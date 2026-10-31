/**
 * False cuts (261031). On 0.6.11 a Windows user on a Backseat share was cut
 * off 19 times in 8 minutes ("it keeps getting cut off"). Replayed headless
 * over real game audio with her TTS echo on top and a real Whisper pass, the
 * cut came from her OWN echo: the duck tripped on a frame of game sound or of
 * her line's onset, the confirming transcription read the pre-roll from before
 * the duck (her voice leaking past AEC), Whisper turned that half second into
 * "Okay." or "Hey.", and one word is under the echo gate's token minimum. So
 * she was cut, and "Okay." went to her as the player's turn.
 *
 * These scenes drive the real VAD loop with generated mic levels: a spiky game
 * bed (seeded, so every run is identical), her line's echo while she plays,
 * and an optional player. The duck pauses her in the rig the way audioQueue
 * now pauses the clip. Every frame carries a tag in its first sample saying
 * what it contains, and the STT mock answers from those tags the way Whisper
 * did on the real clips: the player's frames give words, any frame of her
 * echo gives "Okay.", the game alone gives nothing. No game audio is
 * committed: the levels are synthetic.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bargeVoiceBar, createDictation, isBargeWord, type BargeAbortReason } from './dictation';
import { MIN_ECHO_TOKENS, normalizeTokens, SELF_ECHO_OVERLAP, textOverlap } from './echoGate';

const FRAME = 2048;
const FRAME_MS = (FRAME / 16_000) * 1000; // 128

let nodes: FakeWorkletNode[] = [];
let clock = 0;

class FakeAudioContext {
  close = vi.fn(async () => {});
  audioWorklet = { addModule: vi.fn(async () => {}) };
  destination = {};
  createMediaStreamSource(): { connect: () => void; disconnect: () => void } {
    return { connect: () => {}, disconnect: () => {} };
  }
  createGain(): { gain: { value: number }; connect: () => void; disconnect: () => void } {
    return { gain: { value: 0 }, connect: () => {}, disconnect: () => {} };
  }
}

class FakeWorkletNode {
  port = { onmessage: null as ((e: { data: unknown }) => void) | null };
  constructor() {
    nodes.push(this);
  }
  connect(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  nodes = [];
  clock = 0;
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('AudioWorkletNode', FakeWorkletNode);
  vi.stubGlobal('navigator', {
    mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: () => {} }] })) },
  });
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  vi.spyOn(Date, 'now').mockImplementation(() => 1_700_000_000_000 + clock);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ── frame tags ──────────────────────────────────────────────────────────────
const TAG_ECHO = 1;
const TAG_PLAYER = 2;
const TAG_UNIT = 1e-7; // tiny: changes no frame's RMS measurably

function frameOf(level: number, tags: number): Float32Array {
  const f = new Float32Array(FRAME).fill(level);
  f[0] = (1 + tags) * TAG_UNIT;
  return f;
}

function tagsIn(audio: Float32Array): { echo: number; player: number } {
  let echo = 0;
  let player = 0;
  for (let i = 0; i + FRAME <= audio.length; i += FRAME) {
    const t = Math.round(audio[i] / TAG_UNIT) - 1;
    if (t & TAG_ECHO) echo += 1;
    if (t & TAG_PLAYER) player += 1;
  }
  return { echo, player };
}

const HER_LINE = 'I found some iron over by the cave';

/** Whisper as measured on the real clips: real speech gives its words; a few
 *  frames of her echo give an onset word ("Okay."), a longer stretch gives her
 *  own words back; the game alone gives nothing. */
function whisperLike(playerText: string) {
  return (audio: Float32Array): string => {
    const t = tagsIn(audio);
    if (t.player >= 3) return playerText;
    if (t.echo >= 4) return HER_LINE;
    if (t.echo > 0) return 'Okay.';
    return '';
  };
}

/** micEchoCheck's first step (her own words), as useVoiceStore runs it. */
function ownVoiceCheck(info: { text: string; purpose: 'utterance' | 'barge' }): boolean {
  const min = info.purpose === 'barge' ? 2 : MIN_ECHO_TOKENS;
  return normalizeTokens(info.text).length >= min && textOverlap(info.text, HER_LINE) >= SELF_ECHO_OVERLAP;
}

