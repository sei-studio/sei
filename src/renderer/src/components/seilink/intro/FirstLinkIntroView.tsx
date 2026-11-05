/**
 * The first-link intro's picture (261105, T337; 261106 soft light styles):
 * data in props, no IPC, so the app (FirstLinkIntro) and the dev harness
 * (DevIntroPreview) render the same thing.
 *
 * Every frame comes from computeFrame(style, timeline, t): a rAF loop writes
 * it to the DOM through refs (no React render per frame) and draws the two
 * light canvases (introFx.ts). With `manual`, there is no loop: the harness
 * calls `window.__firstLinkSeek(ms)` and gets exactly that frame, which is
 * how the review videos are rendered without dropped frames.
 *
 * Ends (onFinish once):
 *  - completed: the timeline reached its end. The end card ("Linked.") waits
 *    for the host's answer (`answer`), up to HOLD_MAX_MS. With `holdEnd`
 *    (the first link, played on the desktop stage) only the captions fade:
 *    the last frame is her room full screen, the same picture the wallpaper
 *    draws, so the window can step aside without a visible cut.
 *  - skipped: the Skip button or Esc, at any time. Fades out fast; with
 *    `holdEnd` it rushes to that last frame instead (SKIP_RUSH times the
 *    speed, a cut under reduced motion) while the captions fade, so a skip
 *    also ends on her room.
 *  - aborted: the host start failed (`answer === false`). "Link interrupted."
 *    shows for a moment, then the overlay fades and the app's own error state
 *    (the move-in sheet's retry) is what the player sees.
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { IntroBeat, IntroStyle } from '@shared/seilinkIntroTelemetry';
import type { RoomPresetManifest, RoomState } from '@shared/seilinkRoom';
import type { RoomUrlResolver } from '@shared/seilinkPack';
import { RoomCanvas, type RoomAvatarSlot } from '../RoomCanvas';
import { RoomAvatar, type RoomAvatarUse } from '../RoomAvatar';
import type { FacepackSource } from '../../../lib/facepack/facepackSource';
import { useT } from '../../../lib/i18n';
import {
  ABORT_MS,
  CALM_TIMELINE,
  beatAt,
  FULL_TIMELINE,
  SKIP_FADE_MS,
  ease,
  span,
  timelineTime,
  type IntroTimeline,
} from '../../../lib/seilink/introTimeline';
import { computeFrame, revealMask, type Box, type IntroFrame } from './introFrame';
import { FIELD_SCALE, drawBack, drawFront, herCentre, voidGradient } from './introFx';
import styles from './FirstLinkIntro.module.css';

export type IntroEnd = 'completed' | 'skipped' | 'aborted';

export interface IntroFinish {
  action: IntroEnd;
  /** The beat on screen when it ended. */
  beat: IntroBeat;
  /** Real ms from the start to the end. */
  elapsedMs: number;
}

export interface IntroRoom {
  manifest: RoomPresetManifest;
  state: RoomState;
  resolve: RoomUrlResolver;
}

export interface FirstLinkIntroViewProps {
  style: IntroStyle;
  reduced: boolean;
  characterId: string;
  name: string;
  /** Her room; null shows a plain backdrop (the pack is not installed yet). */
  room: IntroRoom | null;
  portrait?: string | null;
  /** The harness passes a face set; the app lets RoomAvatar find hers. */
  facepack?: FacepackSource | null;
  use?: RoomAvatarUse;
  /** The host start's answer: null while it is starting. */
  answer: boolean | null;
  /** Harness: no clock, frames come from window.__firstLinkSeek(ms). */
  manual?: boolean;
  onFinish?(end: IntroFinish): void;
  /** The room has drawn (or there is none). */
  onReady?(): void;
  /** End on her room (captions fade, the picture stays) instead of fading the whole overlay out. */
  holdEnd?: boolean;
}

declare global {
  interface Window {
    __firstLinkSeek?: (ms: number) => Promise<void>;
  }
}

/** A skip with holdEnd plays the rest this many times faster. */
const SKIP_RUSH = 8;

