/**
 * useLibraryStateStore — per-user library visibility state.
 *
 * Tracks two parallel sets keyed by character UUID:
 *   - removedDefaultIds: bundled defaults (sui/lyra/clawd) the user has
 *     "removed from library". Hidden from Home + IconRail; their on-disk JSON
 *     stays so the World tab can still render them as system-authored.
 *   - addedWorldIds: non-default foreign-owned characters the user explicitly
 *     added from the World tab. Normally HomeGrid hides chars with
 *     owner !== currentUserId; this set opts them back in so Home reflects
 *     what the user added.
 *
 * Both surfaces drive:
 *   - HomeGrid + IconRail filtering.
 *   - WorldGrid's `inMyLibrary` pill swap.
 *   - CharacterPage Summon CTA copy for removed/added states.
 *
 * Source of truth lives in UserConfig (removed_default_ids, added_world_ids);
 * this store reads via sei.getConfig on init and is refreshed by the renderer
 * after each add / remove / restore action.
 */

import { create } from 'zustand';
import { sei } from '../ipcClient';

interface LibraryStateStore {
  removedDefaultIds: Set<string>;
  addedWorldIds: Set<string>;
  /**
   * 260703 procgen — bundled defaults the user has EXPLICITLY invited into a
   * Home slot (UserConfig.added_default_ids). Semantics are inverted from
   * removedDefaultIds: defaults now live in the World tab and are hidden from
   * Home UNLESS their id appears here. The Home slot grid consults this set;
   * the legacy removedDefaultIds is retained for the World "in library" pill.
   */
  addedDefaultIds: Set<string>;
  initialized: boolean;
  refresh: () => Promise<void>;
}

export const useLibraryStateStore = create<LibraryStateStore>((set) => ({
  removedDefaultIds: new Set<string>(),
  addedWorldIds: new Set<string>(),
  addedDefaultIds: new Set<string>(),
  initialized: false,
  refresh: async () => {
    try {
      const cfg = await sei.getConfig();
      const removed = new Set<string>(cfg.removed_default_ids ?? []);
      const added = new Set<string>(cfg.added_world_ids ?? []);
      const addedDefaults = new Set<string>(cfg.added_default_ids ?? []);
      set({
        removedDefaultIds: removed,
        addedWorldIds: added,
        addedDefaultIds: addedDefaults,
        initialized: true,
      });
    } catch {
      set({ initialized: true });
    }
  },
}));
