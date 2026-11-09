/**
 * SeiLink desktop host: THE AVATAR MOUNT POINT (261104, milestone 3).
 *
 * The wallpaper page (SeilinkHostView) renders `<HostAvatar>` in the room's
 * avatar slot (RoomCanvas: anchored bottom centre at the manifest's avatar
 * point, `slot.height` CSS px tall). HostAvatar is RoomAvatar
 * (components/seilink/RoomAvatar.tsx: her imported model, else her face set,
 * else her portrait cut out, else a silhouette, with the idle motion). To
 * draw something else, point `HostAvatar` at another component with these
 * props; nothing else changes.
 *
 * Contract:
 * - Render her at `slot.height` tall (her feet at the bottom edge of what you
 *   render). Width is yours.
 * - `slot.fps` (= `fps`) is the frame cap: run your animation at most that
 *   often, and hold still (no rAF loop at all) at 0. 0 means covered, locked
 *   or asleep.
 * - Her CLICK AREA is the box of the element marked `data-seilink-hit`
 *   (first one found), else the box of everything you render. The page
 *   measures it about 4 times a second and sends it to the host (Windows:
 *   the raw-input hit test; macOS: the hit panel). Keep it to her body:
 *   clicks outside it go to the desktop as usual. An element that is
 *   `visibility: hidden` (she walked out of the frame) counts as no area.
 * - `busy`: the player is chatting with her (main says so) or just clicked
 *   her. Hold her in her seat.
 * - `poke` changes on every click on her (`n` counts up). 'click' also opens
 *   her chat in Sei; 'dblclick' asks her for a short reply (M4,
 *   desktopLines.ts in main); 'drag' is a stroke across her (macOS only for
 *   now).
 * - `speaking` (M4): one of her lines is on screen as a bubble. Move her
 *   mouth and hold her in her seat. No audio plays in the host, so there is
 *   no real level: RoomAvatarHost makes a soft syllable envelope.
 * - `voice` / `voiceLevel` (261110): her voice is playing in a call in Sei's
 *   main window. `voice` is true while she talks; `voiceLevel.current` is the
 *   latest audio level (0..1) and when it came (performance.now()). A fresh
 *   level (under VOICE_LEVEL_FRESH_MS old, hostLook.ts) drives her mouth; else the
 *   syllable envelope does.
 * - `pressSeq` (261110): counts up the moment a button goes down on her,
 *   before the click is classified. RoomAvatarHost answers with a short
 *   squash so the tap feels seen.
 * - `emotion` / `face` / `faceSeq` (261105): her face for the line she is
 *   saying (hostLook.ts): `emotion` for an imported Live2D model while she
 *   says it, `face` (a face-set word, 'neutral' when it goes back) for her
 *   face set. A figure with no face ignores them.
 * - Data comes in props. The page's `window.sei` has only the avatar calls
 *   RoomAvatar's views make (avatarGet, avatarModelFiles, onAvatarManifest,
 *   facepackForCharacter, facepackManifest, facepackFile), relayed to main
 *   for this character only (src/preload/seilinkHost.ts).
 */
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AvatarEmotion } from '@shared/ipc';
import type { RoomAvatarSlot } from '../RoomCanvas';
import type { SeilinkPokeKind } from '@shared/seilinkHost';
import { RoomAvatar, type RoomAvatarUse } from '../RoomAvatar';
import { mouthLevel, type VoiceLevel } from './hostLook';

export type { VoiceLevel } from './hostLook';

export interface HostAvatarPoke {
  kind: SeilinkPokeKind;
  /** Counts up with every poke, so the same kind twice is still a change. */
  n: number;
}

export interface HostAvatarProps {
  characterId: string;
  /** Her name (the figure's accessible name). */
  name: string;
  slot: RoomAvatarSlot;
  /** Frame cap; 0 = hold still. Same as slot.fps. */
  fps: number;
  /** Her portrait URL (SeilinkHostRoom.portrait), or null. */
  portrait: string | null;
  /** The room's avatar choice (roomAvatarUse(room.state.avatar)). */
  use: RoomAvatarUse;
  /** Chatting with her (from main). The component adds its own hold after a poke. */
  busy: boolean;
  poke: HostAvatarPoke | null;
  /** M4: a line of hers is showing (mouth moves, she holds still). */
  speaking?: boolean;
  /** 261105: the Live2D emotion of the line she is saying, else null. */
  emotion?: AvatarEmotion | null;
  /** 261105: her face set's word for the line ('neutral' once it goes back), or null before any line. */
  face?: string | null;
  /** 261105: bumped with each new face. */
  faceSeq?: number;
  /** 261110: her voice is playing in a call in the main window. */
  voice?: boolean;
  /** 261110: latest call audio level and its performance.now() time. */
  voiceLevel?: React.MutableRefObject<VoiceLevel>;
  /** 261110: counts up when a button goes down on her. */
  pressSeq?: number;
}

