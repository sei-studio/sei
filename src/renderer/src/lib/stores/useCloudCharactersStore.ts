/**
 * useCloudCharactersStore — renderer-side cache of the signed-in user's cloud
 * character UUID set.
 *
 * Drives the "LOCAL ONLY" chip on CharacterCard (Plan 11-17, requirement
 * LIB-04): a character is "local only" when authState.kind === 'signed_in'
 * AND character.is_default === false AND character.id is NOT in `cloudIds`.
 *
 * Lifecycle:
 *   - `refresh()` invokes IpcChannel.chars.listCloud and overwrites `cloudIds`.
 *     The main handler returns { ids: [] } for signed-out users and for any
 *     listMyCharacters failure, so this call is safe to fire unconditionally.
 *   - App.tsx triggers `refresh()` on every transition into signed_in (the
 *     post-sign-up migration upload, the user signing back in on a fresh
 *     machine, etc.). Wiring lives in App.tsx alongside subscribeAuthState.
 *   - Plan 11-18's migration upload should also call `refresh()` after each
 *     successful upload so chips vanish without the user reloading.
 *
 * Sources:
 *   - 11-17-PLAN.md Task 1
 *   - 11-CONTEXT §D-19 (cache-on-demand; no eager prefetch on sign-in)
 *   - 11-CONTEXT §specifics: "subtle gray pill, not a warning color"
 */

import { create } from 'zustand';
import { sei } from '../ipcClient';

interface CloudCharactersState {
  /**
   * UUID set of the signed-in user's cloud-backed characters. Empty when
   * signed_out (main handler short-circuits) or on transient list failure.
   * Lookups are O(1) via Set.has(id).
   */
  cloudIds: Set<string>;
  /**
   * Flips true after the first `refresh()` resolves (success OR empty
   * fallback). CharacterCard gates chip rendering on this so the chip
   * never lights up during the brief window between mount and the first
   * IPC response — otherwise every user-created character would briefly
   * flash "LOCAL ONLY" while the snapshot is in flight.
   */
  initialized: boolean;
}

interface CloudCharactersActions {
  /**
   * Pull a fresh cloud-id set from main and overwrite local state. Safe to
   * call repeatedly. The main handler returns `{ ids, ok }` where ok=false
   * signals a listMyCharacters failure (HR-01); on ok=false we PRESERVE the
   * prior cloudIds + initialized values so a transient outage does not flash
   * every user-created character as LOCAL ONLY. On ok=true we overwrite
   * cloudIds and flip initialized=true.
   */
  refresh: () => Promise<void>;
  /** Selector helper — O(1) membership test for the "local only" predicate. */
  isLocalOnly: (id: string) => boolean;
}

export const useCloudCharactersStore = create<
  CloudCharactersState & CloudCharactersActions
>((set, get) => ({
  cloudIds: new Set<string>(),
  initialized: false,

  refresh: async (): Promise<void> => {
    try {
      const r = await sei.charsListCloud();
      if (r.ok) {
        set({ cloudIds: new Set(r.ids), initialized: true });
      }
      // r.ok === false → keep the prior cloudIds + initialized values. If this
      // is the first refresh, `initialized` stays false and CharacterCard's
      // chip predicate short-circuits to false (no chip), which is the safe
      // default during a transient cloud outage. If a prior refresh succeeded,
      // the cached set carries forward until the next successful refresh.
    } catch {
      // Defensive — sei.charsListCloud is wired to swallow on main side, but
      // a contextBridge / preload-time failure could still surface here. Same
      // treatment as ok:false above: preserve prior state so the chip doesn't
      // light up on every char during a transient failure.
    }
  },

  isLocalOnly: (id: string): boolean => !get().cloudIds.has(id),
}));
