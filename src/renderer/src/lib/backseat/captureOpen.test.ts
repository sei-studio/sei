import { describe, expect, it, vi } from 'vitest';
import {
  CaptureStartError,
  desktopVideoConstraints,
  openWithRetry,
  pickScreenSource,
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
    const r = await openWithRetry(WIN, open, async () => SCREEN);
    expect(r).toEqual({ value: 'stream', source: WIN, retry: 'none' });
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(WIN.id, false);
  });

  it('a busy window recovers on the relaxed retry', async () => {
    const open = vi.fn().mockRejectedValueOnce(busy()).mockResolvedValue('stream');
    const onRetry = vi.fn();
    const r = await openWithRetry(WIN, open, async () => SCREEN, onRetry);
    expect(r).toMatchObject({ source: WIN, retry: 'relaxed_ok', firstClass: 'busy' });
    expect(open.mock.calls).toEqual([
      [WIN.id, false],
      [WIN.id, true],
    ]);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('a window still busy falls back to the whole screen', async () => {
    const open = vi.fn().mockRejectedValueOnce(busy()).mockRejectedValueOnce(busy()).mockResolvedValue('stream');
    const r = await openWithRetry(WIN, open, async () => SCREEN);
    expect(r).toMatchObject({ value: 'stream', source: SCREEN, retry: 'screen_ok' });
    expect(open.mock.calls[2]).toEqual([SCREEN.id, true]);
  });

  it('a busy SCREEN is retried once and never "falls back" to another screen', async () => {
    const open = vi.fn().mockRejectedValue(busy());
    const findScreen = vi.fn().mockResolvedValue(SCREEN);
    const err = await openWithRetry(SCREEN, open, findScreen).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CaptureStartError);
    expect(err).toMatchObject({ sourceKind: 'screen', firstClass: 'busy', retry: 'failed' });
    expect(open).toHaveBeenCalledTimes(2);
    expect(findScreen).not.toHaveBeenCalled();
  });

  it('when everything fails the error keeps the DOMException name', async () => {
    const open = vi.fn().mockRejectedValue(busy());
    const err = await openWithRetry(WIN, open, async () => SCREEN).catch((e: unknown) => e);
    expect(err).toMatchObject({ sourceKind: 'window', retry: 'failed', name: 'NotReadableError' });
    expect(captureErrorClass(err)).toBe('busy');
    expect(open).toHaveBeenCalledTimes(3);
  });

  it('no screen to fall back to: fails after the relaxed retry', async () => {
    const open = vi.fn().mockRejectedValue(busy());
    const err = await openWithRetry(WIN, open, async () => null).catch((e: unknown) => e);
    expect(err).toMatchObject({ retry: 'failed' });
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('a permission refusal is not retried', async () => {
    const open = vi.fn().mockRejectedValue(named('NotAllowedError'));
    const onRetry = vi.fn();
    const err = await openWithRetry(WIN, open, async () => SCREEN, onRetry).catch((e: unknown) => e);
    expect(err).toMatchObject({ firstClass: 'permission', retry: 'none' });
    expect(captureErrorClass(err)).toBe('permission');
    expect(open).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });
});

describe('pickScreenSource', () => {
  it('takes the first screen', () => {
    expect(pickScreenSource([WIN, SCREEN, { id: 'screen:1:0', name: 'Screen 2' }])).toBe(SCREEN);
    expect(pickScreenSource([WIN])).toBeNull();
  });
});
