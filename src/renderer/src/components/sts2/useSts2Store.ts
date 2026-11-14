/**
 * useSts2Store (261115): renderer mirror of the Slay the Spire 2 setup state.
 * Main owns the truth (src/main/games/sts2); this store caches what the
 * launch panel and the setup modal body show and forwards the two actions
 * (add the Sei mod, start the game through Steam) over the sts2:* channels.
 * Contract: src/shared/sts2Ipc.ts.
 */
import { create } from 'zustand';
import type { Sts2ActionFailure, Sts2ActionResult, Sts2SetupState } from '@shared/sts2Ipc';
import { sei } from '../../lib/ipcClient';

interface Sts2Api {
  sts2SetupState(): Promise<Sts2SetupState>;
  sts2Install(): Promise<Sts2ActionResult>;
  sts2StartGame(): Promise<Sts2ActionResult>;
}

/** The preload members may not exist in an older build; one narrow cast. */
function api(): Partial<Sts2Api> {
  return sei as unknown as Partial<Sts2Api>;
}

export interface Sts2Failure {
  action: 'install' | 'start';
  reason: Sts2ActionFailure;
  /** Main's developer text (English, shown in a mono line under the copy). */
  message: string;
}

interface Sts2StoreState {
  setup: Sts2SetupState | null;
  installBusy: boolean;
  starting: boolean;
  /** The last action's failure, cleared by the next action or a fixing refresh. */
  failure: Sts2Failure | null;
  refresh: () => Promise<Sts2SetupState | null>;
  runInstall: () => Promise<Sts2ActionResult | null>;
  startGame: () => Promise<Sts2ActionResult | null>;
}

/**
 * A detection pass clears a failure only when it shows the thing that
 * failed is fixed, so the 3 s poll does not wipe the line before it can be
 * read (the DST lesson, 260925).
 */
export function failureAfterRefresh(failure: Sts2Failure | null, s: Sts2SetupState): Sts2Failure | null {
  if (!failure) return null;
  if (s.kind === 'not_found') return failure.reason === 'not_found' ? failure : null;
  switch (failure.reason) {
    case 'not_found':
      return null;
    case 'game_running':
      return s.gameRunning ? failure : null;
    case 'mod_missing':
      return s.modInstalled ? null : failure;
    case 'permission':
      return s.modInstalled && s.modCurrent ? null : failure;
    default:
      return failure;
  }
}

export const useSts2Store = create<Sts2StoreState>((set, get) => {
  const applyResult = (action: Sts2Failure['action'], r: Sts2ActionResult): void => {
    if (r.ok) set({ setup: r.state, failure: null });
    else set({ failure: { action, reason: r.reason, message: r.message }, ...(r.state ? { setup: r.state } : {}) });
  };
  const run = async (
    action: Sts2Failure['action'],
    fn: (() => Promise<Sts2ActionResult>) | undefined,
    flag: 'installBusy' | 'starting',
  ): Promise<Sts2ActionResult | null> => {
    if (!fn || get().installBusy || get().starting) return null;
    set({ [flag]: true, failure: null } as Partial<Sts2StoreState>);
    try {
      const r = await fn();
      applyResult(action, r);
      return r;
    } catch (err) {
      set({ failure: { action, reason: 'failed', message: (err as Error)?.message ?? String(err) } });
      return null;
    } finally {
      set({ [flag]: false } as Partial<Sts2StoreState>);
    }
  };
  return {
    setup: null,
    installBusy: false,
    starting: false,
    failure: null,
    async refresh() {
      const fn = api().sts2SetupState;
      if (!fn) return get().setup;
      try {
        const s = await fn();
        if (get().installBusy || get().starting) return s;
        set({ setup: s, failure: failureAfterRefresh(get().failure, s) });
        return s;
      } catch {
        return get().setup;
      }
    },
    runInstall: () => run('install', api().sts2Install, 'installBusy'),
    startGame: () => run('start', api().sts2StartGame, 'starting'),
  };
});
