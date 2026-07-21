/**
 * AddCharacterScreen — new character flow.
 *
 * Steps:
 *  0. Name.
 *  1. Persona blurb — LLM-facing, synthesized into the model's voice.
 *  2. Proactiveness — Passive / Reactive / Agentic. Chosen BEFORE expansion so
 *     the level feeds the expander as a tier hint (and seeds metadata for the
 *     runtime dial). This step commits the create + runs expansion.
 *  3. Card image (skippable).
 *  4. Skin (skippable).
 *  5. Voice (260705) — Auto (runtime picks a fitting, roster-deduped voice) or
 *     an explicit pick from the curated pool, with per-voice previews.
 *  6. Visibility — yes/no, "share with other players?"
 *  7. Description (only if visibility=yes) — human-facing copy other players
 *     will read on the World card.
 *
 * The character is persisted as SHARED=false at the end of step 2 (so the
 * moderation pipeline doesn't fire until the user actually opts in). If the
 * user picks visibility=yes and writes a description, `setShared(true)` runs
 * at the end of step 6 and any moderation failure is surfaced inline.
 *
 * Description vs persona — strictly separated. Persona is the prompt the
 * LLM reads; description is the blurb other players read. Step copy makes
 * the distinction explicit on both screens.
 */

import React, { useState, useEffect, useRef } from 'react';
import { sei } from '../lib/ipcClient';
import { useUiStore } from '../lib/stores/useUiStore';
import { useDataStore } from '../lib/stores/useDataStore';
import { useAuthStore } from '../lib/stores/useAuthStore';
import { QuestionShell } from '../components/QuestionShell';
import { TextField } from '../components/TextField';
import { PortraitImagePicker } from '../components/PortraitImagePicker';
import { SkinEditor } from '../components/SkinEditor';
import { VoicePicker } from '../components/VoicePicker';
import { Button } from '../components/Button';
import { PercentBar } from '../components/PercentBar';
import { CreationLimitModal } from '../components/CreationLimitModal';
import { PROACTIVENESS_LEVELS, PROACTIVENESS_DEFAULT } from '../lib/proactiveness';
import type { Character } from '@shared/characterSchema';

const STEPS = 8;

