/**
 * SeiLink room host page (261104, milestone 3): the companion's room, full
 * screen, drawn as the desktop wallpaper by the room host process.
 *
 * Talks only to `window.seiRoomHost` (src/preload/seilinkHost.ts):
 * - in: her room (on start, after every save, when her portrait changes),
 *   the frame cap (0 while covered, locked or asleep), pokes (clicks on her),
 *   busy (chatting with her);
 * - out: her box (the click area), frames drawn, the first frame.
 * - M4: the dock (HostDock: its buttons join the click area, the host says
 *   which was pressed, the page answers with the action), her lines (a
 *   bubble above her head while her mouth moves), the work area (where the
 *   dock sits) and the app language.
 * - 261105: her face for a line (`emotion` / `face` on the line, set by main
 *   from the line's face tag or its words), held while the bubble is up.
 *
 * The avatar goes through the mount point in hostAvatar.tsx.
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { seilinkResolver, type RoomUrlResolver, type SeilinkPack } from '@shared/seilinkPack';
import {
  isSeilinkDockOffer,
  type SeilinkBox,
  type SeilinkDockAction,
  type SeilinkDockButton,
  type SeilinkDockOffer,
  type SeilinkHostBridge,
  type SeilinkHostLayout,
  type SeilinkHostLine,
  type SeilinkHostRoom,
} from '@shared/seilinkHost';
import { roomViewport, type RoomOverlay } from '@shared/seilinkDraw';
import { isUiLanguage, uiLanguageForLocale } from '@shared/uiLanguage';
import { useLangStore } from '../../../lib/i18n';
import { RoomCanvas, type RoomAvatarSlot } from '../RoomCanvas';
import { bubbleMs, HostBubble, HostDock, speakMs, type DockPress } from './HostDock';
import { roomAvatarUse } from '../RoomAvatar';
import { HostAvatar, type HostAvatarPoke } from './hostAvatar';
import { lineFaceHoldMs, NEUTRAL_LOOK, toNeutral, type HostAvatarLook } from './hostLook';
import styles from './SeilinkHost.module.css';

const FRAMES_REPORT_MS = 500;
/** She moves (idle motion, a walk off): re-measure her click area this often. */
const BOX_POLL_MS = 250;

function sameBox(a: SeilinkBox | null, b: SeilinkBox | null): boolean {
  if (!a || !b) return a === b;
  return Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1 && Math.abs(a.w - b.w) < 1 && Math.abs(a.h - b.h) < 1;
}

