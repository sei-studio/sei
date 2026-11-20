/**
 * The Home "up next" card's rules and events (261013, T119).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HomeNextStep } from '@shared/homeNextStep';

const track = vi.fn();
const requestGameLaunch = vi.fn((_id: string, _game: unknown, launch: () => void) => launch());
const openGame = vi.fn();
const startOrOpenCall = vi.fn();
const openModal = vi.fn();
const navigate = vi.fn();

vi.mock('./ipcClient', () => ({ sei: { track: (...a: unknown[]) => track(...a) } }));
vi.mock('./gameLaunch', () => ({
  isBotGame: (id: unknown) => id === 'minecraft' || id === 'stardew' || id === 'dontstarve',
  botGameName: (g: string) => ({ minecraft: 'Minecraft', stardew: 'Stardew Valley', dontstarve: "Don't Starve Together" })[g] ?? g,
  requestGameLaunch: (...a: Parameters<typeof requestGameLaunch>) => requestGameLaunch(...a),
  openGame: (...a: unknown[]) => openGame(...a),
}));
vi.mock('./callLaunch', () => ({ startOrOpenCall: (...a: unknown[]) => startOrOpenCall(...a) }));
vi.mock('./stores/useUiStore', () => ({ useUiStore: { getState: () => ({ openModal, navigate }) } }));

const {
  chooseHomeNextStep,
  launchHomeNextStep,
  nextStepButtonLabel,
  nextStepEventProps,
  nextStepKey,
  nextStepTarget,
  resetNextStepShown,
  trackNextStepShown,
} = await import('./homeNextStep');
const { ZH } = await import('./i18n/zh');

const NOW = Date.parse('2026-10-13T12:00:00.000Z');
const HOUR = 3_600_000;

function step(over: Partial<HomeNextStep> = {}): HomeNextStep {
  return { characterId: 'c1', source: 'plan', text: 'Build a boat', at: NOW - 5 * HOUR, surface: 'game', game: 'minecraft', ...over };
}

const fakeT = (en: string, p?: Record<string, string | number>) =>
  en.replace(/\{(\w+)\}/g, (_, k: string) => String(p?.[k] ?? `{${k}}`));

beforeEach(() => {
  track.mockReset();
  requestGameLaunch.mockClear();
  openGame.mockReset();
  startOrOpenCall.mockReset();
  openModal.mockReset();
  navigate.mockReset();
  resetNextStepShown();
});

describe('chooseHomeNextStep', () => {
  it('no steps is no card', () => {
    expect(chooseHomeNextStep(['a', 'b'], {})).toBeNull();
  });

  it('first plan in Home order wins over an earlier goal', () => {
    const steps = {
      a: step({ characterId: 'a', source: 'goal' }),
      b: step({ characterId: 'b', source: 'plan' }),
      c: step({ characterId: 'c', source: 'plan' }),
    };
    expect(chooseHomeNextStep(['a', 'b', 'c'], steps)?.characterId).toBe('b');
  });

  it('falls back to the first goal when nobody has a plan', () => {
    const steps = { a: step({ characterId: 'a', source: 'goal' }), b: step({ characterId: 'b', source: 'goal' }) };
    expect(chooseHomeNextStep(['b', 'a'], steps)?.characterId).toBe('b');
  });

  it('skips busy companions, dismissed cards and ids not on Home', () => {
    const steps = { a: step({ characterId: 'a' }), b: step({ characterId: 'b', source: 'goal' }), z: step({ characterId: 'z' }) };
    expect(chooseHomeNextStep(['a', 'b'], steps, (id) => id === 'a')?.characterId).toBe('b');
    expect(chooseHomeNextStep(['a', 'b'], steps, undefined, new Set([nextStepKey(steps.a)]))?.characterId).toBe('b');
    expect(chooseHomeNextStep(['a'], steps, (id) => id === 'a')).toBeNull();
  });
});

describe('nextStepTarget + label', () => {
  it('maps surfaces to a launch target', () => {
    expect(nextStepTarget(step())).toEqual({ kind: 'game', game: 'minecraft' });
    expect(nextStepTarget(step({ game: 'stardew' }))).toEqual({ kind: 'game', game: 'stardew' });
    expect(nextStepTarget(step({ surface: 'call', game: null }))).toEqual({ kind: 'call' });
    expect(nextStepTarget(step({ surface: 'backseat', game: 'roblox' }))).toEqual({ kind: 'backseat', gameId: 'roblox' });
    expect(nextStepTarget(step({ surface: 'backseat', game: null }))).toEqual({ kind: 'call' });
    expect(nextStepTarget(step({ surface: 'chat', game: null }))).toEqual({ kind: 'chat' });
    expect(nextStepTarget(step({ surface: null, game: null }))).toEqual({ kind: 'picker' });
    expect(nextStepTarget(step({ surface: 'game', game: 'chess' }))).toEqual({ kind: 'picker' });
  });

  it('labels', () => {
    expect(nextStepButtonLabel({ kind: 'game', game: 'minecraft' }, 'Sui', fakeT)).toBe('Play Minecraft');
    expect(nextStepButtonLabel({ kind: 'call' }, 'Sui', fakeT)).toBe('Call Sui');
    expect(nextStepButtonLabel({ kind: 'chat' }, 'Sui', fakeT)).toBe('Message Sui');
    expect(nextStepButtonLabel({ kind: 'picker' }, 'Sui', fakeT)).toBe('Play');
    expect(nextStepButtonLabel({ kind: 'backseat', gameId: 'roblox' }, 'Sui', fakeT)).toMatch(/^Play Roblox/);
  });

  it('every new string has zh and no em dash', () => {
    for (const s of ['Up next with {name}', 'Call {name}', 'Play {game}', 'Play', 'Dismiss']) {
      expect(ZH[s], s).toBeTruthy();
      expect(s).not.toContain('—');
      expect(ZH[s]).not.toContain('—');
    }
  });
});

describe('events', () => {
  it('props are shape only, age in hours to one decimal', () => {
    expect(nextStepEventProps(step({ at: NOW - 90 * 60_000 }), NOW)).toEqual({
      character_id: 'c1',
      source: 'plan',
      age_hours: 1.5,
      surface: 'game',
      game: 'minecraft',
    });
    const untagged = nextStepEventProps(step({ surface: null, game: null, source: 'goal' }), NOW);
    expect(untagged).toEqual({ character_id: 'c1', source: 'goal', age_hours: 5, surface: 'unknown' });
    expect(JSON.stringify(untagged)).not.toContain('Build a boat');
  });

  it('home_next_step_shown fires once per card per session', () => {
    const s = step();
    expect(trackNextStepShown(s, NOW)).toBe(true);
    expect(trackNextStepShown(s, NOW)).toBe(false);
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith('home_next_step_shown', nextStepEventProps(s, NOW));
    // A new plan is a new card.
    trackNextStepShown(step({ at: NOW - HOUR }), NOW);
    expect(track).toHaveBeenCalledTimes(2);
    // An account switch forgets what was counted.
    resetNextStepShown();
    trackNextStepShown(s, NOW);
    expect(track).toHaveBeenCalledTimes(3);
  });

  it('a throwing bridge never breaks the card', () => {
    track.mockImplementation(() => {
      throw new Error('no bridge');
    });
    expect(() => trackNextStepShown(step(), NOW)).not.toThrow();
    expect(() => launchHomeNextStep(step(), NOW)).not.toThrow();
    expect(openGame).toHaveBeenCalled();
  });
});

describe('launchHomeNextStep', () => {
  it('a game plan: tracks the click, then the cross-launch gate opens the game', () => {
    const s = step({ game: 'stardew' });
    launchHomeNextStep(s, NOW);
    expect(track).toHaveBeenCalledWith('home_next_step_clicked', nextStepEventProps(s, NOW));
    expect(requestGameLaunch).toHaveBeenCalledWith('c1', { id: 'stardew', name: 'Stardew Valley' }, expect.any(Function));
    expect(openGame).toHaveBeenCalledWith('c1', 'stardew');
    expect(track.mock.invocationCallOrder[0]).toBeLessThan(requestGameLaunch.mock.invocationCallOrder[0]);
  });

  it('a call plan starts or opens the call', () => {
    launchHomeNextStep(step({ surface: 'call', game: null }), NOW);
    expect(startOrOpenCall).toHaveBeenCalledWith('c1');
    expect(track).toHaveBeenCalledWith('home_next_step_clicked', expect.objectContaining({ surface: 'call' }));
  });

  it('a backseat game plan goes through the gate to its game modal', () => {
    launchHomeNextStep(step({ surface: 'backseat', game: 'roblox' }), NOW);
    expect(requestGameLaunch).toHaveBeenCalledWith('c1', expect.objectContaining({ id: 'backseat' }), expect.any(Function));
    expect(openModal).toHaveBeenCalledWith({ kind: 'backseat-game', characterId: 'c1', gameId: 'roblox' });
  });

  it('a text-chat plan opens the chat', () => {
    launchHomeNextStep(step({ surface: 'chat', game: null }), NOW);
    expect(navigate).toHaveBeenCalledWith({ kind: 'chat', characterId: 'c1' });
    expect(track).toHaveBeenCalledWith('home_next_step_clicked', expect.objectContaining({ surface: 'chat' }));
  });

  it('an untagged plan opens the games picker', () => {
    launchHomeNextStep(step({ surface: null, game: null }), NOW);
    expect(openModal).toHaveBeenCalledWith({ kind: 'games-picker', characterId: 'c1' });
    expect(track).toHaveBeenCalledWith('home_next_step_clicked', expect.objectContaining({ surface: 'unknown' }));
  });
});
