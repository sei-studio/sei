/**
 * ChessPanel — the chess surface that slides into the chat screen (260710).
 *
 * States, in order of precedence:
 *   - launch screen (no game yet, engine download, or Rematch clicked after a
 *     finished game): minimal content over a dark board photo
 *     (./img/chess-launch.png with a plain dark fallback behind it):
 *     "Chess" title, the inline White / Random / Black side picker, and one
 *     primary button ("Launch", or "Start" on the rematch pass);
 *   - status 'active' / 'ended' → the 3D board fills the whole panel edge to
 *     edge and everything else floats over it as a de-boxed HUD:
 *       top-left      icon-only controls (flip, offer draw, resign; tooltips
 *                     via data-tip, resign confirm appears inline in the row)
 *                     stacked above the opponent-side captured strip;
 *       top-center    turn label + dim Elo tag (rendered inside ChessBoard3D;
 *                     the label doubles as the thinking indicator);
 *       top-right     move list (scroll + history scrub) and Back to live;
 *       bottom-left   player-side captured strip, lifted clear of the
 *                     hover-revealed GameSurface bottom chrome strip
 *                     (var(--game-chrome-h, 56px));
 *       bottom-center draw-offer banner / "offer sent" note, same chrome
 *                     clearance;
 *       center        result + Rematch when the game ends (the board stays
 *                     interactive for scrubbing; closing is the unified
 *                     GameSurface "x"), promotion picker (in ChessBoard3D).
 *     Passive labels are pointer-events: none so they never block the board.
 *
 * Rematch flow (260721): the result overlay's Rematch button flips a local
 * `rematchScreen` flag back to the launch layout (same background and side
 * picker, button labeled "Start"); Start goes through the store's new-game
 * action (start), which replaces the ended session in main.
 *
 * The AI move reveal is paced by useAiMoveReveal (commentary first, then the
 * piece slides). Starting while the companion is summoned in Minecraft rejects
 * with CHESS_MC_SESSION_ACTIVE; a confirm modal offers to disconnect the bot
 * and retry.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useChessStore, boardUiFor } from '../../lib/stores/useChessStore';
import { useDataStore } from '../../lib/stores/useDataStore';
import { requestGameLaunch } from '../../lib/gameLaunch';
import { sei } from '../../lib/ipcClient';
import { useT } from '../../lib/i18n';
import { Button } from '../Button';
import { PercentBar } from '../PercentBar';
import { ModalShell, ModalFooter } from '../ModalShell';
import { FlipIcon, DrawIcon, FlagIcon } from '../icons';
import { ChessBoard3D } from './ChessBoard3D';
import { useAiMoveReveal } from './useAiMoveReveal';
import { capturedMaterial } from './chessUtil';
import { Piece } from './pieces';
import type { ChessGameState, ChessResult } from '@shared/chessIpc';
import styles from './ChessPanel.module.css';

export interface ChessPanelProps {
  characterId: string;
}

type ColorChoice = 'w' | 'b' | 'random';

const SIDE_OPTIONS: Array<{ value: ColorChoice; label: string }> = [
  { value: 'w', label: 'White' },
  { value: 'random', label: 'Random' },
  { value: 'b', label: 'Black' },
];

/** The translator shape from useT, for helpers called inside renders. */
type Tr = (en: string, params?: Record<string, string | number>) => string;

/** Plain-language result copy (no em dashes in user-visible text). Shared
 * with ChessReplayPanel (the replay's result banner uses the same copy). */
function resultCopy(result: ChessResult, game: ChessGameState, name: string, t: Tr): {
  title: string;
  detail: string;
} {
  const playerWon = result.winner !== null && result.winner === game.playerColor;
  const title =
    result.winner === null ? t('Draw') : playerWon ? t('You won') : t('{name} won', { name });
  switch (result.reason) {
    case 'checkmate':
      return { title, detail: t('Checkmate.') };
    case 'stalemate':
      return { title: t('Draw'), detail: t('Stalemate. No legal moves left.') };
    case 'draw-agreed':
      return { title: t('Draw'), detail: t('You both agreed to a draw.') };
    case 'draw-material':
      return { title: t('Draw'), detail: t('Not enough pieces left to checkmate.') };
    case 'draw-repetition':
      return { title: t('Draw'), detail: t('The same position repeated three times.') };
    case 'draw-fifty':
      return { title: t('Draw'), detail: t('Fifty moves without a capture or pawn move.') };
    case 'resign':
      return { title, detail: t('You resigned. {name} takes the game.', { name }) };
    case 'forfeit':
      return { title, detail: t('{name} forfeited the game.', { name }) };
    case 'abandoned':
      return { title: t('Game closed'), detail: t('This game ended without a result.') };
    default:
      return { title, detail: '' };
  }
}

