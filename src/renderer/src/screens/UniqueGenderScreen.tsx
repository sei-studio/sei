/**
 * UniqueGenderScreen — the single per-slot question asked before casting a
 * unique companion (260703 procgen, spec item 3). Everything else about the
 * companion is decided from the user profile during generation; only gender is
 * asked here. Three radio-tiles (Male / Female / Other) → Begin routes to the
 * full-screen casting screen with the chosen gender.
 */

import React, { useState } from 'react';
import { useUiStore } from '../lib/stores/useUiStore';
import { QuestionShell } from '../components/QuestionShell';
import type { UniqueGender } from '@shared/ipc';
import styles from './ProfileQuestionsScreen.module.css';

const OPTIONS: Array<{ value: UniqueGender; label: string; sub: string }> = [
  { value: 'male', label: 'Male', sub: 'Cast a companion who presents male.' },
  { value: 'female', label: 'Female', sub: 'Cast a companion who presents female.' },
  { value: 'other', label: 'Other', sub: 'Let the cast decide, or beyond the binary.' },
];

export function UniqueGenderScreen(): React.ReactElement {
  const navigate = useUiStore((s) => s.navigate);
  const [gender, setGender] = useState<UniqueGender | null>(null);

  const begin = (): void => {
    if (!gender) return;
    navigate({ kind: 'unique-casting', gender });
  };

  return (
    <QuestionShell
      eyebrow="Meet your unique companion"
      title="Who are you hoping to meet?"
      hint="Everything else about them is a surprise, cast from your profile."
      stepCount={1}
      currentStep={0}
      onBack={() => navigate({ kind: 'home' })}
      onNext={begin}
      nextLabel="Begin"
      nextKind="accent"
      nextDisabled={gender === null}
    >
      <div role="radiogroup" aria-label="Companion gender" className={styles.tiles}>
        {OPTIONS.map((opt) => {
          const selected = gender === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={selected}
              className={`${styles.tile} ${selected ? styles.tileSelected : ''}`}
              onClick={() => setGender(opt.value)}
            >
              <span className={styles.tileLabel}>{opt.label}</span>
              <span className={styles.tileSub}>{opt.sub}</span>
            </button>
          );
        })}
      </div>
    </QuestionShell>
  );
}
