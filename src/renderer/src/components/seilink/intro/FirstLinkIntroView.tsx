/**
 * The first-link intro's picture (261105, T337; 261106 the eclipse aurora
 * and its climax; 261106 v6 the WorldLink status lines): data in props, no
 * IPC, so the app (FirstLinkIntro) and the dev harness (DevIntroPreview)
 * render the same thing.
 *
 * The lines are paced by a progress source (`source`, lib/seilink/worldLink.ts
 * LinkSource): the app's follows her Anima bake and the host start
 * (animaLinkSource), the harness's is simulated and known up front. Every
 * frame comes from computeFrame(introTimes(planLink(log)), t, ...): a rAF loop
 * writes it to the DOM through refs (no React render per frame) and draws
 * the light and star canvases (introFx.ts). The lines are centred and type
 * in letter by letter, their ellipsis cycling as dots (lib/seilink/typing.ts,
 * LineParts below); screen readers get each whole line once from a hidden
 * live region.
 *
 * What it ends on (`end`): the plain background she spawns on (`plain_dark` /
 * `plain_light`, the OS theme, PLAIN_COLOURS: the same colour the wallpaper
 * draws), or her room (`room`, a replay). `tone` is the theme's solid colour
 * (the climax fills the screen with it): white in light mode, black in dark.
 * With `manual`, there is no loop: the harness calls
 * `window.__firstLinkSeek(ms)` and gets exactly that frame (and reads the
 * length from `window.__firstLinkLength`), which is how the review videos
 * are rendered without dropped frames.
 *
 * Ends (onFinish once):
 *  - completed: the success line landed, she came in and the timeline
 *    reached its end. With `holdEnd` (the first link, played on the desktop
 *    stage) only the captions fade: the last frame is her on the plain
 *    background (or in her room) full screen, the same picture the
 *    wallpaper draws, so the window can step aside without a visible cut.
 *  - skipped: the Skip button or Esc. Fades out fast; with `holdEnd` it
 *    crossfades into the solid (before the success line) and plays her
 *    entrance, rushing the settle (SKIP_RUSH) once the solid has cleared, so
 *    a skip also ends on her room. The climax and the solid are never played fast.
 *  - aborted: the link failed (the failure line). The light stays with the
 *    line and no her; the button turns into Close, and Close or Esc fades
 *    the overlay out (the move-in sheet's retry shows when the host failed).
 * onReport gets the status lines' analytics once: at the end, or when it is
 * unmounted before one.
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { IntroBeat, IntroEndOn, LinkOutcome } from '@shared/seilinkIntroTelemetry';
import type { RoomPresetManifest, RoomState } from '@shared/seilinkRoom';
import type { RoomUrlResolver } from '@shared/seilinkPack';
import { RoomCanvas, type RoomAvatarSlot } from '../RoomCanvas';
import { RoomAvatar, type RoomAvatarUse } from '../RoomAvatar';
import type { FacepackSource } from '../../../lib/facepack/facepackSource';
import { useT } from '../../../lib/i18n';
import { SKIP_FADE_MS, beatAt, introTimes, skipFrom, span, type IntroTimes } from '../../../lib/seilink/introTimeline';
import {
  FAILURE_LINE,
  STATUS_LINES,
  SUCCESS_LINE,
  emptyLog,
  linkReport,
  planLink,
  recordLink,
  worldNumber,
  type LinkLog,
  type LinkSource,
} from '../../../lib/seilink/worldLink';
import { typedAt, type Typed } from '../../../lib/seilink/typing';
import { captionTop, computeFrame, dayInk, revealMask, roomBehind, type Box, type CaptionId, type IntroFrame } from './introFrame';
import { FIELD_SCALE, STAR_SCALE, drawBack, drawFront, drawStars, grainUrl, herCentre, voidGradient } from './introFx';
import { PLAIN_COLOURS, plainTone, type PlainTone } from '../../../lib/seilink/plainTone';
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
  /** What it ends on: the plain background (by the OS theme) or her room. */
  end: IntroEndOn;
  /** The solid colour's theme (default: from a plain `end`, else the OS theme at mount). */
  tone?: PlainTone;
  reduced: boolean;
  characterId: string;
  name: string;
  /** Her room (a plain one draws only her); null ends on the plain colour alone (the pack is not installed yet). */
  room: IntroRoom | null;
  portrait?: string | null;
  /** The harness passes a face set; the app lets RoomAvatar find hers. */
  facepack?: FacepackSource | null;
  use?: RoomAvatarUse;
  /** What paces the status lines (read once, at mount). */
  source: LinkSource;
  /** Harness: no clock, frames come from window.__firstLinkSeek(ms) (needs a `fixed` source). */
  manual?: boolean;
  onFinish?(end: IntroFinish): void;
  /** The status lines' analytics (seilink_intro_link props, without trigger and the like), once. */
  onReport?(report: Record<string, string | number>): void;
  /** The room has drawn (or there is none). */
  onReady?(): void;
  /** End on her room (captions fade, the picture stays) instead of fading the whole overlay out. */
  holdEnd?: boolean;
}

