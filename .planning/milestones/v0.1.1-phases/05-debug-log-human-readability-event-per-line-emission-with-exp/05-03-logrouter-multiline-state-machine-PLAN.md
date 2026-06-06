---
phase: 05-debug-log-human-readability-event-per-line-emission-with-exp
plan: 03
type: execute
wave: 2
depends_on: [05-01-logger-multiline-emit-and-hash-dictionary-PLAN.md]
files_modified:
  - src/main/logRouter.ts
autonomous: true
requirements: []
must_haves:
  truths:
    - "logRouter.append() collects continuation lines following a `[ts] [tag] begin` sentinel into a single LogEntry whose `message` field carries the full multi-line body (begin sentinel + continuation lines + end sentinel)."
    - "When an `[ts] [tag] end` sentinel arrives that matches the currently-open event's tag, the event is finalized and pushed to the buffer as ONE LogEntry."
    - "When a NEW `[ts] [tag] begin` sentinel arrives while another event is still open, the in-progress event is flushed first with an appended `  [truncated]` line on its body, then the new event begins."
    - "On `close()`, any still-open event is flushed with the `[truncated]` marker."
    - "Non-tagged stray lines (no `[ts] [tag]` prefix and no open event) flow through as single-line LogEntry with `tag: null` — preserves today's fallback behavior for raw stdout."
    - "Per-character rolling file tee continues to write EVERY physical line (one stream.write per append call) — file shape is unchanged; only the IPC LogEntry granularity changes."
    - "HARD_BUFFER_CAP=1000 stays unchanged (D-10) — multi-line events count as one LogEntry each."
    - "LogEntry / LogBatch field SHAPES in src/shared/ipc.ts are unchanged — only the `message` string content can now contain embedded newlines."
  artifacts:
    - path: "src/main/logRouter.ts"
      provides: "Multi-line state machine extending append() to collect begin -> continuation -> end into one LogEntry, with [truncated] recovery on dropped end."
      contains: "SENTINEL_RE"
  key_links:
    - from: "src/main/logRouter.ts append()"
      to: "the per-router open-event buffer (closure-private state)"
      via: "SENTINEL_RE match capturing tag + (begin|end) suffix"
      pattern: "SENTINEL_RE"
---

<objective>
Extend `src/main/logRouter.ts` from a single-line classifier into a multi-line state machine. The router must coalesce lines between matching `[ts] [tag] begin` and `[ts] [tag] end` sentinels into ONE `LogEntry` whose `message` carries the full multi-line body. Handle the dropped-end case (process killed mid-event, or a NEW begin arriving before the previous end) by flushing the in-progress event with an appended `  [truncated]` marker line.

Keep the per-character rolling file tee, the IPC batch (50ms / 100 lines / 1000 cap), the `dropped` sentinel, and the close-on-shutdown flush behavior EXACTLY as they are today. Only the unit of an IPC `LogEntry` changes — from one per physical stdout line to one per logical event.

Purpose: Plan 05-01 changed log.js to emit multi-line blocks. logRouter currently parses each physical line as a separate LogEntry, which would explode the renderer into 8-12 fragmented entries per event. This plan restores one-entry-per-event semantics over the new multi-line wire format.
Output: A logRouter that consumes multi-line blocks correctly.
</objective>

<execution_context>
@/Users/ouen/.claude/get-shit-done/workflows/execute-plan.md
@/Users/ouen/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@/Users/ouen/slop/sei/.planning/phases/05-debug-log-human-readability-event-per-line-emission-with-exp/05-CONTEXT.md
@/Users/ouen/slop/sei/.planning/phases/05-debug-log-human-readability-event-per-line-emission-with-exp/05-01-logger-multiline-emit-and-hash-dictionary-PLAN.md
@/Users/ouen/slop/sei/src/main/logRouter.ts
@/Users/ouen/slop/sei/src/shared/ipc.ts

<interfaces>
From `src/shared/ipc.ts` (UNCHANGED in this plan — field shapes stay identical):

```ts
export interface LogEntry {
  timestamp: string;
  tag: string | null;
  message: string;             // now CAN contain embedded \n for multi-line events
  level: 'info' | 'warn' | 'error';
}
export interface LogBatch { entries: LogEntry[]; dropped?: number; }
```

From `src/main/logRouter.ts` (current — what we extend):

