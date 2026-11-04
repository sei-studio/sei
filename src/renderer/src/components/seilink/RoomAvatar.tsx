/**
 * RoomAvatar (261104, SeiLink): her body in her room. Fills RoomCanvas's
 * avatar slot and keeps her alive with idle motion.
 *
 *   <RoomCanvas ... avatar={(slot) => (
 *     <RoomAvatar slot={slot} characterId={c.id} portrait={c.portrait_image}
 *       use={roomAvatarUse(room.avatar)} speaking={speaking} levelRef={levelRef} busy={busy} />
 *   )} />
 *
 * What she looks like, best first (each step falls through when the one
 * above is missing or fails to load):
 *  1. her imported avatar (Live2D or rig, through AvatarView), unless the
 *     room says to use the Sei avatar (`use: 'sei'`);
 *  2. the Sei avatar: her baked face set (facepack: blink, mouth, head
 *     turns), from `facepack` or main's dev pack dir;
 *  3. her portrait, cut out of its background (portraitCutout.ts);
 *  4. a soft silhouette.
 *
 * Motion (lib/seilink/idleMotion.ts): seated sway and breathing, small seat
 * shifts, and now and then a walk out of the frame and back. `busy` or
 * `speaking` holds her in her seat. The frame cap is the slot's `fps`: 0
 * stops every loop (hers and the view's) and leaves a still picture; she is
 * also still under prefers-reduced-motion. Blink, gaze and mouth belong to
 * the view (the portrait has none, so it only breathes and sways).
 *
 * Geometry: the stage is the slot box (bottom centre = the anchor). Her
 * figure hangs `SINK` of her height below that line and is clipped there, so
 * standing up never shows the cut edge of a bust; the room's front canvas
 * draws over her, so furniture in front stays in front. Every offset is in
 * her heights, so the anchor math holds at any room scale.
 *
 * Self-contained: props in, and only the bridge calls the avatar views
 * already make (avatarGet, facepackForCharacter, manifest broadcasts), all
 * optional so it also runs in a plain browser tab.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AvatarCamera, AvatarEmotion } from '@shared/ipc';
import type { RoomState, RoomTime } from '@shared/seilinkRoom';
import { sei } from '../../lib/ipcClient';
import { AvatarView } from '../../lib/avatar/AvatarView';
import { FacepackView } from '../../lib/facepack/FacepackView';
import type { FacepackSource } from '../../lib/facepack/facepackSource';
import { portraitSrc } from '../../lib/portraitSrc';
import { loadCutout, type CutoutImage } from '../../lib/seilink/portraitCutout';
import {
  IdleScheduler,
  REST_POSE,
  poseTransform,
  type IdleExits,
  type IdleMotionConfig,
  type IdlePhase,
  type IdlePose,
} from '../../lib/seilink/idleMotion';
import type { RoomAvatarSlot } from './RoomCanvas';
import styles from './RoomAvatar.module.css';

export type RoomAvatarKind = 'live2d' | 'rig' | 'facepack' | 'portrait' | 'placeholder';

/** 'auto': her imported avatar when she has one; 'sei': the Sei avatar only; 'imported': her model (falls back like auto). */
export type RoomAvatarUse = 'auto' | 'sei' | 'imported';

/** What the room's saved choice means for RoomAvatar. */
export function roomAvatarUse(avatar: RoomState['avatar']): RoomAvatarUse {
  return avatar.kind === 'live2d' ? 'imported' : 'sei';
}

export interface RoomAvatarProps {
  slot: RoomAvatarSlot;
  characterId: string;
  /** For the figure's accessible name. */
  name?: string;
  use?: RoomAvatarUse;
  /** Her portrait_image ref or a URL (resolved through portraitSrc). */
  portrait?: string | null;
  /** The Sei avatar's face set. Absent: ask main's pack dir; null: none. */
  facepack?: FacepackSource | null;
  /** True while she is audibly speaking (mouth, and holds her seated). */
  speaking?: boolean;
  /** 0..1 mouth level, mutated at ~25 Hz by whoever plays her voice. */
  levelRef?: React.MutableRefObject<number>;
  /** Emotion of the line being spoken (Live2D expressions; a facepack expression name also works). */
  emotion?: AvatarEmotion | null;
  /** The player is interacting (dock open, editor, a call): hold her in place. */
  busy?: boolean;
  /** Tune the idle motion, or false for none (still, but the view still blinks). */
  motion?: Partial<IdleMotionConfig> | false;
  /** Framing for an imported model; default shows her from the waist up. */
  camera?: AvatarCamera | null;
  /** Dev: change it to make her walk off now (when seated). */
  walkOffSignal?: number;
  /** Dev: how long that walk-off keeps her away. */
  walkOffAwayMs?: number;
  onKind?(kind: RoomAvatarKind): void;
  onPhase?(phase: IdlePhase): void;
}

