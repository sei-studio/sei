/**
 * Tests for SettingsScreen — "Party" restyle (§4.7) plus the preserved
 * ui-A1 (backend mode gating + 13-provider picker), ui-A7 (developer console),
 * and D-FIX (unconditional reset-all-memories) invariants.
 *
 * Project convention (no @testing-library/react installed): exercise the
 * source contract via grep-style file presence checks. Mirrors
 * src/renderer/src/screens/CharactersScreen.test.tsx.
 *
 * Structural invariants (Party restyle):
 *   S.1  — sentence-case Oswald group headers (Profile / Account / AI /
 *          Minecraft / Appearance / About / Danger); no all-caps eyebrows.
 *   S.2  — Backend switch is a <Seg> (Cloud / My key) that drives the
 *          SwitchBackendConfirmModal; cancel reverts because the value tracks
 *          ai_backend_kind.
 *   S.3  — Theme is a <Seg> with the added System option.
 *   S.4  — Realistic typing + developer console are <Toggle>s.
 *   S.5  — Danger actions use the shared Button danger kind (no bespoke
 *          .dangerBtn CSS).
 *   S.6  — Cloud users get a Playtime row whose Add navigates to credits.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SETTINGS_TSX = resolve(__dirname, 'SettingsScreen.tsx');
const ONBOARDING_TSX = resolve(__dirname, 'OnboardingScreen.tsx');
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const SCHEMA_TS = resolve(REPO_ROOT, 'src', 'shared', 'characterSchema.ts');
const PROVIDER_SELECT_TSX = resolve(REPO_ROOT, 'src', 'renderer', 'src', 'components', 'ProviderSelect.tsx');
const USE_UI_STORE_TS = resolve(REPO_ROOT, 'src', 'renderer', 'src', 'lib', 'stores', 'useUiStore.ts');
const APP_TSX = resolve(REPO_ROOT, 'src', 'renderer', 'src', 'App.tsx');

beforeEach(() => {
  (globalThis as unknown as { window: unknown }).window = {
    sei: {},
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
});

describe('SettingsScreen (Party restyle structure)', () => {
  it('S.1: sentence-case Oswald group headers, no all-caps eyebrows', () => {
    const src = readFileSync(SETTINGS_TSX, 'utf-8');
    for (const h of ['>Profile<', '>Account<', '>AI<', '>Minecraft<', '>Appearance<', '>About<', '>Danger<']) {
      expect(src.includes(h)).toBe(true);
    }
    // The old uppercase section eyebrows are gone.
    for (const old of ['>PROFILE<', '>MINECRAFT<', '>APPEARANCE', '>LEGAL<', '>ACCOUNT MODE<', '>UPDATES<']) {
      expect(src.includes(old)).toBe(false);
    }
  });

  it('S.2: backend switch is a Seg wired to SwitchBackendConfirmModal', () => {
    const src = readFileSync(SETTINGS_TSX, 'utf-8');
    expect(src.includes("from '../components/Seg'")).toBe(true);
    expect(src.includes('aria-label="AI backend"')).toBe(true);
    // Both directional intents route through the confirm modal — the Seg maps
    // its value to the target backend, then arms the pending switch.
    expect(src.includes('SwitchBackendConfirmModal')).toBe(true);
    expect(src.includes("v === 'cloud' ? 'cloud-proxy' : 'local'")).toBe(true);
    expect(src.includes('setPendingSwitch(target)')).toBe(true);
    // The old danger-styled inline switch buttons are retired.
    expect(src.includes('Switch to managed billing')).toBe(false);
    expect(src.includes('Switch to your own API key')).toBe(false);
  });

  it('S.3: theme is a Seg with the System option', () => {
    const src = readFileSync(SETTINGS_TSX, 'utf-8');
    expect(src.includes('aria-label="Theme"')).toBe(true);
    // dark / light / system all offered.
    expect(src.includes("value: 'dark'")).toBe(true);
    expect(src.includes("value: 'light'")).toBe(true);
    expect(src.includes("value: 'system'")).toBe(true);
    // Persisted via saveConfig theme_mode, and reads themeMode from the store.
    expect(src.includes('theme_mode: mode')).toBe(true);
    expect(src.includes('useUiStore((s) => s.themeMode)')).toBe(true);
  });

  it('S.4: realistic typing + developer console are Toggles', () => {
    const src = readFileSync(SETTINGS_TSX, 'utf-8');
    expect(src.includes("from '../components/Toggle'")).toBe(true);
    expect(src.includes('<Toggle')).toBe(true);
    expect(src.includes('onToggleRealisticTyping')).toBe(true);
    expect(src.includes('onToggleDevConsole')).toBe(true);
  });

  it('S.5: danger actions use the shared Button danger kind, not .dangerBtn', () => {
    const src = readFileSync(SETTINGS_TSX, 'utf-8');
    expect(src.includes('styles.dangerBtn')).toBe(false);
    expect(src.includes('kind="danger"')).toBe(true);
  });

  it('S.6: cloud users get a Playtime row whose Add navigates to credits', () => {
    const src = readFileSync(SETTINGS_TSX, 'utf-8');
    expect(src.includes('>Playtime<')).toBe(true);
    expect(src.includes('tokensRemainingToPlaytime')).toBe(true);
    expect(src.includes("navigate({ kind: 'credits' })")).toBe(true);
  });
});

describe('SettingsScreen (ui-A1 mode gating)', () => {
  it('A1.1: reads ai_backend_kind from useCreditsStore', () => {
    const src = readFileSync(SETTINGS_TSX, 'utf-8');
    expect(src.includes('useCreditsStore((s) => s.ai_backend_kind)')).toBe(true);
  });

  it('A1.2: provider + api-key rows gated on aiBackendKind === local', () => {
    const src = readFileSync(SETTINGS_TSX, 'utf-8');
    expect(src.includes("aiBackendKind === 'local'")).toBe(true);
    const providerIdx = src.indexOf('ProviderSelect');
    expect(providerIdx).toBeGreaterThan(0);
  });

  it('A1.3: MINECRAFT section is shown in BOTH cloud and local mode', () => {
    const src = readFileSync(SETTINGS_TSX, 'utf-8');
    // Skin sideloading is independent of the AI-backend billing path, so the
    // group must render regardless of mode. Anchor on the sentence-case header.
    const skinsIdx = src.indexOf('>Minecraft<');
    expect(skinsIdx).toBeGreaterThan(0);
    // The group must NOT be wrapped in a local-only gate. The 200 chars before
    // the header should not open an `aiBackendKind === 'local'` conditional.
    const preamble = src.slice(Math.max(0, skinsIdx - 200), skinsIdx);
    expect(preamble.includes("aiBackendKind === 'local'")).toBe(false);
  });

  it('A1.4: ProviderSelect is imported + rendered in compact mode', () => {
    const src = readFileSync(SETTINGS_TSX, 'utf-8');
    expect(src.includes("from '../components/ProviderSelect'")).toBe(true);
    expect(src.includes('<ProviderSelect')).toBe(true);
    expect(src.includes('compact')).toBe(true);
  });

  it('A1.5: ProviderSelect ships all 13 providers and NO Coming soon chip', () => {
    const src = readFileSync(PROVIDER_SELECT_TSX, 'utf-8');
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

  it('A1.8: ProviderSelect exports the 13-member Provider union type', () => {
    const src = readFileSync(PROVIDER_SELECT_TSX, 'utf-8');
    expect(src.includes("export type Provider =")).toBe(true);
    expect(src.match(/export type Provider =[\s\S]*?\|\s*'perplexity'/)).toBeTruthy();
  });

  it('A1.9: OnboardingScreen routes the dynamic provider label into step-3 title', () => {
    const src = readFileSync(ONBOARDING_TSX, 'utf-8');
    expect(src.includes('PROVIDER_LABELS')).toBe(true);
    expect(src.includes("provider === 'anthropic' ? 'Anthropic' : 'Local'")).toBe(false);
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
    const logsBarIdx = src.lastIndexOf('<LogsBar />');
    expect(logsBarIdx).toBeGreaterThan(0);
    const surrounding = src.slice(Math.max(0, logsBarIdx - 300), logsBarIdx);
    expect(surrounding.includes('devConsoleVisible')).toBe(true);
  });

  it('A7.3: UserConfigSchema includes optional dev_console_visible', () => {
    const src = readFileSync(SCHEMA_TS, 'utf-8');
    expect(src.includes('dev_console_visible')).toBe(true);
  });

  it('A7.4: SettingsScreen surfaces the developer console toggle + helper sentence', () => {
    const src = readFileSync(SETTINGS_TSX, 'utf-8');
    expect(src.includes('Developer console')).toBe(true);
    expect(src.includes('Useful for debugging skin and bot issues.')).toBe(true);
    expect(src.includes('onToggleDevConsole')).toBe(true);
  });

  it('A7.5: SettingsScreen seeds devConsoleVisible from config on mount', () => {
    const src = readFileSync(SETTINGS_TSX, 'utf-8');
    expect(src.includes('setDevConsoleVisible(c.dev_console_visible)')).toBe(true);
  });
});

describe('SettingsScreen (D-FIX reset-all-memories unconditional)', () => {
  it('D-FIX.1: Reset-all-memories row is NOT nested inside the signed-in section', () => {
    const src = readFileSync(SETTINGS_TSX, 'utf-8');
    // The reset row lives in the terminal DANGER group, which renders
    // regardless of auth state so local-mode users can reset too.
    const labelIdx = src.indexOf('Reset all companion memories');
    expect(labelIdx).toBeGreaterThan(0);
    const preamble = src.slice(0, labelIdx);
    // The nearest group header above the row must be Danger.
    const lastH3 = preamble.lastIndexOf('<h3');
    const h3Block = preamble.slice(lastH3);
    expect(h3Block.includes('>Danger<')).toBe(true);
    // The group's opening <div> must not be behind a signed-in gate.
    const lastGroup = preamble.lastIndexOf('className={styles.group}');
    const groupBlock = preamble.slice(lastGroup);
    expect(groupBlock.includes("authState.kind === 'signed_in'")).toBe(false);
  });

  it('D-FIX.2: DANGER group is the terminus, after About', () => {
    const src = readFileSync(SETTINGS_TSX, 'utf-8');
    const aboutIdx = src.indexOf('>About<');
    const dangerIdx = src.indexOf('>Danger<');
    expect(aboutIdx).toBeGreaterThan(0);
    expect(dangerIdx).toBeGreaterThan(aboutIdx);
  });

  it('D-FIX.3: reset-all-memories button opens the confirm popup', () => {
    const src = readFileSync(SETTINGS_TSX, 'utf-8');
    expect(src.includes('onResetAllMemoriesClick')).toBe(true);
    expect(src.includes('Reset all memories…')).toBe(true);
    expect(src.includes('ResetAllMemoriesConfirmModal')).toBe(true);
    expect(src.includes('Click again to confirm reset')).toBe(false);
  });
});
