/**
 * SeiLink art packs on the wire (261104, host pass). Shared by main (which
 * loads and serves packs, src/main/seilink/packs.ts) and the renderer (which
 * draws them, components/seilink/RoomCanvas.tsx).
 *
 * A pack is one directory per preset: `<root>/<presetId>/manifest.json` plus
 * the webp/png files the manifest names, by paths relative to that dir.
 * Main validates the manifest (seilinkValidate.ts), checks every referenced
 * file resolves INSIDE the pack dir after realpath, and serves exactly those
 * files over the `sei-room://` scheme:
 *
 *   sei-room://<presetId>/<relative path>?v=<rev>
 *
 * `rev` changes whenever the pack's manifest changes on disk, so a renderer
 * image cache keyed by URL never shows a stale frame after a pack update.
 */
import type { RoomPresetId, RoomPresetManifest, RoomState } from './seilinkRoom';

export const SEILINK_ROOM_SCHEME = 'sei-room';

/** Where a pack was found: the dev override dir, the installed packs dir, or the app's own (bundled). */
export type SeilinkPackSource = 'dev' | 'installed' | 'bundled';

export interface SeilinkPack {
  id: RoomPresetId;
  manifest: RoomPresetManifest;
  /** Changes when the pack changes on disk (manifest mtime, ms). */
  rev: number;
  source: SeilinkPackSource;
}

/** A companion's room as the renderer gets it: her state, plus her preset's pack when installed. */
export interface SeilinkRoomPayload {
  characterId: string;
  state: RoomState;
  /** null while the preset's pack is not installed. */
  pack: SeilinkPack | null;
  /** M4: a room was saved for her (false = the default room, never set up). */
  saved?: boolean;
}

/** Dev flag info for the preview (null fields when the flag is off). */
export interface SeilinkDevInfo {
  enabled: boolean;
  packsDir: string | null;
}

/** URL of one pack file for the renderer. `rel` must already be a validated pack path. */
export function seilinkFileUrl(pack: Pick<SeilinkPack, 'id' | 'rev'>, rel: string): string {
  const path = rel.split('/').map(encodeURIComponent).join('/');
  return `${SEILINK_ROOM_SCHEME}://${pack.id}/${path}?v=${pack.rev}`;
}

/** Resolver for RoomCanvas: pack-relative path to a loadable URL. */
export type RoomUrlResolver = (rel: string) => string;

export function seilinkResolver(pack: Pick<SeilinkPack, 'id' | 'rev'>): RoomUrlResolver {
  return (rel) => seilinkFileUrl(pack, rel);
}
