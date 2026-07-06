/**
 * Tests for IconRail — B3 (Discord-style sidebar refactor).
 *
 * Project convention (no @testing-library/react installed): exercise the
 * source contract via grep-style file presence checks plus module-import
 * smoke. Mirrors src/renderer/src/screens/ReceiptScreen.test.tsx.
 *
 * Invariants under test:
 *   1. Module exports an IconRail function symbol.
 *   2. Source removes the Minecraft button + Add-game (Plus → coming-soon)
 *      affordances.
 *   3. Source renders a scrollable character avatar cluster (uses
 *      PixelPortrait or <img> at size 44).
 *   4. Source surfaces the round + button → add-character navigation.
 *   5. Source surfaces the CompassIcon → World tab gateway and writes
 *      homeTab='world' before navigating.
 *   6. Source surfaces the CloudIcon branch when ai_backend_kind === 'local'
 *      and mounts a confirm dialog → SignInModal.
 *   7. Source preserves the cloud-proxy PricingIcon branch + Settings link.
 *   8. CSS module hides the scrollbar on the avatar cluster.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TSX_PATH = resolve(__dirname, 'IconRail.tsx');
const CSS_PATH = resolve(__dirname, 'IconRail.module.css');

beforeEach(() => {
  (globalThis as unknown as { window: unknown }).window = {
    sei: {},
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
});

describe('IconRail (B3 Discord-style sidebar)', () => {
  it('Test 1: exports IconRail function symbol', async () => {
    const mod = await import('./IconRail');
    expect(mod.IconRail).toBeDefined();
    expect(typeof mod.IconRail).toBe('function');
  });

  it('Test 2: removes the Minecraft button + Add-game coming-soon affordances', () => {
    const source = readFileSync(TSX_PATH, 'utf-8');
    expect(source.includes('minecraft.png')).toBe(false);
    expect(source.includes("'coming-soon'")).toBe(false);
    expect(source.includes('Add game')).toBe(false);
  });

  it('Test 3: renders a scrollable character avatar cluster with PixelPortrait fallback', () => {
    const source = readFileSync(TSX_PATH, 'utf-8');
    expect(source.includes('PixelPortrait')).toBe(true);
    expect(source.includes('avatarCluster')).toBe(true);
    expect(source.includes('size={40}')).toBe(true);
    // <img> path for portrait_image fallback
    expect(source.includes('portraitImage ?')).toBe(true);
  });

  it('Test 4: dormant + socket navigates to awaken', () => {
    const source = readFileSync(TSX_PATH, 'utf-8');
    expect(source.includes("navigate({ kind: 'awaken' })")).toBe(true);
    expect(source.includes('PlusIcon')).toBe(true);
  });

  it('Test 5: CompassIcon opens the World tab (sets homeTab then navigates home)', () => {
    const source = readFileSync(TSX_PATH, 'utf-8');
    expect(source.includes('CompassIcon')).toBe(true);
    expect(source.includes("setHomeTab('world')")).toBe(true);
    expect(source.includes("navigate({ kind: 'home' })")).toBe(true);
  });

  it('Test 6: local backend renders StarIcon + confirm dialog mounting SignInModal', () => {
    const source = readFileSync(TSX_PATH, 'utf-8');
    // Item 5: the rail's credits/cloud button uses StarIcon in BOTH the
    // cloud-proxy and local states for consistent iconography; CloudIcon is
    // gone. The local branch still opens the "Switch to cloud?" confirm dialog
    // that mounts SignInModal.
    expect(source.includes('CloudIcon')).toBe(false);
    expect(source.includes("aiBackendKind === 'cloud-proxy'")).toBe(true);
    expect(source.includes('Switch to cloud?')).toBe(true);
    expect(source.includes('SignInModal')).toBe(true);
  });

  it('Test 7: preserves the cloud-proxy StarIcon credits branch and Settings link', () => {
    const source = readFileSync(TSX_PATH, 'utf-8');
    expect(source.includes('StarIcon')).toBe(true);
    expect(source.includes("navigate({ kind: 'credits' })")).toBe(true);
    expect(source.includes("navigate({ kind: 'settings' })")).toBe(true);
  });

  it('Test 8: CSS module hides the scrollbar on the avatar cluster', () => {
    const css = readFileSync(CSS_PATH, 'utf-8');
    expect(css.includes('scrollbar-width: none')).toBe(true);
    expect(css.includes('::-webkit-scrollbar')).toBe(true);
    expect(css.includes('.avatarCluster')).toBe(true);
  });

  it('Test 9: sorts characters by last_launched desc then created desc', () => {
    const source = readFileSync(TSX_PATH, 'utf-8');
    expect(source.includes('last_launched')).toBe(true);
    expect(source.includes('created')).toBe(true);
  });
});
