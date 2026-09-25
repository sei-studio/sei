/**
 * useFirstMomentStore (260926): the guided first moment's lifecycle.
 *
 * What is pinned:
 *   - nothing happens unless arm() ran for THAT companion (returning users and
 *     every later chat open get plain undefined options, so the greeting path
 *     is byte-for-byte the old one);
 *   - the plan is frozen at greeting time from the install probe + LAN state;
 *   - a failed or missing greeting is a silent fallback (no card) with one
 *     shape-only analytics event;
 *   - first_moment_shown fires once; first_moment_action only from 'ready',
 *     and only once;
 *   - enterFirstMoment routes the tour end to the companion's chat.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let trackMock: ReturnType<typeof vi.fn>;
let detectMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  trackMock = vi.fn();
  detectMock = vi.fn().mockResolvedValue({ installs: [] });
  (globalThis as unknown as { window: unknown }).window = {
    sei: {
      track: trackMock,
      detectMcInstalls: detectMock,
      onChatMessage: () => () => {},
    },
  };
});

async function load() {
  const fm = await import('./useFirstMomentStore');
  const { useDataStore } = await import('./useDataStore');
  const { useUiStore } = await import('./useUiStore');
  return { ...fm, useDataStore, useUiStore };
}

function eventsNamed(name: string): unknown[] {
  return trackMock.mock.calls.filter((c) => c[0] === name).map((c) => c[1]);
}

describe('greetingOptions: only the armed companion steers its greeting', () => {
  it('returns undefined when nothing was armed (returning users, every later open)', async () => {
    const { useFirstMomentStore } = await load();
    expect(await useFirstMomentStore.getState().greetingOptions('c1')).toBeUndefined();
    expect(useFirstMomentStore.getState().status).toBeNull();
  });

  it('returns undefined for a different companion than the armed one', async () => {
    const { useFirstMomentStore } = await load();
    useFirstMomentStore.getState().arm('c1');
    expect(await useFirstMomentStore.getState().greetingOptions('other')).toBeUndefined();
    expect(useFirstMomentStore.getState().status).toBe('armed');
  });

  it('chess leads with no Minecraft installed', async () => {
    const { useFirstMomentStore } = await load();
    useFirstMomentStore.getState().arm('c1');
    expect(await useFirstMomentStore.getState().greetingOptions('c1')).toEqual({ firstMoment: { primary: 'chess' } });
    expect(useFirstMomentStore.getState().plan).toEqual({ primary: 'chess', minecraft: false });
    expect(useFirstMomentStore.getState().status).toBe('greeting');
  });

  it('an installed Minecraft is offered, chess still leads', async () => {
    detectMock.mockResolvedValue({ installs: [{ id: 'vanilla' }] });
    const { useFirstMomentStore } = await load();
    useFirstMomentStore.getState().arm('c1');
    expect(await useFirstMomentStore.getState().greetingOptions('c1')).toEqual({ firstMoment: { primary: 'chess' } });
    expect(useFirstMomentStore.getState().plan).toEqual({ primary: 'chess', minecraft: true });
  });

  it('an open LAN world makes the greeting invite into Minecraft', async () => {
    const { useFirstMomentStore, useDataStore } = await load();
    useDataStore.setState({ lan: { kind: 'open', port: 25565, motd: 'w', lastSeenAt: 0 } });
    useFirstMomentStore.getState().arm('c1');
    expect(await useFirstMomentStore.getState().greetingOptions('c1')).toEqual({
      firstMoment: { primary: 'minecraft' },
    });
  });

  it("main's LAN state wins over a stale cached copy", async () => {
    const w = (globalThis as unknown as { window: { sei: Record<string, unknown> } }).window;
    w.sei.getLanState = vi.fn().mockResolvedValue({ kind: 'open', port: 25565, motd: 'w', lastSeenAt: 0 });
    const { useFirstMomentStore, useDataStore } = await load();
    useDataStore.setState({ lan: { kind: 'closed' } });
    useFirstMomentStore.getState().arm('c1');
    expect(await useFirstMomentStore.getState().greetingOptions('c1')).toEqual({
      firstMoment: { primary: 'minecraft' },
    });
  });

  it('a hung LAN read falls back to the cached copy', async () => {
    vi.useFakeTimers();
    try {
      const w = (globalThis as unknown as { window: { sei: Record<string, unknown> } }).window;
      w.sei.getLanState = vi.fn().mockReturnValue(new Promise(() => {}));
      const { useFirstMomentStore, useDataStore, MC_PROBE_WAIT_MS } = await load();
      useDataStore.setState({ lan: { kind: 'open', port: 25565, motd: 'w', lastSeenAt: 0 } });
      useFirstMomentStore.getState().arm('c1');
      const p = useFirstMomentStore.getState().greetingOptions('c1');
      await vi.advanceTimersByTimeAsync(MC_PROBE_WAIT_MS + 10);
      expect(await p).toEqual({ firstMoment: { primary: 'minecraft' } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a hung install probe does not hold the greeting past the wait', async () => {
    vi.useFakeTimers();
    try {
      detectMock.mockReturnValue(new Promise(() => {}));
      const { useFirstMomentStore, MC_PROBE_WAIT_MS } = await load();
      useFirstMomentStore.getState().arm('c1');
      const p = useFirstMomentStore.getState().greetingOptions('c1');
      await vi.advanceTimersByTimeAsync(MC_PROBE_WAIT_MS + 10);
      expect(await p).toEqual({ firstMoment: { primary: 'chess' } });
      expect(useFirstMomentStore.getState().plan?.minecraft).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a throwing probe counts as not installed', async () => {
    detectMock.mockRejectedValue(new Error('scan failed'));
    const { useFirstMomentStore } = await load();
    useFirstMomentStore.getState().arm('c1');
    expect(await useFirstMomentStore.getState().greetingOptions('c1')).toEqual({ firstMoment: { primary: 'chess' } });
  });

  it('is one-shot: a second open after the greeting gets undefined', async () => {
    const { useFirstMomentStore } = await load();
    useFirstMomentStore.getState().arm('c1');
    await useFirstMomentStore.getState().greetingOptions('c1');
    expect(await useFirstMomentStore.getState().greetingOptions('c1')).toBeUndefined();
  });
});

describe('greetingResult', () => {
  it('ok moves to ready with no analytics yet', async () => {
    const { useFirstMomentStore } = await load();
    useFirstMomentStore.getState().arm('c1');
    await useFirstMomentStore.getState().greetingOptions('c1');
    useFirstMomentStore.getState().greetingResult('c1', true);
    expect(useFirstMomentStore.getState().status).toBe('ready');
    expect(trackMock).not.toHaveBeenCalled();
  });

  it('a failure falls back silently and records why', async () => {
    const { useFirstMomentStore } = await load();
    useFirstMomentStore.getState().arm('c1');
    await useFirstMomentStore.getState().greetingOptions('c1');
    useFirstMomentStore.getState().greetingResult('c1', false, 'greeting_failed');
    expect(useFirstMomentStore.getState().status).toBe('failed');
    expect(eventsNamed('first_moment_fallback')).toEqual([{ reason: 'greeting_failed' }]);
  });

  it('ignores results for other companions and after it settled', async () => {
    const { useFirstMomentStore } = await load();
    useFirstMomentStore.getState().arm('c1');
    await useFirstMomentStore.getState().greetingOptions('c1');
    useFirstMomentStore.getState().greetingResult('other', false, 'history');
    expect(useFirstMomentStore.getState().status).toBe('greeting');
    useFirstMomentStore.getState().greetingResult('c1', true);
    // A later open with history must not knock a live card over.
    useFirstMomentStore.getState().greetingResult('c1', false, 'history');
    expect(useFirstMomentStore.getState().status).toBe('ready');
    expect(eventsNamed('first_moment_fallback')).toEqual([]);
  });

  it('an existing transcript on the armed companion settles it as failed', async () => {
    const { useFirstMomentStore } = await load();
    useFirstMomentStore.getState().arm('c1');
    useFirstMomentStore.getState().greetingResult('c1', false, 'history');
    expect(useFirstMomentStore.getState().status).toBe('failed');
    expect(eventsNamed('first_moment_fallback')).toEqual([{ reason: 'history' }]);
  });
});

describe('markShown + act: the two analytics events', () => {
  async function ready(id = 'c1') {
    const mods = await load();
    mods.useFirstMomentStore.getState().arm(id);
    await mods.useFirstMomentStore.getState().greetingOptions(id);
    mods.useFirstMomentStore.getState().greetingResult(id, true);
    return mods;
  }

  it('first_moment_shown fires once, shape only', async () => {
    const { useFirstMomentStore } = await ready('gen-1');
    useFirstMomentStore.getState().markShown();
    useFirstMomentStore.getState().markShown();
    expect(eventsNamed('first_moment_shown')).toEqual([
      { primary: 'chess', minecraft_offered: false, companion: 'generated' },
    ]);
  });

  it('names Sui as the companion kind when she is the partner', async () => {
    const { DEFAULT_CHARACTER_UUIDS } = await import('@shared/defaultCharacters');
    const { useFirstMomentStore } = await ready(DEFAULT_CHARACTER_UUIDS.sui);
    useFirstMomentStore.getState().markShown();
    expect(eventsNamed('first_moment_shown')).toEqual([
      { primary: 'chess', minecraft_offered: false, companion: 'sui' },
    ]);
  });

  it('never fires shown before the greeting landed', async () => {
    const { useFirstMomentStore } = await load();
    useFirstMomentStore.getState().arm('c1');
    useFirstMomentStore.getState().markShown();
    expect(eventsNamed('first_moment_shown')).toEqual([]);
  });

  it('first_moment_action records the click once and retires the card', async () => {
    const { useFirstMomentStore } = await ready();
    useFirstMomentStore.getState().markShown();
    useFirstMomentStore.getState().act('chess');
    useFirstMomentStore.getState().act('call');
    const actions = eventsNamed('first_moment_action') as Array<Record<string, unknown>>;
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ action: 'chess', primary: 'chess' });
    expect(typeof actions[0].ms_since_shown).toBe('number');
    expect(useFirstMomentStore.getState().status).toBe('done');
  });

  it('dismiss is an action too', async () => {
    const { useFirstMomentStore } = await ready();
    useFirstMomentStore.getState().markShown();
    useFirstMomentStore.getState().act('dismiss');
    expect(eventsNamed('first_moment_action')).toEqual([
      expect.objectContaining({ action: 'dismiss' }),
    ]);
  });

  it('act is ignored before ready', async () => {
    const { useFirstMomentStore } = await load();
    useFirstMomentStore.getState().arm('c1');
    useFirstMomentStore.getState().act('chess');
    expect(eventsNamed('first_moment_action')).toEqual([]);
    expect(useFirstMomentStore.getState().status).toBe('armed');
  });

  it('a throwing track() never breaks the flow', async () => {
    const { useFirstMomentStore } = await ready();
    trackMock.mockImplementation(() => {
      throw new Error('ipc down');
    });
    expect(() => useFirstMomentStore.getState().markShown()).not.toThrow();
    expect(() => useFirstMomentStore.getState().act('chess')).not.toThrow();
    expect(useFirstMomentStore.getState().status).toBe('done');
  });
});

describe('enterFirstMoment: the tour hands off to the companion chat', () => {
  const character = (id: string) => ({ id }) as unknown as import('@shared/characterSchema').Character;

  it('does nothing when nothing was armed (returning users, resumed tours)', async () => {
    const { enterFirstMoment, useUiStore } = await load();
    useUiStore.setState({ view: { kind: 'home' } });
    expect(enterFirstMoment()).toBe(false);
    expect(useUiStore.getState().view).toEqual({ kind: 'home' });
  });

  it('navigates to the armed companion chat', async () => {
    const { enterFirstMoment, useFirstMomentStore, useDataStore, useUiStore } = await load();
    useDataStore.setState({ characters: [character('c1')] });
    useUiStore.setState({ view: { kind: 'home' } });
    useFirstMomentStore.getState().arm('c1');
    expect(enterFirstMoment()).toBe(true);
    expect(useUiStore.getState().view).toEqual({ kind: 'chat', characterId: 'c1' });
  });

  it('still lands in the chat when the greeting already failed (the normal chat screen)', async () => {
    const { enterFirstMoment, useFirstMomentStore, useDataStore, useUiStore } = await load();
    useDataStore.setState({ characters: [character('c1')] });
    useFirstMomentStore.getState().arm('c1');
    useFirstMomentStore.getState().greetingResult('c1', false, 'greeting_failed');
    expect(enterFirstMoment()).toBe(true);
    expect(useUiStore.getState().view).toEqual({ kind: 'chat', characterId: 'c1' });
  });

  it('stays put and settles when the companion is not in the library', async () => {
    const { enterFirstMoment, useFirstMomentStore, useUiStore } = await load();
    useUiStore.setState({ view: { kind: 'home' } });
    useFirstMomentStore.getState().arm('ghost');
    expect(enterFirstMoment()).toBe(false);
    expect(useUiStore.getState().view).toEqual({ kind: 'home' });
    expect(useFirstMomentStore.getState().status).toBe('failed');
    expect(eventsNamed('first_moment_fallback')).toEqual([{ reason: 'no_companion' }]);
  });

  it('does nothing once the player already clicked', async () => {
    const { enterFirstMoment, useFirstMomentStore, useDataStore, useUiStore } = await load();
    useDataStore.setState({ characters: [character('c1')] });
    useFirstMomentStore.getState().arm('c1');
    await useFirstMomentStore.getState().greetingOptions('c1');
    useFirstMomentStore.getState().greetingResult('c1', true);
    useFirstMomentStore.getState().act('dismiss');
    useUiStore.setState({ view: { kind: 'home' } });
    expect(enterFirstMoment()).toBe(false);
    expect(useUiStore.getState().view).toEqual({ kind: 'home' });
  });
});
