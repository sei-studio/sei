# Phase 5: Debug log human readability — Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-11
**Phase:** 05-debug-log-human-readability-event-per-line-emission-with-exp
**Areas discussed:** Event-record schema, Cache-prefix elision unit, Truncation policy

---

## Gray-area selection

| Option | Description | Selected |
|--------|-------------|----------|
| Event-record schema | Plain-text multiline vs NDJSON vs single line with escaped \n | ✓ |
| Cache-prefix elision unit | Hash whole prefix as one blob vs per cached block | ✓ |
| Renderer-side scope | Phase touches LogsPanel rendering vs output-only | |
| Truncation policy | MAX_INLINE=2000 retention vs drop vs asymmetric vs per-tag | ✓ |

**User's choice:** Discuss schema, elision unit, and truncation. Renderer-side scope left to Claude's discretion (deferred — output-only by default).

---

## Event-record schema

| Option | Description | Selected |
|--------|-------------|----------|
| Plain-text multi-line block | Each event opens `[ts] [tag] begin` / closes `end`; continuation lines indented. Router stitches via state machine. Grep-friendly. | ✓ |
| NDJSON (one JSON object per line) | One JSON object per event; router stays single-line; needs jq for raw grep; renderer can structurally render fields. | |
| Single line with escaped \n in payload | One physical line per event; literal \n in body; router unchanged; defeats multi-section grep navigation. | |

**User's choice:** Plain-text multi-line block.
**Notes:** User selected the preview verbatim. Locks 2-space continuation indent and `begin` / `end` sentinels sharing the originating event timestamp. logRouter parsing moves from per-line tagger to multi-line state machine; truncated/missing `end` recovery left to Claude (e.g., `[truncated]` marker on next `begin` or on close).

---

## Cache-prefix elision unit

| Option | Description | Selected |
|--------|-------------|----------|
| Per cached block (persona / capability / diary) | Three independent hashes mapped 1:1 to Anthropic cache_control breakpoints. Diary compaction only invalidates the diary ref. | ✓ |
| Whole system prefix as one blob | Single hash over all 3 cached blocks concatenated. Simplest; loses block-level reuse. | |
| Per `[haiku?]` user-turn dedup (any repeated section) | Generic: hash any repeated section, including snapshot when owner is afk. Most aggressive; less predictable. | |

**User's choice:** Per cached block (persona / capability / diary).
**Notes:** Three independent hashes. Hash algorithm and char-length left to Claude's discretion (default sha256-8). Session-scoped in-memory dictionary in `src/bot/brain/log.js`; does NOT persist across bot restarts. Snapshot / recent_events / owner-chat are NOT hashed — they change every call and elision overhead would exceed savings.

---

## Truncation policy

| Option | Description | Selected |
|--------|-------------|----------|
| Drop truncation entirely | File and IPC both carry full content; elision is the only size control. | ✓ |
| Asymmetric: file full, IPC capped | File full, renderer-bound IPC truncates parts > N KB. Adds a second emit path. | |
| Per-tag policy | Full for chat/act/heal; defensive caps on haiku? body (8KB) and haiku! text (4KB). | |

**User's choice:** Drop truncation entirely.
**Notes:** `MAX_INLINE=2000` removed. logRouter `HARD_BUFFER_CAP=1000` and dropped-sentinel logic stay as event-count protection.

---

## Claude's Discretion

- Hash algorithm details (default sha256-8)
- Exact section labels inside event blocks
- Recovery format on missing `end` sentinel
- Whether logRouter test fixtures are updated in this phase
- Renderer LogsPanel changes — only if minimal patch is required for begin/end blocks to render as a single visual unit. Renderer-side polish is NOT a phase exit criterion.

## Deferred Ideas

- Renderer LogsPanel multi-line event cards / click-to-expand hash refs — separate UX phase if wanted
- Persistent hash dictionary across bot restarts — not worth the cost
- NDJSON shadow stream for offline analytics — only if analytics work demands it later
- Generic any-section dedup (rejected option 3) — revisit only if logs show repeat snapshots dominate post-Phase-5
