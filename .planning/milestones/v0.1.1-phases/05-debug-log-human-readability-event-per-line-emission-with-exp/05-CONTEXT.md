# Phase 5: Debug log human readability — Context

**Gathered:** 2026-05-11
**Status:** Ready for planning
**Source:** D-NEW-LOG-1, D-NEW-LOG-2 (`.planning/phases/03.1-behavior-polish-and-ai-game-decoupling-refactor-analysis-dri/VALIDATION.md` L184-185)

<domain>
## Phase Boundary

Switch the debug logger from line-tee (one physical 8–11KB line per event) to **event-per-line emission**: each `[haiku?]` / `[haiku!]` / `[chat->]` / `[chat<-]` / `[act!]` / `[heal]` event becomes a readable multi-line text block with explicit section breaks. After the first appearance per session, repeated cached prompt blocks are elided via short hash references (e.g., `<diary @sha=ef56>`) so the log doesn't repeat the same ~3KB diary block 22+ times per session.

**Scope is logger output + parsing only.** The Anthropic prompt sent to Haiku, the conversation memory, the IPC contract, and the renderer LogsPanel rendering are **not changed by this phase**.

**Out of scope:**
- Renderer-side display work (multi-line event cards, click-to-expand hash refs) — Claude's discretion if trivially required, else deferred
- Changes to what Sei logs (no new event kinds, no new fields beyond hash refs)
- Memory/compaction changes (Phase 03.1 already shipped)
- Scavenging logger touches (Phase 6) / scaffolding (Phase 7)

</domain>

<decisions>
## Implementation Decisions (LOCKED)

### Event-record schema

- **D-1 Plain-text multi-line block with `begin`/`end` sentinels.** Each event opens with `[ts] [tag] begin` and closes with `[ts] [tag] end`. Continuation lines are indented 2 spaces. NDJSON and single-line-with-escaped-`\n` rejected — grep-friendly multi-section navigation is the primary readability goal.
- **D-2 logRouter parses with a multi-line state machine.** Existing `TAG_RE` (`^\[ts\]\s+\[tag\]`) only fires on `begin` and `end` sentinels; lines in between are continuations of the current event. One `LogEntry` per logical event (not per physical line); the `message` field carries the full multi-line body. Plan must spec the state-machine transitions and what happens if `end` is missing (e.g., process killed mid-event) — flush the open event with a `[truncated]` marker on the next `begin` or on close.
- **D-3 Section format inside the block is human-prose, not k=v.** Example layout for `[haiku?]`:
  ```
  [12:34:56.789] [haiku?] begin
    tools: say, dig, place, equip
    user: <persona @sha=ab12>
           <capability @sha=cd34>
           <diary @sha=ef56>
           snapshot: pos=12,64,-30 hp=20 ...
           recent_events: killed sheep (+1 wool)
           owner says: get me 5 sand
  [12:34:56.789] [haiku?] end
  ```
  Plan must specify the section labels for every existing event kind (`haiku?`, `haiku!`, `chat<-`, `chat->`, `act!`, `heal`) — keep them faithful to current field semantics.

### Cache-prefix elision unit

