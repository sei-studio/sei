/**
 * FacepackView (261028, desktop companion pilot) — renders a sei-facepack v1
 * pack: pre-baked full-canvas bases per expression and head pose, with eye
 * and mouth patches pasted at fixed boxes, plus overlays (blush, sweat...).
 *
 * Same surface contract as RigView / Live2DView (characterId, speaking,
 * levelRef, camera, className, onStatus), so a future 'facepack' avatar kind
 * can be selected by AvatarView without touching any host. The extra props
 * are the pack (source / packId), the expression to show, and dev hooks.
 *
 * Per frame:
 *  - compose: base, eyes (blink), mouth (viseme), overlays, through the pure
 *    `layersFor` (compose.ts) so the draw order and fallbacks are tested;
 *  - blink: BlinkScheduler, suppressed on blink:false expressions;
 *  - mouth: VisemeDriver over the companion's TTS clip samples
 *    (subscribeClipLevels: level + two bands), else `bandsRef`, else a
 *    level-gated pseudo cycle from `levelRef` / `speaking`;
 *  - expression: ExpressionTimeline (persist until the next cue, decay
 *    holds, 60 s idle -> neutral), with a 120 ms crossfade;
 *  - pose: an idle head turn every 4-10 s, one step at a time, biased toward
 *    the cursor when the overlay's cursor feed is fresh; 170 ms crossfade;
 *  - a 1-2 px idle bob in screen pixels.
 *
 * Rendering is cached: each base is pre-scaled once per view scale, and each
 * composite (base + patches + overlays) is cached per scale and state key, so
 * a steady frame is one drawImage and a dirty check skips frames with nothing
 * new. Offsets and the bob land on whole device pixels.
 * Crossfades are exact: the two cached composites are combined with
 * 'lighter' (A*(1-a) + B*a on premultiplied pixels), so a
 * transparent-background sprite never dims or ghosts midway.
 * A new expression or pose is shown only once all its files have decoded.
 */
import React, { useEffect, useRef } from 'react';
import type { AvatarCamera } from '@shared/ipc';
import type { FacepackManifest, FacepackViseme } from '@shared/facepack';
import { sei } from '../ipcClient';
import { subscribeClipLevels } from '../voice/avatarLevelTap';
import {
  BlinkScheduler,
  ExpressionTimeline,
  type LevelSample,
  VisemeDriver,
  nextPose,
  nextPoseDelay,
} from './animation';
import { cueExpression, expressionBlinks, filesFor, layersFor, posesOf, resolveExpressionName } from './compose';
import { FaceImageCache, type FacepackSource, ipcPackSource } from './facepackSource';

export interface FaceDebugState {
  expression: string;
  pose: string;
  eye: string;
  viseme: FacepackViseme;
  fading: boolean;
  speaking: boolean;
  level: number;
}

export interface FacepackViewProps {
  characterId: string;
  speaking?: boolean;
  levelRef?: React.MutableRefObject<number>;
  camera?: AvatarCamera | null;
  className?: string;
  style?: React.CSSProperties;
  onStatus?: (status: 'loading' | 'ready' | 'error') => void;
  /** Where the pack comes from; overrides `packId`. */
  source?: FacepackSource | null;
  /** A pack in the dev pack dir; default = the one matching the character. */
  packId?: string | null;
  /** Expression to show (unknown names fall back to the pack default). */
  expression?: string | null;
  /** Bump to re-apply the same expression (re-arms its decay). */
  expressionSeq?: number;
  /** Pin a head pose (dev); null/undefined = idle pose changes. */
  pose?: string | null;
  /** Explicit level + band feed (dev talk test); wins over the clip tap. */
  bandsRef?: React.MutableRefObject<LevelSample | null>;
  /** Viseme swaps for packs with weak patches (Lyra: ii -> ee). */
  visemeSubstitutions?: Partial<Record<FacepackViseme, FacepackViseme>>;
  /** Draw expression overlays (blush, sweat, ...). Default true. */
  overlays?: boolean;
  /** Turn decay off (dev picker holds what was picked). */
  decay?: boolean;
  /** Filled every frame for dev readouts. */
  debugRef?: React.MutableRefObject<FaceDebugState | null>;
}

const EXPRESSION_FADE_MS = 120;
const POSE_FADE_MS = 170;
/** Idle bob: CSS px amplitude and period. */
const BOB_PX = 1.5;
const BOB_PERIOD_MS = 3_400;
const CURSOR_FRESH_MS = 2_000;
/** A clip sample older than this is "no feed". */
const SAMPLE_FRESH_MS = 160;
/** Level-only feed: below this the mouth rests between syllables. */
const LEVEL_GATE = 0.06;

