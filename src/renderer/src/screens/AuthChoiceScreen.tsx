/**
 * AuthChoiceScreen — first-launch embedded sign-in surface.
 *
 * B2 refactor: replaces the prior two-tile picker with the user-approved
 * embedded form. The sign-in / sign-up logic was extracted from SignInModal
 * and rendered INLINE (no scrim / no modal) so the very first screen of the
 * app is the sign-in surface itself, not a chooser.
 *
 * Layout (top → bottom):
 *   1. SeiPixelMark (height 44)
 *   2. "Welcome to Sei." heading
 *   3. Embedded email + password form
 *   4. Accent "Sign In" button (full width)
 *   5. "or" divider
 *   6. Official "Sign in with Google" button (full width)
 *   7. Toggle link "New here? Create an account" / "Already have an account? Sign in"
 *   8. DOB triple + ToS checkbox (signup mode only — mirrors SignInModal)
 *   9. "Continue locally →" text link at the very bottom (calls onChooseLocal)
 *
 * Reuses OAuthInterstitialModal + all auth IPC verbatim from SignInModal.
 * ESC support is preserved (when not mid-submit). framingLabel is supported
 * in case a caller wires it, but first-launch flow passes null.
 *
 * Sources:
 *   - 10-UI-SPEC §AuthChoiceScreen + §SignInModal copy
 *   - CONTEXT D-01 (unified sign-in/up), D-02 (equal-citizen local), D-04
 *     (verification non-blocking)
 *   - F-10 (quick/260525-usc) COPPA DOB age gate
 */
import React, { useEffect, useState } from 'react';
import { sei } from '../lib/ipcClient';
import { useT, uiLanguage } from '../lib/i18n';
import { useEmailCode } from '../lib/useEmailCode';
import { SeiPixelMark } from '../components/SeiPixelMark';
import { Button } from '../components/Button';
import { CodeInput } from '../components/CodeInput';
import { GoogleSignInButton } from '../components/GoogleSignInButton';
import { TextField } from '../components/TextField';
import { OAuthInterstitialModal } from '../components/OAuthInterstitialModal';
import styles from './AuthChoiceScreen.module.css';

type Mode = 'signin' | 'signup';

/**
 * Lightweight email shape check. Pre-validates the field client-side so an
 * obviously-malformed address gets an immediate, specific message instead of
 * the server's generic "Email or password doesn't match" (item 8). This is a
 * UX hint, not a security gate — main + Supabase remain the source of truth.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface AuthChoiceScreenProps {
  /** Called when the user picks the bottom "Continue locally" link. Caller routes to home or onboarding per Pitfall A8. */
  onChooseLocal: () => void;
  /**
   * D-10 framing micro-copy mirrored from SignInModal — null on first-launch.
   * Kept on the API so a future inline-upgrade caller can reuse this screen.
   */
  framingLabel?: string | null;
}

