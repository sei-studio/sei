/**
 * Data store — characters, LAN state, summon (bot status), logs ring buffer.
 *
 * Per 04-RESEARCH.md §Resolved Q5: subscriptions to onLog/onStatus/onLan are
 * mounted at the STORE level (App.tsx calls subscribeIpc() once); navigation
 * MUST NOT drop log lines (D-53 buffer cap = 5000).
 *
 * Per Pitfall 7 — main coalesces log batches; renderer just appends and
 * trims the ring buffer with `slice(-MAX_LOG_LINES)`.
 *
 * Source: 04-CONTEXT.md D-22 (LanState), D-53 (5000-line cap),
 *         04-PATTERNS.md §useDataStore, 04-RESEARCH.md §Code Examples 6.
 */

import { create } from 'zustand';
import type { Character } from '@shared/characterSchema';
import type { BotStatus, BotActionPush, LanState, LogEntry, LogBatch } from '@shared/ipc';
import { sei } from '../ipcClient';
import { useUiStore } from './useUiStore';

const MAX_LOG_LINES = 5000;

interface DataState {
  characters: Character[];
  lan: LanState;
  /**
   * Per-character bot status, keyed by characterId (multi-summon). An absent
   * key means "not summoned" (idle); a present entry is connecting/online/error.
   * Components that care about one character read `summons[id]`; "is any bot
   * running" reads `Object.values(summons)`.
   */
  summons: Record<string, BotStatus>;
  /**
   * Current world action per summoned character (Party redesign §2): the last
   * `bot:action` push, mapped to a verb line by lib/actionVerb. Cleared when
   * the push carries name:null or the session leaves 'online'/'connecting'.
   */
  actions: Record<string, { name: string | null; args?: Record<string, unknown>; ts: number }>;
  logs: LogEntry[];
  /** Cumulative count of dropped lines (Pitfall-7 backpressure sentinel). */
  dropped: number;

  /**
   * Session-local set of ids that the user just deleted. HomeGrid's
   * cloud-only placeholder list (the gray CLOUD card) is built from
   * chars:list-merged, which reads the cloud row directly. When the user
   * deletes a self-owned char, the cloud delete is enqueued fire-and-forget;
   * until it drains, the cloud row still exists and the placeholder would
   * pop back as "CLOUD". This set lets the grid suppress that flash so the
   * delete feels immediate. Cleared on auth state change / app restart.
   */
  recentlyDeletedIds: Set<string>;
  loadCharacters: () => Promise<void>;
  refreshCharacter: (id: string) => Promise<void>;
  addCharacter: (c: Character) => void;
  updateCharacter: (c: Character) => void;
  removeCharacter: (id: string) => void;

  setLan: (state: LanState) => void;
  /** Route a single status push into the per-character map (idle clears the key). */
  setStatus: (status: BotStatus) => void;
  /** Route a bot:action push into the per-character action map. */
  setAction: (push: BotActionPush) => void;

  appendLogBatch: (batch: LogBatch) => void;
  clearLogs: () => void;
}

