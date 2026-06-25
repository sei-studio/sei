/**
 * OnboardingScreen — setup flow.
 *
 * Steps:
 *  0. Name.
 *  1. Provider tiles.
 *  2. API key.
 *
 * The Minecraft-username step was retired from the GUI (260605); mc_username
 * stays in UserConfig/DB but is no longer collected. Onboarding completion is
 * keyed on `preferred_name` (the "Name" field) instead.
 *
 * Submit ordering: saveConfig BEFORE saveApiKey. If saveConfig fails, zero
 *    state changes (clean retry). If saveApiKey fails after saveConfig
 *    succeeded, the inline error surfaces and the user retries; saved
 *    UserConfig alone is harmless because App.tsx gates the home route on
 *    `sei.hasApiKey()`.
 *
 * isReonboard:
 *  - true → step 0 Back navigates to settings; existing UserConfig fields
 *    are pre-populated; api key field starts empty (force re-entry per
 *    UI-SPEC re-onboarding rule).
 *  - false → step 0 Back is disabled (it's the first run).
 *
 * Source: UI-SPEC §Onboarding.
 */

import React, { useEffect, useState } from 'react';
import { sei } from '../lib/ipcClient';
import { classifyRendererError } from '../lib/errors';
import { useUiStore } from '../lib/stores/useUiStore';
import { QuestionShell } from '../components/QuestionShell';
import { TextField } from '../components/TextField';
import { ProviderSelect, type Provider } from '../components/ProviderSelect';
import type { UserConfig } from '@shared/characterSchema';

export interface OnboardingScreenProps {
  isReonboard: boolean;
  /**
   * D-03: signed-in users skip the Provider tiles AND API-key steps,
   * leaving just the single Name step.
   */
  signedIn?: boolean;
}

