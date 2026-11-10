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
 *          Games / Appearance / About / Danger); no all-caps eyebrows.
 *   S.2  — 261110: Settings has no backend switch. One "Brain, voice and
 *          plan" row opens Playtime, whose tabs drive the
 *          SwitchBackendConfirmModal.
 *   S.3  — Theme is a <Seg> with the added System option.
 *   S.4  — Realistic typing + developer console are <Toggle>s.
 *   S.5  — Danger actions use the shared Button danger kind (no bespoke
 *          .dangerBtn CSS).
 *   S.6  — 260724: the Playtime row and every playtime-estimate reference are
 *          gone. Weekly usage lives on the plan screen.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { elevenKeySettingMode } from '../lib/voicePicker';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SETTINGS_TSX = resolve(__dirname, 'SettingsScreen.tsx');
const ONBOARDING_TSX = resolve(__dirname, 'OnboardingScreen.tsx');
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const SCHEMA_TS = resolve(REPO_ROOT, 'src', 'shared', 'characterSchema.ts');
const PROVIDER_SELECT_TSX = resolve(REPO_ROOT, 'src', 'renderer', 'src', 'components', 'ProviderSelect.tsx');
const LLM_CATALOG_TS = resolve(REPO_ROOT, 'src', 'shared', 'llmCatalog.ts');
const USE_UI_STORE_TS = resolve(REPO_ROOT, 'src', 'renderer', 'src', 'lib', 'stores', 'useUiStore.ts');
const APP_TSX = resolve(REPO_ROOT, 'src', 'renderer', 'src', 'App.tsx');
const EDIT_MODAL_TSX = resolve(REPO_ROOT, 'src', 'renderer', 'src', 'components', 'EditCharacterModal.tsx');
const VOICE_PICKER_TSX = resolve(REPO_ROOT, 'src', 'renderer', 'src', 'components', 'VoicePicker.tsx');
const DOWNLOAD_MODAL_TSX = resolve(REPO_ROOT, 'src', 'renderer', 'src', 'components', 'DownloadConfirmModal.tsx');
const ZH_TS = resolve(REPO_ROOT, 'src', 'renderer', 'src', 'lib', 'i18n', 'zh.ts');
// 261110: every AI and voice control moved from Settings to the Playtime page.
const PLAYTIME_TSX = resolve(__dirname, 'PlaytimeScreen.tsx');
const PT_DIR = resolve(REPO_ROOT, 'src', 'renderer', 'src', 'components', 'playtime');
const MYKEYS_TSX = resolve(PT_DIR, 'MyKeysTab.tsx');
const PARTS_TSX = resolve(PT_DIR, 'PlaytimeParts.tsx');
const VOICE_PANEL_TSX = resolve(PT_DIR, 'VoicePanel.tsx');
const ELEVEN_ROW_TSX = resolve(PT_DIR, 'ElevenKeyRow.tsx');

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
    for (const h of ['>Profile<', '>Account<', '>AI<', '>Games & search<', '>Appearance<', '>About<', '>Danger<']) {
      expect(src.includes(h)).toBe(true);
    }
    // The old uppercase section eyebrows are gone.
    for (const old of ['>PROFILE<', '>MINECRAFT<', '>APPEARANCE', '>LEGAL<', '>ACCOUNT MODE<', '>UPDATES<']) {
      expect(src.includes(old)).toBe(false);
    }
  });

  it('S.2: the AI group is one row that opens Playtime; Playtime owns the switch (261110)', () => {
    const src = readFileSync(SETTINGS_TSX, 'utf-8');
    expect(src.includes("t('Brain, voice and plan')")).toBe(true);
    expect(src.includes("navigate({ kind: 'credits' })")).toBe(true);
    // Nothing of the old AI and voice config is left in Settings.
    for (const gone of ['SwitchBackendConfirmModal', '<ProviderSelect', 'llmListModels', 'speechPackStatus', "t('Backend')"]) {
      expect(src.includes(gone)).toBe(false);
    }
    const pt = readFileSync(PLAYTIME_TSX, 'utf-8');
    expect(pt.includes('<SwitchBackendConfirmModal')).toBe(true);
    expect(pt.includes('setPendingSwitch(target)')).toBe(true);
    expect(pt.includes("direction={pendingSwitch === 'sei' ? 'cloud-proxy' : 'local'}")).toBe(true);
    // The old danger-styled inline switch buttons stay retired.
    expect(pt.includes('Switch to managed billing')).toBe(false);
    expect(pt.includes('Switch to your own API key')).toBe(false);
  });

  it('S.2b: the API key controls are hidden for Ollama, which is keyless (260915)', () => {
    const src = readFileSync(MYKEYS_TSX, 'utf-8');
    expect(src.includes("const keyless = provider === 'ollama';")).toBe(true);
    const from = src.indexOf('{keyless ? (');
    expect(from).toBeGreaterThan(-1);
    const block = src.slice(from, from + 600);
    expect(block.indexOf("t('No key needed')") < block.indexOf("t('Change key')")).toBe(true);
  });

  it('S.3: theme picker is four color swatches, no System option', () => {
    const src = readFileSync(SETTINGS_TSX, 'utf-8');
    expect(src.includes("aria-label={t('Theme')}")).toBe(true);
    // All four named themes offered as swatches (260724).
    expect(src.includes("value: 'midnight'")).toBe(true);
    expect(src.includes("value: 'ice'")).toBe(true);
    expect(src.includes("value: 'acorn'")).toBe(true);
    expect(src.includes("value: 'mint'")).toBe(true);
    // System was retired from the picker; names ride the data-tip tooltip.
    expect(src.includes("value: 'system'")).toBe(false);
    expect(src.includes('data-tip={t.label}')).toBe(true);
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

  it('S.6: the Playtime row and its estimate plumbing are gone (260724)', () => {
    const src = readFileSync(SETTINGS_TSX, 'utf-8');
    // No Playtime row: the weekly-allowance bar lives on the plan screen, and
    // there is no time estimate left to show anywhere in the UI.
    expect(src.includes('>Playtime<')).toBe(false);
    expect(src.includes('tokensRemainingToPlaytime')).toBe(false);
    expect(src.includes('playtimeEstimate')).toBe(false);
    expect(src.includes('DEFAULT_TOKENS_PER_MIN')).toBe(false);
    expect(src.includes('VISION_MULTIPLIER')).toBe(false);
  });
});

