/**
 * AddCharacterScreen — new character flow.
 *
 * Steps:
 *  0. Name.
 *  1. Persona blurb — LLM-facing, synthesized into the model's voice. This
 *     step commits the create + runs expansion. (The old proactiveness step
 *     was removed 260725: proactiveness is a runtime-only Minecraft mode now,
 *     never saved per character.)
 *  2. Card image (skippable).
 *  3. Skin (skippable).
 *  4. Voice (260705) — Auto (runtime picks a fitting, roster-deduped voice) or
 *     an explicit pick from the curated pool, with per-voice previews.
 *  5. Visibility — yes/no, "share with other players?"
 *  6. Description (only if visibility=yes) — human-facing copy other players
 *     will read on the World card.
 *
 * The character is persisted as SHARED=false at the end of step 1 (so the
 * moderation pipeline doesn't fire until the user actually opts in). If the
 * user picks visibility=yes and writes a description, `setShared(true)` runs
 * at the end of step 5 and any moderation failure is surfaced inline.
 *
 * Description vs persona — strictly separated. Persona is the prompt the
 * LLM reads; description is the blurb other players read. Step copy makes
 * the distinction explicit on both screens.
 */

import React, { useState, useEffect, useRef } from 'react';
import { sei } from '../lib/ipcClient';
import { uiLanguage } from '../lib/i18n';
import { useUiStore } from '../lib/stores/useUiStore';
import { useDataStore } from '../lib/stores/useDataStore';
import { useAuthStore } from '../lib/stores/useAuthStore';
import { QuestionShell } from '../components/QuestionShell';
import { TextField } from '../components/TextField';
import { FullscreenTextField } from '../components/FullscreenTextField';
import { Toggle } from '../components/Toggle';
import { InfoTip } from '../components/InfoTip';
import { PortraitImagePicker } from '../components/PortraitImagePicker';
import { SkinEditor } from '../components/SkinEditor';
import { VoicePicker } from '../components/VoicePicker';
import { Button } from '../components/Button';
import { PercentBar } from '../components/PercentBar';
import { CreationLimitModal } from '../components/CreationLimitModal';
import { KnowledgeDropZone } from '../components/KnowledgeDropZone';
import { CompactKnowledgeModal } from '../components/CompactKnowledgeModal';
import { FileTextIcon, TrashIcon } from '../components/icons';
import type { VoiceParams } from '../lib/voicePicker';
import type { Character } from '@shared/characterSchema';
import { KNOWLEDGE_COMPACT_SUGGEST_BYTES } from '@shared/ipc';

const STEPS = 7;

/** A knowledge file extracted in main, waiting for the character to exist. */
interface PendingKnowledge {
  title: string;
  content: string;
  bytes: number;
}