declare global {
  interface Window {
    __firstLinkSeek?: (ms: number) => Promise<void>;
    /** Harness: how long the seeked intro runs (ms): its end, or a few seconds past the failure line. */
    __firstLinkLength?: number;
  }
}

/** A skip with holdEnd plays the settle this many times faster (once the solid has cleared). */
const SKIP_RUSH = 6;
/** The harness renders this long past the failure line. */
const FAIL_TAIL_MS = 7000;

type Mode = { kind: 'play' } | { kind: 'skip'; at: number; t: number } | { kind: 'close'; at: number; t: number; action: IntroEnd };

export function FirstLinkIntroView(props: FirstLinkIntroViewProps): React.ReactElement {
  const { end, reduced, characterId, name, room, portrait = null, facepack, use = 'auto', source, manual = false, holdEnd = false } = props;
  // Fixed once mounted: a theme change mid-intro does not swap the solid.
  const [tone] = useState<PlainTone>(() => props.tone ?? (end === 'plain_light' ? 'light' : end === 'plain_dark' ? 'dark' : plainTone()));
  const t = useT();
  const world = useMemo(() => String(worldNumber(characterId)), [characterId]);
  const [failedShown, setFailedShown] = useState(false);

  const texts = useMemo(
    () => ({
      lines: STATUS_LINES.map((l) => t(l.key, { world, name })),
      success: t(SUCCESS_LINE, { world }),
      fail: t(FAILURE_LINE, { world }),
    }),
    [t, name, world],
  );

  const rootRef = useRef<HTMLDivElement>(null);
  const backRef = useRef<HTMLCanvasElement>(null);
  const starRef = useRef<HTMLCanvasElement>(null);
  const grainRef = useRef<HTMLDivElement>(null);
  const frontRef = useRef<HTMLCanvasElement>(null);
  const solidRef = useRef<HTMLDivElement>(null);
  const roomRef = useRef<HTMLDivElement>(null);
  const avatarRef = useRef<HTMLDivElement>(null);
  const hudRef = useRef<HTMLDivElement>(null);
  const captionRef = useRef<HTMLDivElement>(null);
  const skipRef = useRef<HTMLButtonElement>(null);
  const lineRef = useRef<HTMLParagraphElement>(null);
  const prevRef = useRef<HTMLParagraphElement>(null);
  // The lines on screen are drawn letter by letter, so screen readers get them from here instead: each whole line once.
  const liveRef = useRef<HTMLParagraphElement>(null);

  // The log: a fixed source's whole log, or what the live source has said so far (ms from the start).
  const logRef = useRef<LinkLog>(source.fixed ?? emptyLog());
  const modeRef = useRef<Mode>({ kind: 'play' });
  const startRef = useRef<number>(0);
  const finishedRef = useRef(false);
  const reportedRef = useRef(false);
  const failedRef = useRef(false);
  const lastTextRef = useRef({ live: '' });
  const cb = useRef(props);
  cb.current = props;
  // A ref: the stage answers after the clock started, and the clock must not restart for it.
  const holdRef = useRef(holdEnd);
  holdRef.current = holdEnd;

  const report = useCallback((outcome: LinkOutcome, endedAt: number) => {
    if (reportedRef.current) return;
    reportedRef.current = true;
    try {
      cb.current.onReport?.(linkReport(logRef.current, planLink(logRef.current), endedAt, outcome));
    } catch {
      /* analytics must never disrupt the intro */
    }
  }, []);

  const finish = useCallback(
    (action: IntroEnd, beat: IntroBeat, timesNow: IntroTimes, tt: number) => {
      if (finishedRef.current) return;
      finishedRef.current = true;
      const elapsed = Math.max(0, performance.now() - startRef.current);
      const reached = timesNow.success !== null && tt >= timesNow.success;
      report(action === 'aborted' ? 'failed' : action === 'completed' || reached ? 'success' : 'abandoned', elapsed);
      cb.current.onFinish?.({ action, beat, elapsedMs: elapsed });
    },
    [report],
  );

  const timesAt = useCallback(
    (skipT: number | null): IntroTimes => introTimes(planLink(logRef.current), reduced, skipT),
    [reduced],
  );

  const textFor = useCallback(
    (id: CaptionId | null): string => (id === null ? '' : typeof id === 'number' ? (texts.lines[id] ?? '') : id === 'success' ? texts.success : texts.fail),
    [texts],
  );

  /** Write one frame to the DOM and canvases. `rootOpacity` fades everything, `hudOpacity` only the captions. */
  const apply = useCallback(
    (f: IntroFrame, rootOpacity: number, hudOpacity: number) => {
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
      // The grain dithers the dark gradients; it goes as her place comes in (under the solid), so the last frame is the plain colour exactly.
      const grain = 1 - f.room.opacity;
      set(grainRef.current, 'opacity', Math.max(0, grain).toFixed(3));
      set(avatarRef.current, 'opacity', f.avatar.opacity.toFixed(3));
      set(avatarRef.current, 'filter', f.avatar.filter);
      set(avatarRef.current, 'transform', f.avatar.rise > 0.05 ? `translateY(${f.avatar.rise.toFixed(2)}px)` : 'none');
      // The solid colour over the whole picture (not the HUD): the opening, the climax filling the screen, its hold under the success line and its fade as she comes in.
      set(solidRef.current, 'opacity', f.solid.toFixed(3));
      set(solidRef.current, 'display', f.solid > 0.0005 ? 'block' : 'none');

      // Captions: one line at a time in the same place. The new one types in
      // letter by letter (its ellipsis turning into cycling dots) as the last one
      // fades out with its letters and dots as they were; under reduced motion
      // the whole line fades up at once with its own static ellipsis.
      const cur = textFor(f.caption.cur);
      const last = lastTextRef.current;
      if (liveRef.current && last.live !== cur) {
        liveRef.current.textContent = cur;
        last.live = cur;
      }
      paintLine(lineRef.current, typedAt(cur, f.caption.curAge, f.reduced), set);
      paintLine(prevRef.current, typedAt(textFor(f.caption.prev), f.caption.prevAge, f.reduced), set);
      const curIn = f.reduced ? f.caption.curIn : 1;
      set(lineRef.current, 'opacity', curIn.toFixed(3));
      set(lineRef.current, 'transform', curIn < 1 ? `translateY(${((1 - curIn) * 8).toFixed(2)}px)` : 'none');
      set(prevRef.current, 'opacity', f.caption.prevOut.toFixed(3));
      set(prevRef.current, 'transform', `translateY(${((f.caption.prevOut - 1) * 6).toFixed(2)}px)`);

      // Captions sit in the empty space above her head, never over her. Each
      // HUD piece goes from night ink to day ink by how much of a light
      // background (the white solid, her room, the white plain one) is behind
      // it. Layout reads first, then the writes.
      const cap = captionRef.current;
      const lineEl = lineRef.current;
      if (cap && lineEl) {
        const top = captionTop(f.H, cap.offsetHeight);
        const y = top + lineEl.offsetTop + lineEl.offsetHeight / 2;
        const half = Math.min(cap.offsetWidth, Math.max(lineEl.offsetWidth, prevRef.current?.offsetWidth ?? 0) + 40) / 2;
        const behind = Math.min(roomBehind(f, centre, { x: f.W / 2 - half, y }), roomBehind(f, centre, { x: f.W / 2 + half, y }));
        const sk = skipRef.current;
        const corner = sk ? roomBehind(f, centre, { x: sk.offsetLeft + sk.offsetWidth / 2, y: sk.offsetTop + sk.offsetHeight / 2 }) : 0;
        set(cap, 'top', `${top.toFixed(1)}px`);
        set(cap, 'opacity', f.caption.block.toFixed(3));
        set(cap, '--fl-day', dayInk(behind).toFixed(3));
        set(sk, '--fl-day', dayInk(corner).toFixed(3));
      }
      if (f.caption.cur === 'fail' && !failedRef.current) {
        failedRef.current = true;
        setFailedShown(true);
      }

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
      const sc = starRef.current;
      if (sc) {
        const w = Math.max(16, Math.round(f.W / STAR_SCALE));
        const h = Math.max(16, Math.round(f.H / STAR_SCALE));
        if (sc.width !== w || sc.height !== h) {
          sc.width = w;
          sc.height = h;
        }
        const sctx = sc.getContext('2d');
        if (sctx) drawStars(sctx, f);
      }
      const bctx = backRef.current?.getContext('2d');
      if (bctx) drawBack(bctx, f);
      const fctx = frontRef.current?.getContext('2d');
      if (fctx) drawFront(fctx, f);
    },
    [textFor],
  );

  const frameAt = useCallback(
    (times: IntroTimes, tt: number): IntroFrame => {
      const W = rootRef.current?.clientWidth || window.innerWidth;
      const H = rootRef.current?.clientHeight || window.innerHeight;
      return computeFrame(times, tt, W, H, reduced, end, tone);
    },
    [reduced, end, tone],
  );

  /** The end's fade at timeline time `tt`: [whole overlay, captions]. With holdEnd only the captions go. */
  const endFade = useCallback((times: IntroTimes, tt: number): [number, number] => {
    const out = times.after ? 1 - span(tt, times.after.fadeAt, times.after.end) : 1;
    return holdRef.current ? [1, out] : [out, 1];
  }, []);

  // The live source: each event lands in the log at the ms it came.
  const sourceRef = useRef(source);
  useEffect(() => {
    const src = sourceRef.current;
    if (src.fixed || !src.subscribe) return;
    let off: (() => void) | undefined;
    try {
      off = src.subscribe((e) => recordLink(logRef.current, e, performance.now() - startRef.current));
    } catch {
      recordLink(logRef.current, { kind: 'failed', failure: 'error' }, performance.now() - startRef.current);
    }
    return () => off?.();
  }, []);

  // Unmounted before it ended (an account switch, the window closing): abandoned.
  useEffect(
    () => () => {
      if (!manual && !reportedRef.current) report('abandoned', Math.max(0, performance.now() - startRef.current));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // The clock (or the harness seek).
  // The clock starts once, at mount: this effect re-runs when a callback changes (the
  // captions' language, her name), and that must not restart the intro or, in the
  // harness, draw frame 0 over the frame it seeked to.
  const clockStarted = useRef(false);
  const seekedRef = useRef(0);
  useLayoutEffect(() => {
    if (!clockStarted.current) {
      clockStarted.current = true;
      startRef.current = performance.now();
    }
    if (manual) {
      const times = timesAt(null);
      window.__firstLinkLength = times.after ? times.after.end : times.fail !== null ? times.fail + FAIL_TAIL_MS : 0;
      window.__firstLinkSeek = async (ms: number) => {
        seekedRef.current = ms;
        apply(frameAt(times, ms), ...endFade(times, ms));
        await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      };
      apply(frameAt(times, seekedRef.current), ...endFade(times, seekedRef.current));
      return () => {
        delete window.__firstLinkSeek;
        delete window.__firstLinkLength;
      };
    }
    let raf = 0;
    const tick = (): void => {
      const now = performance.now();
      const elapsed = now - startRef.current;
      const mode = modeRef.current;
      if (mode.kind === 'play') {
        const times = timesAt(null);
        const f = frameAt(times, elapsed);
        apply(f, ...endFade(times, elapsed));
        if (times.after && elapsed >= times.after.end) return finish('completed', 'linked', times, elapsed);
      } else if (mode.kind === 'skip') {
        // To her room (the wallpaper's picture), captions fading: before the success line a calm crossfade into
        // the solid and her entrance, then the settle rushed; the end is that frame, held.
        const times = timesAt(mode.t);
        const a = times.after;
        if (!a) {
          modeRef.current = { kind: 'close', at: now, t: elapsed, action: 'skipped' };
        } else {
          const pivot = skipFrom(times, mode.t);
          const tt = Math.min(a.fadeAt, elapsed <= pivot ? elapsed : pivot + (elapsed - pivot) * SKIP_RUSH);
          const hud = 1 - span(now - mode.at, 0, SKIP_FADE_MS);
          apply(frameAt(times, tt), 1, hud);
          if (tt >= a.fadeAt) return finish('skipped', beatAt(times, mode.t), times, tt);
        }
      } else {
        // Close: the overlay fades out on the frame it was closed on (a skip in the window, Close on the failure line).
        const times = timesAt(null);
        const f = frameAt(times, mode.t);
        const op = 1 - span(now - mode.at, 0, SKIP_FADE_MS);
        apply(f, op, 1);
        if (op <= 0) return finish(mode.action, f.beat, times, mode.t);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [manual, apply, frameAt, finish, endFade, timesAt]);

  const skip = useCallback(() => {
    if (manual || modeRef.current.kind !== 'play') return;
    const now = performance.now();
    const elapsed = now - startRef.current;
    const plan = planLink(logRef.current);
    if (plan.fail && elapsed >= plan.fail.at) {
      modeRef.current = { kind: 'close', at: now, t: elapsed, action: 'aborted' };
      return;
    }
    modeRef.current = holdRef.current ? { kind: 'skip', at: now, t: elapsed } : { kind: 'close', at: now, t: elapsed, action: 'skipped' };
  }, [manual]);

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

  const grainStyle = useMemo<React.CSSProperties>(() => {
    const url = grainUrl();
    return url ? { backgroundImage: `url(${url})` } : { display: 'none' };
  }, []);

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
      data-end={end}
      data-tone={tone}
      data-reduced={reduced ? '1' : undefined}
      role="dialog"
      aria-modal="true"
      aria-label="WorldLink"
      tabIndex={-1}
    >
      <div className={styles.void} style={{ background: voidGradient() }} />
      <canvas ref={starRef} className={styles.fx} aria-hidden="true" />
      <canvas ref={backRef} className={styles.fx} aria-hidden="true" />
      <div ref={roomRef} className={styles.room} aria-hidden="true">
        {end !== 'room' || !room ? <div className={styles.plain} style={{ background: PLAIN_COLOURS[end === 'plain_light' ? 'light' : 'dark'] }} /> : null}
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
            // Transparent: the light shows through, and the plain layer above fades in the colour.
            style={{ position: 'absolute', inset: 0, background: 'transparent' }}
            onReady={() => cb.current.onReady?.()}
            onError={() => cb.current.onReady?.()}
          />
        ) : null}
      </div>
      <canvas ref={frontRef} className={styles.fx} aria-hidden="true" />
      <div ref={grainRef} className={styles.grain} style={grainStyle} aria-hidden="true" />
      <div ref={solidRef} className={styles.solid} style={{ background: PLAIN_COLOURS[tone] }} aria-hidden="true" />

      <div ref={hudRef} className={styles.hud}>
        <div ref={captionRef} className={styles.caption}>
          <div className={styles.captionGlow} aria-hidden="true" />
          <div className={styles.lines}>
            <LineParts ref={prevRef} />
            <LineParts ref={lineRef} />
          </div>
          <p ref={liveRef} className={styles.live} aria-live="polite" />
        </div>
        <button ref={skipRef} type="button" className={styles.skip} onClick={skip}>
          {failedShown ? t('Close') : t('Skip')}
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

/**
 * One caption line: the typed letters, the newest letter coming up, the letters
 * still to come (there but invisible, so the line keeps its width and its
 * centre while it types) and three dot places (all three always laid out,
 * so the cycling dots never move the line). Hidden from screen readers:
 * `live` reads each whole line once.
 */
const LineParts = React.forwardRef<HTMLParagraphElement>(function LineParts(_props, ref) {
  return (
    <p ref={ref} className={styles.line} aria-hidden="true">
      <span />
      <span />
      <span className={styles.rest} />
      <span>
        <span />
        <span />
        <span />
      </span>
    </p>
  );
});

/** Writes a line's state into its LineParts (text only when it changes). */
function paintLine(el: HTMLElement | null, s: Typed, set: (el: HTMLElement | null, k: string, v: string) => void): void {
  if (!el || el.children.length < 4) return;
  const [typed, fresh, rest, dots] = Array.from(el.children) as HTMLElement[];
  const text = (node: HTMLElement, v: string): void => {
    if (node.textContent !== v) node.textContent = v;
  };
  text(typed, s.typed);
  text(fresh, s.fresh);
  text(rest, s.rest);
  set(fresh, 'opacity', s.freshIn >= 1 ? '1' : s.freshIn.toFixed(3));
  const marks = Array.from(dots.children) as HTMLElement[];
  marks.forEach((m, i) => {
    text(m, s.dot ?? '');
    set(m, 'opacity', i < s.dots ? '1' : '0');
  });
}
