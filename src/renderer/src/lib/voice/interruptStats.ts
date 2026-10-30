/**
 * Per-call interrupt counters (261030), reported on each companion's
 * `voice_call_ended` (see shared/callInterrupts.ts for what each count means).
 *
 * The mic and the barge machinery are shared by everyone on a group call, so
 * the counters are call-wide; each companion reports the slice since it went
 * live, which is what `join` snapshots and `take` diffs against. Pure and
 * synchronous so the store's bookkeeping is testable without a call.
 */
import {
  CALL_INTERRUPT_KEYS,
  zeroInterruptCounts,
  type CallInterruptCounts,
} from '@shared/callInterrupts';

export type InterruptKind = keyof CallInterruptCounts;

export interface InterruptStats {
  note(kind: InterruptKind): void;
  /** A companion went live: its counts start from here. */
  join(id: string): void;
  /** Counts since `id` joined (since reset when it never did), and forget it. */
  take(id: string): CallInterruptCounts;
  /** A fresh call. */
  reset(): void;
}

export function createInterruptStats(): InterruptStats {
  let total = zeroInterruptCounts();
  const base = new Map<string, CallInterruptCounts>();
  return {
    note(kind) {
      total[kind] += 1;
    },
    join(id) {
      base.set(id, { ...total });
    },
    take(id) {
      const b = base.get(id) ?? zeroInterruptCounts();
      base.delete(id);
      const out = zeroInterruptCounts();
      for (const k of CALL_INTERRUPT_KEYS) out[k] = Math.max(0, total[k] - b[k]);
      return out;
    },
    reset() {
      total = zeroInterruptCounts();
      base.clear();
    },
  };
}
