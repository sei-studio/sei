import React from 'react';
import { Easing, interpolate } from 'remotion';

/** Waypoint path for the cursor, eased per-leg, with a click "press" scale. */
export interface CursorKey {
  f: number;
  x: number;
  y: number;
}

const easec = Easing.bezier(0.3, 0.1, 0.25, 1);

export const cursorAt = (keys: CursorKey[], frame: number): { x: number; y: number } => {
  if (frame <= keys[0].f) return keys[0];
  const last = keys[keys.length - 1];
  if (frame >= last.f) return last;
  let i = 0;
  while (keys[i + 1].f < frame) i++;
  const a = keys[i];
  const b = keys[i + 1];
  const t = interpolate(frame, [a.f, b.f], [0, 1], { easing: easec });
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
};

/** Standard macOS-style pointer, tip at (0,0). */
export const Cursor: React.FC<{
  keys: CursorKey[];
  frame: number;
  clicks?: number[]; // frames at which a click lands
  opacity?: number;
  scale?: number;
}> = ({ keys, frame, clicks = [], opacity = 1, scale = 1 }) => {
  const { x, y } = cursorAt(keys, frame);
  // Press: shrink slightly for 6 frames around each click.
  let press = 0;
  for (const c of clicks) {
    if (frame >= c - 2 && frame <= c + 4) {
      press = Math.max(press, 1 - Math.abs(frame - (c + 1)) / 3);
    }
  }
  const s = scale * (1 - press * 0.18);
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        transform: `scale(${s})`,
        transformOrigin: '4px 4px',
        opacity,
        zIndex: 500,
        pointerEvents: 'none',
      }}
    >
      {/* Click ripple */}
      {clicks.map((c) => {
        if (frame < c || frame > c + 14) return null;
        const t = (frame - c) / 14;
        return (
          <div
            key={c}
            style={{
              position: 'absolute',
              left: 4 - 26 * t,
              top: 4 - 26 * t,
              width: 52 * t,
              height: 52 * t,
              borderRadius: '50%',
              border: '3px solid rgba(127, 176, 255, 0.9)',
              opacity: 1 - t,
            }}
          />
        );
      })}
      <svg width="34" height="46" viewBox="0 0 17 23" style={{ display: 'block' }}>
        <path
          d="M1 1 L1 17.5 L5.2 13.6 L7.9 20 L11 18.7 L8.3 12.4 L14 12 Z"
          fill="#ffffff"
          stroke="#1a1a1a"
          strokeWidth="1.1"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
};
