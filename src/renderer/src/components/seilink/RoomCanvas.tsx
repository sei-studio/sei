/**
 * RoomCanvas (261104, SeiLink milestone 1): draws a companion's room from its
 * pack manifest + room state, per the draw rules in shared/seilinkRoom.ts.
 *
 *   <RoomCanvas
 *     manifest={pack.manifest}
 *     state={room}
 *     resolveUrl={seilinkResolver(pack)}
 *     avatar={(slot) => <Her height={slot.height} />}
 *     fps={onBattery ? 15 : 30}
 *   >
 *     {editorOverlay}
 *   </RoomCanvas>
 *
 * Layers: back canvas (everything behind her), the fx canvas (particles:
 * rain, snow, fireflies; 261105), the avatar slot (a DOM box
 * anchored at the manifest's avatar point, bottom centre, `height` tall:
 * anything can live there, a Live2D canvas, a sprite), front canvas
 * (anything in front of her), and the glow canvas, screen-blended over all of
 * them. `children` render above the room in the same box (the editor, the
 * dock), not blended.
 *
 * It fills its parent. `fit="cover"` (default, a wallpaper) crops the room to
 * fill; `"contain"` letterboxes it. Static layers are cached (RoomRenderer);
 * only animated glows redraw, at most `fps` times a second (0 = still, use it
 * when the room is covered). The avatar owns its own animation; `slot.fps`
 * passes the cap along.
 *
 * 261106 (first-link v3): a `plain` state draws no room at all, only the
 * plain background in the OS's light or dark mode (lib/seilink/plainTone.ts,
 * black or white, followed live) with her at the preset's seat; the overlay
 * tint (the dock's and the editor's glass) follows that colour.
 */
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { resolveRoomTime, type RoomPresetManifest, type RoomState, type RoomTime } from '@shared/seilinkRoom';
import { roomTimeMix, roomViewport, type RoomFit, type RoomOverlay, type RoomTimeMix, type RoomViewport } from '@shared/seilinkDraw';
import type { RoomUrlResolver } from '@shared/seilinkPack';
import { RoomRenderer } from '../../lib/seilink/roomRenderer';
import { PLAIN_COLOURS, plainOverlay, usePlainTone } from '../../lib/seilink/plainTone';
import type { RoomAssetError } from '../../lib/seilink/roomCompose';
import styles from './RoomCanvas.module.css';

/** Where her avatar goes, in CSS px of the room box (the RoomCanvas element). */
export interface RoomAvatarSlot {
  /** Bottom centre. */
  x: number;
  y: number;
  /** Her body height. */
  height: number;
  /** CSS px per canvas px. */
  scale: number;
  /** The room's time of day now (the dominant side of a crossfade). */
  time: RoomTime;
  /** The frame cap the room runs at; the avatar should honour it. */
  fps: number;
}

export interface RoomCanvasProps {
  manifest: RoomPresetManifest;
  state: RoomState;
  /** Pack-relative path to a loadable URL (seilinkResolver(pack) for sei-room://). */
  resolveUrl: RoomUrlResolver;
  fit?: RoomFit;
  /** Frame cap for effects: 30 default, 15 on battery, 0 when covered (a still picture). */
  fps?: number;
  /** Clock for state.time 'auto' (tests and previews pass a fixed one). */
  clock?: () => Date;
  /** How long a jump between times (not a clock fade) crossfades. Default 1200 ms; 0 cuts. */
  fadeMs?: number;
  /** Her avatar: a node, or a render function given the slot geometry. */
  avatar?: React.ReactNode | ((slot: RoomAvatarSlot) => React.ReactNode);
  /** UI above the room (editor, dock). Not blended. */
  children?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  onReady?(): void;
  onError?(err: RoomAssetError): void;
  /** Canvas px to CSS px of this element (the editor maps pointers with viewportToCanvas). */
  onLayout?(viewport: RoomViewport): void;
  /** Tint for UI over the room: light room, light overlay (product rule). */
  onOverlay?(overlay: RoomOverlay): void;
  /**
   * 261110: draw the room at this rect (CSS px of this element) instead of
   * filling the element: the desktop stage passes where the display sits in
   * the window (Windows stages at the work area), so the room lines up with
   * the wallpaper under it.
   */
  frame?: { x: number; y: number; width: number; height: number } | null;
}

/** How often 'auto' time re-reads the clock. A clock fade lasts 30 minutes, so this is smooth. */
const CLOCK_TICK_MS = 20_000;

