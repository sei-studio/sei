/**
 * SeiLink room source seam (261104).
 *
 * The AI side (roomContext.ts: the prompt's room line and the look() tool)
 * only needs to know, per companion, which preset she lives in, how it is set
 * up, and where the preset's art lives on disk. The room store and the pack
 * loader (branch feat/seilink-host) own all of that and implement this
 * interface; until they land, roomContext.ts has no source and every prompt
 * is unchanged.
 */
import type { RoomPresetManifest, RoomState } from '../../shared/seilinkRoom';

export interface RoomContext {
  manifest: RoomPresetManifest;
  state: RoomState;
  /** Absolute pack root. Frame `src`/`mask`/`glow` paths resolve against it. */
  packDir: string;
  /**
   * 261105: the loaded pack's files (relative path -> checked realpath), so
   * shared files (`_shared/...`) resolve where the loader found them. Absent
   * (dev stub, tests): `_shared/` resolves beside packDir.
   */
  files?: ReadonlyMap<string, string>;
}

export interface RoomSource {
  /** The companion's room, or null when she has no SeiLink room set up. May be async. */
  getRoom(characterId: string): RoomContext | null | Promise<RoomContext | null>;
  /**
   * (host, 261104) Called with a companion's id after her room state is
   * saved (the editor, the AI). Returns an unsubscribe. Pack installs will
   * call it with '*' (every companion) once downloads exist.
   * Optional so simple sources (tests, the dev stub) need not implement it.
   */
  onChange?(cb: (characterId: string) => void): () => void;
}
