/**
 * Tests for CharactersScreen — B4 (Home / World tabs) + Party redesign
 * (party wall home, awaken view, World scouting grid).
 *
 * Project convention (no @testing-library/react installed): exercise the
 * source contract via grep-style file presence checks plus module-import
 * smoke. Mirrors src/renderer/src/screens/ReceiptScreen.test.tsx.
 *
 * Invariants under test:
 *   1. Module exports a CharactersScreen function symbol.
 *   2. The capability gate is gone from the source.
 *   3. Navigation lives in the IconRail (no tab buttons here).
 *   4. Default tab is driven by useUiStore.homeTab.
 *   5. HomeGrid filters out foreign-owned characters.
 *   6. WorldGrid keeps the search field.
 *   7. CharacterCard renders no chip text.
 *   8-10. Legacy capability plumbing stays deleted.
 *   11-19. Party redesign: party wall panels, dormant Awaken slots, presence +
 *          lastline plumbing, AwakenScreen replaces AddCompanionChooserModal,
 *          World top bar slots indicator + direct Invite path.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TSX_PATH = resolve(__dirname, 'CharactersScreen.tsx');
const CSS_PATH = resolve(__dirname, 'CharactersScreen.module.css');
// 260706: the home-library membership rule moved to a shared module so
// IconRail can use the exact same predicate (it used to diverge signed-out).
const HOME_LIB_PATH = resolve(__dirname, '..', 'lib', 'homeLibrary.ts');
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
    // No role="tab" / tablist in the screen.
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
    // The membership rule itself lives in the shared homeLibrary module
    // (260706) so IconRail applies the identical predicate.
    expect(source.includes('isHomeCharacter')).toBe(true);
    const lib = readFileSync(HOME_LIB_PATH, 'utf-8');
    expect(lib.includes('is_default === true')).toBe(true);
    // Strict mismatch against currentUserId hides foreign-owned chars.
    expect(lib.includes('c.owner !== currentUserId')).toBe(true);
  });

  it('Test 6: WorldGrid keeps the search field', () => {
    const source = readFileSync(TSX_PATH, 'utf-8');
    // No more <h1>Browse</h1>.
    expect(source.includes('>Browse</h1>')).toBe(false);
    // Search field must remain.
    expect(source.includes('searchField')).toBe(true);
    expect(source.includes('Search companions')).toBe(true);
  });

  it('Test 7: CharacterCard is fully retired (party wall replaced the card grid)', () => {
    // The component was deleted outright in the Party redesign — the home
    // surface renders full-height panels, not cards, so no chip vocabulary
    // (MINE / WORLD / LOCAL ONLY / CLOUD) can ever return.
    expect(existsSync(CARD_PATH)).toBe(false);
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

  // ── Party redesign (UI-REDESIGN-PARTY.md §4.2–§4.4) ─────────────────────
  const HOME_CSS = resolve(REPO_ROOT, 'src', 'renderer', 'src', 'screens', 'HomeScreen.module.css');
  const CHOOSER = resolve(
    REPO_ROOT, 'src', 'renderer', 'src', 'components', 'AddCompanionChooserModal.tsx',
  );
  const AWAKEN = resolve(REPO_ROOT, 'src', 'renderer', 'src', 'screens', 'AwakenScreen.tsx');
  const APP = resolve(REPO_ROOT, 'src', 'renderer', 'src', 'App.tsx');
  const UI_STORE = resolve(
    REPO_ROOT, 'src', 'renderer', 'src', 'lib', 'stores', 'useUiStore.ts',
  );
  const BROWSE_CARD = resolve(
    REPO_ROOT, 'src', 'renderer', 'src', 'components', 'BrowseCard.tsx',
  );

  it('Test 11: World CSS exposes the top bar (search + sort + slots indicator)', () => {
    const css = readFileSync(CSS_PATH, 'utf-8');
    expect(css.includes('.worldTop')).toBe(true);
    expect(css.includes('.search')).toBe(true);
    expect(css.includes('.sortSelect')).toBe(true);
    expect(css.includes('.slots')).toBe(true);
    // The legacy mono/uppercase tab bar is gone.
    expect(css.includes('.tabBar')).toBe(false);
    expect(css.includes('text-transform: uppercase')).toBe(false);
  });

  it('Test 12: Home renders the party wall capped at MAX_COMPANION_SLOTS', () => {
    const source = readFileSync(TSX_PATH, 'utf-8');
    // Slots are driven by the shared MAX_COMPANION_SLOTS constant (not a magic 4).
    expect(source.includes('MAX_COMPANION_SLOTS')).toBe(true);
    expect(source.includes('slotCharacters')).toBe(true);
    // Uses the full-height flex panels, not the old card grid.
    expect(source.includes('homeStyles.panels')).toBe(true);
    expect(source.includes('homeStyles.panel')).toBe(true);
    const homeCss = readFileSync(HOME_CSS, 'utf-8');
    expect(homeCss.includes('.panels')).toBe(true);
    expect(homeCss.includes('.dormant')).toBe(true);
    // Hover expansion choreography from the mockup.
    expect(homeCss.includes('flex: 1.65')).toBe(true);
    expect(homeCss.includes('flex: 0.84')).toBe(true);
    // The greeting header + old slot grid are gone.
    expect(source.includes('Welcome back')).toBe(false);
    expect(homeCss.includes('.slotGrid')).toBe(false);
  });

  it('Test 13: empty slots are dormant Awaken panels (GatherPixels), AddCard retired from home', () => {
    const source = readFileSync(TSX_PATH, 'utf-8');
    expect(source.includes('GatherPixels')).toBe(true);
    expect(source.includes('Awaken')).toBe(true);
    expect(source.includes('AddCard')).toBe(false);
    expect(source.includes('Summon a companion')).toBe(false);
    expect(source.includes('New companion')).toBe(false);
    // Dormant slots route to the awaken view behind the creation-quota gate.
    expect(source.includes("navigate({ kind: 'awaken' })")).toBe(true);
    expect(source.includes('checkCreateQuota')).toBe(true);
    expect(source.includes('CreationLimitModal')).toBe(true);
  });

  it('Test 14: Home filter uses added_default_ids (defaults hidden unless invited)', () => {
    const lib = readFileSync(HOME_LIB_PATH, 'utf-8');
    expect(lib.includes('return addedDefaultIds.has(c.id);')).toBe(true);
    expect(lib.includes('removedDefaultIds')).toBe(false);
    const source = readFileSync(TSX_PATH, 'utf-8');
    expect(source.includes('removedDefaultIds')).toBe(false);
  });

  it('Test 15: panels carry presence + lastline plumbing (presenceOf / actionVerb / chat previews)', () => {
    const source = readFileSync(TSX_PATH, 'utf-8');
    expect(source.includes('presenceOf')).toBe(true);
    expect(source.includes('useMinuteTick')).toBe(true);
    expect(source.includes('actionVerb')).toBe(true);
    expect(source.includes('chatPreviewFor')).toBe(true);
    expect(source.includes('loadPreviews')).toBe(true);
    // New companions get the "Say hello" primary instead of Message.
    expect(source.includes("'Say hello'")).toBe(true);
    expect(source.includes("'Message'")).toBe(true);
    // Play opens the games picker without triggering the panel open.
    expect(source.includes("kind: 'games-picker'")).toBe(true);
    expect(source.includes('stopPropagation')).toBe(true);
  });

  it('Test 16: AddCompanionChooserModal is retired; AwakenScreen replaces it', () => {
    expect(existsSync(CHOOSER)).toBe(false);
    expect(existsSync(AWAKEN)).toBe(true);
    const source = readFileSync(TSX_PATH, 'utf-8');
    expect(source.includes('AddCompanionChooserModal')).toBe(false);
    // The awaken view is a routed surface: view kind + App route exist.
    const uiStore = readFileSync(UI_STORE, 'utf-8');
    expect(uiStore.includes("{ kind: 'awaken' }")).toBe(true);
    const app = readFileSync(APP, 'utf-8');
    expect(app.includes("view.kind === 'awaken' && <AwakenScreen />")).toBe(true);
  });

  it('Test 17: AwakenScreen keeps the unique-path gates (sign-in + cloud backend + prefs)', () => {
    const awaken = readFileSync(AWAKEN, 'utf-8');
    expect(awaken.includes("setUpgradeFraming('meet your unique companion')")).toBe(true);
    // Backend gate: local (BYOK) users are also routed to sign-in.
    expect(awaken.includes("!== 'cloud-proxy'")).toBe(true);
    // Questionnaire gate → profile-questions with the unique-gender next hop.
    expect(awaken.includes("next: 'unique-gender'")).toBe(true);
    expect(awaken.includes("navigate({ kind: 'unique-gender' })")).toBe(true);
    // The other two origins: custom wizard (quota-gated) + World tab.
    expect(awaken.includes('checkCreateQuota')).toBe(true);
    expect(awaken.includes("navigate({ kind: 'add-character' })")).toBe(true);
    expect(awaken.includes("setHomeTab('world')")).toBe(true);
  });

  it('Test 18: World top bar shows the party-slots indicator from the shared home filter', () => {
    const source = readFileSync(TSX_PATH, 'utf-8');
    expect(source.includes('isHomeCharacter')).toBe(true);
    expect(source.includes('Party full')).toBe(true);
    expect(source.includes('slotsOpen')).toBe(true);
  });

  it('Test 19: World invite moved to CharacterPage; the in-card hover CTA is gone', () => {
    // 260706: the hover Invite overlay was removed from World cards. Invite is
    // still reachable — the card body opens CharacterPage, whose "Add to
    // library" CTA runs the same charsAddToLibrary / charsRestoreDefault path
    // (with the identical sign-in gate). So the invite plumbing left WorldGrid.
    const source = readFileSync(TSX_PATH, 'utf-8');
    expect(source.includes('handleInvite')).toBe(false);
    expect(source.includes('inviteState')).toBe(false);
    const card = readFileSync(BROWSE_CARD, 'utf-8');
    // No invite action, state, or overlay left in the card.
    expect(card.includes('onInvite')).toBe(false);
    expect(card.includes('InviteState')).toBe(false);
    expect(card.includes('styles.over')).toBe(false);
    // The card body still opens the profile where "Add to library" lives.
    expect(card.includes('onOpen')).toBe(true);
    // CharacterPage carries the add-to-library CTA the invite now flows through.
    const characterPage = readFileSync(
      resolve(REPO_ROOT, 'src', 'renderer', 'src', 'screens', 'CharacterPage.tsx'),
      'utf-8',
    );
    expect(characterPage.includes('charsAddToLibrary')).toBe(true);
    expect(characterPage.includes('Invite to party')).toBe(true);
  });

  it('Test 20: World first two rows gate reveal on portrait load (group reveal)', () => {
    // The above-the-fold rows hold a wireframe until every portrait in them
    // loads (or errors / times out), then reveal together via BrowseCard's
    // `ready` override — no per-card pop-in.
    const source = readFileSync(TSX_PATH, 'utf-8');
    expect(source.includes('firstRowsReady')).toBe(true);
    expect(source.includes('FIRST_ROWS_REVEAL_TIMEOUT_MS')).toBe(true);
    expect(source.includes('new Image()')).toBe(true);
    // Two rows tracks the live column count.
    expect(source.includes('columns * SKELETON_ROWS')).toBe(true);
    const card = readFileSync(BROWSE_CARD, 'utf-8');
    expect(card.includes('readyOverride')).toBe(true);
  });
});
