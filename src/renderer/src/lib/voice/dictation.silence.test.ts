/**
 * "It keeps thinking I'm laughing when I don't say anything" (261127).
 *
 * The chain this pins, end to end through the real VAD frame loop:
 *   1. A single loud frame (a key, a desk bump, a mouth click) no longer
 *      becomes a clip at all (MIN_LOUD_FRAMES). Before, the pre-roll and the
 *      closing silence run carried it past MIN_UTTERANCE_MS and every one
 *      went to Scribe.
 *   2. A longer non-voice sound (breath, rustle) still reaches STT, but a
 *      Scribe answer that is only a laughter tag is dropped unless the clip
 *      had a voice in it (laughHasVoice). A real voiced laugh still lands.
 *   3. The Settings sensitivity scales the open threshold.
 *   4. A saved mic that is gone opens the system default and says so.
 *
 * Browser pieces are stubbed as in dictation.barge.test.ts; cloud-only mode.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDictation, LAUGH_MIN_VOICED_MS, laughHasVoice, voicedMsOf } from './dictation';
import type { CloudPass } from './sttArbiter';

const FRAME = 2048;
const FRAME_MS = (FRAME / 16_000) * 1000; // 128

let nodes: FakeWorkletNode[] = [];
let clock = 0;
let getUserMedia: ReturnType<typeof vi.fn>;

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
  getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: () => {} }] }));
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('AudioWorkletNode', FakeWorkletNode);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Deterministic noise in [-1, 1]. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s / 0xffffffff) * 2 - 1;
  };
}

function scaleTo(buf: Float32Array, rms: number): Float32Array {
  let sum = 0;
  for (const v of buf) sum += v * v;
  const k = sum > 0 ? rms / Math.sqrt(sum / buf.length) : 0;
  for (let i = 0; i < buf.length; i += 1) buf[i] *= k;
  return buf;
}

/** Hiss: breath, a fan, rustle. */
function noise(n: number, rms: number, seed = 7): Float32Array {
  const r = lcg(seed);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) out[i] = r();
  return scaleTo(out, rms);
}

/** A voiced vowel: a 180 Hz fundamental with a few harmonics. */
function vowel(n: number, rms: number, f0 = 180, offset = 0): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const t = (i + offset) / 16_000;
    let v = 0;
    for (let h = 1; h <= 5; h += 1) v += Math.sin(2 * Math.PI * f0 * h * t) / h;
    out[i] = v;
  }
  return scaleTo(out, rms);
}

/** One sharp click: a decaying burst at the start of a frame, silence after. */
function click(n: number, peak: number): Float32Array {
  const out = new Float32Array(n);
  const r = lcg(3);
  for (let i = 0; i < 300; i += 1) out[i] = r() * peak * Math.exp(-i / 60);
  return out;
}

const QUIET = 0.002;

