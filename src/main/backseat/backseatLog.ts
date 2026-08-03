/**
 * Per-session backseat log (260728).
 *
 * Same pattern as chessLog: rides the bot log pipeline (logRouter) so a
 * backseat session can be diagnosed from the in-app developer console
 * (LogsBar) without new plumbing:
 *   - rolling file `backseat-<characterId>-<ts>.log` in <userData>/logs,
 *     pruned by the same startup pass as bot logs;
 *   - batched `bot:log:batch` IPC into LogsBar.
 *
 * What gets logged: gate calls (score, cutoff, latency, verdict), gate skips,
 * tick arbitration (dropped / preempted / run), turn outcomes (silence vs
 * lines), and the overlay renderer's `[backseat]` console lines (signals,
 * jolts, scheduling) forwarded via appendOverlayLog. The terminal keeps its
 * own copy of everything; this is the same stream made visible in-app.
 */
import type { LogBatch } from '../../shared/ipc';
import { createLogRouter, type LogRouter } from '../logRouter';

/** `[HH:MM:SS.mmm]` — same stamp shape src/bot/brain/log.js emits. */
function ts(): string {
  return `[${new Date().toISOString().slice(11, 23)}]`;
}

export interface BackseatLog {
  /** One single-line entry: `[ts] [backseat] message`. */
  line(message: string): void;
  close(): Promise<void>;
}

/** No-op log used when router creation failed (logging is never load-bearing). */
export const NULL_BACKSEAT_LOG: BackseatLog = {
  line: () => {},
  close: async () => {},
};

export async function createBackseatLog(
  characterId: string,
  sendBatch: (batch: LogBatch) => void,
): Promise<BackseatLog> {
  let router: LogRouter;
  try {
    router = await createLogRouter({ characterId: `backseat-${characterId}`, sendBatch });
  } catch {
    return NULL_BACKSEAT_LOG;
  }
  return {
    line(message: string) {
      // Single-line entries must stay single-line for the router's classifier.
      router.append(`${ts()} [backseat] ${message.replace(/\s*\n\s*/g, ' | ')}`);
    },
    async close() {
      await router.close();
    },
  };
}
