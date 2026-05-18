/**
 * AddCharacterScreen — 2-step new character flow (260516-0yw).
 *
 * Steps:
 *  0. Name (sans).
 *  1. Persona source — eyebrow "Shown to the model after expansion",
 *     short blurb (4 rows). Save triggers the main-process LLM expansion
 *     (typical 3–8s); the renderer shows a "Generating persona…" status
 *     and only navigates after the call resolves.
 *
 * On Create:
 *  - Compute id via slugify(name, existingIds) — collision-safe -2/-3 suffix.
 *  - Build Character JSON with persona { source, expanded:'' }. Main
 *    runs the expansion in expandAndSaveCharacter and returns the
 *    persisted Character (with persona.expanded populated).
 *  - addCharacter(persisted) to local store; navigate to CharacterPage.
 *
 * Source: 04-07 Task 3; 260516-0yw plan §Task 3.
 */

import React, { useState } from 'react';
import { sei } from '../lib/ipcClient';
import { useUiStore } from '../lib/stores/useUiStore';
import { useDataStore } from '../lib/stores/useDataStore';
import { QuestionShell } from '../components/QuestionShell';
import { TextField } from '../components/TextField';
import { slugify } from '../lib/slug';
import type { Character } from '@shared/characterSchema';

const STEPS = 2;

export function AddCharacterScreen(): React.ReactElement {
  const navigate = useUiStore((s) => s.navigate);
  const characters = useDataStore((s) => s.characters);
  const addCharacter = useDataStore((s) => s.addCharacter);
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [personaSource, setPersonaSource] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const back = () => {
    if (step === 0) {
      navigate({ kind: 'home' });
      return;
    }
    setStep((s) => s - 1);
  };

  const validate = (): boolean => {
    if (step === 0) return name.trim() !== '';
    if (step === 1) return personaSource.trim() !== '' && !submitting;
    return false;
  };

  const next = async () => {
    if (step < STEPS - 1) {
      setStep((s) => s + 1);
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const existingIds = characters.map((c) => c.id);
      const id = slugify(name.trim(), existingIds);
      const draft: Character = {
        id,
        name: name.trim(),
        persona: {
          source: personaSource.trim(),
          expanded: '',
        },
        is_default: false,
        created: new Date().toISOString(),
        last_launched: null,
        playtime_ms: 0,
        portrait_image: null,
        // Phase 9 (09-01): user-created personas start with no skin and no
        // override username (bot.username falls back to sanitized persona name
        // via src/bot/index.js:270-280 until Plan 02 wires the override).
        skin: { source: 'none', mojang_username: null, png_sha256: null, applied_at: null },
        username: null,
      };
      // 260516-0yw: sei.saveCharacter now returns the persisted Character
      // (with persona.expanded populated by the main-process LLM call).
      // Insert the returned object — not the draft — so the local store
      // mirrors what's actually on disk.
      const persisted = await sei.saveCharacter(draft);
      addCharacter(persisted);
      navigate({ kind: 'character', id: persisted.id });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  // ── Step 0 — Name ───────────────────────────────────────────────────────
  if (step === 0) {
    return (
      <QuestionShell
        title="Name your character."
        stepCount={STEPS}
        currentStep={step}
        onBack={back}
        onNext={next}
        nextDisabled={!validate()}
      >
        <TextField
          value={name}
          onChange={setName}
          autoFocus
          onEnter={next}
          aria-label="Character name"
        />
      </QuestionShell>
    );
  }

  // ── Step 1 — Persona source ─────────────────────────────────────────────
  return (
    <QuestionShell
      eyebrow="Shown to the model after expansion"
      title="Write a short persona blurb."
      hint="A short description of who this character is. The model expands this into the full prompt when you save."
      stepCount={STEPS}
      currentStep={step}
      onBack={back}
      onNext={next}
      nextLabel={submitting ? 'Generating…' : 'Create'}
      nextKind="accent"
      nextDisabled={!validate()}
    >
      <TextField
        value={personaSource}
        onChange={setPersonaSource}
        multiline
        rows={4}
        aria-label="Persona source"
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
