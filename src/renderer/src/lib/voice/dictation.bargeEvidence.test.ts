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
import {
  bargeVoiceBar,
  burstWordOffScript,
  burstWordUnsure,
  cloudPassText,
  createDictation,
  isBargeWord,
  type BargeAbortReason,
} from './dictation';
import type { SttHint } from './sttArbiter';
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

/** Whisper as measured on the real clips: real speech gives its words; the
 *  ~400 ms of her echo the old pre-roll pass read gives an onset word
 *  ("Okay."), a longer stretch gives her own words back; the game alone gives
 *  nothing. The two frames of her a pass after a clean duck holds (the
 *  trigger and its tail) came back as nothing or a non-speech tag in the
 *  replay, but for two stock words ("Bye.") in 68 minutes of it. */
function whisperLike(playerText: string) {
  return (audio: Float32Array): string => {
    const t = tagsIn(audio);
    if (t.player >= 3) return playerText;
    if (t.echo >= 4) return HER_LINE;
    if (t.echo >= 3) return 'Okay.';
    return '';
  };
}

/** Whisper on a short interjection: a frame or two of the player, at least as
 *  loud as anything else in the audio, comes back as the word; otherwise the
 *  same as whisperLike. */
function shortWordLike(word: string) {
  const rest = whisperLike(word);
  return (audio: Float32Array): string => {
    const t = tagsIn(audio);
    return t.player >= 1 && t.player >= t.echo ? word : rest(audio);
  };
}

/** The worst case for a pass that reads her echo: Whisper (or Scribe) makes a
 *  stock word of ANY of it ("Okay."), however little there is. The player,
 *  when at least as loud, still comes back as the word. */
function pessimisticLike(word: string) {
  const rest = shortWordLike(word);
  return (audio: Float32Array): string => {
    const t = tagsIn(audio);
    if (t.player >= 1 && t.player >= t.echo) return word;
    return t.echo > 0 ? 'Okay.' : rest(audio);
  };
}

/** Scribe on a burst, as measured on 58 barge-pass clips sent through it with
 *  the app's parameters (261101): the player's short word comes back sure of
 *  itself (word log-probability above -0.01 for "stop" / "wait"), while the
 *  trigger frame of her echo comes back about half the time as an invented
 *  word it is unsure of ("No" at -0.5 to -1.9), or in a script the call does
 *  not use ("你好"). `sure: false` drops the confidence, as a proxy that does
 *  not relay it would. */
