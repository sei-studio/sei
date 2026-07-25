/**
 * McDashAvatar — the player-model viewport in the Minecraft dashboard's
 * inventory dialog (260721), the dark inset window beside the armor slots,
 * exactly like the real Java Edition inventory screen.
 *
 * Renders the companion's ACTUAL in-game skin: the local skin server serves
 * persona skins at /skins/<username>.png (same bytes CustomSkinLoader
 * fetches), and skinview3d (already a dependency; a three.js classic boxy
 * player model with per-face 64x64 UV mapping, slim-arm alpha detection and
 * inflated hat/outer layers) draws it with a gentle idle sway.
 *
 * Contracts mirrored from SkinPreview3d.tsx:
 *   - skinview3d is LAZY-imported inside useEffect (keeps it out of the
 *     initial chunk; environments without WebGL degrade gracefully).
 *   - viewer.dispose() on unmount releases the WebGL context.
 *   - loadSkin failures (skin not cached yet -> the server 404s with a 1x1
 *     transparent PNG) fall back to an ORIGINAL flat-color mannequin skin
 *     generated on a scratch canvas — never a bundled Mojang asset.
 */

import React, { useEffect, useRef, useState } from 'react';
import styles from './McDashboardPanel.module.css';

/** Narrow view of the skinview3d surface we call (keeps tsc off three.js types). */
interface SkinViewerLike {
  loadSkin(source: string): Promise<void> | void;
  dispose(): void;
  animation?: unknown;
  controls?: { enableZoom?: boolean; enablePan?: boolean };
}

interface Skinview3dModule {
  SkinViewer: new (opts: {
    canvas: HTMLCanvasElement;
    width: number;
    height: number;
    zoom?: number;
    fov?: number;
  }) => SkinViewerLike;
  IdleAnimation?: new () => unknown;
}

/**
 * Original placeholder skin: a flat two-tone mannequin painted onto the
 * standard 64x64 layout (base-layer regions only, outer layers transparent).
 * Used when the persona has no cached skin yet so the window still shows a
 * player model instead of going blank. Not a Mojang asset.
 */
function mannequinSkinDataUrl(): string | null {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.clearRect(0, 0, 64, 64);
  const head = '#a8a8b4';
  const torso = '#6c7f9c';
  const limbs = '#5a5a66';
  ctx.fillStyle = head;
  ctx.fillRect(0, 0, 32, 16); // head (all faces)
  ctx.fillStyle = torso;
  ctx.fillRect(16, 16, 24, 16); // body
  ctx.fillStyle = limbs;
  ctx.fillRect(0, 16, 16, 16); // right leg
  ctx.fillRect(40, 16, 16, 16); // right arm
  ctx.fillRect(16, 48, 16, 16); // left leg
  ctx.fillRect(32, 48, 16, 16); // left arm
  // Simple face pixels so the front reads as a face.
  ctx.fillStyle = '#2c2c34';
  ctx.fillRect(10, 12, 2, 1);
  ctx.fillRect(14, 12, 2, 1);
  return c.toDataURL('image/png');
}

export interface McDashAvatarProps {
  /** Skin PNG URL (the skin server route), or null while the base resolves. */
  skinUrl: string | null;
  /** Companion name for the aria label. */
  name: string;
  width: number;
  height: number;
}

export function McDashAvatar({ skinUrl, name, width, height }: McDashAvatarProps): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewerRef = useRef<SkinViewerLike | null>(null);
  const [failed, setFailed] = useState<boolean>(false);

  useEffect(() => {
    if (failed || !skinUrl) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;

    (async () => {
      let mod: Skinview3dModule;
      try {
        mod = (await import('skinview3d')) as unknown as Skinview3dModule;
      } catch {
        if (!cancelled) setFailed(true);
        return;
      }
      if (cancelled) return;

      if (!viewerRef.current) {
        try {
          // No initial `skin` option: constructing with a URL that 404s
          // throws inside the constructor's async texture decode (see
          // SkinPreview3d). loadSkin below is wrapped instead.
          const viewer = new mod.SkinViewer({ canvas, width, height, zoom: 0.85 });
          if (viewer.controls) {
            viewer.controls.enableZoom = false;
            viewer.controls.enablePan = false;
          }
          try {
            if (mod.IdleAnimation) viewer.animation = new mod.IdleAnimation();
          } catch {
            /* static pose is acceptable */
          }
          viewerRef.current = viewer;
        } catch {
          if (!cancelled) setFailed(true);
          return;
        }
      }

      try {
        await viewerRef.current.loadSkin(skinUrl);
      } catch {
        // Skin not cached yet (server 404s a 1x1 transparent PNG). Show the
        // original mannequin so the window still has a player model.
        try {
          const placeholder = mannequinSkinDataUrl();
          if (placeholder && !cancelled) await viewerRef.current.loadSkin(placeholder);
        } catch {
          /* keep whatever the viewer currently shows */
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [skinUrl, failed, width, height]);

  useEffect(() => {
    return () => {
      if (viewerRef.current) {
        try {
          viewerRef.current.dispose();
        } catch {
          /* best-effort cleanup */
        }
        viewerRef.current = null;
      }
    };
  }, []);

  return (
    <div className={styles.avatarWindow} style={{ width, height }}>
      {failed ? (
        <span className={styles.avatarFallback} aria-hidden="true" />
      ) : (
        <canvas
          ref={canvasRef}
          className={styles.avatarCanvas}
          width={width}
          height={height}
          role="img"
          aria-label={`${name}'s player model`}
        />
      )}
    </div>
  );
}
