/**
 * Tests for AuthChoiceScreen — B2 (embedded sign-in surface).
 *
 * Project convention (no @testing-library/react installed): exercise the
 * source contract via grep-style file presence checks plus module-import
 * smoke tests. Mirrors src/renderer/src/screens/ReceiptScreen.test.tsx.
 *
 * Invariants under test:
 *   1. Module exports an AuthChoiceScreen symbol with prop onChooseLocal.
 *   2. Source embeds the email/password fields inline (no modal scrim).
 *   3. Source surfaces the "Sign In" accent CTA and the official Google button.
 *   4. Source surfaces the "Continue locally" text link at the bottom.
 *   5. Source toggles between sign-in and sign-up modes with the
 *      "New here? Create an account" affordance.
 *   6. Source mounts OAuthInterstitialModal on the Google flow.
 *   7. Source preserves the F-10 DOB triple + ToS checkbox in signup mode.
 *   8. Source preserves the verification-pending "Check your email" branch.
 *   9. CSS module does NOT define a `.scrim` class — the form is embedded,
 *      not a modal.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TSX_PATH = resolve(__dirname, 'AuthChoiceScreen.tsx');
const CSS_PATH = resolve(__dirname, 'AuthChoiceScreen.module.css');

// ipcClient.ts reads `window.sei` at module init; stub a minimal window so
// the import chain works in the node-environment vitest run.
beforeEach(() => {
  (globalThis as unknown as { window: unknown }).window = {
    sei: {
      signInPassword: async () => ({ ok: true }),
      signUpPassword: async () => ({ ok: true, requiresVerification: false }),
      openExternal: async () => undefined,
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
});

describe('AuthChoiceScreen (B2 embedded sign-in)', () => {
  it('Test 1: exports AuthChoiceScreen function and accepts onChooseLocal prop', async () => {
    const mod = await import('./AuthChoiceScreen');
    expect(mod.AuthChoiceScreen).toBeDefined();
    expect(typeof mod.AuthChoiceScreen).toBe('function');
    const source = readFileSync(TSX_PATH, 'utf-8');
    expect(source.includes('onChooseLocal')).toBe(true);
  });

  it('Test 2: embeds the email + password TextFields inline (no SignInModal mount)', () => {
    const source = readFileSync(TSX_PATH, 'utf-8');
    // TextField imports come from the local components dir, not via SignInModal.
    expect(source.includes("import { TextField } from '../components/TextField'")).toBe(true);
    // Inline form, not the modal — must NOT mount SignInModal.
    expect(source.includes('<SignInModal')).toBe(false);
  });

  it('Test 3: surfaces accent Sign In CTA and the official Google sign-in button', () => {
    const source = readFileSync(TSX_PATH, 'utf-8');
    expect(source.includes('Sign In')).toBe(true);
    // The "Continue with Google" ghost button was replaced by the official
    // Google-branded button component (dark variant) per Google's guidelines.
    expect(source.includes('GoogleSignInButton')).toBe(true);
    expect(source.includes('Sign in with Google')).toBe(true);
    // Both buttons should be full-width per the mockup.
    expect(source.includes('fullWidth')).toBe(true);
  });

  it('Test 4: surfaces the Continue locally text link at the bottom', () => {
    const source = readFileSync(TSX_PATH, 'utf-8');
    expect(source.includes('Continue locally')).toBe(true);
    expect(source.includes('onChooseLocal')).toBe(true);
  });

  it('Test 5: provides the sign-in / sign-up mode toggle', () => {
    const source = readFileSync(TSX_PATH, 'utf-8');
    expect(source.includes('New here? Create an account')).toBe(true);
    expect(source.includes('Already have an account? Sign in')).toBe(true);
  });

  it('Test 6: mounts OAuthInterstitialModal for the Google flow', () => {
    const source = readFileSync(TSX_PATH, 'utf-8');
    expect(source.includes('OAuthInterstitialModal')).toBe(true);
    expect(source.includes('oauthInFlight')).toBe(true);
  });

  it('Test 7: preserves the F-10 DOB triple + ToS checkbox in signup mode', () => {
    const source = readFileSync(TSX_PATH, 'utf-8');
    expect(source.includes('dobYear')).toBe(true);
    expect(source.includes('dobMonth')).toBe(true);
    expect(source.includes('dobDay')).toBe(true);
    expect(source.includes('tosChecked')).toBe(true);
  });

  it('Test 8: preserves the verification-pending Check-your-email branch', () => {
    const source = readFileSync(TSX_PATH, 'utf-8');
    expect(source.includes('verificationSentTo')).toBe(true);
    expect(source.includes('Check your email')).toBe(true);
  });

  it('Test 9: CSS module ships no .scrim class — the form is embedded, not modal', () => {
    const css = readFileSync(CSS_PATH, 'utf-8');
    expect(css.includes('.scrim')).toBe(false);
    expect(css.includes('.formPanel')).toBe(true);
    expect(css.includes('.localLink')).toBe(true);
  });

  it('Test 10: surfaces a functional forgot-password link (recovery flow shipped)', () => {
    const source = readFileSync(TSX_PATH, 'utf-8');
    const css = readFileSync(CSS_PATH, 'utf-8');
    // The forgot-password affordance is back now that email-based recovery
    // exists (sei.sendPasswordReset → loopback recovery session →
    // SetNewPasswordModal). It must be WIRED (onForgot → sendPasswordReset),
    // not the Phase 10 dead placeholder.
    expect(source.includes('Forgot your password?')).toBe(true);
    expect(source.includes('sendPasswordReset')).toBe(true);
    expect(source.includes('onForgot')).toBe(true);
    expect(css.includes('.forgotLink')).toBe(true);
  });
});
