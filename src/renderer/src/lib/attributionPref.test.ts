import { describe, it, expect } from 'vitest';
import {
  ATTRIBUTION_ASKED_KEY,
  ATTRIBUTION_DETAIL_OPTIONS,
  ATTRIBUTION_OPTIONS,
  attributionDetailEvent,
  attributionEvent,
  markAttributionAsked,
  shouldAskAttribution,
} from './attributionPref';
import {
  ATTRIBUTION_DETAILS,
  ATTRIBUTION_SOURCES,
  hasAttributionDetail,
  isAttributionDetail,
} from '@shared/attribution';
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
      expect(o.label).not.toContain('â€”');
      expect(ZH[o.label]).not.toContain('â€”');
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

describe('attributionPref: follow-up detail (261012)', () => {
  it('only AI and Google search get a follow-up', () => {
    expect(ATTRIBUTION_SOURCES.filter(hasAttributionDetail)).toEqual(['google_search', 'ai_assistant']);
    expect(hasAttributionDetail(null)).toBe(false);
    expect(hasAttributionDetail('toString')).toBe(false);
  });
  it('offers exactly the shared detail enum per source, in order', () => {
    expect(ATTRIBUTION_DETAIL_OPTIONS.ai_assistant.map((o) => o.value)).toEqual([
      ...ATTRIBUTION_DETAILS.ai_assistant,
    ]);
    expect(ATTRIBUTION_DETAIL_OPTIONS.google_search.map((o) => o.value)).toEqual([
      ...ATTRIBUTION_DETAILS.google_search,
    ]);
    expect(ATTRIBUTION_DETAIL_OPTIONS.ai_assistant.map((o) => o.label)).toEqual([
      'ChatGPT',
      'Google (AI Overview or Gemini)',
      'Copilot',
      'Perplexity',
      'Claude',
      'Other',
    ]);
    expect(ATTRIBUTION_DETAIL_OPTIONS.google_search.map((o) => o.label)).toEqual([
      'I searched for Sei by name',
      'I searched for something like AI gaming companion',
      'Not sure',
    ]);
  });
  it('detail values are unique across sources, so a flat breakdown is unambiguous', () => {
    const all = Object.values(ATTRIBUTION_DETAILS).flat();
    expect(new Set(all).size).toBe(all.length);
  });
  it('a detail is only valid for the source that offers it', () => {
    expect(isAttributionDetail('ai_assistant', 'claude')).toBe(true);
    expect(isAttributionDetail('google_search', 'searched_name')).toBe(true);
    expect(isAttributionDetail('google_search', 'claude')).toBe(false);
    expect(isAttributionDetail('reddit', 'other_ai')).toBe(false);
    expect(isAttributionDetail('ai_assistant', 'skipped')).toBe(false);
  });
  it('labels and lines have zh entries and no em dashes', () => {
    const labels = Object.values(ATTRIBUTION_DETAIL_OPTIONS).flat().map((o) => o.label);
    for (const k of [...labels, 'Ooh, another AI! Which one?', 'Nice! What did you search for?']) {
      expect(ZH[k], `missing zh entry for "${k}"`).toBeTypeOf('string');
      expect(k).not.toContain('â€”');
      expect(ZH[k]).not.toContain('â€”');
    }
  });
  it('an answer sends source + heard_from_detail; a skip sends "skipped"', () => {
    expect(attributionDetailEvent('ai_assistant', 'perplexity')).toEqual({
      event: 'onboarding_attribution_detail',
      props: { source: 'ai_assistant', heard_from_detail: 'perplexity' },
    });
    expect(attributionDetailEvent('google_search', null)).toEqual({
      event: 'onboarding_attribution_detail',
      props: { source: 'google_search', heard_from_detail: 'skipped' },
    });
  });
});




