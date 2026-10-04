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
    expect(pending?.source?.id).toBe('win-1');
    expect(backseatStartMock).not.toHaveBeenCalled();
    expect(startCaptureMock).not.toHaveBeenCalled();
  });

  it('consumes once: starts the share and clears the arm', async () => {
    const { useBackseatStore } = await loadStore();
    useBackseatStore.getState().armPendingShare('char-a', source('win-1'));

    await expect(useBackseatStore.getState().consumePendingShare('char-a')).resolves.toBe(true);

    expect(backseatStartMock).toHaveBeenCalledTimes(1);
    // No game selection on an ordinary share (260929: a backseat game tile
    // arms one, see the test below).
    expect(backseatStartMock).toHaveBeenCalledWith('char-a', 'win-1', 'window-win-1', 'voice', undefined);
    expect(useBackseatStore.getState().sharingFor).toBe('char-a');
    expect(useBackseatStore.getState().pendingShare).toBeNull();

    // A second consume (the watchdog effect re-running) must be a no-op.
    await expect(useBackseatStore.getState().consumePendingShare('char-a')).resolves.toBe(false);
    expect(backseatStartMock).toHaveBeenCalledTimes(1);
  });

  it('carries a backseat game selection from the arm to the start', async () => {
    const { useBackseatStore } = await loadStore();
    const game = { gameId: 'roblox', universeId: 1686885941 };
    useBackseatStore.getState().armPendingShare('char-a', source('win-1'), game);

    await expect(useBackseatStore.getState().consumePendingShare('char-a')).resolves.toBe(true);
    expect(backseatStartMock).toHaveBeenCalledWith('char-a', 'win-1', 'window-win-1', 'voice', game);
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

    expect(useBackseatStore.getState().pendingShare?.source?.id).toBe('win-2');
    // The FIRST arm's timer would land here; it must not clear the second.
    vi.advanceTimersByTime(10);
    expect(useBackseatStore.getState().pendingShare?.source?.id).toBe('win-2');

    vi.advanceTimersByTime(PENDING_SHARE_TTL_MS);
    expect(useBackseatStore.getState().pendingShare).toBeNull();
  });
});

describe('useBackseatStore vision-gate error mapping (china-compat W9)', () => {
  it("maps main's LLM_NO_VISION refusal to the shared gate copy", async () => {
    backseatStartMock.mockRejectedValue(
      new Error(
        'LLM_NO_VISION: the selected model cannot see images, so screen sharing is unavailable. Pick a vision-capable model in Settings.',
      ),
    );
    const { useBackseatStore } = await loadStore();
    const { useUiStore } = await import('./useUiStore');
    useUiStore.setState({ llmVision: 'no', llmModel: 'deepseek-v4-flash' });

    await expect(useBackseatStore.getState().share('char-a', source('win-1'))).resolves.toBe(false);

    expect(useBackseatStore.getState().error).toBe(
      'Screen sharing needs a model that can see images. Your current model (deepseek-v4-flash) does not support vision.',
    );
    // Capture must never have started against a refused session.
    expect(startCaptureMock).not.toHaveBeenCalled();
  });

  it('keeps the generic copy for other start failures', async () => {
    backseatStartMock.mockRejectedValue(new Error('something else broke'));
    const { useBackseatStore } = await loadStore();

    await expect(useBackseatStore.getState().share('char-a', source('win-1'))).resolves.toBe(false);
    expect(useBackseatStore.getState().error).toBe(
      'Could not start sharing. Try picking a different window.',
    );
  });
});

/**
 * share() racing an account switch (260926): resetForScope bumps the epoch; a
 * share begun under the previous account must not come up afterwards, and a
 * session main registered for it must be ended rather than left orphaned.
 */
