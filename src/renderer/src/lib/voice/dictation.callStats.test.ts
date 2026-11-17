/**
 * The dictation's running totals for voice_call_ended (261118): unmuted mic
 * frames that reached the speech floor, and transcription passes started.
 * Same stubs as dictation.barge.test.ts: the real VAD frame loop is driven
 * with constant-level frames (RMS = the fill value), STT is a cloud-only mock
 * and performance.now is a hand-advanced clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDictation } from './dictation';

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

const QUIET = 0.002; // a dead mic's hiss
const VOICE = 0.045; // ordinary speech at a laptop mic

async function rig() {
  const utterances: string[] = [];
  const cloudTranscribe = vi.fn(async () => 'hello there');
  const dictation = await createDictation({
    localModel: 'none',
    cloudTranscribe,
    onUtterance: (text) => {
      utterances.push(text);
    },
    onStatus: () => {},
  });
  const node = nodes[nodes.length - 1];
  const frame = (rms: number, n = 1): void => {
    for (let i = 0; i < n; i += 1) {
      clock += FRAME_MS;
      node.port.onmessage?.({ data: new Float32Array(FRAME).fill(rms) });
    }
  };
  return { dictation, frame, utterances, cloudTranscribe };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

describe('dictation callStats (261118)', () => {
  it('starts at zero', async () => {
    const r = await rig();
    expect(r.dictation.callStats()).toEqual({ heardFrames: 0, sttRequests: 0 });
    r.dictation.stop();
  });

  it('a mic that only delivers hiss is never heard and never transcribed', async () => {
    const r = await rig();
    r.frame(QUIET, 200);
    await flush();
    expect(r.dictation.callStats()).toEqual({ heardFrames: 0, sttRequests: 0 });
    r.dictation.stop();
  });

  it('speech counts heard frames and the transcription passes it starts', async () => {
    const r = await rig();
    r.frame(QUIET, 20);
    r.frame(VOICE, 10);
    r.frame(QUIET, 10);
    await flush();
    const s = r.dictation.callStats();
    expect(s.heardFrames).toBeGreaterThanOrEqual(10);
    expect(s.sttRequests).toBe(r.cloudTranscribe.mock.calls.length);
    expect(s.sttRequests).toBeGreaterThanOrEqual(1);
    expect(r.utterances).toEqual(['hello there']);
    r.dictation.stop();
  });

  it('muted audio is not counted as heard', async () => {
    const r = await rig();
    r.dictation.setMuted(true);
    r.frame(VOICE, 20);
    await flush();
    expect(r.dictation.callStats()).toEqual({ heardFrames: 0, sttRequests: 0 });
    r.dictation.stop();
  });

  it('totals survive a mic switch (they are per call, not per device)', async () => {
    const r = await rig();
    r.frame(VOICE, 3);
    const before = r.dictation.callStats().heardFrames;
    await expect(r.dictation.switchInput('mic-2')).resolves.toBe(true);
    expect(r.dictation.callStats().heardFrames).toBe(before);
    r.dictation.stop();
  });
});
