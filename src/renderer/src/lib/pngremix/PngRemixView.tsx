/**
 * PngRemixView (261122 spike) — renders a 'pngremix'-kind avatar: a
 * PNGTuber Remix model the user imported, stored as Sei's own spec
 * (pngremix.json + img/N.png, written by main's avatar store from the
 * `.pngRemix` file) and played by pngRemixRig.ts. Same surface contract as
 * RigView and Live2DView (speaking + levelRef mouth, camera, fps cap,
 * onStatus), so AvatarView can swap it in by manifest kind.
 *
 *  - Mouth: the speech level (or a pseudo-level while speaking with no
 *    level) opens the model's mouth layers past a small threshold and closes
 *    them in the gaps, which is how Remix itself switches on microphone volume.
 *  - Blink: motion/organic.ts Blinker (Sei's natural cadence) drives the
 *    model's blink layers.
 *  - Emotion: the line's emotion picks a model state through the manifest's
 *    emotion table (state names), held for the line and half its length
 *    again, then back to the first state (Live2DView's expression timing).
 */
import React, { useEffect, useRef } from 'react';
import type { AvatarCamera, AvatarEmotion } from '@shared/ipc';
import { validatePngRemixSpec } from '@shared/pngremix/pngRemix';
import { sei } from '../ipcClient';
import { Blinker } from '../motion/organic';
import { resolveEmotionExpression } from '../avatar/emotion';
import { PngRemixRig, type Bounds, type Drawable } from './pngRemixRig';

export interface PngRemixViewProps {
  characterId: string;
  speaking?: boolean;
  levelRef?: React.MutableRefObject<number>;
  emotion?: AvatarEmotion | null;
  camera?: AvatarCamera | null;
  /** Where the model sits in its box: centred (default) or standing on the bottom edge. */
  anchor?: 'center' | 'bottom';
  className?: string;
  onStatus?: (status: 'loading' | 'ready' | 'error') => void;
  /** Frame cap: absent = every animation frame, 0 = paused, N = at most N a second. */
  fps?: number;
}

/**
 * Mouth layers switch open above this level and closed again once it has
 * stayed below the lower one for MOUTH_HOLD_MS. The raw level is used, not a
 * smoothed envelope: Remix flips on the microphone volume, and a slow release
 * kept the mouth open through the short gaps between syllables.
 */
const MOUTH_OPEN_AT = 0.16;
const MOUTH_CLOSE_AT = 0.08;
const MOUTH_HOLD_MS = 60;
/** Eyes read shut while the lid is past this. */
const LID_SHUT = 0.45;
const EXPRESSION_LINGER_FRACTION = 0.5;
/** Contain fit leaves this much room around the model. */
const FIT_PAD = 0.96;
/** Most of a bounce the bottom-anchored model absorbs by sitting lower (fraction of its height). */
const MAX_SINK = 0.25;

