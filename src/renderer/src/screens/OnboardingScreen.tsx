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
import styles from './OnboardingScreen.module.css';

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
        // Phase 18/19 — UserConfig now carries the user's chat profile picture;
        // a fresh onboard has none yet (set later in Settings).
        profile_picture: null,
        provider,
        provider_config: {},
        theme_mode: themeMode,
        linuxBasicTextWarnDismissed: false,
        // Item 4: AI backend kind. Signed-in users default to Sei's hosted
        // cloud AI ("on cloud by default after sign-in"); local-only users
        // default to BYOK ('local'). Signed-in users with no balance yet are
        // routed to Credits below to claim the trial / subscribe.
        ai_backend_kind: signedIn ? 'cloud-proxy' : 'local',
        // 260703: this is a DEFAULT, not an explicit user pick — a later
        // sign-in may re-assert the cloud default over it. Only the Settings
        // ACCOUNT MODE switch (proxy:configure) stamps 'user'.
        ai_backend_kind_source: 'default',
        dev_console_visible: false,
        // Appearance & feel: default the "Realistic typing" pacing on.
        realistic_typing: true,
        // Appearance & feel: live call captions default off (260705).
        call_captions: false,
        removed_default_ids: [],
        added_default_ids: [],
        added_world_ids: [],
        // 260703 procgen: questionnaire answers start empty; the first-sign-in
        // questionnaire (cloud users) fills these via prefs:save.
        user_profile: { companion_age_range: null, art_style: null, companion_dynamics: null, completed_at: null },
        // 260706: no relationship dynamics granted to a cast yet.
        dynamics_granted: [],
        // Sticky chat side-panel visibility: default shown.
        chat_panel_hidden: false,
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
        // Live call overlay is an opt-in feature: off until enabled in Settings.
        call_overlay_enabled: false,
        // 260706: a fresh install has no legacy local defaults or pre-party
        // state, so the one-time backfill/world migrations have nothing to do.
        // Mark them done (same reasoning as total_playtime_backfilled above) so
        // first launch skips a needless migration pass (incl. a cloud fetch).
        added_defaults_backfilled: true,
        defaults_to_world_migrated: true,
        // The one-time $1 feedback reward is unclaimed on a new account.
        feedback_reward_claimed: false,
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
        // Fresh onboarding, signed-in: the companion questionnaire runs HERE,
        // inside the onboarding ritual (260706 — it used to ambush after the
        // user had already landed on Home). mode 'missing' asks only the
        // unanswered questions, so a re-install whose cloud prefs are complete
        // skips straight through, and one whose prefs predate a newer question
        // answers just the gap. Fail-open to the activity picker — the Home
        // and Awaken gates re-ask if this read failed.
        if (signedIn) {
          try {
            const prefs = await sei.prefsGet();
            if (prefs.missing.length > 0) {
              navigate({ kind: 'profile-questions', next: 'activity-picker', mode: 'missing' });
              return;
            }
          } catch {
            /* fall through to the activity picker */
          }
        }
        // Analytics (260707): onboarding finished (fresh profile completing
        // the name/setup flow), the activation entry point.
        sei.track('onboarding_completed');
        // Ask what they want to do first. The activity picker routes to
        // skin-setup only if they choose Minecraft; choosing Chat skips
        // straight to home (and clears skin_setup_pending).
        navigate({ kind: 'activity-picker' });
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
          <div className={styles.error} role="alert">
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
        <div className={styles.error} role="alert">
          {error}
        </div>
      ) : null}
    </QuestionShell>
  );
}
