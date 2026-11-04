import { describe, it, expect, vi, afterEach } from 'vitest';
import { AvatarRelay, RELAY_FILE_MAX_BYTES, type FileReader } from './avatarRelay';
import type { FromHost } from './protocol';

type Call = Extract<FromHost, { type: 'call' }>;

function setup(files: Record<string, number> = {}, timeoutMs = 1000): { relay: AvatarRelay; sent: Call[] } {
  const sent: Call[] = [];
  const reader: FileReader = {
    size: async (f) => {
      if (!(f in files)) throw new Error('ENOENT');
      return files[f];
    },
    read: async (f) => {
      if (!(f in files)) throw new Error('ENOENT');
      return new Uint8Array([files[f] % 256]);
    },
  };
  return { relay: new AvatarRelay((m) => sent.push(m), reader, timeoutMs), sent };
}

afterEach(() => vi.useRealTimers());

describe('AvatarRelay', () => {
  it('forwards a call and resolves with main\'s value', async () => {
    const { relay, sent } = setup();
    const p = relay.call('avatarGet', ['c1']);
    await Promise.resolve();
    expect(sent).toEqual([{ type: 'call', id: 1, method: 'avatarGet', args: ['c1'] }]);
    relay.onResult({ type: 'call-result', id: 1, ok: true, value: { entry: 'm.model3.json' } });
    await expect(p).resolves.toEqual({ entry: 'm.model3.json' });
    expect(relay.inFlight).toBe(0);
  });

  it('refuses unknown methods and non-string args without asking main', async () => {
    const { relay, sent } = setup();
    await expect(relay.call('avatarRemove', ['c1'])).rejects.toThrow('unknown method');
    await expect(relay.call('avatarGet', [{}])).rejects.toThrow('bad arguments');
    expect(sent).toHaveLength(0);
  });

  it('reads facepack and model files main names, within the limits', async () => {
    const { relay, sent } = setup({ '/a/face.webp': 7, '/a/big.webp': RELAY_FILE_MAX_BYTES + 1, '/m/x.moc3': 3 });
    const small = relay.call('facepackFile', ['sui', 'face.webp']);
    const big = relay.call('facepackFile', ['sui', 'big.webp']);
    const model = relay.call('avatarModelFiles', ['c1']);
    await Promise.resolve();
    relay.onResult({ type: 'call-result', id: sent[0].id, ok: true, value: { file: '/a/face.webp' } });
    relay.onResult({ type: 'call-result', id: sent[1].id, ok: true, value: { file: '/a/big.webp' } });
    relay.onResult({
      type: 'call-result',
      id: sent[2].id,
      ok: true,
      value: [
        { path: 'x.moc3', file: '/m/x.moc3' },
        { path: 'gone.png', file: '/m/gone.png' },
      ],
    });
    await expect(small).resolves.toEqual(new Uint8Array([7]));
    await expect(big).resolves.toBeNull();
    await expect(model).resolves.toEqual([{ path: 'x.moc3', bytes: new Uint8Array([3]) }]);
  });

  it('rejects on an error answer, a timeout and a closing pipe', async () => {
    vi.useFakeTimers();
    const { relay, sent } = setup({}, 500);
    const bad = relay.call('facepackManifest', ['sui']);
    relay.onResult({ type: 'call-result', id: 1, ok: false, error: 'nope' });
    await expect(bad).rejects.toThrow('nope');
    const slow = relay.call('avatarGet', ['c1']);
    const slowDone = expect(slow).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(600);
    await slowDone;
    const closing = relay.call('avatarGet', ['c1']);
    await Promise.resolve();
    relay.rejectAll();
    await expect(closing).rejects.toThrow('closing');
    expect(sent).toHaveLength(3);
  });
});
