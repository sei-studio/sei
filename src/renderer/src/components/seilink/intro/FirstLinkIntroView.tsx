/**
 * The first-link intro's picture (261105, T337): data in props, no IPC, so
 * the app (FirstLinkIntro) and the dev harness (DevIntroPreview) render the
 * same thing.
 *
 * Every frame comes from computeFrame(style, timeline, t): a rAF loop writes
 * it to the DOM through refs (no React render per frame) and draws the two
 * effect canvases (introFx.ts). With `manual`, there is no loop: the harness
 * calls `window.__firstLinkSeek(ms)` and gets exactly that frame, which is
 * how the review videos are rendered without dropped frames.
 *
 * Ends (onFinish once):
 *  - completed: the timeline reached its end. The end card ("Linked.") waits
 *    for the host's answer (`answer`), up to HOLD_MAX_MS.
 *  - skipped: the Skip button or Esc, at any time. Fades out fast.
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
  FULL_TIMELINE,
  SKIP_FADE_MS,
  span,
  timelineTime,
  typedChars,
  type IntroTimeline,
} from '../../../lib/seilink/introTimeline';
import { PORT_SCALE, computeFrame, type Box, type IntroFrame } from './introFrame';
import { drawBack, drawFront } from './introFx';
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
}

declare global {
  interface Window {
    __firstLinkSeek?: (ms: number) => Promise<void>;
  }
}

const DPR_CAP = 1.5;

type Mode = { kind: 'play' } | { kind: 'skip'; at: number; t: number } | { kind: 'abort'; at: number; t: number };

/** Glyphs for the four desktop icons (folder, page, chat, bin). */
const ICON_PATHS: readonly string[] = [
  'M3 7.5a1.5 1.5 0 0 1 1.5-1.5h4l2 2h9a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z',
  'M7 3.5h7l4 4v13H7zM14 3.5v4h4M9.5 12h6M9.5 15h6',
  'M4 5.5h16v10H9l-4 3.5v-3.5H4zM8 10h8',
  'M5 7h14M9.5 7V4.5h5V7M7 7l1 13h8l1-13',
];