export function AuthChoiceScreen({
  onChooseLocal,
  framingLabel = null,
}: AuthChoiceScreenProps): React.ReactElement {
  const t = useT();
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  /**
   * 260804 — ONE code panel for every path that emails something: a signup
   * needing confirmation, a sign-in against an unconfirmed account, and
   * "Forgot your password?". They previously had two separate "check your
   * email" panels whose copy differed, which under the code flow would have
   * told an attacker which kind of email the address had received. Now the
   * address is the only thing that varies, and main decides what the code
   * means (see verifyEmailCode).
   */
  const [codeSentTo, setCodeSentTo] = useState<string | null>(null);
  const [oauthInFlight, setOauthInFlight] = useState(false);
  // Plan 11-12 (D-26 / LIB-06) — at-sign-up ToS capture.
  const [tosChecked, setTosChecked] = useState(false);
  // F-10 (quick/260525-usc) — COPPA DOB age gate (mirrors SignInModal).
  const [dobYear, setDobYear] = useState<string>('');
  const [dobMonth, setDobMonth] = useState<string>('');
  const [dobDay, setDobDay] = useState<string>('');

  // Code panel state. Signed-in routing is driven by App.tsx's auth-state
  // subscriber on the session the redemption lands, so there is nothing to do
  // on success here.
  const codeState = useEmailCode(codeSentTo);

  useEffect(() => {
    // ESC routes to local mode (when not mid-submit). The screen is the
    // first interactive surface, so ESC = back-out = continue locally.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !submitting && codeSentTo === null) {
        onChooseLocal();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onChooseLocal, submitting, codeSentTo]);

  const onSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    // Item 8 — surface a specific message for a malformed email before we even
    // hit the network, rather than letting it fall through to a generic
    // credentials error.
    if (!EMAIL_RE.test(email.trim())) {
      setError(t("That doesn't look like a valid email address."));
      return;
    }
    setSubmitting(true);
    try {
      if (mode === 'signin') {
        const res = await sei.signInPassword({ email, password });
        if (res.ok) {
          // needsVerification: the password was right but the address was
          // never confirmed. Main has already sent a fresh code (260804).
          // Otherwise App.tsx's auth-state subscriber navigates to home on
          // the signed_in transition and there is nothing to do here.
          if (res.needsVerification) setCodeSentTo(email);
        } else {
          setError(res.message);
        }
      } else {
        const res = await sei.signUpPassword({
          email,
          password,
          dobYear: parseInt(dobYear, 10),
          dobMonth: parseInt(dobMonth, 10),
          dobDay: parseInt(dobDay, 10),
        });
        if (res.ok) {
          if (res.requiresVerification) {
            setCodeSentTo(email);
          }
          // !requiresVerification path: App.tsx's auth-state subscriber
          // routes onward on the signed_in transition.
        } else {
          setError(res.message);
        }
      }
    } finally {
      setSubmitting(false);
    }
  };

  const onGoogleClick = (): void => {
    if (submitting) return;
    setError(null);
    setOauthInFlight(true);
  };

  const onForgot = async (): Promise<void> => {
    if (submitting) return;
    setError(null);
    // Reuse the typed email — the field sits directly above the link. Require a
    // valid-looking address first so we don't send the user to a dead-end panel.
    if (!EMAIL_RE.test(email.trim())) {
      setError(t('Enter your email above, then tap "Forgot your password?"'));
      return;
    }
    setSubmitting(true);
    try {
      const res = await sei.sendPasswordReset({ email });
      if (res.ok) {
        // Same panel a signup lands on. Redeeming the code puts the user in a
        // recovery session and App.tsx raises SetNewPasswordModal.
        setCodeSentTo(email);
      } else {
        // rate_limited / network / oauth_only — surface inline; the email field
        // stays filled.
        setError(res.message);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const ctaLabel = submitting
    ? mode === 'signin'
      ? t('Signing in…')
      : t('Creating account…')
    : mode === 'signin'
      ? t('Sign In')
      : t('Create Account');
  const toggleLabel =
    mode === 'signin' ? t('New here? Create an account') : t('Already have an account? Sign in');

  // 260804 code sub-state. Copy is deliberately account-existence-neutral and
  // identical for signup, unconfirmed sign-in and password reset.
  if (codeSentTo !== null) {
    return (
      <div className={styles.shell}>
        <div className={styles.brandRow}>
          <SeiPixelMark height={44} />
        </div>
        <div className={styles.formPanel}>
          <h1 className={styles.title}>{t('Enter your code')}</h1>
          <p className={styles.bodyText}>
            {t('We sent a 6-digit code to {email}. Check spam if it is not there.', {
              email: codeSentTo,
            })}
          </p>
          <CodeInput
            value={codeState.code}
            onChange={codeState.setCode}
            onComplete={(v) => void codeState.submit(v)}
            disabled={codeState.submitting}
            invalid={!!codeState.error}
            autoFocus
            aria-label={t('Verification code')}
          />
          {codeState.error ? (
            <p className={styles.errorText} role="alert">
              {codeState.error}
            </p>
          ) : null}
          {codeState.note ? <p className={styles.bodyText}>{codeState.note}</p> : null}
          <Button
            kind="accent"
            size="md"
            fullWidth
            disabled={codeState.submitting || codeState.code.length === 0}
            onClick={() => void codeState.submit()}
          >
            {codeState.submitting ? t('Checking…') : t('Verify')}
          </Button>
          <Button
            kind="quiet"
            size="md"
            disabled={codeState.resending}
            onClick={() => void codeState.resend()}
          >
            {codeState.resending ? t('Sending…') : t('Send a new code')}
          </Button>
          <Button
            kind="quiet"
            size="md"
            onClick={() => {
              codeState.reset();
              setCodeSentTo(null);
            }}
          >
            {t('Back')}
          </Button>
        </div>
        <button type="button" className={styles.localLink} onClick={onChooseLocal}>
          {t('Continue locally →')}
        </button>
      </div>
    );
  }

  return (
    <div className={styles.shell}>
      <div className={styles.brandRow}>
        <SeiPixelMark height={44} />
      </div>

      <div className={styles.formPanel}>
        {framingLabel ? (
          <p className={styles.framing}>{t('Sign in to {label}', { label: t(framingLabel) })}</p>
        ) : null}

        <form className={styles.form} onSubmit={onSubmit}>
          <div className={styles.fieldGroup}>
            <label className={styles.fieldLabel} htmlFor="auth-email">{t('Email')}</label>
            <TextField
              value={email}
              onChange={setEmail}
              placeholder="you@example.com"
              autoFocus
              aria-label={t('Email')}
            />
          </div>

          <div className={styles.fieldGroup}>
            <label className={styles.fieldLabel} htmlFor="auth-password">{t('Password')}</label>
            <TextField
              value={password}
              onChange={setPassword}
              placeholder={mode === 'signup' ? t('At least 8 characters') : ''}
              type="password"
              aria-label={t('Password')}
              aria-invalid={!!error}
            />
          </div>

          {/*
            F-10 (quick/260525-usc) — COPPA DOB age gate. Three dropdowns
            (month / day / year). The DOB is sent to main on submit; main
            computes age via wall-clock today and rejects with
            `code: 'under_13'` if the user is younger than 13. The DOB is
            NEVER persisted (privacy minimisation — see privacy.html §7).
          */}
          {mode === 'signup' ? (
            <div className={styles.fieldGroup}>
              <label className={styles.fieldLabel}>{t('Date of birth')}</label>
              <div className={styles.dobRow}>
                <select
                  className={styles.dobSelect}
                  value={dobMonth}
                  onChange={(e) => setDobMonth(e.target.value)}
                  aria-label={t('Month of birth')}
                >
                  <option value="">{t('Month')}</option>
                  {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                    <option key={m} value={String(m)}>
                      {new Date(2000, m - 1, 1).toLocaleString(
                        uiLanguage() === 'zh' ? 'zh-CN' : 'en-US',
                        { month: 'short' },
                      )}
                    </option>
                  ))}
                </select>
                <select
                  className={styles.dobSelect}
                  value={dobDay}
                  onChange={(e) => setDobDay(e.target.value)}
                  aria-label={t('Day of birth')}
                >
                  <option value="">{t('Day')}</option>
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
                  aria-label={t('Year of birth')}
                >
                  <option value="">{t('Year')}</option>
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
                aria-label={t('I agree to the Terms of Service and Privacy Policy')}
              />
              <span>
                {t('I agree to the')}{' '}
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    void sei.openExternal('https://sei.gg/terms.html');
                  }}
                >
                  {t('Terms of Service')}
                </a>{' '}
                {t('and')}{' '}
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    void sei.openExternal('https://sei.gg/privacy.html');
                  }}
                >
                  {t('Privacy Policy')}
                </a>
              </span>
            </label>
          ) : null}

          {error ? <p className={styles.errorText} role="alert">{error}</p> : null}

          <Button
            kind="accent"
            size="md"
            type="submit"
            fullWidth
            disabled={
              submitting ||
              !email ||
              !password ||
              (mode === 'signup' && !tosChecked) ||
              (mode === 'signup' && (!dobYear || !dobMonth || !dobDay))
            }
          >
            {ctaLabel}
          </Button>

          {mode === 'signin' ? (
            <div className={styles.forgotRow}>
              <button
                type="button"
                className={styles.forgotLink}
                disabled={submitting}
                onClick={() => { void onForgot(); }}
              >
                {t('Forgot your password?')}
              </button>
            </div>
          ) : null}
        </form>

        <div className={styles.divider}>{t('or')}</div>

        <GoogleSignInButton
          onClick={onGoogleClick}
          disabled={submitting}
          fullWidth
          label={mode === 'signup' ? t('Sign up with Google') : t('Sign in with Google')}
        />

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
      </div>

      <button type="button" className={styles.localLink} onClick={onChooseLocal}>
        {t('Continue locally →')}
      </button>

      {oauthInFlight ? (
        <OAuthInterstitialModal
          onResult={(res) => {
            setOauthInFlight(false);
            if (res.ok) {
              // Auth-state push routes onward (App.tsx subscriber).
            }
          }}
          onCancel={() => {
            setOauthInFlight(false);
          }}
        />
      ) : null}
    </div>
  );
}
