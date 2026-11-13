/**
 * useFactorioStore (261113): renderer mirror of the Factorio setup state.
 * Main owns the truth (src/main/games/factorio); this store caches what the
 * launch panel and the setup modal body show and forwards the two actions
 * (add the Sei mod, start Factorio with the Sei link) over the factorio:*
 * channels. Contract: src/shared/factorioIpc.ts.
 */
import { create } from 'zustand';
import type { FactorioActionFailure, FactorioActionResult, FactorioSetupState } from '@shared/factorioIpc';
import { sei } from '../../lib/ipcClient';

interface FactorioApi {
  factorioSetupState(): Promise<FactorioSetupState>;
  factorioInstall(): Promise<FactorioActionResult>;
  factorioLaunch(): Promise<FactorioActionResult>;
}

/** The preload members may not exist in an older build; one narrow cast. */
function api(): Partial<FactorioApi> {
  return sei as unknown as Partial<FactorioApi>;
}

export interface FactorioFailure {
  action: 'install' | 'launch';
  reason: FactorioActionFailure;
  /** Main's developer text (English, shown in a mono line under the copy). */
  message: string;
}

interface FactorioStoreState {
  setup: FactorioSetupState | null;
  installBusy: boolean;
  launching: boolean;
  /** The last action's failure, cleared by the next action or a fixing refresh. */
  failure: FactorioFailure | null;
  /** This app run started Factorio with the link (the launch step reads it). */
  launchedAt: number | null;
  refresh: () => Promise<FactorioSetupState | null>;
  runInstall: () => Promise<FactorioActionResult | null>;
  launchGame: () => Promise<FactorioActionResult | null>;
}

/**
 * A detection pass never clears a failure on its own unless it shows the
 * thing that failed is now fixed, so the 3 s poll does not wipe the line
 * before it can be read (the DST lesson, 260925).
 */
export function failureAfterRefresh(failure: FactorioFailure | null, s: FactorioSetupState): FactorioFailure | null {
  if (!failure) return null;
  if (s.kind === 'not_found') return failure.reason === 'not_found' ? failure : null;
  switch (failure.reason) {
    case 'not_found':
      return null;
    case 'unsupported_version':
      return s.install.supported === false ? failure : null;
    case 'game_running':
      return s.gameRunning === true ? failure : null;
    case 'mod_missing':
      return s.modInstalled ? null : failure;
    default:
      return failure;
  }
}

export const useFactorioStore = create<FactorioStoreState>((set, get) => {
  const applyResult = (action: FactorioFailure['action'], r: FactorioActionResult): void => {
    if (r.ok) {
      set({ setup: r.state, failure: null, ...(action === 'launch' ? { launchedAt: Date.now() } : {}) });
    } else {
      set({ failure: { action, reason: r.reason, message: r.message }, ...(r.state ? { setup: r.state } : {}) });
    }
  };
  return {
    setup: null,
    installBusy: false,
    launching: false,
    failure: null,
    launchedAt: null,
    async refresh() {
      const fn = api().factorioSetupState;
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
    async runInstall() {
      const fn = api().factorioInstall;
      if (!fn || get().installBusy || get().launching) return null;
      set({ installBusy: true, failure: null });
      try {
        const r = await fn();
        applyResult('install', r);
        return r;
      } catch (err) {
        set({ failure: { action: 'install', reason: 'failed', message: (err as Error)?.message ?? String(err) } });
        return null;
      } finally {
        set({ installBusy: false });
      }
    },
    async launchGame() {
      const fn = api().factorioLaunch;
      if (!fn || get().installBusy || get().launching) return null;
      set({ launching: true, failure: null });
      try {
        const r = await fn();
        applyResult('launch', r);
        return r;
      } catch (err) {
        set({ failure: { action: 'launch', reason: 'failed', message: (err as Error)?.message ?? String(err) } });
        return null;
      } finally {
        set({ launching: false });
      }
    },
  };
});
