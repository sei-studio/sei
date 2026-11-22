/**
 * BATTLESHIPPanel â€” the Battleship surface that slides into the
 * chat screen.
 *
 * States:
 *   - launch screen (no game yet, or Rematch clicked after a finished game):
 *     "Battleship" title, one primary button ("Launch" / "Start").
 *   - status 'active' / 'ended': two 10x10 grids (player ships visible, AI
 *     shots hidden) plus turn label and resign control. Result + Rematch
 *     when the game ends.
 *
 * Contract: src/shared/battleshipIpc.ts +
 * src/main/battleship/battleshipService.ts.
 */
 
import React, { useEffect, useState } from 'react';
import { useBattleshipStore } from '../../lib/stores/useBattleshipStore';
import { useDataStore } from '../../lib/stores/useDataStore';
import { requestGameLaunch } from '../../lib/gameLaunch';
import { useT } from '../../lib/i18n';
import { Button } from '../Button';
import type { BATTLESHIPGameState } from '@shared/battleshipIpc';
import styles from './BattleshipPanel.module.css';

export interface BattleshipPanelProps {
  characterId: string;
}

function cellLabel(r: number, c: number): string {
  return `Empty cell, row ${r + 1}, column ${c + 1}`;
}

export function BattleshipPanel({ characterId }: BattleshipPanelProps): React.ReactElement {
  const t = useT();
  const game = useBattleshipStore((s) => s.games[characterId] ?? null);
  const starting = useBattleshipStore((s) => s.starting[characterId] ?? false);
  const start = useBattleshipStore((s) => s.start);
  const move = useBattleshipStore((s) => s.move);
  const resign = useBattleshipStore((s) => s.resign);
  const rematch = useBattleshipStore((s) => s.rematch);
  const end = useBattleshipStore((s) => s.end);
  const hydrate = useBattleshipStore((s) => s.hydrate);

  const character = useDataStore((s) => s.characters.find((c) => c.id === characterId));
  const name = character?.name ?? t('Companion');

  const [startErr, setStartErr] = useState<string | null>(null);
  const [confirmResign, setConfirmResign] = useState(false);
  const [rematchScreen, setRematchScreen] = useState(false);

  useEffect(() => {
    void hydrate(characterId);
  }, [characterId, hydrate]);

  useEffect(() => {
    setStartErr(null);
    setConfirmResign(false);
    setRematchScreen(false);
  }, [characterId]);

  const gameStatus = game?.status ?? null;
  useEffect(() => {
    if (gameStatus === 'active') setRematchScreen(false);
  }, [gameStatus]);

  const doStart = async (): Promise<void> => {
    setStartErr(null);
    try {
      await start(characterId);
    } catch (err) {
      const msg = String((err as { message?: string })?.message ?? err);
      if (/not available in this build/.test(msg)) {
        setStartErr(t('Battleship is not available in this build yet.'));
      } else {
        setStartErr(t("The game couldn't start. Try again in a moment."));
      }
    }
  };

  const onCellClick = (row: number, col: number): void => {
    if (!game || game.status !== 'active') return;
    if (game.turn !== 'player') return;
    const already = game.aiVisibleGrid.cells?.[row]?.[col] !== null;
    if (already) return;
    void move(characterId, row, col);
  };

  const showLaunch = !game || (game.status === 'ended' && rematchScreen);

  const isPlayerTurn = game ? game.turn === 'player' : false;

  return (
    <div className={styles.panel} aria-label={t('Battleship con {name}', { name })}>
      {showLaunch ? (
        <div className={styles.launch}>
          <h3 className={styles.launchTitle}>{t('Battleship')}</h3>
          {startErr ? (
            <p className={styles.launchError} role="alert">{startErr}</p>
          ) : null}
          <Button
            kind="accent"
            size="md"
            disabled={starting}
            onClick={() =>
              requestGameLaunch(characterId, { id: 'BATTLESHIP', name: 'Battleship' }, () =>
                void doStart(),
              )
            }
          >
            {starting ? t('Startingâ€¦') : rematchScreen ? t('Start') : t('Launch')}
          </Button>
        </div>
      ) : game ? (
        <div className={styles.stage}>
          <div className={styles.grids}>
            <div className={styles.gridWrap}>
              <div className={styles.gridTitle}>{t('Your ships')}</div>
              <div className={styles.grid}>
                {game.playerGrid.cells.map((row, r) =>
                  row.map((cell, c) => (
                    <button
                      key={`p-${r}-${c}`}
                      type="button"
                      className={[
                        styles.cell,
                        cell === 'ship' ? styles.ship : '',
                        cell === 'hit' ? styles.hit : '',
                        cell === 'miss' ? styles.miss : '',
                      ].join(' ')}
                      disabled
                      aria-label={cellLabel(r, c)}
                    />
                  )),
                )}
              </div>
            </div>
            <div className={styles.gridWrap}>
              <div className={styles.gridTitle}>{t("Enemy grid")}</div>
              <div className={styles.grid}>
                {game.aiVisibleGrid.cells.map((row, r) =>
                  row.map((cell, c) => {
                    const disabled =
                      game.status !== 'active' || game.turn !== 'player' || cell !== null;
                    return (
                      <button
                        key={`a-${r}-${c}`}
                        type="button"
                        className={[
                          styles.cell,
                          disabled ? styles.disabled : '',
                          cell === 'hit' ? styles.hit : '',
                          cell === 'miss' ? styles.miss : '',
                        ].join(' ')}
                        disabled={disabled}
                        onClick={() => onCellClick(r, c)}
                        aria-label={cellLabel(r, c)}
                      />
                    );
                  }),
                )}
              </div>
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
                  <Button
                    kind="danger"
                    size="sm"
                    onClick={() => {
                      setConfirmResign(false);
                      void resign(characterId);
                    }}
                  >
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
                  : game.result.winner === 'player'
                    ? t('You won')
                    : t('{name} won', { name })}
              </div>
              <div className={styles.resultDetail}>
                {game.result.reason === 'all-ships-sunk'
                  ? t('All ships sunk.')
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