export function OnboardingScreen({ isReonboard, signedIn = false }: OnboardingScreenProps): React.ReactElement {
  // D-03: signed-in users skip Provider tiles + API-key entry, leaving the
  // single Name step. Local users get Name → Provider → API key.
  const STEPS = signedIn ? 1 : 3;
  const navigate = useUiStore((s) => s.navigate);
  const setHomeTab = useUiStore((s) => s.setHomeTab);
  const themeMode = useUiStore((s) => s.themeMode);
  const [step, setStep] = useState(0);
  const [mc, setMc] = useState('');
  const [pref, setPref] = useState('');
  const [provider, setProvider] = useState<Provider>('anthropic');
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!isReonboard) return;
    let cancelled = false;
    sei
      .getConfig()
      .then((cfg: UserConfig) => {
        if (cancelled) return;
        setMc(cfg.mc_username ?? '');
        setPref(cfg.preferred_name ?? '');
        setProvider((cfg.provider ?? 'anthropic') as Provider);
        // apiKey deliberately NOT pre-filled — UI-SPEC re-onboarding rule.
      })
      .catch(() => {
        /* defaults already set */
      });
    return () => {
      cancelled = true;
    };
  }, [isReonboard]);

  const back = () => {
    if (step === 0) {
      // Re-onboarding (from Settings) → back to Settings. The local-only
      // first-run path (reached via AuthChoice → "Continue locally") → back
      // to the sign-in chooser so the user can pick email / Google instead.
      // Signed-in fresh onboarding keeps step 0 Back disabled (handled below).
      if (isReonboard) navigate({ kind: 'settings' });
      else if (!signedIn) navigate({ kind: 'auth-choice' });
      return;
    }
    setStep((s) => s - 1);
  };

  const next = async () => {
    if (step < STEPS - 1) {
      setStep((s) => s + 1);
      return;
    }
    // Final submit. saveConfig BEFORE saveApiKey.
    setError(null);
    setSubmitting(true);
    try {
      // ui-A1: Phase 14 widened the provider matrix; the selected tile value
      // is now persisted verbatim. UserConfigSchema's z.enum gates the value
      // at main-side parse so a malformed write can't smuggle a non-supported
      // kind through (mirror of the T-04-33 invariant the original line
      // protected).
      await sei.saveConfig({
        mc_username: mc.trim(),
        preferred_name: pref.trim(),
        provider,
        provider_config: {},
        theme_mode: themeMode,
        linuxBasicTextWarnDismissed: false,
        // Item 4: AI backend kind. Signed-in users default to Sei's hosted
        // cloud AI ("on cloud by default after sign-in"); local-only users
        // default to BYOK ('local'). Signed-in users with no balance yet are
        // routed to Credits below to claim the trial / subscribe.
        ai_backend_kind: signedIn ? 'cloud-proxy' : 'local',
        dev_console_visible: false,
        removed_default_ids: [],
        added_world_ids: [],
        // First-login marker stays false here so the Home screen shows the
        // one-time "Welcome to Sei" greeting after onboarding completes; it
        // flips true there on first render.
        has_been_welcomed: false,
        // Looking (vision): fresh installs start at 'on-demand' (your
        // companions look around when they need to, with no automatic views).
        // Settings offers 'continuous' (automatic views, more playtime) or
        // 'off' for anyone who wants to change it.
        vision_mode: 'on-demand',
        // Fresh install: no playtime accumulated yet, nothing to backfill.
        total_playtime_ms: 0,
        total_playtime_backfilled: true,
        // First-run onboarding flows into the dedicated skin-setup step next;
        // mark it pending so a relaunch mid-setup resumes there. Re-onboarding
        // from Settings skips the skin step, so leave it cleared.
        skin_setup_pending: !isReonboard,
      });
      // D-03 / T-10-04-02 mitigation: signed-in users never reach the API-key
      // step, so saveApiKey MUST be gated behind !signedIn. Otherwise a future
      // bug could land a stale apiKey state into the secret store.
      if (!signedIn) {
        await sei.saveApiKey(apiKey.trim());
      }
      // Signed-in users default to Sei's cloud backend — best-effort auto-claim
      // the one-time free trial so a fresh account starts with playtime (they
      // disliked being dropped onto the playtime/credits screen; the summon-time
      // gate covers a still-empty balance later).
      if (signedIn) {
        try {
          await sei.trialClaim();
        } catch {
          /* best-effort */
        }
      }
      if (!isReonboard) {
        // Fresh onboarding → advance to the dedicated skin-setup step. It clears
        // skin_setup_pending and lands on home (World tab) when finished/skipped.
        navigate({ kind: 'skin-setup' });
      } else {
        // Re-onboarding from Settings → straight back to home (no skin step),
        // on the Home tab (which shows the welcome message).
        if (signedIn) setHomeTab('home');
        navigate({ kind: 'home' });
      }
    } catch (err) {
      // GUI-05: surface plain-English copy from ERROR_COPY (via classifier),
      // not the raw error message. classifyRendererError uses keyword
      // heuristics on `err.message` to pick an ErrorClass, then returns
      // the matching ERROR_COPY string (or a generic fallback).
      setError(classifyRendererError(err).copy);
    } finally {
      setSubmitting(false);
    }
  };

  const validate = (): boolean => {
    if (step === 0) return pref.trim() !== '' && !(signedIn && submitting);
    if (step === 1) return true;
    if (step === 2) return apiKey.trim() !== '' && !submitting;
    return false;
  };

  // ── Step 0 — Name ───────────────────────────────────────────────────────
  if (step === 0) {
    // For signedIn, this is the only/final step — show Finish + accent CTA.
    return (
      <QuestionShell
        title="What should they call you?"
        stepCount={STEPS}
        currentStep={step}
        onBack={isReonboard || !signedIn ? back : undefined}
        backDisabled={signedIn && !isReonboard}
        onNext={next}
        nextLabel={signedIn ? 'Finish' : undefined}
        nextKind={signedIn ? 'accent' : undefined}
        nextDisabled={!validate()}
      >
        <TextField
          value={pref}
          onChange={setPref}
          autoFocus
          onEnter={next}
          aria-label="Name"
        />
        {signedIn && error ? (
          <div
            style={{
              marginTop: 12,
              color: 'var(--red)',
              fontFamily: 'var(--mono)',
              fontSize: 13,
            }}
          >
            {error}
          </div>
        ) : null}
      </QuestionShell>
    );
  }

  // ── Step 1 — Provider tiles ─────────────────────────────────────────────
  if (step === 1) {
    return (
      <QuestionShell
        title="Which model provider?"
        stepCount={STEPS}
        currentStep={step}
        onBack={back}
        onNext={next}
      >
        <ProviderSelect value={provider} onChange={setProvider} />
      </QuestionShell>
    );
  }

  // ── Step 2 — API key ────────────────────────────────────────────────────
  // ui-A1: dynamic provider label — title shifts with the selected tile so
  // a user who picked Mistral on step 1 reads "Paste your Mistral API key."
  // not the legacy "Local" fallback.
  const PROVIDER_LABELS: Record<Provider, string> = {
    anthropic: 'Anthropic',
    openai: 'OpenAI',
    gemini: 'Gemini',
    ollama: 'Ollama',
    grok: 'Grok',
    openrouter: 'OpenRouter',
    deepseek: 'DeepSeek',
    mistral: 'Mistral',
    together: 'Together',
    groq: 'Groq',
    fireworks: 'Fireworks',
    cerebras: 'Cerebras',
    perplexity: 'Perplexity',
  };
  const providerLabel = PROVIDER_LABELS[provider] ?? 'API';
  return (
    <QuestionShell
      title={`Paste your ${providerLabel} API key.`}
      stepCount={STEPS}
      currentStep={step}
      onBack={back}
      onNext={next}
      nextLabel="Finish"
      nextKind="accent"
      nextDisabled={!validate()}
    >
      <TextField
        value={apiKey}
        onChange={(v) => {
          setApiKey(v);
          setError(null);
        }}
        type="password"
        monospace
        placeholder="sk-ant-..."
        autoFocus
        onEnter={() => {
          if (validate()) void next();
        }}
        aria-label="API key"
        aria-invalid={!!error}
      />
      {error ? (
        <div
          style={{
            marginTop: 12,
            color: 'var(--red)',
            fontFamily: 'var(--mono)',
            fontSize: 13,
          }}
        >
          {error}
        </div>
      ) : null}
    </QuestionShell>
  );
}