export function FirstLinkIntroView(props: FirstLinkIntroViewProps): React.ReactElement {
  const { style, reduced, characterId, name, room, portrait = null, facepack, use = 'auto', answer, manual = false } = props;
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
  const bezelRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const roomRef = useRef<HTMLDivElement>(null);
  const tintRef = useRef<HTMLDivElement>(null);
  const holoMatrixRef = useRef<SVGFEColorMatrixElement>(null);
  const avatarRef = useRef<HTMLDivElement>(null);
  const scanRef = useRef<HTMLDivElement>(null);
  const deskRef = useRef<HTMLDivElement>(null);
  const iconRefs = useRef<Array<HTMLDivElement | null>>([]);
  const brandRef = useRef<HTMLDivElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const lineRef = useRef<HTMLSpanElement>(null);
  const caretRef = useRef<HTMLSpanElement>(null);
  const subRef = useRef<HTMLParagraphElement>(null);
  const lineBoxRef = useRef<HTMLParagraphElement>(null);
  const fillRefs = useRef<Array<HTMLDivElement | null>>([]);
  const glitchRefs = useRef<{ roomNoise: SVGFETurbulenceElement | null; roomMap: SVGFEDisplacementMapElement | null; roomR: SVGFEOffsetElement | null; roomB: SVGFEOffsetElement | null; herNoise: SVGFETurbulenceElement | null; herMap: SVGFEDisplacementMapElement | null; herR: SVGFEOffsetElement | null; herB: SVGFEOffsetElement | null }>({
    roomNoise: null,
    roomMap: null,
    roomR: null,
    roomB: null,
    herNoise: null,
    herMap: null,
    herR: null,
    herB: null,
  });

  const modeRef = useRef<Mode>({ kind: 'play' });
  const startRef = useRef<number>(0);
  const answeredAtRef = useRef<number | null>(null);
  const finishedRef = useRef(false);
  const lastTextRef = useRef({ line: '', sub: '' });
  const cb = useRef(props);
  cb.current = props;

  const finish = useCallback((action: IntroEnd, beat: IntroBeat) => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    cb.current.onFinish?.({ action, beat, elapsedMs: Math.max(0, performance.now() - startRef.current) });
  }, []);

  /** Write one frame (plus the HUD for timeline time `tt`) to the DOM and canvases. */
  const apply = useCallback(
    (f: IntroFrame, rootOpacity: number, aborted: boolean) => {
      const set = (el: HTMLElement | null, k: string, v: string): void => {
        if (el && el.style.getPropertyValue(k) !== v) el.style.setProperty(k, v);
      };
      set(rootRef.current, 'opacity', rootOpacity.toFixed(3));
      set(stageRef.current, 'transform', `translate(${f.stage.tx.toFixed(2)}px, ${f.stage.ty.toFixed(2)}px) scale(${f.stage.scale.toFixed(5)})`);
      set(stageRef.current, 'opacity', f.stage.opacity.toFixed(3));
      const roomFilter = [f.room.glitch > 0.01 ? 'url(#fl-glitch-room)' : '', f.room.filter === 'none' ? '' : f.room.filter].filter(Boolean).join(' ') || 'none';
      set(roomRef.current, 'filter', roomFilter);
      set(roomRef.current, 'opacity', f.room.opacity.toFixed(3));
      set(roomRef.current, 'clip-path', f.room.clip);
      set(roomRef.current, 'mask-image', f.room.mask);
      set(roomRef.current, '-webkit-mask-image', f.room.mask);
      set(tintRef.current, 'opacity', (0.9 * f.room.tint).toFixed(3));
      const herFilter =
        [f.avatar.holo > 0 ? 'url(#fl-holo-her)' : '', f.avatar.glitch > 0.01 ? 'url(#fl-glitch-her)' : '', f.avatar.filter === 'none' ? '' : f.avatar.filter].filter(Boolean).join(' ') || 'none';
      if (f.avatar.holo > 0) holoMatrixRef.current?.setAttribute('values', holoMatrix(f.avatar.holo));
      set(avatarRef.current, 'opacity', f.avatar.opacity.toFixed(3));
      set(avatarRef.current, 'filter', herFilter);
      set(avatarRef.current, 'clip-path', f.avatar.clip);
      set(avatarRef.current, 'transform', f.avatar.transform);
      set(scanRef.current, 'opacity', f.scanlines.toFixed(3));
      const bz = bezelRef.current;
      if (bz) {
        set(bz, 'left', `${f.bezel.x.toFixed(1)}px`);
        set(bz, 'top', `${f.bezel.y.toFixed(1)}px`);
        set(bz, 'width', `${f.bezel.w.toFixed(1)}px`);
        set(bz, 'height', `${f.bezel.h.toFixed(1)}px`);
        set(bz, 'opacity', f.bezel.opacity.toFixed(3));
      }
      set(deskRef.current, 'opacity', f.desk.toFixed(3));
      f.icons.forEach((a, i) => {
        const el = iconRefs.current[i];
        set(el, 'opacity', a.toFixed(3));
        set(el, 'transform', `translateY(${((1 - a) * 12).toFixed(1)}px)`);
      });
      set(brandRef.current, 'opacity', f.brand.toFixed(3));
      // The caption's backing shade, while the room fills the window (the line sits over her).
      set(scrimRef.current, 'opacity', (f.stage.opacity * span(f.stage.scale, PORT_SCALE + 0.05, 0.95)).toFixed(3));
      f.bars.forEach((b, i) => set(fillRefs.current[i], 'transform', `scaleX(${b.toFixed(4)})`));

      // Glitch filter parameters (only read while a burst is on).
      const g = glitchRefs.current;
      const slot = Math.floor(f.t / 30);
      if (f.room.glitch > 0.01) {
        g.roomNoise?.setAttribute('seed', String(slot % 97));
        g.roomMap?.setAttribute('scale', (90 * f.room.glitch).toFixed(1));
        g.roomR?.setAttribute('dx', (-14 * f.room.glitch).toFixed(1));
        g.roomB?.setAttribute('dx', (14 * f.room.glitch).toFixed(1));
      }
      if (f.avatar.glitch > 0.01) {
        g.herNoise?.setAttribute('seed', String((slot * 7) % 89));
        g.herMap?.setAttribute('scale', (60 * f.avatar.glitch).toFixed(1));
        g.herR?.setAttribute('dx', (-10 * f.avatar.glitch).toFixed(1));
        g.herB?.setAttribute('dx', (10 * f.avatar.glitch).toFixed(1));
      }

      // HUD text.
      let line: string;
      let typing = false;
      let lineOpacity = 1;
      let subOpacity = 0;
      if (aborted) {
        line = lines.aborted;
      } else if (f.beat === 'linked') {
        line = lines.linked;
        subOpacity = span(f.t, tl.beats.linked + 250, tl.beats.linked + 650);
        lineOpacity = tl.msPerChar > 0 ? 1 : span(f.t, tl.beats.linked + tl.lineDelay, tl.beats.linked + tl.lineDelay + 320);
      } else {
        const full = Array.from(lines[f.beat]);
        const n = typedChars(tl, f.t, f.beat, full.length);
        line = full.slice(0, n).join('');
        typing = n > 0 && n < full.length;
        if (tl.msPerChar <= 0) lineOpacity = span(f.t, tl.beats[f.beat] + tl.lineDelay, tl.beats[f.beat] + tl.lineDelay + 320);
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
      set(lineBoxRef.current, 'opacity', lineOpacity.toFixed(3));
      set(subRef.current, 'opacity', subOpacity.toFixed(3));
      const caretOn = !reduced && !aborted && f.beat !== 'linked' && (typing || Math.floor(f.t / 420) % 2 === 0) && line.length > 0;
      set(caretRef.current, 'visibility', caretOn ? 'visible' : 'hidden');

      // Canvases.
      const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
      for (const c of [backRef.current, frontRef.current]) {
        if (!c) continue;
        const w = Math.round(f.W * dpr);
        const h = Math.round(f.H * dpr);
        if (c.width !== w || c.height !== h) {
          c.width = w;
          c.height = h;
        }
      }
      const bctx = backRef.current?.getContext('2d');
      if (bctx) {
        bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        drawBack(bctx, f);
      }
      const fctx = frontRef.current?.getContext('2d');
      if (fctx) {
        fctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        drawFront(fctx, f, herBox(avatarRef.current, rootRef.current));
      }
    },
    [lines, tl, reduced],
  );

  const frameAt = useCallback(
    (tt: number): IntroFrame => {
      const W = rootRef.current?.clientWidth || window.innerWidth;
      const H = rootRef.current?.clientHeight || window.innerHeight;
      return computeFrame(style, tl, tt, W, H, reduced);
    },
    [style, tl, reduced],
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
        apply(frameAt(ms), 1 - span(ms, tl.fadeAt, tl.end), false);
        await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      };
      apply(frameAt(0), 1, false);
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
        apply(f, 1 - span(tt, tl.fadeAt, tl.end), false);
        if (tt >= tl.end) return finish('completed', 'linked');
      } else {
        const since = now - mode.at;
        const f = frameAt(mode.t);
        const fadeFrom = mode.kind === 'abort' ? ABORT_MS : 0;
        const op = 1 - span(since, fadeFrom, fadeFrom + SKIP_FADE_MS);
        apply(f, op, mode.kind === 'abort');
        if (op <= 0) return finish(mode.kind === 'abort' ? 'aborted' : 'skipped', f.beat);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [manual, apply, frameAt, finish, tl]);

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
    <div ref={rootRef} className={styles.root} data-style={reduced ? 'calm' : style} role="dialog" aria-modal="true" aria-label="SeiLink" tabIndex={-1}>
      <div className={styles.void} />
      <canvas ref={backRef} className={styles.fx} aria-hidden="true" />
      <div ref={bezelRef} className={styles.bezel} aria-hidden="true">
        <div className={styles.stand} />
      </div>
      <div ref={stageRef} className={styles.stage} aria-hidden="true">
        <div ref={roomRef} className={styles.room}>
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
          <div ref={tintRef} className={styles.tint} />
        </div>
        <div ref={scanRef} className={styles.scanlines} />
        <div ref={deskRef} className={styles.desk}>
          <div className={styles.icons}>
            {ICON_PATHS.map((d, i) => (
              <div
                key={i}
                ref={(el) => {
                  iconRefs.current[i] = el;
                }}
                className={styles.icon}
              >
                <div className={styles.iconTile}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                    <path d={d} />
                  </svg>
                </div>
                <div className={styles.iconLabel} style={{ width: `${[78, 64, 84, 52][i]}%` }} />
              </div>
            ))}
          </div>
          <div className={styles.taskbar}>
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className={i === 2 ? `${styles.taskItem} ${styles.taskItemOn}` : styles.taskItem} />
            ))}
          </div>
        </div>
      </div>
      <canvas ref={frontRef} className={styles.fx} aria-hidden="true" />

      <div ref={scrimRef} className={styles.captionScrim} aria-hidden="true" />
      <div ref={brandRef} className={styles.brand} aria-hidden="true">
        <span className={styles.brandDot} />
        SEILINK
      </div>
      <div className={styles.caption} aria-live="polite">
        <p ref={lineBoxRef} className={styles.line}>
          <span ref={lineRef} />
          <span ref={caretRef} className={styles.caret} aria-hidden="true" />
        </p>
        <p ref={subRef} className={styles.sub} />
        <div className={styles.steps} aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className={styles.step}>
              <div
                ref={(el) => {
                  fillRefs.current[i] = el;
                }}
                className={styles.stepFill}
              />
            </div>
          ))}
        </div>
      </div>
      <button type="button" className={styles.skip} onClick={skip}>
        {t('Skip')}
      </button>

      <svg className={styles.svgDefs} aria-hidden="true" focusable="false">
        <defs>
          <GlitchFilter
            id="fl-glitch-room"
            refs={(n, m, r, b) => Object.assign(glitchRefs.current, { roomNoise: n, roomMap: m, roomR: r, roomB: b })}
          />
          <GlitchFilter id="fl-glitch-her" refs={(n, m, r, b) => Object.assign(glitchRefs.current, { herNoise: n, herMap: m, herR: r, herB: b })} />
          <filter id="fl-holo-her" colorInterpolationFilters="sRGB">
            <feColorMatrix ref={holoMatrixRef} type="matrix" values={holoMatrix(0)} />
          </filter>
        </defs>
      </svg>
    </div>
  );
}

