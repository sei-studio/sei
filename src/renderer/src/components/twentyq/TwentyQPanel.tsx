/**
 * TwentyQPanel — the 20 Questions surface that slides into the chat screen
 * (260720). CLONED from the Connect4Panel shell (header / pre-game card /
 * result banner / MC-conflict modal) but with NO board: the game itself is
 * the chat, so the body is a status card only (mode, a 20-pip question
 * tracker with guesses as marked pips, the guess list, the running match
 * score, and the round result banner).
 *
 * States, in order of precedence:
 *   - no session yet (panel opened from the games picker) → pre-game setup
 *     card: mode choice (I think of something / companion thinks) + Start;
 *   - round live → status card;
 *   - round over → status card + result banner with New round + Close.
 *
 * Starting while the companion is summoned in Minecraft rejects with
 * TWENTYQ_MC_SESSION_ACTIVE; a confirm modal offers to disconnect the bot
 * and retry.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useTwentyQStore } from '../../lib/stores/useTwentyQStore';
import { useDataStore } from '../../lib/stores/useDataStore';
import { sei } from '../../lib/ipcClient';
import { pickPalette } from '../../lib/portraitPalettes';
import { PixelPortrait } from '../PixelPortrait';
import { Button } from '../Button';
import { Seg } from '../Seg';
import { ModalShell, ModalFooter } from '../ModalShell';
import { TQ_MAX_QUESTIONS, type TQGameState, type TQMode, type TQRoundResult } from '@shared/twentyqIpc';
import styles from './TwentyQPanel.module.css';

export interface TwentyQPanelProps {
  characterId: string;
}

/** Plain-language result copy (no em dashes in user-visible text). */
function resultCopy(result: TQRoundResult, game: TQGameState, name: string): {
  title: string;
  detail: string;
} {
  const title =
    result.winner === 'player' ? 'You won this round' : result.winner === 'character' ? `${name} won this round` : 'Round closed';
  const itWas = result.secret ? ` It was: ${result.secret}.` : '';
  switch (result.reason) {
    case 'guessed':
      return {
        title,
        detail: game.mode === 'guesser' ? `${name} guessed it.${itWas}` : `You guessed it.${itWas}`,
      };
    case 'out-of-questions':
      return {
        title,
        detail:
          game.mode === 'guesser'
            ? `${name} burned all ${TQ_MAX_QUESTIONS} questions and never got it.`
            : `You used all ${TQ_MAX_QUESTIONS} questions.${itWas}`,
      };
    case 'gave-up':
      return { title, detail: `${name} gave this round up.${itWas}` };
    case 'abandoned':
      return { title: 'Round closed', detail: 'This round ended without a result.' };
    default:
      return { title, detail: '' };
  }
}