export function AddCharacterScreen(): React.ReactElement {
  const navigate = useUiStore((s) => s.navigate);
  const addCharacter = useDataStore((s) => s.addCharacter);
  const refreshCharacter = useDataStore((s) => s.refreshCharacter);
  // Item 6 — publishing requires a signed-in account (the cloud upload +
  // moderation gate). A local (signed-out) user can only ever create a private
  // character, so we drop the Visibility + Description steps for them entirely
  // rather than letting them reach charsSetShared and hit the "Please sign in
  // and accept the Terms of Service before publishing" error.
  const signedIn = useAuthStore((s) => s.state.kind === 'signed_in');
  // Signed-in: 8 steps (name → persona → proactiveness → image → skin → voice
  // → visibility → description). Signed-out: 6 steps (name → persona →
  // proactiveness → image → skin → voice), then save private.
  const totalSteps = signedIn ? STEPS : 6;
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [personaSource, setPersonaSource] = useState('');
  // Proactiveness tier (0 Passive / 1 Reactive / 2 Agentic). Chosen on step 2,
  // BEFORE expansion, so it feeds the expander as a tier hint and seeds the
  // runtime dial. Defaults to Reactive.
  const [proactiveness, setProactiveness] = useState<number>(PROACTIVENESS_DEFAULT);
  const [portraitImage, setPortraitImage] = useState<string | null>(null);
  // Voice (step 5): null = Auto — leave metadata.voiceId unset so the runtime
  // assigns a deterministic, roster-deduped pick on first use. 'none' = an
  // explicit silent companion; any other string pins that pool voice.
  const [voiceId, setVoiceId] = useState<string | null>(null);
  const [visibility, setVisibility] = useState<'public' | 'private' | null>(null);
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<Character | null>(null);
  // Daily-cap hit mid-flow (rare race past the pre-flight gate in
  // CharactersScreen) — surfaces the same CreationLimitModal.
  const [limitHit, setLimitHit] = useState(false);
  // Streaming persona-expansion progress (step 1). `activeRequestId` gates
  // incoming ticks to THIS screen's in-flight save so a stale or unrelated
  // event can't move the bar. Subscribed once on mount.
  const [expansion, setExpansion] = useState<{ pct: number; label: string } | null>(null);
  const activeRequestId = useRef<string | null>(null);

  useEffect(() => {
    const off = sei.onExpansionProgress((ev) => {
      if (ev.requestId !== activeRequestId.current) return;
      setExpansion({ pct: Math.round(ev.fraction * 100), label: ev.section });
    });
    return off;
  }, []);

  const back = (): void => {
    if (step === 0) {
      navigate({ kind: 'home' });
      return;
    }
    // Once the character is created (end of step 2), block back-navigation past
    // the creation point — the record exists (and expansion already ran with
    // the chosen proactiveness), so editing happens on the character page now.
    if (created && step <= 3) return;
    setStep((s) => s - 1);
  };

  const validate = (): boolean => {
    if (submitting) return false;
    if (step === 0) return name.trim() !== '';
    if (step === 1) return personaSource.trim() !== '';
    if (step === 2) return true; // proactiveness always has a value (default 1)
    if (step === 6) return visibility !== null;
    if (step === 7) return description.trim() !== '';
    return true; // 3, 4 & 5 always allow next (skippable / Auto default)
  };

  const persistCreate = async (): Promise<Character | null> => {
    setError(null);
    setSubmitting(true);
    // New routing key per attempt; reset the bar to 0 before the stream opens.
    const requestId = crypto.randomUUID();
    activeRequestId.current = requestId;
    setExpansion({ pct: 0, label: 'Starting' });
    try {
      const draft: Character = {
        id: crypto.randomUUID(),
        kind: 'custom',
        public_id: null,
        name: name.trim(),
        persona: { source: personaSource.trim(), expanded: '' },
        is_default: false,
        // Start PRIVATE so the moderation pipeline doesn't fire here — it
        // runs at the end of step 5 if the user opted in. setShared(true)
        // then handles the gate.
        shared: false,
        slug: null,
        // Seed the proactiveness dial from the step-2 choice. characterStore
        // reads this off metadata to (a) pass the tier hint into the expander
        // and (b) drive the runtime directive + idle cadence.
        metadata: { proactiveness },
        created: new Date().toISOString(),
        last_launched: null,
        playtime_ms: 0,
        portrait_image: portraitImage,
        skin: { source: 'none', mojang_username: null, png_sha256: null, applied_at: null },
        username: null,
        description: null,
      };
      const persisted = await sei.saveCharacter(draft, { expansionRequestId: requestId });
      addCharacter(persisted);
      setCreated(persisted);
      return persisted;
    } catch (err) {
      const message = (err as Error).message;
      // Daily cap hit mid-flow (rare race past the pre-flight gate) — show the
      // same friendly modal instead of the raw sentinel error string.
      if (message.includes('daily_limit_reached')) {
        setLimitHit(true);
      } else {
        setError(message);
      }
      return null;
    } finally {
      setSubmitting(false);
      activeRequestId.current = null;
      setExpansion(null);
    }
  };

  const persistPortrait = async (): Promise<void> => {
    if (!created) return;
    if (created.portrait_image === portraitImage) return;
    try {
      await refreshCharacter(created.id);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const finish = (id: string): void => {
    navigate({ kind: 'character', id });
  };

  /**
   * Final step commit:
   *   - Visibility = private → save the (empty / typed) description and
   *     navigate. No moderation.
   *   - Visibility = public  → save description, then setShared(true).
   *     On moderation failure, stay on the description step and surface the
   *     friendly message — the character is already saved locally as
   *     shared=false, so the user can edit + retry without losing work.
   *
   * The `created` snapshot we hold in component state is from step 1 — it
   * does NOT carry the portrait_image / skin updates that happened in steps
   * 2 and 3 (each of which writes to disk via its own IPC). Pull the latest
   * character from the main process before saving, otherwise we'd spread
   * stale fields back onto disk and reset skin.source to 'none' / clear
   * portrait_image, which kills the skin server (404 on /skins/Name.png)
   * and the on-card portrait rendering.
   */
  const commitFinal = async (): Promise<void> => {
    if (!created) return;
    setSubmitting(true);
    setError(null);
    try {
      const desc = description.trim() === '' ? null : description.trim();
      const latest = (await sei.getCharacter(created.id)) ?? created;
      const next: Character = {
        ...latest,
        description: desc,
        // Voice (step 5): an explicit pick pins metadata.voiceId ('none' =
        // silent companion); Auto leaves it unset for the deterministic
        // runtime assignment.
        metadata: { ...latest.metadata, ...(voiceId ? { voiceId } : {}) },
      };
      const saved = await sei.saveCharacter(next, { skipExpansion: true });
      if (visibility === 'public') {
        await sei.charsSetShared({ id: saved.id, shared: true });
      }
      await refreshCharacter(saved.id);
      finish(saved.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const next = async (): Promise<void> => {
    if (step === 0) {
      setStep(1);
      return;
    }
    if (step === 1) {
      // Persona blurb collected — go pick proactiveness (no create yet).
      setStep(2);
      return;
    }
    if (step === 2) {
      // Proactiveness chosen — NOW commit the create + run expansion (the
      // chosen tier is in the draft's metadata, so it reaches the expander).
      const persisted = await persistCreate();
      if (persisted) setStep(3);
      return;
    }
    if (step === 3) {
      await persistPortrait();
      setStep(4);
      return;
    }
    if (step === 4) {
      // Everyone continues to the voice step (260705).
      setStep(5);
      return;
    }
    if (step === 5) {
      // Voice chosen (or Auto). Signed-out users have no visibility/
      // description steps — finish here, saving the character as private.
      if (!signedIn) {
        await commitFinal();
        return;
      }
      setStep(6);
      return;
    }
    if (step === 6) {
      if (visibility === 'private') {
        // Skip description entirely — private chars have no requirement.
        await commitFinal();
        return;
      }
      setStep(7);
      return;
    }
    if (step === 7) {
      await commitFinal();
      return;
    }
  };

  const skip = async (): Promise<void> => {
    if (step === 3) {
      // Skip image — keep whatever was already there (likely null) and move on.
      setStep(4);
      return;
    }
    if (step === 4) {
      // Skip skin — continue to the voice step.
      setStep(5);
      return;
    }
  };

  // ── Step 0 — Name ───────────────────────────────────────────────────────
  if (step === 0) {
    return (
      <QuestionShell
        title="What is your companion's name?"
        stepCount={totalSteps}
        currentStep={step}
        onBack={back}
        onNext={() => void next()}
        nextDisabled={!validate()}
      >
        <TextField
          value={name}
          onChange={setName}
          autoFocus
          onEnter={() => void next()}
          aria-label="Companion name"
        />
      </QuestionShell>
    );
  }

  // ── Step 1 — Persona source ─────────────────────────────────────────────
  if (step === 1) {
    return (
      <QuestionShell
        eyebrow="For the AI: shapes the companion's voice"
        title="Who are they?"
        hint="Describe them in detail; an LLM synthesizes this into your companion's soul. Cover personality, occupation, age, gender, and quirks."
        stepCount={totalSteps}
        currentStep={step}
        onBack={back}
        onNext={() => void next()}
        nextLabel="Next"
        nextDisabled={!validate()}
      >
        <TextField
          value={personaSource}
          onChange={setPersonaSource}
          multiline
          rows={5}
          aria-label="Persona source"
        />
      </QuestionShell>
    );
  }

  // ── Step 2 — Proactiveness (commits create + runs expansion) ────────────
  if (step === 2) {
    return (
      <QuestionShell
        eyebrow="How they behave in your world"
        title="How proactive are they?"
        hint="Sets how much the companion does on its own. You can change this later on the companion page."
        stepCount={totalSteps}
        currentStep={step}
        onBack={back}
        onNext={() => void next()}
        nextLabel={submitting ? 'Generating…' : 'Create'}
        nextKind="accent"
        nextDisabled={!validate()}
      >
        <div
          role="radiogroup"
          aria-label="Proactiveness level"
          style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
        >
          {PROACTIVENESS_LEVELS.map((lvl) => {
            const selected = proactiveness === lvl.value;
            return (
              <button
                key={lvl.value}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={submitting}
                onClick={() => setProactiveness(lvl.value)}
                style={{
                  textAlign: 'left',
                  padding: '14px 16px',
                  borderRadius: 10,
                  border: `1.5px solid ${selected ? 'var(--accent)' : 'var(--border)'}`,
                  background: selected ? 'var(--accent-soft)' : 'transparent',
                  color: 'var(--text)',
                  cursor: submitting ? 'default' : 'pointer',
                  font: 'inherit',
                }}
              >
                <div style={{ fontWeight: 700, marginBottom: 4 }}>{lvl.label}</div>
                <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.4 }}>
                  {lvl.blurb}
                </div>
              </button>
            );
          })}
        </div>
        {submitting && expansion ? (
          <ExpansionProgressRow pct={expansion.pct} label={expansion.label} />
        ) : null}
        {error ? <ErrorRow message={error} /> : null}
        {limitHit ? (
          <CreationLimitModal
            onClose={() => {
              setLimitHit(false);
              navigate({ kind: 'home' });
            }}
          />
        ) : null}
      </QuestionShell>
    );
  }

  // ── Step 3 — Card image (skippable) ─────────────────────────────────────
  if (step === 3) {
    return (
      <QuestionShell
        title="Add a card image?"
        hint="Optional. Shown on the companion card on Home."
        stepCount={totalSteps}
        currentStep={step}
        onBack={back}
        onNext={() => void next()}
        nextLabel="Next"
        nextDisabled={!validate()}
        secondaryLabel="Skip"
        onSecondary={() => void skip()}
      >
        {created ? (
          <PortraitImagePicker
            characterId={created.id}
            value={portraitImage}
            onChange={setPortraitImage}
          />
        ) : null}
        {error ? <ErrorRow message={error} /> : null}
      </QuestionShell>
    );
  }

  // ── Step 4 — Skin (skippable) ───────────────────────────────────────────
  if (step === 4) {
    return (
      <QuestionShell
        title="Select a Minecraft skin"
        hint="Optional. Search a Minecraft username or upload a PNG. You can change this later."
        stepCount={totalSteps}
        currentStep={step}
        wide
        onBack={back}
        onNext={() => void next()}
        nextLabel="Next"
        secondaryLabel="Skip"
        onSecondary={() => void skip()}
      >
        {created ? (
          <SkinEditor
            character={created}
            onChanged={() => {
              if (created) void refreshCharacter(created.id);
            }}
          />
        ) : null}
      </QuestionShell>
    );
  }

  // ── Step 5 — Voice (260705) ─────────────────────────────────────────────
  if (step === 5) {
    return (
      <QuestionShell
        eyebrow="How they sound on voice calls"
        title="Pick their voice?"
        hint="Auto picks one that fits their personality. Tap play to hear a sample; you can change this later."
        stepCount={totalSteps}
        currentStep={step}
        onBack={back}
        onNext={() => void next()}
        nextLabel={!signedIn ? (submitting ? 'Saving…' : 'Finish') : 'Next'}
        nextDisabled={!validate()}
      >
        <VoicePicker value={voiceId} onChange={setVoiceId} />
        {error ? <ErrorRow message={error} /> : null}
      </QuestionShell>
    );
  }

  // ── Step 6 — Visibility (Public / Private) ──────────────────────────────
  if (step === 6) {
    return (
      <QuestionShell
        title="Visible to other players?"
        hint="Public companions appear in the World tab and anyone can connect them. Private stays only in your party."
        stepCount={totalSteps}
        currentStep={step}
        onBack={back}
        onNext={() => void next()}
        nextLabel={submitting ? 'Saving…' : visibility === 'private' ? 'Finish' : 'Next'}
        nextKind={visibility === 'public' ? 'accent' : 'primary'}
        nextDisabled={!validate()}
      >
        <div style={{ display: 'flex', gap: 12 }}>
          <Button
            kind={visibility === 'public' ? 'accent' : 'ghost'}
            size="lg"
            onClick={() => setVisibility('public')}
          >
            Yes, share with other players
          </Button>
          <Button
            kind={visibility === 'private' ? 'primary' : 'ghost'}
            size="lg"
            onClick={() => setVisibility('private')}
          >
            No, keep private
          </Button>
        </div>
        {error ? <ErrorRow message={error} /> : null}
      </QuestionShell>
    );
  }

  // ── Step 7 — Description (only when public) ─────────────────────────────
  return (
    <QuestionShell
      eyebrow="For other players, NOT for the AI"
      title="Short description for your companion?"
      hint="A blurb other players read on the World card. The AI never sees this; it's just for humans browsing."
      stepCount={totalSteps}
      currentStep={step}
      onBack={back}
      onNext={() => void next()}
      nextLabel={submitting ? 'Publishing…' : 'Done'}
      nextKind="accent"
      nextDisabled={!validate()}
    >
      <TextField
        value={description}
        onChange={setDescription}
        multiline
        rows={4}
        aria-label="Public description"
      />
      {error ? <ErrorRow message={error} /> : null}
    </QuestionShell>
  );
}

/**
 * Live progress for the streaming persona expansion. The model writes six
 * sections in order; `label` names the one currently being written and `pct`
 * tracks the streamed fraction. JetBrains-Mono caption above a slim PercentBar,
 * matching the design system's label register.
 */
function ExpansionProgressRow({ pct, label }: { pct: number; label: string }): React.ReactElement {
  return (
    <div style={{ marginTop: 16 }} aria-live="polite">
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          marginBottom: 8,
          fontFamily: 'var(--mono)',
          fontSize: 12,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          color: 'var(--muted)',
        }}
      >
        <span>Summoning persona: {label}</span>
        <span>{pct}%</span>
      </div>
      <PercentBar value={pct} size="sm" label={`Expanding persona: ${label}, ${pct} percent`} />
    </div>
  );
}

function ErrorRow({ message }: { message: string }): React.ReactElement {
  return (
    <div
      style={{
        marginTop: 12,
        color: 'var(--red)',
        fontFamily: 'var(--mono)',
        fontSize: 13,
      }}
    >
      {message}
    </div>
  );
}
