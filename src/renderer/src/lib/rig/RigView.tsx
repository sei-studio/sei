/**
 * RigView (260817) â€” renders a 'rig'-kind avatar: a rig.json + aligned PNG
 * layers (the chibi-rig pipeline's output), the lightweight alternative to a
 * real Live2D model. Shares Live2DView's surface contract (speaking +
 * levelRef mouth drive, camera framing, onStatus) so AvatarView can swap the
 * two by manifest kind and every host â€” profile preview, overlay tile â€”
 * works unchanged.
 *
 * Liveliness model, ported from the pipeline's viewer:
 *  - Blink (261116): motion/organic.ts Blinker, a natural lid curve (fast
 *    close, short hold, slower open) every couple of seconds.
 *  - Mouth: two-state patch (open/closed) switched + vertically squashed by
 *    the same speaking/levelRef envelope Live2DView feeds ParamMouthOpenY;
 *    with no level feed a pseudo-envelope keeps it moving while speaking.
 *  - Head (261116): motion/organic.ts GazeDriver, the head part only (a rig
 *    has no separate irises, so her gaze shows through the head): a damped
 *    spring after each look, with its own slow sway, mapped onto a pixel
 *    translation of the 'head' group. The overlay's cursor feed, when fresh,
 *    is one of the things she looks at.
 *  - Hair physics: per-layer damped spring followers chasing the head target
 *    (rig.json `physics: {k, c}`) â€” hair lags, overshoots, and re-converges
 *    exactly at rest, the way Live2D physics chains behave. A plain `sway`
 *    fraction is available for layers that should track shallowly (body).
 */
import React, { useEffect, useRef } from 'react';
import type { AvatarCamera, AvatarRigLayer, AvatarRigSpec } from '@shared/ipc';
import { sei } from '../ipcClient';
import { Blinker, GazeDriver, type GazeInput } from '../motion/organic';

export interface RigViewProps {
  characterId: string;
  /** True while this character is audibly speaking (drives the mouth). */
  speaking?: boolean;
  /** Latest mouth level 0..1, mutated externally at ~25 Hz; read per frame. */
  levelRef?: React.MutableRefObject<number>;
  /** Same contract as Live2DView: zoom multiplies the contain fit, x/y pan
   * in view fractions. */
  camera?: AvatarCamera | null;
  className?: string;
  onStatus?: (status: 'loading' | 'ready' | 'error') => void;
  /** Frame cap (261104, SeiLink): absent = every animation frame, 0 = paused (no frames at all), N = at most N a second. */
  fps?: number;
}

/** A states patch reads "closed" below this openness; above it the open
 * image draws with a vertical squash for the intermediate frames. */
const PATCH_THRESHOLD = 0.35;

/* Mouth smoothing per frame (Live2DView's constants). */
const MOUTH_ATTACK = 0.5;
const MOUTH_RELEASE = 0.18;

const CURSOR_FRESH_MS = 2_000;
const CURSOR_GAIN_X = 0.75;
const CURSOR_GAIN_Y = 0.6;
/** The head carries about half of a look (GazeDriver head share); this restores the old full-deflection range. */
const HEAD_RANGE = 1.8;

/** Head translation per gaze unit, as fractions of the rig canvas (â‰ˆ the
 * viewer's 22 px / 12 px on a 2048 canvas at full deflection). */
const HEAD_GAIN_X = 0.02;
const HEAD_GAIN_Y = 0.011;
/** Breath bob amplitude (canvas-height fraction) and period. */
const BREATH_AMP = 0.0015;
const BREATH_PERIOD_MS = 1_600;

interface SpringAxis {
  p: number;
  v: number;
}

/** Damped spring step (semi-implicit Euler with exponential damping): the
 * layer chases `target`, overshoots by its k/c ratio, converges at rest. */
function stepSpring(s: SpringAxis, target: number, k: number, c: number, dt: number): void {
  s.v += (target - s.p) * k * dt;
  s.v *= Math.exp(-c * dt);
  s.p += s.v * dt;
}

interface LoadedLayer {
  spec: AvatarRigLayer;
  img?: ImageBitmap;
  states?: { open: ImageBitmap; closed: ImageBitmap };
}

