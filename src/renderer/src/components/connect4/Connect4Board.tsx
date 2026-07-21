/**
 * Connect4Board — the 7x6 grid with column-drop interaction (260720).
 *
 * Renders the committed board from the store snapshot plus (at most) one
 * overlay disc: the player's just-hovered ghost, or the AI's revealed pending
 * drop mid-fall. Clicking a column drops the player's disc; the falling
 * animation is pure CSS (translateY from above the board, distance set per
 * row via a CSS variable). The AI's pending move renders only once the store
 * reveals it (useAiDropReveal's quiet gate), then commits on ack.
 *
 * Rows are stored bottom-up (row 0 = floor, the shared contract) and drawn
 * top-down, so the render maps row index (C4_ROWS - 1 - r).
 */

import React, { useState } from 'react';
import { C4_COLS, C4_ROWS, type C4Color, type C4GameState } from '@shared/connect4Ipc';
import { useConnect4Store } from '../../lib/stores/useConnect4Store';
import styles from './Connect4Board.module.css';

export interface Connect4BoardProps {
  characterId: string;
}

/** Row a drop in `col` would land in, or -1 when the column is full. */
function landingRow(game: C4GameState, col: number): number {
  for (let row = 0; row < C4_ROWS; row++) {
    if (game.board[row][col] === null) return row;
  }
  return -1;
}

export function Connect4Board({ characterId }: Connect4BoardProps): React.ReactElement | null {
  const game = useConnect4Store((s) => s.games[characterId] ?? null);
  const revealed = useConnect4Store((s) => s.revealed[characterId] ?? null);
  const move = useConnect4Store((s) => s.move);
  const [hoverCol, setHoverCol] = useState<number | null>(null);
  // The player's own drop animates too: remember the last cell we sent so the
  // authoritative snapshot renders it with the fall animation once.
  const [justDropped, setJustDropped] = useState<{ row: number; col: number; ply: number } | null>(
    null,
  );

  if (!game) return null;

  const aiColor: C4Color = game.playerColor === 'r' ? 'y' : 'r';
  const playable =
    game.status === 'active' &&
    game.turn === game.playerColor &&
    !game.aiThinking &&
    game.pendingAiMove === null;

  const winCells = new Set(
    (game.result?.line ?? []).map((c) => `${c.row}:${c.col}`),
  );

  // The AI's revealed pending drop (not committed yet): render as a falling
  // disc in its landing cell.
  const pendingCell =
    revealed !== null && game.pendingAiMove?.col === revealed
      ? { row: landingRow(game, revealed), col: revealed }
      : null;

  const onDrop = (col: number): void => {
    if (!playable) return;
    const row = landingRow(game, col);
    if (row === -1) return;
    setJustDropped({ row, col, ply: game.history.length });
    setHoverCol(null);
    void move(characterId, col);
  };

  const ghostRow = hoverCol !== null && playable ? landingRow(game, hoverCol) : -1;
  const lastMove = game.history[game.history.length - 1];

  return (
    <div
      className={styles.board}
      role="grid"
      aria-label="Connect 4 board"
      onMouseLeave={() => setHoverCol(null)}
    >
      {Array.from({ length: C4_COLS }, (_, col) => {
        const full = landingRow(game, col) === -1;
        return (
          <button
            key={col}
            type="button"
            className={`${styles.col} ${playable && !full ? styles.colPlayable : ''}`}
            disabled={!playable || full}
            aria-label={`Drop in column ${col + 1}`}
            onMouseEnter={() => setHoverCol(col)}
            onFocus={() => setHoverCol(col)}
            onClick={() => onDrop(col)}
          >
            {Array.from({ length: C4_ROWS }, (_, i) => {
              const row = C4_ROWS - 1 - i; // draw top-down
              const cell = game.board[row][col];
              const isPending = pendingCell !== null && pendingCell.col === col && pendingCell.row === row;
              const isGhost = !cell && !isPending && ghostRow === row && hoverCol === col;
              const disc: C4Color | null = cell ?? (isPending ? aiColor : null);
              const isWin = winCells.has(`${row}:${col}`);
              const isLast =
                !isPending &&
                lastMove !== undefined &&
                lastMove.row === row &&
                lastMove.col === col;
              // Animate the fall for the AI's reveal and for the player's own
              // freshly landed disc (one render after the snapshot arrives).
              const falls =
                isPending ||
                (isLast &&
                  justDropped !== null &&
                  justDropped.row === row &&
                  justDropped.col === col &&
                  justDropped.ply === game.history.length - 1);
              return (
                <span key={row} className={styles.cell}>
                  {disc ? (
                    <span
                      className={[
                        styles.disc,
                        disc === 'r' ? styles.discR : styles.discY,
                        falls ? styles.discFall : '',
                        isWin ? styles.discWin : '',
                        isLast && !isWin ? styles.discLast : '',
                      ].join(' ')}
                      style={falls ? ({ '--fall-cells': C4_ROWS - row } as React.CSSProperties) : undefined}
                    />
                  ) : isGhost ? (
                    <span
                      className={`${styles.disc} ${styles.ghost} ${
                        game.playerColor === 'r' ? styles.discR : styles.discY
                      }`}
                    />
                  ) : null}
                </span>
              );
            })}
          </button>
        );
      })}
    </div>
  );
}
