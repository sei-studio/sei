/**
 * Anima face sets (261105): a companion's baked facepack, made in the cloud
 * from her portrait the first time SeiLink opens for her (sei-proxy
 * /anima/v1/*, baked on Modal), then kept on disk. See src/main/anima/.
 *
 * Shared between main and the renderer: the pack id shape, and the small
 * status the renderer shows ("Preparing {name}'s look...").
 */

/** A downloaded pack's id: `an-` + the first 32 hex of its archive sha256. Fits facepackStore's id rule. */
export const ANIMA_PACK_ID_RE = /^an-[0-9a-f]{32}$/;

export function animaPackId(packSha256: string): string {
  return `an-${packSha256.slice(0, 32)}`;
}

export function isAnimaPackId(id: unknown): id is string {
  return typeof id === 'string' && ANIMA_PACK_ID_RE.test(id);
}

/**
 * What the renderer needs to know, nothing more:
 *  - preparing: a bake is queued or running, or the pack is downloading;
 *  - ready: her face set is on disk (RoomAvatar picks it up by itself);
 *  - idle: anything else (never asked, signed out, offline, no pack for this
 *    portrait, deferred, failed). The fallback avatar stays and nothing is shown.
 */
export type AnimaUiState = 'idle' | 'preparing' | 'ready';

export interface AnimaStatus {
  characterId: string;
  state: AnimaUiState;
}

/** What opened SeiLink for her (analytics only). */
export type AnimaTrigger = 'move_in_sheet' | 'editor' | 'host_start' | 'host_restore' | 'portrait_changed';

export const ANIMA_TRIGGERS: readonly AnimaTrigger[] = ['move_in_sheet', 'editor', 'host_start', 'host_restore', 'portrait_changed'];

/** The avatar kinds RoomAvatar can show (RoomAvatarKind), for the `shown` analytics event. */
export const ANIMA_SHOWN_KINDS = ['live2d', 'rig', 'facepack', 'portrait', 'placeholder'] as const;
export type AnimaShownKind = (typeof ANIMA_SHOWN_KINDS)[number];

export function isAnimaShownKind(v: unknown): v is AnimaShownKind {
  return typeof v === 'string' && (ANIMA_SHOWN_KINDS as readonly string[]).includes(v);
}
