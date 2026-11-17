/**
 * createDictation's failure paths (261023): each step that can stop a call
 * from starting tags its error with the stage, keeps the original error name
 * (friendlyError and the mic card read it), and releases what it already
 * opened. The browser pieces are stubbed; only the setup sequence runs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDictation } from './dictation';
import { callSetupFailureProps } from './callSetupFailure';

type WorkerMode = 'ready' | 'init-error' | 'load-error';

let workerMode: WorkerMode = 'ready';
let workers: FakeWorker[] = [];

class FakeWorker {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: { preventDefault: () => void }) => void) | null = null;
  terminated = false;
  constructor() {
    workers.push(this);
  }
  postMessage(msg: { type: string }): void {
    if (msg.type !== 'init') return;
    queueMicrotask(() => {
      if (workerMode === 'ready') this.onmessage?.({ data: { type: 'ready' } });
      else if (workerMode === 'init-error')
        this.onmessage?.({ data: { type: 'init-error', message: 'fetch failed for https://huggingface.co/x' } });
      else this.onerror?.({ preventDefault: () => {} });
    });
  }
  terminate(): void {
    this.terminated = true;
  }
}

function domErr(name: string, message = ''): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

let track: { stop: ReturnType<typeof vi.fn> };
let getUserMedia: ReturnType<typeof vi.fn>;
let ctxMode: 'ok' | 'ctor-throws' | 'addmodule-rejects' = 'ok';
let contexts: Array<{ close: ReturnType<typeof vi.fn> }> = [];

class FakeAudioContext {
  close = vi.fn(async () => {});
  audioWorklet = {
    addModule: vi.fn(async () => {
      if (ctxMode === 'addmodule-rejects') throw domErr('AbortError', 'Unable to load a worklet');
    }),
  };
  destination = {};
  constructor() {
    if (ctxMode === 'ctor-throws') throw domErr('NotSupportedError', 'sample rate');
    contexts.push(this);
  }
  createMediaStreamSource(): { connect: () => void; disconnect: () => void } {
    return { connect: () => {}, disconnect: () => {} };
  }
  createGain(): { gain: { value: number }; connect: () => void; disconnect: () => void } {
    return { gain: { value: 0 }, connect: () => {}, disconnect: () => {} };
  }
}

class FakeWorkletNode {
  port = { onmessage: null as unknown };
  connect(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  workerMode = 'ready';
  workers = [];
  ctxMode = 'ok';
  contexts = [];
  track = { stop: vi.fn() };
  getUserMedia = vi.fn(async () => ({ getTracks: () => [track] }));
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('AudioWorkletNode', FakeWorkletNode);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const baseOpts = () => ({
  onUtterance: () => {},
  onStatus: vi.fn(),
});

async function failure(opts: Parameters<typeof createDictation>[0]): Promise<unknown> {
  try {
    await createDictation(opts);
  } catch (err) {
    return err;
  }
  throw new Error('expected createDictation to fail');
}

describe('createDictation setup failures', () => {
  it('a mic another app holds is mic_capture / NotReadableError, and the model worker is stopped', async () => {
    getUserMedia.mockRejectedValueOnce(domErr('NotReadableError', 'Could not start audio source'));
    const err = await failure({ ...baseOpts(), localModel: 'eager' });
    expect((err as Error).name).toBe('NotReadableError');
    expect(callSetupFailureProps(err)).toEqual({ stage: 'mic_capture', error_name: 'NotReadableError' });
    expect(workers[0]?.terminated).toBe(true);
  });

  it('a refused mic is mic_permission and keeps its name for the mic card', async () => {
    getUserMedia.mockRejectedValueOnce(domErr('NotAllowedError', 'Permission denied by system'));
    const err = await failure({ ...baseOpts(), localModel: 'none' });
    expect((err as Error).name).toBe('NotAllowedError');
    expect(callSetupFailureProps(err)).toEqual({ stage: 'mic_permission', error_name: 'NotAllowedError' });
  });

  it('a model that fails to load is stt_boot / ModelLoadError and closes the mic', async () => {
    workerMode = 'init-error';
    const err = await failure({ ...baseOpts(), localModel: 'eager' });
    expect(callSetupFailureProps(err)).toEqual({ stage: 'stt_boot', error_name: 'ModelLoadError' });
    expect(track.stop).toHaveBeenCalled();
    expect(workers[0]?.terminated).toBe(true);
  });

  it('a worker script that never loads fails fast as stt_boot / WorkerLoadError', async () => {
    workerMode = 'load-error';
    const err = await failure({ ...baseOpts(), localModel: 'eager' });
    expect(callSetupFailureProps(err)).toEqual({ stage: 'stt_boot', error_name: 'WorkerLoadError' });
    expect(track.stop).toHaveBeenCalled();
  });

  it('an AudioContext that cannot be built is audio_graph, and the mic is released', async () => {
    ctxMode = 'ctor-throws';
    const err = await failure({ ...baseOpts(), localModel: 'none' });
    expect(callSetupFailureProps(err)).toEqual({ stage: 'audio_graph', error_name: 'NotSupportedError' });
    // Before 261023 this throw skipped the cleanup and left the mic open.
    expect(track.stop).toHaveBeenCalled();
  });

  it('a capture worklet that will not load is audio_graph, and the context is closed', async () => {
    ctxMode = 'addmodule-rejects';
    const err = await failure({ ...baseOpts(), localModel: 'none' });
    expect(callSetupFailureProps(err)).toEqual({ stage: 'audio_graph', error_name: 'AbortError' });
    expect(contexts[0]?.close).toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalled();
  });

  it('cloud-only calls never boot a worker', async () => {
    getUserMedia.mockRejectedValueOnce(domErr('NotFoundError', 'Requested device not found'));
    const err = await failure({ ...baseOpts(), localModel: 'none' });
    expect(workers).toHaveLength(0);
    expect(callSetupFailureProps(err)).toEqual({ stage: 'mic_capture', error_name: 'NotFoundError' });
  });
});

describe('createDictation input device (261118)', () => {
  const streamOf = (t: { stop: ReturnType<typeof vi.fn> }) => ({ getTracks: () => [t] });

  it('opens the saved mic with an exact deviceId', async () => {
    const d = await createDictation({ ...baseOpts(), localModel: 'none', inputDeviceId: 'mic-1' });
    expect(getUserMedia.mock.calls[0][0].audio.deviceId).toEqual({ exact: 'mic-1' });
    expect(getUserMedia.mock.calls[0][0].audio.echoCancellation).toBe(true);
    d.stop();
  });

  it('a saved mic that is gone falls back to the default and reports it, the call still starts', async () => {
    getUserMedia.mockRejectedValueOnce(domErr('OverconstrainedError', 'deviceId'));
    const onInputDeviceGone = vi.fn();
    const d = await createDictation({ ...baseOpts(), localModel: 'none', inputDeviceId: 'gone', onInputDeviceGone });
    expect(onInputDeviceGone).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(getUserMedia.mock.calls[1][0].audio.deviceId).toBeUndefined();
    d.stop();
  });

  it('a refusal on the saved mic is still a refusal (no silent fallback)', async () => {
    getUserMedia.mockRejectedValueOnce(domErr('NotAllowedError', 'Permission denied'));
    const err = await failure({ ...baseOpts(), localModel: 'none', inputDeviceId: 'mic-1' });
    expect(callSetupFailureProps(err)).toEqual({ stage: 'mic_permission', error_name: 'NotAllowedError' });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('switchInput moves capture to the new mic, stops the old one', async () => {
    const d = await createDictation({ ...baseOpts(), localModel: 'none' });
    const next = { stop: vi.fn() };
    getUserMedia.mockResolvedValueOnce(streamOf(next));
    await expect(d.switchInput('mic-2')).resolves.toBe(true);
    expect(getUserMedia.mock.calls[1][0].audio.deviceId).toEqual({ exact: 'mic-2' });
    expect(track.stop).toHaveBeenCalled();
    expect(next.stop).not.toHaveBeenCalled();
    d.stop();
    expect(next.stop).toHaveBeenCalled();
  });

  it('a switch that cannot open the new mic keeps the current one', async () => {
    const d = await createDictation({ ...baseOpts(), localModel: 'none' });
    getUserMedia.mockRejectedValueOnce(domErr('NotReadableError', 'busy'));
    await expect(d.switchInput('busy-mic')).resolves.toBe(false);
    expect(track.stop).not.toHaveBeenCalled();
    d.stop();
  });

  it('only the latest of two quick switches lands', async () => {
    const d = await createDictation({ ...baseOpts(), localModel: 'none' });
    const first = { stop: vi.fn() };
    const second = { stop: vi.fn() };
    let releaseFirst: (v: unknown) => void = () => {};
    getUserMedia.mockImplementationOnce(() => new Promise((r) => (releaseFirst = () => r(streamOf(first)))));
    getUserMedia.mockResolvedValueOnce(streamOf(second));
    const a = d.switchInput('a');
    const b = d.switchInput('b');
    await expect(b).resolves.toBe(true);
    releaseFirst(undefined);
    await expect(a).resolves.toBe(false);
    expect(first.stop).toHaveBeenCalled();
    expect(second.stop).not.toHaveBeenCalled();
    d.stop();
  });
});