describe('SettingsScreen (ui-A1 mode gating)', () => {
  it('A1.1: Playtime reads ai_backend_kind from useCreditsStore', () => {
    const src = readFileSync(PLAYTIME_TSX, 'utf-8');
    expect(src.includes('useCreditsStore((s) => s.ai_backend_kind)')).toBe(true);
  });

  it('A1.2: provider + api-key rows live on the My keys tab, shown only while it is the setup in use', () => {
    const src = readFileSync(MYKEYS_TSX, 'utf-8');
    expect(src.includes('if (!active) {')).toBe(true);
    expect(src.indexOf('<ProviderSelect')).toBeGreaterThan(src.indexOf('if (!active) {'));
    const pt = readFileSync(PLAYTIME_TSX, 'utf-8');
    expect(pt.includes('isActiveSetupTab(tab, backend, provider)')).toBe(true);
  });

  it('A1.3: GAMES section is shown in BOTH cloud and local mode', () => {
    const src = readFileSync(SETTINGS_TSX, 'utf-8');
    // Skin sideloading and game setup are independent of the AI-backend
    // billing path, so the group must render regardless of mode. Anchor on
    // the sentence-case header (260908: one "Games" group hosts every game,
    // Minecraft's rows inside it via GamesSettingsGroup).
    const skinsIdx = src.indexOf('>Games & search<');
    expect(src.includes('<GamesSettingsGroup')).toBe(true);
    expect(skinsIdx).toBeGreaterThan(0);
    // The group must NOT be wrapped in a local-only gate. The 200 chars before
    // the header should not open an `aiBackendKind === 'local'` conditional.
    const preamble = src.slice(Math.max(0, skinsIdx - 200), skinsIdx);
    expect(preamble.includes("aiBackendKind === 'local'")).toBe(false);
  });

  it('A1.4: ProviderSelect is rendered compact on My keys, without the ChatGPT plan (its own tab)', () => {
    const src = readFileSync(MYKEYS_TSX, 'utf-8');
    expect(src.includes("from '../ProviderSelect'")).toBe(true);
    expect(src.includes('compact quiet exclude={NO_CHATGPT}')).toBe(true);
    expect(src.includes("const NO_CHATGPT: readonly Provider[] = ['chatgpt'];")).toBe(true);
  });

  it('A1.5: ProviderSelect offers the catalog SHOWN list; grandfathered only when current (260816)', () => {
    const src = readFileSync(PROVIDER_SELECT_TSX, 'utf-8');
    // The offered options come from the shared catalog, not a hardcoded list.
    expect(src.includes("from '@shared/llmCatalog'")).toBe(true);
    expect(src.includes('SHOWN_PROVIDERS')).toBe(true);
    expect(src.includes('PROVIDER_LABELS')).toBe(true);
    // A grandfathered current value is appended as the selected option.
    expect(src.includes('SHOWN_PROVIDERS.includes(value)')).toBe(true);
    // No hardcoded per-provider option entries survive.
    for (const id of ['mistral', 'together', 'groq', 'fireworks', 'cerebras', 'perplexity']) {
      expect(src.includes(`'${id}'`)).toBe(false);
    }
    expect(src.includes('styles.chip')).toBe(false);
    expect(src.includes('>Coming soon<')).toBe(false);
  });

  it('A1.5b: the shared catalog shows 8 providers and grandfathers the dropped 6', () => {
    const catalog = readFileSync(LLM_CATALOG_TS, 'utf-8');
    const shownBlock = catalog.slice(catalog.indexOf('SHOWN_PROVIDERS'), catalog.indexOf('GRANDFATHERED_PROVIDERS'));
    for (const id of ['anthropic', 'openai', 'deepseek', 'qwen', 'gemini', 'grok', 'openrouter', 'ollama']) {
      expect(shownBlock.includes(`'${id}'`)).toBe(true);
    }
    for (const id of ['mistral', 'together', 'groq', 'fireworks', 'cerebras', 'perplexity']) {
      expect(shownBlock.includes(`'${id}'`)).toBe(false);
    }
    const grandfathered = catalog.slice(catalog.indexOf('GRANDFATHERED_PROVIDERS'), catalog.indexOf('PROVIDER_LABELS'));
    for (const id of ['mistral', 'together', 'groq', 'fireworks', 'cerebras', 'perplexity']) {
      expect(grandfathered.includes(`'${id}'`)).toBe(true);
    }
  });

  it('A1.6: UserConfigSchema provider enum keeps all 14 backends (incl. qwen) + has provider_config', () => {
    const src = readFileSync(SCHEMA_TS, 'utf-8');
    // Grandfathered values MUST stay in the enum — existing configs round-trip.
    for (const id of ['anthropic', 'openai', 'gemini', 'ollama', 'grok', 'openrouter', 'deepseek', 'qwen', 'mistral', 'together', 'groq', 'fireworks', 'cerebras', 'perplexity']) {
      expect(src.includes(`'${id}'`)).toBe(true);
    }
    expect(src.includes('provider_config')).toBe(true);
  });

  it('A1.8: ProviderSelect re-exports the catalog ProviderKind as Provider', () => {
    const src = readFileSync(PROVIDER_SELECT_TSX, 'utf-8');
    expect(src.includes('export type Provider = ProviderKind')).toBe(true);
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

// 261110: the model picker moved to Playtime (PlaytimeParts' ModelSelect,
// used by the ChatGPT and My keys tabs). The Test probe row was dropped with
// the move: a bad key or model shows its error line under the Brain row.
describe('Playtime model picker (W5 china-compat, moved 261110)', () => {
  it('W5.1: the model list rides the typed llm IPC', () => {
    const src = readFileSync(PARTS_TSX, 'utf-8');
    expect(src.includes('sei.llmListModels(provider)')).toBe(true);
  });

  it('W5.2: the picked model persists to provider_config[provider].model — the field resolveLocalModel reads', () => {
    const src = readFileSync(MYKEYS_TSX, 'utf-8');
    expect(src.includes('model: id }')).toBe(true);
    expect(src.includes('provider_config: pc')).toBe(true);
    // The current-model readout falls back to the catalog default.
    expect(src.includes('stored ?? DEFAULT_MODELS[provider]')).toBe(true);
  });

  it('W5.3: every typed error token maps to a human string', () => {
    const src = readFileSync(PARTS_TSX, 'utf-8');
    for (const token of ["'no_api_key'", "'unauthorized'", "'timeout'", "'network'", "startsWith('http_')"]) {
      expect(src.includes(token)).toBe(true);
    }
    expect(src.includes('Something went wrong. Try again.')).toBe(true);
  });

  it('W5.5: non-vision models are marked, and a picked one says why on hover', () => {
    const src = readFileSync(PARTS_TSX, 'utf-8');
    expect(src.includes("m.vision === 'no'")).toBe(true);
    expect(src.includes('Screen sharing and Draw! need a vision model.')).toBe(true);
  });
});

// 261110: voice moved to Playtime (VoicePanel on the ChatGPT and My keys tabs).
describe('Playtime voice panel (W5 china-compat: TTS packs + SenseVoice, moved 261110)', () => {
  it('V.1: Settings has no Voice group; the voice panel sits on the ChatGPT and My keys tabs', () => {
    expect(readFileSync(SETTINGS_TSX, 'utf-8').includes('>Voice<')).toBe(false);
    expect(readFileSync(resolve(PT_DIR, 'ChatgptTab.tsx'), 'utf-8').includes('<VoicePanel mode="chatgpt"')).toBe(true);
    expect(readFileSync(MYKEYS_TSX, 'utf-8').includes('<VoicePanel mode="mykeys"')).toBe(true);
  });

  it('V.2: voice sources per tab; the device engine (Fast / Kokoro) is inline, never its own row', () => {
    const src = readFileSync(VOICE_PANEL_TSX, 'utf-8');
    expect(src.includes("{ value: 'device', label: t('On this device') }")).toBe(true);
    expect(src.includes("{ value: 'elevenlabs', label: t('ElevenLabs key') }")).toBe(true);
    expect(src.includes("{ value: 'fish', label: t('Fish Audio key') }")).toBe(true);
    expect(src.includes("{ value: 'sei' as const, label: t('Sei voices') }")).toBe(true);
    // Sei voices and its "Free this week" meter stay behind the flag (review 261110).
    expect(src.includes("...(SEI_VOICES_FOR_CHATGPT_ENABLED && (signedIn || source === 'sei')")).toBe(true);
    expect(src.includes('const showTrial = SEI_VOICES_FOR_CHATGPT_ENABLED &&')).toBe(true);
    expect(src.includes('<option value="fast">{t(\'Fast\')}</option>')).toBe(true);
    expect(src.includes('<option value="kokoro">Kokoro</option>')).toBe(true);
    expect(src.includes('local_tts_voice')).toBe(false);
    // Picking Kokoro without its pack offers the download, then saves.
    expect(src.includes("if (thenKokoro) await persistLocalModel('kokoro')")).toBe(true);
    expect(/experimental/i.test(src)).toBe(false);
  });

  it('V.3: the two TTS pack rows carry the registry pack ids and an uninstall affordance', () => {
    const src = readFileSync(VOICE_PANEL_TSX, 'utf-8');
    for (const id of ["'tts-en'", "'tts-zh'"]) {
      expect(src.includes(id)).toBe(true);
    }
    expect(src.includes("'tts-zh-f'")).toBe(false);
    expect(src.includes("'tts-zh-m'")).toBe(false);
    expect(src.includes("t('(free)')")).toBe(false);
    expect(src.includes("t('Uninstall')")).toBe(true);
    expect(src.includes('onRemovePack')).toBe(true);
    expect(src.includes('<DownloadConfirmModal')).toBe(true);
  });

  it('V.4: pack state rides the speech IPC and sizes come from the push, never hardcoded', () => {
    const src = readFileSync(VOICE_PANEL_TSX, 'utf-8');
    expect(src.includes('.speechPackStatus()')).toBe(true);
    expect(src.includes('sei.onSpeechPackState')).toBe(true);
    expect(src.includes('bytes={packStates[pendingPack.id].bytes}')).toBe(true);
    for (const literal of ['78 MB', '30 MB', '13 MB', '155 MB', '158 MB']) {
      expect(src.includes(literal)).toBe(false);
    }
  });

  it('V.5: voice recognition offers scribe / whisper / SenseVoice, download-gated', () => {
    const src = readFileSync(VOICE_PANEL_TSX, 'utf-8');
    expect(src.includes('<option value="scribe">{t(\'ElevenLabs Scribe\')}</option>')).toBe(true);
    expect(src.includes('<option value="whisper">{t(\'Local Whisper\')}</option>')).toBe(true);
    expect(src.includes('<option value="sensevoice">{t(\'SenseVoice\')}</option>')).toBe(true);
    expect(src.includes("packStates[SENSEVOICE_PACK_ID]?.state !== 'ready'")).toBe(true);
    expect(src.includes("if (thenSensevoice) await persistStt('sensevoice')")).toBe(true);
  });
});

describe('SettingsScreen (T158: optional ElevenLabs key on Sei Cloud)', () => {
  it('OV.1: the key field shows for BYOK + ElevenLabs and as an optional field on Cloud, never twice', () => {
    expect(elevenKeySettingMode('local', 'elevenlabs')).toBe('byok');
    expect(elevenKeySettingMode('local', 'local')).toBe('hidden');
    // Cloud ignores tts_engine (no engine choice there): always optional.
    expect(elevenKeySettingMode('cloud-proxy', 'elevenlabs')).toBe('cloud-optional');
    expect(elevenKeySettingMode('cloud-proxy', 'local')).toBe('cloud-optional');
    // Backend not reported yet: nothing.
    expect(elevenKeySettingMode(null, 'elevenlabs')).toBe('hidden');
  });

  it('OV.2: the Sei tab renders the shared key row in optional mode; one key editor in the source', () => {
    const pt = readFileSync(PLAYTIME_TSX, 'utf-8');
    expect(pt.includes('<ElevenKeyRow mode="cloud-optional" />')).toBe(true);
    expect(readFileSync(VOICE_PANEL_TSX, 'utf-8').includes('<ElevenKeyRow mode="byok" />')).toBe(true);
    const row = readFileSync(ELEVEN_ROW_TSX, 'utf-8');
    expect((row.match(/placeholder=\{t\('Your ElevenLabs key'\)\}/g) ?? []).length).toBe(1);
    // "Not set" is a warning only in BYOK mode.
    expect(row.includes("hasKey || mode === 'cloud-optional'")).toBe(true);
  });

  it('OV.3: the picker points to the key field when none is saved, on either backend', () => {
    const src = readFileSync(VOICE_PICKER_TSX, 'utf-8');
    expect(src.includes('elevenKeyHintShown(hasElevenKey, localTtsMode)')).toBe(true);
    expect(src.includes("t('Have your own ElevenLabs voices? Add your ElevenLabs key in Playtime.')")).toBe(
      true,
    );
    // The free-plan pool hint is a local-backend thing only.
    expect(src.includes('poolUsesOwnKey(ownList, aiBackendKind)')).toBe(true);
  });
});

describe('DownloadConfirmModal (W5 shared "Download? (XX MB)" confirm)', () => {
  it('DL.1: renders through ModalShell with the size computed from exact bytes', () => {
    const src = readFileSync(DOWNLOAD_MODAL_TSX, 'utf-8');
    expect(src.includes('ModalShell')).toBe(true);
    expect(src.includes('ModalFooter')).toBe(true);
    expect(src.includes('export function formatMb')).toBe(true);
    expect(src.includes('bytes / (1024 * 1024)')).toBe(true);
    expect(src.includes("t('Download ({mb} MB)', { mb })")).toBe(true);
  });
});

describe('EditCharacterModal + VoicePicker (W5 local-TTS voice gating)', () => {
  it('G.1: EditCharacterModal derives localTtsMode from backend kind + tts_engine and passes it down', () => {
    const src = readFileSync(EDIT_MODAL_TSX, 'utf-8');
    expect(src.includes("aiBackendKind === 'local' && localTtsPref")).toBe(true);
    expect(src.includes("c.tts_engine === 'local'")).toBe(true);
    expect(src.includes('localTtsMode={localTtsMode}')).toBe(true);
  });

  it('G.2: VoicePicker hides the ElevenLabs list/previews + Calmness in localTtsMode, keeps Pitch tunable', () => {
    const src = readFileSync(VOICE_PICKER_TSX, 'utf-8');
    expect(src.includes('localTtsMode?: boolean')).toBe(true);
    // The list/sample half and the Calmness slider are both behind the gate.
    expect((src.match(/localTtsMode \? null/g) ?? []).length).toBeGreaterThanOrEqual(2);
    // Pitch stays live without an ElevenLabs selection.
    expect(src.includes('localTtsMode || (value !== null && value !== NO_VOICE_ID)')).toBe(true);
  });

  it('G.3: the stored ElevenLabs voiceId is preserved untouched underneath', () => {
    const src = readFileSync(EDIT_MODAL_TSX, 'utf-8');
    // The deferred save still writes voiceId from state — which localTtsMode
    // never mutates, since the picker that changes it is hidden. (261019:
    // written through applyVoicePick, which also carries the own-voice marker.)
    expect(src.includes('applyVoicePick(latest.metadata, voiceId, voiceOwn)')).toBe(true);
  });

  it('G.4: every W5 user string has a zh entry in the dedicated block', () => {
    const zh = readFileSync(ZH_TS, 'utf-8');
    const block = zh.slice(zh.indexOf('// W5 settings (china-compat)'));
    expect(block.length).toBeGreaterThan(0);
    for (const key of [
      "'Choose model'",
      "'Testing your key and model. This can take up to a minute.'",
      "'SenseVoice'",
      "'Download ({mb} MB)'",
      "'Local'",
    ]) {
      expect(block.includes(key)).toBe(true);
    }
    // No em dash anywhere in the W5 copy, either language.
    expect(block.includes('—')).toBe(false);
  });
});

// 261023: web search moved into the Games group ("Games & search"),
// and the ChatGPT plan block became one row with the sign-in button.
describe('261023 settings tidy: web search tab + compact ChatGPT plan row', () => {
  const settings = readFileSync(SETTINGS_TSX, 'utf8');
  const credits = readFileSync(resolve(__dirname, 'CreditsScreen.tsx'), 'utf8');
  const games = readFileSync(
    resolve(REPO_ROOT, 'src', 'renderer', 'src', 'components', 'settings', 'GamesSettingsGroup.tsx'),
    'utf8',
  );

  it('the standalone Search group is gone; Web search is an extra tab of Games & search', () => {
    expect(settings).not.toMatch(/>\s*\{t\('Search'\)\}\s*</);
    expect(settings).toContain("extraTabs={[");
    expect(settings).toContain("id: 'search'");
    expect(settings).toContain('<SearchSettingsSection config={cfg} saveConfig={persistConfig} />');
    expect(games).toContain('extraTabs');
  });

  it('the ChatGPT plan intent flag now opens Playtime on its ChatGPT tab (261110)', () => {
    expect(credits).not.toContain('ChatGPT plan, separate from Sei plans');
    expect(credits).not.toContain('Have ChatGPT Plus or Pro?');
    expect(readFileSync(USE_UI_STORE_TS, 'utf8')).toContain(
      "{ kind: 'credits'; tab?: PlaytimeTab; useChatgptPlan?: boolean }",
    );
    expect(readFileSync(USE_UI_STORE_TS, 'utf8')).not.toContain('SettingsFocus');
    expect(settings).not.toContain('chatgptPlanIntent');
    expect(settings).not.toContain('data-settings-focus');
  });

  it('Playtime runs the intent once through the normal switch paths, then clears it', () => {
    const pt = readFileSync(PLAYTIME_TSX, 'utf8');
    const at = pt.indexOf('if (!chatgptPlanIntent) return;');
    expect(at).toBeGreaterThan(-1);
    const body = pt.slice(at, at + 700);
    expect(body).toContain('chatgptPlanIntentStep(!!cfg, chatgptStatus, backend)');
    expect(body).toContain("if (step === 'wait') return;");
    // Clears the flag before anything else, so it never fires later.
    expect(body).toMatch(
      /if \(step === 'wait'\) return;\s*useUiStore\.setState\(\{ view: \{ kind: 'credits', tab: 'chatgpt' \} \}\);\s*setTab\('chatgpt'\);\s*if \(step === 'drop'\) return;/,
    );
    // Both backends confirm through the same modal as the tab's own button.
    expect(body).toContain("setPendingSwitch('chatgpt')");
  });
});
