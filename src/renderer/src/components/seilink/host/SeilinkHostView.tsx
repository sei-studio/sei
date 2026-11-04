/**
 * SeiLink room host page (261104, milestone 3): the companion's room, full
 * screen, drawn as the desktop wallpaper by the room host process.
 *
 * Talks only to `window.seiRoomHost` (src/preload/seilinkHost.ts):
 * - in: her room (on start, after every save, when her portrait changes),
 *   the frame cap (0 while covered, locked or asleep), pokes (clicks on her),
 *   busy (chatting with her);
 * - out: her box (the click area), frames drawn, the first frame.
 *
 * The avatar goes through the mount point in hostAvatar.tsx.
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { seilinkResolver } from '@shared/seilinkPack';
import type { SeilinkBox, SeilinkHostRoom } from '@shared/seilinkHost';
import { RoomCanvas, type RoomAvatarSlot } from '../RoomCanvas';
import { roomAvatarUse } from '../RoomAvatar';
import { HostAvatar, type HostAvatarPoke } from './hostAvatar';
import styles from './SeilinkHost.module.css';

const FRAMES_REPORT_MS = 500;
/** She moves (idle motion, a walk off): re-measure her click area this often. */
const BOX_POLL_MS = 250;

function sameBox(a: SeilinkBox | null, b: SeilinkBox | null): boolean {
  if (!a || !b) return a === b;
  return Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1 && Math.abs(a.w - b.w) < 1 && Math.abs(a.h - b.h) < 1;
}

export function SeilinkHostView(): React.ReactElement {
  const bridge = window.seiRoomHost;
  const [room, setRoom] = useState<SeilinkHostRoom | null>(null);
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
    ];
    bridge.ready();
    return () => offs.forEach((off) => off());
  }, [bridge]);

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
      />
    </div>
  );

  const pack = room?.pack ?? null;
  const resolveUrl = useMemo(() => (pack ? seilinkResolver(pack) : null), [pack]);

  if (!room) return <div className={styles.root} />;

  if (!pack || !resolveUrl) return <FallbackRoom fps={fps} renderAvatar={renderAvatar} onReady={onSceneReady} />;

  return (
    <div className={styles.root}>
      <RoomCanvas
        manifest={pack.manifest}
        state={room.state}
        resolveUrl={resolveUrl}
        fit="cover"
        fps={fps}
        avatar={renderAvatar}
        onReady={onSceneReady}
      />
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