/** How far her figure hangs below the floor line, in her heights (see the header). */
export const SINK = 0.07;
/** An imported model contain-fits its box; this shows the top three quarters of it (top edge at the box top). */
const BUST_CAMERA: AvatarCamera = { zoom: 1.35, x: 0, y: 0.175 };
/** Motion never draws faster than this, whatever the room runs at. */
const MOTION_FPS_MAX = 30;
/** How often the frame edges are re-measured for a walk-off. */
const EXIT_MEASURE_MS = 1_000;
/** Time-of-day grade so a day-lit figure sits in a night room. */
const TIME_GRADE: Record<RoomTime, string> = {
  day: 'none',
  dusk: 'brightness(0.97) sepia(0.05)',
  night: 'brightness(0.84) saturate(0.9)',
};

// ── kind resolution ─────────────────────────────────────────────────────────

type Resolved = { kind: RoomAvatarKind; packId?: string };

async function resolveKind(
  characterId: string,
  use: RoomAvatarUse,
  facepack: FacepackSource | null | undefined,
  portrait: string | null,
  failed: ReadonlySet<RoomAvatarKind>,
): Promise<Resolved> {
  if (use !== 'sei' && !failed.has('live2d') && !failed.has('rig')) {
    try {
      const m = await sei?.avatarGet?.(characterId);
      if (m) return { kind: m.kind === 'rig' ? 'rig' : 'live2d' };
    } catch {
      /* no bridge, or no model */
    }
  }
  if (!failed.has('facepack')) {
    if (facepack) return { kind: 'facepack' };
    if (facepack === undefined) {
      try {
        const id = await sei?.facepackForCharacter?.(characterId);
        if (id) return { kind: 'facepack', packId: id };
      } catch {
        /* dev flag off */
      }
    }
  }
  if (portrait && !failed.has('portrait')) return { kind: 'portrait' };
  return { kind: 'placeholder' };
}

// ── motion ──────────────────────────────────────────────────────────────────

