/**
 * 261023: the Settings row for the own-key import shows only while the local
 * profile has something worth bringing, and its copy has zh translations.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PeekLocalProfileResult } from '@shared/ipc';

(globalThis as unknown as { window: unknown }).window = {
  sei: {},
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
};

const { LocalImportRowView } = await import('./LocalImportRow');
const { ZH } = await import('../../lib/i18n/zh');

const SUI = 'bbf5b66f-2f0f-4918-a953-a2cf66d5a586';

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

const render = (p: PeekLocalProfileResult | null): string =>
  renderToStaticMarkup(React.createElement(LocalImportRowView, { peek: p, onOpen: () => undefined }));

describe('LocalImportRowView', () => {
  it('shows with local companions', () => {
    const html = render(peek({ migratableCharacterIds: ['own'], hasData: true, hasCompanionData: true }));
    expect(html).toContain('Companions from before you signed in');
    expect(html).toContain('Bring over');
  });

  it('shows with memories alone', () => {
    expect(render(peek({ memoryOnlyCharacterIds: ['own'], hasData: true, hasCompanionData: true }))).toContain(
      'Companions from before you signed in',
    );
  });

  it('hidden with nothing local, before the peek, or with only the untouched Sui', () => {
    expect(render(peek({}))).toBe('');
    expect(render(null)).toBe('');
    expect(
      render(peek({ migratableCharacterIds: [SUI], hasData: true, hasCompanionData: true, untouchedSeedIds: [SUI] })),
    ).toBe('');
  });

  it('has zh translations', () => {
    expect(ZH['Companions from before you signed in']).toBeTruthy();
    expect(ZH['Bring over']).toBeTruthy();
  });
});
