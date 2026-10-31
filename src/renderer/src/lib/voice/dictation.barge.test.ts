/**
 * Barge-in over game audio (261030). The 0.6.10 Windows report ("It doesnt let
 * me interrupt it") came from a backseat share on Roblox: game sound on the
 * speakers reaches the mic untouched by AEC, the adaptive noise floor climbs to
 * it, and both barge bars sat at >= 5x that floor, so a normal voice over the
 * game never crossed them.
 *
 * These drive the real VAD frame loop with synthetic constant-level frames
 * (RMS = the fill value): the browser pieces are stubbed exactly as in
 * dictation.setup.test.ts, STT is a cloud-only mock, and performance.now is a
 * hand-advanced clock so the grace window and deadlines are deterministic.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bargeBars, bargeDeadlineBar, createDictation, type BargeAbortReason } from './dictation';

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
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

interface Rig {
  frame: (rms: number, n?: number) => void;
  ramp: (from: number, to: number, n: number) => void;
  dictation: Awaited<ReturnType<typeof createDictation>>;
  suspects: number;
  barges: number;
  aborts: BargeAbortReason[];
}

async function rig(opts: {
  share: boolean;
  transcript?: string;
  echoCheck?: () => boolean | Promise<boolean>;
}): Promise<Rig> {
  const r = { suspects: 0, barges: 0, aborts: [] as BargeAbortReason[] } as Rig;
  r.dictation = await createDictation({
    localModel: 'none',
    cloudTranscribe: async () => opts.transcript ?? '',
    onUtterance: () => {},
    onStatus: () => {},
    onBargeSuspect: () => {
      r.suspects += 1;
    },
    onBargeIn: () => {
      r.barges += 1;
    },
    onBargeAbort: (why) => {
      r.aborts.push(why);
    },
    echoCheck: opts.echoCheck,
    shareActive: () => opts.share,
  });
  const node = nodes[nodes.length - 1];
  r.frame = (rms, n = 1) => {
    for (let i = 0; i < n; i += 1) {
      clock += FRAME_MS;
      node.port.onmessage?.({ data: new Float32Array(FRAME).fill(rms) });
    }
  };
  // Geometric ramp, outside hold: the floor tracks it without the VAD ever
  // opening speech (a game fading in, the way real game audio arrives).
  r.ramp = (from, to, n) => {
    const g = Math.pow(to / from, 1 / n);
    let v = from;
    for (let i = 0; i < n; i += 1) {
      r.frame(v);
      v *= g;
    }
  };
  return r;
}

/** Mixed level of two uncorrelated sources at the mic. */
const mix = (a: number, b: number): number => Math.sqrt(a * a + b * b);
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

const GAME = 0.03; // a loud game on speakers at the mic (~-30 dBFS)
const VOICE = 0.045; // ordinary speech at a laptop mic

/** Game fades in over ~40 s, then her line starts and the player talks. */
async function talkOverGame(share: boolean): Promise<Rig> {
  const r = await rig({ share });
  r.ramp(0.004, GAME, 300);
  r.frame(GAME, 60);
  r.dictation.setHold(true);
  r.dictation.armBargeGrace();
  r.frame(GAME, 20); // ~2.5 s of her line over the game, player silent
  expect(r.suspects, 'the game alone must not duck her').toBe(0);
  r.frame(mix(GAME, VOICE), 2);
  return r;
}

describe('barge-in over game audio', () => {
  it('without a share, the inflated floor blocks a normal voice (the reported bug)', async () => {
    const r = await talkOverGame(false);
    expect(r.suspects).toBe(0);
  });

  it('during a share, the same voice over the same game ducks her', async () => {
    const r = await talkOverGame(true);
    expect(r.suspects).toBe(1);
  });

  it('during a share, the first frame of a line over the game does not duck', async () => {
    // The residue still holds the quiet-room value at the very first line;
    // the floor (which adapted to the game in the gap) must stand in for it.
    const r = await rig({ share: true });
    r.ramp(0.004, GAME, 300);
    r.frame(GAME, 60);
    r.dictation.setHold(true);
    r.dictation.armBargeGrace();
    r.frame(GAME, 3);
    expect(r.suspects).toBe(0);
  });

  it('TTS echo on speakers in a quiet room: a share changes nothing', async () => {
    // Quiet room, loud speakers: the residue (her echo past AEC) carries the
    // bar. The same echo sequence must duck exactly as often with a share as
    // without (the cold first line's onset ducks are the accepted, retracted
    // cost of a one-frame stage one), and once the residue has learned the
    // echo, a wobble up to 1.5x of it ducks neither.
    const counts: number[] = [];
    for (const share of [false, true]) {
      const r = await rig({ share });
      r.frame(0.004, 200);
      r.dictation.setHold(true);
      r.dictation.armBargeGrace();
      // First line: cold residue, so its onset ducks; each duck's empty STT
      // pass retracts it before the next frame, and the residue learns.
      for (let i = 0; i < 30; i += 1) {
        r.frame(0.04);
        await flush();
      }
      r.dictation.setHold(false);
      await flush();
      r.frame(0.004, 40); // the gap between lines
      const before = r.suspects;
      r.dictation.setHold(true);
      r.dictation.armBargeGrace();
      for (const level of [0.04, 0.04, 0.04, 0.04, 0.04, 0.04, 0.058, 0.04, 0.04]) {
        r.frame(level);
        await flush();
      }
      expect(r.suspects - before, `learned echo, share=${share}`).toBe(0);
      counts.push(r.suspects);
    }
    expect(counts[1]).toBe(counts[0]);
  });
});

