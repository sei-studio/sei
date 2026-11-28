/**
 * Call connect clock (261127, O5 speed, T563): Call press -> live -> the
 * companion's first audible line, reported on the dialed companion's
 * `voice_call_ended` (see shared/callConnect.ts for what each phase means).
 *
 * The renderer only measures; it never changes when anything happens. Pure
 * and synchronous (clocks injected) so the store's bookkeeping is testable
 * without a call. Phases are integer ms from start(); each is stamped once
 * (the first mark wins) and only while the call it belongs to is current.
 */
import type {
  CallConnectGate,
  CallConnectPhase,
  CallConnectTiming,
  CallGreetPath,
  CallSttLocal,
} from '@shared/callConnect';

export interface CallConnectClockDeps {
  /** Monotonic clock (performance.now) for the renderer's own phases. */
  now: () => number;
  /** Wall clock (Date.now), for stamps taken in main. */
  wallNow?: () => number;
}

export interface CallConnectClock {
  /** The Call press: a fresh call dialing `characterId`. */
  start(characterId: string): void;
  /** Stamp one renderer-side phase (first stamp wins). `opener_tts_ms` and
   * `opener_queued_ms` only count while the opener is still open (nothing
   * heard yet, the player has not spoken). */
  mark(phase: Exclude<CallConnectPhase, 'greet_request_ms' | 'connect_ms' | 'first_line_ms'>): void;
  /** Route facts known during setup. */
  note(meta: { greetPath?: CallGreetPath; sttLocal?: CallSttLocal }): void;
  /** A line from `characterId` reached the renderer. The dialed companion's
   * first one before the player speaks is the greeting (usually while
   * dialing; after a timed-out connect it lands late). `llmStartAt` is
   * main's wall-clock stamp of the greeting's LLM request, when it sent one. */
  greetLine(characterId: string, llmStartAt?: number): void;
  /** The call went live. `minRingMs`: the ring floor the connect waited for;
   * `greetingTimedOut`: no line was buffered by the cap. */
  connected(info: { minRingMs: number; greetingTimedOut: boolean }): void;
  /** A companion clip became audible. Only the first one before the player
   * speaks counts (that is the opener). True when this one was it. */
  audible(): boolean;
  /** The player took a turn (or anything else that is not the opener spoke
   * first): a later first audible clip is no longer the opener. */
  closeOpener(): void;
  /** The timing for `characterId`'s hang-up report: only the dialed companion
   * of a call that connected has one, and only once. */
  take(characterId: string): CallConnectTiming | undefined;
  /** The current timing (DevTools log), without consuming it. */
  peek(): CallConnectTiming | undefined;
  /** Forget the current call. */
  reset(): void;
}

function ms(at: number, from: number): number | undefined {
  if (!Number.isFinite(at) || !Number.isFinite(from)) return undefined;
  const d = Math.round(at - from);
  return d >= 0 ? d : undefined;
}

interface Current {
  characterId: string;
  t0: number;
  wall0: number;
  timing: CallConnectTiming;
  openerOpen: boolean;
}

export function createCallConnectClock(deps: CallConnectClockDeps): CallConnectClock {
  const wallNow = deps.wallNow ?? Date.now;
  let cur: Current | null = null;

  const stamp = (phase: CallConnectPhase): void => {
    if (!cur || cur.timing[phase] !== undefined) return;
    const v = ms(deps.now(), cur.t0);
    if (v !== undefined) cur.timing[phase] = v;
  };

  return {
    start(characterId) {
      cur = { characterId, t0: deps.now(), wall0: wallNow(), timing: {}, openerOpen: true };
    },
    mark(phase) {
      if ((phase === 'opener_queued_ms' || phase === 'opener_tts_ms') && !cur?.openerOpen) return;
      stamp(phase);
    },
    note(meta) {
      if (!cur) return;
      if (meta.greetPath) cur.timing.greet_path = meta.greetPath;
      if (meta.sttLocal) cur.timing.stt_local = meta.sttLocal;
    },
    greetLine(characterId, llmStartAt) {
      if (!cur || cur.characterId !== characterId || !cur.openerOpen) return;
      if (cur.timing.greet_ready_ms !== undefined) return;
      stamp('greet_ready_ms');
      if (typeof llmStartAt === 'number') {
        // A stamp from before this dial belongs to another greeting: dropped.
        const v = ms(llmStartAt, cur.wall0);
        if (v !== undefined) cur.timing.greet_request_ms = v;
      }
    },
    connected({ minRingMs, greetingTimedOut }) {
      if (!cur || cur.timing.connect_ms !== undefined) return;
      stamp('connect_ms');
      let gate: CallConnectGate;
      if (greetingTimedOut) {
        gate = 'greeting_timeout';
      } else {
        // Whichever finished last held the connect.
        const ring = Math.max(0, minRingMs);
        const setup = cur.timing.stt_ready_ms ?? 0;
        const greet = cur.timing.greet_ready_ms ?? 0;
        gate = greet >= setup && greet >= ring ? 'greeting' : setup >= ring ? 'setup' : 'ring';
      }
      cur.timing.gate = gate;
    },
    audible() {
      if (!cur || !cur.openerOpen || cur.timing.connect_ms === undefined) return false;
      cur.openerOpen = false;
      stamp('first_line_ms');
      return true;
    },
    closeOpener() {
      if (cur) cur.openerOpen = false;
    },
    take(characterId) {
      if (!cur || cur.characterId !== characterId || cur.timing.connect_ms === undefined) return undefined;
      const out = { ...cur.timing };
      cur = null;
      return out;
    },
    peek() {
      return cur ? { ...cur.timing } : undefined;
    },
    reset() {
      cur = null;
    },
  };
}