export function RoomCanvas(props: RoomCanvasProps): React.ReactElement {
  const { manifest, state, resolveUrl, fit = 'cover', fps = 30, clock, fadeMs = 1200, avatar, children, className, style } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const backRef = useRef<HTMLCanvasElement>(null);
  const frontRef = useRef<HTMLCanvasElement>(null);
  const glowRef = useRef<HTMLCanvasElement>(null);
  const fxRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<RoomRenderer | null>(null);
  const [box, setBox] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [used, setUsed] = useState<{ front: boolean; glow: boolean; fx?: boolean }>({ front: false, glow: false, fx: false });
  const [mix, setMix] = useState<RoomTimeMix>(() => roomTimeMix(state, (clock ?? (() => new Date()))()));

  // Latest callbacks without re-creating the renderer.
  const cb = useRef(props);
  cb.current = props;
  // 261106: no room yet, a plain background (the renderer draws an empty scene).
  const plain = state.plain === true;
  const plainRef = useRef(plain);
  plainRef.current = plain;
  const tone = usePlainTone();

  useLayoutEffect(() => {
    const r = new RoomRenderer(
      { back: backRef.current!, front: frontRef.current!, glow: glowRef.current!, fx: fxRef.current! },
      {
        onReady: () => cb.current.onReady?.(),
        onError: (e) => {
          if (cb.current.onError) cb.current.onError(e);
          else console.warn(`[seilink] room file failed: ${e.file}: ${e.message}`);
        },
        onOverlay: (o) => {
          if (!plainRef.current) cb.current.onOverlay?.(o);
        },
        onLayersUsed: setUsed,
      },
      { fps, fadeMs },
    );
    rendererRef.current = r;
    return () => {
      r.dispose();
      rendererRef.current = null;
    };
    // The renderer lives for the component; props flow in through the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Size: follow the element.
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const read = (): void => {
      const r = el.getBoundingClientRect();
      setBox((b) => (Math.abs(b.w - r.width) < 0.5 && Math.abs(b.h - r.height) < 0.5 ? b : { w: r.width, h: r.height }));
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { frame } = props;
  const fx = frame && frame.width > 0 && frame.height > 0 ? frame : null;
  const vp = useMemo(() => {
    if (!fx || !box.w || !box.h) return roomViewport(manifest.canvas, box.w, box.h, fit);
    const v = roomViewport(manifest.canvas, fx.width, fx.height, fit);
    return { ...v, left: v.left + fx.x, top: v.top + fx.y };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifest.canvas, box.w, box.h, fit, fx?.x, fx?.y, fx?.width, fx?.height]);

  useEffect(() => {
    cb.current.onLayout?.(vp);
  }, [vp]);

  // Resolution: device px per canvas px, never above the art's own. Debounced
  // so a live window resize rescales by CSS and rebuilds once at the end.
  useEffect(() => {
    if (vp.scale <= 0) return;
    const res = Math.min(1, vp.scale * (window.devicePixelRatio || 1));
    const r = rendererRef.current;
    if (!r) return;
    if (r.resolution === 0) {
      r.setResolution(res);
      return;
    }
    const t = setTimeout(() => r.setResolution(res), 180);
    return () => clearTimeout(t);
  }, [vp.scale]);

  // A plain state: every slot empty and no items, so nothing of the room draws (her slot still comes from the manifest).
  const scene = useMemo<RoomState>(() => {
    if (!plain) return state;
    const slots: RoomState['slots'] = {};
    for (const slot of Object.keys(manifest.slots) as Array<keyof RoomState['slots']>) slots[slot] = { id: null };
    return { ...state, slots, items: [] };
  }, [plain, state, manifest]);

  useEffect(() => {
    rendererRef.current?.setScene(manifest, scene, resolveUrl);
  }, [manifest, scene, resolveUrl]);

  useEffect(() => {
    if (plain) cb.current.onOverlay?.(plainOverlay(tone));
  }, [plain, tone]);

  useEffect(() => {
    rendererRef.current?.setFps(fps);
  }, [fps]);

  useEffect(() => {
    rendererRef.current?.setFadeMs(fadeMs);
  }, [fadeMs]);

  // Time of day: fixed, or the clock (re-read on a slow tick).
  useEffect(() => {
    const now = clock ?? (() => new Date());
    const apply = (): void => {
      const m = roomTimeMix(state, now());
      setMix((prev) => (prev.from === m.from && prev.to === m.to && Math.abs(prev.t - m.t) < 1e-4 ? prev : m));
    };
    apply();
    if (state.time !== 'auto') return;
    const id = setInterval(apply, CLOCK_TICK_MS);
    return () => clearInterval(id);
  }, [state, clock]);

  useEffect(() => {
    rendererRef.current?.setMix(mix);
  }, [mix]);

  const time: RoomTime = state.time === 'auto' ? (mix.t >= 0.5 ? mix.to : mix.from) : resolveRoomTime(state);
  const slot: RoomAvatarSlot = {
    x: manifest.avatar.x * vp.scale,
    y: manifest.avatar.y * vp.scale,
    height: manifest.avatar.height * vp.scale,
    scale: vp.scale,
    time,
    fps,
  };
  const avatarNode = typeof avatar === 'function' ? avatar(slot) : avatar;

  return (
    <div
      ref={rootRef}
      className={className ? `${styles.root} ${className}` : styles.root}
      style={plain ? { background: PLAIN_COLOURS[tone], ...style } : style}
      data-plain={plain ? tone : undefined}
    >
      <div className={styles.scene} style={{ left: vp.left, top: vp.top, width: vp.width, height: vp.height }}>
        <canvas ref={backRef} className={styles.layer} />
        {/* 261105: weather and ambience particles, behind her. */}
        <canvas ref={fxRef} className={used.fx ? styles.layer : `${styles.layer} ${styles.hidden}`} data-layer="fx" />
        {avatarNode != null && (
          <div className={styles.avatar} style={{ left: slot.x, top: slot.y, height: slot.height }}>
            {avatarNode}
          </div>
        )}
        <canvas ref={frontRef} className={used.front ? styles.layer : `${styles.layer} ${styles.hidden}`} />
        <canvas ref={glowRef} className={used.glow ? `${styles.layer} ${styles.glow}` : `${styles.layer} ${styles.glow} ${styles.hidden}`} />
      </div>
      {children != null && <div className={styles.overlay}>{children}</div>}
    </div>
  );
}
