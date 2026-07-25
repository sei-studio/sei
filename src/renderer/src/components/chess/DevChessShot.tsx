/**
 * DevChessShot — dev-only screenshot harness, NOT part of the app UI.
 *
 * main.tsx lazy-loads this behind `import.meta.env.DEV` when the renderer URL
 * carries `?chessshot=1`, e.g.
 *
 *     http://localhost:5173/?chessshot=1
 *
 * It renders ONLY the 3D chess scene, full viewport, with a fixed
 * Italian-game middlegame at the standard camera angle and no HUD. It is used
 * to capture the launch-screen background (public/img/chess-launch.png).
 * Deliberately zero window.sei / store access so it also works in a plain
 * browser tab outside Electron.
 */

import React, { useEffect, useRef } from 'react';
import { ChessScene } from './three/ChessScene';
import { piecesOf } from './chessUtil';

/** Italian-game middlegame: castled kings, mutual Bg5/Bg4 pins. */
const SHOT_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export function DevChessShot(): React.ReactElement {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const scene = new ChessScene(el);
    scene.setPieces(piecesOf(SHOT_FEN));
    return () => scene.dispose();
  }, []);

  // Fixed full-viewport mount; the backdrop matches the scene background so
  // resize flashes stay dark.
  return <div ref={ref} style={{ position: 'fixed', inset: 0, background: '#1a120c' }} />;
}