export function ChessPanel({ characterId }: ChessPanelProps): React.ReactElement {
  const t = useT();
  const game = useChessStore((s) => s.games[characterId] ?? null);
  const download = useChessStore((s) => s.downloads[characterId]);
  const starting = useChessStore((s) => s.starting[characterId] ?? false);
  const ui = useChessStore((s) => boardUiFor(s, characterId));
  const start = useChessStore((s) => s.start);
  const resign = useChessStore((s) => s.resign);
  const offerDraw = useChessStore((s) => s.offerDraw);
  const respondDraw = useChessStore((s) => s.respondDraw);
  const setUi = useChessStore((s) => s.setUi);
  const hydrate = useChessStore((s) => s.hydrate);

  const character = useDataStore((s) => s.characters.find((c) => c.id === characterId));
  const name = character?.name ?? t('Companion');

  const [colorChoice, setColorChoice] = useState<ColorChoice>('random');
  const [startErr, setStartErr] = useState<string | null>(null);
  const [mcConflict, setMcConflict] = useState(false);
  const [confirmResign, setConfirmResign] = useState(false);
  /** Rematch clicked on a finished game: show the launch layout again. */
  const [rematchScreen, setRematchScreen] = useState(false);

  useAiMoveReveal(characterId);

  // Resume any game main still holds (navigation away and back, relaunch).
  useEffect(() => {
    void hydrate(characterId);
  }, [characterId, hydrate]);

  // Reset transient panel state when switching characters.
  useEffect(() => {
    setStartErr(null);
    setMcConflict(false);
    setConfirmResign(false);
    setRematchScreen(false);
  }, [characterId]);

  // A fresh game went live (Start pressed on the rematch screen, or any other
  // path): leave the rematch pass of the launch layout.
  const gameStatus = game?.status ?? null;
  useEffect(() => {
    if (gameStatus === 'active') setRematchScreen(false);
  }, [gameStatus]);

  const doStart = async (choice: ColorChoice): Promise<void> => {
    setStartErr(null);
    try {
      await start(characterId, choice);
    } catch (err) {
      const msg = String((err as { message?: string })?.message ?? err);
      if (/CHESS_MC_SESSION_ACTIVE/.test(msg)) {
        setMcConflict(true);
      } else if (/CHESS_MODEL_DOWNLOAD_FAILED/.test(msg)) {
        setStartErr(t('The chess brain failed to download. Check your connection and try again.'));
      } else if (/not available in this build/.test(msg)) {
        setStartErr(t('Chess is not available in this build yet.'));
      } else {
        setStartErr(t("The game couldn't start. Try again in a moment."));
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
    await doStart(colorChoice);
  };

  // ── Move list auto-scroll ─────────────────────────────────────────────────
  const listRef = useRef<HTMLDivElement | null>(null);
  const historyLen = game?.history.length ?? 0;
  useEffect(() => {
    if (ui.viewPly !== null) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [historyLen, ui.viewPly]);

  const captured = useMemo(
    () => (game ? capturedMaterial(game.fen) : null),
    [game],
  );

  // The strip near the top belongs to the opponent side, the bottom one to the
  // player, matching how the board is oriented by default.
  const capturedStrips = useMemo(() => {
    if (!game || !captured) return null;
    const byWhite = {
      pieces: captured.b.map((t) => `b${t}`),
      diff: captured.diff > 0 ? `+${captured.diff}` : null,
      label: 'Captured by white',
    };
    const byBlack = {
      pieces: captured.w.map((t) => `w${t}`),
      diff: captured.diff < 0 ? `+${-captured.diff}` : null,
      label: 'Captured by black',
    };
    return game.playerColor === 'w'
      ? { top: byBlack, bottom: byWhite }
      : { top: byWhite, bottom: byBlack };
  }, [game, captured]);

  const downloadFailed = download?.pct === -1;
  const preparing = !!game && game.status === 'preparing';
  // Launch layout: pre-game, engine warm-up, or the rematch pass. The board
  // (and its scene) unmounts underneath it; ChessBoard3D disposes cleanly.
  const showLaunch = !game || preparing || (game.status === 'ended' && rematchScreen);

  return (
    <div className={styles.panel} aria-label={t('Chess with {name}', { name })}>
      {showLaunch ? (
        /* ── Launch screen: content over the dark board photo ── */
        <div className={styles.launch}>
          <img
            className={styles.launchBg}
            src="./img/chess-launch.png"
            alt=""
            draggable={false}
            onError={(e) => {
              // Missing asset: the plain dark backdrop behind it carries the look.
              e.currentTarget.style.display = 'none';
            }}
          />
          <div className={styles.launchScrim} />
          {/* 260721: no local close control; the GameSurface bottom-right "x"
              is the one dismiss/end affordance for every game surface. */}
          <div className={styles.launchContent}>
            <h3 className={styles.launchTitle}>{t('Chess')}</h3>
            {preparing ? (
              downloadFailed ? (
                <>
                  <p className={styles.launchError}>
                    {download?.error ?? t('The download failed. Check your connection and try again.')}
                  </p>
                  <Button kind="accent" size="md" onClick={() => void doStart(colorChoice)}>
                    {t('Try again')}
                  </Button>
                </>
              ) : (
                <>
                  <p className={styles.launchHint}>{t('Setting up the chess brain (one-time download).')}</p>
                  <div className={styles.progressWrap}>
                    <PercentBar
                      value={Math.max(0, download?.pct ?? 0)}
                      label={t('Chess engine download progress')}
                      size="md"
                    />
                  </div>
                </>
              )
            ) : (
              <>
                <div className={styles.sideRow} role="radiogroup" aria-label={t('Your side')}>
                  {SIDE_OPTIONS.map((opt, i) => (
                    <React.Fragment key={opt.value}>
                      {i > 0 ? (
                        <span className={styles.sideSep} aria-hidden="true">
                          /
                        </span>
                      ) : null}
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
                {startErr ? <p className={styles.launchError}>{startErr}</p> : null}
                <Button
                  kind="accent"
                  size="md"
                  disabled={starting}
                  onClick={() =>
                    // 260721: the shared cross-launch gate — another live game
                    // (screen share, a summoned bot) confirms before this one
                    // starts; otherwise it launches directly.
                    requestGameLaunch(characterId, { id: 'chess', name: 'Chess' }, () =>
                      void doStart(colorChoice),
                    )
                  }
                >
                  {starting ? t('Starting…') : rematchScreen ? t('Start') : t('Launch')}
                </Button>
              </>
            )}
          </div>
        </div>
      ) : game ? (
        /* ── Board states: full-bleed 3D scene + floating HUD ── */
        <div className={styles.stage}>
          <div className={styles.boardFill}>
            <ChessBoard3D characterId={characterId} companionName={name} />
          </div>

          <div className={styles.hud}>
            {/* Top-left: icon controls (active games only) stacked above the
                opponent captures. Tooltips clamp to the left edge so they can
                only grow inward (data-tip-edge="left"). */}
            {game.status === 'active' || (capturedStrips && capturedStrips.top.pieces.length > 0) ? (
              <div className={styles.hudTopLeft}>
                {game.status === 'active' ? (
                  <div className={styles.hudControls} role="group" aria-label={t('Game controls')}>
                    <button
                      type="button"
                      className={styles.ctrlBtn}
                      onClick={() => setUi(characterId, { flip: !(ui.flip ?? false) })}
                      aria-label={t('Flip board')}
                      data-tip={t('Flip board')}
                      data-tip-edge="left"
                    >
                      <FlipIcon size={16} />
                    </button>
                    <button
                      type="button"
                      className={styles.ctrlBtn}
                      disabled={game.drawOffer !== null}
                      onClick={() => void offerDraw(characterId)}
                      aria-label={t('Offer draw')}
                      data-tip={t('Offer draw')}
                      data-tip-edge="left"
                    >
                      <DrawIcon size={16} />
                    </button>
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
                        data-tip-edge="left"
                      >
                        <FlagIcon size={16} />
                      </button>
                    )}
                  </div>
                ) : null}
                {capturedStrips && capturedStrips.top.pieces.length > 0 ? (
                  <div className={styles.capturedStrip}>
                    <CapturedRow
                      pieces={capturedStrips.top.pieces}
                      diff={capturedStrips.top.diff}
                      label={t(capturedStrips.top.label)}
                    />
                  </div>
                ) : null}
              </div>
            ) : null}

            {/* Player captures, bottom-left. */}
            {capturedStrips && capturedStrips.bottom.pieces.length ? (
              <div className={styles.hudBottomLeft}>
                <div className={styles.capturedStrip}>
                  <CapturedRow
                    pieces={capturedStrips.bottom.pieces}
                    diff={capturedStrips.bottom.diff}
                    label={t(capturedStrips.bottom.label)}
                  />
                </div>
              </div>
            ) : null}

            {/* Move list, top-right. */}
            <div className={styles.hudTopRight}>
              <div className={styles.moves} ref={listRef}>
                {game.history.length === 0 ? (
                  <div className={styles.movesEmpty}>{t('No moves yet')}</div>
                ) : (
                  pairs(game.history.length).map(([wi, bi], n) => (
                    <div key={n} className={styles.moveRow}>
                      <span className={styles.moveNum}>{n + 1}.</span>
                      <MoveCell
                        san={game.history[wi]?.san}
                        active={ui.viewPly === wi}
                        onClick={() => setUi(characterId, { viewPly: wi, selected: null })}
                      />
                      <MoveCell
                        san={bi < game.history.length ? game.history[bi]?.san : undefined}
                        active={ui.viewPly === bi}
                        onClick={() => setUi(characterId, { viewPly: bi, selected: null })}
                      />
                    </div>
                  ))
                )}
              </div>
              {ui.viewPly !== null ? (
                <button
                  type="button"
                  className={styles.backToLive}
                  onClick={() => setUi(characterId, { viewPly: null })}
                >
                  {t('Back to live')}
                </button>
              ) : null}
            </div>

            {/* Draw offer, bottom-center. */}
            {game.status === 'active' && game.drawOffer === 'ai' ? (
              <div className={styles.offerBanner}>
                <span>{t('{name} offers a draw', { name })}</span>
                <div className={styles.offerActions}>
                  <Button kind="accent" size="sm" onClick={() => void respondDraw(characterId, true)}>
                    {t('Accept')}
                  </Button>
                  <Button kind="quiet" size="sm" onClick={() => void respondDraw(characterId, false)}>
                    {t('Decline')}
                  </Button>
                </div>
              </div>
            ) : null}
            {game.status === 'active' && game.drawOffer === 'player' ? (
              <div className={styles.offerNote}>{t('Draw offer sent')}</div>
            ) : null}

            {/* Result, centered. The wrapper is passive (board scrubbing keeps
                working); only the action row takes the pointer. Rematch flips
                back to the launch layout where Start begins the next game;
                closing goes through the unified GameSurface "x" (260721). */}
            {game.status === 'ended' && game.result ? (
              <div className={styles.hudResult}>
                <ResultBanner result={game.result} game={game} name={name} />
                <div className={styles.resultActions}>
                  <Button kind="accent" size="md" onClick={() => setRematchScreen(true)}>
                    {t('Rematch')}
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* ── Minecraft-session conflict confirm ── */}
      {mcConflict ? (
        <ModalShell
          title={t('{name} is in Minecraft', { name })}
          onClose={() => setMcConflict(false)}
          scrimClose
          tier="stacked"
        >
          <p className={styles.modalBody}>
            {t(
              '{name} is playing in a Minecraft world right now. Disconnect them from the world to start a chess game?',
              { name },
            )}
          </p>
          <ModalFooter>
            <Button kind="quiet" size="md" onClick={() => setMcConflict(false)}>
              {t('Cancel')}
            </Button>
            <Button kind="primary" size="md" onClick={() => void onConfirmDisconnect()}>
              {t('Disconnect and play')}
            </Button>
          </ModalFooter>
        </ModalShell>
      ) : null}
    </div>
  );
}

/** Half-move index pairs for the numbered move list. */
export function pairs(len: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < len; i += 2) out.push([i, i + 1]);
  return out;
}

export function MoveCell({
  san,
  active,
  onClick,
}: {
  san: string | undefined;
  active: boolean;
  onClick: () => void;
}): React.ReactElement {
  if (!san) return <span className={styles.moveCellEmpty} />;
  return (
    <button
      type="button"
      className={active ? `${styles.moveCell} ${styles.moveCellActive}` : styles.moveCell}
      onClick={onClick}
    >
      {san}
    </button>
  );
}

export function CapturedRow({
  pieces,
  diff,
  label,
}: {
  pieces: string[];
  diff: string | null;
  label: string;
}): React.ReactElement {
  return (
    <div className={styles.capturedRow} aria-label={label}>
      {pieces.map((code, i) => (
        <span key={`${code}-${i}`} className={styles.capturedPiece}>
          <Piece code={code} />
        </span>
      ))}
      {diff ? <span className={styles.capturedDiff}>{diff}</span> : null}
    </div>
  );
}

export function ResultBanner({
  result,
  game,
  name,
}: {
  result: ChessResult;
  game: ChessGameState;
  name: string;
}): React.ReactElement {
  const t = useT();
  const { title, detail } = resultCopy(result, game, name, t);
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
