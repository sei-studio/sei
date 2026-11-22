/**
 * CONNECT4Panel â€” the Forza 4 surface that slides into the chat screen.
 *
 * States:
 *   - launch screen (no game yet, or Rematch clicked after a finished game):
 *     "Forza 4" title, the inline Red / Yellow / Random side picker, one
 *     primary button ("Launch" / "Start").
 *   - status 'active' / 'ended': the 6x7 board fills the panel edge to edge
 *     and everything else floats over it as a de-boxed HUD:
 *       top-left   turn label + icon controls (resign)
 *       center     result + Rematch when the game ends
 *     Closing goes through the unified GameSurface "x".
 *
 * Contract: src/shared/connect4Ipc.ts + src/main/connect4/connect4Service.ts.
 */

import React, { useEffect, useState } from 'react';
import { useConnect4Store } from '../../lib/stores/useConnect4Store';
import { useDataStore } from '../../lib/stores/useDataStore';
import { requestGameLaunch } from '../../lib/gameLaunch';
import { useT } from '../../lib/i18n';
import { Button } from '../Button';
import type { CONNECT4Color, CONNECT4GameState } from '@shared/connect4Ipc';
import styles from './CONNECT4Panel.module.css';

export interface CONNECT4PanelProps {
  characterId: string;
}

type SideChoice = 'r' | 'y' | 'random';

const SIDE_OPTIONS: Array<{ value: SideChoice; label: string }> = [
  { value: 'r', label: 'Red' },
  { value: 'y', label: 'Yellow' },
  { value: 'random', label: 'Random' },
];

function columnFull(board: CONNECT4GameState['board'], c: number): boolean {
  for (let r = 0; r < board.length; r++) if (board[r][c] === null) return false;
  return true;
}