function scribeLike(word: string, o: { invent?: string; sure?: boolean } = {}) {
  const rest = shortWordLike(word);
  return (audio: Float32Array): SttAnswer => {
    const t = tagsIn(audio);
    const conf = (lp: number): number | undefined => (o.sure === false ? undefined : lp);
    if (t.player >= 1 && t.player >= t.echo) return { text: word, minWordLogprob: conf(-0.005) };
    if (t.echo > 0 && t.echo <= 2) return { text: o.invent ?? 'No', minWordLogprob: conf(-0.9) };
    const text = rest(audio);
    return { text, minWordLogprob: text ? conf(-0.05) : undefined };
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
  /** Her echo at the mic while she is audible (a level, or one per frame). */
  echo: number | ((i: number) => number);
  /** Frames per line of hers, and the gap between lines. */
  lineFrames: number;
  gapFrames: number;
  totalFrames: number;
  /** Player speech: frame index -> level (absent = silent). */
  player?: (i: number) => number;
  playerText?: string;
  /** STT round trip, in frames (~900 ms default). */
  latencyFrames?: number;
  /** Override the STT answer. An object answer carries Scribe's confidence
   *  and goes through the voice store's cloudPassText, as the app's does. */
  stt?: (audio: Float32Array) => SttAnswer;
  /** The conversation language (createDictation's `language`). */
  language?: string;
  /** Runs after each frame is fed (mute toggles and the like). */
  onFrame?: (i: number, d: { setMuted(m: boolean): void }) => void;
  /** Share of her echo still in the frame after the duck (the queue's 60 ms
   *  ramp plus the speaker path). 0 = she stops at the frame boundary. */
  duckTail?: number;
}

type SttAnswer = string | null | { text: string; minWordLogprob?: number };

interface SceneResult {
  /** The hint each STT call was given. */
  sttHints: (SttHint | undefined)[];
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
    sttHints: [],
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
  let pausedAt = -1;
  let lineLeft = 0;
  let gapLeft = 20;
  let duckCallsAt = -1;
  const closeDuck = (): void => {
    if (duckCallsAt >= 0) res.callsPerDuck.push(res.sttCalls - duckCallsAt);
    duckCallsAt = -1;
  };
  const dictation = await createDictation({
    localModel: 'none',
    language: o.language,
    cloudTranscribe: (audio, hint) => {
      if (process.env.DEBUG_SCENE) process.stderr.write(`#${frameNo} stt ${JSON.stringify(tagsIn(audio))} n=${audio.length / FRAME}\n`);
      res.sttCalls += 1;
      res.sttAudio.push(tagsIn(audio));
      if (duckCallsAt >= 0) res.duckAudio[res.duckAudio.length - 1].push(tagsIn(audio));
      res.sttHints.push(hint);
      const a = answer(audio);
      const text = a !== null && typeof a === 'object' ? cloudPassText(a, hint) : a;
      return new Promise((resolve) => {
        pending.push({ due: frameNo + (o.latencyFrames ?? 7), resolve: () => resolve(text) });
      });
    },
    onUtterance: (text) => {
      res.utterances.push(text);
    },
    onStatus: () => {},
    onBargeSuspect: () => {
      if (process.env.DEBUG_SCENE) process.stderr.write(`#${frameNo} duck\n`);
      res.suspects += 1;
      duckCallsAt = res.sttCalls;
      res.duckAudio.push([]);
      paused = true;
      pausedAt = frameNo;
    },
    onBargeAbort: (why) => {
      if (process.env.DEBUG_SCENE) process.stderr.write(`#${frameNo} abort ${why}\n`);
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
    const echoAt = (i: number): number => (typeof o.echo === 'function' ? o.echo(i) : o.echo);
    const tail = lineLeft > 0 && paused && pausedAt === frameNo - 1 ? (o.duckTail ?? 0) : 0;
    const e = audible ? echoAt(frameNo) : echoAt(frameNo - 1) * tail;
    const p = o.player?.(frameNo) ?? 0;
    const r = o.room(frameNo);
    const level = mix(r, e, p);
    // A voice is in the transcript when it is within ~6 dB of the loudest
    // other sound in the frame (speech stays intelligible under a game bed,
    // not under a hit four times louder).
    const heard = (v: number, ...others: number[]): boolean => v > 0 && v >= 0.5 * Math.max(...others);
    const tags = (heard(e, r, p) ? TAG_ECHO : 0) | (heard(p, r, e) ? TAG_PLAYER : 0);
    clock += FRAME_MS;
    node.port.onmessage?.({ data: frameOf(level, tags) });
    o.onFrame?.(frameNo, dictation);
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

  it('a spiky game during a share: no cut, nothing sent as the player, STT bounded per duck', async () => {
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
    // A hit after the clip's grace window gets its pass, as a short word
    // would (261031 review), plus at most the one re-ask when the game kept
    // going while it was out. The rig cannot see a duck that takes over a
    // finished one's wait, so it counts per open span.
    expect(r.callsPerDuck.reduce((a, c) => a + c, 0)).toBeLessThanOrEqual(2 * r.suspects);
    // A duck retracted for lack of a voice was decided without paying.
    const noVoice = r.aborts.map((a, i) => [a, r.callsPerDuck[i]] as const).filter(([a]) => a === 'no_voice');
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
    // The pass that decided it read the player, not the pre-roll of her echo.
    // (A game hit before the player can spend a pass of its own: a clean duck
    // may be a short word.)
    const confirm = r.duckAudio[r.duckAudio.length - 1];
    const last = confirm[confirm.length - 1];
    expect(confirm.length).toBeLessThanOrEqual(3);
    expect(last.echo).toBe(0);
    expect(last.player).toBeGreaterThanOrEqual(3);
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

describe('ducks that cannot stick (261031 review)', () => {
  it('loud speakers and a cold residue: her line does not stutter a frame per duck', async () => {
    // Her echo far over the starting residue. The first duck pauses her inside
    // the clip's grace window, so before the re-grace the residue never learned
    // her level and every resumed frame re-ducked her: 63 ducks and 252 paused
    // frames in this scene, her line playing 128 ms at a time.
    const r = await runScene({
      share: false,
      room: () => QUIET,
      echo: 0.08,
      lineFrames: 60,
      gapFrames: 25,
      totalFrames: 600,
    });
    expect(r.cuts).toBe(0);
    expect(r.utterances).toEqual([]);
    expect(r.suspects).toBeLessThanOrEqual(6);
    expect(r.pausedFrames).toBeLessThan(40);
  });

  it('a player muting while a finished barge waits on its transcript still resumes her in bound', async () => {
    // A short burst ends while its pass is out, transcription never answers,
    // and the player mutes. The wait's bound used to be checked only on
    // unmuted frames, so she stayed paused for as long as the mute lasted.
    const r = await runScene({
      share: false,
      room: () => QUIET,
      echo: 0.01,
      lineFrames: 80,
      gapFrames: 300,
      totalFrames: 140,
      player: (i) => (i >= 40 && i < 45 ? VOICE : 0),
      latencyFrames: 1000,
      onFrame: (i, d) => {
        if (i === 52) d.setMuted(true);
      },
    });
    expect(r.suspects).toBe(1);
    expect(r.aborts).toEqual(['no_word']);
    expect(r.pausedFrames).toBeLessThan(50); // ~4 s bound, not the rest of the scene
  });
});

describe('short interjections (261031 review)', () => {
  // She starts at frame 20; her grace window is over by frame 26. A word of one
  // or two frames used to fail the voice window after the duck and be dropped.
  const quietLine = { share: false, room: () => QUIET, echo: 0.01, lineFrames: 80, gapFrames: 300, totalFrames: 140 };

  it('a two-frame "stop" cuts her and reaches her as the player', async () => {
    const r = await runScene({
      ...quietLine,
      player: (i) => (i === 40 || i === 41 ? VOICE : 0),
      stt: shortWordLike('stop'),
    });
    expect(r.suspects).toBe(1);
    expect(r.cuts).toBe(1);
    expect(r.utterances).toEqual(['stop']);
    expect(r.sttCalls).toBe(1);
  });

  it('a crisp "stop" over inside the trigger frame still cuts her', async () => {
    const r = await runScene({
      ...quietLine,
      player: (i) => (i === 40 ? 0.08 : 0),
      stt: shortWordLike('stop'),
    });
    expect(r.cuts).toBe(1);
    expect(r.utterances).toEqual(['stop']);
    expect(r.sttCalls).toBe(1);
  });

  it('a short "stop" on loud speakers, its end no louder than her echo tail, still cuts her', async () => {
    // Her echo at a normal voice's level and a long duck tail: the skip frame
    // after the word reads the same as her tail does, and nothing voiced
    // follows, so only the pass can tell this from her.
    const r = await runScene({
      ...quietLine,
      echo: 0.08,
      duckTail: 0.7,
      lineFrames: 140,
      totalFrames: 220,
      player: (i) => (i === 100 ? 0.15 : i === 101 ? 0.04 : 0),
      stt: shortWordLike('stop'),
    });
    expect(r.cuts).toBe(1);
    expect(r.utterances).toEqual(['stop']);
  });

  it('a three-frame fading "wait" cuts her', async () => {
    const fade = [1, 0.6, 0.3];
    const r = await runScene({
      ...quietLine,
      player: (i) => (i >= 40 && i < 43 ? VOICE * fade[i - 40] : 0),
      stt: shortWordLike('wait'),
    });
    expect(r.cuts).toBe(1);
    expect(r.utterances).toEqual(['wait']);
  });

  it('early in a call (a cold floor, her first line) a fading "wait" still cuts', async () => {
    // The floor starts at 0.008 and does not adapt while she talks, so the
    // voice bar sits near 0.033: the word's second frame is under it.
    const fade = [1, 0.6, 0.3];
    const r = await runScene({
      ...quietLine,
      echo: 0.004, // headphones
      player: (i) => (i >= 27 && i < 30 ? VOICE * fade[i - 27] : 0),
      stt: shortWordLike('wait'),
    });
    expect(r.cuts).toBe(1);
    expect(r.utterances).toEqual(['wait']);
  });

  it('her own loud syllables on loud speakers do not cut her and are not sent as the player', async () => {
    // Loud speakers, a long duck tail, and every so often two frames of hers
    // twice as loud as the rest of the line: the shape of a short word, made
    // of her echo. Past the grace window each one gets a pass (no energy test
    // tells it from a word), and the pass reads only the trigger and its
    // tail, never the pre-roll Whisper used to turn into "Okay.".
    const r = await runScene({
      share: false,
      room: () => QUIET,
      echo: (i) => (i % 23 === 0 || i % 23 === 1 ? 0.16 : 0.08),
      duckTail: 0.7,
      lineFrames: 60,
      gapFrames: 25,
      totalFrames: 600,
      stt: shortWordLike('stop'),
    });
    expect(r.cuts).toBe(0);
    expect(r.utterances).toEqual([]);
    // Each of those ducks costs its one pass, and no more.
    expect(r.callsPerDuck.every((c) => c <= 1)).toBe(true);
  });

  it('the same syllables under pessimistic STT: the worst case is bounded to one pass per duck', async () => {
    // If STT turns any of her echo into a stock word, a pass on a clean duck
    // past the grace window has nothing left to tell it from "stop": the
    // trigger frame IS her syllable, and a one-word transcript is under the
    // echo gate's token minimum. That is the cost of giving short words their
    // pass (0.6.11, reading the pre-roll, cut about as often in this scene
    // and paid several times the transcriptions). What must hold is the
    // bound: one pass per duck, never a pass on a grace-window duck, and the
    // retraction re-arms grace so the resumed frames do not re-duck.
    const r = await runScene({
      share: false,
      room: () => QUIET,
      echo: (i) => (i % 23 === 0 || i % 23 === 1 ? 0.16 : 0.08),
      duckTail: 0.7,
      lineFrames: 60,
      gapFrames: 25,
      totalFrames: 600,
      stt: pessimisticLike('stop'),
    });
    expect(r.callsPerDuck.every((c) => c <= 1)).toBe(true);
    expect(r.sttCalls).toBeLessThan(r.suspects);
    expect(r.cuts).toBeLessThanOrEqual(r.sttCalls);
  });

  it('a short word whose transcript lands after the wait is delivered once, without a cut', async () => {
    const r = await runScene({
      ...quietLine,
      totalFrames: 200,
      player: (i) => (i === 40 || i === 41 ? VOICE : 0),
      stt: shortWordLike('stop'),
      latencyFrames: 45, // ~5.8 s: past the 4 s bound on a finished barge
    });
    expect(r.suspects).toBe(1);
    expect(r.cuts).toBe(0);
    expect(r.aborts).toEqual(['no_word']);
    expect(r.utterances).toEqual(['stop']);
  });

  it('a late transcript that is not a word, or is her own line, is not delivered', async () => {
    for (const late of ['Thank you.', '[Music]', HER_LINE]) {
      const r = await runScene({
        ...quietLine,
        totalFrames: 200,
        player: (i) => (i === 40 || i === 41 ? VOICE : 0),
        stt: () => late,
        latencyFrames: 45,
      });
      expect(r.cuts, late).toBe(0);
      expect(r.utterances, late).toEqual([]);
    }
  });

  it('a long utterance whose pass outlives the energy deadline is delivered after the retraction', async () => {
    // A word, then the player keeps a voice up under the bar the deadline
    // needs; transcription is slow. The deadline retracts the duck, and the
    // word that comes back late is still the player's turn.
    const r = await runScene({
      ...quietLine,
      totalFrames: 200,
      player: (i) => (i >= 40 && i < 55 ? (i % 4 === 0 ? VOICE : 0.006) : 0),
      stt: shortWordLike('hang on'),
      latencyFrames: 20,
    });
    expect(r.suspects).toBe(1);
    expect(r.cuts).toBe(0);
    expect(r.aborts).toEqual(['no_word']);
    expect(r.utterances).toEqual(['hang on']);
  });
});

describe('Scribe on a burst (261101)', () => {
  // The loud-speaker syllables of the review above, with Scribe as measured:
  // it made a word of her trigger frame about half the time. One token is
  // under the echo gate's minimum, so before this each of those cut her.
  const loudSyllables = {
    share: false,
    room: () => QUIET,
    echo: (i: number) => (i % 23 === 0 || i % 23 === 1 ? 0.16 : 0.08),
    duckTail: 0.7,
    lineFrames: 60,
    gapFrames: 25,
    totalFrames: 600,
  };

  it('the path was real: the same invented words with no confidence cut her', async () => {
    const r = await runScene({ ...loudSyllables, stt: scribeLike('stop', { sure: false }) });
    expect(r.cuts).toBeGreaterThan(0);
  });

  it('an invented burst word Scribe is unsure of does not cut her', async () => {
    const r = await runScene({ ...loudSyllables, stt: scribeLike('stop') });
    expect(r.sttCalls).toBeGreaterThan(0);
    expect(r.cuts).toBe(0);
    expect(r.utterances).toEqual([]);
    // Every pass here was a burst, and said so to the cloud leg.
    expect(r.sttHints.every((h) => h?.burst === true)).toBe(true);
  });

  it('an invented word in a script the call does not use does not cut her, even when sure', async () => {
    const r = await runScene({ ...loudSyllables, stt: scribeLike('stop', { invent: '你好', sure: false }) });
    expect(r.cuts).toBe(0);
    // On a Chinese call the same word is a word: only Latin calls are judged.
    const zh = await runScene({
      ...loudSyllables,
      language: 'zh',
      stt: scribeLike('stop', { invent: '你好', sure: false }),
    });
    expect(zh.cuts).toBeGreaterThan(0);
  });

  it('a real short word still cuts her, quiet room or loud speakers', async () => {
    const quiet = await runScene({
      share: false,
      room: () => QUIET,
      echo: 0.01,
      lineFrames: 80,
      gapFrames: 300,
      totalFrames: 140,
      player: (i) => (i === 40 || i === 41 ? VOICE : 0),
      stt: scribeLike('stop'),
    });
    expect(quiet.cuts).toBe(1);
    expect(quiet.utterances).toEqual(['stop']);
    expect(quiet.sttHints).toEqual([{ burst: true }]);
    const loud = await runScene({
      ...loudSyllables,
      totalFrames: 140,
      player: (i) => (i === 57 ? 0.3 : 0),
      stt: scribeLike('stop'),
    });
    expect(loud.cuts).toBe(1);
    expect(loud.utterances).toEqual(['stop']);
  });

  it('a voiced pass is not a burst, and its words are not judged by confidence', async () => {
    const r = await runScene({
      share: false,
      room: () => QUIET,
      echo: 0.01,
      lineFrames: 80,
      gapFrames: 300,
      totalFrames: 140,
      player: (i) => (i >= 40 && i < 52 ? VOICE : 0),
      stt: () => ({ text: 'wait, hold on', minWordLogprob: -1.2 }),
    });
    expect(r.cuts).toBe(1);
    expect(r.sttHints[0]).toBeUndefined();
  });
});

describe('burst word helpers (261101)', () => {
  it('burstWordUnsure: below the bar is unsure, unknown confidence is not', () => {
    expect(burstWordUnsure(-0.9)).toBe(true);
    expect(burstWordUnsure(-0.31)).toBe(true);
    expect(burstWordUnsure(-0.2)).toBe(false);
    expect(burstWordUnsure(-0.004)).toBe(false);
    expect(burstWordUnsure(undefined)).toBe(false);
  });

  it('cloudPassText judges bursts only', () => {
    const unsure = { text: 'No', minWordLogprob: -0.9 };
    expect(cloudPassText(unsure, { burst: true })).toBe('');
    expect(cloudPassText(unsure)).toBe('No');
    expect(cloudPassText({ text: 'Stop', minWordLogprob: -0.004 }, { burst: true })).toBe('Stop');
    expect(cloudPassText({ text: 'No' }, { burst: true })).toBe('No');
  });

  it('burstWordOffScript: no Latin letter on a Latin-script call', () => {
    expect(burstWordOffScript('你好', undefined)).toBe(true);
    expect(burstWordOffScript('いいの', 'en')).toBe(true);
    expect(burstWordOffScript('听吗？', 'fr')).toBe(true);
    expect(burstWordOffScript('Stop', 'en')).toBe(false);
    expect(burstWordOffScript('¡Para!', 'es')).toBe(false);
    expect(burstWordOffScript('等等', 'zh')).toBe(false);
    expect(burstWordOffScript('stop', 'ja')).toBe(false);
  });
});

describe('resuming after a retracted duck (261031 re-review)', () => {
  const slowStop = {
    share: false,
    room: () => QUIET,
    echo: 0.04,
    lineFrames: 200,
    gapFrames: 300,
    totalFrames: 280,
    latencyFrames: 45, // ~5.8 s: a slow cloud STT round trip
    player: (i: number) => (i === 40 || i === 41 ? VOICE * 2 : 0),
  };

  it('slow STT: the resumed echo after the wait runs out is a free no_voice, one STT call in all', async () => {
    const r = await runScene({ ...slowStop, stt: shortWordLike('stop') });
    expect(r.sttCalls).toBe(1);
    // The wait ran out (no_word); everything after it was retracted for free.
    const waited = r.aborts.indexOf('no_word');
    expect(waited).toBeGreaterThanOrEqual(0);
    expect(r.aborts.slice(waited + 1).every((a) => a === 'no_voice')).toBe(true);
    // The word still reaches her, late, as an ordinary turn.
    expect(r.utterances).toEqual(['stop']);
    expect(r.cuts).toBe(0);
  });

  it('slow STT under pessimistic STT: her resumed echo is never transcribed', async () => {
    const r = await runScene({ ...slowStop, stt: pessimisticLike('stop') });
    expect(r.sttCalls).toBe(1);
    expect(r.cuts).toBe(0);
    expect(r.utterances).toEqual(['stop']);
  });

  it('alternating soft and loud echo: no pass reads her echo at a line onset', async () => {
    const r = await runScene({
      share: false,
      room: () => QUIET,
      echo: (i) => (i % 2 === 0 ? 0.03 : 0.1),
      lineFrames: 30,
      gapFrames: 25,
      totalFrames: 600,
      stt: pessimisticLike('stop'),
    });
    expect(r.suspects).toBeGreaterThan(0);
    expect(r.sttCalls).toBe(0);
    expect(r.cuts).toBe(0);
    expect(r.utterances).toEqual([]);
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
