/**
 * FeedbackModal — the standing "Submit feedback" form (260706).
 *
 * Opened from the plan screen after the one-time reward banner has been
 * used (and anywhere else a feedback entry point makes sense). Email is
 * optional: leaving it blank submits fully anonymously (the proxy stores no
 * user id on the row). Server-side the proxy caps submissions at 20/day per
 * account; the 429 surfaces here as honest daily-limit copy.
 *
 * Form scaffolding cloned from SetNewPasswordModal (fields / error / done
 * sub-state swap); renders through ModalShell.
 *
 * 261109 (T379): with `onKnownGame` (the games picker's Suggest a game), a
 * line under the field says when the typed game already works in Sei, with a
 * button into it. Players kept suggesting "roblox" with the Roblox tile one
 * row up. The lookup is our own catalog (shared/knownGame.ts), debounced so
 * "draw" on the way to "drawing" does not flash. Submitting stays possible.
 * Analytics: `suggest_game_hint_shown {game}` once per game per form,
 * `suggest_game_hint_clicked {game, has_query}`, and the submit events carry
 * `form` + `game_hint_shown` (main, feedbackSubmit.ts). Never the text.
 */

import React, { useEffect, useRef, useState } from 'react';
import { sei } from '../lib/ipcClient';
import { clearFeedbackDraft, getFeedbackDraft, setFeedbackDraft } from '../lib/feedbackDraft';
import { useT } from '../lib/i18n';
import { matchKnownGame, type KnownGameMatch } from '@shared/knownGame';
import { Button } from './Button';
import { ModalShell, ModalFooter } from './ModalShell';
import { TextField } from './TextField';
import styles from './FeedbackModal.module.css';

function submitErrorCopy(code: string): string {
  switch (code) {
    case 'PROXY_RATE_LIMITED':
      return 'Daily feedback limit reached. Try again tomorrow.';
    case 'PROXY_NO_SESSION':
      return 'Sign in to submit feedback.';
    default:
      return 'Feedback could not be sent. Your message is still here. Check your connection and press Submit to try again.';
  }
}

export interface FeedbackModalProps {
  /** Closes the modal. Caller controls mount/unmount. */
  onClose: () => void;
  /** Optional copy overrides (e.g. the games picker's "Suggest a game").
   * The submit path is identical regardless. Empty framing hides the line. */
  title?: string;
  framing?: string;
  fieldLabel?: string;
  placeholder?: string;
  /** One extra line on the "Feedback sent" confirmation (261023: the games
   * picker points a game wish at Backseat, which already covers any game). */
  doneNote?: string;
  /** Turns on the "already works in Sei" hint (Suggest a game): opens the
   *  matched game. The caller closes this form. */
  onKnownGame?: (match: KnownGameMatch) => void;
  /** Analytics: which form this is (sent with the submit events). */
  form?: 'suggest_game';
}

/** Typing pause before the hint follows the text. */
export const GAME_HINT_DEBOUNCE_MS = 350;