describe('useBackseatStore share() across an account switch', () => {
  it('main accepted the session, then the account changed: ends it, starts no capture', async () => {
    const { useBackseatStore } = await loadStore();
    let accept!: () => void;
    backseatStartMock.mockImplementationOnce(() => new Promise<void>((r) => (accept = r)));
    const sharing = useBackseatStore.getState().share('char-a', source('win-1'));
    useBackseatStore.getState().resetForScope();
    accept();
    expect(await sharing).toBe(false);
    expect(backseatEndMock).toHaveBeenCalledWith('char-a');
    expect(startCaptureMock).not.toHaveBeenCalled();
    const st = useBackseatStore.getState();
    expect(st.sharingFor).toBeNull();
    expect(st.stream).toBeNull();
    expect(st.starting).toBe(false);
    expect(st.active).toEqual({});
  });

  it('the account changed while capture was coming up: stops capture and ends the session', async () => {
    const { useBackseatStore } = await loadStore();
    let captured!: (h: unknown) => void;
    startCaptureMock.mockImplementationOnce(() => new Promise((r) => (captured = r)));
    const sharing = useBackseatStore.getState().share('char-a', source('win-1'));
    // Let backseatStart resolve and startCapture begin.
    for (let i = 0; i < 10 && !captured; i++) await Promise.resolve();
    expect(startCaptureMock).toHaveBeenCalled();
    useBackseatStore.getState().resetForScope();
    stopCaptureMock.mockClear();
    captured({ stream: { id: 'late' }, noteSpoke: () => {} });
    expect(await sharing).toBe(false);
    expect(stopCaptureMock).toHaveBeenCalledTimes(1);
    expect(backseatEndMock).toHaveBeenCalledWith('char-a');
    expect(useBackseatStore.getState().sharingFor).toBeNull();
    expect(useBackseatStore.getState().stream).toBeNull();
  });

  it('main refused because the account is changing: no error shown after the reset', async () => {
    const { useBackseatStore } = await loadStore();
    let refuse!: (e: Error) => void;
    backseatStartMock.mockImplementationOnce(() => new Promise<void>((_r, j) => (refuse = j)));
    const sharing = useBackseatStore.getState().share('char-a', source('win-1'));
    useBackseatStore.getState().resetForScope();
    refuse(new Error('ACCOUNT_SWITCHING: the account is changing, try again in a moment'));
    expect(await sharing).toBe(false);
    expect(useBackseatStore.getState().error).toBeNull();
    expect(useBackseatStore.getState().starting).toBe(false);
  });

  it('control: with no switch the share comes up', async () => {
    const { useBackseatStore } = await loadStore();
    expect(await useBackseatStore.getState().share('char-a', source('win-1'))).toBe(true);
    expect(backseatEndMock).not.toHaveBeenCalled();
    expect(useBackseatStore.getState().sharingFor).toBe('char-a');
  });
});

/**
 * The auto-share watch (261004): a Roblox backseat session skips the share
 * picker and waits for the Roblox window, sharing it by itself, and waiting
 * again when it closes. Every one of these failures is silent in the app (a
 * share that never starts, starts twice, or keeps restarting after the
 * player said stop), so the lifecycle is pinned here.
 */