export const useDataStore = create<DataState>((set) => ({
  characters: [],
  recentlyDeletedIds: new Set<string>(),
  lan: { kind: 'closed' },
  summons: {},
  actions: {},
  logs: [],
  dropped: 0,

  loadCharacters: async () => {
    const list = await sei.listCharacters();
    set({ characters: list });
  },

  refreshCharacter: async (id) => {
    // Hard guard: chars:get validates its input as a non-optional string, so a
    // falsy id (a status push that predates the multi-summon characterId field,
    // or an undefined route param) would reject with a Zod "Required" error and
    // surface as an uncaught promise rejection. There is nothing to refresh for
    // an empty id, so bail before crossing the IPC boundary.
    if (!id) return;
    const c = await sei.getCharacter(id);
    if (!c) {
      set((s) => ({ characters: s.characters.filter((x) => x.id !== id) }));
      return;
    }
    set((s) => ({
      characters: s.characters.some((x) => x.id === id)
        ? s.characters.map((x) => (x.id === id ? c : x))
        : [...s.characters, c],
    }));
  },

  addCharacter: (c) => set((s) => ({ characters: [...s.characters, c] })),
  updateCharacter: (c) =>
    set((s) => ({ characters: s.characters.map((x) => (x.id === c.id ? c : x)) })),
  removeCharacter: (id) =>
    set((s) => {
      const next = new Set(s.recentlyDeletedIds);
      next.add(id);
      return {
        characters: s.characters.filter((x) => x.id !== id),
        recentlyDeletedIds: next,
      };
    }),

  setLan: (state) => set({ lan: state }),
  setStatus: (status) =>
    set((s) => {
      // Defend the map key: a malformed/legacy status without a characterId
      // must not land under an `"undefined"` key (which would then route to a
      // ghost character everywhere `summons[id]` is read). Ignore it.
      if (!status.characterId) return {};
      const next = { ...s.summons };
      // 'idle' means this character's session ended → drop the key so
      // `summons[id]` reads undefined (not summoned). Everything else upserts.
      if (status.kind === 'idle') delete next[status.characterId];
      else next[status.characterId] = status;
      // A session leaving the live states can't have a current action.
      if (status.kind === 'idle' || status.kind === 'error') {
        const nextActions = { ...s.actions };
        delete nextActions[status.characterId];
        return { summons: next, actions: nextActions };
      }
      return { summons: next };
    }),

  setAction: (push) =>
    set((s) => {
      if (!push.characterId) return {};
      const next = { ...s.actions };
      if (push.name === null) delete next[push.characterId];
      else next[push.characterId] = { name: push.name, args: push.args, ts: push.ts };
      return { actions: next };
    }),

  appendLogBatch: (batch) =>
    set((s) => {
      const next = s.logs.concat(batch.entries);
      const trimmed = next.length > MAX_LOG_LINES ? next.slice(-MAX_LOG_LINES) : next;
      return {
        logs: trimmed,
        dropped: s.dropped + (batch.dropped ?? 0),
      };
    }),

  clearLogs: () => set({ logs: [], dropped: 0 }),
}));

/**
 * Wire push subscriptions from preload into the data store.
 * Returns a teardown function.
 *
 * Per RESEARCH §Resolved Q5: subscriptions live at the STORE level, not inside
 * individual screen components. Navigation cannot drop log lines.
 */