export function FeedbackModal({
  onClose,
  title = 'Submit feedback',
  framing = "Tell us anything you like or don't like! We read all comments within 24 hrs.",
  fieldLabel = 'Feedback',
  placeholder = 'What should we improve?',
  doneNote,
  onKnownGame,
  form,
}: FeedbackModalProps): React.ReactElement {
  const t = useT();
  const [email, setEmail] = useState('');
  // 260926: the draft outlives the modal, so a failed send followed by a
  // close does not lose the text. Keyed by title: "Suggest a game" and
  // "Submit feedback" are separate drafts.
  const draftKey = `modal:${title}`;
  const [body, setBodyState] = useState(() => getFeedbackDraft(draftKey));
  const setBody = (v: string): void => {
    setBodyState(v);
    setFeedbackDraft(draftKey, v);
  };
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // The hint follows the text after a short pause; a restored draft is
  // checked at once.
  const [hintText, setHintText] = useState(body);
  useEffect(() => {
    if (!onKnownGame) return;
    const id = window.setTimeout(() => setHintText(body), GAME_HINT_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [body, onKnownGame]);
  const knownGame = onKnownGame ? matchKnownGame(hintText) : null;
  const hintedGames = useRef(new Set<string>());
  const knownGameId = knownGame?.gameId;
  useEffect(() => {
    if (!knownGameId || hintedGames.current.has(knownGameId)) return;
    hintedGames.current.add(knownGameId);
    sei.track('suggest_game_hint_shown', { game: knownGameId });
  }, [knownGameId]);

  const canSubmit = body.trim().length > 0 && !submitting;

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setSubmitting(true);
    try {
      const trimmedEmail = email.trim();
      const res = await sei.feedbackSubmit({
        body: body.trim(),
        ...(trimmedEmail ? { email: trimmedEmail } : {}),
        ...(form ? { form, gameHintShown: hintedGames.current.size > 0 } : {}),
      });
      if (res.ok) {
        clearFeedbackDraft(draftKey);
        setDone(true);
      } else {
        setError(submitErrorCopy(res.code));
      }
    } catch {
      setError(submitErrorCopy('PROXY_NETWORK'));
    } finally {
      setSubmitting(false);
    }
  };

  if (done) return <FeedbackSent onClose={onClose} note={doneNote} />;

  return (
    <ModalShell title={t(title)} onClose={onClose} scrimClose width={440}>
      {framing ? <p className={styles.framing}>{t(framing)}</p> : null}
      <form className={styles.form} onSubmit={handleSubmit}>
        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel} htmlFor="feedback-email">
            {t('Email (optional, leave blank to stay anonymous)')}
          </label>
          <TextField
            value={email}
            onChange={setEmail}
            placeholder="you@example.com"
            aria-label={t('Email, optional')}
          />
        </div>
        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel} htmlFor="feedback-body">
            {t(fieldLabel)}
          </label>
          <TextField
            value={body}
            onChange={setBody}
            multiline
            rows={5}
            autoFocus
            placeholder={t(placeholder)}
            aria-label={t(fieldLabel)}
          />
          {knownGame && onKnownGame ? (
            <div className={styles.gameHint} role="status">
              <span className={styles.gameHintText}>
                {t('{game} already works in Sei', { game: t(knownGame.name) })}
              </span>
              <Button
                kind="secondary"
                size="sm"
                type="button"
                onClick={() => {
                  sei.track('suggest_game_hint_clicked', {
                    game: knownGame.gameId,
                    has_query: !!knownGame.query,
                  });
                  onKnownGame(knownGame);
                }}
              >
                {t('Play {game}', { game: t(knownGame.name) })}
              </Button>
            </div>
          ) : null}
        </div>
        {error ? (
          <p className={styles.errorText} role="alert">
            {t(error)}
          </p>
        ) : null}
        <ModalFooter>
          <Button kind="ghost" size="md" onClick={onClose} type="button">
            {t('Cancel')}
          </Button>
          <Button kind="accent" size="md" type="submit" disabled={!canSubmit}>
            {submitting ? t('Sending…') : t('Submit')}
          </Button>
        </ModalFooter>
      </form>
    </ModalShell>
  );
}

/** The confirmation that replaces the form after a successful send. */
export function FeedbackSent({ onClose, note }: { onClose: () => void; note?: string }): React.ReactElement {
  const t = useT();
  return (
    <ModalShell title={t('Feedback sent')} onClose={onClose} scrimClose width={440}>
      <p className={styles.framing}>{t('Thank you. We read all comments within 24 hrs.')}</p>
      {note ? <p className={styles.framing}>{t(note)}</p> : null}
      <ModalFooter>
        <Button kind="accent" size="md" onClick={onClose}>
          {t('Close')}
        </Button>
      </ModalFooter>
    </ModalShell>
  );
}
