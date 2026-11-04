/**
 * SeiLink desktop host: THE AVATAR MOUNT POINT (261104, milestone 3).
 *
 * The wallpaper page (SeilinkHostView) renders `<HostAvatar>` in the room's
 * avatar slot (RoomCanvas: anchored bottom centre at the manifest's avatar
 * point, `slot.height` CSS px tall). To put the real companion on the
 * desktop, point `HostAvatar` at your component; nothing else changes:
 *
 *   import { CompanionRig } from '../avatar/CompanionRig';
 *   export const HostAvatar: HostAvatarComponent = CompanionRig;
 *
 * Contract:
 * - Render her at `slot.height` tall (her feet at the bottom edge of what you
 *   render). Width is yours.
 * - `fps` is the frame cap: run your animation at most that often, and hold
 *   still (no rAF loop at all) at 0. 0 means covered, locked or asleep.
 * - Her CLICK AREA is the bounding box of what you render, measured by the
 *   page and sent to the host (Windows: the raw-input hit test; macOS: the
 *   hit panel). For a tighter area, put `data-seilink-hit` on the element
 *   that should count; the first one found is measured instead. Keep it to
 *   her body: clicks outside it go to the desktop as usual.
 * - `poke` changes on every click on her (`n` counts up): react to it if you
 *   like (a glance, a hop). 'click' also opens her chat in Sei; 'dblclick'
 *   is reserved; 'drag' is a stroke across her (macOS only for now).
 * - The page is sandboxed with no window.sei: data comes in props only.
 */
import React from 'react';
import type { RoomAvatarSlot } from '../RoomCanvas';
import type { SeilinkPokeKind } from '@shared/seilinkHost';
import { PlaceholderAvatar } from './PlaceholderAvatar';

export interface HostAvatarPoke {
  kind: SeilinkPokeKind;
  /** Counts up with every poke, so the same kind twice is still a change. */
  n: number;
}

export interface HostAvatarProps {
  characterId: string;
  slot: RoomAvatarSlot;
  /** Frame cap; 0 = hold still. */
  fps: number;
  poke: HostAvatarPoke | null;
}

export type HostAvatarComponent = React.ComponentType<HostAvatarProps>;

/** Swap this for the real avatar (feat/seilink-motion). */
export const HostAvatar: HostAvatarComponent = PlaceholderAvatar;
