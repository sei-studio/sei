/**
 * SkinPreview3d — 240×320 canvas wrapping skinview3d for a live 3D Minecraft skin preview.
 *
 * Source: 09-UI-SPEC.md §"Skin editor (persona page section) — copy" + §"Animation & Motion"
 * (slow 30s rotate when in viewport + prefers-reduced-motion respected) +
 * §"Accessibility Contracts" (role=img + aria-label).
 *
 * Key contracts (planner WARNINGs):
 *   - skinview3d is LAZY-imported via dynamic `import('skinview3d')` inside useEffect —
 *     keeps it out of the initial renderer chunk (~50KB gz). A top-level static import
 *     would defeat that AND would also error at module-init in environments without
 *     WebGL (degrades to the 2D fallback below).
 *   - On dynamic-import failure OR a WebGL-context-creation failure, the component falls
 *     back to a 2D <img> rendered with image-rendering: pixelated, plus the verbatim copy
 *     `3D preview unavailable. Showing 2D thumbnail.` from UI-SPEC.
 *   - On unmount, viewer.dispose() releases the WebGL context + scene graph.
 *
 * a11y: canvas + fallback img both carry role="img" + aria-label tying the surface to
 * the persona's name. The canvas itself is not keyboard-focusable in v1 (UI-SPEC).
 */

import React, { useEffect, useRef, useState } from 'react';
import styles from './SkinPreview3d.module.css';

export interface SkinPreview3dProps {
  /** data:image/png;base64,... — null shows the "Loading preview…" empty state. */
  pngDataUrl: string | null;
  /** Persona name for aria-label and screen-reader narration. */
  personaName: string;
  className?: string;
}

/**
 * Minimal subset of the skinview3d API surface we actually call. Kept narrow so
 * the lazy `import('skinview3d')` doesn't propagate the full module type into our
 * compile graph (it would force tsc to walk three.js types — slow + irrelevant here).
 */
interface SkinViewerLike {
  loadSkin(source: string): Promise<void> | void;
  dispose(): void;
}

interface Skinview3dModule {
  SkinViewer: new (opts: {
    canvas: HTMLCanvasElement;
    width: number;
    height: number;
    skin?: string;
  }) => SkinViewerLike;
}

export function SkinPreview3d({
  pngDataUrl,
  personaName,
  className,
}: SkinPreview3dProps): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewerRef = useRef<SkinViewerLike | null>(null);
  const [fallback, setFallback] = useState<boolean>(false);
  const [ready, setReady] = useState<boolean>(false);

  // ── Mount the SkinViewer once on first render that has a pngDataUrl. ────
  //
  // We re-run this effect when pngDataUrl flips between null and a value
  // (mount/unmount the viewer accordingly) AND when the URL itself changes
  // (refresh the skin texture). The boolean `fallback` short-circuits to the
  // 2D <img> path on any failure — never re-enters the WebGL path until a
  // page reload (no point retrying with the same failed environment).
  useEffect(() => {
    if (fallback) return;
    if (!pngDataUrl) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    let cancelled = false;

    (async () => {
      // Split WebGL-init failures (fall back to 2D) from per-skin load
      // failures (keep the live viewer, ignore the bad skin). A loadSkin
      // failure on a server URL after Apply must NOT collapse the 3D
      // canvas — the WebGL context is still healthy.
      let mod: Skinview3dModule;
      try {
        mod = (await import('skinview3d')) as unknown as Skinview3dModule;
      } catch {
        if (!cancelled) setFallback(true);
        return;
      }
      if (cancelled) return;

      if (!viewerRef.current) {
        try {
          // Construct WITHOUT the initial `skin` arg. Passing skin: <url>
          // kicks off an async texture load inside the constructor that
          // throws an unhandled IndexSizeError inside getImageData when
          // the URL 404s (the texture decode runs against a 0-byte image).
          // Calling loadSkin separately lets us wrap it in try/catch.
          const viewer = new mod.SkinViewer({
            canvas,
            width: 240,
            height: 320,
          });
          viewerRef.current = viewer;
        } catch {
          if (!cancelled) setFallback(true);
          return;
        }
      }

      try {
        await viewerRef.current.loadSkin(pngDataUrl);
        if (!cancelled) setReady(true);
      } catch {
        // Skin URL failed (commonly /skins/<username>.png 404 when the
        // user hasn't applied a skin yet). Keep the viewer mounted so the
        // default Steve silhouette renders, and mark ready so the loading
        // hint clears. Do NOT flip to the 2D fallback — the WebGL context
        // is still healthy.
        if (!cancelled) setReady(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [pngDataUrl, fallback]);

  // ── Dispose on unmount so the WebGL context + scene graph release cleanly.
  useEffect(() => {
    return () => {
      if (viewerRef.current) {
        try {
          viewerRef.current.dispose();
        } catch {
          // ignore — best-effort cleanup
        }
        viewerRef.current = null;
      }
    };
  }, []);

  const ariaLabel = `3D preview of ${personaName}'s skin`;
  const frameClass = [styles.frame, className].filter(Boolean).join(' ');

  // ── Loading state: empty card frame with the "Loading preview…" copy. ───
  if (!pngDataUrl) {
    return (
      <div className={frameClass}>
        <span className={styles.loadingHint}>Loading preview...</span>
      </div>
    );
  }

  // ── 2D fallback (WebGL unavailable / lazy-import failure). ──────────────
  if (fallback) {
    return (
      <div className={frameClass}>
        <img
          className={styles.fallbackImg}
          src={pngDataUrl}
          role="img"
          aria-label={ariaLabel}
          alt={ariaLabel}
        />
        <span className={styles.fallbackHint}>
          3D preview unavailable. Showing 2D thumbnail.
        </span>
      </div>
    );
  }

  // ── 3D path: skinview3d-managed <canvas>. ───────────────────────────────
  return (
    <div className={frameClass}>
      <canvas
        ref={canvasRef}
        className={styles.canvas}
        width={240}
        height={320}
        role="img"
        aria-label={ariaLabel}
        // Hide the canvas until the viewer reports ready so we don't flash a
        // black frame on first mount. The frame's background already provides
        // a calm placeholder background.
        style={{ opacity: ready ? 1 : 0 }}
      />
    </div>
  );
}
