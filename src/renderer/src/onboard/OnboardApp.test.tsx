/**
 * Source-contract tests for OnboardApp's W6 local-mode onboarding
 * (260817, china-compat). Repo convention (no @testing-library/react):
 * grep-style checks over the source, mirroring AuthChoiceScreen.test.tsx.
 *
 * Invariants under test:
 *   1. CLOUD PATH UNTOUCHED — runCloudSetup still saves the cloud config,
 *      persists the questionnaire (prefsSave), and generates the companion,
 *      and the cloud branch of the setup dispatch runs it exactly when no
 *      local choices are armed.
 *   2. LOCAL PATH RESTORED — runLocalSetup mirrors the full cloud arc:
 *      config save with the picked provider + model (provider_config, where
 *      the llm layer reads it), prefsSave, BYOK generateUnique, and the
 *      'return' scene so a generated companion reaches the FULL tutorial.
 *   3. Voice engine choices are OPTIONAL and only written when made
 *      (absent = Whisper-fallback STT / ElevenLabs TTS semantics).
 *   4. The wizard uses the scene's native panel vocabulary, not ModalShell.
 *   5. Provider step upgrade: live model list + Test through llm:list-models
 *      / llm:test, the DeepSeek up-to-a-minute pending copy, and the
 *      non-vision hint naming the two vision surfaces.
 *   6. Pack downloads confirm with exact sizes from speech:pack-status and
 *      show live progress from speech:pack-state.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(__dirname, 'OnboardApp.tsx'), 'utf-8');

describe('OnboardApp W6: cloud path untouched', () => {
  it('runCloudSetup keeps its exact save/prefs/generate arc', () => {
    const cloud = src.slice(src.indexOf('runCloudSetup = useCallback'), src.indexOf('}, [buildConfig]);'));
    expect(cloud).toContain("saveConfig(buildConfig('cloud-proxy'))");
    expect(cloud).toContain('prefsSave');
    expect(cloud).toContain('generateUnique');
    expect(cloud).toContain("track('onboarding_completed')");
    expect(cloud).toContain("setPhase({ k: 'return' })");
  });
  it('the setup phase dispatches to the cloud path when no local choices are armed', () => {
    expect(src).toContain(
      "if (phase.k === 'setup') void (localChoicesRef.current ? runLocalSetup() : runCloudSetup());",
    );
  });
});

describe('OnboardApp W6: local path restored (full onboarding)', () => {
  const local = src.slice(src.indexOf('const runLocalSetup'), src.indexOf('useEffect(() => {\n    if (phase.k === \'setup\')'));

  it('saves the local config with the picked provider and model where the llm layer reads it', () => {
    expect(local).toContain("buildConfig('local', choices.provider");
    expect(local).toContain('provider_config: { [choices.provider]: { model: choices.model } }');
  });
  it('persists the questionnaire (prefsSave) exactly like the cloud path', () => {
    expect(local).toContain('prefsSave');
    expect(local).toContain('companion_age_range');
    expect(local).toContain('companion_dynamics');
  });
  it('runs BYOK generation and routes the result into the return scene (full tutorial)', () => {
    expect(local).toContain('generateUnique');
    expect(local).toContain('genCharacterIdRef.current = characterId');
    expect(local).toContain("setPhase({ k: 'return' })");
  });
  it('writes stt/tts engines only when chosen — absent keys keep default semantics', () => {
    expect(local).toContain('...(choices.stt ? { stt_engine: choices.stt } : {})');
    expect(local).toContain('...(choices.tts ? { tts_engine: choices.tts } : {})');
  });
  it('still tracks onboarding_completed and honors skipCreation', () => {
    expect(local).toContain("track('onboarding_completed')");
    expect(local).toContain('skipCreation');
  });
});

describe('OnboardApp W6: local wizard steps', () => {
  it('is a four-step wizard in the panel idiom (no ModalShell)', () => {
    expect(src).toContain("'key' | 'model' | 'stt' | 'tts'");
    expect(src).not.toContain('ModalShell');
    expect(src).toContain('styles.panel');
  });
  it('model step lists live models and tests through the layer', () => {
    expect(src).toContain('llmListModels');
    expect(src).toContain('llmTest');
    expect(src).toContain('DEFAULT_MODELS');
  });
  it('carries the DeepSeek up-to-a-minute pending copy', () => {
    expect(src).toContain('Testing... DeepSeek can take up to a minute to answer.');
  });
  it('marks non-vision models with the two vision surfaces by name', () => {
    expect(src).toContain('This model cannot see images. Screen sharing and Draw! need a vision model.');
  });
  it('both voice steps offer a decide-later path', () => {
    expect((src.match(/Decide later/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
  it('local options drop the decorative (free) badge and confirm the download in MB', () => {
    expect(src).not.toContain('Whisper (free)');
    expect(src).toContain('SenseVoice (best for Chinese)');
    expect(src).toContain("'Local voices'");
    expect(src).toContain('Download? ({mb} MB)');
  });
  it('pack sizes come from speech:pack-status and progress from speech:pack-state', () => {
    expect(src).toContain('speechPackStatus');
    expect(src).toContain('onSpeechPackState');
    expect(src).toContain('speechPackDownload');
    // No hardcoded pack byte counts in the component.
    expect(src).not.toMatch(/82_?038_?311|165_?783_?878/);
  });
  it('ollama may proceed without an API key; every other provider requires one', () => {
    expect(src).toContain("key.trim() !== '' || provider === 'ollama'");
  });
});

describe('OnboardApp: key-step probe (260817)', () => {
  it('Continue on the key step probes the key before advancing', () => {
    // submitKey saves the key, then asks the probe; only an 'ok' verdict
    // advances to the model step.
    expect(src).toContain('const verdict = await probeKey()');
    expect(src).toContain("if (verdict === 'ok')");
    expect(src).toContain('setProbe(verdict)');
  });
  it('the probe rides the transport helper (openrouter tests, others list)', () => {
    expect(src).toContain('keyProbeTransport(provider)');
    expect(src).toContain('keyProbeVerdict(provider,');
  });
  it('a definite failure interrupts with Back and Continue anyway', () => {
    expect(src).toContain('keyProbeLine(provider, probe)');
    expect(src).toContain('keyProbeConsequence(probe)');
    expect(src).toContain('Continue anyway');
  });
  it('Continue anyway on a REJECTED key skips generation; a re-submitted key un-skips it', () => {
    expect(src).toContain("if (probe === 'rejected') skipGenRef.current = true;");
    expect(src).toContain('skipGenRef.current = false;');
    expect(src).toContain('...(skipGenRef.current ? { skipGeneration: true } : {})');
  });
  it('runLocalSetup honors skipGeneration (reduced tutorial, no wasted timeout)', () => {
    expect(src).toContain('if (!a.skipCreation && !choices.skipGeneration)');
  });
  it('the probe shows a busy note while checking', () => {
    expect(src).toContain('Checking your key...');
  });
});
