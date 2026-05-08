/**
 * AddCharacterScreen — 3-step new character flow.
 *
 * Steps (per UI-SPEC §AddCharacterScreen + D-46..D-48):
 *  0. Name (sans).
 *  1. Description — eyebrow "Shown to you", multiline 5 rows (D-47).
 *  2. Persona prompt — eyebrow "Sent to the model", multiline 7 rows mono (D-48).
 *
 * On Create:
 *  - Compute id via slugify(name, existingIds) — collision-safe -2/-3 suffix.
 *  - Build Character JSON (D-11): `is_default: false`, `created` ISO now,
 *    `last_launched: null`, `playtime_ms: 0`, `portrait_image: null` (D-14
 *    image override is V2 — keep null).
 *  - sei.saveCharacter (Zod-validated server-side; T-04-31 mitigation).
 *  - addCharacter to local store + navigate to CharacterPage.
 *
 * Source: 04-07 Task 3.
 */

import React, { useState } from 'react';
import { sei } from '../lib/ipcClient';
import { useUiStore } from '../lib/stores/useUiStore';
import { useDataStore } from '../lib/stores/useDataStore';
import { QuestionShell } from '../components/QuestionShell';
import { TextField } from '../components/TextField';
import { slugify } from '../lib/slug';
import type { Character } from '@shared/characterSchema';

const STEPS = 3;

export function AddCharacterScreen(): React.ReactElement {
  const navigate = useUiStore((s) => s.navigate);
  const characters = useDataStore((s) => s.characters);
  const addCharacter = useDataStore((s) => s.addCharacter);
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [personaPrompt, setPersonaPrompt] = useState('');
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
    if (step === 1) return true; // description optional
    if (step === 2) return personaPrompt.trim() !== '' && !submitting;
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
      const character: Character = {
        id,
        name: name.trim(),
        description: description.trim(),
        persona_prompt: personaPrompt.trim(),
        is_default: false,
        created: new Date().toISOString(),
        last_launched: null,
        playtime_ms: 0,
        portrait_image: null,
      };
      await sei.saveCharacter(character);
      addCharacter(character);
      navigate({ kind: 'character', id });
    } catch (err) {
      // Plan 09 will replace with ERROR_COPY[errorClass] once lib/errors.ts ships.
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

  // ── Step 1 — Description ────────────────────────────────────────────────
  if (step === 1) {
    return (
      <QuestionShell
        eyebrow="Shown to you"
        title="Describe them."
        hint="A short bio that appears on this character's page. Just for you — purely flavour."
        stepCount={STEPS}
        currentStep={step}
        onBack={back}
        onNext={next}
      >
        <TextField
          value={description}
          onChange={setDescription}
          multiline
          rows={5}
          aria-label="Description"
        />
      </QuestionShell>
    );
  }

  // ── Step 2 — Persona prompt ─────────────────────────────────────────────
  return (
    <QuestionShell
      eyebrow="Sent to the model"
      title="Write the persona prompt."
      hint="The system instruction the language model receives. Speak to the model directly."
      stepCount={STEPS}
      currentStep={step}
      onBack={back}
      onNext={next}
      nextLabel="Create"
      nextKind="accent"
      nextDisabled={!validate()}
    >
      <TextField
        value={personaPrompt}
        onChange={setPersonaPrompt}
        multiline
        rows={7}
        monospace
        aria-label="Persona prompt"
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