describe('useBackseatStore auto-share watch', () => {
  const ROBLOX = { gameId: 'roblox', universeId: 1686885941 };
  let windows: BackseatSource[];
  let sourcesMock: ReturnType<typeof vi.fn>;

  function win(id: string, name: string): BackseatSource {
    return { id, name, kind: 'window', thumbnail: '' };
  }

  beforeEach(() => {
    windows = [win('w:1', 'Notes')];
    sourcesMock = vi.fn(async () => windows);
    (window as unknown as { sei: Record<string, unknown> }).sei.backseatSources = sourcesMock;
  });

  /** Run the watch's timers far enough for a look plus the settle look. */
  async function settle(ms = 0): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
  }

  it('waits while the game is not open, then shares its window once it has settled', async () => {
    const { useBackseatStore, WATCH_POLL_MS, WATCH_SETTLE_MS } = await loadStore();
    useBackseatStore.getState().startWatch('char-a', ROBLOX);
    await settle(WATCH_POLL_MS * 3);

    expect(sourcesMock).toHaveBeenCalled();
    // Titles only: the watch never asks for thumbnails.
    expect(sourcesMock).toHaveBeenCalledWith({ thumbnails: false });
    expect(backseatStartMock).not.toHaveBeenCalled();
    expect(useBackseatStore.getState().watch?.characterId).toBe('char-a');

    windows = [win('w:9', 'Roblox'), ...windows];
    await settle(WATCH_POLL_MS);
    // Seen once: not shared yet (a launcher window can flash up and close).
    expect(backseatStartMock).not.toHaveBeenCalled();
    await settle(WATCH_SETTLE_MS);

    expect(backseatStartMock).toHaveBeenCalledTimes(1);
    expect(backseatStartMock).toHaveBeenCalledWith('char-a', 'w:9', 'Roblox', 'voice', ROBLOX);
    expect(useBackseatStore.getState().sharingFor).toBe('char-a');
    // Still watching, so a closed window means waiting again, not the end.
    expect(useBackseatStore.getState().watch).not.toBeNull();
  });

  it('picks the frontmost game window and never a browser tab about the game', async () => {
    const { useBackseatStore, WATCH_SETTLE_MS } = await loadStore();
    windows = [
      win('w:1', 'Brookhaven - Roblox - Google Chrome'),
      win('w:2', 'Roblox'),
      win('w:3', 'Roblox'),
    ];
    useBackseatStore.getState().startWatch('char-a', ROBLOX);
    await settle(WATCH_SETTLE_MS + 10);
    expect(backseatStartMock).toHaveBeenCalledWith('char-a', 'w:2', 'Roblox', 'voice', ROBLOX);
  });

  it('a closed game window pauses the share and waits for the game to come back', async () => {
    const { useBackseatStore, WATCH_POLL_MS, WATCH_SETTLE_MS } = await loadStore();
    windows = [win('w:9', 'Roblox')];
    useBackseatStore.getState().startWatch('char-a', ROBLOX);
    await settle(WATCH_SETTLE_MS + 10);
    expect(useBackseatStore.getState().sharingFor).toBe('char-a');

    // The OS ends the track when the window closes; the capture controller
    // ends main's session and reports it.
    windows = [];
    const opts = startCaptureMock.mock.calls[0][3] as { onEnded: () => void };
    opts.onEnded();

    const st = useBackseatStore.getState();
    expect(st.sharingFor).toBeNull();
    expect(st.stream).toBeNull();
    expect(st.active['char-a']).toBeUndefined();
    expect(st.watch?.resumed).toBe(true);

    await settle(WATCH_POLL_MS * 2);
    expect(backseatStartMock).toHaveBeenCalledTimes(1);

    windows = [win('w:12', 'Roblox')];
    await settle(WATCH_POLL_MS + WATCH_SETTLE_MS + 10);
    expect(backseatStartMock).toHaveBeenCalledTimes(2);
    expect(backseatStartMock).toHaveBeenLastCalledWith('char-a', 'w:12', 'Roblox', 'voice', ROBLOX);
    expect(useBackseatStore.getState().sharingFor).toBe('char-a');
  });

  it('a stale capture ending does not clear a newer share', async () => {
    const { useBackseatStore } = await loadStore();
    startCaptureMock.mockResolvedValueOnce({ stream: { id: 'one' }, noteSpoke: () => {} });
    startCaptureMock.mockResolvedValueOnce({ stream: { id: 'two' }, noteSpoke: () => {} });
    await useBackseatStore.getState().share('char-a', win('w:1', 'Notes'));
    await useBackseatStore.getState().share('char-a', win('w:2', 'Other'));
    (startCaptureMock.mock.calls[0][3] as { onEnded: () => void }).onEnded();
    expect(useBackseatStore.getState().stream).toEqual({ id: 'two' });
  });

  it('the share toggle stops the wait too, and nothing starts later', async () => {
    const { useBackseatStore, WATCH_POLL_MS } = await loadStore();
    useBackseatStore.getState().startWatch('char-a', ROBLOX);
    await settle(WATCH_POLL_MS);
    await useBackseatStore.getState().stopSharing();
    expect(useBackseatStore.getState().watch).toBeNull();

    const looks = sourcesMock.mock.calls.length;
    windows = [win('w:9', 'Roblox')];
    await settle(WATCH_POLL_MS * 5);
    expect(sourcesMock.mock.calls.length).toBe(looks);
    expect(backseatStartMock).not.toHaveBeenCalled();
  });

  it('a cold start arms the watch, which begins when the call goes live', async () => {
    const { useBackseatStore, WATCH_SETTLE_MS } = await loadStore();
    windows = [win('w:9', 'Roblox')];
    useBackseatStore.getState().armPendingShare('char-a', null, ROBLOX);
    expect(useBackseatStore.getState().watch).toBeNull();
    expect(sourcesMock).not.toHaveBeenCalled();

    await expect(useBackseatStore.getState().consumePendingShare('char-a')).resolves.toBe(true);
    expect(useBackseatStore.getState().pendingShare).toBeNull();
    expect(useBackseatStore.getState().watch?.game).toEqual(ROBLOX);
    await settle(WATCH_SETTLE_MS + 10);
    expect(backseatStartMock).toHaveBeenCalledWith('char-a', 'w:9', 'Roblox', 'voice', ROBLOX);
  });

  it('stops retrying after repeated failed starts and keeps the reason', async () => {
    const { useBackseatStore, WATCH_POLL_MS, WATCH_MAX_FAILURES } = await loadStore();
    backseatStartMock.mockRejectedValue(new Error('BACKSEAT_MC_SESSION_ACTIVE'));
    windows = [win('w:9', 'Roblox')];
    useBackseatStore.getState().startWatch('char-a', ROBLOX);
    await settle(WATCH_POLL_MS * 20);

    expect(backseatStartMock).toHaveBeenCalledTimes(WATCH_MAX_FAILURES);
    expect(useBackseatStore.getState().watch?.stalled).toBe(true);
    expect(useBackseatStore.getState().error).toMatch(/Minecraft/);

    // "Try again" is a fresh watch.
    backseatStartMock.mockResolvedValue(undefined);
    useBackseatStore.getState().startWatch('char-a', ROBLOX);
    expect(useBackseatStore.getState().error).toBeNull();
    await settle(WATCH_POLL_MS * 2);
    expect(useBackseatStore.getState().sharingFor).toBe('char-a');
  });

  it('a share that lands after the watch was stopped is undone', async () => {
    const { useBackseatStore, WATCH_SETTLE_MS } = await loadStore();
    let started!: (v: unknown) => void;
    startCaptureMock.mockImplementationOnce(() => new Promise((r) => (started = r)));
    windows = [win('w:9', 'Roblox')];
    useBackseatStore.getState().startWatch('char-a', ROBLOX);
    await settle(WATCH_SETTLE_MS + 10);
    expect(startCaptureMock).toHaveBeenCalledTimes(1);

    useBackseatStore.getState().stopWatch();
    started({ stream: { id: 'late' }, noteSpoke: () => {} });
    await settle(0);

    expect(useBackseatStore.getState().sharingFor).toBeNull();
    expect(backseatEndMock).toHaveBeenCalledWith('char-a');
  });

  it('an account switch forgets the watch', async () => {
    const { useBackseatStore, WATCH_POLL_MS } = await loadStore();
    useBackseatStore.getState().startWatch('char-a', ROBLOX);
    useBackseatStore.getState().resetForScope();
    expect(useBackseatStore.getState().watch).toBeNull();
    const looks = sourcesMock.mock.calls.length;
    await settle(WATCH_POLL_MS * 4);
    expect(sourcesMock.mock.calls.length).toBe(looks);
  });
});
