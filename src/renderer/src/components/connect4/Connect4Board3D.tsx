/**
 * Connect4Board3D — the interactive Four in a Row viewport over
 * three/Connect4Scene.ts (Clubhouse-style frame on the chess table).
 *
 * Pure view over the game snapshot main pushes (useConnect4Store): it shows
 * the board (+ a short-lived optimistic disc while the move round trips),
 * turns pointer and keyboard input into a column drop, and carries the
 * top-center turn line ("Your turn" / "{Name}'s turn" / a shimmering
 * "{Name} is thinking…"), like the chess board.
 *
 * With `game` null it renders the empty frame only (the launch screen's
 * backdrop), with no input.
 *
 * Keyboard: the viewport is focusable; Left/Right move the column, Home/End
 * jump to the edges, Enter or Space drops.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../../lib/i18n';
import type { CONNECT4Color, CONNECT4GameState } from '@shared/connect4Ipc';
import { Connect4Scene } from './three/Connect4Scene';
import { COLS, ROWS, landingRow, winningCells, type Board } from './connect4Util';
import { watchWebglContext } from '../tabletop/SceneGuard';
import hud from '../tabletop/TabletopHud.module.css';

export interface Connect4Board3DProps {
  game: CONNECT4GameState | null;
  companionName: string;
  /** Drop a disc; resolves with main's verdict. */
  onDrop?: (column: number) => Promise<boolean> | void;
  /** Run the character's failed turn again (shown when aiTurnFailed is set). */
  onRetry?: () => void;
  /** The WebGL context was lost (true) or came back (false). */
  onSceneLost?: (lost: boolean) => void;
}

const EMPTY_BOARD: Board = Array.from({ length: ROWS }, () => Array<CONNECT4Color | null>(COLS).fill(null));

export function colorName(c: CONNECT4Color): string {
  return c === 'r' ? 'Red' : 'Yellow';
}

