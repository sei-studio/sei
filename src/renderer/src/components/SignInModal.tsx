/**
 * SignInModal — unified sign-in / sign-up modal (D-01).
 *
 * Mode toggle inside the form. Email + Password. Primary accent CTA changes
 * label per mode. Google ghost button (plan 05 wires the actual OAuth dance).
 *
 * Dismissal label follows the UI-SPEC dismissal-label policy — a specific
 * verb+noun phrase, never the generic 'Cancel'.
 *
 * Email verification does NOT block sign-in (D-04). On signup success the
 * modal closes immediately and the user proceeds into the app; the
 * verify-email Banner (plan 06) handles the persistent prompt.
 *
 * The Forgot-password link sends a reset email (sei.sendPasswordReset) and
 * shows a neutral "check your email" sub-state. Clicking the emailed link lands
 * a recovery session and App.tsx raises SetNewPasswordModal. (Superseded the
 * Phase 10 non-functional placeholder, T-10-04-03.)
 *
 * Source: 10-UI-SPEC §SignInModal + Copywriting Contract.
 */
import React, { useEffect, useState } from 'react';
import { sei } from '../lib/ipcClient';
import { Button } from './Button';
import { ModalShell, ModalFooter } from './ModalShell';
import { GoogleSignInButton } from './GoogleSignInButton';
import { TextField } from './TextField';
import { OAuthInterstitialModal } from './OAuthInterstitialModal';
import styles from './SignInModal.module.css';

export interface SignInModalProps {
  /**
   * D-10 framing micro-copy. Null when opened directly from AuthChoice; set
   * to e.g. 'browse public characters' for the inline-upgrade flow (plan 07).
   */
  framingLabel: string | null;
  /** Called on dismissal AND on successful sign-in/up. Caller routes onward. */
  onClose: () => void;
}

type Mode = 'signin' | 'signup';

