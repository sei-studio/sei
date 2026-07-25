/**
 * ChessBoard — the interactive 2D board (lichess-basics quality).
 *
 * Pure view over useChessStore: renders the display position (committed FEN +
 * any revealed pending AI move + a short-lived optimistic player move), and
 * turns pointer gestures into intents:
 *   - left drag OR click-click moves a piece (legal targets shown as dots,
 *     captures as rings; illegal drops snap back);
 *   - promotion opens a picker column over the target square;
 *   - right-button drag draws planning arrows, right-click toggles a circle,
 *     any left-click clears them — arrows are allowed at ALL times, including
 *     while the AI is thinking (the player can plan while waiting);
 *   - the last move, the checked king, and the selection are highlighted.
 *
 * The board is a CSS grid + percent-positioned piece layer, so it stays crisp
 * at any size; pieces are inline SVG (see pieces.tsx).
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useChessStore, boardUiFor } from '../../lib/stores/useChessStore';
import type { ChessColor } from '@shared/chessIpc';
import {
  FILES,
  RANKS,
  colOf,
  rowOf,
  squareAt,
  piecesOf,
  legalTargets,
  isPromotion,
  fenAfterUci,
  checkedKingSquare,
  type Square,
} from './chessUtil';
import { Piece } from './pieces';
import styles from './ChessBoard.module.css';

export interface ChessBoardProps {
  characterId: string;
}

/** Pieces offered by the promotion picker, in lichess order. */
const PROMO_PIECES = ['q', 'n', 'r', 'b'] as const;

/** Matches the slide keyframe duration in ChessBoard.module.css. */
const ANIM_MS = 320;

const pct = (n: number): string => `${n * 12.5}%`;

