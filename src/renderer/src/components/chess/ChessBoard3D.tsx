/**
 * ChessBoard3D — the interactive chess viewport, rendered as a 3D scene
 * (Clubhouse-Games-style wooden table, see three/ChessScene.ts).
 *
 * Pure view over useChessStore, same contract as the old 2D board: it renders
 * the display position (committed FEN + any revealed pending AI move + a
 * short-lived optimistic player move) and turns pointer gestures into intents:
 *   - left click-click OR left drag moves a piece (legal targets shown as
 *     discs, captures as rings; illegal drops settle back);
 *   - promotion opens a centered picker card over the viewport;
 *   - right-button drag draws planning arrows on the board surface,
 *     right-click toggles a circle, any left press clears them;
 *   - the last move, the checked king, the selection, and the hovered square
 *     are highlighted on the board surface;
 *   - a subtle turn label sits over the scene, top-center: "Your move" /
 *     "{Name}'s move", or a shimmering "{Name} is thinking…" while the AI
 *     decides, with a dim Elo tag beneath it.
 *
 * All game state stays in main behind IPC; this file only decides what to
 * show and forwards intents through the store, exactly like ChessBoard.tsx.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useChessStore, boardUiFor } from '../../lib/stores/useChessStore';
import type { ChessColor } from '@shared/chessIpc';
import {
  piecesOf,
  legalTargets,
  isPromotion,
  fenAfterUci,
  checkedKingSquare,
  type Square,
} from './chessUtil';
import { Piece } from './pieces';
import { ChessScene } from './three/ChessScene';
import styles from './ChessBoard3D.module.css';

export interface ChessBoard3DProps {
  characterId: string;
  /** Companion display name, shown in the turn label ("{Name}'s move"). */
  companionName: string;
}

/** Pieces offered by the promotion picker, in lichess order. */
const PROMO_PIECES = ['q', 'n', 'r', 'b'] as const;

const PROMO_NAMES: Record<(typeof PROMO_PIECES)[number], string> = {
  q: 'queen',
  n: 'knight',
  r: 'rook',
  b: 'bishop',
};