export function RigView({
  characterId,
  speaking = false,
  levelRef,
  camera = null,
  className,
  onStatus,
  fps,
}: RigViewProps): React.ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const fpsRef = useRef(fps);
  fpsRef.current = fps;
  // Restarts a loop paused by fps 0.
  const resumeRef = useRef<(() => void) | null>(null);
  const speakingRef = useRef(speaking);
  speakingRef.current = speaking;
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  const cameraRef = useRef<AvatarCamera | null>(camera);
  cameraRef.current = camera;

  useEffect(() => {
    let cancelled = false;
    let raf = 0;
    let resizeObserver: ResizeObserver | null = null;
    let offCursor: (() => void) | undefined;
    const bitmaps: ImageBitmap[] = [];
    const host = hostRef.current;
    if (!host) return undefined;

    onStatusRef.current?.('loading');

    void (async () => {
      try {
        const [manifest, files] = await Promise.all([
          sei.avatarGet(characterId),
          sei.avatarModelFiles(characterId),
        ]);
        if (cancelled) return;
        if (!manifest || manifest.kind !== 'rig' || files.length === 0) {
          throw new Error('no rig avatar');
        }
        const byPath = new Map(files.map((f) => [f.path, f.bytes]));
        const entryBytes = byPath.get(manifest.entry);
        if (!entryBytes) throw new Error('rig entry missing');
        const spec = JSON.parse(new TextDecoder().decode(entryBytes)) as AvatarRigSpec;
        const entryDir = manifest.entry.includes('/')
          ? manifest.entry.slice(0, manifest.entry.lastIndexOf('/'))
          : '';
        const resolve = (ref: string): string => (entryDir ? `${entryDir}/${ref}` : ref);
        const bitmap = async (ref: string): Promise<ImageBitmap> => {
          const bytes = byPath.get(resolve(ref));
          if (!bytes) throw new Error(`rig image missing: ${ref}`);
          const bm = await createImageBitmap(new Blob([bytes as BlobPart]));
          bitmaps.push(bm);
          return bm;
        };
        const layers: LoadedLayer[] = await Promise.all(
          [...spec.layers]
            .sort((a, b) => a.z - b.z)
            .map(async (l) => {
              const out: LoadedLayer = { spec: l };
              if (l.src) out.img = await bitmap(l.src);
              if (l.states) {
                out.states = {
                  open: await bitmap(l.states.open),
                  closed: await bitmap(l.states.closed),
                };
              }
              return out;
            }),
        );
        if (cancelled) return;

        const [W, H] = spec.canvas;
        const canvas = document.createElement('canvas');
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.style.display = 'block';
        host.appendChild(canvas);
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('no 2d context');

        let viewW = Math.max(1, host.clientWidth);
        let viewH = Math.max(1, host.clientHeight);
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const fit = (): void => {
          viewW = Math.max(1, host.clientWidth);
          viewH = Math.max(1, host.clientHeight);
          canvas.width = Math.round(viewW * dpr);
          canvas.height = Math.round(viewH * dpr);
        };
        fit();
        resizeObserver = new ResizeObserver(fit);
        resizeObserver.observe(host);

        // â”€â”€ Gaze (261116) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        const cursor = { x: 0, y: 0, at: 0 };
        const cursorPt = { x: 0, y: 0 };
        const gazeIn: GazeInput = { cursor: null, engaged: false };
        const gazeDriver = new GazeDriver(performance.now());
        const blinker = new Blinker(performance.now());
        offCursor = sei.onAvatarOverlayCursor?.((pt) => {
          cursor.x = pt.x;
          cursor.y = pt.y;
          cursor.at = Date.now();
        });

        // â”€â”€ Per-frame state â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        let mouth = 0;
        let pseudoPhase = 0;
        let lastT = performance.now();
        const springs = new Map<string, { x: SpringAxis; y: SpringAxis }>();

        const drawPatch = (l: LoadedLayer, openness: number, dx: number, dy: number): void => {
          if (!l.spec.box || !l.states) return;
          const [x0, y0] = l.spec.box;
          if (openness < PATCH_THRESHOLD) {
            ctx.drawImage(l.states.closed, x0 + dx, y0 + dy);
          } else {
            const im = l.states.open;
            const squash = 0.55 + 0.45 * openness; // 55%..100% height
            const sy = im.height * (1 - squash) * 0.6; // top edge roughly pinned
            ctx.drawImage(im, x0 + dx, y0 + dy + sy, im.width, im.height * squash);
          }
        };

        let lastTick = 0;
        const frame = (t: number): void => {
          if (cancelled) return;
          const cap = fpsRef.current;
          if (cap === 0) {
            raf = 0;
            return;
          }
          raf = requestAnimationFrame(frame);
          if (cap !== undefined && cap > 0 && t - lastTick < 1000 / cap - 1) return;
          lastTick = t;
          const dt = Math.min((t - lastT) / 1000, 0.05);
          lastT = t;

          // Eye openness: 1 open, 0 shut, on the lid curve.
          const eye = 1 - blinker.lid(t);

          // Mouth envelope: level feed when present, pseudo-syllables when
          // speaking without one, easing shut otherwise.
          let target = 0;
          if (speakingRef.current) {
            const level = levelRef?.current ?? -1;
            if (level >= 0) target = Math.min(1, level);
            else {
              pseudoPhase += 0.35;
              target = 0.25 + 0.35 * Math.abs(Math.sin(pseudoPhase));
            }
          }
          mouth += (target - mouth) * (target > mouth ? MOUTH_ATTACK : MOUTH_RELEASE);

          // Gaze â†’ head pixel target (the head part of her look; y down).
          const cursorFresh = Date.now() - cursor.at < CURSOR_FRESH_MS;
          if (cursorFresh) {
            cursorPt.x = cursor.x * CURSOR_GAIN_X;
            cursorPt.y = -cursor.y * CURSOR_GAIN_Y;
          }
          gazeIn.cursor = cursorFresh ? cursorPt : null;
          gazeIn.engaged = speakingRef.current;
          const g = gazeDriver.update(t, gazeIn);
          const breath = Math.sin(t / BREATH_PERIOD_MS) * H * BREATH_AMP;
          const headDX = g.headX * HEAD_RANGE * W * HEAD_GAIN_X;
          const headDY = g.headY * HEAD_RANGE * H * HEAD_GAIN_Y + breath;

          // Contain fit + camera, then draw in rig coordinates.
          const cam = cameraRef.current;
          const s = Math.min(viewW / W, viewH / H) * (cam?.zoom ?? 1);
          const ox = (viewW - W * s) / 2 + (cam?.x ?? 0) * viewW;
          const oy = (viewH - H * s) / 2 + (cam?.y ?? 0) * viewH;
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * ox, dpr * oy);

          for (const l of layers) {
            const isHead = l.spec.group === 'head';
            const sway = l.spec.sway ?? 0;
            let dx = isHead ? headDX : headDX * sway;
            let dy = isHead ? headDY : headDY * sway + breath * 0.5;
            if (l.spec.physics) {
              const f =
                springs.get(l.spec.id) ??
                springs
                  .set(l.spec.id, { x: { p: 0, v: 0 }, y: { p: 0, v: 0 } })
                  .get(l.spec.id)!;
              stepSpring(f.x, dx, l.spec.physics.k, l.spec.physics.c, dt);
              stepSpring(f.y, dy, l.spec.physics.k, l.spec.physics.c, dt);
              dx = f.x.p;
              dy = f.y.p;
            }
            if (l.states) {
              drawPatch(l, /eye/i.test(l.spec.id) ? eye : mouth, dx, dy);
              continue;
            }
            if (l.img) ctx.drawImage(l.img, dx, dy);
          }
        };
        raf = requestAnimationFrame(frame);
        resumeRef.current = () => {
          if (!cancelled && raf === 0) raf = requestAnimationFrame(frame);
        };
        onStatusRef.current?.('ready');
      } catch (err) {
        if (!cancelled) {
          // eslint-disable-next-line no-console
          console.warn('[RigView] load failed', err);
          onStatusRef.current?.('error');
        }
      }
    })();

    return () => {
      cancelled = true;
      resumeRef.current = null;
      cancelAnimationFrame(raf);
      offCursor?.();
      resizeObserver?.disconnect();
      for (const bm of bitmaps) bm.close();
      host.replaceChildren();
    };
  }, [characterId, levelRef]);

  useEffect(() => {
    if (fps !== 0) resumeRef.current?.();
  }, [fps]);

  return <div ref={hostRef} className={className} />;
}




