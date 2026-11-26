import { describe, expect, it, vi } from 'vitest';
import {
  CaptureStartError,
  desktopVideoConstraints,
  openWithRetry,
} from './captureOpen';
import { captureErrorClass } from '../../../../shared/callEndReasons';

const named = (name: string, message = 'x'): Error => Object.assign(new Error(message), { name });
const busy = (): Error => named('NotReadableError', 'Could not start video source');
const WIN = { id: 'window:123:0', name: 'Roblox' };
const SCREEN = { id: 'screen:0:0', name: 'Entire screen' };

describe('desktopVideoConstraints', () => {
  const cap = { width: 1280, height: 720, fps: 30 };
  it('caps size and rate on the normal request', () => {
    const c = desktopVideoConstraints('window:1:0', false, cap) as unknown as { mandatory: Record<string, unknown> };
    expect(c.mandatory).toEqual({
      chromeMediaSource: 'desktop',
      chromeMediaSourceId: 'window:1:0',
      maxWidth: 1280,
      maxHeight: 720,
      maxFrameRate: 30,
    });
  });
  it('the relaxed request carries no max at all', () => {
    const c = desktopVideoConstraints('window:1:0', true, cap) as unknown as { mandatory: Record<string, unknown> };
    expect(c.mandatory).toEqual({ chromeMediaSource: 'desktop', chromeMediaSourceId: 'window:1:0' });
  });
});

describe('openWithRetry', () => {
  it('a clean start does not retry', async () => {
    const open = vi.fn().mockResolvedValue('stream');
    const r = await openWithRetry(WIN, open);
    expect(r).toEqual({ value: 'stream', retry: 'none' });
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(WIN.id, false);
  });

  it('a busy window recovers on the relaxed retry', async () => {
    const open = vi.fn().mockRejectedValueOnce(busy()).mockResolvedValue('stream');
    const onRetry = vi.fn();
    const r = await openWithRetry(WIN, open, onRetry);
    expect(r).toMatchObject({ value: 'stream', retry: 'relaxed_ok', firstClass: 'busy' });
    expect(open.mock.calls).toEqual([
      [WIN.id, false],
      [WIN.id, true],
    ]);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('a window still busy fails and is NEVER widened to the whole screen (261123)', async () => {
    const open = vi.fn().mockRejectedValueOnce(busy()).mockRejectedValueOnce(busy()).mockResolvedValue('stream');
    const err = await openWithRetry(WIN, open).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CaptureStartError);
    expect(err).toMatchObject({ sourceKind: 'window', firstClass: 'busy', retry: 'failed', name: 'NotReadableError' });
    expect(captureErrorClass(err)).toBe('busy');
    expect(open).toHaveBeenCalledTimes(2);
    // Every attempt was the window the player picked.
    for (const [id] of open.mock.calls) expect(id).toBe(WIN.id);
  });

  it('a busy screen is retried once on the same screen', async () => {
    const open = vi.fn().mockRejectedValue(busy());
    const err = await openWithRetry(SCREEN, open).catch((e: unknown) => e);
    expect(err).toMatchObject({ sourceKind: 'screen', firstClass: 'busy', retry: 'failed' });
    expect(open.mock.calls).toEqual([
      [SCREEN.id, false],
      [SCREEN.id, true],
    ]);
  });

  it('the relaxed retry failing differently keeps the first class', async () => {
    const open = vi.fn().mockRejectedValueOnce(busy()).mockRejectedValueOnce(named('NotFoundError'));
    const err = await openWithRetry(WIN, open).catch((e: unknown) => e);
    expect(err).toMatchObject({ firstClass: 'busy', retry: 'failed', name: 'NotFoundError' });
  });

  it('a permission refusal is not retried', async () => {
    const open = vi.fn().mockRejectedValue(named('NotAllowedError'));
    const onRetry = vi.fn();
    const err = await openWithRetry(WIN, open, onRetry).catch((e: unknown) => e);
    expect(err).toMatchObject({ firstClass: 'permission', retry: 'none' });
    expect(captureErrorClass(err)).toBe('permission');
    expect(open).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });
});