async function rig(opts: {
  pass: string | CloudPass;
  gateScale?: number;
  micDeviceId?: string;
}): Promise<{
  feed: (frame: Float32Array) => void;
  quiet: (n: number) => void;
  passes: number;
  utterances: string[];
  events: boolean[];
  fallbacks: number;
}> {
  const r = { passes: 0, utterances: [] as string[], events: [] as boolean[], fallbacks: 0 } as Awaited<
    ReturnType<typeof rig>
  >;
  await createDictation({
    localModel: 'none',
    cloudTranscribe: async () => {
      r.passes += 1;
      return opts.pass;
    },
    onUtterance: (text) => {
      r.utterances.push(text);
    },
    onStatus: () => {},
    gateScale: opts.gateScale,
    micDeviceId: opts.micDeviceId,
    onMicFallback: () => {
      r.fallbacks += 1;
    },
    onAudioEvent: (kept) => {
      r.events.push(kept);
    },
  });
  const node = nodes[nodes.length - 1];
  r.feed = (frame) => {
    clock += FRAME_MS;
    node.port.onmessage?.({ data: frame });
  };
  r.quiet = (n) => {
    for (let i = 0; i < n; i += 1) r.feed(noise(FRAME, QUIET, 100 + i));
  };
  return r;
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

const LAUGH: CloudPass = { text: 'haha', audioEvent: 'laugh' };

describe('voicedMsOf', () => {
  const bar = 0.012;
  it('counts a voiced vowel, and none of silence, hiss or a click', () => {
    expect(voicedMsOf(vowel(16_000, 0.05), bar)).toBeGreaterThan(900);
    expect(voicedMsOf(new Float32Array(16_000), bar)).toBe(0);
    expect(voicedMsOf(noise(16_000, 0.05), bar)).toBe(0);
    expect(voicedMsOf(click(16_000, 0.6), bar)).toBe(0);
  });

  it('a vowel under the energy bar does not count', () => {
    expect(voicedMsOf(vowel(16_000, 0.005), bar)).toBe(0);
  });

  it('a high laugh (450 Hz) still counts', () => {
    expect(voicedMsOf(vowel(8_000, 0.05, 450), bar)).toBeGreaterThan(LAUGH_MIN_VOICED_MS);
  });

  it('laughHasVoice reads the bar off the hint', () => {
    const clip = vowel(8_000, 0.03);
    expect(laughHasVoice(clip, { voiceBar: 0.012 })).toBe(true);
    expect(laughHasVoice(clip, { voiceBar: 0.1 })).toBe(false);
  });
});

describe('false laughter on silence (261127)', () => {
  it('a single click in a quiet room is never sent to STT', async () => {
    const r = await rig({ pass: LAUGH });
    r.quiet(40);
    r.feed(click(FRAME, 0.6));
    r.quiet(12);
    await settle();
    expect(r.passes).toBe(0);
    expect(r.utterances).toEqual([]);
  });

  it('a breath that Scribe tags as laughter is dropped, and counted', async () => {
    const r = await rig({ pass: LAUGH });
    r.quiet(40);
    for (let i = 0; i < 4; i += 1) r.feed(noise(FRAME, 0.04, 50 + i));
    r.quiet(12);
    await settle();
    expect(r.passes).toBeGreaterThan(0);
    expect(r.utterances).toEqual([]);
    expect(r.events).toContain(false);
    expect(r.events).not.toContain(true);
  });

  it('a real voiced laugh still reaches the companion as "haha"', async () => {
    const r = await rig({ pass: LAUGH });
    r.quiet(40);
    for (let i = 0; i < 4; i += 1) r.feed(vowel(FRAME, 0.05, 220, i * FRAME));
    r.quiet(12);
    await settle();
    expect(r.utterances).toEqual(['haha']);
    expect(r.events).toEqual([true]);
  });

  it('a short spoken word (two frames) is still transcribed', async () => {
    const r = await rig({ pass: 'no' });
    r.quiet(40);
    r.feed(vowel(FRAME, 0.05));
    r.feed(vowel(FRAME, 0.03, 180, FRAME));
    r.quiet(12);
    await settle();
    expect(r.utterances).toEqual(['no']);
  });
});

describe('sensitivity (gateScale)', () => {
  const level = 0.018; // over the default 0.012 open bar, under 2x it
  const talk = async (gateScale: number): Promise<number> => {
    const r = await rig({ pass: 'hello there', gateScale });
    r.quiet(40);
    for (let i = 0; i < 4; i += 1) r.feed(vowel(FRAME, level, 180, i * FRAME));
    r.quiet(12);
    await settle();
    return r.passes;
  };
  it('the default opens on ordinary quiet speech; the lowest setting needs it louder', async () => {
    expect(await talk(1)).toBeGreaterThan(0);
    expect(await talk(2)).toBe(0);
  });
});

describe('input device', () => {
  const domErr = (name: string): Error => Object.assign(new Error(name), { name });

  it('opens the saved device by exact id', async () => {
    await rig({ pass: '', micDeviceId: 'usb-mic' });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia.mock.calls[0][0].audio.deviceId).toEqual({ exact: 'usb-mic' });
  });

  it('an unplugged device falls back to the system default and reports it once', async () => {
    getUserMedia.mockRejectedValueOnce(domErr('OverconstrainedError'));
    const r = await rig({ pass: '', micDeviceId: 'usb-mic' });
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(getUserMedia.mock.calls[1][0].audio.deviceId).toBeUndefined();
    expect(r.fallbacks).toBe(1);
  });

  it('a refusal is not a missing device: no fallback, the call fails as before', async () => {
    getUserMedia.mockRejectedValueOnce(domErr('NotAllowedError'));
    await expect(rig({ pass: '', micDeviceId: 'usb-mic' })).rejects.toMatchObject({ name: 'NotAllowedError' });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });
});
