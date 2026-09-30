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
import { uiLanguage, useT } from '../lib/i18n';
import { useEmailCode } from '../lib/useEmailCode';
import { Button } from './Button';
import { CodeInput } from './CodeInput';
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
  const t = useT();
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  /**
   * 260519 UAT fix #2: when signUp returns requiresVerification=true and no
   * session, Supabase has email-confirm enabled — no session is issued until
   * the address is confirmed. The original executor blindly closed the modal
   * on every {ok:true}, bouncing the user back to AuthChoice with no feedback,
   * so the modal stays open on a sub-state instead.
   *
   * 260804: that sub-state is now a CODE panel, and it is the single panel for
   * all three email-sending paths (signup, sign-in against an unconfirmed
   * account, forgot-password). They used to be two panels with different copy,
   * which under the code flow would leak which kind of email an address got.
   * See useEmailCode + authHandlers.verifyEmailCode.
   */
  const [codeSentTo, setCodeSentTo] = useState<string | null>(null);
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

  // A non-recovery redemption signs the user in; the modal's job is done.
  // Recovery redemptions deliberately do NOT close it here — App.tsx mounts
  // SetNewPasswordModal above, and unmounting the host mid-flow is what the
  // recovery gate exists to prevent.
  const codeState = useEmailCode(codeSentTo, onClose);

  /**
   * W7 region gate (260816). Pre-checked on mount over region:status so the
   * blocking body appears immediately; the submit paths below also honor a
   * main-side `region_blocked` refusal (the authoritative gate). Fails open:
   * a failed pre-check leaves the form usable.
   */
  const [regionBlocked, setRegionBlocked] = useState(false);
  useEffect(() => {
    let cancelled = false;
    sei.regionStatus().then(
      (s) => {
        if (!cancelled && s.blocked) setRegionBlocked(true);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, []);

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
      setError(t("That doesn't look like a valid email address."));
      return;
    }
    setSubmitting(true);
    try {
      if (mode === 'signin') {
        const res = await sei.signInPassword({ email, password });
        if (res.ok) {
          // 260804 — right password, address never confirmed. Main has already
          // sent a fresh code; stay open on the code panel instead of closing
          // onto a session that was never issued.
          if (res.needsVerification) setCodeSentTo(email);
          else onClose();
        } else if (res.code === 'region_blocked') {
          // W7: swap the whole body for the blocking message (translated
          // locally) rather than showing it as an inline field error.
          setRegionBlocked(true);
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
            // 260519 UAT fix #2 / 260804: Supabase has email-confirm enabled,
            // so no session exists until the emailed code is redeemed. Stay
            // open on the code panel; redeeming it fires SIGNED_IN and
            // App.tsx's useAuthStore subscriber drives the route transition.
            setCodeSentTo(email);
          } else {
            // D-04 path with email-confirm disabled in the project: session
            // is present, the auth-state stream already pushed SIGNED_IN,
            // and the verify-email Banner (plan 06) handles any persistent
            // prompt. Close the modal.
            onClose();
          }
        } else if (res.code === 'region_blocked') {
          // W7 backstop — same treatment as the sign-in branch.
          setRegionBlocked(true);
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
      setError(t('Enter your email above, then tap "Forgot your password?"'));
      return;
    }
    setSubmitting(true);
    try {
      const res = await sei.sendPasswordReset({ email });
      if (res.ok) {
        // Same panel signup lands on. Redeeming a recovery code opens
        // SetNewPasswordModal above this one.
        setCodeSentTo(email);
      } else {
        // rate_limited / network — surface the copy inline; the email field
        // stays filled so the user can retry.
        setError(res.message);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const titleText = mode === 'signin' ? t('Sign in to Sei') : t('Create your Sei account');
  const ctaLabel = submitting
    ? mode === 'signin'
      ? t('Signing in…')
      : t('Creating account…')
    : mode === 'signin'
      ? t('Sign In')
      : t('Create Account');
  const toggleLabel =
    mode === 'signin' ? t('New here? Create an account') : t('Already have an account? Sign in');

  // W7 region gate (260816) — cloud accounts are unavailable from this
  // region, so the whole form is replaced by the blocking message and one
  // acknowledging button. The gate never touches an existing session; this
  // modal only ever fronts signup/sign-in, so blocking it whole is correct.
  if (regionBlocked) {
    return (
      <ModalShell title={titleText} width={460} onClose={onClose}>
        <p className={styles.framing}>
          {t('Our servers do not currently support your region. Please continue with local mode.')}
        </p>
        <ModalFooter>
          <Button kind="accent" size="md" onClick={onClose}>
            {t('Got it')}
          </Button>
        </ModalFooter>
      </ModalShell>
    );
  }

  // 260804 code sub-state. Renders inside the same scrim+modal frame so the
  // user isn't bounced anywhere; only the body changes. ONE panel serves
  // signup, unconfirmed sign-in and password reset, and its copy names none of
  // them (anti-enumeration — see the codeSentTo comment above).
  if (codeSentTo !== null) {
    // Keep the <strong> around the email: translate with the {email}
    // placeholder intact, then split on it and re-insert the styled node.
    const [vBefore, vAfter] = t(
      'We sent a 6-digit code to {email}. Check spam if it is not there.',
    ).split('{email}');
    return (
      <ModalShell
        title={t('Enter your code')}
        width={460}
        escClose={!codeState.submitting}
        onClose={onClose}
      >
        <p className={styles.framing}>
          {vBefore}
          <strong>{codeSentTo}</strong>
          {vAfter}
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
        {codeState.note ? <p className={styles.framing}>{codeState.note}</p> : null}
        <ModalFooter>
          <Button
            kind="accent"
            size="md"
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
          <Button kind="quiet" size="md" onClick={onClose}>
            {t('Back to Sei')}
          </Button>
        </ModalFooter>
      </ModalShell>
    );
  }

  return (
    <>
    <ModalShell title={titleText} width={460} escClose={!submitting} onClose={onClose}>
        {framingLabel ? (
          <p className={styles.framing}>{t('Sign in to {action}', { action: framingLabel })}</p>
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
            <label className={styles.fieldLabel} htmlFor="signin-email">{t('Email')}</label>
            <TextField
              value={email}
              onChange={setEmail}
              placeholder="you@example.com"
              autoFocus
              aria-label={t('Email')}
            />
          </div>

          <div className={styles.fieldGroup}>
            <label className={styles.fieldLabel} htmlFor="signin-password">{t('Password')}</label>
            <TextField
              value={password}
              onChange={setPassword}
              placeholder={mode === 'signup' ? t('At least 8 characters') : ''}
              type="password"
              aria-label={t('Password')}
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
                {/* The links must survive translation, so the sentence is
                    translated with {tos}/{privacy} placeholders intact and the
                    anchor nodes are re-inserted at their positions. */}
                {t('I agree to the {tos} and {privacy}')
                  .split(/(\{tos\}|\{privacy\})/g)
                  .map((part, i) =>
                    part === '{tos}' ? (
                      <a
                        key={i}
                        href="#"
                        onClick={(e) => {
                          e.preventDefault();
                          void sei.openExternal('https://sei.gg/terms.html');
                        }}
                      >
                        {t('Terms of Service')}
                      </a>
                    ) : part === '{privacy}' ? (
                      <a
                        key={i}
                        href="#"
                        onClick={(e) => {
                          e.preventDefault();
                          void sei.openExternal('https://sei.gg/privacy.html');
                        }}
                      >
                        {t('Privacy Policy')}
                      </a>
                    ) : (
                      part
                    ),
                  )}
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
              {t('Forgot your password?')}
            </button>
          ) : null}
        </form>

        <div className={styles.divider}>{t('or')}</div>

        <GoogleSignInButton
          onClick={onGoogleClick}
          disabled={submitting}
          fullWidth
          label={mode === 'signup' ? t('Sign up with Google') : t('Sign in with Google')}
        />

        <ModalFooter>
          <Button kind="quiet" size="md" onClick={onClose} disabled={submitting}>
            {t('Back to Sei')}
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
