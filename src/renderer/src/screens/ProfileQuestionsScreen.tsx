/**
 * ProfileQuestionsScreen — the first-sign-in questionnaire (260703 procgen,
 * spec item 6). Two QuestionShell steps of tile options that seed a user
 * profile used later as the generation seed for 'unique' companions:
 *   1. How old should your companions feel? (companion_age_range)
 *   2. Pick an art style. (art_style)
 *
 * Submit persists via sei.prefsSave (local config.user_profile + cloud
 * user_preferences upsert). On completion it routes to `next`:
 *   - 'home'          → the App-level gate ran it before landing home.
 *   - 'unique-gender' → the add-companion chooser gated the unique path on it.
 *
 * Names only for the art styles for now (spec: example images come later).
 */

import React, { useState } from 'react';
import { sei } from '../lib/ipcClient';
import { useUiStore } from '../lib/stores/useUiStore';
import { QuestionShell } from '../components/QuestionShell';
import type { UserPreferences } from '@shared/characterSchema';
import styles from './ProfileQuestionsScreen.module.css';

type AgeRange = NonNullable<UserPreferences['companion_age_range']>;
type ArtStyle = NonNullable<UserPreferences['art_style']>;

const AGE_OPTIONS: Array<{ value: AgeRange; label: string; sub: string }> = [
  { value: 'young-adult', label: 'Young adult', sub: 'Fresh, spirited, early twenties energy.' },
  { value: 'adult', label: 'Adult', sub: 'Grounded and self-assured.' },
  { value: 'mature', label: 'Mature', sub: 'Seasoned, with lived-in wisdom.' },
  { value: 'elder', label: 'Elder', sub: 'Old souls who have seen it all.' },
  { value: 'timeless', label: 'Timeless', sub: 'Ageless — beyond years entirely.' },
];

const STYLE_OPTIONS: Array<{ value: ArtStyle; label: string; sub: string }> = [
  { value: 'chibi', label: 'Round chibi', sub: 'Soft, cute, big-headed charm.' },
  { value: 'anime', label: 'Anime', sub: 'Classic Japanese animation look.' },
  { value: 'celshaded', label: 'Cel-shaded', sub: 'Bold lines, flat painterly shading.' },
  { value: 'cartoon', label: 'Cartoon', sub: 'Western animated styling.' },
  { value: '3d', label: '3D', sub: 'Rendered, dimensional, modern.' },
];

export interface ProfileQuestionsScreenProps {
  next: 'home' | 'unique-gender';
}

export function ProfileQuestionsScreen({ next }: ProfileQuestionsScreenProps): React.ReactElement {
  const navigate = useUiStore((s) => s.navigate);
  const [step, setStep] = useState<0 | 1>(0);
  const [age, setAge] = useState<AgeRange | null>(null);
  const [style, setStyle] = useState<ArtStyle | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const goNext = async (): Promise<void> => {
    if (step === 0) {
      setStep(1);
      return;
    }
    // Step 1 — persist and route onward.
    if (!age || !style) return;
    setSubmitting(true);
    setError(null);
    try {
      await sei.prefsSave({
        companion_age_range: age,
        art_style: style,
        completed_at: new Date().toISOString(),
      });
      if (next === 'unique-gender') {
        navigate({ kind: 'unique-gender' });
      } else {
        navigate({ kind: 'home' });
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const back = (): void => {
    if (step === 1) {
      setStep(0);
      return;
    }
    // Step 0 back cancels the questionnaire and returns home (the App-level gate
    // won't immediately re-trigger — it fires once per signed-in user).
    navigate({ kind: 'home' });
  };

  if (step === 0) {
    return (
      <QuestionShell
        eyebrow="Set up your companions"
        title="How old should your companions feel?"
        hint="This shapes how the companions Sei casts for you come across. You can revisit this later."
        stepCount={2}
        currentStep={0}
        onBack={back}
        onNext={() => void goNext()}
        nextLabel="Continue"
        nextDisabled={age === null}
      >
        <TileGroup
          ariaLabel="Companion age range"
          options={AGE_OPTIONS}
          value={age}
          onChange={setAge}
        />
      </QuestionShell>
    );
  }

  return (
    <QuestionShell
      eyebrow="Set up your companions"
      title="Pick an art style"
      hint="How your companions look when Sei gives them a face."
      stepCount={2}
      currentStep={1}
      onBack={back}
      onNext={() => void goNext()}
      nextLabel={submitting ? 'Saving…' : 'Finish'}
      nextKind="accent"
      nextDisabled={style === null || submitting}
    >
      <TileGroup
        ariaLabel="Art style"
        options={STYLE_OPTIONS}
        value={style}
        onChange={setStyle}
      />
      {error ? (
        <div className={styles.error} role="alert">
          {error}
        </div>
      ) : null}
    </QuestionShell>
  );
}

/**
 * TileGroup — a vertical radio-tile group matching the AddCharacterScreen
 * proactiveness step idiom (accent border + soft fill when selected).
 */
function TileGroup<T extends string>({
  ariaLabel,
  options,
  value,
  onChange,
}: {
  ariaLabel: string;
  options: Array<{ value: T; label: string; sub: string }>;
  value: T | null;
  onChange: (v: T) => void;
}): React.ReactElement {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={styles.tiles}>
      {options.map((opt) => {
        const selected = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={selected}
            className={`${styles.tile} ${selected ? styles.tileSelected : ''}`}
            onClick={() => onChange(opt.value)}
          >
            <span className={styles.tileLabel}>{opt.label}</span>
            <span className={styles.tileSub}>{opt.sub}</span>
          </button>
        );
      })}
    </div>
  );
}
