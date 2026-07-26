/**
 * McDashMinimap — top-down minimap canvas for the Minecraft dashboard
 * (260721). Renders the bot's packed cell grid (palette index + height
 * shading per byte, see src/shared/mcDashboardIpc.ts) at 1px per cell and
 * lets CSS scale it up with image-rendering: pixelated for the chunky
 * in-game-map look. A rotated arrow overlay marks the bot at the center
 * (mineflayer view direction: x = -sin(yaw), z = -cos(yaw)). North is up.
 */

import React, { useEffect, useMemo, useRef } from 'react';
import {
  MC_DASH_PALETTE_COLORS,
  decodeMcDashCells,
  mcDashCellHeight,
  mcDashCellPalette,
  type McDashMap,
} from '@shared/mcDashboardIpc';
import styles from './McDashMinimap.module.css';

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

const PALETTE_RGB = MC_DASH_PALETTE_COLORS.map(hexToRgb);

export interface McDashMinimapProps {
  map: McDashMap | null;
  /** Facing in radians (mineflayer convention). */
  yaw: number;
  /** Rendered edge length in px. */
  sizePx: number;
}

export function McDashMinimap({ map, yaw, sizePx }: McDashMinimapProps): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const cells = useMemo(() => (map ? decodeMcDashCells(map.cells) : null), [map]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !map || !cells) return;
    const size = map.size;
    if (cells.length < size * size) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = ctx.createImageData(size, size);
    for (let i = 0; i < size * size; i++) {
      const byte = cells[i];
      const [r, g, b] = PALETTE_RGB[mcDashCellPalette(byte)] ?? PALETTE_RGB[0];
      // Height shading: higher terrain brighter, lower darker (map-item look).
      const f = 1 + mcDashCellHeight(byte) * 0.045;
      const o = i * 4;
      img.data[o] = Math.max(0, Math.min(255, Math.round(r * f)));
      img.data[o + 1] = Math.max(0, Math.min(255, Math.round(g * f)));
      img.data[o + 2] = Math.max(0, Math.min(255, Math.round(b * f)));
      img.data[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }, [map, cells]);

  // Canvas rotation: 0 = up. View dir (dx,dz) = (-sin yaw, -cos yaw); up on
  // the canvas is -z, so the arrow angle from "up" is atan2(dx, -dz).
  const angleDeg = (Math.atan2(-Math.sin(yaw), Math.cos(yaw)) * 180) / Math.PI;

  return (
    <div className={styles.wrap} style={{ width: sizePx, height: sizePx }}>
      {map ? (
        <canvas
          ref={canvasRef}
          width={map.size}
          height={map.size}
          className={styles.canvas}
          aria-label="Minimap around the companion"
        />
      ) : (
        <div className={styles.empty}>Surveying...</div>
      )}
      {map ? (
        <svg
          className={styles.arrow}
          viewBox="0 0 10 10"
          style={{ transform: `translate(-50%, -50%) rotate(${angleDeg}deg)` }}
          aria-hidden="true"
        >
          <polygon points="5,0.5 9,9 5,6.6 1,9" fill="#ffffff" stroke="#101014" strokeWidth="0.8" />
        </svg>
      ) : null}
    </div>
  );
}
