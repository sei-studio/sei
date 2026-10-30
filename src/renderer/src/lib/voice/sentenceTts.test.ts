import { describe, expect, it, vi } from 'vitest';
import { createSentenceTts } from './sentenceTts';
import type { AudioQueue } from './audioQueue';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  const slots: Array<{ text?: string; done?: (ok: boolean) => void; push: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn>; fail: ReturnType<typeof vi.fn> }> = [];
  const queue: Pick<AudioQueue, 'enqueueStream'> = {
    enqueueStream: (_id, text, _rate, opts) => {
      const slot = { text, done: opts?.onDone, push: vi.fn(), end: vi.fn(), fail: vi.fn() };
      slots.push(slot);
      return slot;
    },
  };
  const synthesize = vi.fn<(req: { characterId: string; text: string; more?: boolean; prev?: string }) => Promise<ArrayBuffer>>();
  const current = vi.fn(() => true);
  const speak = createSentenceTts(queue, synthesize, current);
  const onDone = vi.fn(); const onError = vi.fn();
  const opts = { rate: 1, onDone, onError, turn: 'turn1' };
  return { slots, synthesize, current, speak, onDone, onError, opts };
}
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

describe('sentence-sized local speech', () => {
  it('delivers the first sentence while the second is pending and preserves line order/context', async () => {
    const f = fixture();
    const a = deferred<ArrayBuffer>(); const b = deferred<ArrayBuffer>();
    f.synthesize.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise)
      .mockResolvedValue(new ArrayBuffer(4));
    const first = f.speak({ characterId: 'c1', text: 'Hello Marco. How are you?', prev: 'Earlier.' }, f.opts);
    const next = f.speak({ characterId: 'c2', text: 'Next reply.' }, { ...f.opts, onDone: undefined });
    expect(f.slots.map((s) => s.text)).toEqual(['Hello Marco.', 'How are you?', 'Next reply.']);
    await tick();
    expect(f.synthesize).toHaveBeenCalledTimes(1);
    a.resolve(new ArrayBuffer(4)); await tick();
    expect(f.slots[0].end).toHaveBeenCalledOnce();
    expect(f.slots[1].end).not.toHaveBeenCalled();
    expect(f.synthesize).toHaveBeenNthCalledWith(1, { characterId: 'c1', text: 'Hello Marco.', more: true, prev: 'Earlier.' });
    expect(f.synthesize).toHaveBeenNthCalledWith(2, { characterId: 'c1', text: 'How are you?', more: false, prev: 'Hello Marco.' });
    f.slots[0].done?.(true); expect(f.onDone).not.toHaveBeenCalled();
    b.resolve(new ArrayBuffer(4)); await first; await next;
    f.slots[1].done?.(true); expect(f.onDone).toHaveBeenCalledExactlyOnceWith(true);
    expect(f.synthesize.mock.calls[2][0].characterId).toBe('c2');
  });
  it('drops an in-flight completion and never synthesizes the rest after interrupt', async () => {
    const f = fixture(); const audio = deferred<ArrayBuffer>();
    f.synthesize.mockReturnValue(audio.promise);
    const job = f.speak({ characterId: 'c1', text: 'First sentence. Second sentence.' }, f.opts);
    await tick(); f.slots[0].done?.(false); audio.resolve(new ArrayBuffer(4)); await job;
    expect(f.synthesize).toHaveBeenCalledTimes(1);
    expect(f.slots[0].push).not.toHaveBeenCalled();
    expect(f.slots[1].fail).toHaveBeenCalled();
    expect(f.onDone).toHaveBeenCalledExactlyOnceWith(false);
    expect(f.onError).not.toHaveBeenCalled();
  });
  it('fails reservations on synthesis failure, then allows the next line', async () => {
    const f = fixture();
    f.synthesize.mockRejectedValueOnce(new Error('VOICE_PACK_MISSING:tts-kokoro'))
      .mockResolvedValue(new ArrayBuffer(4));
    await f.speak({ characterId: 'c1', text: 'First sentence. Second sentence.' }, f.opts);
    expect(f.onError).toHaveBeenCalledOnce();
    expect(f.slots.every((s) => s.fail.mock.calls.length === 1)).toBe(true);
    await f.speak({ characterId: 'c1', text: 'Recovered.' }, f.opts);
    expect(f.slots[2].end).toHaveBeenCalledOnce();
  });
  it('skips superseded queued jobs and refuses work from an ended call', async () => {
    const f = fixture(); const audio = deferred<ArrayBuffer>();
    f.synthesize.mockReturnValue(audio.promise);
    const a = f.speak({ characterId: 'c1', text: 'Current.' }, f.opts);
    const b = f.speak({ characterId: 'c1', text: 'Stale sentence. More stale.' }, f.opts);
    await tick(); f.slots[1].done?.(false);
    f.current.mockReturnValue(false); audio.resolve(new ArrayBuffer(4));
    await a; await b;
    expect(f.synthesize).toHaveBeenCalledTimes(1);
    expect(f.slots.every((s) => !s.push.mock.calls.length)).toBe(true);
  });
  it('keeps decimals, CJK and a final unpunctuated tail', async () => {
    const f = fixture(); f.synthesize.mockResolvedValue(new ArrayBuffer(4));
    await f.speak({ characterId: 'c1', text: 'The value is 3.14. 你好。これは試験です！ Final tail', more: true }, f.opts);
    expect(f.slots.map((s) => s.text)).toEqual(['The value is 3.14.', '你好。', 'これは試験です！', 'Final tail']);
    expect(f.synthesize.mock.calls.every(([r]) => r.more === true)).toBe(true);
  });
});
