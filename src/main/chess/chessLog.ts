/**
 * Per-game chess session log (260722).
 *
 * Rides the exact same pipeline as the Minecraft bot logs so a chess game can
 * be diagnosed end to end without new plumbing:
 *   - rolling file `chess-<characterId>-<ts>.log` in <userData>/logs, pruned
 *     by the same startup pruneLogsDir pass as bot logs;
 *   - batched `bot:log:batch` IPC into the in-app developer console (LogsBar),
 *     multi-line events coalesced by logRouter's begin/end sentinel protocol.
 *
 * What gets logged (the contract the commentary debugging depends on):
 *   - session start/end: gameId, colors, elo, result;
 *   - every committed ply: SAN + UCI + FEN after;
 *   - every LLM turn as ONE multi-line [chess:turn] event: kind, the chess
 *     context block that was sent (compact — the persona prefix is stable and
 *     omitted), each hop's raw text + tool calls + tool_result notes, what was
 *     spoken vs suppressed, token usage, wall time;
 *   - hold lifecycle: decided (with sampled prethink), presented, revised,
 *     held (wait), released, force-committed, committed.
 */
import type { LogBatch } from '../../shared/ipc';
import { createLogRouter, type LogRouter } from '../logRouter';

/** `[HH:MM:SS.mmm]` — same stamp shape src/bot/brain/log.js emits. */
function ts(): string {
  return `[${new Date().toISOString().slice(11, 23)}]`;
}

export interface ChessLog {
  /** One single-line entry: `[ts] [chess] message`. */
  line(message: string): void;
  /**
   * One multi-line event, coalesced into a single console entry via the
   * begin/end sentinel protocol. `tag` extends the vocabulary, e.g. 'turn'
   * becomes `[chess:turn]`.
   */
  block(tag: string, body: string): void;
  close(): Promise<void>;
}

/** No-op log used when router creation failed (logging is never load-bearing). */
export const NULL_CHESS_LOG: ChessLog = {
  line: () => {},
  block: () => {},
  close: async () => {},
};

export async function createChessLog(
  characterId: string,
  sendBatch: (batch: LogBatch) => void,
): Promise<ChessLog> {
  let router: LogRouter;
  try {
    router = await createLogRouter({ characterId: `chess-${characterId}`, sendBatch });
  } catch {
    return NULL_CHESS_LOG;
  }
  return {
    line(message: string) {
      router.append(`${ts()} [chess] ${flatten(message)}`);
    },
    block(tag: string, body: string) {
      const stamp = ts();
      const t = `[chess:${tag}]`;
      router.append(`${stamp} ${t} begin`);
      for (const l of body.split('\n')) router.append(`  ${l}`);
      router.append(`${stamp} ${t} end`);
    },
    async close() {
      await router.close();
    },
  };
}

/** Single-line entries must stay single-line for the router's classifier. */
function flatten(s: string): string {
  return s.replace(/\s*\n\s*/g, ' | ');
}