export type HostAvatarComponent = React.ComponentType<HostAvatarProps>;

/** How long a click on her keeps her in her seat, so she does not walk off under the cursor. */
export const POKE_HOLD_MS = 8_000;

/** RoomAvatar in the host: her figure is the click area, and a poke holds her still for a moment. */
export function RoomAvatarHost(props: HostAvatarProps): React.ReactElement {
  const { characterId, name, slot, portrait, use, busy, poke, speaking = false, emotion = null, face = null, faceSeq = 0, voice = false, voiceLevel, pressSeq = 0 } = props;
  const ref = useRef<HTMLDivElement>(null);
  const [held, setHeld] = useState(false);
  const talking = speaking || voice;
  // The syllable envelope covers a bubble line, and a call line until its first level arrives.
  const syllable = useSyllableLevel(talking && slot.fps > 0);
  const voiceRef = useRef(voiceLevel);
  voiceRef.current = voiceLevel;
  // Read once per frame by the figure: a getter, so no extra timer merges the two.
  const levelRef = useMemo<React.MutableRefObject<number>>(
    () => ({
      get current() {
        return mouthLevel(voiceRef.current?.current, syllable.current, performance.now());
      },
      set current(_v: number) {
        /* read-only */
      },
    }),
    [syllable],
  );

  // 261110: a short squash the moment a button goes down on her (feet stay put).
  useEffect(() => {
    if (pressSeq === 0 || slot.fps === 0) return;
    const fig = ref.current?.querySelector<HTMLElement>('[data-seilink-hit]');
    if (!fig || typeof fig.animate !== 'function') return;
    const anim = fig.animate(
      [
        { transform: 'scale(1, 1)' },
        { transform: 'scale(1.04, 0.95)', offset: 0.35 },
        { transform: 'scale(0.99, 1.02)', offset: 0.7 },
        { transform: 'scale(1, 1)' },
      ],
      { duration: 220, easing: 'ease-out', composite: 'add' },
    );
    fig.style.transformOrigin = '50% 100%';
    return () => anim.cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pressSeq]);

  useEffect(() => {
    if (!poke) return;
    setHeld(true);
    const id = setTimeout(() => setHeld(false), POKE_HOLD_MS);
    return () => clearTimeout(id);
  }, [poke]);

  // RoomAvatar's stage is the whole seat box (stage > body > figure); the figure is her.
  useLayoutEffect(() => {
    const fig = ref.current?.querySelector('[data-avatar-kind] > div > div');
    if (fig && !fig.hasAttribute('data-seilink-hit')) fig.setAttribute('data-seilink-hit', '');
  });

  return (
    <div ref={ref} style={{ display: 'contents' }}>
      <RoomAvatar
        slot={slot}
        characterId={characterId}
        name={name}
        portrait={portrait}
        use={use}
        busy={busy || held}
        speaking={talking}
        levelRef={levelRef}
        emotion={emotion}
        face={face}
        faceSeq={faceSeq}
      />
    </div>
  );
}

export const HostAvatar: HostAvatarComponent = RoomAvatarHost;

/** A speech-like mouth level without audio: syllables of 120-220 ms with small gaps. */
function useSyllableLevel(on: boolean): React.MutableRefObject<number> {
  const level = useRef(0);
  useEffect(() => {
    if (!on) {
      level.current = 0;
      return;
    }
    let dead = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const step = (open: boolean): void => {
      if (dead) return;
      level.current = open ? 0.35 + Math.random() * 0.5 : 0.05;
      timer = setTimeout(() => step(!open), open ? 120 + Math.random() * 100 : 50 + Math.random() * 70);
    };
    step(true);
    return () => {
      dead = true;
      if (timer) clearTimeout(timer);
      level.current = 0;
    };
  }, [on]);
  return level;
}