// ── generated levels ────────────────────────────────────────────────────────
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** A game bed with the shape measured on the Roblox clip: a wobbling base and
 *  short hits several times louder (over a third of real frames sat above
 *  1.6x the median). */
function spikyGame(seed: number, base: number, n: number): number[] {
  const rnd = lcg(seed);
  const out: number[] = [];
  let hit = 0;
  for (let i = 0; i < n; i += 1) {
    const wobble = base * (0.7 + 0.6 * rnd());
    if (hit === 0 && rnd() < 0.07) hit = 1 + Math.floor(rnd() * 2);
    if (hit > 0) {
      hit -= 1;
      out.push(base * (3 + 3 * rnd()));
    } else out.push(wobble);
  }
  return out;
}

const mix = (...xs: number[]): number => Math.sqrt(xs.reduce((a, x) => a + x * x, 0));

// ── the scene ───────────────────────────────────────────────────────────────
interface SceneOpts {
  share: boolean;
  /** Mic level of the room (and the game, during a share), per frame. */
  room: (i: number) => number;
  /** Her echo at the mic while she is audible. */
  echo: number;
  /** Frames per line of hers, and the gap between lines. */
  lineFrames: number;
  gapFrames: number;
  totalFrames: number;
  /** Player speech: frame index -> level (absent = silent). */
  player?: (i: number) => number;
  playerText?: string;
  /** STT round trip, in frames (~900 ms default). */
  latencyFrames?: number;
  /** Override the STT answer. */
  stt?: (audio: Float32Array) => string | null;
}

interface SceneResult {
  suspects: number;
  cuts: number;
  aborts: BargeAbortReason[];
  utterances: string[];
  sttCalls: number;
  /** STT calls made between each duck and the end of its decision. */
  callsPerDuck: number[];
  /** Tags of the audio each STT call was given. */
  sttAudio: { echo: number; player: number }[];
  /** The same, for the calls made while each duck was open. */
  duckAudio: { echo: number; player: number }[][];
  /** Frames her line spent paused. */
  pausedFrames: number;
}

async function runScene(o: SceneOpts): Promise<SceneResult> {
  const res: SceneResult = {
    suspects: 0,
    cuts: 0,
    aborts: [],
    utterances: [],
    sttCalls: 0,
    callsPerDuck: [],
    sttAudio: [],
    duckAudio: [],
    pausedFrames: 0,
  };
  const pending: { due: number; resolve: () => void }[] = [];
  let frameNo = 0;
  const answer = o.stt ?? whisperLike(o.playerText ?? 'wait, hold on');
  let paused = false;
  let lineLeft = 0;
  let gapLeft = 20;
  let duckCallsAt = -1;
  const closeDuck = (): void => {
    if (duckCallsAt >= 0) res.callsPerDuck.push(res.sttCalls - duckCallsAt);
    duckCallsAt = -1;
  };
  const dictation = await createDictation({
    localModel: 'none',
    cloudTranscribe: (audio) => {
      res.sttCalls += 1;
      res.sttAudio.push(tagsIn(audio));
      if (duckCallsAt >= 0) res.duckAudio[res.duckAudio.length - 1].push(tagsIn(audio));
      const text = answer(audio);
      return new Promise((resolve) => {
        pending.push({ due: frameNo + (o.latencyFrames ?? 7), resolve: () => resolve(text) });
      });
    },
    onUtterance: (text) => {
      res.utterances.push(text);
    },
    onStatus: () => {},
    onBargeSuspect: () => {
      res.suspects += 1;
      duckCallsAt = res.sttCalls;
      res.duckAudio.push([]);
      paused = true;
    },
    onBargeAbort: (why) => {
      res.aborts.push(why);
      closeDuck();
      paused = false;
    },
    onBargeIn: () => {
      res.cuts += 1;
      closeDuck();
      paused = false;
      lineLeft = 0; // queue.clear(): her line is gone
      dictation.setHold(false);
      gapLeft = o.gapFrames;
    },
    echoCheck: ownVoiceCheck,
    shareActive: () => o.share,
  });
  const node = nodes[nodes.length - 1];
  for (frameNo = 0; frameNo < o.totalFrames; frameNo += 1) {
    if (lineLeft === 0 && gapLeft > 0) {
      gapLeft -= 1;
      if (gapLeft === 0) {
        lineLeft = o.lineFrames;
        dictation.setHold(true);
        dictation.armBargeGrace();
      }
    }
    const audible = lineLeft > 0 && !paused;
    const p = o.player?.(frameNo) ?? 0;
    const level = mix(o.room(frameNo), audible ? o.echo : 0, p);
    const tags = (audible && o.echo > 0 ? TAG_ECHO : 0) | (p > 0 ? TAG_PLAYER : 0);
    clock += FRAME_MS;
    node.port.onmessage?.({ data: frameOf(level, tags) });
    if (lineLeft > 0) {
      if (paused) res.pausedFrames += 1;
      else {
        lineLeft -= 1;
        if (lineLeft === 0) {
          dictation.setHold(false);
          gapLeft = o.gapFrames;
        }
      }
    }
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      if (pending[i].due <= frameNo) pending.splice(i, 1)[0].resolve();
    }
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  }
  dictation.stop();
  if (process.env.DEBUG_SCENE) process.stderr.write(JSON.stringify(res) + '\n');
  return res;
}