function wireIpc(): () => void {
  const offLan = sei.onLan((state) => useDataStore.getState().setLan(state));
  // Seed the LAN state once the listener is attached. The onLan push only
  // fires on CHANGE, so on a (re)load while a world is already open the store
  // would otherwise sit at its initial 'closed' until the next change.
  // Pulling the snapshot here (not relying on a replay-push that races this
  // subscription) fixes "open world → detected → reload → shows closed".
  void sei
    .getLanState()
    .then((state) => useDataStore.getState().setLan(state))
    .catch(() => {
      /* leave initial state; a subsequent push will correct it */
    });
  const offStatus = sei.onStatus((status) => {
    // Clear the console when the FIRST bot starts connecting (no other session
    // already live). This preserves single-summon behavior — a fresh session
    // gets a clean console — while a SECOND concurrent summon must not wipe the
    // logs of a bot that's already running.
    if (status.kind === 'connecting') {
      const others = useDataStore.getState().summons;
      const anyOther = Object.entries(others).some(
        ([cid, st]) =>
          cid !== status.characterId && (st.kind === 'connecting' || st.kind === 'online'),
      );
      if (!anyOther) useDataStore.getState().clearLogs();
    }
    // When a session ends (idle), pull the character's freshly-written
    // last_launched / playtime_ms. Main defers emitting 'idle' until the
    // exit-time playtime write lands, so this reads the updated totals — and
    // every status now carries characterId, so no separate tracking is needed.
    if (status.kind === 'idle' && status.characterId) {
      void useDataStore.getState().refreshCharacter(status.characterId);
    }
    // 260709 — unsupported world version gets a popup, not just a model-row
    // status: the Play flow otherwise fails with no visible feedback. Opened
    // here (the single onStatus subscription) so every summon entry point is
    // covered. Status pushes fire on transitions only, so one failed summon
    // opens exactly one popup.
    if (status.kind === 'error' && status.error === 'UNSUPPORTED_MC_VERSION') {
      useUiStore.getState().openModal({
        kind: 'unsupported-version',
        characterId: status.characterId,
        message: status.message,
      });
    }
    // 260720 — LAN_NOT_OPEN failures get the same treatment: prod data shows
    // users hitting this repeatedly and churning, so the failure opens a popup
    // with numbered "open to LAN" steps instead of only the model-row line.
    if (status.kind === 'error' && status.error === 'LAN_NOT_OPEN') {
      useUiStore.getState().openModal({
        kind: 'lan-not-open',
        characterId: status.characterId,
      });
    }
    // 260720 — crash popup: a LIVE session died unexpectedly (the supervisor
    // marks the terminal error with midSession; only a nonzero exit with no
    // stop requested ever carries it, so user stops, app quit, clean session
    // ends, and every pre-summon failure are all excluded by construction).
    // Classes with a dedicated popup above keep their own surface; everything
    // else was previously a silent vanish.
    if (
      status.kind === 'error' &&
      status.midSession === true &&
      status.error !== 'LAN_NOT_OPEN' &&
      status.error !== 'UNSUPPORTED_MC_VERSION'
    ) {
      useUiStore.getState().openModal({
        kind: 'bot-crash',
        characterId: status.characterId,
      });
    }
    useDataStore.getState().setStatus(status);
  });
  // Seed the summons map once the listener is attached (260703). Status pushes
  // fire only on TRANSITIONS, so a subscriber attaching after a session went
  // 'online' — full reload, dev HMR re-wire, late mount — would otherwise never
  // learn it is live (no floating widget, profile stuck on "Play together").
  // Replace the map wholesale: the snapshot is authoritative, so this also
  // clears stale entries whose terminal 'idle' push was missed. Optional-call —
  // a not-yet-reloaded preload without getBotStatuses just skips the seed.
  void sei
    .getBotStatuses?.()
    .then((list) => {
      const summons: Record<string, BotStatus> = {};
      for (const st of list) {
        if (st.characterId && st.kind !== 'idle') summons[st.characterId] = st;
      }
      useDataStore.setState({ summons });
    })
    .catch(() => {
      /* leave the push-fed map; the next status transition corrects it */
    });
  const offLog = sei.onLog((batch) => useDataStore.getState().appendLogBatch(batch));
  // Phase 15 (D-10/VIS-03): mirror the active provider's vision capability into
  // useUiStore so the Settings auto-render toggle (15-05) gates its disabled
  // state on a real signal. The bot emits this on summon-ready and on each
  // backend switch; subscribed here alongside the other store-level bot pushes
  // (one subscription for the lifetime of the renderer — App.tsx calls
  // subscribeIpc once). Fail-closed default (false) lives in useUiStore.
  const offVisionCapability = sei.onVisionCapability((cap) => {
    useUiStore.getState().setVisionCapable(cap.visionCapable === true);
  });
  // Current-action pushes (Party redesign §2). Optional-call: a not-yet-
  // reloaded preload without onBotAction just skips the feature.
  const offAction =
    sei.onBotAction?.((push) => useDataStore.getState().setAction(push)) ?? (() => {});
  return () => {
    offLan();
    offStatus();
    offLog();
    offVisionCapability();
    offAction();
  };
}

/**
 * At most one live wiring per MODULE INSTANCE. subscribeIpc() (App.tsx mount,
 * StrictMode re-runs) swaps the active wiring instead of stacking; the returned
 * teardown is idempotent.
 */
let activeTeardown: (() => void) | null = null;

export function subscribeIpc(): () => void {
  activeTeardown?.();
  const off = wireIpc();
  let done = false;
  const teardown = (): void => {
    if (done) return;
    done = true;
    off();
    if (activeTeardown === teardown) activeTeardown = null;
  };
  activeTeardown = teardown;
  return teardown;
}

// Self-subscribe at module scope (260703). App.tsx's mount effect used to be
// the only subscriber — but when Vite HMR re-executes THIS module (editing this
// file, or a store it imports, while the app runs), `create()` builds a fresh
// store that every re-imported component reads, while App's old effect keeps
// feeding the ORPHANED previous instance. Result: bot:status/lan pushes landed
// in a dead store — a chat-launched session showed no popup and the profile
// stayed on "Play together". Wiring here runs on every (re)execution, so the
// instance components read is always the instance the pushes feed (and the
// snapshot seeds above backfill anything missed in between). App.tsx's
// subscribeIpc() call remains as the production-path subscription; it swaps
// this wiring rather than duplicating it. Guarded: under vitest/jsdom the
// preload bridge is absent or a partial stub, and importing this module must
// not throw — App.tsx wires it on mount in that world.
try {
  if (typeof window !== 'undefined' && window.sei) subscribeIpc();
} catch {
  /* partial bridge (tests) — App.tsx's mount call owns the wiring there */
}