export function Connect4Board3D({
  game,
  companionName,
  onDrop,
  onRetry,
  onSceneLost,
}: Connect4Board3DProps): React.ReactElement {
  const t = useT();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scene, setScene] = useState<Connect4Scene | null>(null);
  const [hoverCol, setHoverCol] = useState<number | null>(null);
  const [keyboard, setKeyboard] = useState(false);
  const [optimistic, setOptimistic] = useState<{ r: number; c: number; moves: number } | null>(null);
  const [anchors, setAnchors] = useState<ReturnType<Connect4Scene['pileAnchors']> | null>(null);

  const playerColor: CONNECT4Color = game?.playerColor ?? 'r';
  const aiColor: CONNECT4Color = playerColor === 'r' ? 'y' : 'r';

  // Committed board + the optimistic disc (until main's push moves on).
  const board: Board = useMemo(() => {
    const base = game?.board ?? EMPTY_BOARD;
    if (!optimistic || !game || game.moves !== optimistic.moves) return base;
    if (base[optimistic.r]?.[optimistic.c] !== null) return base;
    const next = base.map((row) => row.slice());
    next[optimistic.r][optimistic.c] = playerColor;
    return next;
  }, [game, optimistic, playerColor]);

  const canPlay =
    !!game &&
    game.status === 'active' &&
    game.turn === game.playerColor &&
    !game.aiThinking &&
    !optimistic;

  const winCells = useMemo(() => {
    if (!game || game.status !== 'ended' || !game.result?.winner) return [];
    if (game.result.reason !== 'connect-four') return [];
    return winningCells(game.board, game.result.winner);
  }, [game]);

  // Drop the optimistic disc once main's snapshot moves on.
  const moves = game?.moves ?? 0;
  const gameId = game?.gameId ?? '';
  useEffect(() => {
    setOptimistic(null);
  }, [moves, gameId]);

  // ── Scene lifecycle ───────────────────────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const s = new Connect4Scene(el);
    s.onLayout = () => setAnchors(s.pileAnchors());
    setScene(s);
    // Dev perf probe (screenshot harness only reads it).
    (el as unknown as { __tabletopTiming?: () => unknown }).__tabletopTiming = () => s.timing();
    return () => {
      s.dispose();
      setScene(null);
    };
  }, []);

  const lostRef = useRef(onSceneLost);
  lostRef.current = onSceneLost;
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    return watchWebglContext(el, (lost) => lostRef.current?.(lost));
  }, []);

  useEffect(() => {
    scene?.setPlayerColor(playerColor);
  }, [scene, playerColor]);

  // Board pushes: animate new discs, except on the very first paint (resume)
  // where everything is simply there. A new gameId releases the old discs.
  const shown = useRef<{ gameId: string | null; first: boolean }>({ gameId: null, first: true });
  useEffect(() => {
    if (!scene) return;
    const prev = shown.current;
    const reset = prev.gameId !== null && prev.gameId !== (game?.gameId ?? null);
    scene.setBoard(board, { animate: !prev.first, reset });
    shown.current = { gameId: game?.gameId ?? null, first: false };
  }, [scene, board, game?.gameId]);

  useEffect(() => {
    if (!scene) return;
    const col = canPlay ? hoverCol : null;
    scene.setHover(col, col !== null ? playerColor : null, col !== null ? landingRow(board, col) : -1);
  }, [scene, canPlay, hoverCol, playerColor, board]);

  useEffect(() => {
    scene?.setThinking(game?.status === 'active' && game.aiThinking ? aiColor : null);
  }, [scene, game?.status, game?.aiThinking, aiColor]);

  useEffect(() => {
    scene?.setWin(winCells);
  }, [scene, winCells]);

  useEffect(() => {
    scene?.setEnded(game?.status === 'ended');
  }, [scene, game?.status]);

  // ── Intents ───────────────────────────────────────────────────────────────
  function drop(col: number): void {
    if (!canPlay || !game) return;
    const r = landingRow(game.board, col);
    if (r < 0) return;
    setOptimistic({ r, c: col, moves: game.moves });
    void Promise.resolve(onDrop?.(col)).then((ok) => {
      // Rejected (not our turn after all, column full): main's state stands.
      if (ok === false) setOptimistic(null);
    });
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>): void {
    if (!scene) return;
    scene.wake();
    setKeyboard(false);
    const col = canPlay ? scene.columnAtPointer(e.clientX, e.clientY) : null;
    if (col !== hoverCol) setHoverCol(col);
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>): void {
    if (e.button !== 0 || !scene || !canPlay) return;
    const col = scene.columnAtPointer(e.clientX, e.clientY);
    if (col !== null) drop(col);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
    if (!canPlay) return;
    const cur = hoverCol ?? Math.floor(COLS / 2);
    let next: number | null = null;
    if (e.key === 'ArrowLeft') next = Math.max(0, cur - 1);
    else if (e.key === 'ArrowRight') next = Math.min(COLS - 1, cur + 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = COLS - 1;
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      drop(cur);
      return;
    } else return;
    e.preventDefault();
    setKeyboard(true);
    setHoverCol(next);
  }

  // ── Render ────────────────────────────────────────────────────────────────
  const aiFailed = !!game && game.status === 'active' && !!game.aiTurnFailed;
  const turnLabel = !game
    ? ''
    : aiFailed
      ? t("{name} couldn't move", { name: companionName })
      : game.aiThinking
      ? t('{name} is thinking…', { name: companionName })
      : game.turn === game.playerColor
        ? t('Your turn')
        : t("{name}'s turn", { name: companionName });

  const hoverFull = hoverCol !== null && landingRow(board, hoverCol) < 0;
  const liveHint =
    keyboard && hoverCol !== null
      ? hoverFull
        ? t('Column {c} is full', { c: hoverCol + 1 })
        : t('Column {c}', { c: hoverCol + 1 })
      : '';

  return (
    <div
      ref={containerRef}
      className={canPlay && hoverCol !== null ? `${hud.viewport} ${hud.pointer}` : hud.viewport}
      onPointerMove={game ? onPointerMove : undefined}
      onPointerDown={game ? onPointerDown : undefined}
      onPointerLeave={() => {
        if (!keyboard) setHoverCol(null);
      }}
      onKeyDown={game ? onKeyDown : undefined}
      onBlur={() => {
        if (keyboard) setHoverCol(null);
      }}
      tabIndex={game ? 0 : -1}
      role={game ? 'application' : 'presentation'}
      aria-label={game ? t('Four in a Row board. Left and Right pick a column, Enter drops a disc.') : undefined}
    >
      {game && game.status === 'active' ? (
        <div className={hud.topCenter}>
          {aiFailed ? (
            <div className={hud.turnRow}>
              <div className={hud.turnChip} role="status">
                {turnLabel}
              </div>
              {onRetry ? (
                <button
                  type="button"
                  className={`${hud.sceneBtn} ${hud.retryBtn}`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRetry();
                  }}
                >
                  {t('Try again')}
                </button>
              ) : null}
            </div>
          ) : (
            <div className={game.aiThinking ? `${hud.turnChip} ${hud.thinking}` : hud.turnChip} aria-live="polite">
              {turnLabel}
            </div>
          )}
        </div>
      ) : null}

      {game && anchors ? (
        <>
          <div className={hud.sceneLabel} style={{ left: anchors.player.x, top: anchors.player.y }}>
            {t('You')}
          </div>
          <div className={hud.sceneLabel} style={{ left: anchors.ai.x, top: anchors.ai.y }}>
            {companionName}
          </div>
        </>
      ) : null}

      <div className={hud.srOnly} aria-live="polite">
        {liveHint}
      </div>
    </div>
  );
}