const QUIET = 0.004;
const VOICE = 0.045;

describe('false cuts (261031)', () => {
  it("her own line's onset on loud speakers: the duck retracts with no STT call and no cut", async () => {
    // A quiet room, her echo past AEC at about a normal voice's level, and a
    // cold residue at the start of the call: the first lines' onsets duck.
    const r = await runScene({
      share: false,
      room: () => QUIET,
      echo: 0.04,
      lineFrames: 30,
      gapFrames: 25,
      totalFrames: 600,
    });
    expect(r.suspects).toBeGreaterThan(0); // the scene does reproduce the duck
    expect(r.cuts).toBe(0);
    expect(r.utterances).toEqual([]); // no phantom "Okay." sent to her
    expect(r.aborts.every((a) => a === 'no_voice')).toBe(true);
    expect(r.sttCalls).toBe(0);
  });

  it('a spiky game during a share: no cut, nothing sent as the player, blips cost no STT', async () => {
    const game = spikyGame(7, 0.015, 1200);
    const r = await runScene({
      share: true,
      room: (i) => game[i],
      echo: 0.012,
      lineFrames: 40,
      gapFrames: 30,
      totalFrames: 1200,
    });
    expect(r.suspects).toBeGreaterThan(3); // the game does trip the duck
    expect(r.cuts).toBe(0);
    expect(r.utterances.filter((u) => isBargeWord(u))).toEqual([]);
    // Every duck retracted for lack of a voice was decided without paying.
    const noVoice = r.aborts.map((a, i) => [a, r.callsPerDuck[i]] as const).filter(([a]) => a === 'no_voice');
    expect(noVoice.length).toBeGreaterThan(0);
    expect(noVoice.every(([, calls]) => calls === 0)).toBe(true);
    // And no transcription that decided a duck ever read her echo.
    // No duck ever transcribed her echo alone.
    expect(r.duckAudio.flat().filter((t) => t.echo > 0 && t.player === 0)).toEqual([]);
  });

  it('the player talking over the same game still cuts her, and the words reach her', async () => {
    const game = spikyGame(7, 0.015, 400);
    // She starts at frame 20; the player talks for ~1.5 s from frame 45.
    const r = await runScene({
      share: true,
      room: (i) => game[i],
      echo: 0.012,
      lineFrames: 80,
      gapFrames: 300,
      totalFrames: 140,
      player: (i) => (i >= 45 && i < 57 ? VOICE * (i % 3 === 2 ? 0.6 : 1) : 0),
      playerText: 'wait, hold on',
    });
    expect(r.cuts).toBe(1);
    expect(r.utterances).toEqual(['wait, hold on']);
    // The confirming pass read the player, not the pre-roll of her echo.
    const confirm = r.duckAudio[r.duckAudio.length - 1];
    expect(confirm).toHaveLength(1);
    expect(confirm[0].echo).toBe(0);
    expect(confirm[0].player).toBeGreaterThanOrEqual(3);
  });

  it('a word the utterance filter would drop ("Thank you.") does not cut her', async () => {
    const r = await runScene({
      share: false,
      room: () => QUIET,
      echo: 0.01,
      lineFrames: 80,
      gapFrames: 300,
      totalFrames: 120,
      player: (i) => (i >= 40 && i < 52 ? VOICE : 0),
      stt: () => 'Thank you.',
    });
    expect(r.suspects).toBe(1);
    expect(r.cuts).toBe(0);
    expect(r.aborts).toEqual(['no_word']);
    expect(r.utterances).toEqual([]);
  });

  it('with transcription down, sustained talking still cuts at the deadline', async () => {
    const r = await runScene({
      share: false,
      room: () => QUIET,
      echo: 0.01,
      lineFrames: 80,
      gapFrames: 300,
      totalFrames: 120,
      player: (i) => (i >= 40 && i < 70 ? VOICE : 0),
      stt: () => null,
      latencyFrames: 1000, // never answers inside the scene
    });
    expect(r.suspects).toBe(1);
    expect(r.cuts).toBe(1);
  });

  it('with transcription down, one loud frame on the deadline no longer decides it', async () => {
    // A burst that passes the voice window, then the room, then a single hit
    // landing right on the 1.8 s deadline (the old rule's whole input).
    const loud = new Set([40, 41, 42, 43, 54]);
    const r = await runScene({
      share: false,
      room: () => QUIET,
      echo: 0.01,
      lineFrames: 80,
      gapFrames: 300,
      totalFrames: 120,
      player: (i) => (loud.has(i) ? 0.08 : 0),
      stt: () => null,
      latencyFrames: 1000,
    });
    expect(r.suspects).toBe(1);
    expect(r.cuts).toBe(0);
    expect(r.aborts).toHaveLength(1);
  });
});

