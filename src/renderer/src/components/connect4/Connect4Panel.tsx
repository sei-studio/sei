/**
 * Connect4Panel — the Connect 4 surface that slides into the chat screen
 * (260720). CLONED from the ChessPanel shell (header / pre-game card / live
 * board / result banner / MC-conflict modal), minus the chess extras: no
 * engine download state, no draw offers, no move-list scrubbing, no flip.
 *
 * States, in order of precedence:
 *   - no game yet (panel opened from the games picker) → pre-game setup card:
 *     turn-order choice (First / Random / Second) + Start;
 *   - status 'active' → live board + status + resign (inline confirm);
 *   - status 'ended' → compact result banner with Rematch + Close.
 *
 * The AI move reveal is paced by useAiDropReveal (commentary first, then the
 * disc falls). Starting while the companion is summoned in Minecraft rejects
 * with CONNECT4_MC_SESSION_ACTIVE; a confirm modal offers to disconnect the
 * bot and retry.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useConnect4Store } from '../../lib/stores/useConnect4Store';
import { useDataStore } from '../../lib/stores/useDataStore';
import { sei } from '../../lib/ipcClient';
import { pickPalette } from '../../lib/portraitPalettes';
import { PixelPortrait } from '../PixelPortrait';
import { Button } from '../Button';
import { Seg } from '../Seg';
import { ModalShell, ModalFooter } from '../ModalShell';
import { Connect4Board } from './Connect4Board';
import { useAiDropReveal } from './useAiDropReveal';
import type { C4GameState, C4Result } from '@shared/connect4Ipc';
import styles from './Connect4Panel.module.css';

export interface Connect4PanelProps {
  characterId: string;
}

type OrderChoice = 'r' | 'y' | 'random';

/** Plain-language result copy (no em dashes in user-visible text). */
function resultCopy(result: C4Result, game: C4GameState, name: string): {
  title: string;
  detail: string;
} {
  const playerWon = result.winner !== null && result.winner === game.playerColor;
  const title = result.winner === null ? 'Draw' : playerWon ? 'You won' : `${name} won`;
  switch (result.reason) {
    case 'connect':
      return { title, detail: 'Four in a row.' };
    case 'draw-full':
      return { title: 'Draw', detail: 'The board filled up with no four in a row.' };
    case 'resign':
      return { title, detail: `You resigned. ${name} takes the game.` };
    case 'forfeit':
      return { title, detail: `${name} forfeited the game.` };
    case 'abandoned':
      return { title: 'Game closed', detail: 'This game ended without a result.' };
    default:
      return { title, detail: '' };
  }
}