type Mode = { kind: 'play' } | { kind: 'skip'; at: number; t: number } | { kind: 'abort'; at: number; t: number };

export function FirstLinkIntroView(props: FirstLinkIntroViewProps): React.ReactElement {
  const { style, reduced, characterId, name, room, portrait = null, facepack, use = 'auto', answer, manual = false, holdEnd = false } = props;
  const t = useT();
  const tl: IntroTimeline = reduced ? CALM_TIMELINE : FULL_TIMELINE;

  const lines = useMemo(
    () => ({
      tunnel: t('Opening a tunnel to the digital world…'),
      link: t('Linking {name}…', { name }),
      port: t('Porting the link to your desktop…'),
      linked: t('Linked.'),
      linkedSub: t('{name} lives on your desktop now.', { name }),
      aborted: t('Link interrupted.'),
    }),
    [t, name],
  );

  const rootRef = useRef<HTMLDivElement>(null);
  const backRef = useRef<HTMLCanvasElement>(null);
  const frontRef = useRef<HTMLCanvasElement>(null);
  const roomRef = useRef<HTMLDivElement>(null);
  const avatarRef = useRef<HTMLDivElement>(null);
  const hudRef = useRef<HTMLDivElement>(null);
  const brandRef = useRef<HTMLDivElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const lineRef = useRef<HTMLParagraphElement>(null);
  const subRef = useRef<HTMLParagraphElement>(null);
  const dotRefs = useRef<Array<HTMLDivElement | null>>([]);

  const modeRef = useRef<Mode>({ kind: 'play' });
  const startRef = useRef<number>(0);
  const answeredAtRef = useRef<number | null>(null);
  const finishedRef = useRef(false);
  const lastTextRef = useRef({ line: '', sub: '' });
  const cb = useRef(props);
  cb.current = props;
  // A ref: the stage answers after the clock started, and the clock must not restart for it.
  const holdRef = useRef(holdEnd);
  holdRef.current = holdEnd;

  const finish = useCallback((action: IntroEnd, beat: IntroBeat) => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    cb.current.onFinish?.({ action, beat, elapsedMs: Math.max(0, performance.now() - startRef.current) });
  }, []);

  /** Write one frame to the DOM and canvases. `rootOpacity` fades everything, `hudOpacity` only the captions. */
  const apply = useCallback(
    (f: IntroFrame, rootOpacity: number, hudOpacity: number, aborted: boolean) => {
      const set = (el: HTMLElement | null, k: string, v: string): void => {
        if (el && el.style.getPropertyValue(k) !== v) el.style.setProperty(k, v);
      };
      const root = rootRef.current;
      set(root, 'opacity', rootOpacity.toFixed(3));
      set(hudRef.current, 'opacity', hudOpacity.toFixed(3));

      const her = herBox(avatarRef.current, root);
      const centre = herCentre(f, her);
      // Her room: its own canvases (not her) fade and open in a soft circle around her.
      const roomEl = roomRef.current;
      set(roomEl, '--fl-room', f.room.opacity.toFixed(3));
      let mask = 'none';
      const layer = roomEl?.querySelector('canvas');
      if (layer && root && f.room.reveal < 1) {
        const lr = layer.getBoundingClientRect();
        const o = root.getBoundingClientRect();
        mask = revealMask(f, { x: centre.x - (lr.left - o.left), y: centre.y - (lr.top - o.top) });
      }
      set(roomEl, '--fl-mask', mask);
      set(avatarRef.current, 'opacity', f.avatar.opacity.toFixed(3));
      set(avatarRef.current, 'filter', f.avatar.filter);

      set(brandRef.current, 'opacity', f.brand.toFixed(3));
      set(scrimRef.current, 'opacity', f.scrim.toFixed(3));
      f.dots.forEach((d, i) => {
        const el = dotRefs.current[i];
        set(el, 'opacity', (0.28 + 0.72 * d).toFixed(3));
        set(el, 'transform', `scale(${(0.7 + 0.3 * d).toFixed(3)})`);
      });

      // Captions: each beat's line fades up (no typing caret: soft light, not a terminal).
      let line: string;
      let lineOpacity: number;
      let subOpacity = 0;
      if (aborted) {
        line = lines.aborted;
        lineOpacity = 1;
      } else {
        line = lines[f.beat];
        const at = tl.beats[f.beat] + tl.lineDelay;
        lineOpacity = ease.out(span(f.t, at, at + 520));
        if (f.beat === 'linked') subOpacity = ease.out(span(f.t, tl.beats.linked + 450, tl.beats.linked + 1000));
      }
      const sub = aborted ? '' : lines.linkedSub;
      const last = lastTextRef.current;
      if (lineRef.current && last.line !== line) {
        lineRef.current.textContent = line;
        last.line = line;
      }
      if (subRef.current && last.sub !== sub) {
        subRef.current.textContent = sub;
        last.sub = sub;
      }
      set(lineRef.current, 'opacity', lineOpacity.toFixed(3));
      set(lineRef.current, 'transform', `translateY(${((1 - lineOpacity) * 8).toFixed(2)}px)`);
      set(subRef.current, 'opacity', subOpacity.toFixed(3));

      // The light: small canvases, stretched (the upscale is the softness).
      for (const c of [backRef.current, frontRef.current]) {
        if (!c) continue;
        const w = Math.max(16, Math.round(f.W / FIELD_SCALE));
        const h = Math.max(16, Math.round(f.H / FIELD_SCALE));
        if (c.width !== w || c.height !== h) {
          c.width = w;
          c.height = h;
        }
      }
      const bctx = backRef.current?.getContext('2d');
      if (bctx) drawBack(bctx, f, her);
      const fctx = frontRef.current?.getContext('2d');
      if (fctx) drawFront(fctx, f, her);
    },
    [lines, tl],
  );

  const frameAt = useCallback(
    (tt: number): IntroFrame => {
      const W = rootRef.current?.clientWidth || window.innerWidth;
      const H = rootRef.current?.clientHeight || window.innerHeight;
      return computeFrame(style, tl, tt, W, H, reduced);
    },
    [style, tl, reduced],
  );

  /** The end's fade at timeline time `tt`: [whole overlay, captions]. With holdEnd only the captions go. */
  const endFade = useCallback(
    (tt: number): [number, number] => {
      const out = 1 - span(tt, tl.fadeAt, tl.end);
      return holdRef.current ? [1, out] : [out, 1];
    },
    [tl],
  );

  // The host's answer.
  useEffect(() => {
    if (answer === null || answeredAtRef.current !== null) return;
    const now = performance.now();
    answeredAtRef.current = now - startRef.current;
    if (answer === false && modeRef.current.kind === 'play' && !manual) {
      const elapsed = now - startRef.current;
      modeRef.current = { kind: 'abort', at: now, t: timelineTime(tl, elapsed, answeredAtRef.current) };
    }
  }, [answer, manual, tl]);

  // The clock (or the harness seek).
  useLayoutEffect(() => {
    startRef.current = performance.now();
    if (manual) {
      window.__firstLinkSeek = async (ms: number) => {
        apply(frameAt(ms), ...endFade(ms), false);
        await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      };
      apply(frameAt(0), 1, 1, false);
      return () => {
        delete window.__firstLinkSeek;
      };
    }
    let raf = 0;
    const tick = (): void => {
      const now = performance.now();
      const elapsed = now - startRef.current;
      const mode = modeRef.current;
      if (mode.kind === 'play') {
        const tt = timelineTime(tl, elapsed, answeredAtRef.current);
        const f = frameAt(tt);
        apply(f, ...endFade(tt), false);
        if (tt >= tl.end) return finish('completed', 'linked');
      } else if (mode.kind === 'skip' && holdRef.current) {
        // Rush to her room (the wallpaper's picture), captions fading; the end is that frame, held.
        const since = now - mode.at;
        const tt = reduced ? tl.fadeAt : Math.min(tl.fadeAt, mode.t + since * SKIP_RUSH);
        const hud = 1 - span(since, 0, SKIP_FADE_MS);
        apply(frameAt(tt), 1, hud, false);
        if (tt >= tl.fadeAt && hud <= 0) return finish('skipped', beatAt(tl, mode.t));
      } else {
        const since = now - mode.at;
        const f = frameAt(mode.t);
        const fadeFrom = mode.kind === 'abort' ? ABORT_MS : 0;
        const op = 1 - span(since, fadeFrom, fadeFrom + SKIP_FADE_MS);
        apply(f, op, 1, mode.kind === 'abort');
        if (op <= 0) return finish(mode.kind === 'abort' ? 'aborted' : 'skipped', f.beat);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [manual, apply, frameAt, finish, tl, endFade, reduced]);

  const skip = useCallback(() => {
    if (manual || modeRef.current.kind !== 'play') return;
    const now = performance.now();
    modeRef.current = { kind: 'skip', at: now, t: timelineTime(tl, now - startRef.current, answeredAtRef.current) };
  }, [manual, tl]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        skip();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [skip]);

  useEffect(() => {
    rootRef.current?.focus();
    if (!room) cb.current.onReady?.();
  }, [room]);

  const renderHer = useCallback(
    (slot: RoomAvatarSlot) => (
      <div ref={avatarRef} className={styles.avatarWrap}>
        <RoomAvatar slot={slot} characterId={characterId} name={name} use={use} portrait={portrait} facepack={facepack} motion={manual ? false : undefined} />
      </div>
    ),
    [characterId, name, use, portrait, facepack, manual],
  );

  return (
    <div
      ref={rootRef}
      className={styles.root}
      data-style={style}
      data-reduced={reduced ? '1' : undefined}
      role="dialog"
      aria-modal="true"
      aria-label="SeiLink"
      tabIndex={-1}
    >
      <div className={styles.void} style={{ background: voidGradient(style) }} />
      <canvas ref={backRef} className={styles.fx} aria-hidden="true" />
      <div ref={roomRef} className={styles.room} aria-hidden="true">
        {room ? (
          <RoomCanvas
            manifest={room.manifest}
            state={room.state}
            resolveUrl={room.resolve}
            fit="cover"
            // 30 in the harness too: a face set draws nothing at 0 (a still).
            fps={30}
            fadeMs={0}
            avatar={renderHer}
            style={{ position: 'absolute', inset: 0 }}
            onReady={() => cb.current.onReady?.()}
            onError={() => cb.current.onReady?.()}
          />
        ) : (
          <div className={styles.roomFallback} />
        )}
      </div>
      <canvas ref={frontRef} className={styles.fx} aria-hidden="true" />

      <div ref={hudRef} className={styles.hud}>
        <div ref={scrimRef} className={styles.captionScrim} aria-hidden="true" />
        <div ref={brandRef} className={styles.brand} aria-hidden="true">
          <span className={styles.brandDot} />
          SEILINK
        </div>
        <div className={styles.caption} aria-live="polite">
          <p ref={lineRef} className={styles.line} />
          <p ref={subRef} className={styles.sub} />
          <div className={styles.dots} aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                ref={(el) => {
                  dotRefs.current[i] = el;
                }}
                className={styles.dot}
              />
            ))}
          </div>
        </div>
        <button type="button" className={styles.skip} onClick={skip}>
          {t('Skip')}
        </button>
      </div>
    </div>
  );
}

/** Her box on screen (null before she has a size), in the root's coordinates. */
function herBox(el: HTMLElement | null, root: HTMLElement | null): Box | null {
  const box = el?.parentElement ?? el;
  if (!box || !root) return null;
  const r = box.getBoundingClientRect();
  const o = root.getBoundingClientRect();
  if (r.height < 4) return null;
  const w = Math.max(r.width, r.height * 0.42);
  return { x: r.left - o.left + (r.width - w) / 2, y: r.top - o.top, w, h: r.height };
}