describe('false ducks that keep coming (261031)', () => {
  it('a loud steady room teaches the bar instead of re-ducking her the frame she resumes', async () => {
    // A game loud enough to trip the duck on every frame, and no words in it.
    // Before the duck learned, each retraction was followed by another duck
    // the moment she resumed: her line crept forward a frame at a time.
    const r = await runScene({
      share: true,
      room: (i) => (i % 2 ? 0.05 : 0.04),
      echo: 0.012,
      lineFrames: 120,
      gapFrames: 1000,
      totalFrames: 300,
      stt: () => '[Music]',
    });
    // Without the learning: 15 ducks, paused for 281 of the 300 frames.
    expect(r.cuts).toBe(0);
    expect(r.suspects).toBeLessThanOrEqual(3);
    expect(r.pausedFrames).toBeLessThan(80);
  });

  it('a player who starts talking after the first pass still cuts her (one more pass)', async () => {
    // A game sound ducks her and keeps sounding through the first pass's
    // window; the player only starts after it.
    const r = await runScene({
      share: false,
      room: (i) => (i >= 40 && i < 46 ? 0.05 : QUIET),
      echo: 0.01,
      lineFrames: 100,
      gapFrames: 1000,
      totalFrames: 140,
      player: (i) => (i >= 46 && i < 60 ? VOICE : 0),
      playerText: 'wait, hold on',
    });
    expect(r.suspects).toBe(1);
    expect(r.cuts).toBe(1);
    expect(r.utterances).toEqual(['wait, hold on']);
    expect(r.callsPerDuck[0]).toBe(2);
  });
});

describe('bargeVoiceBar', () => {
  it('is the duck bar with her echo residue taken out', () => {
    // Loud speakers in a quiet room: the duck bar rides the residue, the
    // voice bar (she is paused) does not.
    expect(bargeVoiceBar({ noiseFloor: 0.004, holdResidue: 0.04, shareActive: false })).toBeCloseTo(0.02);
    // During a share the game floor still counts.
    expect(bargeVoiceBar({ noiseFloor: 0.03, holdResidue: 0.05, shareActive: true })).toBeCloseTo(0.048);
  });
});

describe('isBargeWord', () => {
  it('needs a word the finished-utterance filter also keeps', () => {
    for (const w of ['wait', 'no', 'stop', 'hey', 'hold on', '等等']) expect(isBargeWord(w), w).toBe(true);
    for (const w of ['', 'you', 'Thank you.', 'music', 'foreign', '[Music]', '(door closes)', 'hhhh']) {
      expect(isBargeWord(w), w).toBe(false);
    }
  });
});