```ts
const TAG_RE = /^\[\d{2}:\d{2}:\d{2}\.\d{3}\]\s+(\[[^\]]+\])/;
function classify(line: string): { tag: string | null; level: 'info'|'warn'|'error' };
export async function createLogRouter(opts): Promise<LogRouter>;
// LogRouter = { append(line: string): void; close(): Promise<void>; }
```

Wire format from log.js (post-Plan-05-01) — five line shapes that arrive at `append`:

1. Begin sentinel: `[HH:MM:SS.mmm] [tag] begin` — line ends with literal ` begin`.
2. End sentinel:   `[HH:MM:SS.mmm] [tag] end`   — line ends with literal ` end`.
3. Continuation line: typically starts with two-or-more spaces (the 2-space indent from Plan 05-01); does NOT match SENTINEL_RE.
4. Session header (one-shot, single line): `[HH:MM:SS.mmm] [log] cache-prefix dictionary initialized (sha256-8, session-scoped)` — has no `begin` or `end` suffix; treated as a single-line passthrough entry.
5. Stray untagged lines (raw stack traces, mineflayer console output) — pass through as today with `tag: null`.

Sentinel regex to add:

```ts
const SENTINEL_RE = /^\[\d{2}:\d{2}:\d{2}\.\d{3}\]\s+(\[[^\]]+\])\s+(begin|end)\s*$/;
```
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Implement multi-line state machine in logRouter.ts</name>
  <files>src/main/logRouter.ts</files>
  <read_first>
    - /Users/ouen/slop/sei/src/main/logRouter.ts (the whole file — small)
    - /Users/ouen/slop/sei/src/shared/ipc.ts (LogEntry / LogBatch — confirm shape is unchanged)
    - /Users/ouen/slop/sei/.planning/phases/05-debug-log-human-readability-event-per-line-emission-with-exp/05-CONTEXT.md decisions D-2 and D-10
  </read_first>
  <action>
Modify `src/main/logRouter.ts` only. Do NOT touch `src/shared/ipc.ts` — the LogEntry shape is unchanged.

1. **Add a sentinel regex** alongside the existing `TAG_RE`:

```ts
// Matches `[HH:MM:SS.mmm] [tag] begin` and `... end` (the only legal sentinel
// suffixes emitted by src/bot/brain/log.js post-Phase-5).
const SENTINEL_RE = /^\[\d{2}:\d{2}:\d{2}\.\d{3}\]\s+(\[[^\]]+\])\s+(begin|end)\s*$/;
```

Keep the existing `TAG_RE` — `classify()` continues to use it for the single-line passthrough path (session header, stray non-event tagged lines).

2. **Add closure-private state inside `createLogRouter`** alongside `buffer` / `dropped` / `closed`:

```ts
let openTag: string | null = null;
let openLines: string[] = [];
let openTimestamp: string | null = null;
let openLevel: 'info' | 'warn' | 'error' = 'info';
```

3. **Add a private `finalizeOpenEvent(reason)` helper** in closure scope:

```ts
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
  if (buffer.length >= HARD_BUFFER_CAP) { buffer.shift(); dropped += 1; }
  buffer.push(entry);
  if (buffer.length >= MAX_BATCH) flush();
  openTag = null;
  openLines = [];
  openTimestamp = null;
  openLevel = 'info';
}
```

4. **Rewrite the `append(line)` body** as a state machine. The file-tee MUST run unconditionally for every physical line (file shape is unchanged):

```ts
append(line: string) {
  if (closed) return;
  const cleaned = line.replace(/\r?$/, '');
  if (!cleaned) return;

  // Tee EVERY physical line to file unconditionally.
  try { stream.write(cleaned + '\n'); } catch { /* ignore */ }

  const sentinelMatch = cleaned.match(SENTINEL_RE);
  if (sentinelMatch) {
    const tag = sentinelMatch[1];
    const suffix = sentinelMatch[2]; // 'begin' | 'end'
    if (suffix === 'begin') {
      if (openTag !== null) finalizeOpenEvent('truncated');
      openTag = tag;
      openLines = [cleaned];
      openTimestamp = new Date().toISOString();
      openLevel = 'info';  // begin-line classify is meaningless (sentinel has no level signal); continuation lines escalate via the contLevel block below.
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
    if (buffer.length >= HARD_BUFFER_CAP) { buffer.shift(); dropped += 1; }
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

  // No open event — single-line passthrough.
  const { tag, level } = classify(cleaned);
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    tag,
    message: cleaned,
    level,
  };
  if (buffer.length >= HARD_BUFFER_CAP) { buffer.shift(); dropped += 1; }
  buffer.push(entry);
  if (buffer.length >= MAX_BATCH) flush();
},
```

