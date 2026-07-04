/**
 * useLibraryStateStore — per-user library visibility state.
 *
 * Tracks two parallel sets keyed by character UUID:
 *   - addedDefaultIds: bundled defaults (sui/lyra/clawd) the user has invited
 *     into a Home slot (260703 procgen opt-in semantics — see below).
 *   - addedWorldIds: non-default foreign-owned characters the user explicitly
 *     added from the World tab. Normally HomeGrid hides chars with
 *     owner !== currentUserId; this set opts them back in so Home reflects
 *     what the user added.
 *
 * Both surfaces drive:
 *   - HomeGrid + IconRail filtering.
 *   - WorldGrid's `inMyLibrary` pill swap.
 *   - CharacterPage Summon CTA copy for invited/added states.
 *
 * Source of truth lives in UserConfig (added_default_ids, added_world_ids);
 * this store reads via sei.getConfig on init and is refreshed by the renderer
 * after each add / remove / restore action.
 */

import { create } from 'zustand';
import { sei } from '../ipcClient';

interface LibraryStateStore {
  addedWorldIds: Set<string>;
  /**
   * 260703 procgen — bundled defaults the user has EXPLICITLY invited into a
   * Home slot (UserConfig.added_default_ids). Defaults now live in the World
   * tab and are hidden from Home UNLESS their id appears here. Consulted by
   * HomeGrid, IconRail, WorldGrid's "in library" pill, and CharacterPage's
   * Add-to-library CTA. The legacy removed_default_ids config field is dead.
   */
  addedDefaultIds: Set<string>;
  initialized: boolean;
  refresh: () => Promise<void>;
}

export const useLibraryStateStore = create<LibraryStateStore>((set) => ({
  addedWorldIds: new Set<string>(),
  addedDefaultIds: new Set<string>(),
  initialized: false,
  refresh: async () => {
    try {
      const cfg = await sei.getConfig();
      const added = new Set<string>(cfg.added_world_ids ?? []);
      const addedDefaults = new Set<string>(cfg.added_default_ids ?? []);
      set({
        addedWorldIds: added,
        addedDefaultIds: addedDefaults,
        initialized: true,
      });
    } catch {
      set({ initialized: true });
    }
  },
}));
