/**
 * NoticeLine — the one-line notice (quiet register, product call 261110).
 *
 * `[NEW] text  x` on the --wash fill, one control tall. Product rule: in-app
 * notices are one brief styled line, never plain text with bullet points and
 * never a floating card. The text can be an action (onAction), and the close
 * button dismisses it (onDismiss).
 */

import React from 'react';
import { CloseIcon } from './icons';
import { useT } from '../lib/i18n';
import styles from './NoticeLine.module.css';

export interface NoticeLineProps {
  /** The tag on the left, already translated (e.g. t('NEW')). */
  tag?: string;
  /** The one line. */
  text: string;
  /** Makes the text a button (e.g. open the games picker). */
  onAction?: () => void;
  onDismiss?: () => void;
  className?: string;
  /** Extra attributes for tests and the tutorial. */
  dataAttrs?: Record<string, string>;
}

export function NoticeLine({ tag, text, onAction, onDismiss, className, dataAttrs }: NoticeLineProps): React.ReactElement {
  const t = useT();
  return (
    <div className={[styles.notice, className ?? ''].filter(Boolean).join(' ')} role="status" {...dataAttrs}>
      {tag ? <span className={styles.tag}>{tag}</span> : null}
      {onAction ? (
        <button type="button" className={`${styles.text} ${styles.action}`} onClick={onAction}>
          {text}
        </button>
      ) : (
        <span className={styles.text}>{text}</span>
      )}
      {onDismiss ? (
        <button type="button" className={styles.close} onClick={onDismiss} aria-label={t('Dismiss')}>
          <CloseIcon size={14} />
        </button>
      ) : null}
    </div>
  );
}
