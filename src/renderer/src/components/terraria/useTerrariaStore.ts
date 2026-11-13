/**
 * useTerrariaStore (261113): renderer mirror of the Terraria setup state.
 * Main owns the truth (src/main/games/terraria); this store caches what the
 * launch panel and the setup modal body show and forwards the two actions
 * (add the Sei mod, start tModLoader) over the terraria:* channels.
 * Contract: src/shared/terrariaIpc.ts.
 */
import { create } from 'zustand';
import type { TerrariaActionFailure, TerrariaActionResult, TerrariaSetupState } from '@shared/terrariaIpc';
import { sei } from '../../lib/ipcClient';

interface TerrariaApi {
  terrariaSetupState(): Promise<TerrariaSetupState>;
  terrariaInstall(): Promise<TerrariaActionResult>;
  terrariaLaunch(): Promise<TerrariaActionResult>;
}

/** The preload members may not exist in an older build; one narrow cast. */
function api(): Partial<TerrariaApi> {
  return sei as unknown as Partial<TerrariaApi>;
}

export interface TerrariaFailure {
  action: 'install' | 'launch';
  reason: TerrariaActionFailure;
  /** Main's developer text (English, shown in a mono line under the copy). */
  message: string;
}

interface TerrariaStoreState {
  setup: TerrariaSetupState | null;
  installBusy: boolean;
  launching: boolean;
  /** The last action's failure, cleared by the next action or a fixing refresh. */
  failure: TerrariaFailure | null;
  refresh: () => Promise<TerrariaSetupState | null>;
  runInstall: () => Promise<TerrariaActionResult | null>;
  launchGame: () => Promise<TerrariaActionResult | null>;
}

/**
 * A detection pass only clears a failure when it shows the failed thing is
 * fixed, so the 3 s poll does not wipe the line before it can be read.
 */
export function failureAfterRefresh(failure: TerrariaFailure | null, s: TerrariaSetupState): TerrariaFailure | null {
  if (!failure) return null;
  if (failure.reason === 'no_tml') return s.tmlInstalled === false ? failure : null;
  if (failure.action === 'install') return s.modInstalled && s.modEnabled && s.linked ? null : failure;
  return failure;
}

export const useTerrariaStore = create<TerrariaStoreState>((set, get) => {
  const applyResult = (action: TerrariaFailure['action'], r: TerrariaActionResult): void => {
    if (r.ok) set({ setup: r.state, failure: null });
    else set({ failure: { action, reason: r.reason, message: r.message }, ...(r.state ? { setup: r.state } : {}) });
  };
  const run = async (action: TerrariaFailure['action'], fn: (() => Promise<TerrariaActionResult>) | undefined): Promise<TerrariaActionResult | null> => {
    if (!fn || get().installBusy || get().launching) return null;
    set({ [action === 'install' ? 'installBusy' : 'launching']: true, failure: null } as Partial<TerrariaStoreState>);
    try {
      const r = await fn();
      applyResult(action, r);
      return r;
    } catch (err) {
      set({ failure: { action, reason: 'failed', message: (err as Error)?.message ?? String(err) } });
      return null;
    } finally {
      set({ [action === 'install' ? 'installBusy' : 'launching']: false } as Partial<TerrariaStoreState>);
    }
  };
  return {
    setup: null,
    installBusy: false,
    launching: false,
    failure: null,
    async refresh() {
      const fn = api().terrariaSetupState;
      if (!fn) return get().setup;
      try {
        const s = await fn();
        if (get().installBusy || get().launching) return s;
        set({ setup: s, failure: failureAfterRefresh(get().failure, s) });
        return s;
      } catch {
        return get().setup;
      }
    },
    runInstall: () => run('install', api().terrariaInstall),
    launchGame: () => run('launch', api().terrariaLaunch),
  };
});