function useReducedMotion(): boolean {
  const query = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const [reduced, setReduced] = useState(() => query?.matches ?? false);
  useEffect(() => {
    if (!query) return;
    const on = (): void => setReduced(query.matches);
    query.addEventListener('change', on);
    return () => query.removeEventListener('change', on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return reduced;
}

/** Distance to each side of the visible frame, in her heights, plus her own half width. */
function measureExits(stage: HTMLElement): IdleExits {
  const r = stage.getBoundingClientRect();
  const h = Math.max(1, r.height);
  let left = 0;
  let right = window.innerWidth;
  for (let p = stage.parentElement; p; p = p.parentElement) {
    const cs = getComputedStyle(p);
    if (cs.overflowX !== 'visible' || cs.overflow === 'hidden') {
      const fr = p.getBoundingClientRect();
      left = Math.max(left, fr.left);
      right = Math.min(right, fr.right);
      break;
    }
  }
  const ax = r.left + r.width / 2;
  // Her half width, with room for the lean, so she is fully out.
  const half = r.width * 0.55 + h * 0.08;
  return { left: Math.max(0.6, (ax - left + half) / h), right: Math.max(0.6, (right - ax + half) / h) };
}

interface MotionOpts {
  fps: number;
  busy: boolean;
  height: number;
  enabled: boolean;
  config: Partial<IdleMotionConfig>;
  /** Talking bounce for figures without a mouth. */
  bounce: boolean;
  levelRef?: React.MutableRefObject<number>;
  speaking: boolean;
  onPhase(phase: IdlePhase): void;
}

/**
 * Drives an IdleScheduler from requestAnimationFrame and writes the pose
 * straight to the element (no React render per frame). Its clock advances
 * only while frames run, so a covered room resumes where it stopped.
 */
function useIdleMotion(
  stageRef: React.RefObject<HTMLDivElement | null>,
  bodyRef: React.RefObject<HTMLDivElement | null>,
  opts: MotionOpts,
): { forceWalk(awayMs?: number): void } {
  const live = useRef(opts);
  live.current = opts;
  const sched = useRef<IdleScheduler | null>(null);
  const clock = useRef(0);
  const exits = useRef<IdleExits>({ left: 3, right: 3 });
  const pose = useRef<IdlePose>(REST_POSE);
  const configKey = JSON.stringify(opts.config);
  const running = opts.enabled && opts.fps > 0;

  useEffect(() => {
    sched.current = null;
  }, [configKey]);

  useEffect(() => {
    const body = bodyRef.current;
    const stage = stageRef.current;
    if (!body || !stage) return;
    if (!live.current.enabled) {
      body.style.transform = poseTransform(REST_POSE, live.current.height);
      pose.current = REST_POSE;
      live.current.onPhase('seated');
      return;
    }
    if (!running) return; // fps 0: keep the last pose, a still picture.
    const s = (sched.current ??= new IdleScheduler(clock.current, live.current.config));
    let raf = 0;
    let lastTick = performance.now();
    let lastMeasure = -Infinity;
    let phase: IdlePhase | null = null;
    let talk = 0;
    const tick = (t: number): void => {
      raf = requestAnimationFrame(tick);
      const L = live.current;
      const cap = Math.min(MOTION_FPS_MAX, L.fps);
      const dt = t - lastTick;
      if (dt < 1000 / cap - 1) return;
      lastTick = t;
      // A long gap (tab hidden, a stall) counts as a short one: she does not skip ahead.
      clock.current += Math.min(dt, 250);
      if (t - lastMeasure > EXIT_MEASURE_MS) {
        lastMeasure = t;
        exits.current = measureExits(stage);
      }
      const p = s.update(clock.current, { busy: L.busy || L.speaking, exits: exits.current });
      pose.current = p;
      let out = p;
      if (L.bounce) {
        const level = L.speaking ? Math.min(1, L.levelRef?.current ?? 0.35) : 0;
        talk += (level - talk) * (level > talk ? 0.45 : 0.15);
        if (talk > 0.002) out = { ...p, lift: p.lift + 0.006 * talk, breath: p.breath * (1 + 0.008 * talk) };
      }
      body.style.transform = poseTransform(out, L.height);
      if (p.phase !== phase) {
        phase = p.phase;
        L.onPhase(p.phase);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [running, opts.enabled, configKey, stageRef, bodyRef]);

  // A slot resize while still: re-apply the held pose at the new height.
  useEffect(() => {
    const body = bodyRef.current;
    if (body) body.style.transform = poseTransform(pose.current, opts.height);
  }, [opts.height, bodyRef]);

  const forceWalk = useCallback(
    (awayMs?: number) => {
      const stage = stageRef.current;
      if (!live.current.enabled) return;
      const s = (sched.current ??= new IdleScheduler(clock.current, live.current.config));
      if (stage) exits.current = measureExits(stage);
      s.forceWalk(clock.current, exits.current, awayMs);
    },
    [stageRef],
  );
  return { forceWalk };
}

// ── figures ─────────────────────────────────────────────────────────────────

function PortraitFigure({ url, height, name, onError }: { url: string; height: number; name?: string; onError(): void }): React.ReactElement | null {
  const [cut, setCut] = useState<CutoutImage | null>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  useEffect(() => {
    let dead = false;
    setCut(null);
    void loadCutout(url).then((c) => {
      if (dead) return;
      if (c) setCut(c);
      else onErrorRef.current();
    });
    return () => {
      dead = true;
    };
  }, [url]);
  if (!cut) return null;
  return <img className={styles.sprite} src={cut.src} alt={name ?? ''} draggable={false} style={{ height, width: height * cut.aspect }} data-cutout={cut.method} />;
}

/** No art at all: a soft head-and-shoulders silhouette, tinted by the room's time (the editor's figure shape). */
function Silhouette({ height, time }: { height: number; time: RoomTime }): React.ReactElement {
  const [top, bottom] = time === 'night' ? ['#59608f', '#3a3f63'] : time === 'dusk' ? ['#a47f97', '#7d5a73'] : ['#bccbef', '#94a9dc'];
  const id = `sil-${time}`;
  return (
    <svg width={height * 0.6} height={height} viewBox="0 0 60 100" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={top} />
          <stop offset="1" stopColor={bottom} />
        </linearGradient>
      </defs>
      <path
        d="M30 5c7.6 0 13 6 13 15.5 0 7.4-3.6 12.6-7.6 14.8V40c10 1.8 18.4 8.6 20.4 20.5L58 100H2l2.2-39.5C6.2 48.6 14.6 41.8 24.6 40v-4.7C20.6 33.1 17 27.9 17 20.5 17 11 22.4 5 30 5z"
        fill={`url(#${id})`}
        opacity="0.9"
      />
    </svg>
  );
}

// ── the component ───────────────────────────────────────────────────────────

export function RoomAvatar(props: RoomAvatarProps): React.ReactElement {
  const { slot, characterId, name, use = 'auto', portrait = null, facepack, speaking = false, levelRef, emotion = null, busy = false, motion = {}, camera, walkOffSignal, walkOffAwayMs } = props;
  const stageRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const [resolved, setResolved] = useState<Resolved | null>(null);
  const [failed, setFailed] = useState<ReadonlySet<RoomAvatarKind>>(() => new Set());
  const [phase, setPhase] = useState<IdlePhase>('seated');
  const [importRev, setImportRev] = useState(0);
  const portraitUrl = useMemo(() => portraitSrc(portrait), [portrait]);
  const cb = useRef(props);
  cb.current = props;

  // A new character, choice or source starts the fallback chain over.
  useEffect(() => {
    setFailed(new Set());
  }, [characterId, use, facepack, portraitUrl]);

  useEffect(() => {
    let dead = false;
    void resolveKind(characterId, use, facepack, portraitUrl, failed).then((r) => {
      if (dead) return;
      setResolved((prev) => (prev && prev.kind === r.kind && prev.packId === r.packId ? prev : r));
    });
    return () => {
      dead = true;
    };
  }, [characterId, use, facepack, portraitUrl, failed, importRev]);

  // An import or removal of her model re-resolves (AvatarView swaps live2d/rig itself).
  useEffect(() => {
    let off: (() => void) | undefined;
    try {
      off = sei?.onAvatarManifest?.((u) => {
        if (u.characterId === characterId) setImportRev((n) => n + 1);
      });
    } catch {
      off = undefined;
    }
    return () => off?.();
  }, [characterId]);

  useEffect(() => {
    if (resolved) cb.current.onKind?.(resolved.kind);
  }, [resolved]);

  const fail = useCallback((kind: RoomAvatarKind) => {
    setFailed((f) => (f.has(kind) ? f : new Set([...f, kind])));
  }, []);
  const onViewStatus = useCallback(
    (kind: RoomAvatarKind) => (s: 'loading' | 'ready' | 'error') => {
      if (s === 'error') fail(kind);
    },
    [fail],
  );

  const kind = resolved?.kind ?? null;
  const onPhase = useCallback((p: IdlePhase) => {
    setPhase(p);
    cb.current.onPhase?.(p);
  }, []);
  const { forceWalk } = useIdleMotion(stageRef, bodyRef, {
    fps: slot.fps,
    busy,
    speaking,
    height: slot.height,
    enabled: motion !== false && !reduced,
    config: motion === false ? {} : motion,
    bounce: kind === 'portrait' || kind === 'placeholder',
    levelRef,
    onPhase,
  });

  const lastSignal = useRef(walkOffSignal);
  useEffect(() => {
    if (walkOffSignal === undefined || walkOffSignal === lastSignal.current) return;
    lastSignal.current = walkOffSignal;
    forceWalk(walkOffAwayMs);
  }, [walkOffSignal, walkOffAwayMs, forceWalk]);

  const away = phase === 'away';
  // Away, nothing of her is on screen: her view stops drawing too.
  const viewFps = away ? 0 : slot.fps;
  const h = slot.height;
  const figH = h * (1 + SINK);

  let figW = figH * 0.75;
  let view: React.ReactNode = null;
  if (kind === 'live2d' || kind === 'rig') {
    figW = figH * 1.1;
    view = (
      <AvatarView
        characterId={characterId}
        speaking={speaking}
        levelRef={levelRef}
        emotion={emotion}
        camera={camera ?? BUST_CAMERA}
        fps={viewFps}
        className={styles.fill}
        onStatus={onViewStatus(kind)}
      />
    );
  } else if (kind === 'facepack') {
    figW = figH * 1.15;
    view = (
      <FacepackView
        characterId={characterId}
        source={facepack ?? null}
        packId={resolved?.packId ?? null}
        speaking={speaking}
        levelRef={levelRef}
        expression={emotion}
        fps={viewFps}
        className={styles.fill}
        onStatus={onViewStatus('facepack')}
      />
    );
  } else if (kind === 'portrait' && portraitUrl) {
    view = <PortraitFigure url={portraitUrl} height={figH} name={name} onError={() => fail('portrait')} />;
    figW = 0; // sized by the image
  } else if (kind === 'placeholder') {
    view = <Silhouette height={figH} time={slot.time} />;
    figW = figH * 0.6;
  }

  // The stage is as wide as a seated figure so the slot box centres on her.
  const stageW = Math.max(h * 0.5, figW || h * 0.75);
  return (
    <div
      ref={stageRef}
      className={styles.stage}
      style={{ width: stageW, height: h }}
      role="img"
      aria-label={name}
      data-avatar-kind={kind ?? 'loading'}
      data-avatar-phase={phase}
    >
      <div ref={bodyRef} className={away ? `${styles.body} ${styles.away}` : styles.body}>
        <div className={styles.figure} style={{ bottom: -h * SINK, height: figH, width: figW || undefined, filter: TIME_GRADE[slot.time] }}>
          {view}
        </div>
      </div>
    </div>
  );
}
