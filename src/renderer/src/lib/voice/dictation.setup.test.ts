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




