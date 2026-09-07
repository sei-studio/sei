/**
 * RigView (260817) — renders a 'rig'-kind avatar: a rig.json + aligned PNG
 * layers (the chibi-rig pipeline's output), the lightweight alternative to a
 * real Live2D model. Shares Live2DView's surface contract (speaking +
 * levelRef mouth drive, camera framing, onStatus) so AvatarView can swap the
 * two by manifest kind and every host — profile preview, overlay tile —
 * works unchanged.
 *
 * Liveliness model, ported from the pipeline's viewer:
 *  - Blink: a 160 ms triangle every 2.5-6 s.
 *  - Mouth: two-state patch (open/closed) switched + vertically squashed by
 *    the same speaking/levelRef envelope Live2DView feeds ParamMouthOpenY;
 *    with no level feed a pseudo-envelope keeps it moving while speaking.
 *  - Head sway: the gaze system from Live2DView (wander goals on a saccade
 *    cadence, alternating with cursor-follow when the overlay's cursor feed
 *    is fresh, constant-speed glide) mapped onto a pixel translation of the
 *    'head' group.
 *  - Hair physics: per-layer damped spring followers chasing the head target
 *    (rig.json `physics: {k, c}`) — hair lags, overshoots, and re-converges
 *    exactly at rest, the way Live2D physics chains behave. A plain `sway`
 *    fraction is available for layers that should track shallowly (body).
 */
import React, { useEffect, useRef } from 'react';
import type { AvatarCamera, AvatarRigLayer, AvatarRigSpec } from '@shared/ipc';
import { sei } from '../ipcClient';

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
}

/* Blink (viewer.html): quick close-open triangle on a randomized timer. */
const BLINK_MS = 160;
const BLINK_GAP_MIN_MS = 2_500;
const BLINK_GAP_RAND_MS = 3_500;
/** A states patch reads "closed" below this openness; above it the open
 * image draws with a vertical squash for the intermediate frames. */
const PATCH_THRESHOLD = 0.35;

/* Mouth smoothing per frame (Live2DView's constants). */
const MOUTH_ATTACK = 0.5;
const MOUTH_RELEASE = 0.18;

/* Gaze constants, mirrored from Live2DView (same reasoning, same feel). */
const SACCADE_MIN_MS = 2_600;
const SACCADE_MAX_MS = 7_500;
const GAZE_KEEP = 0.35;
const GAZE_STEP_X = 0.2;
const GAZE_STEP_Y = 0.14;
const GLANCE_CHANCE = 0.15;
const GLANCE_STEP_X = 0.45;
const GLANCE_STEP_Y = 0.28;
const MODE_MIN_MS = 6_000;
const MODE_MAX_MS = 14_000;
const CURSOR_CHANCE = 0.45;
const CURSOR_FRESH_MS = 2_000;
const CURSOR_GAIN_X = 0.75;
const CURSOR_GAIN_Y = 0.6;
const GAZE_SPEED = 0.9;
const GAZE_ARRIVE_DIST = 0.06;

/** Head translation per gaze unit, as fractions of the rig canvas (≈ the
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
}: RigViewProps): React.ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
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
    let saccadeTimer: ReturnType<typeof setTimeout> | null = null;
    let gazeModeTimer: ReturnType<typeof setTimeout> | null = null;
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

        // ── Gaze: wander goals + cursor alternation + constant-speed glide ─
        const wanderGoal = { x: 0, y: 0 };
        const cursor = { x: 0, y: 0, at: 0 };
        let gazeMode: 'wander' | 'cursor' = 'wander';
        const gaze = { x: 0, y: 0 };
        const saccade = (): void => {
          if (cancelled) return;
          const glance = Math.random() < GLANCE_CHANCE;
          const ax = glance ? GLANCE_STEP_X : GAZE_STEP_X;
          const ay = glance ? GLANCE_STEP_Y : GAZE_STEP_Y;
          wanderGoal.x = Math.max(
            -0.55,
            Math.min(0.55, wanderGoal.x * GAZE_KEEP + (Math.random() * 2 - 1) * ax),
          );
          wanderGoal.y = Math.max(
            -0.4,
            Math.min(0.3, wanderGoal.y * GAZE_KEEP + (Math.random() * 1.7 - 1) * ay),
          );
          saccadeTimer = setTimeout(
            saccade,
            SACCADE_MIN_MS + Math.random() * (SACCADE_MAX_MS - SACCADE_MIN_MS),
          );
        };
        saccade();
        offCursor = sei.onAvatarOverlayCursor?.((pt) => {
          cursor.x = pt.x;
          cursor.y = pt.y;
          cursor.at = Date.now();
        });
        const pickGazeMode = (): void => {
          if (cancelled) return;
          const fresh = Date.now() - cursor.at < CURSOR_FRESH_MS;
          gazeMode = fresh && Math.random() < CURSOR_CHANCE ? 'cursor' : 'wander';
          gazeModeTimer = setTimeout(
            pickGazeMode,
            MODE_MIN_MS + Math.random() * (MODE_MAX_MS - MODE_MIN_MS),
          );
        };
        pickGazeMode();

        // ── Per-frame state ────────────────────────────────────────────────
        let nextBlink = performance.now() + 1_500 + Math.random() * BLINK_GAP_RAND_MS;
        let blinkAt = -1;
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

        const frame = (t: number): void => {
          if (cancelled) return;
          raf = requestAnimationFrame(frame);
          const dt = Math.min((t - lastT) / 1000, 0.05);
          lastT = t;

          // Blink value: 1 open, triangle dip to 0 and back over BLINK_MS.
          if (t > nextBlink) {
            blinkAt = t;
            nextBlink = t + BLINK_GAP_MIN_MS + Math.random() * BLINK_GAP_RAND_MS;
          }
          let eye = 1;
          if (blinkAt > 0) {
            const ph = (t - blinkAt) / BLINK_MS;
            if (ph >= 1) blinkAt = -1;
            else eye = Math.abs(ph * 2 - 1);
          }

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

          // Gaze glide → head pixel target.
          const cursorFresh = Date.now() - cursor.at < CURSOR_FRESH_MS;
          const goalX =
            gazeMode === 'cursor' && cursorFresh
              ? Math.max(-0.7, Math.min(0.7, cursor.x * CURSOR_GAIN_X))
              : wanderGoal.x;
          const goalY =
            gazeMode === 'cursor' && cursorFresh
              ? Math.max(-0.45, Math.min(0.35, cursor.y * CURSOR_GAIN_Y))
              : wanderGoal.y;
          const gdx = goalX - gaze.x;
          const gdy = goalY - gaze.y;
          const dist = Math.hypot(gdx, gdy);
          if (dist > 0.001 && dt > 0) {
            const speed = GAZE_SPEED * Math.min(1, dist / GAZE_ARRIVE_DIST);
            const step = Math.min(dist, speed * dt);
            gaze.x += (gdx / dist) * step;
            gaze.y += (gdy / dist) * step;
          }
          const breath = Math.sin(t / BREATH_PERIOD_MS) * H * BREATH_AMP;
          const headDX = gaze.x * W * HEAD_GAIN_X;
          const headDY = gaze.y * H * HEAD_GAIN_Y + breath;

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
      cancelAnimationFrame(raf);
      if (saccadeTimer) clearTimeout(saccadeTimer);
      if (gazeModeTimer) clearTimeout(gazeModeTimer);
      offCursor?.();
      resizeObserver?.disconnect();
      for (const bm of bitmaps) bm.close();
      host.replaceChildren();
    };
  }, [characterId, levelRef]);

  return <div ref={hostRef} className={className} />;
}
