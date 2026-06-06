/**
 * GoogleSignInButton — the official "Sign in with Google" button.
 *
 * This is deliberately NOT built on the app's <Button> primitive and does NOT
 * pull from the Summoning-Terminal design tokens. Google's branding guidelines
 * (https://developers.google.com/identity/branding-guidelines) mandate the
 * exact logo, colors, typography (Roboto Medium 14px), 40px height, 12px
 * padding and ~4px corner radius — altering them violates the guidelines. The
 * literal hex/px below are intentional brand-asset values, not design-system
 * drift. We use the dark variant so it reads correctly on Sei's dark surfaces.
 *
 * The 4-color "G" is the canonical Google logo, inlined as JSX so it tints
 * itself (no CSS mask, unlike SeiPixelMark) and needs no separate asset file.
 *
 * Behaviorally a drop-in for the old `<Button kind="ghost">Continue with
 * Google</Button>`: same onClick/disabled/fullWidth contract.
 */

import React from 'react';
import styles from './GoogleSignInButton.module.css';

interface GoogleSignInButtonProps {
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  fullWidth?: boolean;
  /**
   * One of Google's three sanctioned labels: "Sign in with Google",
   * "Sign up with Google", or "Continue with Google". Defaults to sign-in.
   */
  label?: string;
}

/** Canonical 4-color Google "G", 18px per the branding spec's 40px button. */
function GoogleGlyph(): React.ReactElement {
  return (
    <svg
      className={styles.glyph}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 48 48"
      aria-hidden="true"
      focusable="false"
    >
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

export function GoogleSignInButton({
  onClick,
  disabled,
  fullWidth,
  label = 'Sign in with Google',
}: GoogleSignInButtonProps): React.ReactElement {
  const cls = [styles.button, fullWidth ? styles.fullWidth : ''].filter(Boolean).join(' ');
  return (
    <button type="button" className={cls} onClick={onClick} disabled={disabled}>
      <span className={styles.glyphWrap}>
        <GoogleGlyph />
      </span>
      <span className={styles.label}>{label}</span>
    </button>
  );
}
