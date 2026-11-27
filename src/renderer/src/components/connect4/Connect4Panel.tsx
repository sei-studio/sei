/**
 * CONNECT4Panel — the Four in a Row surface that slides into the chat screen.
 *
 * The 3D frame (Connect4Board3D) fills the panel edge to edge in every state
 * and everything else floats over it as the chess panel's de-boxed HUD:
 *   - launch (no game yet, or Rematch clicked on a finished game): title,
 *     the inline Red / Random / Yellow side picker and one button ("Launch",
 *     "Start" on the rematch pass) over the empty frame under a scrim;
 *   - active: turn line top-center (inside the board), the borderless resign
 *     flag top-left with an inline confirm; when the character's turn could
 *     not be finished (aiTurnFailed) the turn line says so and offers a
 *     borderless Try again (CONNECT4:retry);
 *   - ended: the winning four glow in the frame and the result card with
 *     Rematch rises at the bottom, clear of the winning line.
 * Closing goes through the unified GameSurface "x".
 *
 * Contract: src/shared/connect4Ipc.ts + src/main/connect4/connect4Service.ts.
 */

import React, { useEffect, useState } from 'react';
import { useConnect4Store } from '../../lib/stores/useConnect4Store';
import { useDataStore } from '../../lib/stores/useDataStore';
import { requestGameLaunch } from '../../lib/gameLaunch';
import { useT } from '../../lib/i18n';
import { Button } from '../Button';
import { FlagIcon } from '../icons';
import type { CONNECT4GameState, CONNECT4Result } from '@shared/connect4Ipc';
import { Connect4Board3D } from './Connect4Board3D';
import { SceneBoundary, SceneFailedNotice } from '../tabletop/SceneGuard';
import hud from '../tabletop/TabletopHud.module.css';

export interface CONNECT4PanelProps {
  characterId: string;
}

type SideChoice = 'r' | 'y' | 'random';

/** Disc colors for the side picker dots (art colors, match the 3D discs). */
const SIDE_OPTIONS: Array<{ value: SideChoice; label: string; dot?: string }> = [
  { value: 'r', label: 'Red', dot: '#d8473b' },
  { value: 'random', label: 'Random' },
  { value: 'y', label: 'Yellow', dot: '#f2b430' },
];

type Tr = (en: string, params?: Record<string, string | number>) => string;

function resultCopy(result: CONNECT4Result, game: CONNECT4GameState, name: string, t: Tr): {
  title: string;
  detail: string;
  tone: 'win' | 'loss' | 'draw';
} {
  const playerWon = result.winner !== null && result.winner === game.playerColor;
  const tone = result.winner === null ? 'draw' : playerWon ? 'win' : 'loss';
  const title = result.winner === null ? t('Draw') : playerWon ? t('You won') : t('{name} won', { name });
  switch (result.reason) {
    case 'connect-four':
      return { title, tone, detail: t('Four in a row.') };
    case 'draw':
      return { title: t('Draw'), tone: 'draw', detail: t('The board is full.') };
    case 'resign':
      return { title, tone, detail: t('You resigned. {name} takes the game.', { name }) };
    case 'forfeit':
      return { title, tone, detail: t('{name} forfeited the game.', { name }) };
    default:
      return { title: t('Game closed'), tone: 'draw', detail: t('This game ended without a result.') };
  }
}

