/**
 * ContinueWithChatGPTButton — OpenAI's approved "Continue with ChatGPT"
 * button (261017, issue #46).
 *
 * Like GoogleSignInButton, deliberately NOT built on <Button> and NOT on the
 * design tokens: OpenAI's sign-in button formats fix the label, the logo,
 * the colors (black or white only), 45px height, 20px gutter, 12px gap, 12px
 * radius, Inter 15px/500 and a 242px width. The literal values in the CSS
 * module are those brand specs. The white format is used on Sei's dark
 * theme and the black one on light, so the button always reads as a solid
 * shape against the surface. The label keeps OpenAI's "Continue with
 * ChatGPT" wording; under a non-English UI it is the same phrase in that
 * language (261104), with "ChatGPT" verbatim, like the Google button.
 */
import React from 'react';
import { ChatgptLogo } from './ChatgptLogo';
import { useT } from '../lib/i18n';
import styles from './ContinueWithChatGPTButton.module.css';

interface Props {
  onClick?: () => void;
  disabled?: boolean;
  /** Force a format; default follows the theme (white on dark, black on light). */
  format?: 'black' | 'white';
  /** Accessible busy state while the browser sign-in is open. */
  busy?: boolean;
  /** Stretch to the container, matching a full-width Google button beside it. */
  fullWidth?: boolean;
}

export function ContinueWithChatGPTButton({ onClick, disabled, format, busy, fullWidth }: Props): React.ReactElement {
  const t = useT();
  return (
    <button
      type="button"
      className={fullWidth ? `${styles.button} ${styles.fullWidth}` : styles.button}
      data-format={format}
      onClick={onClick}
      disabled={disabled}
      aria-busy={busy || undefined}
    >
      <ChatgptLogo className={styles.logo} />
      <span>{t('Continue with ChatGPT')}</span>
    </button>
  );
}
