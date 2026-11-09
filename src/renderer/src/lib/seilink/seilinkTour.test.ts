/**
 * The SeiLink first-link intro's play-once memory and the guide's SeiLink
 * tour (261105, T337).
 *
 * Invariants under test:
 *   1. The intro plays on the first move-in that works, once per ACCOUNT;
 *      a failed start leaves it unseen; Replay always plays.
 *   2. The tour is offered only where SeiLink runs, never in the session that
 *      ran onboarding, never to someone already linked, a day after a new
 *      player's onboarding, and at most twice: Not now snoozes it once for a
 *      few days, the second Not now retires it. Sure or a drop retires it.
 *   3. The tour's analytics carry the closed shape (offered / sure / not_now
 *      with snoozed / completed / dropped with step).
 *   4. startSeilinkHost plays the intro alongside the start (it never waits
 *      for it) and only while unseen; its outcome is false on a failed start.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '@shared/ipc';

let authState: AuthState = { kind: 'local' };
vi.mock('../stores/useAuthStore', () => ({
  useAuthStore: { getState: () => ({ state: authState }) },
}));

const track = vi.fn();
const hostStart = vi.fn();
const roomGet = vi.fn();
const stage = vi.fn(async (_r: unknown) => ({ ok: true }));
const getConfig = vi.fn(async () => ({}));
const saveConfig = vi.fn(async (_c: unknown) => undefined);
vi.mock('../ipcClient', () => ({
  sei: {
    track: (...a: unknown[]) => track(...a),
    seilinkHostStart: (...a: unknown[]) => hostStart(...a),
    seilinkRoomGet: (...a: unknown[]) => roomGet(...a),
    seilinkStage: (r: unknown) => stage(r),
    seilinkOffer: async () => undefined,
    getConfig: () => getConfig(),
    saveConfig: (c: unknown) => saveConfig(c),
    onSeilinkStatus: () => () => undefined,
    seilinkAvailability: async () => null,
    seilinkHostStatus: async () => null,
  },
}));

const introPref = await import('./introPref');
const liveHintPref = await import('./liveHintPref');
const tourPref = await import('./tourPref');
const tour = await import('./seilinkTour');
const flow = await import('./seilinkFlow');
const { useTutorialStore } = await import('../stores/useTutorialStore');
const { useSeilinkStore } = await import('../stores/useSeilinkStore');

function fakeStorage(opts?: { throws?: boolean }): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => {
      if (opts?.throws) throw new Error('denied');
      return map.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (opts?.throws) throw new Error('denied');
      map.set(k, v);
    },
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
}

function install(storage: Storage): void {
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
}

const signedIn = (id: string): AuthState => ({
  kind: 'signed_in',
  user: { id, email: 'a@b.com', emailVerified: true, createdAt: '2026-01-01T00:00:00Z' },
});

beforeEach(() => {
  install(fakeStorage());
  authState = { kind: 'local' };
  track.mockClear();
  hostStart.mockReset();
  roomGet.mockReset();
  stage.mockClear();
  tourPref.__resetTourSessionForTest();
  useTutorialStore.setState({ active: false, mode: 'onboarding', seilink: null, characterId: null, step: 'meet' });
  useSeilinkStore.setState({ intro: null, flow: null, moveBusy: false, liveHint: null });
});

afterEach(() => {
  Reflect.deleteProperty(globalThis as unknown as Record<string, unknown>, 'localStorage');
});

// ── 1. play once ────────────────────────────────────────────────────────────

describe('first-link intro, play once', () => {
  it('plays until seen, then never on the same account', () => {
    expect(introPref.introSeen()).toBe(false);
    expect(introPref.shouldPlayFirstLink({ seen: introPref.introSeen() })).toBe(true);
    introPref.markIntroSeen();
    expect(introPref.introSeen()).toBe(true);
    expect(introPref.shouldPlayFirstLink({ seen: introPref.introSeen() })).toBe(false);
  });

  it('is per account', () => {
    authState = signedIn('acct-a');
    introPref.markIntroSeen();
    authState = signedIn('acct-b');
    expect(introPref.introSeen()).toBe(false);
    authState = { kind: 'local' };
    expect(introPref.introSeen()).toBe(false);
  });

  it('a failed start does not count', () => {
    expect(introPref.shouldPlayFirstLink({ seen: false, failedStart: true })).toBe(false);
  });

  it('a storage that throws reads as unseen and does not crash', () => {
    install(fakeStorage({ throws: true }));
    expect(introPref.introSeen()).toBe(false);
    expect(() => introPref.markIntroSeen()).not.toThrow();
  });

});

describe('startSeilinkHost and the intro', () => {
  it('plays the intro alongside the start, without waiting for it', async () => {
    let resolve!: (s: unknown) => void;
    hostStart.mockReturnValue(new Promise((r) => (resolve = r)));
    const start = flow.startSeilinkHost('c1', { firstRoom: true, entry: 'button' });
    expect(hostStart).toHaveBeenCalledTimes(1);
    const intro = useSeilinkStore.getState().intro;
    expect(intro).toMatchObject({ characterId: 'c1', trigger: 'first_link', entry: 'button' });
    resolve({ state: 'running', characterId: 'c1' });
    await start;
    await expect(intro!.outcome).resolves.toBe(true);
  });

  it('a failed start resolves the outcome false (the intro aborts)', async () => {
    hostStart.mockResolvedValue({ state: 'failed', characterId: 'c1', failure: 'spawn' });
    await flow.startSeilinkHost('c1', { entry: 'gear' });
    await expect(useSeilinkStore.getState().intro!.outcome).resolves.toBe(false);
  });

  it('a rejected start resolves the outcome false', async () => {
    hostStart.mockRejectedValue(new Error('ipc'));
    await flow.startSeilinkHost('c1', { entry: 'gear' }).catch(() => undefined);
    await expect(useSeilinkStore.getState().intro!.outcome).resolves.toBe(false);
  });

  it('does not play once seen', async () => {
    introPref.markIntroSeen();
    hostStart.mockResolvedValue({ state: 'running', characterId: 'c1' });
    await flow.startSeilinkHost('c1', { entry: 'button' });
    expect(useSeilinkStore.getState().intro).toBeNull();
  });

  it('Replay always plays, as a new request, with nothing starting', () => {
    introPref.markIntroSeen();
    flow.replayIntro('c1', 'gear');
    const a = useSeilinkStore.getState().intro!;
    flow.replayIntro('c1', 'gear');
    const b = useSeilinkStore.getState().intro!;
    expect(a.trigger).toBe('replay');
    expect(b.seq).toBeGreaterThan(a.seq);
    expect(hostStart).not.toHaveBeenCalled();
    expect(track).toHaveBeenCalledWith('seilink_entry', { character_id: 'c1', source: 'gear', action: 'replay_intro' });
  });
});

// ── 1b. the "lives on your desktop" card (261110) ──────────────────────────

describe('the live card after a move-in without the intro', () => {
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  it('is remembered per account once dismissed', () => {
    expect(liveHintPref.liveHintDismissed()).toBe(false);
    authState = signedIn('acct-a');
    liveHintPref.markLiveHintDismissed();
    expect(liveHintPref.liveHintDismissed()).toBe(true);
    authState = signedIn('acct-b');
    expect(liveHintPref.liveHintDismissed()).toBe(false);
    install(fakeStorage({ throws: true }));
    expect(liveHintPref.liveHintDismissed()).toBe(false);
    expect(() => liveHintPref.markLiveHintDismissed()).not.toThrow();
  });

  it('names the OS the shortcut is written for', () => {
    expect(liveHintPref.liveHintOs('win32')).toBe('windows');
    expect(liveHintPref.liveHintOs('darwin')).toBe('mac');
    expect(liveHintPref.liveHintOs(undefined)).toBe('linux');
  });

  it('a fresh move-in shows the card first and does not step aside yet', async () => {
    introPref.markIntroSeen();
    hostStart.mockResolvedValue({ state: 'running', characterId: 'c1' });
    await flow.startSeilinkHost('c1', { entry: 'button', fresh: true });
    await settle();
    expect(useSeilinkStore.getState().liveHint).toEqual({ characterId: 'c1', fresh: true });
    expect(stage).not.toHaveBeenCalled();
  });

  it('a move-in back into a saved room shows it too, until dismissed', async () => {
    introPref.markIntroSeen();
    hostStart.mockResolvedValue({ state: 'running', characterId: 'c1' });
    await flow.startSeilinkHost('c1', { entry: 'gear' });
    await settle();
    expect(useSeilinkStore.getState().liveHint).toEqual({ characterId: 'c1', fresh: false });
  });

  it('once dismissed, a fresh move-in steps aside as before and a saved room does nothing', async () => {
    introPref.markIntroSeen();
    liveHintPref.markLiveHintDismissed();
    hostStart.mockResolvedValue({ state: 'running', characterId: 'c1' });
    await flow.startSeilinkHost('c1', { entry: 'button', fresh: true });
    await settle();
    expect(useSeilinkStore.getState().liveHint).toBeNull();
    expect(stage).toHaveBeenCalledWith({ action: 'reveal', purpose: 'move_in', characterId: 'c1' });
    stage.mockClear();
    await flow.startSeilinkHost('c1', { entry: 'gear' });
    await settle();
    expect(stage).not.toHaveBeenCalled();
    expect(useSeilinkStore.getState().liveHint).toBeNull();
  });

  it('not after a failed start, and not while the first-link intro plays (it shows its own)', async () => {
    introPref.markIntroSeen();
    hostStart.mockResolvedValue({ state: 'failed', characterId: 'c1', failure: 'spawn' });
    await flow.startSeilinkHost('c1', { entry: 'button', fresh: true });
    await settle();
    expect(useSeilinkStore.getState().liveHint).toBeNull();
    install(fakeStorage());
    hostStart.mockResolvedValue({ state: 'running', characterId: 'c1' });
    await flow.startSeilinkHost('c1', { entry: 'button', fresh: true });
    await settle();
    expect(useSeilinkStore.getState().intro).not.toBeNull();
    expect(useSeilinkStore.getState().liveHint).toBeNull();
  });
});

// ── 2. when the tour is offered ─────────────────────────────────────────────

const NOW = Date.UTC(2026, 10, 5, 12);
const H = 3_600_000;
const ok = { record: tourPref.EMPTY_TOUR_RECORD, now: NOW, available: true, onboardedThisSession: false, alreadyLinked: false, hasCompanion: true };

describe('tourDecision', () => {
  it('offers an existing user the "remember me" tour', () => {
    expect(tourPref.tourDecision(ok)).toEqual({ kind: 'show', audience: 'existing', offer: 1 });
  });

  it('never where SeiLink cannot run, and never without a companion', () => {
    expect(tourPref.tourDecision({ ...ok, available: false }).kind).toBe('skip');
    expect(tourPref.tourDecision({ ...ok, hasCompanion: false }).kind).toBe('skip');
  });

  it('never in the session that ran onboarding', () => {
    expect(tourPref.tourDecision({ ...ok, onboardedThisSession: true }).kind).toBe('skip');
    tourPref.noteOnboardingThisSession({ newPlayer: true }, NOW);
    expect(tourPref.onboardingRanThisSession()).toBe(true);
  });

  it('a new player waits a day after onboarding, then gets the new-player copy', () => {
    const record = tourPref.afterOnboarded(tourPref.EMPTY_TOUR_RECORD, NOW);
    expect(tourPref.tourDecision({ ...ok, record, now: NOW + 2 * H }).kind).toBe('skip');
    expect(tourPref.tourDecision({ ...ok, record, now: NOW + 25 * H })).toEqual({ kind: 'show', audience: 'new', offer: 1 });
  });

  it('onboarding is stamped once, and not on someone already offered', () => {
    const r1 = tourPref.afterOnboarded(tourPref.EMPTY_TOUR_RECORD, NOW);
    expect(tourPref.afterOnboarded(r1, NOW + H)).toBe(r1);
    const offered = tourPref.afterOffered(tourPref.EMPTY_TOUR_RECORD);
    expect(tourPref.afterOnboarded(offered, NOW).onboardedAt).toBeUndefined();
  });

  it('retires for someone already linked', () => {
    expect(tourPref.tourDecision({ ...ok, alreadyLinked: true }).kind).toBe('retire');
  });

  it('Not now snoozes once for a few days, then the second Not now retires it', () => {
    let record = tourPref.afterOffered(tourPref.EMPTY_TOUR_RECORD);
    const first = tourPref.afterNotNow(record, NOW);
    expect(first.snoozed).toBe(true);
    record = first.record;
    expect(tourPref.tourDecision({ ...ok, record, now: NOW + 2 * 24 * H }).kind).toBe('skip');
    expect(tourPref.tourDecision({ ...ok, record, now: NOW + tourPref.TOUR_SNOOZE_MS + 1 })).toEqual({ kind: 'show', audience: 'existing', offer: 2 });
    record = tourPref.afterOffered(record);
    const second = tourPref.afterNotNow(record, NOW + tourPref.TOUR_SNOOZE_MS + 1);
    expect(second.snoozed).toBe(false);
    expect(second.record.done).toBe(true);
    expect(tourPref.tourDecision({ ...ok, record: second.record, now: NOW + 30 * 24 * H }).kind).toBe('retire');
  });

  it('never more than two offers, even if a Not now was lost', () => {
    const record = { offers: tourPref.TOUR_MAX_OFFERS };
    expect(tourPref.tourDecision({ ...ok, record }).kind).toBe('retire');
  });

  it('the record is per account', () => {
    authState = signedIn('acct-a');
    tourPref.updateTourRecord(tourPref.retired);
    expect(tourPref.readTourRecord().done).toBe(true);
    authState = signedIn('acct-b');
    expect(tourPref.readTourRecord()).toEqual(tourPref.EMPTY_TOUR_RECORD);
  });

  it('picks the companion talked to last, else Sui, else the first', () => {
    expect(tourPref.pickTourCompanion([{ id: 'a', lastAt: '2026-11-01T00:00:00Z' }, { id: 'b', lastAt: '2026-11-04T00:00:00Z' }, { id: 'sui' }], 'sui')).toBe('b');
    expect(tourPref.pickTourCompanion([{ id: 'a' }, { id: 'sui' }], 'sui')).toBe('sui');
    expect(tourPref.pickTourCompanion([{ id: 'a' }], 'sui')).toBe('a');
    expect(tourPref.pickTourCompanion([], 'sui')).toBeNull();
  });
});

// ── 3. the tour's answers ───────────────────────────────────────────────────

describe('tour answers', () => {
  it('offered: counts the offer, starts the unpersisted seilink mode', () => {
    tour.beginSeilinkTour('c1', 'existing');
    expect(tourPref.readTourRecord().offers).toBe(1);
    expect(useTutorialStore.getState()).toMatchObject({ active: true, mode: 'seilink', step: 'sl_offer', characterId: 'c1' });
    expect(track).toHaveBeenCalledWith('seilink_tour', { action: 'offered', audience: 'existing', offer_n: 1 });
    useTutorialStore.getState().setStep('sl_button');
    useTutorialStore.getState().end();
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it('not_now snoozes the first time and says so', () => {
    tour.beginSeilinkTour('c1', 'existing');
    tour.seilinkTourNotNow(NOW);
    expect(track).toHaveBeenLastCalledWith('seilink_tour', { action: 'not_now', audience: 'existing', offer_n: 1, snoozed: true });
    expect(tourPref.readTourRecord().snoozedUntil).toBe(NOW + tourPref.TOUR_SNOOZE_MS);
    expect(useTutorialStore.getState().active).toBe(false);
  });

  it('sure retires it; completed opens SeiLink from the tour', async () => {
    roomGet.mockResolvedValue({ characterId: 'c1', saved: false, state: {}, pack: null });
    tour.beginSeilinkTour('c1', 'new');
    tour.seilinkTourSure();
    expect(tourPref.readTourRecord().done).toBe(true);
    expect(track).toHaveBeenLastCalledWith('seilink_tour', { action: 'sure', audience: 'new', offer_n: 1 });
    tour.seilinkTourCompleted();
    expect(track).toHaveBeenCalledWith('seilink_tour', { action: 'completed', audience: 'new', offer_n: 1 });
    await vi.waitFor(() => expect(useSeilinkStore.getState().flow).toMatchObject({ kind: 'sheet', characterId: 'c1', entry: 'tour' }));
    expect(track).toHaveBeenCalledWith('seilink_entry', { character_id: 'c1', source: 'tour', action: 'sheet' });
  });

  it('dropped carries the step and retires it', () => {
    tour.beginSeilinkTour('c1', 'existing');
    tour.seilinkTourDropped('button');
    expect(track).toHaveBeenLastCalledWith('seilink_tour', { action: 'dropped', audience: 'existing', offer_n: 1, step: 'button' });
    expect(tourPref.readTourRecord().done).toBe(true);
  });

  it('the onboarding tour still persists its step', () => {
    useTutorialStore.getState().start('c1');
    expect(useTutorialStore.getState().mode).toBe('onboarding');
    expect(getConfig).toHaveBeenCalled();
  });
});
