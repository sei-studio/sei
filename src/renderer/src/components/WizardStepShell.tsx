/**
 * WizardStepShell — reusable wizard step body.
 *
 * Renders:
 *   - Step indicator "STEP n / 5" in pixel font (only when stepNumber !== null;
 *     branch states 1b/3b omit the indicator per UI-SPEC §"Setup wizard modal").
 *   - <h2> heading in --sans 22px 600.
 *   - Body content (children) — flex: 1 so footers stick to the bottom of the modal.
 *   - Footer row — fixed margin-top to keep button alignment consistent across steps.
 *
 * Distinct from QuestionShell because wizard step content height varies
 * (welcome paragraph vs install list vs progress bars vs single line of copy).
 *
 * Source: 09-UI-SPEC.md §"Component Inventory" + §Typography (pixel-font reserved
 *         for SeiPixelMark + wizard step indicator).
 */

import React from 'react';
import styles from './WizardStepShell.module.css';

export interface WizardStepShellProps {
  /** 1..5; null for branch states (none-found / one-failed) that don't advance the counter. */
  stepNumber: number | null;
  heading: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}

export function WizardStepShell({
  stepNumber,
  heading,
  children,
  footer,
}: WizardStepShellProps): React.ReactElement {
  return (
    <div className={styles.shell}>
      {stepNumber !== null ? (
        <div className={styles.stepIndicator}>STEP {stepNumber} / 5</div>
      ) : null}
      <h2 className={styles.heading}>{heading}</h2>
      <div className={styles.body}>{children}</div>
      {footer ? <div className={styles.footer}>{footer}</div> : null}
    </div>
  );
}
