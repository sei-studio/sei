/**
 * 261123 launch speed: the preload holds renderer calls until main has
 * registered its handlers (app:ipc-ready), in the order they were made.
 */
import { describe, expect, it, vi } from 'vitest';
import { createGatedIpc, type GatedIpc } from './mainReadyGate';

function fakeIpc(gate: Promise<unknown>) {
  const log: string[] = [];
  const raw = {
    invoke: vi.fn((channel: string, ...args: unknown[]) => {
      if (channel === 'app:ipc-ready') return gate;
      log.push(`invoke ${channel} ${JSON.stringify(args)}`);
      return Promise.resolve(`r:${channel}`);
    }),
    send: vi.fn((channel: string, ...args: unknown[]) => {
      log.push(`send ${channel} ${JSON.stringify(args)}`);
    }),
    on: vi.fn(),
    off: vi.fn(),
  };
  return { raw, log, ipc: createGatedIpc(raw as unknown as GatedIpc, 'app:ipc-ready') };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('createGatedIpc', () => {
  it('holds invokes and sends until main answers, then runs them in order', async () => {
    let open!: () => void;
    const { log, ipc } = fakeIpc(new Promise<void>((r) => (open = r)));
    const a = ipc.invoke('config:get');
    ipc.send('analytics:track', { event: 'x' });
    const b = ipc.invoke('chars:list', 1);
    await flush();
    expect(log).toEqual([]);
    open();
    await expect(a).resolves.toBe('r:config:get');
    await expect(b).resolves.toBe('r:chars:list');
    expect(log).toEqual([
      'invoke config:get []',
      'send analytics:track [{"event":"x"}]',
      'invoke chars:list [1]',
    ]);
  });

  it('lets calls through when main has no gate handler', async () => {
    const { log, ipc } = fakeIpc(Promise.reject(new Error('No handler registered')));
    await expect(ipc.invoke('config:get')).resolves.toBe('r:config:get');
    expect(log).toEqual(['invoke config:get []']);
  });

  it('calls straight through once open', async () => {
    const { raw, ipc } = fakeIpc(Promise.resolve());
    await flush();
    ipc.send('app:renderer-ready');
    expect(raw.send).toHaveBeenCalledWith('app:renderer-ready');
  });

  it('never delays push listeners', () => {
    const { raw, ipc } = fakeIpc(new Promise(() => {}));
    const h = () => {};
    ipc.on('auth:state', h);
    ipc.off('auth:state', h);
    expect(raw.on).toHaveBeenCalledWith('auth:state', h);
    expect(raw.off).toHaveBeenCalledWith('auth:state', h);
  });
});
