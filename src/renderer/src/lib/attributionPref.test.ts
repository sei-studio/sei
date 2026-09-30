import { describe, it, expect } from 'vitest';
import {
  ATTRIBUTION_ASKED_KEY,
  ATTRIBUTION_OPTIONS,
  attributionEvent,
  markAttributionAsked,
  shouldAskAttribution,
} from './attributionPref';
import { ATTRIBUTION_SOURCES } from '@shared/attribution';
import { ZH } from './i18n/zh';

function memStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    get length() {
      return m.size;
    },
  };
}

describe('attributionPref: asked once per machine', () => {
  it('asks on a fresh machine and not after it was shown', () => {
    const s = memStorage();
    expect(shouldAskAttribution(s)).toBe(true);
    markAttributionAsked(s);
    expect(s.getItem(ATTRIBUTION_ASKED_KEY)).toBe('1');
    expect(shouldAskAttribution(s)).toBe(false);
  });
  it('broken storage never throws; an unreadable flag asks', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(shouldAskAttribution(broken)).toBe(true);
    expect(() => markAttributionAsked(broken)).not.toThrow();
    expect(shouldAskAttribution(null)).toBe(true);
    expect(() => markAttributionAsked(null)).not.toThrow();
  });
});

describe('attributionPref: options and payload', () => {
  it('offers exactly the shared enum, in order', () => {
    expect(ATTRIBUTION_OPTIONS.map((o) => o.value)).toEqual([...ATTRIBUTION_SOURCES]);
  });
  it('labels have zh entries and no em dashes', () => {
    for (const o of ATTRIBUTION_OPTIONS) {
      expect(ZH[o.label], `missing zh entry for "${o.label}"`).toBeTypeOf('string');
      expect(o.label).not.toContain('—');
      expect(ZH[o.label]).not.toContain('—');
    }
    const q = 'Quick one before we start. Where did you hear about Sei?';
    expect(ZH[q]).toBeTypeOf('string');
    expect(ZH.Skip).toBeTypeOf('string');
  });
  it('an answer sends its source; a skip sends "skipped"', () => {
    expect(attributionEvent('reddit')).toEqual({
      event: 'onboarding_attribution',
      props: { source: 'reddit' },
    });
    expect(attributionEvent(null)).toEqual({
      event: 'onboarding_attribution',
      props: { source: 'skipped' },
    });
  });
});