function hexTriple(hex: string): string {
  const n = parseInt(hex.replace('#', ''), 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

export interface SeilinkHostViewProps {
  /** Dev preview: a fake bridge (the real page uses window.seiRoomHost). */
  bridge?: SeilinkHostBridge;
  /** Dev preview: pack URLs over HTTP instead of sei-room://. */
  resolveFor?: (pack: SeilinkPack) => RoomUrlResolver;
  /** Dev preview / screenshots: move out already asking. */
  initialConfirm?: boolean;
  /** Dev preview / screenshots: the decorate-together offer already up. */
  initialOffer?: SeilinkDockOffer;
}

export function SeilinkHostView(props: SeilinkHostViewProps = {}): React.ReactElement {
  const bridge = props.bridge ?? window.seiRoomHost;
  const [room, setRoom] = useState<SeilinkHostRoom | null>(null);
  const [layout, setLayout] = useState<SeilinkHostLayout | null>(null);
  const [deafened, setDeafened] = useState(false);
  const [offer, setOffer] = useState<SeilinkDockOffer>(props.initialOffer ?? 'none');
  const [dockPress, setDockPress] = useState<DockPress | null>(null);
  const [line, setLine] = useState<SeilinkHostLine | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const [look, setLook] = useState<HostAvatarLook>(NEUTRAL_LOOK);
  const [herBox, setHerBox] = useState<SeilinkBox | null>(null);
  const [overlay, setOverlay] = useState<RoomOverlay | null>(null);
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [fps, setFps] = useState(0);
  const [busy, setBusy] = useState(false);
  const [poke, setPoke] = useState<HostAvatarPoke | null>(null);
  const frames = useRef(0);
  const sceneReady = useRef(false);
  const firstSent = useRef(false);
  const fpsRef = useRef(0);
  fpsRef.current = fps;

  useEffect(() => {
    if (!bridge) return;
    const offs = [
      bridge.onRoom((r) => {
        setRoom(r);
        // A new scene draws afresh: report its first frame again.
        sceneReady.current = !r.pack;
        firstSent.current = false;
      }),
      bridge.onFps(setFps),
      bridge.onBusy(setBusy),
      bridge.onPoke((kind) => setPoke((p) => ({ kind, n: (p?.n ?? 0) + 1 }))),
      bridge.onLayout?.((l) => setLayout(l)) ?? (() => {}),
      bridge.onDockState?.((st) => {
        setDeafened(st.deafened === true);
        setOffer(isSeilinkDockOffer(st.offer) ? st.offer : 'none');
      }) ?? (() => {}),
      bridge.onDockPress?.((id) => setDockPress((p) => ({ id, n: (p?.n ?? 0) + 1 }))) ?? (() => {}),
      bridge.onLine?.((l) => setLine(l)) ?? (() => {}),
    ];
    bridge.ready();
    return () => offs.forEach((off) => off());
  }, [bridge]);

  // The dock and the bubble speak the app's language (no setting: the system's).
  const uiLanguage = room?.uiLanguage;
  useEffect(() => {
    const lang = isUiLanguage(uiLanguage) ? uiLanguage : (uiLanguageForLocale(navigator.language) ?? 'en');
    useLangStore.getState().setLang(lang);
  }, [uiLanguage]);

  useEffect(() => {
    const on = (): void => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);

  // Her line: the bubble stays up long enough to read; her mouth moves for the first part.
  // 261105: her face follows the line (hostLook.ts): the Live2D emotion while she says it (the model
  // lingers on it for half the line, as on a call), the face set's word until her face goes back.
  useEffect(() => {
    if (!line) return;
    setSpeaking(true);
    if (line.emotion || line.face) setLook((l) => ({ emotion: line.emotion ?? null, face: line.face ?? l.face, seq: l.seq + 1 }));
    const a = setTimeout(() => {
      setSpeaking(false);
      setLook((l) => (l.emotion ? { ...l, emotion: null } : l));
    }, speakMs(line.text));
    const b = setTimeout(() => setLine((l) => (l === line ? null : l)), bubbleMs(line.text));
    const c = setTimeout(() => setLook(toNeutral), lineFaceHoldMs(line.text));
    return () => {
      clearTimeout(a);
      clearTimeout(b);
      clearTimeout(c);
    };
  }, [line]);
  // A covered room drops the bubble (nobody can read it, and it would wait there), and her face with it.
  useEffect(() => {
    if (fps > 0) return;
    setLine(null);
    setSpeaking(false);
    setLook(toNeutral);
  }, [fps]);

  const onDockAction = useCallback((action: SeilinkDockAction) => bridge?.dockAction?.(action), [bridge]);
  const onDockButtons = useCallback((buttons: SeilinkDockButton[] | null) => bridge?.setDock?.(buttons), [bridge]);

  const maybeFirstFrame = useCallback(() => {
    if (!sceneReady.current || firstSent.current) return;
    firstSent.current = true;
    bridge?.firstFrame();
  }, [bridge]);

  // Frame ticker at the cap; stopped (a still picture) at 0.
  useEffect(() => {
    if (fps <= 0) return;
    let raf = 0;
    let last = 0;
    const step = (t: number): void => {
      if (t - last >= 1000 / fps - 2) {
        last = t;
        frames.current++;
        maybeFirstFrame();
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [fps, maybeFirstFrame]);

  useEffect(() => {
    if (!bridge) return;
    const id = setInterval(() => bridge.frames(frames.current), FRAMES_REPORT_MS);
    return () => clearInterval(id);
  }, [bridge]);

  const onSceneReady = useCallback(() => {
    sceneReady.current = true;
    // Covered at start: the still picture is the first frame.
    if (fpsRef.current <= 0 || frames.current > 0) maybeFirstFrame();
  }, [maybeFirstFrame]);

  // ── Her click area: the box of what the avatar renders ──
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const lastBox = useRef<SeilinkBox | null>(null);
  const measure = useCallback(() => {
    const wrap = wrapRef.current;
    let next: SeilinkBox | null = null;
    if (wrap) {
      const el = (wrap.querySelector('[data-seilink-hit]') as HTMLElement | null) ?? wrap;
      const r = el.getBoundingClientRect();
      // Hidden (she walked out of the frame): no click area, the desktop gets the clicks.
      if (r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden') next = { x: r.left, y: r.top, w: r.width, h: r.height };
    }
    if (sameBox(next, lastBox.current)) return;
    lastBox.current = next;
    setHerBox(next);
    bridge?.setBox(next);
  }, [bridge]);

  const setWrap = useCallback(
    (el: HTMLDivElement | null) => {
      wrapRef.current = el;
      measure();
    },
    [measure],
  );

  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const ro = new ResizeObserver(() => measure());
    if (wrap) ro.observe(wrap);
    window.addEventListener('resize', measure);
    const id = setInterval(measure, BOX_POLL_MS);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
      clearInterval(id);
    };
  });

  const characterId = room?.characterId ?? '';
  const avatarChoice = room?.state.avatar;
  const use = useMemo(() => (avatarChoice ? roomAvatarUse(avatarChoice) : 'sei'), [avatarChoice]);
  const renderAvatar = (slot: RoomAvatarSlot): React.ReactNode => (
    <div ref={setWrap} className={styles.measure}>
      <HostAvatar
        characterId={characterId}
        name={room?.name ?? ''}
        slot={slot}
        fps={fps}
        portrait={room?.portrait ?? null}
        use={use}
        busy={busy}
        poke={poke}
        speaking={speaking}
        emotion={look.emotion}
        face={look.face}
        faceSeq={look.seq}
      />
    </div>
  );

  const pack = room?.pack ?? null;
  const resolveFor = props.resolveFor;
  const resolveUrl = useMemo(() => (pack ? (resolveFor ?? seilinkResolver)(pack) : null), [pack, resolveFor]);

  if (!room) return <div className={styles.root} />;

  // M4: the dock beside her, above the taskbar / Dock; her line above her head.
  const workArea = layout?.workArea ?? { x: 0, y: 0, w: size.w, h: size.h };
  const anchorX = pack
    ? (() => {
        const vp = roomViewport(pack.manifest.canvas, size.w, size.h, 'cover');
        return vp.left + pack.manifest.avatar.x * vp.scale;
      })()
    : size.w * 0.72;
  const ov = overlay ?? { color: pack?.manifest.overlay?.day ?? '#25304f', ink: pack ? '#1d1b22' : '#f4f1ee', light: Boolean(pack) };
  const tint = { '--ov': hexTriple(ov.color), '--ink': hexTriple(ov.ink) } as React.CSSProperties;
  const chrome = (
    <>
      {line && herBox ? <HostBubble key={line.id} text={line.text} her={herBox} workArea={workArea} /> : null}
      {layout || props.bridge ? (
        <HostDock
          workArea={workArea}
          her={herBox}
          anchorX={anchorX}
          deafened={deafened}
          offer={offer}
          name={room.name}
          press={dockPress}
          onAction={onDockAction}
          onButtons={onDockButtons}
          initialConfirm={props.initialConfirm}
        />
      ) : null}
    </>
  );

  if (!pack || !resolveUrl) {
    return (
      <div className={styles.root} style={tint}>
        <FallbackRoom fps={fps} renderAvatar={renderAvatar} onReady={onSceneReady} />
        {chrome}
      </div>
    );
  }

  return (
    <div className={styles.root} style={tint}>
      <RoomCanvas
        manifest={pack.manifest}
        state={room.state}
        resolveUrl={resolveUrl}
        fit="cover"
        fps={fps}
        avatar={renderAvatar}
        onReady={onSceneReady}
        onOverlay={setOverlay}
      />
      {chrome}
    </div>
  );
}

/** No pack installed for her preset yet: a plain backdrop with her in it. */
function FallbackRoom(props: {
  fps: number;
  renderAvatar: (slot: RoomAvatarSlot) => React.ReactNode;
  onReady(): void;
}): React.ReactElement {
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const on = (): void => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  const { onReady } = props;
  useEffect(() => {
    onReady();
  }, [onReady]);
  const slot: RoomAvatarSlot = { x: size.w * 0.72, y: size.h * 0.86, height: size.h * 0.4, scale: 1, time: 'night', fps: props.fps };
  return (
    <div className={styles.root}>
      <div className={styles.fallback} />
      <div className={styles.fallbackSlot} style={{ left: slot.x, top: slot.y, height: slot.height }}>
        {props.renderAvatar(slot)}
      </div>
    </div>
  );
}
