import React from 'react';
import { Easing, interpolate } from 'remotion';

/**
 * Camera rig: a list of keyframes (frame, focus point in stage coordinates,
 * zoom). Between keyframes the camera glides with an ease-in-out; outside the
 * range it holds. The stage is rendered at its design size and transformed so
 * the focus point lands at the viewport center at the requested scale.
 */
export interface CamKey {
  f: number; // frame
  x: number; // focus x in stage coords
  y: number; // focus y in stage coords
  s: number; // scale
}

const easec = Easing.bezier(0.45, 0.05, 0.3, 0.95);

export const camAt = (keys: CamKey[], frame: number): { x: number; y: number; s: number } => {
  if (frame <= keys[0].f) return keys[0];
  const last = keys[keys.length - 1];
  if (frame >= last.f) return last;
  let i = 0;
  while (keys[i + 1].f < frame) i++;
  const a = keys[i];
  const b = keys[i + 1];
  const t = interpolate(frame, [a.f, b.f], [0, 1], { easing: easec });
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    s: a.s + (b.s - a.s) * t,
  };
};

export const Camera: React.FC<{
  keys: CamKey[];
  frame: number;
  width?: number;
  height?: number;
  children: React.ReactNode;
}> = ({ keys, frame, width = 1920, height = 1080, children }) => {
  const { x, y, s } = camAt(keys, frame);
  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width,
          height,
          transformOrigin: '0 0',
          transform: `translate(${width / 2 - x * s}px, ${height / 2 - y * s}px) scale(${s})`,
        }}
      >
        {children}
      </div>
    </div>
  );
};
