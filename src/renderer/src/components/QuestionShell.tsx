/**
 * QuestionShell — the central column used by OnboardingScreen and
 * AddCharacterScreen for each step.
 *
 * Layout: 520px max-width column with optional eyebrow / title / hint, the
 * field children, and a footer row of (Back | StepDots | Next).
 *
 * Source: 04-UI-SPEC.md §"Question shell max-width 520px" + 04-07 Task 1.
 */

import React from 'react';
import { Button } from './Button';
import { StepDots } from './StepDots';
import { BackIcon } from './icons';
import styles from './QuestionShell.module.css';

export interface QuestionShellProps {
  eyebrow?: string;
  title: React.ReactNode;
  hint?: string;
  children: React.ReactNode;
  stepCount: number;
  currentStep: number;
  onBack?: () => void;
  onNext: () => void;
  nextLabel?: string;
  nextKind?: 'primary' | 'accent';
  nextDisabled?: boolean;
  backDisabled?: boolean;
  /** Optional secondary action shown between Back and Next (e.g. "Skip"). */
  secondaryLabel?: string;
  onSecondary?: () => void;
  /** Widen the column for content that needs more room (e.g. SkinEditor). */
  wide?: boolean;
}

export function QuestionShell(p: QuestionShellProps): React.ReactElement {
  return (
    <div
      className={styles.root}
      style={p.wide ? { maxWidth: 820 } : undefined}
    >
      <div className={styles.body}>
        {p.eyebrow ? <div className={styles.eyebrow}>{p.eyebrow}</div> : null}
        <h1 className={styles.title}>{p.title}</h1>
        {p.hint ? <p className={styles.hint}>{p.hint}</p> : null}
        <div className={styles.field}>{p.children}</div>
      </div>
      <div className={styles.footer}>
        <Button
          kind="quiet"
          size="md"
          icon={<BackIcon size={14} />}
          onClick={p.onBack}
          disabled={p.backDisabled}
          aria-label="Back"
        >
          Back
        </Button>
        <StepDots count={p.stepCount} current={p.currentStep} />
        {p.secondaryLabel ? (
          <Button kind="quiet" size="md" onClick={p.onSecondary}>
            {p.secondaryLabel}
          </Button>
        ) : null}
        <Button
          kind={p.nextKind ?? 'primary'}
          size="md"
          onClick={p.onNext}
          disabled={p.nextDisabled}
        >
          {p.nextLabel ?? 'Continue'}
        </Button>
      </div>
    </div>
  );
}