describe('bargeBars', () => {
  it('is unchanged without a share', () => {
    expect(bargeBars({ noiseFloor: 0.008, holdResidue: 0.01, shareActive: false })).toEqual({
      duck: 0.04,
      commit: 0.04,
    });
    expect(bargeBars({ noiseFloor: 0.03, holdResidue: 0.03, shareActive: false }).duck).toBeCloseTo(0.15);
  });

  it('during a share, an inflated floor counts like residue instead of 5x', () => {
    const b = bargeBars({ noiseFloor: 0.03, holdResidue: 0.03, shareActive: true });
    expect(b.duck).toBeCloseTo(0.048);
    expect(b.commit).toBeCloseTo(0.075);
  });

  it('during a share, the bar never drops below a quiet room with the same residue', () => {
    // "Quiet room" = the same floor clipped to a quiet level (<= 0.006).
    for (const residue of [0.004, 0.01, 0.02, 0.04, 0.08]) {
      for (const floor of [0.002, 0.006, 0.01, 0.03, 0.06]) {
        const quiet = bargeBars({ noiseFloor: Math.min(floor, 0.006), holdResidue: residue, shareActive: false });
        const shared = bargeBars({ noiseFloor: floor, holdResidue: residue, shareActive: true });
        expect(shared.duck).toBeGreaterThanOrEqual(quiet.duck - 1e-12);
        expect(shared.commit).toBeGreaterThanOrEqual(quiet.commit - 1e-12);
      }
    }
  });

  it('during a share, a quiet room keeps exactly its old bars', () => {
    for (const floor of [0.002, 0.004, 0.006]) {
      for (const residue of [0.004, 0.02]) {
        expect(bargeBars({ noiseFloor: floor, holdResidue: residue, shareActive: true })).toEqual(
          bargeBars({ noiseFloor: floor, holdResidue: residue, shareActive: false }),
        );
      }
    }
  });
});

describe('stage two after a duck', () => {
  it('a word the echo gate is still judging is not thrown away at the 1.8 s energy deadline', async () => {
    // Windows loopback share: her voice is in the screen reference, so every
    // barge takes the gate's slow path (one bounded screen-STT flush). It used
    // to run past BARGE_SUSPECT_MAX_MS, and the energy fallback then retracted
    // the duck on whatever frame came next, dropping the player's words.
    let answer: (echo: boolean) => void = () => {};
    const gate = new Promise<boolean>((res) => {
      answer = res;
    });
    const r = await rig({ share: true, transcript: 'wait hold on', echoCheck: () => gate });
    r.frame(0.004, 200);
    r.dictation.setHold(true);
    r.dictation.armBargeGrace();
    r.frame(0.01, 8);
    r.frame(0.06, 2); // the player starts talking: duck, then the STT pass
    expect(r.suspects).toBe(1);
    await flush(); // the cloud mock answers with a word; the gate is pending
    // Keep talking past 1.8 s, softly enough to sit under the deadline bar.
    expect(0.025).toBeLessThan(bargeDeadlineBar(0.01));
    r.frame(0.025, 12);
    expect(r.aborts).toEqual([]);
    answer(false); // not echo: the player's
    await flush();
    expect(r.barges).toBe(1);
    expect(r.aborts).toEqual([]);
  });

  it('a duck the echo gate traces to the speakers is retracted as echo', async () => {
    const r = await rig({ share: true, transcript: 'over there', echoCheck: async () => true });
    r.frame(0.004, 200);
    r.dictation.setHold(true);
    r.dictation.armBargeGrace();
    r.frame(0.01, 8);
    // The duck, then the voice after it: stage two only reads the audio from
    // the duck on (261031), so it needs a few frames of the player.
    r.frame(0.06, 6);
    await flush();
    expect(r.barges).toBe(0);
    expect(r.aborts).toEqual(['echo']);
  });

  it('a duck with no word behind it is retracted as no_word', async () => {
    const r = await rig({ share: false, transcript: '', echoCheck: async () => false });
    r.frame(0.004, 200);
    r.dictation.setHold(true);
    r.dictation.armBargeGrace();
    r.frame(0.01, 8);
    // The duck, then the voice after it: stage two only reads the audio from
    // the duck on (261031), so it needs a few frames of the player.
    r.frame(0.06, 6);
    await flush();
    expect(r.aborts).toEqual(['no_word']);
  });
});