export function TwentyQPanel({ characterId }: TwentyQPanelProps): React.ReactElement {
  const game = useTwentyQStore((s) => s.games[characterId] ?? null);
  const starting = useTwentyQStore((s) => s.starting[characterId] ?? false);
  const start = useTwentyQStore((s) => s.start);
  const newRound = useTwentyQStore((s) => s.newRound);
  const end = useTwentyQStore((s) => s.end);
  const hydrate = useTwentyQStore((s) => s.hydrate);

  const character = useDataStore((s) => s.characters.find((c) => c.id === characterId));
  const name = character?.name ?? 'Companion';

  const [modeChoice, setModeChoice] = useState<TQMode>('guesser');
  const [startErr, setStartErr] = useState<string | null>(null);
  const [mcConflict, setMcConflict] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);

  // Resume any session main still holds (navigation away and back, relaunch).
  useEffect(() => {
    void hydrate(characterId);
  }, [characterId, hydrate]);

  // Reset transient panel state when switching characters.
  useEffect(() => {
    setStartErr(null);
    setMcConflict(false);
    setConfirmEnd(false);
  }, [characterId]);

  const theme: 'light' | 'dark' =
    (document.documentElement.getAttribute('data-theme') as 'light' | 'dark') ?? 'light';
  const palette = useMemo(
    () => pickPalette((character?.id ?? '') + (character?.name ?? ''), theme),
    [character?.id, character?.name, theme],
  );

  const doStart = async (choice: TQMode): Promise<void> => {
    setStartErr(null);
    try {
      await start(characterId, choice);
    } catch (err) {
      const msg = String((err as { message?: string })?.message ?? err);
      if (/TWENTYQ_MC_SESSION_ACTIVE/.test(msg)) {
        setMcConflict(true);
      } else if (/not available in this build/.test(msg)) {
        setStartErr('20 Questions is not available in this build yet.');
      } else {
        setStartErr("The game couldn't start. Try again in a moment.");
      }
    }
  };

  const onConfirmDisconnect = async (): Promise<void> => {
    setMcConflict(false);
    // Same instant-disconnect path the chat panel uses: flip presence locally,
    // then tear the session down (stop is idempotent).
    useDataStore.getState().setStatus({ kind: 'idle', characterId });
    try {
      await sei.stop(characterId);
    } catch {
      /* already stopped */
    }
    await doStart(modeChoice);
  };

  const onClose = (): void => {
    // A live round with real activity gets an inline confirm; everything else
    // closes immediately.
    if (game && game.status === 'active' && !game.roundOver && game.log.length > 0) {
      setConfirmEnd(true);
      return;
    }
    void end(characterId);
  };

  const statusLine = ((): React.ReactElement | null => {
    if (!game) return null;
    if (game.status === 'ended') return <span className={styles.statusMuted}>Game over</span>;
    if (game.aiBusy) return <span className={styles.thinking}>thinking…</span>;
    if (game.roundOver) return <span className={styles.statusMuted}>Round over</span>;
    return (
      <span className={styles.statusYou}>{game.mode === 'guesser' ? 'Answer in chat' : 'Ask in chat'}</span>
    );
  })();

  const guesses = game ? game.log.filter((e) => e.kind === 'guess') : [];

  return (
    <div className={styles.panel} aria-label={`20 Questions with ${name}`}>
      {/* ── Header ── */}
      <header className={styles.head}>
        <div className={styles.headAvatar}>
          {character ? (
            <PixelPortrait
              seed={character.id + character.name}
              palette={palette}
              size={26}
              portraitImage={character.portrait_image}
              style={{ width: '100%', height: '100%' }}
            />
          ) : null}
        </div>
        <span className={styles.headName}>{name}</span>
        {game ? <span className={styles.headRound}>Round {game.round}</span> : null}
        <span className={styles.headStatus}>{statusLine}</span>
        <button
          type="button"
          className={styles.closeBtn}
          onClick={onClose}
          aria-label="Close 20 Questions"
          title="Close 20 Questions"
        >
          ×
        </button>
      </header>

      {/* ── Body ── */}
      {!game ? (
        <div className={styles.centerCard}>
          <h3 className={styles.cardTitle}>Play 20 Questions with {name}</h3>
          <p className={styles.cardHint}>
            One of you thinks of something, the other has 20 yes/no questions to find it. The whole
            game happens in chat; this panel keeps score.
          </p>
          <div className={styles.modeRow}>
            <Seg<TQMode>
              options={[
                { value: 'guesser', label: 'I think of something' },
                { value: 'keeper', label: `${name} thinks of something` },
              ]}
              value={modeChoice}
              onChange={setModeChoice}
              aria-label="Who thinks of something"
              disabled={starting}
            />
          </div>
          <p className={styles.cardHint}>
            {modeChoice === 'guesser'
              ? `${name} asks the questions and tries to read your mind.`
              : `${name} hides something and answers your questions honestly.`}
          </p>
          {startErr ? <p className={styles.errorText}>{startErr}</p> : null}
          <div className={styles.cardActions}>
            <Button kind="quiet" size="md" onClick={() => void end(characterId)}>
              Not now
            </Button>
            <Button kind="accent" size="md" disabled={starting} onClick={() => void doStart(modeChoice)}>
              {starting ? 'Starting…' : 'Start game'}
            </Button>
          </div>
        </div>
      ) : (
        <div className={styles.main}>
          <div className={styles.statusCard}>
            <p className={styles.modeLine}>
              {game.mode === 'guesser'
                ? `You are thinking of something. ${name} is guessing.`
                : `${name} is thinking of something. You are guessing.`}
            </p>

            {/* 20-pip question tracker */}
            <div className={styles.pipBlock}>
              <div className={styles.pipLabelRow}>
                <span className={styles.pipLabel}>Questions</span>
                <span className={styles.pipCount}>
                  {game.questionsUsed}/{TQ_MAX_QUESTIONS}
                </span>
              </div>
              <div className={styles.pips} role="img" aria-label={`${game.questionsUsed} of ${TQ_MAX_QUESTIONS} questions used`}>
                {Array.from({ length: TQ_MAX_QUESTIONS }, (_, i) => {
                  const entry = game.log[i];
                  const cls = !entry
                    ? styles.pip
                    : entry.kind === 'guess'
                      ? `${styles.pip} ${styles.pipGuess}`
                      : `${styles.pip} ${styles.pipUsed}`;
                  return <span key={i} className={cls} title={entry?.text ?? undefined} />;
                })}
              </div>
              {game.mode === 'guesser' ? (
                <p className={styles.pipHint}>A guess costs a question. Marked pips are guesses.</p>
              ) : null}
            </div>

            {/* Explicit guesses (marked moments) */}
            {guesses.length > 0 ? (
              <div className={styles.guessBlock}>
                <span className={styles.guessTitle}>Guesses</span>
                <ul className={styles.guessList}>
                  {guesses.map((g, i) => (
                    <li key={i} className={styles.guessItem}>
                      {g.text}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {/* Match score */}
            <p className={styles.scoreLine}>
              Rounds won: you {game.score.player}, {name} {game.score.character}
            </p>

            {/* Result banner */}
            {game.roundOver && game.result ? (
              <ResultBanner result={game.result} game={game} name={name} />
            ) : null}

            {/* Controls */}
            {game.roundOver || confirmEnd ? (
              <div className={styles.controls}>
                {confirmEnd ? (
                  <span className={styles.endConfirm}>
                    <span className={styles.endLabel}>End the game?</span>
                    <Button
                      kind="danger"
                      size="sm"
                      onClick={() => {
                        setConfirmEnd(false);
                        void end(characterId);
                      }}
                    >
                      Yes
                    </Button>
                    <Button kind="quiet" size="sm" onClick={() => setConfirmEnd(false)}>
                      No
                    </Button>
                  </span>
                ) : (
                  <>
                    <Button kind="accent" size="sm" onClick={() => void newRound(characterId)}>
                      New round
                    </Button>
                    <Button kind="quiet" size="sm" onClick={() => void end(characterId)}>
                      Close
                    </Button>
                  </>
                )}
              </div>
            ) : null}
          </div>
        </div>
      )}

      {/* ── Minecraft-session conflict confirm ── */}
      {mcConflict ? (
        <ModalShell
          title={`${name} is in Minecraft`}
          onClose={() => setMcConflict(false)}
          scrimClose
          tier="stacked"
        >
          <p className={styles.modalBody}>
            {name} is playing in a Minecraft world right now. Disconnect them from the world to
            start a round of 20 Questions?
          </p>
          <ModalFooter>
            <Button kind="quiet" size="md" onClick={() => setMcConflict(false)}>
              Cancel
            </Button>
            <Button kind="primary" size="md" onClick={() => void onConfirmDisconnect()}>
              Disconnect and play
            </Button>
          </ModalFooter>
        </ModalShell>
      ) : null}
    </div>
  );
}

function ResultBanner({
  result,
  game,
  name,
}: {
  result: TQRoundResult;
  game: TQGameState;
  name: string;
}): React.ReactElement {
  const { title, detail } = resultCopy(result, game, name);
  return (
    <div
      className={[
        styles.result,
        result.winner === null
          ? styles.resultDraw
          : result.winner === 'player'
            ? styles.resultWin
            : styles.resultLoss,
      ].join(' ')}
    >
      <div className={styles.resultTitle}>{title}</div>
      <div className={styles.resultDetail}>{detail}</div>
    </div>
  );
}
