/**
 * Companion profile page tabs and header (product call 261116),
 * server-rendered.
 *
 *  - Every tab's body is mounted with the page and the inactive ones are
 *    hidden. A body used to mount on the click, so it painted its rows before
 *    their IPC reads landed (half a tab, then rows popping in above and the
 *    rest jumping down), and the old tab's label faded out over 140ms on top
 *    of the new content: the switch read as a flash of the previous tab.
 *  - The stats sit on one line under the name, and Chat + Play are two equal
 *    buttons under them (they used to sit beside the name and squeeze the
 *    stats into an orphan "Last launch" line).
 */
import { describe, expect, it } from 'vitest';
import React from 'react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

(globalThis as unknown as { window: unknown }).window = {
  sei: {},
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }),
  location: { search: '' },
};

const { CharacterPage } = await import('./CharacterPage');
const { useDataStore } = await import('../lib/stores/useDataStore');
const { useLibraryStateStore } = await import('../lib/stores/useLibraryStateStore');

const SUI = '3f6c2a1e-9b7d-4c1a-8e2f-5a6b7c8d9e01';
const sui = {
  id: SUI,
  kind: 'custom',
  public_id: 'K7Q2',
  name: 'Sui',
  persona: { source: 'A teasing gremlin.', expanded: '' },
  is_default: true,
  description: 'A teasing, sunny gremlin.',
  shared: false,
  slug: null,
  metadata: { voiceId: 'v-lily' },
  created: '2026-10-07T00:00:00Z',
  last_launched: '2026-11-16T00:00:00Z',
  playtime_ms: 14 * 3_600_000,
  skin: { source: 'none', mojang_username: null, png_sha256: null, applied_at: null },
  username: null,
  owner: null,
};

function renderPage(): string {
  // The page reads the color scheme off <html> while rendering; a server
  // render has no document, so give it the bare minimum.
  const g = globalThis as { document?: unknown };
  if (!g.document) g.document = { documentElement: { getAttribute: () => null } };
  // A server render reads each store's INITIAL state (zustand's server
  // snapshot), so the fixture goes there.
  Object.assign(useDataStore.getInitialState(), { characters: [sui] });
  Object.assign(useLibraryStateStore.getInitialState(), {
    addedDefaultIds: new Set([SUI]),
    addedWorldIds: new Set(),
    initialized: true,
  });
  return renderToStaticMarkup(React.createElement(CharacterPage, { id: SUI }));
}

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, 'CharacterPage.module.css'), 'utf8');

/** The body of the first rule whose selector list starts with `selector`. */
function rule(selector: string): string {
  const i = css.indexOf(`\n${selector}`);
  expect(i, selector).toBeGreaterThanOrEqual(0);
  return css.slice(css.indexOf('{', i) + 1, css.indexOf('}', i));
}

describe('profile tabs (261116)', () => {
  it('mounts every tab body with the page and hides all but the active one', () => {
    const html = renderPage();
    const panels = [...html.matchAll(/<div id="profile-tabpanel-(\w+)" data-tab-panel="\w+"( hidden="")?/g)].map(
      (m) => [m[1], m[2] ? 'hidden' : 'shown'],
    );
    expect(panels).toEqual([
      ['overview', 'shown'],
      ['settings', 'hidden'],
      ['more', 'hidden'],
    ]);
    // The hidden tabs already hold their rows, so a switch shows them whole.
    expect(html).toContain('data-tab-body="settings"');
    expect(html).toContain('data-tab-body="more"');
    // Each tab button points at its own panel.
    expect(html).toContain('aria-controls="profile-tabpanel-settings"');
  });

  it('the tab labels switch at once (no color fade that left the old tab looking selected)', () => {
    expect(rule('.tab,')).not.toMatch(/transition\s*:/);
    expect(rule('.tabActive {')).not.toMatch(/transition\s*:/);
  });
});

describe('profile header (261116)', () => {
  it('Chat and Play come after the stats line, as two equal buttons across the header', () => {
    const html = renderPage();
    const meta = html.indexOf('Last launch');
    const actions = html.indexOf('data-actions="true"');
    expect(meta).toBeGreaterThan(0);
    expect(actions).toBeGreaterThan(meta);
    expect(rule('.head {')).toMatch(/flex-direction:\s*column/);
    expect(rule('.deploy {')).toMatch(/grid-auto-columns:\s*minmax\(0, 1fr\)/);
    expect(rule('.deployBig {')).toMatch(/width:\s*100%/);
  });

  it('the stats never wrap item by item: one row, a two-column grid when narrow', () => {
    expect(rule('.meta {')).toMatch(/flex-wrap:\s*nowrap/);
    expect(css).toMatch(/@container \(max-width: 520px\)\s*\{\s*\.meta \{\s*display: grid;\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  });
});
