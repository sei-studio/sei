/**
 * Bot log routing: stdout/stderr → batched IPC + rolling file.
 *
 * Sources:
 *   - PATTERNS §src/main/logRouter.ts
 *   - RESEARCH §Pitfall 7 (batching: 50ms / 100 lines / drop above 1000 with sentinel)
 *   - src/bot/brain/log.js — tag prefix vocabulary the router classifies
 *
 * Behavior:
 *   - Every `append(line)` call parses + classifies the line, writes a copy
 *     to a per-character rolling file, and queues a structured LogEntry for
 *     the next batched IPC flush.
 *   - Multi-line state machine (Phase 5 / Plan 05-03): physical lines between a
 *     matching `[ts] [tag] begin` and `[ts] [tag] end` sentinel pair are coalesced
 *     into ONE LogEntry whose `message` carries the full multi-line body joined
 *     by `\n`. Dropped-end recovery (new begin while an event is open, or close()
 *     while an event is open) flushes the in-progress event with an appended
 *     `  [truncated]` marker line. The file tee remains per-physical-line — only
 *     IPC granularity changes.
 *   - Flushes every FLUSH_INTERVAL_MS (50ms) or when MAX_BATCH (100) is hit,
 *     whichever comes first. Above HARD_BUFFER_CAP (1000) we drop the oldest
 *     entries and surface a `dropped` sentinel on the next batch — keeps the
 *     renderer alive under firehose conditions (T-04-16 mitigation).
 */
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { LogEntry, LogBatch } from '../shared/ipc';
import { paths } from './paths';

const FLUSH_INTERVAL_MS = 50;
const MAX_BATCH = 100;
const HARD_BUFFER_CAP = 1000;

// The brain logger writes lines like:
//   [12:34:56.789] [haiku-prompt] hello world
// Capture the bracketed tag immediately following the timestamp.
const TAG_RE = /^\[\d{2}:\d{2}:\d{2}\.\d{3}\]\s+(\[[^\]]+\])/;

// Matches `[HH:MM:SS.mmm] [tag] begin` and `... end` (the only legal sentinel
// suffixes emitted by src/bot/brain/log.js post-Phase-5).
const SENTINEL_RE = /^\[\d{2}:\d{2}:\d{2}\.\d{3}\]\s+(\[[^\]]+\])\s+(begin|end)\s*$/;

function classify(line: string): { tag: string | null; level: 'info' | 'warn' | 'error' } {
  const m = line.match(TAG_RE);
  const tag = m ? m[1] : null;
  let level: 'info' | 'warn' | 'error' = 'info';
  if (/\[error\]|^ERROR\b|^Error:/i.test(line)) level = 'error';
  else if (/\[warn\]|^WARN\b/i.test(line)) level = 'warn';
  return { tag, level };
}

export interface LogRouterOptions {
  characterId: string;
  sendBatch: (batch: LogBatch) => void;
}

export interface LogRouter {
  append(line: string): void;
  close(): Promise<void>;
}

