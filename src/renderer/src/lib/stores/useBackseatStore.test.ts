/**
 * Tests for useBackseatStore's PENDING SHARE (260803): the arm the chat
 * header's Backseat button leaves behind when it starts a call so the share can
 * begin once that call is live.
 *
 * The lifecycle is the part worth pinning, because every failure mode is
 * silent: a share that fires for the wrong companion, twice, or minutes after
 * the player gave up on it all look like nothing in the code.
 *
 * Invariants under test:
 *   1. armPendingShare records the request; nothing starts yet.
 *   2. consumePendingShare starts the capture and leaves no arm behind, so a
 *      second consume (a re-render of the CallMiniBar effect) cannot double it.
 *   3. consumePendingShare for a DIFFERENT companion does nothing and keeps the
 *      arm. A call with someone else must not steal it.
 *   4. The arm self-clears at the deadline.
 *   5. An arm consumed after the deadline (a lagging timer, e.g. across a
 *      machine sleep) is refused on the clock check, not started late.
 *   6. clearPendingShare drops the arm and its timer.
 *   7. Re-arming replaces the previous arm without its timer clearing the new one.
 *
 * Mock strategy mirrors useChatStore.test.ts: stub `window.sei` on globalThis
 * before importing the store, and import fresh per test for isolation. The
 * capture controller is mocked because it owns real getDisplayMedia/worker
 * machinery that has nothing to do with the arm.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BackseatSource } from '../../../../shared/backseatIpc';

const startCaptureMock = vi.fn();
const stopCaptureMock = vi.fn();

vi.mock('../backseat/captureController', () => ({
  startCapture: (...args: unknown[]) => startCaptureMock(...args),
  stopCapture: (...args: unknown[]) => stopCaptureMock(...args),
}));

let backseatStartMock: ReturnType<typeof vi.fn>;
let backseatEndMock: ReturnType<typeof vi.fn>;

function source(id: string): BackseatSource {
  return { id, name: `window-${id}`, kind: 'window' } as BackseatSource;
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  startCaptureMock.mockReset();
  stopCaptureMock.mockReset();
  startCaptureMock.mockResolvedValue({ stream: { id: 'stream' }, noteSpoke: () => {} });
  backseatStartMock = vi.fn().mockResolvedValue(undefined);
  backseatEndMock = vi.fn().mockResolvedValue(undefined);
  (globalThis as unknown as { window: unknown }).window = {
    sei: {
      onBackseatState: () => () => {},
      onBackseatLine: () => () => {},
      backseatStart: backseatStartMock,
      backseatEnd: backseatEndMock,
      backseatGetState: vi.fn().mockResolvedValue(null),
    },
  };
});

afterEach(() => {
  vi.useRealTimers();
});

async function loadStore() {
  const mod = await import('./useBackseatStore');
  return mod;
}

describe('useBackseatStore pending share', () => {
  it('arms without starting anything', async () => {
    const { useBackseatStore } = await loadStore();
    useBackseatStore.getState().armPendingShare('char-a', source('win-1'));

    const pending = useBackseatStore.getState().pendingShare;
    expect(pending?.characterId).toBe('char-a');
    expect(pending?.source.id).toBe('win-1');
    expect(backseatStartMock).not.toHaveBeenCalled();
    expect(startCaptureMock).not.toHaveBeenCalled();
  });

  it('consumes once: starts the share and clears the arm', async () => {
    const { useBackseatStore } = await loadStore();
    useBackseatStore.getState().armPendingShare('char-a', source('win-1'));

    await expect(useBackseatStore.getState().consumePendingShare('char-a')).resolves.toBe(true);

    expect(backseatStartMock).toHaveBeenCalledTimes(1);
    expect(backseatStartMock).toHaveBeenCalledWith('char-a', 'win-1', 'window-win-1', 'voice');
    expect(useBackseatStore.getState().sharingFor).toBe('char-a');
    expect(useBackseatStore.getState().pendingShare).toBeNull();

    // A second consume (the watchdog effect re-running) must be a no-op.
    await expect(useBackseatStore.getState().consumePendingShare('char-a')).resolves.toBe(false);
    expect(backseatStartMock).toHaveBeenCalledTimes(1);
  });

  it('ignores a consume for a different companion and keeps the arm', async () => {
    const { useBackseatStore } = await loadStore();
    useBackseatStore.getState().armPendingShare('char-a', source('win-1'));

    await expect(useBackseatStore.getState().consumePendingShare('char-b')).resolves.toBe(false);

    expect(backseatStartMock).not.toHaveBeenCalled();
    expect(useBackseatStore.getState().pendingShare?.characterId).toBe('char-a');
  });

  it('self-clears at the deadline', async () => {
    const { useBackseatStore, PENDING_SHARE_TTL_MS } = await loadStore();
    useBackseatStore.getState().armPendingShare('char-a', source('win-1'));

    vi.advanceTimersByTime(PENDING_SHARE_TTL_MS - 1);
    expect(useBackseatStore.getState().pendingShare).not.toBeNull();

    vi.advanceTimersByTime(1);
    expect(useBackseatStore.getState().pendingShare).toBeNull();
    expect(backseatStartMock).not.toHaveBeenCalled();
  });

  it('refuses an expired arm on the clock even if its timer never ran', async () => {
    const { useBackseatStore, PENDING_SHARE_TTL_MS } = await loadStore();
    useBackseatStore.getState().armPendingShare('char-a', source('win-1'));

    // Move the wall clock past the deadline WITHOUT running timers: the shape
    // of a machine that slept through the window.
    vi.setSystemTime(Date.now() + PENDING_SHARE_TTL_MS + 1);

    await expect(useBackseatStore.getState().consumePendingShare('char-a')).resolves.toBe(false);
    expect(backseatStartMock).not.toHaveBeenCalled();
    expect(useBackseatStore.getState().pendingShare).toBeNull();
  });

  it('clearPendingShare drops the arm and its timer', async () => {
    const { useBackseatStore, PENDING_SHARE_TTL_MS } = await loadStore();
    useBackseatStore.getState().armPendingShare('char-a', source('win-1'));
    useBackseatStore.getState().clearPendingShare();

    expect(useBackseatStore.getState().pendingShare).toBeNull();
    // The timer must not resurrect anything or throw when it would have fired.
    vi.advanceTimersByTime(PENDING_SHARE_TTL_MS + 10);
    expect(useBackseatStore.getState().pendingShare).toBeNull();
  });

  it('re-arming replaces the previous arm and its deadline', async () => {
    const { useBackseatStore, PENDING_SHARE_TTL_MS } = await loadStore();
    useBackseatStore.getState().armPendingShare('char-a', source('win-1'));
    vi.advanceTimersByTime(PENDING_SHARE_TTL_MS - 5);
    useBackseatStore.getState().armPendingShare('char-a', source('win-2'));

    expect(useBackseatStore.getState().pendingShare?.source.id).toBe('win-2');
    // The FIRST arm's timer would land here; it must not clear the second.
    vi.advanceTimersByTime(10);
    expect(useBackseatStore.getState().pendingShare?.source.id).toBe('win-2');

    vi.advanceTimersByTime(PENDING_SHARE_TTL_MS);
    expect(useBackseatStore.getState().pendingShare).toBeNull();
  });
});
