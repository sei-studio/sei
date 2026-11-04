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
 *   her chat in Sei; 'dblclick' is reserved; 'drag' is a stroke across her
 *   (macOS only for now).
 * - Data comes in props. The page's `window.sei` has only the avatar calls
 *   RoomAvatar's views make (avatarGet, avatarModelFiles, onAvatarManifest,
 *   facepackForCharacter, facepackManifest, facepackFile), relayed to main
 *   for this character only (src/preload/seilinkHost.ts).
 * - Not wired yet: `speaking` / `levelRef` (her voice does not play in the
 *   host) and `emotion`.
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RoomAvatarSlot } from '../RoomCanvas';
import type { SeilinkPokeKind } from '@shared/seilinkHost';
import { RoomAvatar, type RoomAvatarUse } from '../RoomAvatar';

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
}

export type HostAvatarComponent = React.ComponentType<HostAvatarProps>;

/** How long a click on her keeps her in her seat, so she does not walk off under the cursor. */
export const POKE_HOLD_MS = 8_000;

/** RoomAvatar in the host: her figure is the click area, and a poke holds her still for a moment. */
export function RoomAvatarHost(props: HostAvatarProps): React.ReactElement {
  const { characterId, name, slot, portrait, use, busy, poke } = props;
  const ref = useRef<HTMLDivElement>(null);
  const [held, setHeld] = useState(false);

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
      <RoomAvatar slot={slot} characterId={characterId} name={name} portrait={portrait} use={use} busy={busy || held} />
    </div>
  );
}

export const HostAvatar: HostAvatarComponent = RoomAvatarHost;
