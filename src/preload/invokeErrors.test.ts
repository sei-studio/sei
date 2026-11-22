/**
 * 261119 product report: a full party showed users "Error invoking remote
 * method 'chars:add-to-library': Error: You can only have 4 companions.
 * Remove one to make room." This drives the real preload bridge over a
 * mocked ipcRenderer that rejects the way Electron does, and checks the
 * renderer receives (and would show) main's message only.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import type { RendererApi } from '../shared/ipc';
import { IpcChannel } from '../shared/ipc';

const LIMIT = 'You can only have 4 companions. Remove one to make room.';

const exposed: { api?: RendererApi } = {};
const invoke = vi.fn();

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_key: string, api: RendererApi) => {
      exposed.api = api;
    },
  },
  ipcRenderer: {
    invoke: (...args: unknown[]) => invoke(...args),
    on: vi.fn(),
    once: vi.fn(),
    send: vi.fn(),
    removeListener: vi.fn(),
    removeAllListeners: vi.fn(),
    off: vi.fn(),
  },
}));

/** What Electron's ipcRenderer.invoke rejects with when a handler throws. */
function electronRejection(channel: string, err: Error): Error {
  return new Error(`Error invoking remote method '${channel}': ${err}`);
}

describe('preload invoke error unwrapping', () => {
  beforeAll(async () => {
    await import('./index');
  });

  it('exposes the bridge', () => {
    expect(exposed.api).toBeTruthy();
  });

  it('rejects chars:add-to-library with the clean companions-limit message', async () => {
    invoke.mockImplementationOnce((channel: string) =>
      Promise.reject(electronRejection(channel, new Error(LIMIT))),
    );
    const err = await exposed.api!.charsAddToLibrary('some-id').then(
      () => null,
      (e: unknown) => e,
    );
    expect(invoke).toHaveBeenLastCalledWith(IpcChannel.chars.addToLibrary, 'some-id');
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(LIMIT);
  });

  it('keeps main error tokens readable for the renderer routing that matches on them', async () => {
    invoke.mockImplementationOnce((channel: string) =>
      Promise.reject(electronRejection(channel, new Error('CHAT_ABORTED'))),
    );
    const err = (await exposed.api!.saveCharacter({} as never).catch((e: unknown) => e)) as Error;
    expect(err.message).toBe('CHAT_ABORTED');
  });

  it('leaves plain values and subscriptions synchronous', () => {
    expect(typeof exposed.api!.platform).toBe('string');
    const off = exposed.api!.onScopeEnding(() => {});
    expect(typeof off).toBe('function');
  });

  it('passes a successful result through untouched', async () => {
    invoke.mockResolvedValueOnce(undefined);
    await expect(exposed.api!.charsAddToLibrary('ok-id')).resolves.toBeUndefined();
  });
});




