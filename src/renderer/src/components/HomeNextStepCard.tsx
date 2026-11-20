/**
 * HomeNextStepCard — the Home "up next" strip (261013, retention O2 / T119).
 *
 * One line above the party wall: the companion's face, "Up next with Sui",
 * the plan they made together (or the goal they are working on), and one
 * button that opens the surface the plan belongs to. Renders nothing when
 * there is no step: no placeholder, no empty state. Which step, and what the
 * button does, live in lib/homeNextStep.ts.
 */
import React, { useEffect } from 'react';
import type { HomeNextStep } from '@shared/homeNextStep';
import {
  launchHomeNextStep,
  nameInSentence,
  nextStepButtonLabel,
  nextStepTarget,
  trackNextStepShown,
} from '../lib/homeNextStep';
import { useT } from '../lib/i18n';
import { pickPalette } from '../lib/portraitPalettes';
import { PixelPortrait } from './PixelPortrait';
import { Button } from './Button';
import { CloseIcon } from './icons';
import styles from './HomeNextStepCard.module.css';

export interface HomeNextStepCardProps {
  step: HomeNextStep | null;
  name: string;
  portraitImage?: string | null;
  theme: 'light' | 'dark';
  onDismiss: (step: HomeNextStep) => void;
}

export function HomeNextStepCard({
  step,
  name: rawName,
  portraitImage,
  theme,
  onDismiss,
}: HomeNextStepCardProps): React.ReactElement | null {
  const t = useT();

  useEffect(() => {
    if (step) trackNextStepShown(step);
  }, [step]);

  if (!step) return null;
  const target = nextStepTarget(step);
  // The portrait seed keeps the stored name so the palette never changes.
  const seed = step.characterId + rawName;
  const name = nameInSentence(rawName);

  return (
    <section
      className={styles.root}
      aria-label={t('Up next with {name}', { name })}
      data-home-next-step={step.source}
    >
      <div className={styles.face} aria-hidden="true">
        <PixelPortrait
          seed={seed}
          palette={pickPalette(seed, theme)}
          portraitImage={portraitImage}
          size={96}
          style={{ width: '100%', height: '100%' }}
        />
      </div>
      <div className={styles.copy}>
        <span className={styles.kicker}>{t('Up next with {name}', { name })}</span>
        <span className={styles.text}>{step.text}</span>
      </div>
      <div className={styles.actions}>
        <Button kind="secondary" size="md" onClick={() => launchHomeNextStep(step)}>
          {nextStepButtonLabel(target, name, t)}
        </Button>
        <button
          type="button"
          className={styles.dismiss}
          aria-label={t('Dismiss')}
          title={t('Dismiss')}
          onClick={() => onDismiss(step)}
        >
          <CloseIcon size={16} />
        </button>
      </div>
    </section>
  );
}
