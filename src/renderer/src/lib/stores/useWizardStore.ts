/**
 * useWizardStore — Zustand store managing the first-launch / re-runnable setup wizard.
 *
 * The renderer NEVER holds an AbortController for the wizard. Cancellation
 * crosses the IPC boundary via `sei.wizardCancel(sessionId)` — main's
 * `abortWizardSession` then fires `.abort()` on its Map<sessionId, AbortController>,
 * which propagates through signal-aware install modules to SIGTERM the in-flight
 * `java -jar fabric-installer` child process. The single source of truth for
 * cancellation lives in main; this store only owns the sessionId (renderer-generated
 * via `crypto.randomUUID()` per install run) so `cancelInstall` targets the right run.
 */

import { create } from 'zustand';
import { sei } from '../ipcClient';
import type {
  McInstall,
  WizardInstallResult,
  WizardProgressEvent,
} from '@shared/ipc';

/** Linear step machine; branch states (none-found / one-failed) don't advance the counter. */
export type WizardStep =
  | 'welcome'
  | 'detecting'
  | 'none-found'
  | 'pick'
  | 'installing'
  | 'one-failed'
  | 'done';

export interface WizardStoreState {
  open: boolean;
  step: WizardStep;
  /** True when re-running from Settings (controls Back-to-settings button on welcome step). */
  isReentry: boolean;
  installs: McInstall[];
  selectedIds: Set<string>;
  /**
   * Non-null while runWizardInstall is in flight. Lets cancelInstall
   * pass the correct id to sei.wizardCancel(sessionId). Generated per run via
   * `crypto.randomUUID()` so the matching cancel targets THIS run, not a stale one.
   */
  sessionId: string | null;
  /** Map<installId, latest WizardProgressEvent> so progress bars render the current stage. */
  progress: Map<string, WizardProgressEvent>;
  results: WizardInstallResult[];
  error: string | null;

  // ── Imperative actions ─────────────────────────────────────────────────
  openWizard: (isReentry: boolean) => void;
  closeWizard: () => void;
  gotoStep: (step: WizardStep) => void;
  runDetection: () => Promise<void>;
  toggleSelected: (id: string) => void;
  runInstall: () => Promise<void>;
  /** Async because it fires an IPC call across the process boundary. */
  cancelInstall: () => Promise<void>;
}

export const useWizardStore = create<WizardStoreState>((set, get) => {
  // Module-scoped unsubscriber for the onWizardProgress push channel. Cleared in finally
  // after runInstall settles, and in closeWizard when the wizard is dismissed mid-flight.
  let progressUnsub: (() => void) | null = null;

  return {
    open: false,
    step: 'welcome',
    isReentry: false,
    installs: [],
    selectedIds: new Set(),
    sessionId: null,
    progress: new Map(),
    results: [],
    error: null,

    openWizard: (isReentry) => {
      set({
        open: true,
        isReentry,
        step: 'welcome',
        installs: [],
        selectedIds: new Set(),
        progress: new Map(),
        results: [],
        error: null,
        sessionId: null,
      });
    },

    closeWizard: () => {
      if (progressUnsub) {
        progressUnsub();
        progressUnsub = null;
      }
      // If a wizard run is in flight, abort it via IPC (not via a
      // renderer-local AbortController). Fire-and-forget: main's handler resolves
      // immediately and the in-flight runWizardInstall promise then rejects via
      // its AbortSignal chain.
      const sid = get().sessionId;
      if (sid) {
        void sei.wizardCancel(sid).catch(() => {
          /* best-effort — main may already have cleaned up the session */
        });
      }
      set({ open: false, sessionId: null });
    },

    gotoStep: (step) => set({ step }),

    runDetection: async () => {
      set({ step: 'detecting', error: null });
      try {
        const { installs } = await sei.detectMcInstalls();
        if (installs.length === 0) {
          set({ installs, step: 'none-found' });
          return;
        }
        // Pre-select: prefer the persisted sei_enabled set (CONTEXT idempotency —
        // re-runs preserve the user's prior choice). If nothing was previously
        // enabled (first-run path), select ALL so the user can just click Continue.
        const selected = new Set(installs.filter((i) => i.sei_enabled).map((i) => i.id));
        if (selected.size === 0) installs.forEach((i) => selected.add(i.id));
        set({ installs, selectedIds: selected, step: 'pick' });
      } catch (err) {
        set({
          error: (err as Error).message ?? 'Detection failed',
          step: 'pick',
        });
      }
    },

    toggleSelected: (id) => {
      const next = new Set(get().selectedIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      set({ selectedIds: next });
    },

    runInstall: async () => {
      // Generate a fresh sessionId for this install run. The renderer
      // stores it in state so cancelInstall can pass it back through sei.wizardCancel.
      const sessionId = crypto.randomUUID();
      set({
        step: 'installing',
        progress: new Map(),
        results: [],
        error: null,
        sessionId,
      });
      const { baseUrl } = await sei.getSkinServerUrl();
      // Subscribe to the push channel BEFORE invoking runWizardInstall so we don't
      // miss the 'queued' event for the first install (main can emit immediately).
      progressUnsub = sei.onWizardProgress((ev) => {
        const m = new Map(get().progress);
        m.set(ev.installId, ev);
        set({ progress: m });
      });
      try {
        const { results } = await sei.runWizardInstall({
          sessionId,
          installIds: Array.from(get().selectedIds),
          skinServerBaseUrl: baseUrl,
        });
        const anyFailed = results.some((r) => !r.ok);
        set({ results, step: anyFailed ? 'one-failed' : 'done' });
      } catch (err) {
        set({
          error: (err as Error).message ?? 'Install failed',
          step: 'one-failed',
        });
      } finally {
        if (progressUnsub) {
          progressUnsub();
          progressUnsub = null;
        }
        // Session is over; clear the id so a stray late cancel is a no-op.
        set({ sessionId: null });
      }
    },

    cancelInstall: async () => {
      // Fire the IPC cancel. Main's handler aborts the matching AbortController,
      // which propagates through signal-aware install modules
      // (installFabricLoader / downloadCustomSkinLoader) to SIGTERM the
      // `java -jar fabric-installer` child process. The runWizardInstall promise
      // then rejects (or resolves with partial results); the finally block in
      // runInstall clears sessionId.
      const sid = get().sessionId;
      if (!sid) return;
      try {
        await sei.wizardCancel(sid);
      } catch {
        /* best-effort — main may already have cleaned up the session */
      }
      // Do NOT call closeWizard here — the user might want to retry. Stay on the
      // installing step; results will reflect partial progress when
      // runWizardInstall settles via its catch path.
    },
  };
});
