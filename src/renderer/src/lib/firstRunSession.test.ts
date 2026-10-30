/**
 * First-run session (261029): the startup popup is held for the whole
 * session once onboarding, the tour or the first moment has been seen.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./ipcClient', () => ({
  sei: {
    getConfig: async () => ({}),
    saveConfig: async () => undefined,
  },
}));

const fr = await import('./firstRunSession');
const { useUiStore } = await import('./stores/useUiStore');
const { useTutorialStore } = await import('./stores/useTutorialStore');
const { useFirstMomentStore } = await import('./stores/useFirstMomentStore');

beforeEach(() => {
  useUiStore.setState({ view: { kind: 'home' } });
  useTutorialStore.setState({ active: false });
  useFirstMomentStore.setState({ status: null });
  fr._resetFirstRunSessionForTests();
});

describe('isFirstRunView', () => {
  it('counts the onboarding scene, not the sign-in screen or skin setup', () => {
    expect(fr.isFirstRunView({ kind: 'onboard' })).toBe(true);
    expect(fr.isFirstRunView({ kind: 'onboard', signin: true })).toBe(false);
    expect(fr.isFirstRunView({ kind: 'onboarding' } as never)).toBe(true);
    expect(fr.isFirstRunView({ kind: 'skin-setup' } as never)).toBe(false);
    expect(fr.isFirstRunView({ kind: 'home' })).toBe(false);
  });
});

describe('isFirstRunSession', () => {
  it('a normal session is not first-run', () => {
    useUiStore.setState({ view: { kind: 'settings' } });
    useUiStore.setState({ view: { kind: 'onboard', signin: true } });
    expect(fr.isFirstRunSession()).toBe(false);
  });

  it('latches once the onboarding scene shows, even after Home', () => {
    useUiStore.setState({ view: { kind: 'onboard' } });
    useUiStore.setState({ view: { kind: 'home' } });
    expect(fr.isFirstRunSession()).toBe(true);
  });

  it('latches on the tour, and stays after it ends', () => {
    useTutorialStore.setState({ active: true });
    useTutorialStore.setState({ active: false });
    expect(fr.isFirstRunSession()).toBe(true);
  });

  it('latches on the first moment', () => {
    useFirstMomentStore.setState({ status: 'armed' } as never);
    useFirstMomentStore.setState({ status: null });
    expect(fr.isFirstRunSession()).toBe(true);
  });

  it('markFirstRunSession latches it by hand (a saved tour about to resume)', () => {
    fr.markFirstRunSession();
    expect(fr.isFirstRunSession()).toBe(true);
  });
});
