/**
 * OnboardingScreen — setup flow.
 *
 * Steps:
 *  0. Name.
 *  1. Provider tiles.
 *  2. API key.
 *
 * Fresh-onboard completion (260728): Sui is seeded into a party slot
 * (fire-and-forget chars:add-to-library — removable any time), and a
 * brand-new signed-in profile continues from the questionnaire into the
 * unique-companion flow ('first-fill' → gender question → casting) so the
 * ritual ends on a first companion, not an empty Home.
 *
 * The conversation-language step was removed (260725): the language is now
 * auto-detected from the player's voice (ElevenLabs Scribe STT → main's
 * voice/languageAutoSwitch.ts persists UserConfig.chat_language). Onboarding
 * no longer writes chat_language at all; saveConfigFromRenderer preserves
 * whatever is on disk.
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
import { DEFAULT_CHARACTER_UUIDS } from '@shared/defaultCharacters';
import { useDataStore } from '../lib/stores/useDataStore';
import { useLibraryStateStore } from '../lib/stores/useLibraryStateStore';
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
  // D-03: signed-in users skip Provider tiles + API-key entry, leaving just
  // the Name step. Local users get Name → Provider → API key.
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
        // chat_language is deliberately absent (260725): it is auto-detected
        // from voice in main, and saveConfigFromRenderer keeps the on-disk
        // value regardless of what a renderer save carries.
        // Phase 18/19 — UserConfig now carries the user's chat profile picture;
        // a fresh onboard has none yet (set later in Settings).
        profile_picture: null,
        // 260724: no custom app background on a fresh onboard (set in Settings).
        background_image: null,
        provider,
        provider_config: {},
        theme_mode: themeMode,
        linuxBasicTextWarnDismissed: false,
        // Item 4: AI backend kind. Signed-in users default to Sei's hosted
        // cloud AI ("on cloud by default after sign-in"); local-only users
        // default to BYOK ('local'). Signed-in users with no balance yet are
        // start on the free tier and can subscribe later from the plan screen.
        ai_backend_kind: signedIn ? 'cloud-proxy' : 'local',
        // 260703: this is a DEFAULT, not an explicit user pick — a later
        // sign-in may re-assert the cloud default over it. Only the Settings
        // ACCOUNT MODE switch (proxy:configure) stamps 'user'.
        ai_backend_kind_source: 'default',
        dev_console_visible: false,
        // A fresh onboard tracks the stable update channel (advanced updates
        // are opt-in from Settings).
        advanced_updates: false,
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
        // Conversation starters (quiet calls): on by default.
        call_convo_starters: true,
        // 260706: a fresh install has no legacy local defaults or pre-party
        // state, so the one-time backfill/world migrations have nothing to do.
        // Mark them done (same reasoning as total_playtime_backfilled above) so
        // first launch skips a needless migration pass (incl. a cloud fetch).
        added_defaults_backfilled: true,
        defaults_to_world_migrated: true,
        // The one-time feedback reward is unclaimed on a new account.
        feedback_reward_claimed: false,
        // Game setup moved out of onboarding (260725): skin setup now runs
        // the first time the Minecraft surface is opened (gameLaunch.ts), so
        // onboarding never arms the resume gate.
        skin_setup_pending: false,
      });
      // D-03 / T-10-04-02 mitigation: signed-in users never reach the API-key
      // step, so saveApiKey MUST be gated behind !signedIn. Otherwise a future
      // bug could land a stale apiKey state into the secret store.
      if (!signedIn) {
        await sei.saveApiKey(apiKey.trim());
      }
      // 260724: nothing to claim on sign-up. Every account starts on the free
      // tier with a weekly allowance already available, so onboarding goes
      // straight on instead of detouring through a claim step.
      if (!isReonboard) {
        // 260728: every fresh profile starts with Sui in one of the four party
        // slots (removable any time — she is an ordinary World invite, so the
        // character page offers Release). Fire-and-forget: chars:add-to-library
        // pulls her cloud row + art and writes added_world_ids, then the data +
        // library stores refresh so Home/IconRail show her the moment the user
        // lands there. Offline or fetch failure just means no Sui — never a
        // blocked onboarding.
        void sei
          .charsAddToLibrary(DEFAULT_CHARACTER_UUIDS.sui)
          .then(async () => {
            await useDataStore.getState().loadCharacters();
            await useLibraryStateStore.getState().refresh();
          })
          .catch(() => {
            /* best-effort seed */
          });
        // Fresh onboarding, signed-in: the companion questionnaire runs HERE,
        // inside the onboarding ritual (260706 — it used to ambush after the
        // user had already landed on Home). 260728: a BRAND-NEW profile (no
        // completed questionnaire at all) runs it as 'first-fill', which
        // continues past Finish into the unique-companion flow — the gender
        // question, then the casting screen — so onboarding lands the user on
        // their first companion instead of an empty Home. A profile that
        // already completed but is missing a newer question stays a 'missing'
        // top-up that returns to Home (mirrors App.tsx's Home gate). Fail-open
        // to home — the Home and Awaken gates re-ask if this read failed.
        if (signedIn) {
          try {
            const prefs = await sei.prefsGet();
            if (prefs.missing.length > 0) {
              const firstFill = !prefs.profile?.completed_at;
              navigate({
                kind: 'profile-questions',
                next: 'home',
                mode: firstFill ? 'first-fill' : 'missing',
              });
              return;
            }
          } catch {
            /* fall through to home */
          }
        }
        // Analytics (260707): onboarding finished (fresh profile completing
        // the name/setup flow), the activation entry point.
        sei.track('onboarding_completed');
        // Straight to home. Per-game setup (Minecraft skins) now runs the
        // first time that game is opened from the Play together tiles.
        setHomeTab('home');
        navigate({ kind: 'home' });
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
    // Name step: for signedIn it is also the final submit — block re-submits
    // while it is in flight.
    if (step === 0) return pref.trim() !== '' && !(signedIn && submitting);
    if (step === 1) return true;
    if (step === 2) return apiKey.trim() !== '' && !submitting;
    return false;
  };

  // ── Step 0 — Name ───────────────────────────────────────────────────────
  // For signedIn this is the ONLY step — show Finish + accent CTA and the
  // inline submit error here.
  if (step === 0) {
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
          onEnter={() => {
            if (validate()) void next();
          }}
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