/** See AuthChoiceScreen — same client-side email-shape hint (item 8). */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function SignInModal({ framingLabel, onClose }: SignInModalProps): React.ReactElement {
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  /**
   * 260519 UAT fix #2: when signUp returns requiresVerification=true and no
   * session, Supabase has email-confirm enabled — the user must click the
   * link in their inbox before a session is issued. The previous executor
   * blindly closed the modal on every {ok:true}, bouncing the user back to
   * AuthChoice with no feedback. Now we surface a "Check your email" state
   * inside the modal until the auth-state push fires (or the user dismisses
   * manually). The verify-email Banner (plan 06) replaces this interim
   * message with a persistent app-level prompt.
   */
  const [verificationSentTo, setVerificationSentTo] = useState<string | null>(null);
  /**
   * Forgot-password sub-state. When the user taps "Forgot your password?" we
   * call sei.sendPasswordReset with the typed email and, on neutral success,
   * render a "check your email" panel (mirrors verificationSentTo). The reset
   * is anti-enumeration: main returns ok:true even for unknown addresses.
   */
  const [resetSentTo, setResetSentTo] = useState<string | null>(null);
  /**
   * Plan 10-05: when true, OAuthInterstitialModal mounts as a sibling above
   * this modal. SignInModal STAYS MOUNTED so the typed `email` value is
   * preserved across an OAuth cancel — on cancel we just flip this back to
   * false and the SignInModal reappears with the email field still filled
   * (UI-SPEC §Interaction Contracts → OAuth flow §5: cancel returns to
   * SignInModal NOT AuthChoice, preserving the typed email).
   */
  const [oauthInFlight, setOauthInFlight] = useState(false);
  /**
   * Plan 11-12 (D-26 / LIB-06) — at-sign-up ToS capture branch. The checkbox
   * is REQUIRED in signup mode: the submit button is disabled until it's
   * checked. After supabase.auth.signUp() succeeds the main process records
   * the tos_acceptance row (authHandlers.signUpWithPassword fire-and-forget);
   * the renderer never calls tosAccept directly here because the user_id only
   * exists after the auth.signUp call returns.
   */
  const [tosChecked, setTosChecked] = useState(false);
  /**
   * F-10 (quick/260525-usc) — COPPA DOB age gate. Three dropdowns, defaults
   * to empty placeholder options. Submit button additionally disabled until
   * all three are set. The DOB is sent to main on submit, where the age
   * is computed via wall-clock today; if age < 13 main returns
   * `{ ok:false, code:'under_13' }` and we render the message inline via
   * the existing error path. The DOB itself is NEVER persisted by main
   * (privacy minimisation — see privacy.html §7).
   */
  const [dobYear, setDobYear] = useState<string>('');
  const [dobMonth, setDobMonth] = useState<string>('');
  const [dobDay, setDobDay] = useState<string>('');

  useEffect(() => {
    // ESC closes (when not mid-submit so we don't drop a pending sign-in).
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !submitting) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, submitting]);

  const onSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    // Item 8 — specific message for a malformed email, pre-network.
    if (!EMAIL_RE.test(email.trim())) {
      setError("That doesn't look like a valid email address.");
      return;
    }
    setSubmitting(true);
    try {
      if (mode === 'signin') {
        const res = await sei.signInPassword({ email, password });
        if (res.ok) {
          onClose();
        } else {
          setError(res.message);
        }
      } else {
        // F-10 — DOB triple is required in signup mode. The submit button
        // is disabled until all three dropdowns are set; this parseInt cannot
        // produce NaN here because the disabled-guard above blocks the
        // submission. The DOB is sent to main for the COPPA age check; main
        // does NOT persist it.
        const res = await sei.signUpPassword({
          email,
          password,
          dobYear: parseInt(dobYear, 10),
          dobMonth: parseInt(dobMonth, 10),
          dobDay: parseInt(dobDay, 10),
        });
        if (res.ok) {
          if (res.requiresVerification) {
            // 260519 UAT fix #2: Supabase has email-confirm enabled — no
            // session is issued until the user clicks the link. Stay open
            // and tell them to check their inbox. The main process's
            // auth-state push will fire SIGNED_IN later (once the loopback
            // callback handler exchanges the code), at which point App.tsx's
            // useAuthStore subscriber drives the route transition AND the
            // modal naturally unmounts because AuthChoiceScreen is replaced.
            setVerificationSentTo(email);
          } else {
            // D-04 path with email-confirm disabled in the project: session
            // is present, the auth-state stream already pushed SIGNED_IN,
            // and the verify-email Banner (plan 06) handles any persistent
            // prompt. Close the modal.
            onClose();
          }
        } else if (res.code === 'already_registered') {
          // 260605 no-silent-failure: the email is already in use. Flip to
          // sign-in mode (email stays filled) and show the honest message —
          // when it's an OAuth account the copy names the provider (e.g.
          // "Use Continue with Google"), and the Google button is right below.
          setMode('signin');
          setPassword('');
          setError(res.message);
        } else {
          setError(res.message);
        }
      }
    } finally {
      setSubmitting(false);
    }
  };

  const onGoogleClick = (): void => {
    // Plan 10-05: hand off to OAuthInterstitialModal. SignInModal stays
    // mounted (the interstitial is a sibling, z-index 1100 > scrim 1000)
    // so on cancel the typed email is preserved automatically.
    if (submitting) return;
    setError(null);
    setOauthInFlight(true);
  };

  const onForgot = async (): Promise<void> => {
    if (submitting) return;
    setError(null);
    // Reuse the typed email — the field is right above the link. Require a
    // valid-looking address before firing so we don't send the user to a
    // "check your email" dead-end with nothing entered.
    if (!EMAIL_RE.test(email.trim())) {
      setError('Enter your email above, then tap "Forgot your password?"');
      return;
    }
    setSubmitting(true);
    try {
      const res = await sei.sendPasswordReset({ email });
      if (res.ok) {
        setResetSentTo(email);
      } else {
        // rate_limited / network — surface the copy inline; the email field
        // stays filled so the user can retry.
        setError(res.message);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const titleText = mode === 'signin' ? 'Sign in to Sei' : 'Create your Sei account';
  const ctaLabel = submitting
    ? mode === 'signin'
      ? 'Signing in…'
      : 'Creating account…'
    : mode === 'signin'
      ? 'Sign In'
      : 'Create Account';
  const toggleLabel =
    mode === 'signin' ? 'New here? Create an account' : 'Already have an account? Sign in';

  // 260519 UAT fix #2 — verification-pending sub-state. Renders inside the
  // same scrim+modal frame so the user isn't bounced anywhere; only the modal
  // body content changes. Replaced by the verify-email Banner (plan 06) once
  // that ships.
  if (verificationSentTo !== null) {
    return (
      <ModalShell title="Check your email" width={460} escClose={!submitting} onClose={onClose}>
        <p className={styles.framing}>
          We sent a verification link to <strong>{verificationSentTo}</strong>. Open it on this
          device to finish signing in.
        </p>
        <p className={styles.framing}>
          You can close this window. Once you click the link, Sei signs you in automatically.
        </p>
        <ModalFooter>
          <Button kind="quiet" size="md" onClick={onClose}>
            Back to Sei
          </Button>
        </ModalFooter>
      </ModalShell>
    );
  }

  // Forgot-password sub-state — neutral "check your email" panel. Same frame as
  // the verification panel; copy is deliberately account-existence-neutral.
  if (resetSentTo !== null) {
    return (
      <ModalShell title="Check your email" width={460} escClose={!submitting} onClose={onClose}>
        <p className={styles.framing}>
          If an account exists for <strong>{resetSentTo}</strong>, we've sent a password reset
          link. Open it on this device to choose a new password.
        </p>
        <p className={styles.framing}>
          You can close this window. Once you click the link, Sei prompts you for a new password.
        </p>
        <ModalFooter>
          <Button kind="quiet" size="md" onClick={onClose}>
            Back to Sei
          </Button>
        </ModalFooter>
      </ModalShell>
    );
  }

  return (
    <>
    <ModalShell title={titleText} width={460} escClose={!submitting} onClose={onClose}>
        {framingLabel ? (
          <p className={styles.framing}>Sign in to {framingLabel}</p>
        ) : null}

        <div className={styles.toggleRow}>
          <button
            type="button"
            className={styles.toggleLink}
            onClick={() => {
              setMode((m) => (m === 'signin' ? 'signup' : 'signin'));
              setError(null);
            }}
          >
            {toggleLabel}
          </button>
        </div>

        <form className={styles.form} onSubmit={onSubmit}>
          <div className={styles.fieldGroup}>
            <label className={styles.fieldLabel} htmlFor="signin-email">Email</label>
            <TextField
              value={email}
              onChange={setEmail}
              placeholder="you@example.com"
              autoFocus
              aria-label="Email"
            />
          </div>

          <div className={styles.fieldGroup}>
            <label className={styles.fieldLabel} htmlFor="signin-password">Password</label>
            <TextField
              value={password}
              onChange={setPassword}
              placeholder={mode === 'signup' ? 'At least 8 characters' : ''}
              type="password"
              aria-label="Password"
              aria-invalid={!!error}
            />
          </div>

          {error ? <p className={styles.errorText} role="alert">{error}</p> : null}

          {/*
            F-10 (quick/260525-usc) — COPPA DOB age gate. Three dropdowns
            (month / day / year). The DOB is sent to main on submit; main
            computes age via wall-clock today and rejects with
            `code: 'under_13'` if the user is younger than 13. The DOB is
            NEVER persisted (privacy minimisation — see privacy.html §7).
            Years: 100 back from current year (1926..2026 by default).
          */}
          {mode === 'signup' ? (
            <div className={styles.fieldGroup}>
              <label className={styles.fieldLabel}>Date of birth</label>
              <div className={styles.dobRow}>
                <select
                  className={styles.dobSelect}
                  value={dobMonth}
                  onChange={(e) => setDobMonth(e.target.value)}
                  aria-label="Month of birth"
                >
                  <option value="">Month</option>
                  {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                    <option key={m} value={String(m)}>
                      {new Date(2000, m - 1, 1).toLocaleString('en-US', { month: 'short' })}
                    </option>
                  ))}
                </select>
                <select
                  className={styles.dobSelect}
                  value={dobDay}
                  onChange={(e) => setDobDay(e.target.value)}
                  aria-label="Day of birth"
                >
                  <option value="">Day</option>
                  {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                    <option key={d} value={String(d)}>
                      {d}
                    </option>
                  ))}
                </select>
                <select
                  className={styles.dobSelect}
                  value={dobYear}
                  onChange={(e) => setDobYear(e.target.value)}
                  aria-label="Year of birth"
                >
                  <option value="">Year</option>
                  {(() => {
                    const currentYear = new Date().getFullYear();
                    return Array.from({ length: 100 }, (_, i) => currentYear - i).map((y) => (
                      <option key={y} value={String(y)}>
                        {y}
                      </option>
                    ));
                  })()}
                </select>
              </div>
            </div>
          ) : null}

          {mode === 'signup' ? (
            <label className={styles.tosCheckbox}>
              <input
                type="checkbox"
                checked={tosChecked}
                onChange={(e) => setTosChecked(e.target.checked)}
                aria-label="I agree to the Terms of Service and Privacy Policy"
              />
              <span>
                I agree to the{' '}
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    void sei.openExternal('https://sei.gg/terms.html');
                  }}
                >
                  Terms of Service
                </a>{' '}
                and{' '}
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    void sei.openExternal('https://sei.gg/privacy.html');
                  }}
                >
                  Privacy Policy
                </a>
              </span>
            </label>
          ) : null}

          <Button
            kind="accent"
            size="md"
            type="submit"
            disabled={
              submitting ||
              !email ||
              !password ||
              (mode === 'signup' && !tosChecked) ||
              // F-10: in signup mode, all three DOB dropdowns must be set
              // before submission is allowed.
              (mode === 'signup' && (!dobYear || !dobMonth || !dobDay))
            }
          >
            {ctaLabel}
          </Button>

          {mode === 'signin' ? (
            <button
              type="button"
              className={styles.forgotLink}
              disabled={submitting}
              onClick={() => { void onForgot(); }}
            >
              Forgot your password?
            </button>
          ) : null}
        </form>

        <div className={styles.divider}>or</div>

        <GoogleSignInButton
          onClick={onGoogleClick}
          disabled={submitting}
          fullWidth
          label={mode === 'signup' ? 'Sign up with Google' : 'Sign in with Google'}
        />

        <ModalFooter>
          <Button kind="quiet" size="md" onClick={onClose} disabled={submitting}>
            Back to Sei
          </Button>
        </ModalFooter>
    </ModalShell>
    {oauthInFlight ? (
      <OAuthInterstitialModal
        onResult={(res) => {
          setOauthInFlight(false);
          if (res.ok) {
            // Success: close SignInModal. The auth-state push will route
            // App.tsx onward (Pitfall A8).
            onClose();
          }
          // Non-ok results other than user_cancelled (which routes through
          // onCancel below) are surfaced as error variants INSIDE the
          // interstitial, where the user gets Try again / Cancel sign-in.
          // If we somehow reach here with !res.ok, just stay on SignInModal
          // with the email preserved.
        }}
        onCancel={() => {
          // Stay mounted on SignInModal; the `email` state value persists,
          // so the email field is still filled when the interstitial unmounts.
          setOauthInFlight(false);
        }}
      />
    ) : null}
    </>
  );
}
