/**
 * UniqueGenderScreen — the single per-slot question asked before casting a
 * unique companion (260703 procgen, spec item 3). Everything else about the
 * companion is decided from the user profile during generation; only gender is
 * asked here. Three radio-tiles (labels Masculine / Feminine / Other; values
 * stay 'male' / 'female' / 'other') → Begin routes to the full-screen casting
 * screen with the chosen gender.
 */

import React, { useState } from 'react';
import { useUiStore } from '../lib/stores/useUiStore';
import { QuestionShell } from '../components/QuestionShell';
import type { UniqueGender } from '@shared/ipc';
import { useT } from '../lib/i18n';
import styles from './ProfileQuestionsScreen.module.css';

const OPTIONS: Array<{ value: UniqueGender; label: string; sub: string }> = [
  { value: 'male', label: 'Masculine', sub: 'Cast a companion who presents masculine.' },
  { value: 'female', label: 'Feminine', sub: 'Cast a companion who presents feminine.' },
  { value: 'other', label: 'Other', sub: 'Let the cast decide, or beyond the binary.' },
];

export function UniqueGenderScreen(): React.ReactElement {
  const t = useT();
  const navigate = useUiStore((s) => s.navigate);
  const [gender, setGender] = useState<UniqueGender | null>(null);

  const begin = (): void => {
    if (!gender) return;
    navigate({ kind: 'unique-casting', gender });
  };

  return (
    <QuestionShell
      title={t('Who are you hoping to meet?')}
      hint={t('Everything else about them is a surprise, cast from your profile.')}
      stepCount={1}
      currentStep={0}
      onBack={() => navigate({ kind: 'home' })}
      onNext={begin}
      nextLabel={t('Begin')}
      nextKind="accent"
      nextDisabled={gender === null}
    >
      <div role="radiogroup" aria-label={t('Companion gender')} className={styles.tiles}>
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
              <span className={styles.tileLabel}>{t(opt.label)}</span>
              <span className={styles.tileSub}>{t(opt.sub)}</span>
            </button>
          );
        })}
      </div>
    </QuestionShell>
  );
}