export function CONNECT4Panel({ characterId }: CONNECT4PanelProps): React.ReactElement {
  const t = useT();
  const game = useConnect4Store((s) => s.games[characterId] ?? null);
  const starting = useConnect4Store((s) => s.starting[characterId] ?? false);
  const start = useConnect4Store((s) => s.start);
  const move = useConnect4Store((s) => s.move);
  const resign = useConnect4Store((s) => s.resign);
  const retry = useConnect4Store((s) => s.retry);
  const hydrate = useConnect4Store((s) => s.hydrate);
  const endGame = useConnect4Store((s) => s.end);

  const character = useDataStore((s) => s.characters.find((c) => c.id === characterId));
  const name = character?.name ?? t('Companion');

  const [colorChoice, setColorChoice] = useState<SideChoice>('random');
  const [startErr, setStartErr] = useState<string | null>(null);
  const [confirmResign, setConfirmResign] = useState(false);
  /** The 3D scene could not start, or lost its WebGL context. */
  const [sceneFailed, setSceneFailed] = useState(false);
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
    setSceneFailed(false);
    setRematchScreen(false);
  }, [characterId]);

  const gameStatus = game?.status ?? null;
  useEffect(() => {
    if (gameStatus === 'active') setRematchScreen(false);
    if (gameStatus !== 'active') setConfirmResign(false);
  }, [gameStatus]);

  const doStart = async (choice: SideChoice): Promise<void> => {
    setStartErr(null);
    try {
      await start(characterId, choice);
    } catch (err) {
      const msg = String((err as { message?: string })?.message ?? err);
      if (/not available in this build/.test(msg)) {
        setStartErr(t('Four in a Row is not available in this build yet.'));
      } else {
        setStartErr(t("The game couldn't start. Try again in a moment."));
      }
    }
  };

  const showLaunch = !game || (game.status === 'ended' && rematchScreen);
  const result = game?.status === 'ended' && game.result ? resultCopy(game.result, game, name, t) : null;

  return (
    <div className={hud.panel} aria-label={t('Four in a Row with {name}', { name })}>
      <div className={hud.stage}>
        <div className={hud.boardFill}>
          <SceneBoundary key={characterId} onFail={() => setSceneFailed(true)}>
            <Connect4Board3D
              key={characterId}
              game={showLaunch ? null : game}
              companionName={name}
              onDrop={(column) => move(characterId, column)}
              onRetry={() => void retry(characterId)}
              onSceneLost={setSceneFailed}
            />
          </SceneBoundary>
        </div>
        {sceneFailed ? <SceneFailedNotice onClose={() => void endGame(characterId)} /> : null}

        {showLaunch ? (
          <div className={hud.launch}>
            <div className={hud.launchScrim} />
            <div className={hud.launchContent}>
              <h3 className={hud.launchTitle}>{t('Four in a Row')}</h3>
              <div className={hud.sideRow} role="radiogroup" aria-label={t('Your side')}>
                {SIDE_OPTIONS.map((opt, i) => (
                  <React.Fragment key={opt.value}>
                    {i > 0 ? (
                      <span className={hud.sideSep} aria-hidden="true">
                        /
                      </span>
                    ) : null}
                    <button
                      type="button"
                      role="radio"
                      aria-checked={colorChoice === opt.value}
                      className={colorChoice === opt.value ? `${hud.sideBtn} ${hud.sideBtnActive}` : hud.sideBtn}
                      disabled={starting}
                      onClick={() => setColorChoice(opt.value)}
                    >
                      {opt.dot ? <span className={hud.sideDot} style={{ background: opt.dot }} aria-hidden="true" /> : null}
                      {t(opt.label)}
                    </button>
                  </React.Fragment>
                ))}
              </div>
              {startErr ? (
                <p className={hud.launchError} role="alert">
                  {startErr}
                </p>
              ) : null}
              <Button
                kind="accent"
                size="md"
                disabled={starting}
                onClick={() =>
                  requestGameLaunch(characterId, { id: 'CONNECT4', name: t('Four in a Row') }, () =>
                    void doStart(colorChoice),
                  )
                }
              >
                {starting ? t('Starting…') : rematchScreen ? t('Start') : t('Launch')}
              </Button>
            </div>
          </div>
        ) : game ? (
          <div className={hud.hud}>
            {game.status === 'active' ? (
              <div className={hud.hudTopLeft} role="group" aria-label={t('Game controls')}>
                {confirmResign ? (
                  <span className={hud.resignConfirm}>
                    <span className={hud.resignLabel}>{t('Resign?')}</span>
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
                    className={`${hud.ctrlBtn} ${hud.ctrlDanger}`}
                    onClick={() => setConfirmResign(true)}
                    aria-label={t('Resign')}
                    data-tip={t('Resign')}
                    data-tip-edge="left"
                  >
                    <FlagIcon size={16} />
                  </button>
                )}
              </div>
            ) : null}

            {result ? (
              <div className={`${hud.hudResult} ${hud.hudResultLow} ${hud.hudResultRow}`}>
                <div
                  className={[
                    hud.result,
                    result.tone === 'win' ? hud.resultWin : result.tone === 'loss' ? hud.resultLoss : hud.resultDraw,
                  ].join(' ')}
                  role="status"
                >
                  <div className={hud.resultTitle}>{result.title}</div>
                  <div className={hud.resultDetail}>{result.detail}</div>
                </div>
                <div className={hud.resultActions}>
                  <Button kind="accent" size="md" onClick={() => setRematchScreen(true)}>
                    {t('Rematch')}
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
