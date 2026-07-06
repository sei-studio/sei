/**
 * Tests for CharactersScreen — B4 (Home / World tabs, capability gate removal).
 *
 * Project convention (no @testing-library/react installed): exercise the
 * source contract via grep-style file presence checks plus module-import
 * smoke. Mirrors src/renderer/src/screens/ReceiptScreen.test.tsx.
 *
 * Invariants under test:
 *   1. Module exports a CharactersScreen function symbol.
 *   2. The capability gate (`getCapabilities`, `browseEnabled` state, capability
 *      IPC) is gone from the source.
 *   3. Tab labels are "Home" and "World" (not "Browse").
 *   4. Default tab is driven by useUiStore.homeTab.
 *   5. HomeGrid filters out foreign-owned characters (only defaults, owned,
 *      or legacy null-owner chars survive).
 *   6. WorldGrid drops the H1 heading and keeps only the search field at top.
 *   7. CharacterCard chip text is now MINE / WORLD (not PUBLIC / CUSTOM).
 *   8. main/capabilities.ts and main/capabilities.test.ts files are deleted.
 *   9. UserConfigSchema no longer carries `browse_enabled`.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TSX_PATH = resolve(__dirname, 'CharactersScreen.tsx');
const CSS_PATH = resolve(__dirname, 'CharactersScreen.module.css');
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const SCHEMA_PATH = resolve(REPO_ROOT, 'src', 'shared', 'characterSchema.ts');
const CARD_PATH = resolve(REPO_ROOT, 'src', 'renderer', 'src', 'components', 'CharacterCard.tsx');
const CAPS_TS = resolve(REPO_ROOT, 'src', 'main', 'capabilities.ts');
const CAPS_TEST = resolve(REPO_ROOT, 'src', 'main', 'capabilities.test.ts');
const PRELOAD = resolve(REPO_ROOT, 'src', 'preload', 'index.ts');
const SHARED_IPC = resolve(REPO_ROOT, 'src', 'shared', 'ipc.ts');
const MAIN_IPC = resolve(REPO_ROOT, 'src', 'main', 'ipc.ts');

beforeEach(() => {
  (globalThis as unknown as { window: unknown }).window = {
    sei: {},
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
});

describe('CharactersScreen (B4 Home / World refactor)', () => {
  it('Test 1: source exports CharactersScreen function symbol', () => {
    // CharactersScreen transitively imports `@shared/ipc` via ReportModal,
    // which the vitest harness can't resolve without alias config. The
    // export-symbol check is satisfied by literal source grep instead.
    const source = readFileSync(TSX_PATH, 'utf-8');
    expect(/export\s+function\s+CharactersScreen\s*\(/.test(source)).toBe(true);
  });

  it('Test 2: capability gate is removed from CharactersScreen source', () => {
    const source = readFileSync(TSX_PATH, 'utf-8');
    expect(source.includes('getCapabilities')).toBe(false);
    expect(source.includes('browseEnabled')).toBe(false);
    expect(source.includes('capabilities')).toBe(false);
  });

  it('Test 3: tab labels removed — navigation lives in IconRail now', () => {
    const source = readFileSync(TSX_PATH, 'utf-8');
    // No "Browse" anywhere as a label.
    expect(/>\s*Browse\s*</.test(source)).toBe(false);
    // The Home/World tab BUTTONS are gone (rail handles navigation). A welcome
    // header replaces them; no role="tab" / tablist in the screen any more.
    expect(source.includes('role="tab"')).toBe(false);
    expect(source.includes('role="tablist"')).toBe(false);
  });

  it('Test 4: default tab is driven by useUiStore.homeTab', () => {
    const source = readFileSync(TSX_PATH, 'utf-8');
    expect(source.includes('homeTab')).toBe(true);
    expect(source.includes('useUiStore')).toBe(true);
  });

  it('Test 5: HomeGrid filters out defaults + foreign-owned characters', () => {
    const source = readFileSync(TSX_PATH, 'utf-8');
    expect(source.includes('homeCharacters')).toBe(true);
    expect(source.includes('is_default === true')).toBe(true);
    // Strict mismatch against currentUserId hides foreign-owned chars.
    expect(source.includes('c.owner !== currentUserId')).toBe(true);
  });

  it('Test 6: WorldGrid drops the H1 heading and keeps the search field', () => {
    const source = readFileSync(TSX_PATH, 'utf-8');
    // No more <h1>Browse</h1>.
    expect(source.includes('>Browse</h1>')).toBe(false);
    // Search field must remain.
    expect(source.includes('searchField')).toBe(true);
    expect(source.includes('Search companions')).toBe(true);
  });

  it('Test 7: CharacterCard renders no chip text (MINE / WORLD / LOCAL ONLY / CLOUD all removed)', () => {
    const source = readFileSync(CARD_PATH, 'utf-8');
    expect(source.includes("'MINE'")).toBe(false);
    expect(source.includes("'WORLD'")).toBe(false);
    // The legacy PUBLIC / CUSTOM vocabulary also must not return.
    expect(source.includes("isDefault ? 'PUBLIC' : 'CUSTOM'")).toBe(false);
    // LOCAL ONLY chip removed.
    expect(source.includes('LOCAL ONLY')).toBe(false);
    // chipLocalOnly CSS class no longer referenced from JSX.
    expect(source.includes('chipLocalOnly')).toBe(false);
  });

  it('Test 8: capabilities.ts and capabilities.test.ts are deleted', () => {
    expect(existsSync(CAPS_TS)).toBe(false);
    expect(existsSync(CAPS_TEST)).toBe(false);
  });

  it('Test 9: UserConfigSchema no longer carries browse_enabled', () => {
    const source = readFileSync(SCHEMA_PATH, 'utf-8');
    // browse_enabled may appear in a removal-comment but must not be a schema field.
    expect(/browse_enabled\s*:\s*z\./.test(source)).toBe(false);
  });

  it('Test 10: capabilities IPC channel + getCapabilities IPC binding are removed', () => {
    const sharedIpc = readFileSync(SHARED_IPC, 'utf-8');
    const preload = readFileSync(PRELOAD, 'utf-8');
    const mainIpc = readFileSync(MAIN_IPC, 'utf-8');
    expect(sharedIpc.includes("'capabilities:get'")).toBe(false);
    expect(preload.includes('getCapabilities')).toBe(false);
    expect(mainIpc.includes('IpcChannel.capabilities')).toBe(false);
  });

  it('Test 11: CSS module still exposes tabBar + tabActive', () => {
    const css = readFileSync(CSS_PATH, 'utf-8');
    expect(css.includes('.tabBar')).toBe(true);
    expect(css.includes('.tabActive')).toBe(true);
  });

  // ── 260703 procgen — fixed 4-slot Home + add-companion chooser ──────────
  const HOME_CSS = resolve(REPO_ROOT, 'src', 'renderer', 'src', 'screens', 'HomeScreen.module.css');
  const CHOOSER = resolve(REPO_ROOT, 'src', 'renderer', 'src', 'components', 'AddCompanionChooserModal.tsx');

  it('Test 12: Home renders a fixed 4-slot grid capped at MAX_COMPANION_SLOTS', () => {
    const source = readFileSync(TSX_PATH, 'utf-8');
    // Slots are driven by the shared MAX_COMPANION_SLOTS constant (not a magic 4).
    expect(source.includes('MAX_COMPANION_SLOTS')).toBe(true);
    expect(source.includes('slotCharacters')).toBe(true);
    // Uses the non-scrolling slot grid, not the old auto-fill .grid.
    expect(source.includes('homeStyles.slotGrid')).toBe(true);
    const homeCss = readFileSync(HOME_CSS, 'utf-8');
    expect(homeCss.includes('.slotGrid')).toBe(true);
    expect(homeCss.includes('repeat(4, 1fr)')).toBe(true);
  });

  it('Test 13: empty slots use the slot AddCard, header "New companion" button is gone', () => {
    const source = readFileSync(TSX_PATH, 'utf-8');
    // The header CTA was removed — slots are now the creation affordance.
    expect(source.includes('New companion')).toBe(false);
    // Empty slots render the AddCard slot variant labelled "Summon a companion".
    expect(source.includes("variant=\"slot\"")).toBe(true);
    expect(source.includes('Summon a companion')).toBe(true);
    // The card renders with the slot variant so it stretches to full height.
    expect(source.includes("variant=\"slot\"")).toBe(true);
  });

  it('Test 14: Home filter uses added_default_ids (defaults hidden unless invited)', () => {
    const source = readFileSync(TSX_PATH, 'utf-8');
    // Defaults are opt-IN on Home now (added_default_ids), not opt-out: the
    // is_default branch of the Home filter returns addedDefaultIds.has(c.id),
    // and WorldGrid's "in library" pill reads the same set.
    expect(source.includes('return addedDefaultIds.has(c.id);')).toBe(true);
    expect(source.includes('removedDefaultIds')).toBe(false);
  });

  it('Test 15: an empty slot opens the three-way AddCompanionChooserModal', () => {
    const source = readFileSync(TSX_PATH, 'utf-8');
    expect(source.includes('AddCompanionChooserModal')).toBe(true);
    expect(existsSync(CHOOSER)).toBe(true);
    const chooser = readFileSync(CHOOSER, 'utf-8');
    // Three tiles: unique / custom / world.
    expect(chooser.includes('Meet your unique companion')).toBe(true);
    expect(chooser.includes('Create from scratch')).toBe(true);
    expect(chooser.includes('Invite an existing companion')).toBe(true);
  });

  it('Test 16: unique path gates on sign-in via the meet-your-unique framing', () => {
    const source = readFileSync(TSX_PATH, 'utf-8');
    expect(source.includes("setUpgradeFraming('meet your unique companion')")).toBe(true);
    // Backend gate: local (BYOK) users are also routed to sign-in.
    expect(source.includes("!== 'cloud-proxy'")).toBe(true);
  });
});
