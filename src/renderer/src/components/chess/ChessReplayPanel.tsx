/**
 * ChessReplayPanel — a finished game replayed from its transcript row
 * (260724). Clicking the "You and X played chess" row in chat opens this
 * surface in the same game slot as a live game.
 *
 * Same look as ChessPanel's board state (it reuses ChessPanel.module.css and
 * ChessBoard3D wholesale), minus everything a finished recording cannot use:
 * no launch screen, no draw offer / resign controls, no rematch, no draw
 * banners, no Minecraft-conflict modal. What remains:
 *   top-left      flip board + the opponent-side captured strip;
 *   top-right     move list (click any move to scrub);
 *   bottom-left   player-side captured strip;
 *   center        the result banner, shown on the final position only.
 * The board opens on the final position; ArrowLeft/ArrowRight also step
 * through the moves. Captured strips follow the VIEWED position, so scrubbing
 * rewinds them too.
 *
 * The board is a synthetic 'ended' ChessGameState seeded by
 * useChessStore.openReplay under replayKeyFor(characterId) — ChessBoard3D
 * renders it view-only exactly like a live board after game over, and any
 * live game under the real characterId is untouched. Closing goes through the
 * unified GameSurface "x" (ChatScreen calls closeReplay).
 */

import React, { useEffect, useMemo, useRef } from 'react';
import { useChessStore, boardUiFor, replayKeyFor } from '../../lib/stores/useChessStore';
import { useDataStore } from '../../lib/stores/useDataStore';
import { FlipIcon } from '../icons';
import { ChessBoard3D } from './ChessBoard3D';
import { capturedMaterial } from './chessUtil';
import { pairs, MoveCell, CapturedRow, ResultBanner } from './ChessPanel';
import styles from './ChessPanel.module.css';

export interface ChessReplayPanelProps {
  characterId: string;
}

export function ChessReplayPanel({ characterId }: ChessReplayPanelProps): React.ReactElement | null {
  const replayKey = replayKeyFor(characterId);
  const game = useChessStore((s) => s.games[replayKey] ?? null);
  const ui = useChessStore((s) => boardUiFor(s, replayKey));
  const setUi = useChessStore((s) => s.setUi);

  const character = useDataStore((s) => s.characters.find((c) => c.id === characterId));
  const name = character?.name ?? 'Companion';

  // Viewed position: scrubbed frame, else the final position.
  const viewedFen = useMemo(() => {
    if (!game) return null;
    if (ui.viewPly !== null) return game.history[ui.viewPly]?.fen ?? game.fen;
    return game.fen;
  }, [game, ui.viewPly]);

  const captured = useMemo(() => (viewedFen ? capturedMaterial(viewedFen) : null), [viewedFen]);
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

  // Move list opens scrolled to the end (the game opens on its final position).
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [game?.gameId]);

  // Arrow keys step through the moves. Ignored while typing (the chat
  // composer stays usable under the split view).
  const historyLen = game?.history.length ?? 0;
  useEffect(() => {
    if (!historyLen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      const cur = useChessStore.getState().ui[replayKey]?.viewPly ?? historyLen - 1;
      if (e.key === 'ArrowLeft') {
        setUi(replayKey, { viewPly: Math.max(0, cur - 1) });
      } else {
        const next = cur + 1;
        setUi(replayKey, { viewPly: next >= historyLen - 1 ? null : next });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [historyLen, replayKey, setUi]);

  if (!game) return null;

  return (
    <div className={styles.panel} aria-label={`Chess replay with ${name}`}>
      <div className={styles.stage}>
        <div className={styles.boardFill}>
          <ChessBoard3D characterId={replayKey} companionName={name} />
        </div>

        <div className={styles.hud}>
          {/* Top-left: flip, stacked above the opponent captures. */}
          <div className={styles.hudTopLeft}>
            <div className={styles.hudControls} role="group" aria-label="Replay controls">
              <button
                type="button"
                className={styles.ctrlBtn}
                onClick={() => setUi(replayKey, { flip: !(ui.flip ?? false) })}
                aria-label="Flip board"
                data-tip="Flip board"
                data-tip-edge="left"
              >
                <FlipIcon size={16} />
              </button>
            </div>
            {capturedStrips && capturedStrips.top.pieces.length > 0 ? (
              <div className={styles.capturedStrip}>
                <CapturedRow
                  pieces={capturedStrips.top.pieces}
                  diff={capturedStrips.top.diff}
                  label={capturedStrips.top.label}
                />
              </div>
            ) : null}
          </div>

          {/* Player captures, bottom-left. */}
          {capturedStrips && capturedStrips.bottom.pieces.length ? (
            <div className={styles.hudBottomLeft}>
              <div className={styles.capturedStrip}>
                <CapturedRow
                  pieces={capturedStrips.bottom.pieces}
                  diff={capturedStrips.bottom.diff}
                  label={capturedStrips.bottom.label}
                />
              </div>
            </div>
          ) : null}

          {/* Move list, top-right. */}
          <div className={styles.hudTopRight}>
            <div className={styles.moves} ref={listRef}>
              {game.history.length === 0 ? (
                <div className={styles.movesEmpty}>No moves</div>
              ) : (
                pairs(game.history.length).map(([wi, bi], n) => (
                  <div key={n} className={styles.moveRow}>
                    <span className={styles.moveNum}>{n + 1}.</span>
                    <MoveCell
                      san={game.history[wi]?.san}
                      active={ui.viewPly === wi}
                      onClick={() => setUi(replayKey, { viewPly: wi })}
                    />
                    <MoveCell
                      san={bi < game.history.length ? game.history[bi]?.san : undefined}
                      active={ui.viewPly === bi}
                      onClick={() => setUi(replayKey, { viewPly: bi })}
                    />
                  </div>
                ))
              )}
            </div>
            {ui.viewPly !== null ? (
              <button
                type="button"
                className={styles.backToLive}
                onClick={() => setUi(replayKey, { viewPly: null })}
              >
                Final position
              </button>
            ) : null}
          </div>

          {/* Result, centered on the final position only (scrubbing hides it
              so the replayed moves are unobstructed). Fully passive: no
              actions, the board stays scrubbable through it. */}
          {ui.viewPly === null && game.result ? (
            <div className={styles.hudResult}>
              <ResultBanner result={game.result} game={game} name={name} />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