/** Per-pack viseme defaults from the bake reports (Lyra's ii/uu read weak). */
const PACK_VISEME_SUBS: Record<string, Partial<Record<FacepackViseme, FacepackViseme>>> = {
  lyra: { ii: 'ee' },
};

interface Shown {
  expression: string;
  pose: string;
}

export function FacepackView({
  characterId,
  speaking = false,
  levelRef,
  camera = null,
  className,
  style,
  onStatus,
  source = null,
  packId,
  expression = null,
  expressionSeq = 0,
  pose: pinnedPose = null,
  bandsRef,
  visemeSubstitutions,
  overlays = true,
  decay = true,
  debugRef,
}: FacepackViewProps): React.ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const live = useRef({ speaking, camera, expression, expressionSeq, pinnedPose, overlays, decay });
  live.current = { speaking, camera, expression, expressionSeq, pinnedPose, overlays, decay };
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;

  useEffect(() => {
    let cancelled = false;
    let raf = 0;
    let resizeObserver: ResizeObserver | null = null;
    let offCursor: (() => void) | undefined;
    let offLevels: (() => void) | undefined;
    let cache: FaceImageCache | null = null;
    const host = hostRef.current;
    if (!host) return undefined;
    onStatusRef.current?.('loading');

    void (async () => {
      try {
        let src = source;
        if (!src) {
          const id = packId ?? (await sei.facepackForCharacter?.(characterId)) ?? null;
          if (!id) throw new Error('no facepack for character');
          src = ipcPackSource(id);
        }
        const m: FacepackManifest | null = await src.manifest();
        if (cancelled) return;
        if (!m) throw new Error('facepack manifest unavailable');
        cache = new FaceImageCache(src);
        const c = cache;
        const [W, H] = m.canvas;
        const subs = visemeSubstitutions ?? PACK_VISEME_SUBS[m.character.toLowerCase()] ?? {};

        const startExpr = resolveExpressionName(m, live.current.expression ?? m.default_expression ?? 'neutral');
        const startPose = live.current.pinnedPose ?? m.default_pose ?? 'c';
        await c.load(filesFor(m, startExpr, startPose));
        if (cancelled) return;

        const canvas = document.createElement('canvas');
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.style.display = 'block';
        host.replaceChildren(canvas);
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('2d context unavailable');
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        let viewW = 1;
        let viewH = 1;
        let sized = 0;
        const fit = (): void => {
          viewW = Math.max(1, host.clientWidth);
          viewH = Math.max(1, host.clientHeight);
          canvas.width = Math.round(viewW * dpr);
          canvas.height = Math.round(viewH * dpr);
          sized++;
        };
        fit();
        resizeObserver = new ResizeObserver(fit);
        resizeObserver.observe(host);

        // ── Render caches ────────────────────────────────────────────────
        // Scaling a full-canvas base is the one expensive draw, so each base
        // is scaled ONCE per view scale into its own canvas, and a frame is
        // composed (base + patches) only when its eye / mouth / expression /
        // pose changes. A frame with nothing new draws nothing at all. The
        // patches are drawn with the same transform the base was scaled
        // with, so they land on the same device pixels.
        let scaleKey = '';
        let devScale = 1;
        const scaledBases = new Map<string, HTMLCanvasElement>();
        const MAX_SCALED_BASES = 10;
        const newCanvas = (): { cv: HTMLCanvasElement; g: CanvasRenderingContext2D } => {
          const cv = document.createElement('canvas');
          const g = cv.getContext('2d');
          if (!g) throw new Error('2d context unavailable');
          return { cv, g };
        };
        const scaledBase = (src: string): HTMLCanvasElement | null => {
          const hit = scaledBases.get(src);
          if (hit) {
            scaledBases.delete(src);
            scaledBases.set(src, hit);
            return hit;
          }
          const bmp = c.get(src);
          if (!bmp) return null;
          const { cv, g } = newCanvas();
          cv.width = Math.ceil(W * devScale);
          cv.height = Math.ceil(H * devScale);
          g.imageSmoothingEnabled = true;
          g.imageSmoothingQuality = 'high';
          g.setTransform(devScale, 0, 0, devScale, 0, 0);
          g.drawImage(bmp, 0, 0);
          scaledBases.set(src, cv);
          while (scaledBases.size > MAX_SCALED_BASES) {
            const oldest = scaledBases.keys().next().value as string;
            scaledBases.delete(oldest);
          }
          return cv;
        };
        interface Slot {
          key: string;
          cv: HTMLCanvasElement;
          g: CanvasRenderingContext2D;
        }
        const mkSlot = (): Slot => ({ key: '', ...newCanvas() });
        let cur = mkSlot();
        let old = mkSlot();
        const compose = (slot: Slot, st: Shown, eye: 'open' | 'half' | 'closed', viseme: FacepackViseme): void => {
          const ov = live.current.overlays;
          const key = `${scaleKey}|${st.expression}/${st.pose}/${eye}/${viseme}/${ov ? 1 : 0}`;
          if (slot.key === key) return;
          const layers = layersFor(m, { ...st, eye, viseme, overlays: ov });
          if (layers.length === 0) return;
          const base = scaledBase(layers[0].src);
          if (!base) return;
          const g = slot.g;
          if (slot.cv.width !== base.width || slot.cv.height !== base.height) {
            slot.cv.width = base.width;
            slot.cv.height = base.height;
          }
          g.setTransform(1, 0, 0, 1, 0, 0);
          g.clearRect(0, 0, slot.cv.width, slot.cv.height);
          g.drawImage(base, 0, 0);
          g.imageSmoothingEnabled = true;
          g.imageSmoothingQuality = 'high';
          g.setTransform(devScale, 0, 0, devScale, 0, 0);
          for (const l of layers.slice(1)) {
            const bmp = c.get(l.src);
            if (bmp) g.drawImage(bmp, l.x, l.y);
          }
          slot.key = key;
        };
        let lastDraw = '';

        // ── Feeds ────────────────────────────────────────────────────────
        const cursor = { x: 0, at: 0 };
        offCursor = sei.onAvatarOverlayCursor?.((pt) => {
          cursor.x = pt.x;
          cursor.at = Date.now();
        });
        const clip = { sample: null as LevelSample | null, at: 0 };
        offLevels = subscribeClipLevels((id, sample) => {
          if (id !== characterId) return;
          clip.sample = sample;
          clip.at = sample ? performance.now() : 0;
        });

        // ── State ────────────────────────────────────────────────────────
        const t0 = performance.now();
        const blink = new BlinkScheduler(t0);
        const visemes = new VisemeDriver(subs);
        const timeline = new ExpressionTimeline(t0);
        if (startExpr !== timeline.current) timeline.set(startExpr, t0);
        let seenExpr = live.current.expression;
        let seenSeq = live.current.expressionSeq;
        let shown: Shown = { expression: startExpr, pose: startPose };
        let prev: Shown | null = null;
        let fadeStart = 0;
        let fadeMs = EXPRESSION_FADE_MS;
        let idlePose = startPose;
        let poseAt = t0 + nextPoseDelay();
        let loading: string | null = null;
        const keep = new Set<string>();

        const want = (now: number): Shown => {
          const exprName = resolveExpressionName(m, timeline.current);
          const avail = posesOf(m, exprName);
          const pinned = live.current.pinnedPose;
          if (pinned) return { expression: exprName, pose: avail.includes(pinned) ? pinned : avail[0] };
          if (now >= poseAt) {
            const fresh = Date.now() - cursor.at < CURSOR_FRESH_MS;
            idlePose = nextPose(idlePose, avail, fresh ? cursor.x : null);
            poseAt = now + nextPoseDelay();
          }
          return { expression: exprName, pose: avail.includes(idlePose) ? idlePose : avail[0] };
        };

        const frame = (): void => {
          if (cancelled) return;
          raf = requestAnimationFrame(frame);
          const now = performance.now();
          const L = live.current;

          // Expression input -> timeline (+ decay).
          if (L.expression !== seenExpr || L.expressionSeq !== seenSeq) {
            seenExpr = L.expression;
            seenSeq = L.expressionSeq;
            // A word this pack cannot show keeps the current face (261028).
            const next = L.expression ? cueExpression(m, L.expression) : null;
            if (next) timeline.set(next, now);
          }
          // Speaking: the prop, or a fresh clip sample for this character.
          const clipFresh = clip.sample !== null && now - clip.at < SAMPLE_FRESH_MS;
          const explicit = bandsRef?.current ?? null;
          const isSpeaking = L.speaking || clipFresh || explicit !== null;
          timeline.setSpeaking(isSpeaking, now);
          if (L.decay) timeline.tick(now);

          // Target state; switch only once it has decoded.
          const target = want(now);
          const targetKey = `${target.expression}/${target.pose}`;
          if (targetKey !== `${shown.expression}/${shown.pose}`) {
            const files = filesFor(m, target.expression, target.pose);
            if (files.every((f) => c.has(f))) {
              prev = shown;
              shown = target;
              fadeStart = now;
              fadeMs = target.expression !== prev.expression ? EXPRESSION_FADE_MS : POSE_FADE_MS;
              loading = null;
              // The outgoing frame keeps its pixels in the other slot.
              const t = old;
              old = cur;
              cur = t;
            } else if (loading !== targetKey) {
              loading = targetKey;
              void c.load(files);
            }
          }

          // Eyes and mouth.
          const canBlink = expressionBlinks(m, shown.expression) && (!prev || expressionBlinks(m, prev.expression));
          const eye = blink.stateAt(now, canBlink);
          let sample: LevelSample | null = explicit ?? (clipFresh ? clip.sample : null);
          let mouthOn = isSpeaking;
          if (!sample && levelRef && L.speaking) {
            // Level-only feed: gate the pseudo cycle on loudness.
            mouthOn = levelRef.current > LEVEL_GATE;
            sample = null;
          }
          const viseme = visemes.update(now, mouthOn, sample);

          // Fit + camera, in whole device pixels so line art never resamples
          // between frames; the bob moves in whole device pixels too.
          const cam = L.camera;
          const s = Math.min(viewW / W, viewH / H) * (cam?.zoom ?? 1);
          const sk = `${s.toFixed(5)}@${dpr}#${sized}`;
          if (sk !== scaleKey) {
            scaleKey = sk;
            devScale = s * dpr;
            scaledBases.clear();
            cur.key = '';
            old.key = '';
          }
          const ox = (viewW - W * s) / 2 + (cam?.x ?? 0) * viewW;
          const oy = (viewH - H * s) / 2 + (cam?.y ?? 0) * viewH;
          const bob = Math.round(Math.sin(((now - t0) / BOB_PERIOD_MS) * Math.PI * 2) * BOB_PX * dpr);
          const dx = Math.round(ox * dpr);
          const dy = Math.round(oy * dpr) + bob;

          const a = prev ? Math.min(1, (now - fadeStart) / fadeMs) : 1;
          const fading = prev !== null && a < 1;
          if (!fading) prev = null;
          compose(cur, shown, eye, viseme);
          if (fading && prev) compose(old, prev, eye, viseme);
          const drawKey = `${cur.key}|${fading ? old.key : ''}|${fading ? a.toFixed(3) : ''}|${dx},${dy}|${canvas.width}x${canvas.height}`;
          if (drawKey !== lastDraw) {
            lastDraw = drawKey;
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            if (fading) {
              // A*(1-a) + B*a on premultiplied pixels: an exact crossfade.
              ctx.globalAlpha = 1 - a;
              ctx.drawImage(old.cv, dx, dy);
              ctx.globalCompositeOperation = 'lighter';
              ctx.globalAlpha = a;
              ctx.drawImage(cur.cv, dx, dy);
              ctx.globalCompositeOperation = 'source-over';
              ctx.globalAlpha = 1;
            } else {
              ctx.drawImage(cur.cv, dx, dy);
            }
          }

          // Keep what is on screen or about to be; trim the rest.
          keep.clear();
          for (const f of filesFor(m, shown.expression, shown.pose)) keep.add(f);
          if (prev) for (const f of filesFor(m, prev.expression, prev.pose)) keep.add(f);
          for (const f of filesFor(m, target.expression, target.pose)) keep.add(f);
          c.trim(keep);

          if (debugRef) {
            debugRef.current = {
              expression: shown.expression,
              pose: shown.pose,
              eye,
              viseme,
              fading,
              speaking: isSpeaking,
              level: sample?.level ?? levelRef?.current ?? 0,
            };
          }
        };
        raf = requestAnimationFrame(frame);
        onStatusRef.current?.('ready');

        // Warm the other poses of the starting expression in the background.
        void c.load(posesOf(m, startExpr).flatMap((p) => filesFor(m, startExpr, p)));
      } catch (err) {
        if (!cancelled) {
          // eslint-disable-next-line no-console
          console.warn('[FacepackView] load failed', err);
          onStatusRef.current?.('error');
        }
      }
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      offCursor?.();
      offLevels?.();
      resizeObserver?.disconnect();
      cache?.dispose();
      host.replaceChildren();
    };
    // Pack identity changes rebuild everything; the rest is read live.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [characterId, source, packId, levelRef, bandsRef]);

  return <div ref={hostRef} className={className} style={style} />;
}
