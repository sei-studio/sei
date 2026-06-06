/**
 * Tests for SettingsScreen — ui-A1 (cloud/local mode gating + 13-provider
 * picker) and ui-A7 (developer console toggle).
 *
 * Project convention (no @testing-library/react installed): exercise the
 * source contract via grep-style file presence checks. Mirrors
 * src/renderer/src/screens/CharactersScreen.test.tsx.
 *
 * Invariants under test:
 *   A1.1  — SettingsScreen reads ai_backend_kind from useCreditsStore.
 *   A1.2  — Provider + API-key rows render under a local-only gate.
 *   A1.3  — MINECRAFT SKINS SETUP renders in BOTH cloud and local mode
 *           (skin setup is needed regardless of AI backend).
 *   A1.4  — ProviderTiles is imported + used inline (compact picker).
 *   A1.5  — ProviderTiles ships all 13 Phase 14 providers w/ NO "Coming
 *           soon" chips.
 *   A1.6  — UserConfigSchema.provider enum now includes all 13 backends
 *           and an optional provider_config field.
 *   A1.7  — ACCOUNT MODE section sits below LEGAL with both directional
 *           buttons present (switch to managed billing / switch to your
 *           own API key), each opening the SwitchBackendConfirmModal.
 *   A1.8  — The legacy 2x2 ProviderTiles enum types (Provider type) is
 *           the new 13-member union.
 *   A1.9  — OnboardingScreen routes the dynamic provider label into the
 *           step-3 title (no hardcoded 'Local' fallback).
 *   A7.1  — useUiStore exposes devConsoleVisible: false default +
 *           setDevConsoleVisible action.
 *   A7.2  — App.tsx gates <LogsBar /> on devConsoleVisible.
 *   A7.3  — UserConfigSchema carries `dev_console_visible?: boolean`.
 *   A7.4  — SettingsScreen surfaces the "Show developer console" row +
 *           helper sentence in APPEARANCE.
 */

import { describe, it, expect, beforeEach } from 'vitest';
// @ts-expect-error node module under renderer tsconfig
import { readFileSync } from 'node:fs';
// @ts-expect-error node module under renderer tsconfig
import { fileURLToPath } from 'node:url';
// @ts-expect-error node module under renderer tsconfig
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SETTINGS_TSX = resolve(__dirname, 'SettingsScreen.tsx');
const ONBOARDING_TSX = resolve(__dirname, 'OnboardingScreen.tsx');
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const SCHEMA_TS = resolve(REPO_ROOT, 'src', 'shared', 'characterSchema.ts');
const PROVIDER_TILES_TSX = resolve(REPO_ROOT, 'src', 'renderer', 'src', 'components', 'ProviderTiles.tsx');
const USE_UI_STORE_TS = resolve(REPO_ROOT, 'src', 'renderer', 'src', 'lib', 'stores', 'useUiStore.ts');
const APP_TSX = resolve(REPO_ROOT, 'src', 'renderer', 'src', 'App.tsx');

