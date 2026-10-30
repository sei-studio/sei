/**
 * 261027: SkinEditor's same-in-game-name warning uses the accent-folded name,
 * so "Sofía" (now joins as Sofia) is flagged against a character named Sofia,
 * and no longer against one named Sofa.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Character } from '@shared/characterSchema';

(globalThis as unknown as { window: unknown }).window = {
  sei: {},
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
};

vi.mock('./SkinPreview3d', () => ({ SkinPreview3d: () => null }));
// Static render reads a zustand store's INITIAL state, so the data store is a
// plain selector over this test's library.
const store = vi.hoisted(() => ({ state: { characters: [] as unknown[], summons: {} } }));
vi.mock('../lib/stores/useDataStore', () => ({
  useDataStore: (sel: (s: unknown) => unknown) => sel(store.state),
}));

const { SkinEditor } = await import('./SkinEditor');

function mkChar(id: string, name: string, username: string | null = null): Character {
  return {
    id,
    kind: 'custom',
    public_id: null,
    name,
    persona: { source: 'x', expanded: 'x' },
    is_default: false,
    shared: false,
    slug: null,
    metadata: {},
    created: '2026-01-01T00:00:00.000Z',
    last_launched: null,
    playtime_ms: 0,
    portrait_image: null,
    username,
    owner: null,
    skin: { source: 'none', mojang_username: null, png_sha256: null, applied_at: null },
  } as Character;
}

const SOFIA_ACCENT = mkChar('11111111-1111-1111-1111-111111111111', 'Sofía');

function render(others: Character[]): string {
  store.state = { characters: [SOFIA_ACCENT, ...others], summons: {} };
  return renderToStaticMarkup(
    React.createElement(SkinEditor, { character: SOFIA_ACCENT, onChanged: () => undefined }),
  );
}

describe('SkinEditor in-game name collision (accent fold)', () => {
  it('warns when another character also folds to Sofia', () => {
    const html = render([mkChar('22222222-2222-2222-2222-222222222222', 'Sofia')]);
    expect(html).toContain('also joins as &quot;Sofia&quot;');
  });

  it('no longer collides with a character named Sofa (the old deleted-accent name)', () => {
    const html = render([mkChar('33333333-3333-3333-3333-333333333333', 'Sofa')]);
    expect(html).not.toContain('also joins as');
  });
});