export function AddCharacterScreen({ importFirst = false }: { importFirst?: boolean } = {}): React.ReactElement {
  const navigate = useUiStore((s) => s.navigate);
  const addCharacter = useDataStore((s) => s.addCharacter);
  const refreshCharacter = useDataStore((s) => s.refreshCharacter);
  // Item 6 — publishing requires a signed-in account (the cloud upload +
  // moderation gate). A local (signed-out) user can only ever create a private
  // character, so we drop the Visibility + Description steps for them entirely
  // rather than letting them reach charsSetShared and hit the "Please sign in
  // and accept the Terms of Service before publishing" error.
  const signedIn = useAuthStore((s) => s.state.kind === 'signed_in');
  // Signed-in: 7 steps (name → persona → image → skin → voice → visibility →
  // description). Signed-out: 5 steps (name → persona → image → skin → voice),
  // then save private.
  const totalSteps = signedIn ? STEPS : 5;
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [personaSource, setPersonaSource] = useState('');
  // "Expand my prompt". ON by default (260725): runs the LLM expander that
  // rewrites the blurb into the four-section base personality. OFF uses the
  // blurb verbatim (skipExpansion) and the character opens in Advanced mode
  // in the editor afterwards (metadata.prompt_mode).
  const [expandPrompt, setExpandPrompt] = useState(true);
  // 260725 knowledge import: the "Import from another platform" entry runs an
  // upload phase before the usual questions. Extracted files wait here until
  // the character exists (end of step 1), then persist via knowledge:add.
  const [importPhase, setImportPhase] = useState(importFirst);
  const [pendingKnowledge, setPendingKnowledge] = useState<PendingKnowledge[]>([]);
  const [compactPromptOpen, setCompactPromptOpen] = useState(false);
  const [knowledgeStatus, setKnowledgeStatus] = useState<string | null>(null);
  const [portraitImage, setPortraitImage] = useState<string | null>(null);
  // Voice (step 5): null = Auto — leave metadata.voiceId unset so the runtime
  // assigns a deterministic, roster-deduped pick on first use. 'none' = an
  // explicit silent companion; any other string pins that pool voice.
  const [voiceId, setVoiceId] = useState<string | null>(null);
  // Voice playground (260725): pitch/calmness the user tuned. VoicePicker
  // normalizes (drops default-valued keys), so any key present here is a real
  // user change and gets persisted as metadata.voicePitch / voiceStability.
  const [voiceParams, setVoiceParams] = useState<VoiceParams>({});
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
      // Import entry: back from the first question returns to the upload
      // phase (pending files are kept) instead of leaving the wizard.
      if (importFirst) {
        setImportPhase(true);
        return;
      }
      navigate({ kind: 'home' });
      return;
    }
    // Once the character is created (end of step 1), block back-navigation past
    // the creation point — the record exists (and expansion already ran), so
    // editing happens on the character page now.
    if (created && step <= 2) return;
    setStep((s) => s - 1);
  };

  const validate = (): boolean => {
    if (submitting) return false;
    if (step === 0) return name.trim() !== '';
    if (step === 1) return personaSource.trim() !== '';
    if (step === 5) return visibility !== null;
    if (step === 6) return description.trim() !== '';
    return true; // 2, 3 & 4 always allow next (skippable / Auto default)
  };

  const persistCreate = async (): Promise<Character | null> => {
    setError(null);
    setSubmitting(true);
    // New routing key per attempt; reset the bar to 0 before the stream opens.
    const requestId = crypto.randomUUID();
    activeRequestId.current = requestId;
    setExpansion({ pct: 0, label: 'Starting' });
    const source = personaSource.trim();
    try {
      const draft: Character = {
        id: crypto.randomUUID(),
        kind: 'custom',
        public_id: null,
        name: name.trim(),
        // Toggle OFF (default): use the blurb verbatim as the persona the bot
        // reads (the bot requires a non-empty persona.expanded), saved with
        // skipExpansion so no LLM call runs. Toggle ON: leave expanded empty
        // for the expander to fill.
        persona: { source, expanded: expandPrompt ? '' : source },
        is_default: false,
        // Start PRIVATE so the moderation pipeline doesn't fire here — it
        // runs at the end of step 5 if the user opted in. setShared(true)
        // then handles the gate.
        shared: false,
        slug: null,
        // prompt_mode (260725): expand OFF means the user wrote the exact
        // prompt, so the editor opens in Advanced for this character.
        // (No proactiveness key anymore — it is a runtime-only Minecraft
        // mode since 260725, never saved per character.)
        metadata: {
          prompt_mode: expandPrompt ? 'standard' : 'advanced',
          // 260730: a character created under the Chinese UI is a Chinese
          // character: persona generation and every AI surface pin to zh.
          ...(uiLanguage() === 'zh' ? { language: 'zh' } : {}),
        },
        created: new Date().toISOString(),
        last_launched: null,
        playtime_ms: 0,
        portrait_image: portraitImage,
        skin: { source: 'none', mojang_username: null, png_sha256: null, applied_at: null },
        username: null,
        description: null,
      };
      const persisted = await sei.saveCharacter(
        draft,
        expandPrompt ? { expansionRequestId: requestId } : { skipExpansion: true },
      );
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

  /**
   * Step-1 commit: create the character, then persist any imported knowledge
   * files (and optionally LLM-compact them into one entry). Knowledge
   * failures are non-fatal — the character exists and Knowledge is editable
   * later from the character page.
   */
  const commitCreate = async (compact: boolean): Promise<void> => {
    const persisted = await persistCreate();
    if (!persisted) return;
    if (pendingKnowledge.length > 0) {
      setSubmitting(true);
      setKnowledgeStatus('Saving knowledge…');
      try {
        for (const f of pendingKnowledge) {
          await sei.knowledgeAdd(persisted.id, { title: f.title, content: f.content, source: 'upload' });
        }
        if (compact) {
          setKnowledgeStatus('Compressing knowledge…');
          await sei.knowledgeCompact(persisted.id);
        }
      } catch (err) {
        setError(`Some knowledge could not be saved: ${(err as Error).message}. You can add it later from the companion page.`);
      } finally {
        setSubmitting(false);
        setKnowledgeStatus(null);
      }
    }
    setStep(2);
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
        // runtime assignment. Playground params persist only when the user
        // actually changed them (absent = engine default).
        metadata: {
          ...latest.metadata,
          ...(voiceId ? { voiceId } : {}),
          ...(voiceParams.pitch !== undefined ? { voicePitch: voiceParams.pitch } : {}),
          ...(voiceParams.calmness !== undefined ? { voiceStability: voiceParams.calmness } : {}),
        },
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
      // Persona blurb collected — NOW commit the create + run expansion.
      // Large knowledge import → offer compaction first (the stored copies
      // only; originals on disk are never touched).
      const totalBytes = pendingKnowledge.reduce((s, f) => s + f.bytes, 0);
      if (pendingKnowledge.length > 0 && totalBytes > KNOWLEDGE_COMPACT_SUGGEST_BYTES) {
        setCompactPromptOpen(true);
        return;
      }
      await commitCreate(false);
      return;
    }
    if (step === 2) {
      await persistPortrait();
      setStep(3);
      return;
    }
    if (step === 3) {
      // Everyone continues to the voice step (260705).
      setStep(4);
      return;
    }
    if (step === 4) {
      // Voice chosen (or Auto). Signed-out users have no visibility/
      // description steps — finish here, saving the character as private.
      if (!signedIn) {
        await commitFinal();
        return;
      }
      setStep(5);
      return;
    }
    if (step === 5) {
      if (visibility === 'private') {
        // Skip description entirely — private chars have no requirement.
        await commitFinal();
        return;
      }
      setStep(6);
      return;
    }
    if (step === 6) {
      await commitFinal();
      return;
    }
  };

  const skip = async (): Promise<void> => {
    if (step === 2) {
      // Skip image — keep whatever was already there (likely null) and move on.
      setStep(3);
      return;
    }
    if (step === 3) {
      // Skip skin — continue to the voice step.
      setStep(4);
      return;
    }
  };

  // ── Import phase (260725, before step 0 when entered via the Awaken
  // "Import from another platform" tile) ────────────────────────────────────
  if (importPhase) {
    const totalKb = Math.round(pendingKnowledge.reduce((s, f) => s + f.bytes, 0) / 1024);
    return (
      <QuestionShell
        title="Bring their memories"
        hint="Upload your companion's memories and knowledge here. You can always edit this later. Please do not upload your AI prompt here."
        stepCount={totalSteps}
        currentStep={0}
        onBack={() => navigate({ kind: 'awaken' })}
        onNext={() => setImportPhase(false)}
        nextLabel="Next"
        nextDisabled={pendingKnowledge.length === 0}
        secondaryLabel="Skip"
        onSecondary={() => setImportPhase(false)}
      >
        <KnowledgeDropZone
          onExtracted={(f) =>
            setPendingKnowledge((prev) => [
              ...prev,
              { title: f.title, content: f.content, bytes: new TextEncoder().encode(f.content).length },
            ])
          }
        />
        {pendingKnowledge.length > 0 ? (
          <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {pendingKnowledge.map((f, i) => (
              <div
                key={`${f.title}-${i}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  padding: '8px 12px',
                  border: '1px solid var(--border)',
                }}
              >
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                    minWidth: 0,
                    fontSize: 14,
                  }}
                >
                  <span style={{ display: 'inline-flex', flexShrink: 0, color: 'var(--muted)' }} aria-hidden="true">
                    <FileTextIcon size={15} />
                  </span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {f.title}
                  </span>
                </span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)' }}>
                    {Math.max(1, Math.round(f.bytes / 1024))} KB
                  </span>
                  <Button
                    kind="ghost"
                    size="sm"
                    aria-label={`Remove ${f.title}`}
                    onClick={() => setPendingKnowledge((prev) => prev.filter((_, j) => j !== i))}
                  >
                    <TrashIcon size={13} />
                  </Button>
                </span>
              </div>
            ))}
            <div
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 11,
                letterSpacing: '0.04em',
                color: 'var(--muted)',
              }}
            >
              {pendingKnowledge.length} file{pendingKnowledge.length === 1 ? '' : 's'}, {Math.max(1, totalKb)} KB total
            </div>
          </div>
        ) : null}
      </QuestionShell>
    );
  }

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

  // ── Step 1 — Persona source (commits create + runs expansion) ───────────
  if (step === 1) {
    return (
      <QuestionShell
        title="Who are they?"
        hint="Describe your companion in as much detail as you like."
        stepCount={totalSteps}
        currentStep={step}
        onBack={back}
        onNext={() => void next()}
        nextLabel={submitting ? (expandPrompt ? 'Generating…' : 'Saving…') : 'Create'}
        nextKind="accent"
        nextDisabled={!validate()}
      >
        <FullscreenTextField
          value={personaSource}
          onChange={setPersonaSource}
          modalTitle="Describe your character."
          placeholder="Describe your character."
          aria-label="Persona source"
        />
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            marginTop: 16,
          }}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontWeight: 700 }}>Expand my prompt</span>
            <InfoTip
              text="Let AI build on what you wrote, keeping your details and adding structure. Off uses your text exactly as written."
              label="About Expand my prompt"
            />
          </span>
          <Toggle
            on={expandPrompt}
            onChange={setExpandPrompt}
            aria-label="Expand my prompt"
          />
        </div>
        {submitting && expandPrompt && expansion ? (
          <ExpansionProgressRow pct={expansion.pct} label={expansion.label} />
        ) : null}
        {knowledgeStatus ? (
          <div
            style={{
              marginTop: 12,
              fontFamily: 'var(--mono)',
              fontSize: 12,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              color: 'var(--muted)',
            }}
            aria-live="polite"
          >
            {knowledgeStatus}
          </div>
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
        {compactPromptOpen ? (
          <CompactKnowledgeModal
            totalKb={Math.max(1, Math.round(pendingKnowledge.reduce((s, f) => s + f.bytes, 0) / 1024))}
            onCancel={() => setCompactPromptOpen(false)}
            onKeep={() => {
              setCompactPromptOpen(false);
              void commitCreate(false);
            }}
            onCompact={() => {
              setCompactPromptOpen(false);
              void commitCreate(true);
            }}
          />
        ) : null}
      </QuestionShell>
    );
  }

  // ── Step 2 — Card image (skippable) ─────────────────────────────────────
  if (step === 2) {
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

  // ── Step 3 — Skin (skippable) ───────────────────────────────────────────
  if (step === 3) {
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

  // ── Step 4 — Voice (260705) ─────────────────────────────────────────────
  if (step === 4) {
    return (
      <QuestionShell
        title="Pick their voice?"
        hint="Auto picks one that fits their personality. Tap play to hear a sample; you can change this later."
        stepCount={totalSteps}
        currentStep={step}
        onBack={back}
        onNext={() => void next()}
        nextLabel={!signedIn ? (submitting ? 'Saving…' : 'Finish') : 'Next'}
        nextDisabled={!validate()}
      >
        <VoicePicker
          value={voiceId}
          onChange={setVoiceId}
          params={voiceParams}
          onParamsChange={setVoiceParams}
        />
        {error ? <ErrorRow message={error} /> : null}
      </QuestionShell>
    );
  }

  // ── Step 5 — Visibility (Public / Private) ──────────────────────────────
  if (step === 5) {
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

  // ── Step 6 — Description (only when public) ─────────────────────────────
  return (
    <QuestionShell
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