/**
 * Her colours mapped toward a cyan hologram by `g` (0 = as she is): a straight
 * blend of the identity matrix and a cyan-on-luminance one, so the fade goes
 * from tinted to true colour without passing through other hues.
 */
const HOLO: readonly number[] = [
  0.1, 0.33, 0.035, 0, 0.03,
  0.19, 0.63, 0.065, 0, 0.08,
  0.22, 0.74, 0.075, 0, 0.16,
  0, 0, 0, 1, 0,
];
const IDENTITY: readonly number[] = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0];

function holoMatrix(g: number): string {
  return IDENTITY.map((v, i) => (v + (HOLO[i] - v) * g).toFixed(4)).join(' ');
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
 * Banded displacement plus a red/blue split: horizontal noise bands (low x
 * frequency, high y frequency) shove rows sideways, like a torn signal.
 */
function GlitchFilter(props: {
  id: string;
  refs(noise: SVGFETurbulenceElement | null, map: SVGFEDisplacementMapElement | null, r: SVGFEOffsetElement | null, b: SVGFEOffsetElement | null): void;
}): React.ReactElement {
  const noise = useRef<SVGFETurbulenceElement>(null);
  const map = useRef<SVGFEDisplacementMapElement>(null);
  const r = useRef<SVGFEOffsetElement>(null);
  const b = useRef<SVGFEOffsetElement>(null);
  const { refs } = props;
  useLayoutEffect(() => {
    refs(noise.current, map.current, r.current, b.current);
  }, [refs]);
  return (
    <filter id={props.id} x="-10%" y="-10%" width="120%" height="120%" colorInterpolationFilters="sRGB">
      <feTurbulence ref={noise} type="turbulence" baseFrequency="0.0004 0.045" numOctaves={1} seed={1} result="noise" />
      <feDisplacementMap ref={map} in="SourceGraphic" in2="noise" scale={0} xChannelSelector="R" yChannelSelector="A" result="torn" />
      <feColorMatrix in="torn" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="red" />
      <feOffset ref={r} in="red" dx={0} result="redOff" />
      <feColorMatrix in="torn" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 1 0" result="cyan" />
      <feOffset ref={b} in="cyan" dx={0} result="cyanOff" />
      <feBlend in="redOff" in2="cyanOff" mode="screen" />
    </filter>
  );
}
