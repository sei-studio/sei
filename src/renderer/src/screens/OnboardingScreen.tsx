/**
 * OnboardingScreen — 5-step setup flow.
 *
 * Steps (per UI-SPEC §OnboardingScreen + D-37..D-42):
 *  0. Welcome to <SeiPixelMark/>.
 *  1. Minecraft username.
 *  2. Preferred name.
 *  3. Provider tiles.
 *  4. API key.
 *
 * Submit ordering (WARNING-7 fix — see <changes_made> in PLAN):
 *    saveConfig BEFORE saveApiKey. If saveConfig fails, zero state changes
 *    (clean retry). If saveApiKey fails after saveConfig succeeded, the
 *    inline error surfaces and the user retries; saved UserConfig alone is
 *    harmless because App.tsx gates the home route on `sei.hasApiKey()`.
 *
 * isReonboard:
 *  - true → step 0 Back navigates to settings; existing UserConfig fields
 *    are pre-populated; api key field starts empty (force re-entry per
 *    UI-SPEC re-onboarding rule).
 *  - false → step 0 Back is disabled (it's the first run).
 *
 * Source: 04-07 Task 2; UI-SPEC §Onboarding.
 */

import React, { useEffect, useState } from 'react';
import { sei } from '../lib/ipcClient';
import { classifyRendererError } from '../lib/errors';
import { useUiStore } from '../lib/stores/useUiStore';
import { QuestionShell } from '../components/QuestionShell';
import { TextField } from '../components/TextField';
import { ProviderTiles, type Provider } from '../components/ProviderTiles';
import { SeiPixelMark } from '../components/SeiPixelMark';
import type { UserConfig } from '@shared/characterSchema';

export interface OnboardingScreenProps {
  isReonboard: boolean;
}

const STEPS = 5;

export function OnboardingScreen({ isReonboard }: OnboardingScreenProps): React.ReactElement {
  const navigate = useUiStore((s) => s.navigate);
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
      if (isReonboard) navigate({ kind: 'settings' });
      return;
    }
    setStep((s) => s - 1);
  };

  const next = async () => {
    if (step < STEPS - 1) {
      setStep((s) => s + 1);
      return;
    }
    // Final submit (step 4). saveConfig BEFORE saveApiKey (WARNING-7 fix).
    setError(null);
    setSubmitting(true);
    try {
      // T-04-33 mitigation: only 'anthropic' is valid in UserConfigSchema today
      // (D-26). Disabled tiles can't change `provider` from the default; this
      // narrowing makes the type contract explicit and prevents a future
      // refactor from sending an invalid enum value to the Zod-validated main.
      await sei.saveConfig({
        mc_username: mc.trim(),
        preferred_name: pref.trim(),
        provider: 'anthropic',
        theme_mode: themeMode,
      });
      await sei.saveApiKey(apiKey.trim());
      navigate({ kind: 'home' });
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
    if (step === 0) return true;
    if (step === 1) return mc.trim() !== '';
    if (step === 2) return pref.trim() !== '';
    if (step === 3) return true;
    if (step === 4) return apiKey.trim() !== '' && !submitting;
    return false;
  };

  // ── Step 0 — Welcome ────────────────────────────────────────────────────
  if (step === 0) {
    return (
      <QuestionShell
        title={
          <>
            Welcome to <SeiPixelMark height={22} />.
          </>
        }
        stepCount={STEPS}
        currentStep={step}
        onBack={isReonboard ? back : undefined}
        backDisabled={!isReonboard}
        onNext={next}
        nextLabel="Begin"
        nextKind="accent"
      >
        <span />
      </QuestionShell>
    );
  }

  // ── Step 1 — Minecraft username ─────────────────────────────────────────
  if (step === 1) {
    return (
      <QuestionShell
        title="What's your Minecraft username?"
        stepCount={STEPS}
        currentStep={step}
        onBack={back}
        onNext={next}
        nextDisabled={!validate()}
      >
        <TextField
          value={mc}
          onChange={setMc}
          monospace
          autoFocus
          onEnter={next}
          aria-label="Minecraft username"
        />
      </QuestionShell>
    );
  }

  // ── Step 2 — Preferred name ─────────────────────────────────────────────
  if (step === 2) {
    return (
      <QuestionShell
        title="What should they call you?"
        stepCount={STEPS}
        currentStep={step}
        onBack={back}
        onNext={next}
        nextDisabled={!validate()}
      >
        <TextField
          value={pref}
          onChange={setPref}
          autoFocus
          onEnter={next}
          aria-label="Preferred name"
        />
      </QuestionShell>
    );
  }

  // ── Step 3 — Provider tiles ─────────────────────────────────────────────
  if (step === 3) {
    return (
      <QuestionShell
        title="Which model provider?"
        stepCount={STEPS}
        currentStep={step}
        onBack={back}
        onNext={next}
      >
        <ProviderTiles value={provider} onChange={setProvider} />
      </QuestionShell>
    );
  }

  // ── Step 4 — API key ────────────────────────────────────────────────────
  const providerLabel = provider === 'anthropic' ? 'Anthropic' : 'Local';
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
