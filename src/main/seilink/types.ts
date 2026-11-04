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
}

export interface RoomSource {
  /** The companion's room, or null when she has no SeiLink room set up. May be async. */
  getRoom(characterId: string): RoomContext | null | Promise<RoomContext | null>;
  /**
   * Called with a character id whenever that companion's room (state, preset
   * or pack) changes. Returns an unsubscribe. The AI side reads the room fresh
   * on every turn, so it does not need to subscribe; the host renderer does.
   */
  onChange(listener: (characterId: string) => void): () => void;
}
