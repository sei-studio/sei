import { describe, it, expect } from 'vitest';
import {
  bootOfferUiReady,
  checkBootImportOffer,
  hasImportableLeftovers,
  localImportOfferTiming,
  shouldOfferLocalImport,
  type BootOfferUi,
} from './localImportOffer';
import type { PeekLocalProfileResult } from '../../../shared/ipc';

function peek(p: Partial<PeekLocalProfileResult>): PeekLocalProfileResult {
  return {
    migratableCharacterIds: [],
    memoryOnlyCharacterIds: [],
    mcUsername: null,
    preferredName: null,
    hasData: false,
    hasCompanionData: false,
    untouchedSeedIds: [],
    ...p,
  };
}

describe('shouldOfferLocalImport', () => {
  it('offers local companions to an EXISTING account (bug 1)', () => {
    const p = peek({ migratableCharacterIds: ['a'], hasData: true, hasCompanionData: true });
    expect(shouldOfferLocalImport(p, true)).toBe(true);
  });

  it('offers memories alone to an existing account', () => {
    const p = peek({ memoryOnlyCharacterIds: ['a'], hasData: true, hasCompanionData: true });
    expect(shouldOfferLocalImport(p, true)).toBe(true);
  });

  it('does not prompt an existing account over onboarding answers alone', () => {
    const p = peek({ mcUsername: 'Steve', hasData: true });
    expect(shouldOfferLocalImport(p, true)).toBe(false);
    // A new account still takes them.
    expect(shouldOfferLocalImport(p, false)).toBe(true);
  });

  it('offers nothing when the local profile is empty or the peek failed', () => {
    expect(shouldOfferLocalImport(peek({}), false)).toBe(false);
    expect(shouldOfferLocalImport(null, true)).toBe(false);
  });
});

describe('localImportOfferTiming', () => {
  it('offers on sign-in, deferred while the first-run scene is up', () => {
    expect(localImportOfferTiming('sign-in', false)).toBe('now');
    expect(localImportOfferTiming('sign-in', true)).toBe('after-onboarding');
  });

  it('never offers on sign-out or account to account', () => {
    expect(localImportOfferTiming('sign-out', false)).toBe('none');
    expect(localImportOfferTiming('switch', false)).toBe('none');
    expect(localImportOfferTiming('switch', true)).toBe('none');
  });

  it('never offers when the session was restored at launch, not signed into (261029)', () => {
    expect(localImportOfferTiming('sign-in', false, true)).toBe('none');
    expect(localImportOfferTiming('sign-in', true, true)).toBe('none');
  });
});

const SUI = 'bbf5b66f-2f0f-4918-a953-a2cf66d5a586';
const calm: BootOfferUi = { signedIn: true, viewKind: 'home', modalOpen: false, tourActive: false, liveSession: false };

describe('hasImportableLeftovers', () => {
  it('counts companions and memories', () => {
    expect(hasImportableLeftovers(peek({ migratableCharacterIds: ['a'], hasCompanionData: true }))).toBe(true);
    expect(hasImportableLeftovers(peek({ memoryOnlyCharacterIds: ['a'], hasCompanionData: true }))).toBe(true);
  });

  it('the untouched seeded Sui alone is not a leftover', () => {
    const p = peek({ migratableCharacterIds: [SUI], hasCompanionData: true, untouchedSeedIds: [SUI] });
    expect(hasImportableLeftovers(p)).toBe(false);
  });

  it('Sui the player talked to, or anything beside her, is', () => {
    expect(hasImportableLeftovers(peek({ migratableCharacterIds: [SUI], hasCompanionData: true }))).toBe(true);
    expect(
      hasImportableLeftovers(peek({ migratableCharacterIds: [SUI, 'own'], hasCompanionData: true, untouchedSeedIds: [SUI] })),
    ).toBe(true);
  });

  it('nothing for an empty peek, onboarding answers alone, or no peek', () => {
    expect(hasImportableLeftovers(peek({}))).toBe(false);
    expect(hasImportableLeftovers(peek({ mcUsername: 'Steve', hasData: true }))).toBe(false);
    expect(hasImportableLeftovers(null)).toBe(false);
  });
});

describe('bootOfferUiReady', () => {
  it('only a calm, signed-in Home', () => {
    expect(bootOfferUiReady(calm)).toBe(true);
    expect(bootOfferUiReady({ ...calm, signedIn: false })).toBe(false);
    for (const viewKind of ['onboard', 'skin-setup', 'chat', 'draw', 'settings']) {
      expect(bootOfferUiReady({ ...calm, viewKind }), viewKind).toBe(false);
    }
    expect(bootOfferUiReady({ ...calm, modalOpen: true })).toBe(false);
    expect(bootOfferUiReady({ ...calm, tourActive: true })).toBe(false);
    expect(bootOfferUiReady({ ...calm, liveSession: true })).toBe(false);
  });
});

describe('checkBootImportOffer', () => {
  /** A fake of main's device-global offered store, keyed per account. */
  function harness(p: PeekLocalProfileResult, ui: () => BootOfferUi = () => calm) {
    const store = new Set<string>();
    let account = 'acct-1';
    let peeks = 0;
    return {
      store,
      setAccount: (a: string) => { account = a; },
      get peeks() { return peeks; },
      deps: {
        ui,
        peek: async () => { peeks++; return p; },
        offered: async () => store.has(account),
      },
      answer: () => store.add(account),
    };
  }
  const leftovers = peek({ migratableCharacterIds: ['own'], hasData: true, hasCompanionData: true });

  it('signed in with leftovers: shows once, and Not now stops it for that account', async () => {
    const h = harness(leftovers);
    const first = await checkBootImportOffer(h.deps);
    expect(first.kind).toBe('show');
    // The player answers "Not now": App records it through profileImportOffered('set').
    h.answer();
    expect((await checkBootImportOffer(h.deps)).kind).toBe('done');
    // Next launch (same store on disk): still done, and no peek is needed.
    const peeksBefore = h.peeks;
    expect((await checkBootImportOffer(h.deps)).kind).toBe('done');
    expect(h.peeks).toBe(peeksBefore);
    // A different account on the same device has not answered.
    h.setAccount('acct-2');
    expect((await checkBootImportOffer(h.deps)).kind).toBe('show');
  });

  it('an untouched seeded Sui alone never prompts', async () => {
    const h = harness(peek({ migratableCharacterIds: [SUI], hasData: true, hasCompanionData: true, untouchedSeedIds: [SUI] }));
    expect((await checkBootImportOffer(h.deps)).kind).toBe('done');
  });

  it('waits during onboarding, a modal, the tour or a live session, without reading anything', async () => {
    for (const ui of [
      { ...calm, viewKind: 'onboard' },
      { ...calm, viewKind: 'skin-setup' },
      { ...calm, modalOpen: true },
      { ...calm, tourActive: true },
      { ...calm, liveSession: true },
    ]) {
      const h = harness(leftovers, () => ui);
      expect((await checkBootImportOffer(h.deps)).kind).toBe('wait');
      expect(h.peeks).toBe(0);
    }
  });

  it('re-checks the UI after the reads', async () => {
    let n = 0;
    const h = harness(leftovers, () => (n++ === 0 ? calm : { ...calm, modalOpen: true }));
    expect((await checkBootImportOffer(h.deps)).kind).toBe('wait');
  });
});
