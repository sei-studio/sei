/**
 * GamePackCard (260908). Rendered with react-dom/server against a seeded
 * store (no @testing-library in this repo). Invariants:
 *   1. ready -> renders nothing.
 *   2. missing -> the offer names the game and the size hint in MB, with a
 *      Download button.
 *   3. downloading -> a progressbar at the right percent and "x of y MB".
 *   4. error -> the ERROR_COPY line and a Retry button.
 *   5. Every user-facing string the card emits has a zh entry, and none
 *      carries an em dash.
 *   6. ERROR_COPY.GAME_PACK_DOWNLOAD_FAILED names the descriptor's size hint,
 *      so the copy and GAME_PACKS.minecraft.sizeHintBytes cannot drift apart.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { GamePackState } from '@shared/gamePacks';
import { GAME_PACKS, packSizeMb } from '@shared/gamePacks';

const __dirname = dirname(fileURLToPath(import.meta.url));

beforeEach(() => {
  vi.resetModules();
  (globalThis as unknown as { window: unknown }).window = {
    sei: {
      gamePackState: vi.fn(async () => ({ kind: 'missing' })),
      gamePackEnsure: vi.fn(async () => ({ kind: 'ready', root: '/r' })),
      onGamePackProgress: vi.fn(() => () => undefined),
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
});

/**
 * zustand's hook reads getInitialState() under renderToStaticMarkup (the
 * useSyncExternalStore server snapshot), so a setState on the real store is
 * invisible to a server render. Mock the hook to select from a seeded state.
 */
async function render(state: GamePackState): Promise<string> {
  const store = { packs: { minecraft: state }, refresh: vi.fn(), ensure: vi.fn(), init: vi.fn() };
  vi.doMock('../../lib/stores/useGamePackStore', () => ({
    useGamePackStore: (selector: (s: typeof store) => unknown) => selector(store),
  }));
  const { GamePackCard } = await import('./GamePackCard');
  return renderToStaticMarkup(React.createElement(GamePackCard, { game: 'minecraft' }));
}

describe('GamePackCard', () => {
  it('Test 1: ready renders nothing', async () => {
    expect(await render({ kind: 'ready', root: '/r' })).toBe('');
  });

  it('Test 2: missing offers the download with the size hint', async () => {
    const html = await render({ kind: 'missing' });
    expect(html).toContain('data-state="missing"');
    expect(html).toContain('Download Minecraft support (about 50 MB)');
    expect(html).toContain('Download (50 MB)');
    expect(html).toContain('<button');
  });

  it('Test 3: downloading shows a progressbar and the MB counter', async () => {
    const html = await render({ kind: 'downloading', received: 12 * 1024 * 1024, total: 48 * 1024 * 1024 });
    expect(html).toContain('data-state="downloading"');
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="25"');
    expect(html).toContain('12 of 48 MB');
    expect(html).not.toContain('<button');
  });

  it('Test 4: error shows the copy and a Retry', async () => {
    const html = await render({ kind: 'error', error: 'GAME_PACK_DOWNLOAD_FAILED', message: 'x' });
    expect(html).toContain('data-state="error"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('about 50 MB');
    expect(html).toContain('Retry');
  });

  it('Test 5: every t() key in the card has a zh entry and no em dash', async () => {
    const src = readFileSync(resolve(__dirname, 'GamePackCard.tsx'), 'utf8');
    const keys = [...src.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].replace(/\\'/g, "'"));
    const dq = [...src.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
    const all = [...keys, ...dq];
    expect(all.length).toBeGreaterThanOrEqual(6);
    const { ZH } = await import('../../lib/i18n/zh');
    for (const k of all) {
      expect(k, `em dash in "${k}"`).not.toContain('—');
      expect(ZH[k], `missing zh entry for "${k}"`).toBeTypeOf('string');
      expect(ZH[k]).not.toContain('—');
    }
  });

  it('Test 6: ERROR_COPY names the descriptor size hint', async () => {
    const { ERROR_COPY } = await import('../../lib/errors');
    const mb = packSizeMb(GAME_PACKS.minecraft.sizeHintBytes);
    expect(ERROR_COPY.GAME_PACK_DOWNLOAD_FAILED).toContain(`${mb} MB`);
    expect(ERROR_COPY.GAME_PACK_DOWNLOAD_FAILED).not.toContain('—');
  });
});
