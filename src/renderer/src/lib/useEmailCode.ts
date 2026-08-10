/**
 * useEmailCode — shared state machine for the "enter the code we emailed you"
 * panel (260804).
 *
 * Four surfaces show that panel (AuthChoiceScreen, SignInModal, the onboarding
 * AuthPanel, and the Settings verify row), and they differ only in chrome. The
 * behaviour they must NOT differ in is the part that carries the security
 * property: the panel is identical whether the address was new or already
 * registered, and nothing it can display distinguishes them. Keeping the logic
 * in one hook is what keeps that true as the surfaces drift apart visually.
 *
 * The hook owns entry, redemption, resend and their copy. Callers own layout.
 */
import { useCallback, useRef, useState } from 'react';
import { sei } from './ipcClient';
import { useT } from './i18n';
import { useAuthStore } from './stores/useAuthStore';

export interface EmailCodeState {
  code: string;
  setCode: (v: string) => void;
  /** Inline failure for the code itself. */
  error: string | null;
  /** Status line for the resend affordance ("Sent.", rate-limit copy). */
  note: string | null;
  submitting: boolean;
  resending: boolean;
  /** Redeem. Pass a value to submit something other than current state. */
  submit: (candidate?: string) => Promise<void>;
  resend: () => Promise<void>;
  /** Clear entry state when the panel is dismissed or re-armed. */
  reset: () => void;
}

/**
 * @param email address the code was sent to. Null disables submission — the
 *              panel should not be mounted without one.
 * @param onVerified called after a successful redemption that is NOT a password
 *              recovery. Recovery redemptions are routed by App.tsx's
 *              SetNewPasswordModal instead, so a caller that closes itself here
 *              would tear the modal's host out from under it.
 */
export function useEmailCode(email: string | null, onVerified?: () => void): EmailCodeState {
  const t = useT();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [resending, setResending] = useState(false);
  const setPasswordRecovery = useAuthStore((s) => s.setPasswordRecovery);
  // CodeInput fires onComplete on arrival at a full code; a slow round trip
  // plus a corrected digit could otherwise overlap two redemptions.
  const inFlight = useRef(false);

  const submit = useCallback(
    async (candidate?: string): Promise<void> => {
      const value = (candidate ?? code).replace(/\D/g, '');
      if (!email || value.length === 0 || inFlight.current) return;
      inFlight.current = true;
      setError(null);
      setNote(null);
      setSubmitting(true);
      try {
        const res = await sei.verifyEmailCode({ email, code: value });
        if (res.ok) {
          if (res.recovery) {
            // Main already pushed auth:password-recovery; this is the belt to
            // that braces, for the documented case where the push fails.
            setPasswordRecovery(true);
          } else {
            onVerified?.();
          }
          return;
        }
        setError(res.message);
        // Wrong code: clear so the next attempt starts from an empty field
        // rather than requiring six backspaces. A network failure keeps the
        // digits, because retyping a correct code helps nobody.
        if (res.code === 'invalid_code') setCode('');
      } catch (err) {
        setError((err as Error).message || t("Couldn't check that code. Try again."));
      } finally {
        inFlight.current = false;
        setSubmitting(false);
      }
    },
    [code, email, onVerified, setPasswordRecovery, t],
  );

  const resend = useCallback(async (): Promise<void> => {
    if (!email || resending) return;
    setResending(true);
    setNote(null);
    setError(null);
    try {
      const res = await sei.resendVerification({ email });
      setNote(res.ok ? t('Sent. Give it a minute, and check spam too.') : res.message);
    } catch {
      setNote(t("Couldn't send a new code. Try again in a moment."));
    } finally {
      setResending(false);
    }
  }, [email, resending, t]);

  const reset = useCallback((): void => {
    setCode('');
    setError(null);
    setNote(null);
  }, []);

  return { code, setCode, error, note, submitting, resending, submit, resend, reset };
}