beforeEach(() => {
  (globalThis as unknown as { window: unknown }).window = {
    sei: {},
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
});

describe('SettingsScreen (ui-A1 mode gating)', () => {
  it('A1.1: reads ai_backend_kind from useCreditsStore', () => {
    const src = readFileSync(SETTINGS_TSX, 'utf-8');
    expect(src.includes('useCreditsStore((s) => s.ai_backend_kind)')).toBe(true);
  });

  it('A1.2: provider + api-key rows gated on aiBackendKind === local', () => {
    const src = readFileSync(SETTINGS_TSX, 'utf-8');
    expect(src.includes("aiBackendKind === 'local'")).toBe(true);
    // The whole provider+api-key block lives inside one local gate.
    const providerIdx = src.indexOf('ProviderTiles');
    expect(providerIdx).toBeGreaterThan(0);
  });

  it('A1.3: MINECRAFT SKINS SETUP section is shown in BOTH cloud and local mode', () => {
    const src = readFileSync(SETTINGS_TSX, 'utf-8');
    // Skin sideloading is independent of the AI-backend billing path, so the
    // section must render regardless of mode (cloud-proxy users need to be
    // able to run / re-run it too). Anchor on the JSX section title.
    const skinsIdx = src.indexOf('>MINECRAFT SKINS SETUP<');
    expect(skinsIdx).toBeGreaterThan(0);
    // The section must NOT be wrapped in a local-only gate. The 200 chars
    // before the JSX title should not open a `aiBackendKind === 'local'`
    // conditional.
    const preamble = src.slice(Math.max(0, skinsIdx - 200), skinsIdx);
    expect(preamble.includes("aiBackendKind === 'local'")).toBe(false);
  });

  it('A1.4: ProviderTiles is imported + rendered in compact mode', () => {
    const src = readFileSync(SETTINGS_TSX, 'utf-8');
    expect(src.includes("from '../components/ProviderTiles'")).toBe(true);
    expect(src.includes('<ProviderTiles')).toBe(true);
    expect(src.includes('compact')).toBe(true);
  });

  it('A1.5: ProviderTiles ships all 13 providers and NO Coming soon chip', () => {
    const src = readFileSync(PROVIDER_TILES_TSX, 'utf-8');
    const wanted = [
      'anthropic',
      'openai',
      'gemini',
      'ollama',
      'grok',
      'openrouter',
      'deepseek',
      'mistral',
      'together',
      'groq',
      'fireworks',
      'cerebras',
      'perplexity',
    ];
    for (const id of wanted) expect(src.includes(`'${id}'`)).toBe(true);
    // The doc comment may legitimately mention "Coming soon" in describing
    // the migration away from chip-disabled tiles; the regression we care
    // about is the actual JSX <span className={styles.chip}>Coming soon</span>.
    expect(src.includes('styles.chip')).toBe(false);
    expect(src.includes('>Coming soon<')).toBe(false);
  });

  it('A1.6: UserConfigSchema provider enum extends to all 13 backends + has provider_config', () => {
    const src = readFileSync(SCHEMA_TS, 'utf-8');
    for (const id of ['anthropic', 'openai', 'gemini', 'ollama', 'grok', 'openrouter', 'deepseek', 'mistral', 'together', 'groq', 'fireworks', 'cerebras', 'perplexity']) {
      expect(src.includes(`'${id}'`)).toBe(true);
    }
    expect(src.includes('provider_config')).toBe(true);
  });

  it('A1.7: ACCOUNT MODE section sits below LEGAL with both switch buttons', () => {
    const src = readFileSync(SETTINGS_TSX, 'utf-8');
    // The LEGAL <div> sectionTitle marker is unique to the rendered JSX.
    const legalIdx = src.indexOf('>LEGAL<');
    expect(legalIdx).toBeGreaterThan(0);
    // The ACCOUNT MODE sectionTitle div renders later in the JSX. The
    // top-of-file imports/docs comment mentioning the same string sits
    // ABOVE the render — use lastIndexOf to land on the JSX site.
    const accountModeIdx = src.lastIndexOf('>ACCOUNT MODE<');
    expect(accountModeIdx).toBeGreaterThan(legalIdx);
    expect(src.includes('Switch to managed billing')).toBe(true);
    expect(src.includes('Switch to your own API key')).toBe(true);
    // Switching cloud ⇄ local now routes through a confirmation modal
    // (uncommon, consequential action) rather than toggling directly.
    expect(src.includes('SwitchBackendConfirmModal')).toBe(true);
    expect(src.includes("setPendingSwitch('cloud-proxy')")).toBe(true);
    expect(src.includes("setPendingSwitch('local')")).toBe(true);
  });

  it('A1.8: ProviderTiles exports the 13-member Provider union type', () => {
    const src = readFileSync(PROVIDER_TILES_TSX, 'utf-8');
    expect(src.includes("export type Provider =")).toBe(true);
    // Spot-check: the new ids are part of the type, not just the runtime tile array.
    expect(src.match(/export type Provider =[\s\S]*?\|\s*'perplexity'/)).toBeTruthy();
  });

  it('A1.9: OnboardingScreen routes the dynamic provider label into step-3 title', () => {
    const src = readFileSync(ONBOARDING_TSX, 'utf-8');
    expect(src.includes('PROVIDER_LABELS')).toBe(true);
    // Hardcoded "Local" fallback gone.
    expect(src.includes("provider === 'anthropic' ? 'Anthropic' : 'Local'")).toBe(false);
    // Saves the selected provider verbatim instead of forcing 'anthropic'.
    expect(src.includes('provider,')).toBe(true);
  });
});

describe('SettingsScreen + App (ui-A7 dev console toggle)', () => {
  it('A7.1: useUiStore exposes devConsoleVisible default-false + setter', () => {
    const src = readFileSync(USE_UI_STORE_TS, 'utf-8');
    expect(src.includes('devConsoleVisible: boolean')).toBe(true);
    expect(src.includes('devConsoleVisible: false')).toBe(true);
    expect(src.includes('setDevConsoleVisible')).toBe(true);
  });

  it('A7.2: App.tsx gates <LogsBar /> on devConsoleVisible', () => {
    const src = readFileSync(APP_TSX, 'utf-8');
    expect(src.includes('devConsoleVisible')).toBe(true);
    // LogsBar conditional must reference devConsoleVisible.
    const logsBarIdx = src.lastIndexOf('<LogsBar />');
    expect(logsBarIdx).toBeGreaterThan(0);
    const surrounding = src.slice(Math.max(0, logsBarIdx - 300), logsBarIdx);
    expect(surrounding.includes('devConsoleVisible')).toBe(true);
  });

  it('A7.3: UserConfigSchema includes optional dev_console_visible', () => {
    const src = readFileSync(SCHEMA_TS, 'utf-8');
    expect(src.includes('dev_console_visible')).toBe(true);
  });

  it('A7.4: SettingsScreen surfaces the developer console row + helper sentence', () => {
    const src = readFileSync(SETTINGS_TSX, 'utf-8');
    expect(src.includes('Show developer console')).toBe(true);
    expect(src.includes('Useful for debugging skin and bot issues.')).toBe(true);
    expect(src.includes('onToggleDevConsole')).toBe(true);
  });

  it('A7.5: SettingsScreen seeds devConsoleVisible from config on mount', () => {
    const src = readFileSync(SETTINGS_TSX, 'utf-8');
    expect(src.includes('setDevConsoleVisible(c.dev_console_visible)')).toBe(true);
  });
});

describe('SettingsScreen (D-FIX reset-all-memories unconditional)', () => {
  /*
   * D-FIX: the user spec ("'reset memory' button per-character in character
   * page and for all characters in settings page") is unconditional, but
   * ALPHA initially gated the row inside `authState.kind === 'signed_in'`.
   * These tests pin the row OUT of that conditional so local-mode users
   * can reset all memories too.
   */

  it('D-FIX.1: Reset-all-memories row is NOT nested inside the signed-in section', () => {
    const src = readFileSync(SETTINGS_TSX, 'utf-8');
    // The signed-in ACCOUNT panel opens with `authState.kind === 'signed_in' ? (`
    // and contains the ACCOUNT section + delete-account row. The new DANGER
    // section that owns the reset-all-memories button must sit OUTSIDE that
    // conditional so it renders in local mode too.
    //
    // We anchor on the JSX label (preceded by `>`) so we skip the code-comment
    // hits at the top of the file.
    const labelIdx = src.indexOf('>\n              Reset all character memories\n');
    expect(labelIdx).toBeGreaterThan(0);
    // The closest `<section` opening above the reset row should be the new
    // DANGER section (not the ACCOUNT-panel section that requires signed_in).
    const preamble = src.slice(0, labelIdx);
    const lastSection = preamble.lastIndexOf('<section');
    expect(lastSection).toBeGreaterThan(0);
    const sectionBlock = preamble.slice(lastSection);
    // The section block above the row must not open with the signed-in gate.
    expect(sectionBlock.includes("authState.kind === 'signed_in'")).toBe(false);
    // And the section must carry the DANGER eyebrow.
    expect(sectionBlock.includes('>DANGER<')).toBe(true);
  });

  it('D-FIX.2: DANGER section sits AFTER the conditional ACCOUNT MODE block', () => {
    const src = readFileSync(SETTINGS_TSX, 'utf-8');
    // The DANGER section is the terminus of the screen — below ACCOUNT MODE
    // so it's the last visual section regardless of auth state.
    const accountModeIdx = src.lastIndexOf('>ACCOUNT MODE<');
    const dangerIdx = src.lastIndexOf('>DANGER<');
    expect(accountModeIdx).toBeGreaterThan(0);
    expect(dangerIdx).toBeGreaterThan(accountModeIdx);
  });

  it('D-FIX.3: onResetAllMemoriesClick handler is still wired to the button', () => {
    const src = readFileSync(SETTINGS_TSX, 'utf-8');
    // Behavioural contract is unchanged — only the gating moved.
    expect(src.includes('onResetAllMemoriesClick')).toBe(true);
    expect(src.includes('Click again to confirm reset')).toBe(true);
    expect(src.includes('Reset all memories…')).toBe(true);
  });
});