export function CONNECT4Panel({ characterId }: CONNECT4PanelProps): React.ReactElement {
  const t = useT();
  const game = useConnect4Store((s) => s.games[characterId] ?? null);
  const starting = useConnect4Store((s) => s.starting[characterId] ?? false);
  const start = useConnect4Store((s) => s.start);
  const move = useConnect4Store((s) => s.move);
  const resign = useConnect4Store((s) => s.resign);
  const rematch = useConnect4Store((s) => s.rematch);
  const end = useConnect4Store((s) => s.end);
  const hydrate = useConnect4Store((s) => s.hydrate);

  const character = useDataStore((s) => s.characters.find((c) => c.id === characterId));
  const name = character?.name ?? t('Companion');

  const [colorChoice, setColorChoice] = useState<SideChoice>('random');
  const [startErr, setStartErr] = useState<string | null>(null);
  const [confirmResign, setConfirmResign] = useState(false);
  /** Rematch clicked on a finished game: show the launch layout again. */
  const [rematchScreen, setRematchScreen] = useState(false);

  // Resume any game main still holds (navigation away and back, relaunch).
  useEffect(() => {
    void hydrate(characterId);
  }, [characterId, hydrate]);

  // Reset transient panel state when switching characters.
  useEffect(() => {
    setStartErr(null);
    setConfirmResign(false);
    setRematchScreen(false);
  }, [characterId]);

  const gameStatus = game?.status ?? null;
  useEffect(() => {
    if (gameStatus === 'active') setRematchScreen(false);
  }, [gameStatus]);

  const doStart = async (choice: SideChoice): Promise<void> => {
    setStartErr(null);
    try {
      await start(characterId, choice);
    } catch (err) {
      const msg = String((err as { message?: string })?.message ?? err);
      if (/not available in this build/.test(msg)) {
        setStartErr(t('Forza 4 is not available in this build yet.'));
      } else {
        setStartErr(t("The game couldn't start. Try again in a moment."));
      }
    }
  };

  const onCellClick = (column: number): void => {
    if (!game || game.status !== 'active') return;
    if (game.turn !== game.playerColor) return;
    if (columnFull(game.board, column)) return;
    void move(characterId, column);
  };

  const showLaunch = !game || game.status === 'ended' && rematchScreen;

  const playerColor = game?.playerColor ?? 'r';
  const isPlayerTurn = game ? game.turn === game.playerColor : false;

  return (
    <div className={styles.panel} aria-label={t('Forza 4 with {name}', { name })}>
      {showLaunch ? (
        <div className={styles.launch}>
          <h3 className={styles.launchTitle}>{t('Forza 4')}</h3>
          <div className={styles.sideRow} role="radiogroup" aria-label={t('Your side')}>
            {SIDE_OPTIONS.map((opt, i) => (
              <React.Fragment key={opt.value}>
                {i > 0 ? <span className={styles.sideSep} aria-hidden="true">/</span> : null}
                <button
                  type="button"
                  role="radio"
                  aria-checked={colorChoice === opt.value}
                  className={
                    colorChoice === opt.value
                      ? `${styles.sideBtn} ${styles.sideBtnActive}`
                      : styles.sideBtn
                  }
                  disabled={starting}
                  onClick={() => setColorChoice(opt.value)}
                >
                  {t(opt.label)}
                </button>
              </React.Fragment>
            ))}
          </div>
          {startErr ? (
            <p className={styles.launchError} role="alert">{startErr}</p>
          ) : null}
          <Button
            kind="accent"
            size="md"
            disabled={starting}
            onClick={() =>
              requestGameLaunch(characterId, { id: 'CONNECT4', name: 'Forza 4' }, () =>
                void doStart(colorChoice),
              )
            }
          >
            {starting ? t('Startingâ€¦') : rematchScreen ? t('Start') : t('Launch')}
          </Button>
        </div>
      ) : game ? (
        <div className={styles.stage}>
          <div className={styles.boardWrap}>
            <div className={styles.board}>
              {game.board.map((row, r) =>
                row.map((cell, c) => {
                  const full = columnFull(game.board, c);
                  const disabled =
                    game.status !== 'active' || game.turn !== game.playerColor || full;
                  return (
                    <button
                      key={`${r}-${c}`}
                      type="button"
                      className={[
                        styles.cell,
                        full ? styles.full : '',
                        disabled ? styles.disabled : '',
                      ].join(' ')}
                      disabled={disabled}
                      onClick={() => onCellClick(c)}
                      aria-label={
                        cell === null
                          ? t('Empty cell, row {r}, column {c}', { r: r + 1, c: c + 1 })
                          : cell === 'r'
                            ? t('Red piece')
                            : t('Yellow piece')
                      }
                    >
                      {cell === 'r' ? (
                        <span className={`${styles.piece} ${styles.red}`} aria-hidden="true" />
                      ) : cell === 'y' ? (
                        <span className={`${styles.piece} ${styles.yellow}`} aria-hidden="true" />
                      ) : null}
                    </button>
                  );
                }),
              )}
            </div>
          </div>

          <div className={styles.hud}>
            <div className={styles.turnLabel}>
              {isPlayerTurn
                ? t("It's your turn, {name}", { name })
                : t("{name}'s turn", { name })}
            </div>

            <div className={styles.controls}>
              {confirmResign ? (
                <span className={styles.resignConfirm}>
                  <span className={styles.resignLabel}>{t('Resign?')}</span>
                  <Button kind="danger" size="sm" onClick={() => { setConfirmResign(false); void resign(characterId); }}>
                    {t('Yes')}
                  </Button>
                  <Button kind="quiet" size="sm" onClick={() => setConfirmResign(false)}>
                    {t('No')}
                  </Button>
                </span>
              ) : (
                <button
                  type="button"
                  className={`${styles.ctrlBtn} ${styles.ctrlDanger}`}
                  onClick={() => setConfirmResign(true)}
                  aria-label={t('Resign')}
                  data-tip={t('Resign')}
                >
                  {t('Resign')}
                </button>
              )}
            </div>
          </div>

          {game.status === 'ended' && game.result ? (
            <div className={styles.resultWrap}>
              <div className={styles.resultTitle}>
                {game.result.winner === null
                  ? t('Draw')
                  : game.result.winner === game.playerColor
                    ? t('You won')
                    : t('{name} won', { name })}
              </div>
              <div className={styles.resultDetail}>
                {game.result.reason === 'connect-four'
                  ? t('Four in a row.')
                  : game.result.reason === 'draw'
                    ? t('The board is full.')
                    : t('This game ended without a result.')}
              </div>
              <div className={styles.resultActions}>
                <Button kind="accent" size="md" onClick={() => setRematchScreen(true)}>
                  {t('Rematch')}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}