export function Connect4Panel({ characterId }: Connect4PanelProps): React.ReactElement {
  const game = useConnect4Store((s) => s.games[characterId] ?? null);
  const starting = useConnect4Store((s) => s.starting[characterId] ?? false);
  const start = useConnect4Store((s) => s.start);
  const resign = useConnect4Store((s) => s.resign);
  const rematch = useConnect4Store((s) => s.rematch);
  const end = useConnect4Store((s) => s.end);
  const hydrate = useConnect4Store((s) => s.hydrate);

  const character = useDataStore((s) => s.characters.find((c) => c.id === characterId));
  const name = character?.name ?? 'Companion';

  const [orderChoice, setOrderChoice] = useState<OrderChoice>('random');
  const [startErr, setStartErr] = useState<string | null>(null);
  const [mcConflict, setMcConflict] = useState(false);
  const [confirmResign, setConfirmResign] = useState(false);

  useAiDropReveal(characterId);

  // Resume any game main still holds (navigation away and back, relaunch).
  useEffect(() => {
    void hydrate(characterId);
  }, [characterId, hydrate]);

  // Reset transient panel state when switching characters.
  useEffect(() => {
    setStartErr(null);
    setMcConflict(false);
    setConfirmResign(false);
  }, [characterId]);

  const theme: 'light' | 'dark' =
    (document.documentElement.getAttribute('data-theme') as 'light' | 'dark') ?? 'light';
  const palette = useMemo(
    () => pickPalette((character?.id ?? '') + (character?.name ?? ''), theme),
    [character?.id, character?.name, theme],
  );

  const doStart = async (choice: OrderChoice): Promise<void> => {
    setStartErr(null);
    try {
      await start(characterId, choice);
    } catch (err) {
      const msg = String((err as { message?: string })?.message ?? err);
      if (/CONNECT4_MC_SESSION_ACTIVE/.test(msg)) {
        setMcConflict(true);
      } else if (/not available in this build/.test(msg)) {
        setStartErr('Connect 4 is not available in this build yet.');
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
    await doStart(orderChoice);
  };

  const statusLine = ((): React.ReactElement | null => {
    if (!game) return null;
    if (game.status === 'ended') return <span className={styles.statusMuted}>Game over</span>;
    if (game.aiThinking) return <span className={styles.thinking}>thinking…</span>;
    if (game.turn === game.playerColor) return <span className={styles.statusYou}>Your move</span>;
    return <span className={styles.statusMuted}>Waiting</span>;
  })();

  const discLabel = (color: 'r' | 'y'): string => (color === 'r' ? 'red' : 'yellow');

  return (
    <div className={styles.panel} aria-label={`Connect 4 with ${name}`}>
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
        {game ? <span className={styles.headLevel}>Level {game.aiStrength}/5</span> : null}
        <span className={styles.headStatus}>{statusLine}</span>
        {!game || game.status !== 'active' ? (
          <button
            type="button"
            className={styles.closeBtn}
            onClick={() => void end(characterId)}
            aria-label="Close Connect 4"
            title="Close Connect 4"
          >
            ×
          </button>
        ) : null}
      </header>

      {/* ── Body ── */}
      {!game ? (
        <div className={styles.centerCard}>
          <h3 className={styles.cardTitle}>Play Connect 4 with {name}</h3>
          <p className={styles.cardHint}>
            Drop discs, connect four in a row. {name} will talk while you play, and you can chat
            back anytime.
          </p>
          <div className={styles.orderRow}>
            <Seg<OrderChoice>
              options={[
                { value: 'r', label: 'I go first' },
                { value: 'random', label: 'Random' },
                { value: 'y', label: `${name} first` },
              ]}
              value={orderChoice}
              onChange={setOrderChoice}
              aria-label="Turn order"
              disabled={starting}
            />
          </div>
          {startErr ? <p className={styles.errorText}>{startErr}</p> : null}
          <div className={styles.cardActions}>
            <Button kind="quiet" size="md" onClick={() => void end(characterId)}>
              Not now
            </Button>
            <Button
              kind="accent"
              size="md"
              disabled={starting}
              onClick={() => void doStart(orderChoice)}
            >
              {starting ? 'Starting…' : 'Start game'}
            </Button>
          </div>
        </div>
      ) : (
        <div className={styles.main}>
          <div className={styles.boardArea}>
            <div className={styles.boardBox}>
              <Connect4Board characterId={characterId} />
            </div>
          </div>

          <div className={styles.underBoard}>
            <span className={styles.seatNote}>
              You play {discLabel(game.playerColor)}. {name} plays{' '}
              {discLabel(game.playerColor === 'r' ? 'y' : 'r')}. Red moves first.
            </span>

            {/* Result banner */}
            {game.status === 'ended' && game.result ? (
              <ResultBanner result={game.result} game={game} name={name} />
            ) : null}

            {/* Controls */}
            <div className={styles.controls}>
              {game.status === 'active' ? (
                confirmResign ? (
                  <span className={styles.resignConfirm}>
                    <span className={styles.resignLabel}>Resign?</span>
                    <Button
                      kind="danger"
                      size="sm"
                      onClick={() => {
                        setConfirmResign(false);
                        void resign(characterId);
                      }}
                    >
                      Yes
                    </Button>
                    <Button kind="quiet" size="sm" onClick={() => setConfirmResign(false)}>
                      No
                    </Button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className={`${styles.ctrlBtn} ${styles.ctrlDanger}`}
                    onClick={() => setConfirmResign(true)}
                  >
                    Resign
                  </button>
                )
              ) : null}
              {game.status === 'ended' ? (
                <>
                  <Button kind="accent" size="sm" onClick={() => void rematch(characterId)}>
                    Rematch
                  </Button>
                  <Button kind="quiet" size="sm" onClick={() => void end(characterId)}>
                    Close
                  </Button>
                </>
              ) : null}
            </div>
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
            start a Connect 4 game?
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
  result: C4Result;
  game: C4GameState;
  name: string;
}): React.ReactElement {
  const { title, detail } = resultCopy(result, game, name);
  const playerWon = result.winner !== null && result.winner === game.playerColor;
  return (
    <div
      className={[
        styles.result,
        result.winner === null ? styles.resultDraw : playerWon ? styles.resultWin : styles.resultLoss,
      ].join(' ')}
    >
      <div className={styles.resultTitle}>{title}</div>
      <div className={styles.resultDetail}>{detail}</div>
    </div>
  );
}