export function ChessBoard({ characterId }: ChessBoardProps): React.ReactElement | null {
  const game = useChessStore((s) => s.games[characterId]);
  const ui = useChessStore((s) => boardUiFor(s, characterId));
  const revealed = useChessStore((s) => s.revealed[characterId] ?? null);
  const setUi = useChessStore((s) => s.setUi);
  const dispatchMove = useChessStore((s) => s.move);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const ghostRef = useRef<HTMLDivElement | null>(null);

  /** Left-button drag in progress (from + whether the pointer really moved). */
  const [drag, setDrag] = useState<{ from: Square; moved: boolean } | null>(null);
  const dragDetail = useRef<{ pointerId: number; startX: number; startY: number } | null>(null);
  /** Square currently hovered while dragging (big ring, lichess-style). */
  const [dragOver, setDragOver] = useState<Square | null>(null);
  /** Right-button arrow draw in progress. */
  const [rightDrag, setRightDrag] = useState<{ from: Square; over: Square } | null>(null);
  /** Player move applied locally while the IPC round trip is in flight. */
  const [optimistic, setOptimistic] = useState<{ uci: string; fen: string } | null>(null);
  /** One-shot slide animation for the piece that just moved. */
  const [anim, setAnim] = useState<{ from: Square; to: Square; id: number } | null>(null);
  const animSeq = useRef(0);
  const animTimer = useRef<number | null>(null);

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

  // Reveal animation: the pending AI move just became visible; slide it in.
  useEffect(() => {
    if (!revealed || viewing) return;
    startAnim(revealed.slice(0, 2) as Square, revealed.slice(2, 4) as Square);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealed]);

  function startAnim(from: Square, to: Square): void {
    animSeq.current += 1;
    setAnim({ from, to, id: animSeq.current });
    if (animTimer.current !== null) window.clearTimeout(animTimer.current);
    animTimer.current = window.setTimeout(() => setAnim(null), ANIM_MS);
  }
  useEffect(
    () => () => {
      if (animTimer.current !== null) window.clearTimeout(animTimer.current);
    },
    [],
  );

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

  if (!game) return null;

  function squareAtPoint(clientX: number, clientY: number): Square | null {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return null;
    const col = Math.floor(((clientX - rect.left) / rect.width) * 8);
    const row = Math.floor(((clientY - rect.top) / rect.height) * 8);
    return squareAt(col, row, orientation);
  }

  function moveGhost(clientX: number, clientY: number): void {
    const rect = rootRef.current?.getBoundingClientRect();
    const el = ghostRef.current;
    if (!rect || !el) return;
    const half = rect.width / 16; // half a square
    el.style.transform = `translate(${clientX - rect.left - half}px, ${clientY - rect.top - half}px)`;
  }

  function submitMove(from: Square, to: Square, opts: { animate: boolean }): void {
    if (isPromotion(displayFen, from, to)) {
      setUi(characterId, { pendingPromotion: { from, to }, selected: null });
      return;
    }
    const uci = `${from}${to}`;
    setOptimistic({ uci, fen: fenAfterUci(displayFen, uci) });
    if (opts.animate) startAnim(from, to);
    setUi(characterId, { selected: null });
    void dispatchMove(characterId, uci);
  }

  function pickPromotion(piece: string): void {
    if (!pendingPromotion) return;
    const { from, to } = pendingPromotion;
    const uci = `${from}${to}${piece}`;
    setOptimistic({ uci, fen: fenAfterUci(displayFen, uci) });
    startAnim(from as Square, to as Square);
    setUi(characterId, { pendingPromotion: null, selected: null });
    void dispatchMove(characterId, uci);
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>): void {
    const sq = squareAtPoint(e.clientX, e.clientY);
    if (e.button === 2) {
      if (!sq) return;
      e.preventDefault();
      rootRef.current?.setPointerCapture(e.pointerId);
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
      submitMove(ui.selected as Square, sq, { animate: true });
      return;
    }
    if (canMove && ownPiece) {
      rootRef.current?.setPointerCapture(e.pointerId);
      dragDetail.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY };
      setDrag({ from: sq, moved: false });
      setDragOver(sq);
      setUi(characterId, { selected: sq });
      moveGhost(e.clientX, e.clientY);
      return;
    }
    if (ui.selected) setUi(characterId, { selected: null });
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>): void {
    if (rightDrag) {
      const sq = squareAtPoint(e.clientX, e.clientY);
      if (sq && sq !== rightDrag.over) setRightDrag({ ...rightDrag, over: sq });
      return;
    }
    if (!drag || dragDetail.current?.pointerId !== e.pointerId) return;
    if (!drag.moved) {
      const dx = e.clientX - (dragDetail.current?.startX ?? 0);
      const dy = e.clientY - (dragDetail.current?.startY ?? 0);
      if (dx * dx + dy * dy > 16) setDrag({ ...drag, moved: true });
    }
    moveGhost(e.clientX, e.clientY);
    const sq = squareAtPoint(e.clientX, e.clientY);
    if (sq !== dragOver) setDragOver(sq);
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>): void {
    if (rightDrag && e.button === 2) {
      const to = squareAtPoint(e.clientX, e.clientY) ?? rightDrag.over;
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
    setDrag(null);
    setDragOver(null);
    dragDetail.current = null;
    if (!moved) return; // a plain click: selection stays, targets shown
    const to = squareAtPoint(e.clientX, e.clientY);
    if (to && to !== from && targetSet.has(to)) {
      submitMove(from, to, { animate: false });
    }
    // Illegal or off-board drop: the piece simply re-renders at its origin
    // (snap back); the selection stays so the dots remain visible.
  }

  function onPointerCancel(): void {
    setDrag(null);
    setDragOver(null);
    setRightDrag(null);
    dragDetail.current = null;
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const squares: React.ReactElement[] = [];
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const sq = squareAt(col, row, orientation)!;
      const dark = (col + row) % 2 === 1;
      squares.push(
        <div key={sq} className={dark ? styles.sqDark : styles.sqLight}>
          {col === 0 ? (
            <span className={styles.coordRank}>
              {orientation === 'w' ? RANKS[7 - row] : RANKS[row]}
            </span>
          ) : null}
          {row === 7 ? (
            <span className={styles.coordFile}>
              {orientation === 'w' ? FILES[col] : FILES[7 - col]}
            </span>
          ) : null}
        </div>,
      );
    }
  }

  const posStyle = (sq: string): React.CSSProperties => ({
    left: pct(colOf(sq, orientation)),
    top: pct(rowOf(sq, orientation)),
  });

  const highlights: React.ReactElement[] = [];
  if (lastMoveUci) {
    highlights.push(
      <div key="lm-from" className={styles.lastMove} style={posStyle(lastMoveUci.slice(0, 2))} />,
      <div key="lm-to" className={styles.lastMove} style={posStyle(lastMoveUci.slice(2, 4))} />,
    );
  }
  if (ui.selected) {
    highlights.push(
      <div key="sel" className={styles.selected} style={posStyle(ui.selected)} />,
    );
  }
  if (checkSq) {
    highlights.push(<div key="check" className={styles.check} style={posStyle(checkSq)} />);
  }
  if (drag && dragOver && dragOver !== drag.from) {
    highlights.push(
      <div key="over" className={styles.dragOver} style={posStyle(dragOver)} />,
    );
  }
  for (const t of targets) {
    highlights.push(
      <div
        key={`dot-${t.to}`}
        className={t.capture ? styles.captureRing : styles.moveDot}
        style={posStyle(t.to)}
      />,
    );
  }

  const arrowsToDraw = rightDrag && rightDrag.over !== rightDrag.from
    ? [...ui.arrows, { from: rightDrag.from, to: rightDrag.over }]
    : ui.arrows;

  const center = (sq: string): { x: number; y: number } => ({
    x: colOf(sq, orientation) + 0.5,
    y: rowOf(sq, orientation) + 0.5,
  });

  return (
    <div
      ref={rootRef}
      className={styles.board}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onContextMenu={(e) => e.preventDefault()}
      role="application"
      aria-label="Chess board"
    >
      <div className={styles.squares}>{squares}</div>
      <div className={styles.layer}>{highlights}</div>

      {/* Pieces */}
      <div className={styles.layer}>
        {pieces.map((p) => {
          const isDragged = drag?.moved && p.square === drag.from;
          const animated = anim && p.square === anim.to;
          const style: React.CSSProperties = { ...posStyle(p.square) };
          if (animated) {
            const dx = (colOf(anim.from, orientation) - colOf(anim.to, orientation)) * 100;
            const dy = (rowOf(anim.from, orientation) - rowOf(anim.to, orientation)) * 100;
            (style as Record<string, string>)['--slide-x'] = `${dx}%`;
            (style as Record<string, string>)['--slide-y'] = `${dy}%`;
          }
          return (
            <div
              key={`${p.square}${animated ? `-a${anim.id}` : ''}`}
              className={[
                styles.piece,
                p.code[0] === 'b' ? styles.pieceBlack : '',
                isDragged ? styles.pieceHidden : '',
                animated ? styles.pieceSlide : '',
              ]
                .filter(Boolean)
                .join(' ')}
              style={style}
            >
              <Piece code={p.code} />
            </div>
          );
        })}
      </div>

      {/* Dragged piece follows the cursor */}
      {drag?.moved ? (
        <div ref={ghostRef} className={styles.ghost}>
          <Piece code={pieceBySquare.get(drag.from) ?? ''} />
        </div>
      ) : (
        <div ref={ghostRef} className={styles.ghostHidden} />
      )}

      {/* Planning arrows + circles */}
      {arrowsToDraw.length || ui.circles.length ? (
        <svg className={styles.arrows} viewBox="0 0 8 8" aria-hidden="true">
          <defs>
            <marker
              id="chess-arrowhead"
              viewBox="0 0 10 10"
              refX="6"
              refY="5"
              markerWidth="3.2"
              markerHeight="3.2"
              orient="auto-start-reverse"
            >
              <path d="M0 0 L10 5 L0 10 z" className={styles.arrowHead} />
            </marker>
          </defs>
          {ui.circles.map((sq) => {
            const c = center(sq);
            return (
              <circle
                key={`c-${sq}`}
                cx={c.x}
                cy={c.y}
                r={0.42}
                className={styles.circleMark}
              />
            );
          })}
          {arrowsToDraw.map((a, i) => {
            const f = center(a.from);
            const t = center(a.to);
            const dx = t.x - f.x;
            const dy = t.y - f.y;
            const len = Math.hypot(dx, dy) || 1;
            // Pull the tail off the piece and leave room for the arrowhead.
            const sx = f.x + (dx / len) * 0.28;
            const sy = f.y + (dy / len) * 0.28;
            const ex = t.x - (dx / len) * 0.22;
            const ey = t.y - (dy / len) * 0.22;
            return (
              <line
                key={`a-${a.from}${a.to}-${i}`}
                x1={sx}
                y1={sy}
                x2={ex}
                y2={ey}
                className={styles.arrowLine}
                markerEnd="url(#chess-arrowhead)"
              />
            );
          })}
        </svg>
      ) : null}

      {/* Promotion picker over the target square's file */}
      {pendingPromotion ? (
        <>
          <div
            className={styles.promoScrim}
            onPointerDown={(e) => {
              e.stopPropagation();
              setUi(characterId, { pendingPromotion: null });
            }}
          />
          {PROMO_PIECES.map((piece, i) => {
            const col = colOf(pendingPromotion.to, orientation);
            const baseRow = rowOf(pendingPromotion.to, orientation);
            const row = baseRow === 0 ? i : 7 - i;
            return (
              <button
                key={piece}
                type="button"
                className={styles.promoBtn}
                style={{ left: pct(col), top: pct(row) }}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => pickPromotion(piece)}
                aria-label={`Promote to ${
                  piece === 'q' ? 'queen' : piece === 'n' ? 'knight' : piece === 'r' ? 'rook' : 'bishop'
                }`}
              >
                <Piece code={`${playerColor}${piece}`} />
              </button>
            );
          })}
        </>
      ) : null}
    </div>
  );
}