- **D-4 Three independent hashes — persona, capability, diary** — mapped 1:1 to the existing Anthropic `cache_control` breakpoints (D-18 in STATE.md: 3 cached blocks). When only the diary changes (compaction at semantic boundary), persona and capability stay elided. Whole-prefix-blob and generic-section-dedup rejected.
- **D-5 Hash algo: sha256, first 8 hex chars** (Claude's discretion — change if research surfaces a reason). Hash is computed over the **raw block body bytes** as sent to Anthropic, not the rendered log text.
- **D-6 Session-scoped dictionary** — first appearance per logger-process lifetime prints full body; subsequent appearances print `<persona @sha=ab12>` as a single-line reference. Plan must spec where the dictionary lives (in-memory in `src/bot/brain/log.js`) and that it does **not** persist across bot restarts. Restarting the bot re-prints the full block on the first `[haiku?]` of the new session — by design (the rolling log file is per-session).
- **D-7 Dictionary header at session start.** When the logger writes its first event of a session, emit a one-line header noting "cache-prefix dictionary initialized" so a reader scrolling from the top understands why hashes appear. Plan must spec exact header format.
- **D-8 Snapshot, recent_events, owner-chat are NOT hashed.** These change every call (or nearly so); elision overhead would exceed savings. They print inline in full.

### Truncation policy

- **D-9 Drop `MAX_INLINE` truncation entirely.** Both file-tee and IPC carry full content. Elision is the only size control. First-appearance bodies (persona ~600t, capability ~400t, diary ~1000t) print in full once per session; thereafter the log is dominated by short hash refs + per-call snapshot.
- **D-10 Renderer firehose protection stays.** `logRouter.ts` HARD_BUFFER_CAP=1000 + dropped-sentinel logic is unchanged — the per-event size shrinks, so the cap protects against event-count spikes (already its purpose).

### Claude's Discretion

- Hash algorithm details (sha256 vs sha1 vs murmur, char-length 6/8/10/12) — default to sha256-8; switch if collision math or readability research suggests otherwise
- Exact wording of section labels inside event blocks (`tools:` / `user:` / `stop:` / etc.)
- Open-event recovery format on process kill (`[truncated]` marker vs phantom `end` line — pick what's cleanest)
- Whether to update `src/main/logRouter.ts` test fixtures alongside the schema change
- Renderer LogsPanel display behavior — if existing multi-line rendering already works acceptably, no changes; otherwise minimal patch to render begin/end blocks as a single visual unit. Renderer-side polish is **NOT** required for phase completion.

</decisions>

<specifics>
## Specific Ideas

- "Switch from line-tee to event-per-line with explicit `\n` between `[haiku?]` / `[haiku!]` / `[chat->]` sections" — phase goal verbatim from ROADMAP.md.
- "Elide repeated cache-prefix JSON via hash reference (e.g., `<diary @sha=...>`) after first appearance per session" — phase goal verbatim.
- User-selected schema preview (event format):
  ```
  [12:34:56.789] [haiku?] begin
    tools: say, dig, place, equip
    user: <persona @sha=ab12>
           <capability @sha=cd34>
           <diary @sha=ef56>
           snapshot: pos=12,64,-30 hp=20 ...
           recent_events: killed sheep (+1 wool)
           owner says: get me 5 sand
  [12:34:56.789] [haiku?] end
  ```
- User-selected elision preview (per-block, 3 hashes mapped to Anthropic cache breakpoints).

</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase source defects
- `.planning/phases/03.1-behavior-polish-and-ai-game-decoupling-refactor-analysis-dri/VALIDATION.md` L184-185 — D-NEW-LOG-1 (line wrap), D-NEW-LOG-2 (cache-prefix repeat)
- `.planning/phases/03.1-behavior-polish-and-ai-game-decoupling-refactor-analysis-dri/VALIDATION.md` L250 — touch-points summary

### Current logger + router (read before modifying)
- `src/bot/brain/log.js` — current emitters: `logHaikuQuery`, `logHaikuResponse`, `logChatIn`, `logChatOut`, `logHeal`, `logActionResult`. Holds `MAX_INLINE=2000`, `emit()` writes one `console.log` per event.
- `src/main/logRouter.ts` — line tagger + classifier (`TAG_RE`), 50ms / 100-line / 1000-cap batched IPC, per-character rolling file tee. **This file's parsing model changes from single-line to multi-line event** under D-2.
- `src/shared/ipc.ts` (or `.js`) — `LogEntry` / `LogBatch` types consumed by renderer. **Field shape is unchanged**; only `message` content format is multi-line.

### Anthropic prompt structure (for hash-unit alignment — D-4)
- `src/bot/brain/orchestrator.js` — system prompt assembly, cached prefix layout, 3 `cache_control` breakpoints (persona / capability / diary). Plan must identify the exact byte ranges so the logger can hash them in the same units.
- `src/bot/brain/compaction.js` — diary compaction; the diary hash changes when compaction fires, persona/capability stay stable across the session.

### Architecture & project rules
- `CLAUDE.md` — project guide (timeout rule, native ABI, etc.)
- `.planning/STATE.md` — D-18 (3 cached blocks, cache_control on LAST block)
- `.planning/ROADMAP.md` Phase 5 entry — goal definition

### Recent quick-task history (context for emitter touchpoints)
- `.planning/quick/260505-iqo-memory-and-loop-architecture-refactor-bu/` — most recent loop/memory architecture; convoMemory split owner/self
- `.planning/quick/260505-twx-sei-behavior-fixes-chat-full-mode-toggle/` — chat/full mode toggle (controls whether `[think]` is relayed in chat); does NOT change log emit path

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/bot/brain/log.js` `emit(tag, ...parts)` — the single chokepoint. Refactor target: replace `console.log(single-line)` with a multi-line writer that emits `[ts] [tag] begin` + indented sections + `[ts] [tag] end`. Per-emitter helpers (`logHaikuQuery` etc.) stay as the public API.
- `src/main/logRouter.ts` `classify()` + `TAG_RE` — already does first-line tag extraction. Extend, don't replace: detect `begin` / `end` suffix, collect continuation lines into a buffer keyed by the open event, finalize on `end`.
- `src/main/logRouter.ts` `flush()` + dropped-sentinel — keep verbatim. Multi-line events count as one `LogEntry`; the cap remains protective.

### Established Patterns
- Tag prefixes (`[haiku?]`, `[haiku!]`, `[chat<-]`, `[chat->]`, `[act!]`, `[heal]`) are stable vocabulary — do NOT rename. Append ` begin` / ` end` suffix to keep grep patterns like `grep '\[haiku?\]'` matching both sentinels.
- ISO-8601 timestamps `HH:MM:SS.mmm` at line start — preserve format. Begin and end sentinels use the SAME timestamp (the moment the event was logged), not wall-clock at write time of each.
- Best-effort try/catch around stream writes (Pitfall 7 logging guard) — preserve.

### Integration Points
- `src/bot/brain/orchestrator.js` calls `logHaikuQuery({messages, tools})` and `logHaikuResponse({...})` — plan must surface the cached-block byte ranges to the logger. Two paths: (a) orchestrator passes pre-computed hashes alongside the raw user payload, or (b) logger receives the raw cached blocks separately and hashes them itself. Plan picks one; (b) is cleaner separation but requires a new arg shape.
- Renderer `LogsPanel` (Phase 4 ship) consumes `LogEntry.message` — multi-line strings already display; minor CSS may be needed for indent rendering. Not a phase requirement.

</code_context>

<deferred>
## Deferred Ideas

- **Renderer LogsPanel multi-line event cards / click-to-expand hash refs** — could become its own UX polish phase if user wants structured display.
- **Persistent hash dictionary across bot restarts** — would let cross-session log reading skip the first-appearance bodies. Not worth the cost; current per-session model is fine.
- **NDJSON shadow stream** — keep human-readable file, additionally emit a machine-parseable NDJSON stream for offline analysis tooling. Not needed today; pick up if analytics work demands it.
- **Generic any-section dedup (rejected option 3 in elision discussion)** — could fold repeated snapshots when owner is afk. Marginal; revisit only if logs show this is the dominant source of repeat content after Phase 5 lands.

</deferred>

---

*Phase: 05-debug-log-human-readability-event-per-line-emission-with-exp*
*Context gathered: 2026-05-11*