5. **Update `close()`** to finalize any still-open event before the final flush. The existing `flush()` short-circuits on `closed`, so do the finalize + flush inline:

```ts
async close() {
  closed = true;
  clearInterval(interval);
  if (openTag !== null) {
    openLines.push('  [truncated]');
    buffer.push({
      timestamp: openTimestamp ?? new Date().toISOString(),
      tag: openTag,
      message: openLines.join('\n'),
      level: openLevel,
    });
    openTag = null; openLines = []; openTimestamp = null; openLevel = 'info';
  }
  if (buffer.length > 0 || dropped > 0) {
    const entries = buffer; buffer = [];
    const batch: LogBatch = { entries };
    if (dropped > 0) { batch.dropped = dropped; dropped = 0; }
    try { sendBatch(batch); } catch { /* ignore */ }
  }
  await new Promise<void>((resolve) => stream.end(() => resolve()));
},
```

6. **Keep HARD_BUFFER_CAP, MAX_BATCH, FLUSH_INTERVAL_MS, file-tee, and the dropped-sentinel logic UNCHANGED** (D-10). Do not touch `src/shared/ipc.ts`. The `classify()` function is unchanged and is reused for both single-line and continuation-line paths.

Update the top-of-file doc comment to mention the multi-line state machine briefly (one new sentence under "Behavior:").
  </action>
  <verify>
    <automated>cd /Users/ouen/slop/sei &amp;&amp; npx --yes -p typescript@5 tsc --noEmit --target es2022 --module nodenext --moduleResolution nodenext --skipLibCheck --strict false src/main/logRouter.ts &amp;&amp; grep -q 'SENTINEL_RE' src/main/logRouter.ts &amp;&amp; grep -q "finalizeOpenEvent" src/main/logRouter.ts &amp;&amp; grep -q "\\[truncated\\]" src/main/logRouter.ts &amp;&amp; echo OK</automated>
  </verify>
  <acceptance_criteria>
    - `npx --yes -p typescript@5 tsc --noEmit ... src/main/logRouter.ts` exits 0.
    - `grep -c "SENTINEL_RE" src/main/logRouter.ts` (filtered for non-comment lines via `grep -v '^//'`) is at least 2 (declaration + use).
    - `grep -c "openTag" src/main/logRouter.ts` is at least 6 (declaration, set in begin path, check before begin, check in continuation, reset in finalize, reset in close).
    - `grep -q "openTag === tag" src/main/logRouter.ts` matches (the end-suffix tag-match check).
    - `grep -q "finalizeOpenEvent('truncated')" src/main/logRouter.ts` matches.
    - File-tee call `stream.write(cleaned + '\n')` is still present and is reached on EVERY append (i.e., it is OUTSIDE the sentinel branch and before any early returns).
    - `src/shared/ipc.ts` is unmodified by this plan: `git diff --name-only` includes `src/main/logRouter.ts` and does NOT include `src/shared/ipc.ts`.
  </acceptance_criteria>
  <done>logRouter coalesces multi-line events into one LogEntry on matching end, recovers with a `  [truncated]` marker on dropped end (mid-event killed process or unmatched-begin), preserves single-line passthrough for the session header and stray lines, and keeps the file-tee + buffer-cap + flush cadence unchanged.</done>
</task>

</tasks>

<verification>
- The verify command in Task 1 prints `OK`.
- `git diff --stat src/main/logRouter.ts` shows substantive additions; `git diff src/shared/ipc.ts` shows zero changes.
</verification>

<success_criteria>
- A synthetic stream of `[ts] [haiku?] begin` + indented continuation lines + `[ts] [haiku?] end` injected via `append()` produces exactly ONE `LogEntry` in the batched output, whose `message` contains all the lines joined by `\n`.
- An unmatched-begin scenario (begin without end, then a second begin) produces exactly TWO entries: the first carrying `  [truncated]` appended to its message.
</success_criteria>

<output>
After completion, create `.planning/phases/05-debug-log-human-readability-event-per-line-emission-with-exp/05-03-SUMMARY.md` noting the regex shape, the close()-time truncation handling, and confirmation that ipc.ts was untouched.
</output>
