/**
 * Per-call "was the player heard" bookkeeping (261118), reported on each
 * companion's `voice_call_ended` (see shared/callHearing.ts for each field).
 *
 * The dictation keeps running totals (DictationCallStats); this adds the
 * accepted-utterance count and the STT path, and slices all of it per
 * companion the same way interruptStats does: `join` snapshots when a
 * companion goes live, `take` reports the difference. Pure and synchronous so
 * the store's bookkeeping is testable without a call.
 */
import type { CallHearing, SttPath } from '@shared/callHearing';
import type { DictationCallStats } from './dictation';

export interface CallHearingTracker {
  /** A fresh call. The path is unknown until the STT policy is read. */
  reset(): void;
  /** Which STT path this call runs on (sttPathFor). May change mid-call when
   *  the cloud leg turns out to have no credentials and only local runs. */
  setPath(path: SttPath): void;
  /** The call accepted one of the player's transcripts as a turn. */
  noteUtterance(): void;
  /** A companion went live: its slice starts from here. */
  join(id: string, stats: DictationCallStats | null): void;
  /** The slice since `id` joined (since reset when it never did), and forget
   *  it. `stats` is the dictation's latest totals (null = no dictation). Null
   *  when the call never got as far as choosing an STT path. */
  take(id: string, stats: DictationCallStats | null): CallHearing | null;
}

interface Base {
  utterances: number;
  heardFrames: number;
  sttRequests: number;
}

const ZERO: Base = { utterances: 0, heardFrames: 0, sttRequests: 0 };

export function createCallHearing(): CallHearingTracker {
  let path: SttPath | null = null;
  let utterances = 0;
  const base = new Map<string, Base>();
  return {
    reset() {
      path = null;
      utterances = 0;
      base.clear();
    },
    setPath(p) {
      path = p;
    },
    noteUtterance() {
      utterances += 1;
    },
    join(id, stats) {
      base.set(id, {
        utterances,
        heardFrames: stats?.heardFrames ?? 0,
        sttRequests: stats?.sttRequests ?? 0,
      });
    },
    take(id, stats) {
      const b = base.get(id) ?? ZERO;
      base.delete(id);
      if (path === null) return null;
      return {
        player_utterances: Math.max(0, utterances - b.utterances),
        stt_requests: Math.max(0, (stats?.sttRequests ?? b.sttRequests) - b.sttRequests),
        input_peak_heard: (stats?.heardFrames ?? b.heardFrames) > b.heardFrames,
        stt_path: path,
      };
    },
  };
}