export function ChessBoard3D({
  characterId,
  companionName,
}: ChessBoard3DProps): React.ReactElement | null {
  const game = useChessStore((s) => s.games[characterId]);
  const ui = useChessStore((s) => boardUiFor(s, characterId));
  const revealed = useChessStore((s) => s.revealed[characterId] ?? null);
  const setUi = useChessStore((s) => s.setUi);
  const dispatchMove = useChessStore((s) => s.move);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scene, setScene] = useState<ChessScene | null>(null);

  /** Left-button drag in progress (from + whether the pointer really moved). */
  const [drag, setDrag] = useState<{ from: Square; moved: boolean } | null>(null);
  const dragDetail = useRef<{ pointerId: number; startX: number; startY: number } | null>(null);
  /** Square currently hovered while dragging (drop-target ring). */
  const [dragOver, setDragOver] = useState<Square | null>(null);
  /** Square hovered while idle (own piece / legal target affordance). */
  const [hover, setHover] = useState<Square | null>(null);
  /** Right-button arrow draw in progress. */
  const [rightDrag, setRightDrag] = useState<{ from: Square; over: Square } | null>(null);
  /** Player move applied locally while the IPC round trip is in flight. */
  const [optimistic, setOptimistic] = useState<{ uci: string; fen: string } | null>(null);

  const viewing = ui.viewPly !== null;
  const playerColor: ChessColor = game?.playerColor ?? 'w';
  const orientation: ChessColor = ui.flip ? (playerColor === 'w' ? 'b' : 'w') : playerColor;

  // Display position: scrubbed history frame, else committed + local overlays.
  const liveFen = useMemo(() => {
    if (!game) return '';
    if (optimistic) return optimistic.fen;
    return revealed ? fenAfterUci(game.fen, revealed) : game.fen;
  }, [game, optimistic, revealed]);
  const displayFen = useMemo(() => {
    if (!game) return '';
    if (ui.viewPly !== null) return game.history[ui.viewPly]?.fen ?? liveFen;
    return liveFen;
  }, [game, ui.viewPly, liveFen]);

  const pieces = useMemo(() => piecesOf(displayFen), [displayFen]);
  const pieceBySquare = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of pieces) map.set(p.square, p.code);
    return map;
  }, [pieces]);

  const canMove =
    !!game &&
    !viewing &&
    !optimistic &&
    !revealed &&
    game.status === 'active' &&
    game.turn === game.playerColor &&
    !game.aiThinking;

  const targets = useMemo(() => {
    const from = drag?.from ?? ui.selected;
    if (!canMove || !from) return [];
    return legalTargets(displayFen, from as Square);
  }, [canMove, drag, ui.selected, displayFen]);
  const targetSet = useMemo(() => new Set(targets.map((t) => t.to as string)), [targets]);

  const lastMoveUci = useMemo(() => {
    if (!game) return null;
    if (ui.viewPly !== null) return game.history[ui.viewPly]?.uci ?? null;
    if (optimistic) return optimistic.uci;
    if (revealed) return revealed;
    return game.history.length ? game.history[game.history.length - 1].uci : null;
  }, [game, ui.viewPly, optimistic, revealed]);

  const checkSq = useMemo(() => (displayFen ? checkedKingSquare(displayFen) : null), [displayFen]);

  // The committed FEN moved on (main applied our move / a new push landed):
  // drop the optimistic overlay.
  const committedFen = game?.fen ?? '';
  const gameId = game?.gameId ?? '';
  useEffect(() => {
    setOptimistic(null);
  }, [committedFen, gameId]);

  // Esc cancels the promotion picker.
  const pendingPromotion = ui.pendingPromotion;
  useEffect(() => {
    if (!pendingPromotion) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setUi(characterId, { pendingPromotion: null });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pendingPromotion, characterId, setUi]);

  // ── Scene lifecycle + pushes ─────────────────────────────────────────────
  const hasGame = !!game;
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !hasGame) return;
    const s = new ChessScene(el);
    setScene(s);
    return () => {
      s.dispose();
      setScene(null);
    };
  }, [hasGame]);

  useEffect(() => {
    scene?.setOrientation(orientation);
  }, [scene, orientation]);

  useEffect(() => {
    scene?.setPieces(pieces);
  }, [scene, pieces]);

  useEffect(() => {
    if (!scene) return;
    const hoverSq = drag ? (dragOver && dragOver !== drag.from ? dragOver : null) : hover;
    scene.setMarks({
      selected: ui.selected,
      lastMove: lastMoveUci
        ? { from: lastMoveUci.slice(0, 2), to: lastMoveUci.slice(2, 4) }
        : null,
      check: checkSq,
      hover: hoverSq,
      targets: targets.map((t) => ({ to: t.to as string, capture: t.capture })),
    });
  }, [scene, ui.selected, lastMoveUci, checkSq, targets, drag, dragOver, hover]);

  useEffect(() => {
    if (!scene) return;
    const arrows =
      rightDrag && rightDrag.over !== rightDrag.from
        ? [...ui.arrows, { from: rightDrag.from, to: rightDrag.over }]
        : ui.arrows;
    scene.setOverlays(arrows, ui.circles);
  }, [scene, ui.arrows, ui.circles, rightDrag]);

  if (!game) return null;

  // ── Intents ──────────────────────────────────────────────────────────────

  function submitMove(from: Square, to: Square): void {
    if (isPromotion(displayFen, from, to)) {
      setUi(characterId, { pendingPromotion: { from, to }, selected: null });
      return;
    }
    const uci = `${from}${to}`;
    setOptimistic({ uci, fen: fenAfterUci(displayFen, uci) });
    setUi(characterId, { selected: null });
    void dispatchMove(characterId, uci);
  }

  function pickPromotion(piece: string): void {
    if (!pendingPromotion) return;
    const { from, to } = pendingPromotion;
    const uci = `${from}${to}${piece}`;
    setOptimistic({ uci, fen: fenAfterUci(displayFen, uci) });
    setUi(characterId, { pendingPromotion: null, selected: null });
    void dispatchMove(characterId, uci);
  }

  function pick(clientX: number, clientY: number): Square | null {
    return scene?.squareAtPointer(clientX, clientY) ?? null;
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>): void {
    const sq = pick(e.clientX, e.clientY);
    if (e.button === 2) {
      if (!sq) return;
      e.preventDefault();
      containerRef.current?.setPointerCapture(e.pointerId);
      setRightDrag({ from: sq, over: sq });
      return;
    }
    if (e.button !== 0) return;
    // Any left press clears planning marks (lichess convention).
    if (ui.arrows.length || ui.circles.length) setUi(characterId, { arrows: [], circles: [] });
    if (pendingPromotion) {
      setUi(characterId, { pendingPromotion: null });
      return;
    }
    if (!sq) return;
    const code = pieceBySquare.get(sq);
    const ownPiece = !!code && code[0] === playerColor;
    // Click-click completion: a selected piece + a legal target square.
    if (canMove && ui.selected && sq !== ui.selected && targetSet.has(sq)) {
      submitMove(ui.selected as Square, sq);
      return;
    }
    if (canMove && ownPiece) {
      containerRef.current?.setPointerCapture(e.pointerId);
      dragDetail.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY };
      setDrag({ from: sq, moved: false });
      setDragOver(sq);
      setHover(null);
      setUi(characterId, { selected: sq });
      // Pass the pointer so the scene can capture the grab offset: the piece
      // keeps the grip it was picked up with instead of snapping its centre
      // under the cursor.
      scene?.liftPiece(sq, e.clientX, e.clientY);
      return;
    }
    if (ui.selected) setUi(characterId, { selected: null });
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>): void {
    if (rightDrag) {
      const sq = pick(e.clientX, e.clientY);
      if (sq && sq !== rightDrag.over) setRightDrag({ ...rightDrag, over: sq });
      return;
    }
    if (!drag || dragDetail.current?.pointerId !== e.pointerId) {
      // Idle hover affordance: own pieces and legal targets light up.
      if (!canMove) {
        if (hover) setHover(null);
        return;
      }
      const sq = pick(e.clientX, e.clientY);
      const code = sq ? pieceBySquare.get(sq) : undefined;
      const interesting = !!sq && ((!!code && code[0] === playerColor) || targetSet.has(sq));
      const next = interesting ? sq : null;
      if (next !== hover) setHover(next);
      return;
    }
    if (!drag.moved) {
      const dx = e.clientX - (dragDetail.current?.startX ?? 0);
      const dy = e.clientY - (dragDetail.current?.startY ?? 0);
      if (dx * dx + dy * dy > 16) setDrag({ ...drag, moved: true });
    }
    scene?.dragPiece(e.clientX, e.clientY);
    // The drop target is the square under the PIECE, not under the raw pointer
    // ray — otherwise the ring highlights a square the piece does not cover.
    const sq = scene?.draggedSquare() ?? null;
    if (sq !== dragOver) setDragOver(sq);
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>): void {
    if (rightDrag && e.button === 2) {
      const to = pick(e.clientX, e.clientY) ?? rightDrag.over;
      if (to === rightDrag.from) {
        const has = ui.circles.includes(to);
        setUi(characterId, {
          circles: has ? ui.circles.filter((c) => c !== to) : [...ui.circles, to],
        });
      } else {
        const exists = ui.arrows.some((a) => a.from === rightDrag.from && a.to === to);
        setUi(characterId, {
          arrows: exists
            ? ui.arrows.filter((a) => !(a.from === rightDrag.from && a.to === to))
            : [...ui.arrows, { from: rightDrag.from, to }],
        });
      }
      setRightDrag(null);
      return;
    }
    if (!drag || e.button !== 0) return;
    const from = drag.from;
    const moved = drag.moved;
    // Read the drop square BEFORE releasePiece clears the scene's drag state.
    const to = scene?.draggedSquare() ?? null;
    setDrag(null);
    setDragOver(null);
    dragDetail.current = null;
    if (!moved) {
      // A plain click: the piece settles; selection stays, targets shown.
      scene?.releasePiece(true);
      return;
    }
    if (to && to !== from && targetSet.has(to)) {
      if (isPromotion(displayFen, from, to)) {
        scene?.releasePiece(true);
        setUi(characterId, { pendingPromotion: { from, to }, selected: null });
      } else {
        // Leave the piece floating; the optimistic position lerps it home.
        scene?.releasePiece(false);
        submitMove(from, to);
      }
      return;
    }
    // Illegal or off-board drop: settle back; selection stays visible.
    scene?.releasePiece(true);
  }

  function onPointerCancel(): void {
    scene?.releasePiece(true);
    setDrag(null);
    setDragOver(null);
    setRightDrag(null);
    dragDetail.current = null;
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const sideToMove = displayFen.split(' ')[1] === 'b' ? 'b' : 'w';
  const turnLabel = game.aiThinking
    ? `${companionName} is thinking…`
    : sideToMove === game.playerColor
      ? 'Your move'
      : `${companionName}'s move`;

  return (
    <div
      ref={containerRef}
      className={styles.viewport}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onPointerLeave={() => {
        if (!drag && hover) setHover(null);
      }}
      onContextMenu={(e) => e.preventDefault()}
      role="application"
      aria-label="Chess board"
    >
      <div className={styles.topCenter}>
        {game.status === 'active' ? (
          <div
            className={game.aiThinking ? `${styles.turnChip} ${styles.thinking}` : styles.turnChip}
            aria-live="polite"
          >
            {turnLabel}
          </div>
        ) : null}
        <div className={styles.eloTag}>Elo ~{game.aiElo}</div>
      </div>

      {/* Promotion picker */}
      {pendingPromotion ? (
        <>
          <div
            className={styles.promoScrim}
            onPointerDown={(e) => {
              e.stopPropagation();
              setUi(characterId, { pendingPromotion: null });
            }}
          />
          <div className={styles.promoCard} onPointerDown={(e) => e.stopPropagation()}>
            <div className={styles.promoTitle}>Promote to</div>
            <div className={styles.promoRow}>
              {PROMO_PIECES.map((piece) => (
                <button
                  key={piece}
                  type="button"
                  className={styles.promoBtn}
                  onClick={() => pickPromotion(piece)}
                  aria-label={`Promote to ${PROMO_NAMES[piece]}`}
                >
                  <Piece code={`${playerColor}${piece}`} />
                </button>
              ))}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