export async function createLogRouter(opts: LogRouterOptions): Promise<LogRouter> {
  const { characterId, sendBatch } = opts;
  const tsForFile = new Date().toISOString().replace(/[:.]/g, '-');
  const logFile = path.join(paths.logsDir(), `${characterId}-${tsForFile}.log`);
  await mkdir(paths.logsDir(), { recursive: true });
  const stream: WriteStream = createWriteStream(logFile, { flags: 'a' });

  let buffer: LogEntry[] = [];
  let dropped = 0;
  let closed = false;

  // Multi-line event state (Plan 05-03). When openTag !== null, we are inside
  // a `[ts] [tag] begin` ... `[ts] [tag] end` block and continuation lines
  // accumulate in openLines until a matching end sentinel finalizes the event.
  let openTag: string | null = null;
  let openLines: string[] = [];
  let openTimestamp: string | null = null;
  let openLevel: 'info' | 'warn' | 'error' = 'info';

  const flush = (): void => {
    if (closed) return;
    if (buffer.length === 0 && dropped === 0) return;
    const entries = buffer;
    buffer = [];
    const batch: LogBatch = { entries };
    if (dropped > 0) {
      batch.dropped = dropped;
      dropped = 0;
    }
    try {
      sendBatch(batch);
    } catch {
      // best-effort — renderer may be torn down; swallow to avoid log-loop
    }
  };

  function finalizeOpenEvent(reason: 'end' | 'truncated'): void {
    if (openTag === null) return;
    if (reason === 'truncated') openLines.push('  [truncated]');
    const message = openLines.join('\n');
    const entry: LogEntry = {
      timestamp: openTimestamp ?? new Date().toISOString(),
      tag: openTag,
      message,
      level: openLevel,
    };
    if (buffer.length >= HARD_BUFFER_CAP) {
      buffer.shift();
      dropped += 1;
    }
    buffer.push(entry);
    if (buffer.length >= MAX_BATCH) flush();
    openTag = null;
    openLines = [];
    openTimestamp = null;
    openLevel = 'info';
  }

  const interval = setInterval(flush, FLUSH_INTERVAL_MS);

  return {
    append(line: string) {
      if (closed) return;
      const cleaned = line.replace(/\r?$/, '');
      if (!cleaned) return;

      // Tee EVERY physical line to file unconditionally (file shape unchanged).
      try {
        stream.write(cleaned + '\n');
      } catch {
        // ignore — file may be temporarily unavailable; in-memory batch unaffected
      }

      const sentinelMatch = cleaned.match(SENTINEL_RE);
      if (sentinelMatch) {
        const tag = sentinelMatch[1];
        const suffix = sentinelMatch[2]; // 'begin' | 'end'
        if (suffix === 'begin') {
          if (openTag !== null) finalizeOpenEvent('truncated');
          openTag = tag;
          openLines = [cleaned];
          openTimestamp = new Date().toISOString();
          // begin-line classify is meaningless (sentinel carries no level signal);
          // continuation lines escalate via the contLevel block below.
          openLevel = 'info';
          return;
        }
        // suffix === 'end'
        if (openTag === tag) {
          openLines.push(cleaned);
          finalizeOpenEvent('end');
          return;
        }
        // Mismatched / orphan end — push as single-line defensive entry.
        const entry: LogEntry = {
          timestamp: new Date().toISOString(),
          tag,
          message: cleaned,
          level: classify(cleaned).level,
        };
        if (buffer.length >= HARD_BUFFER_CAP) {
          buffer.shift();
          dropped += 1;
        }
        buffer.push(entry);
        if (buffer.length >= MAX_BATCH) flush();
        return;
      }

      // Not a sentinel.
      if (openTag !== null) {
        openLines.push(cleaned);
        const contLevel = classify(cleaned).level;
        if (contLevel === 'error' || (contLevel === 'warn' && openLevel === 'info')) {
          openLevel = contLevel;
        }
        return;
      }

      // No open event — single-line passthrough (session header, stray lines).
      const { tag, level } = classify(cleaned);
      const entry: LogEntry = {
        timestamp: new Date().toISOString(),
        tag,
        message: cleaned,
        level,
      };
      if (buffer.length >= HARD_BUFFER_CAP) {
        // Drop oldest, increment counter (Pitfall 7)
        buffer.shift();
        dropped += 1;
      }
      buffer.push(entry);
      if (buffer.length >= MAX_BATCH) flush();
    },
    async close() {
      closed = true;
      clearInterval(interval);
      // Finalize any still-open event with a truncated marker before final flush.
      // We cannot call finalizeOpenEvent() here because it depends on flush(),
      // which short-circuits when `closed` is true — so do it inline.
      if (openTag !== null) {
        openLines.push('  [truncated]');
        buffer.push({
          timestamp: openTimestamp ?? new Date().toISOString(),
          tag: openTag,
          message: openLines.join('\n'),
          level: openLevel,
        });
        openTag = null;
        openLines = [];
        openTimestamp = null;
        openLevel = 'info';
      }
      if (buffer.length > 0 || dropped > 0) {
        const entries = buffer;
        buffer = [];
        const batch: LogBatch = { entries };
        if (dropped > 0) {
          batch.dropped = dropped;
          dropped = 0;
        }
        try {
          sendBatch(batch);
        } catch {
          // ignore
        }
      }
      await new Promise<void>((resolve) => stream.end(() => resolve()));
    },
  };
}