export function PngRemixView({
  characterId,
  speaking = false,
  levelRef,
  emotion = null,
  camera = null,
  anchor = 'center',
  className,
  onStatus,
  fps,
}: PngRemixViewProps): React.ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const fpsRef = useRef(fps);
  fpsRef.current = fps;
  const resumeRef = useRef<(() => void) | null>(null);
  const speakingRef = useRef(speaking);
  speakingRef.current = speaking;
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  const cameraRef = useRef<AvatarCamera | null>(camera);
  cameraRef.current = camera;
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;
  const rigRef = useRef<PngRemixRig | null>(null);
  const emotionsRef = useRef<Partial<Record<AvatarEmotion, string>> | undefined>(undefined);
  const emotionRef = useRef(emotion);
  emotionRef.current = emotion;
  const appliedRef = useRef<AvatarEmotion | null>(null);

  useEffect(() => {
    let cancelled = false;
    let raf = 0;
    let resizeObserver: ResizeObserver | null = null;
    const bitmaps: ImageBitmap[] = [];
    const host = hostRef.current;
    if (!host) return undefined;
    onStatusRef.current?.('loading');

    void (async () => {
      try {
        const [manifest, files] = await Promise.all([sei.avatarGet(characterId), sei.avatarModelFiles(characterId)]);
        if (cancelled) return;
        if (!manifest || manifest.kind !== 'pngremix' || files.length === 0) throw new Error('no pngremix avatar');
        emotionsRef.current = manifest.emotions;
        const byPath = new Map(files.map((f) => [f.path, f.bytes]));
        const entry = byPath.get(manifest.entry);
        if (!entry) throw new Error('pngremix entry missing');
        const spec = validatePngRemixSpec(JSON.parse(new TextDecoder().decode(entry)));
        const images: Array<Drawable | null> = await Promise.all(
          spec.images.map(async (im) => {
            const bytes = byPath.get(im.path);
            if (!bytes) return null;
            try {
              const bm = await createImageBitmap(new Blob([bytes as BlobPart], { type: 'image/png' }));
              bitmaps.push(bm);
              return bm;
            } catch {
              return null;
            }
          }),
        );
        if (cancelled) return;
        const rig = new PngRemixRig(spec, images);
        rigRef.current = rig;
        // An emotion that arrived while the model loaded applies now.
        const early = emotionRef.current;
        const earlyName = early ? resolveEmotionExpression(manifest.emotions, early) : null;
        const earlyIdx = earlyName ? spec.states.findIndex((st) => st.name === earlyName) : -1;
        if (early && earlyIdx >= 0) {
          appliedRef.current = early;
          rig.setState(earlyIdx);
        }
        const bounds: Bounds = rig.restBounds(0) ?? {
          x: -256,
          y: -256,
          w: 512,
          h: 512,
        };

        const headroom = rig.motionHeadroom();

        const canvas = document.createElement('canvas');
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.style.display = 'block';
        host.appendChild(canvas);
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('no 2d context');
        ctx.imageSmoothingQuality = 'high';

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

        const blinker = new Blinker(performance.now());
        let mouthOpen = false;
        let loudAt = 0;
        let pseudoPhase = 0;
        let lastT = performance.now();
        let lastTick = 0;
        let shownMouth: boolean | null = null;
        let shownEyes: boolean | null = null;

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
          const dt = Math.min((t - lastT) / 1000, 0.1);
          lastT = t;

          let target = 0;
          if (speakingRef.current) {
            const level = levelRef?.current ?? -1;
            if (level >= 0) target = Math.min(1, level);
            else {
              // About 3.5 syllables a second, with real gaps between them.
              pseudoPhase += dt * Math.PI * 2 * 3.5;
              target = Math.max(0, Math.sin(pseudoPhase)) * 0.6;
            }
          }
          if (target > MOUTH_CLOSE_AT) loudAt = t;
          if (!mouthOpen && target > MOUTH_OPEN_AT) mouthOpen = true;
          else if (mouthOpen && target < MOUTH_CLOSE_AT && t - loudAt > MOUTH_HOLD_MS) mouthOpen = false;
          const eyesClosed = blinker.lid(t) > LID_SHUT;

          rig.step({ dt, mouthOpen, eyesClosed });
          // Read by shot scripts and tests; written only on a change.
          if (mouthOpen !== shownMouth) host.dataset.mouth = (shownMouth = mouthOpen) ? 'open' : 'closed';
          if (eyesClosed !== shownEyes) host.dataset.eyes = (shownEyes = eyesClosed) ? 'closed' : 'open';

          const cam = cameraRef.current;
          // Bottom anchor: the rest pose sits `sink` lower than a plain fit,
          // so at the top of a bounce it is where the fit put it and the bust's
          // bottom edge stays below the box. Rise past a quarter of the height
          // is made room for by fitting smaller instead.
          const bottom = anchorRef.current === 'bottom';
          const sink = bottom ? Math.min(headroom, bounds.h * MAX_SINK) : 0;
          const room = headroom - sink;
          const s = Math.min(viewW / bounds.w, viewH / (bounds.h + room)) * FIT_PAD * (cam?.zoom ?? 1);
          const ox = (viewW - bounds.w * s) / 2 - bounds.x * s + (cam?.x ?? 0) * viewW;
          const top = bottom ? viewH - (bounds.h - sink) * s : (viewH - (bounds.h + room) * s) / 2 + room * s;
          const oy = top - bounds.y * s + (cam?.y ?? 0) * viewH;
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          rig.draw(ctx, [dpr * s, 0, 0, dpr * s, dpr * ox, dpr * oy]);
        };
        raf = requestAnimationFrame(frame);
        resumeRef.current = () => {
          if (!cancelled && raf === 0) raf = requestAnimationFrame(frame);
        };
        onStatusRef.current?.('ready');
      } catch (err) {
        if (!cancelled) {
          // eslint-disable-next-line no-console
          console.warn('[PngRemixView] load failed', err);
          onStatusRef.current?.('error');
        }
      }
    })();

    return () => {
      cancelled = true;
      resumeRef.current = null;
      cancelAnimationFrame(raf);
      resizeObserver?.disconnect();
      rigRef.current?.dispose();
      rigRef.current = null;
      for (const bm of bitmaps) bm.close();
      host.replaceChildren();
      delete host.dataset.mouth;
      delete host.dataset.eyes;
    };
  }, [characterId, levelRef]);

  useEffect(() => {
    if (fps !== 0) resumeRef.current?.();
  }, [fps]);

  // ── Emotion -> model state, held for the line and half again ──────────────
  const lineStartRef = useRef(0);
  const prevSpeakingRef = useRef(false);
  const decayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const wasSpeaking = prevSpeakingRef.current;
    prevSpeakingRef.current = speaking;
    const stateFor = (e: AvatarEmotion | null): number => {
      const rig = rigRef.current;
      const name = resolveEmotionExpression(emotionsRef.current, e);
      if (!rig || !name) return -1;
      return rig.spec.states.findIndex((s) => s.name === name);
    };
    if (speaking && !wasSpeaking) lineStartRef.current = Date.now();
    if (emotion && emotion !== appliedRef.current) {
      if (decayTimerRef.current) clearTimeout(decayTimerRef.current);
      decayTimerRef.current = null;
      lineStartRef.current = Date.now();
      const idx = stateFor(emotion);
      if (idx >= 0) {
        appliedRef.current = emotion;
        rigRef.current?.setState(idx);
      }
    }
    if (!speaking && wasSpeaking && appliedRef.current) {
      const lineMs = Math.max(0, Date.now() - lineStartRef.current);
      if (decayTimerRef.current) clearTimeout(decayTimerRef.current);
      decayTimerRef.current = setTimeout(
        () => {
          decayTimerRef.current = null;
          appliedRef.current = null;
          rigRef.current?.setState(0);
        },
        Math.round(lineMs * EXPRESSION_LINGER_FRACTION),
      );
    }
  }, [emotion, speaking]);
  useEffect(
    () => () => {
      if (decayTimerRef.current) clearTimeout(decayTimerRef.current);
    },
    [],
  );

  return <div ref={hostRef} className={className} />;
}
