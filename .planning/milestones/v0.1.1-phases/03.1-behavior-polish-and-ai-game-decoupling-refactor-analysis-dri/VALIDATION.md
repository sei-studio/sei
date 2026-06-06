# Phase 03.1 Validation

**Validated:** 2026-05-06 (static) → 2026-05-06 live replay (Option A — partial: 3 of 4 postfix logs)
**Method:** Static (grep) checks for code-path presence + automated test runs (postProcessSay, firstTurnSay, affectLog, progressCadence) + live in-game replay of three scenarios (wood, hunt+sand, memory) with user-supplied `logs/*-postfix.txt` traces. Explore scenario was NOT exercised: `logs/explore-postfix.txt` was supplied but is 0 bytes — D-E-* defects therefore have NOT-EXERCISED Live verdicts and gap status carries forward.

Source logs cited (under `logs/` — gitignored, not in this repo's tree but referenced by the four findings files under `.planning/phases/03.1-.../log-analysis/`): wood.txt (10 defects), explore.txt (10 defects), hunt+sand.txt (11 defects), memory.txt (6 defects). 37 cited defects total. Postfix replay logs (Live verdict source): `logs/wood-postfix.txt`, `logs/hunt+sand-postfix.txt`, `logs/memory-postfix.txt`. `logs/explore-postfix.txt` is empty.

Tests are housed at `scripts/test-*.mjs` (NOT `test/...` — `test/` is gitignored at project root, line 6). This is the established convention from Plans 03 + 04 + 05 SUMMARY files.

---

## Refactor invariants

| Invariant | Check | Result |
|---|---|---|
| `brain/` has zero `mineflayer` references | `grep -rln 'mineflayer' src/brain/` | exit=1 (no matches) — PASS |
| `brain/` has zero `adapter/minecraft` references | `grep -rln 'adapter/minecraft' src/brain/` | exit=1 (no matches) — PASS |
| All Adapter members implemented | (see "Adapter members" table below) | 14/14 PRESENT — PASS |
| Cache prefix md5 stable since Plan 04 | `node -e "<harness — see Plan 02 SUMMARY 'Cache Prefix BEFORE/AFTER'>"` | BEFORE (Plan 02 baseline): `c7b24c5c0529cfdb787799e971f8bd2b` (7000B). AFTER (Plan 03 cache-bust): `5ca24ca374e40f1d3b371886ad353d2f` (6120B). CURRENT (post-Plan-05): `b939e481e9dbaa1aaeaa9f2970f5ff54` (6320B). Verdict: Plan 03 paid one intentional cache rebuild; Plan 04 added persona bytes (NOTE_TO_SELF_GUIDANCE) inside the same window per Plan 04 SUMMARY decision #6. Plan 05 did NOT bust the prefix (per Plan 05 SUMMARY "Cache Impact" — DIG_DESCRIPTION rebuild lands inside the Plan-03 window; idle/loop_end addenda + soft nudge are dynamic per-turn user content). The 200B Plan-03→current delta (+200B) is consistent with the Plan 04 NOTE_TO_SELF_GUIDANCE sentence + the noteToSelf tool-description block addition. |
| `node scripts/test-firstTurnSay.mjs` | run + record exit | "firstTurnSay: all 7 cases passed" — exit=0 — PASS |
| `node scripts/test-postProcessSay.mjs` | run + record exit | "postProcessSay: all cases passed" — exit=0 — PASS |
| `node scripts/test-affectLog.mjs` | run + record exit | "affectLog + owner: all cases passed" — exit=0 — PASS |
| `node --test scripts/test-progressCadence.mjs` | run + record exit | tests 5 / pass 5 / fail 0 — exit=0 — PASS |

### Adapter members (14 from src/brain/types.js — all checked against src/adapter/minecraft/index.js)

| # | Member | grep `<member>` src/adapter/minecraft/index.js | Result |
|---|---|---|---|
| 1 | `listActions` | match | PRESENT |
| 2 | `getActionSchema` | match | PRESENT |
| 3 | `getActionDescription` | match | PRESENT |
| 4 | `executeAction` | match | PRESENT |
| 5 | `createSnapshotComposer` | match | PRESENT |
| 6 | `worldPrimer` | match | PRESENT |
| 7 | `attach` | match | PRESENT |
| 8 | `chat` | match | PRESENT |
| 9 | `setInflightProvider` | match | PRESENT |
| 10 | `closeAnySessions` | match | PRESENT |
| 11 | `supportsAutoEat` | match | PRESENT |
| 12 | `supportsFollow` | match | PRESENT |
| 13 | `botUsername` | match | PRESENT |
| 14 | `getKnownPlayers` | match | PRESENT |

All 14 contract members from the JSDoc Adapter typedef in `src/brain/types.js` are present in `src/adapter/minecraft/index.js`. None MISSING.

---

## Defect verdict table — wood.txt (10 defects)

| ID | Title | Plan(s) | Code-path check | Live verdict | Notes |
|---|---|---|---|---|---|
| D-W-1 | Bot self-assigns task | 05 | `grep -q "Settle\|settle.*no need" src/brain/orchestrator.js` → MATCH | VERIFIED-FIXED | static: FIXED — sei:loop_end addendum: "Settle, no need to start a new task...". Live: Loop-3 sei:loop_end produced single say "we're settled in this plains spot"; no autonomous sand-digging |
| D-W-2 | 10-call dig fan-out | 05 | `grep -q "only one dig per turn" src/brain/orchestrator.js` → MATCH | PARTIAL | static: FIXED — parallel-dig cap=1 dispatch. Live: bot still issues 7 parallel digs (line 24, calls=dig×7); cap-1 dispatch correctly aborts them, but model wastes a round-trip emitting them again after first abort |
| D-W-3 | Out-of-range dig retry | 05 | `grep -q "SEARCH RADIUS" src/adapter/minecraft/behaviors/dig.js` → MATCH | PARTIAL | static: FIXED — DIG_DESCRIPTION rewrite. Live: first-pass still emits stale 5.8m/9.9m/10.2m targets; closest= hint helps recovery |
| D-W-4 | Re-narrating inventory | 05 | empty-text guard in say() (`src/brain/orchestrator.js:958` → `if (line && line.trim().length > 0)` immediately above `convoMemory.recentChat.pushSelf`) — MATCH (visual confirmation, regex-grep too narrow) | VERIFIED-FIXED | static: FIXED — empty say() lines no longer enter self-buffer. Live: restate near-eliminated; bot says "got 6 logs need 4 more" / "almost there just need 3 more" |
| D-W-5 | text leaks player-prose | DEFERRED | per CONTEXT D-3 | DEFERRED | DEFERRED — item 3 deferred per user. Live: NOT-EXERCISED in postfix replay; status unchanged |
| D-W-6 | #N indices change | 05 | `grep -q "rotate every snapshot" src/adapter/minecraft/behaviors/dig.js` → MATCH | VERIFIED-FIXED | static: FIXED — DIG_DESCRIPTION includes rotation warning + `{block:...}` hint. Live: bot now uses `{block:"jungle_log"}` form throughout; no #N digs in postfix |
| D-W-7 | Path oscillates as owner walks | 05 | `grep -q "closest=" src/adapter/minecraft/behaviors/pathfind.js` → MATCH | PARTIAL | static: FIXED — cant_reach now reports closest distance. Live: closest-distance hint visible but 6 consecutive cant_reach against moving SSk1tz; bot does NOT invoke "ask for help" rule |
| D-W-8 | Bot fails progress chat under pressure | 05 | first-turn-say enforcement (`shouldRepromptForFirstTurnSay` predicate, 7 unit cases pass) covers chat-triggered loops | STILL-REPRODUCING | static: PARTIAL. Live: user wrote "what are you thinking about? why arent you talking what do you mean brain melting" after ~30 silent iterations of cant_reach; only "okay, brain melting — taking five." came from forced iteration-cap wrap-up, not progress-cadence soft-nudge |
| D-W-9 | Diary purple prose | 04 | `grep -q "Maximum 80 words" src/brain/compaction.js` → MATCH | NOT-FIXED-IN-LIVE | static: FIXED — SUMMARY_PROMPT_INTRO rewrite: 80-word cap + anti-pattern examples. Live: diary loaded verbatim every loop with legacy 2026-05-06 / 2026-05-03 / 2026-05-02 entries containing "we'd finally found our groove", "+2183 chars" tail; 80-word cap only enforced on NEW compactions, legacy purple persists |
| D-W-10 | dropItem 10 sand silent | 05 | `grep -q "dropping 4+ items requires" src/brain/orchestrator.js` → MATCH | VERIFIED-FIXED | static: FIXED — dropItem(>=4) without paired say() reprompts. Live: dropItem({count:10}) paired with say("dropping 10 wood") via reprompt mechanism (see also NEW-W-A: actual count off-by-one) |

## Defect verdict table — explore.txt (10 defects)

| ID | Title | Plan(s) | Code-path check | Live verdict | Notes |
|---|---|---|---|---|---|
| D-E-1 | goTo flails inland | 05 | `grep -q "closest=" src/adapter/minecraft/behaviors/pathfind.js` → MATCH; SYSTEM_INSTRUCTIONS "Pathfinder rule: if goTo returns cant_reach twice for the same destination, ask for help in say() instead of trying again" (Plan 03 AFTER text) | NOT-EXERCISED | static: FIXED — combined fix: hint + ask-for-help rule. Live: explore-postfix.txt is 0 bytes; verdict carries forward (related ask-for-help defect surfaced in wood scenario as D-W-7 PARTIAL) |
| D-E-2 | text→say verbatim | DEFERRED | per CONTEXT D-3 (text leakage skipped) | DEFERRED | DEFERRED — live: NOT-EXERCISED |
| D-E-3 | "you/me" framing | 03 | `grep -q "FRAMING_LINE\|partners" src/brain/persona.js` → MATCH | NOT-EXERCISED | static: FIXED — FRAMING_LINE constant in persona; renderPersona now appends "we"/"us"/"the owner" line. Live: explore-postfix empty; partially observed in hunt+sand as PARTIAL-IMPROVED (see D-H-3) |
| D-E-4 | Redundant clarifying questions | PARTIAL | OWNER.md `## Notes` can record "appreciates action" via `noteToSelf` (`appendNote` in src/brain/memory/owner.js — MATCH from Plan 04) but not enforced | NOT-EXERCISED | static: PARTIAL — rely on noteToSelf usage; live: explore-postfix empty. Cross-log signal: D-NEW-MEM-1 shows noteToSelf activation rate near-zero in non-memory scenarios — D-E-4 indirectly STILL-AT-RISK |
| D-E-5 | Ignores "come here" partially | 05 | `closest=` hint (D-E-1) + ask-for-help rule (Plan 03 AFTER text) — MATCH | NOT-EXERCISED | static: FIXED — combined fix. Live: explore-postfix empty |
| D-E-6 | Snapshot scenery generic | 03 | `grep -q "casually acknowledge" src/brain/orchestrator.js` → MATCH | NOT-EXERCISED | static: FIXED — SYSTEM_INSTRUCTIONS entity-richness rule added. Live: explore-postfix empty |
| D-E-7 | Coord talk leaks | NOT-PLANNED | partially mitigated by D-7 say() strip; raw coords in `text` field not addressed | NOT-EXERCISED | static: NOT-PLANNED / PARTIAL — postProcessSay strips terminals/dashes/quotes from say() but `text` field passes through unfiltered. Live: explore-postfix empty |
| D-E-8 | Idle = nag | 05 | `grep -q "silence is fine" src/brain/orchestrator.js` → MATCH | NOT-EXERCISED | static: FIXED — sei:idle addendum. Live: explore-postfix empty |
| D-E-9 | 9-iter loop without progress narration | 05 | `node --test scripts/test-progressCadence.mjs` → 5/5 PASS + `grep -q "iterationsSinceLastSay" src/brain/orchestrator.js` → MATCH | NOT-EXERCISED | static: FIXED — _advanceIterationCadence helper + soft nudge after SILENT_ITERATIONS_BEFORE_NUDGE (=4) silent iterations. Live: explore-postfix empty; cross-log signal — D-W-8 (silent under cant_reach pressure) STILL-REPRODUCING in wood scenario, suggesting soft nudge does not reliably trigger |
| D-E-10 | Diary not internalized | 04 | new compaction prompt (`Maximum 80 words` + anti-pattern examples — MATCH) + AFFECT.md two-tier persistence — quality verdict requires live test | NOT-EXERCISED | static: PARTIAL. Live: explore-postfix empty; cross-log signal — D-W-9 (legacy purple diary entries persist) and D-NEW-MEM-3 (diary flush did not fire at 70KB) suggest diary content quality remains a gap |

## Defect verdict table — hunt+sand.txt (11 defects)

| ID | Title | Plan(s) | Code-path check | Live verdict | Notes |
|---|---|---|---|---|---|
| D-H-1 | First-turn say omitted | 05 | `node scripts/test-firstTurnSay.mjs` → "all 7 cases passed" exit=0 PASS | PARTIAL | static: FIXED — shouldRepromptForFirstTurnSay predicate + runIterations call site. Live: guard fires, but model still defaults to action-only first turn — costs an extra LLM round-trip every time (line 32→33→34). New defect: D-H-14 (prefill instead of abort+retry) |
| D-H-2 | text addresses player 2nd person | DEFERRED | per CONTEXT D-3 | STILL-REPRODUCING | static: DEFERRED. Live: line 19 "alright, back in the sparse jungle with SSk1tz—let's see what we're working with"; line 117 "I need to react to the zombie hitting me" — defect remains real, just out of scope for 03.1 |
| D-H-3 | Tone "you/me" not "we" | 03 | `grep -q "FRAMING_LINE" src/brain/persona.js` → MATCH | PARTIAL-IMPROVED | static: FIXED — FRAMING_LINE in persona. Live: more "we" usage but still mixed |
| D-H-4 | Punctuation everywhere | 03 | `node scripts/test-postProcessSay.mjs` → "postProcessSay: all cases passed" exit=0 PASS | VERIFIED-FIXED-BUT-OVER-STRIPS | static: FIXED — postProcessSay strip set: terminals, dashes, quotes, backticks; preserves apostrophes. Live: apostrophes survive, periods/commas/em-dashes gone — matches user complaint #5 ("dead tone, needs character-class refinement"). New defect: D-NEW-TONE-1 (over-strip — keep `,` `!` `?` and apostrophes; strip only terminal `.` and em-dash `–` and `"` and backtick) |
| D-H-5 | 7-way dig barrage | 05 | `grep -q "only one dig per turn" src/brain/orchestrator.js` → MATCH | NOT-EXERCISED | static: FIXED — parallel-dig cap=1 (same dispatch as D-W-2). Live: no sand task this run; user noted "did not try sand" |
| D-H-6 | follow returns "target gone" | 05 | `grep -q "already pursuing" src/brain/orchestrator.js` → MATCH | PARTIAL-IMPROVED | static: FIXED — follow + attackEntity same-turn collapse: follow becomes no-op. Live: new "already pursuing: combat reflex auto-pursues..." helper text replaces confusing "target gone"; still raw "target gone" at line 87, 119 |
| D-H-7 | Snapshot #N inter-turn | 05 | `grep -q "rotate every snapshot" src/adapter/minecraft/behaviors/dig.js` → MATCH | STILL-REPRODUCING | static: FIXED — DIG_DESCRIPTION warns about rotation (same fix as D-W-6). Live: line 32 calls entity:"#14"; post-abort retry switches to #15 because resolved snapshot showed #15 sheep. The dig-rotation warning didn't generalize to attackEntity targets |
| D-H-8 | PLAYER INTERRUPT double-fire | 05 | `grep -q "_lastPreservedSig" src/brain/orchestrator.js` → MATCH | NOT-EXERCISED | static: FIXED — shouldPreserveInterrupt helper + `${username}:${text}:${Math.floor(ts/500)}` signature dedup. Live: owner chats arrive cleanly as `chat<-`, no observable double-INTERRUPT in this session |
| D-H-9 | goTo cant_reach default-range | 05 | `grep -q "isCoordsAtKnownPlayer" src/adapter/minecraft/registry.js` → MATCH | NOT-EXERCISED | static: FIXED — isCoordsAtKnownPlayer detector + `range = 2` when coords match a known player within 1.5 blocks. Live: no goTo to player in this run |
| D-H-10 | Empty say() on action turns | 05 | first-turn-say enforcement covers this — `grep -c "shouldRepromptForFirstTurnSay" src/brain/orchestrator.js` → 2 PASS | STILL-REPRODUCING | static: FIXED. Live: empty `text=` channel persists at lines 25, 50, 101, 177, 182, 202, 230, 234. Predicate guards say() but does not stop empty `text=` reasoning emissions |
| D-H-11 | 26s of silent combat | 05 | first-turn-say covers start (Task 1) + progress-cadence covers mid-task silence (Task 4) — `node --test scripts/test-progressCadence.mjs` → 5/5 PASS | PARTIAL-IMPROVED | static: FIXED — layered: first-turn ack + soft nudge after 4 silent iterations. Live: combat narrates between iterations: "sheep got away. chasing it down" (38), "zombie's still breathing. keeping after it" (62); silence-past-4-iters injection visible at line 75 |

## Defect verdict table — memory.txt (6 defects)

| ID | Title | Plan(s) | Code-path check | Live verdict | Notes |
|---|---|---|---|---|---|
| D-M-1 | Praise/affect never persisted | 04 | `grep -q "loopHasAffect" src/brain/sessionState.js` → MATCH + AFFECT.md (gitignored runtime artifact, cold-created on first noteToSelf emission) | VERIFIED-FIXED | static: FIXED — OR-gate (mutation OR affect) on cadence-cap and session-end flushes. Live: AFFECT.md L6/L7/L8 written this session; noteToSelf({kind:'praise'}) → AFFECT.md write within same loop turn |
| D-M-2 | Diary entries are blobs | 04 | structured AFFECT.md + new compaction prompt (`Maximum 80 words` + anti-pattern examples — MATCH) | NOT-EXERCISED | static: PARTIAL. Live: no diary flush this session despite 70 KB cumulative; compaction prompt rewrite untested live. New defect: D-NEW-MEM-3 (flush threshold not firing at 70 KB) |
| D-M-3 | Seed loader FIFO-only | DEFERRED-WITH-RATIONALE | Plan 04 §deferred_with_rationale documents the trace: AFFECT.md satisfies CONTEXT D-4's "durable high-signal entries reachable across sessions" intent; seed-loader algorithm change deferred to v2 | DEFERRED | DEFERRED |
| D-M-4 | OWNER.md ## Notes empty | 04 | `grep -q "appendNote" src/brain/memory/owner.js` → MATCH + noteToSelf `kind:'preference'` branch in orchestrator dispatch | VERIFIED-FIXED | static: FIXED — structured `appendNote` helper + `setPreferredName` for kind='name'. Live: OWNER.md Notes line: `[2026-05-06T23:39:08.485Z] SSk1tz's favorite food is chicken`; appendNote path works end-to-end |
| D-M-5 | Hallucinated denial | PARTIAL | with AFFECT.md present, model has positive evidence; closed-world reasoning rule could help (NOT-PLANNED) | PARTIAL | static: PARTIAL. Live: "they haven't, explicitly. but there's something warmer in the question itself" — improved over original "no you haven't" but still asserts negative without hedging. User flagged in memory-postfix L2: "1 doesnt remember i've told it good job. fine." |
| D-M-6 | loopHistory crowds out diary | 03 | `grep -nE "LOOP_HISTORY_CAPACITY.*=.*10\b" src/brain/convoMemory.js` → line 30 MATCH; `grep -nE "LOOP_HISTORY_CAPACITY.*=.*20\b" src/brain/convoMemory.js` → 0 hits | NOT-EXERCISED | static: FIXED — cap reduced 20 → 10 (Trim 4). Live: no recall query this session that would exercise crowding |

---

## Summary (Static — pre-live-verdict)

Static-check tally (informational, retained from Task 1 baseline):
- Static MATCH (defect-fix code path proven present): D-W-1, D-W-2, D-W-3, D-W-4, D-W-6, D-W-7, D-W-9, D-W-10, D-E-1, D-E-3, D-E-5, D-E-6, D-E-8, D-E-9, D-E-10, D-H-1, D-H-3, D-H-4, D-H-5, D-H-6, D-H-7, D-H-8, D-H-9, D-H-10, D-H-11, D-M-1, D-M-2, D-M-4, D-M-6 = **29 defects with affirmative static evidence**
- PARTIAL (structural fix only; content/behavior verdict requires live replay): D-W-8, D-E-4, D-E-7, D-M-5 = **4 defects**
- DEFERRED (per CONTEXT D-3 / Plan 04 §deferred_with_rationale): D-W-5, D-E-2, D-H-2, D-M-3 = **4 defects**

29 + 4 + 4 = 37.

Refactor invariants: 7/7 PASS (mineflayer-free brain, adapter/minecraft-free brain, all 14 Adapter members present, 4 test runners green, cache prefix accounted for).

---

## Cross-Log Findings (Live Replay)

**Live replay performed:** 2026-05-06. User chose Option A (live in-game replay) and supplied 3 of 4 postfix logs:
- `logs/wood-postfix.txt` — 174 KB, scenario: "get 10 wood"
- `logs/hunt+sand-postfix.txt` — 108 KB, scenario: "we need food" (sand portion not exercised — see user note)
- `logs/memory-postfix.txt` — 70 KB, scenario: praise + preference recall + recall question
- `logs/explore-postfix.txt` — 0 bytes (NOT EXERCISED — explore-scenario defects D-E-* therefore have NOT-EXERCISED Live verdicts)

### User direction (verbatim)

> "Feedback is within each one, tell analysis agents to consolidate my feedback with its observations, and then consolidate across logs. To summarize, there is a major design decision regarding scavenging via veined tallying and smart find in wood-postfix.txt. Also problems with double messaging, dead tone, and lack of immediate memory storage. Please fix these, and then improve human readability of the debug log"

### User feedback embedded in logs (verbatim — preserved exactly)

**wood-postfix.txt header (SSk1tz):**
- "backlog issue, messages are taking a while to get to me and theyre being sent all at once"
- "tried to place dirt block under it to build up and reach the rest of the tree, this is good, smart, but failed"
- "still struggling to find wood: i think we need a general find() find function that conencts natural language ('wood') and in game items ('oak_log') and the model need to be able to know how to use it; not just for wood, for ores explicit"
- "major design decision: we should implement veined tallying. in world state description: we only show the nearest visible (not covered) unique blocks, so if the user is surrounded by dirt, we'd show dirt, coord of nearest dirt, number of connected dirt blocks in that vein. same thing with wood, show the nearest wood block, and number of wood connected to that vein. note that if theres two trees it would still be two wood blocks, counted in two separate veins. do this for all visible blocks within the chunk."
- "combine veined tallying for within chunk and smart_find for navigating to other chunks, i think we finally can make scavenging resources work."

**hunt+sand-postfix.txt header (SSk1tz):**
- "problems i noticed"
- "keeps disconnecting when attacked, this is an old issue we've fixed. not sure why it's back"
- "generally hunt works pretty well, just double check this would work with further prey too."
- "did not try sand"

**memory-postfix.txt header (SSk1tz):**
- "1 doesnt remember i've told it good job. fine."
- "2 it doesnt have a method of noting down specific details on the spot, it needs to wait for a diary entry opportunity but if i end the session before that it won't be remembered. fix"
- "3 double messaging still common. absolutely fix this. we also see messages not sending and then being sent all at once so it could just be that.. sometimes messages are identical and repeated though."
- "4 cannot hardcode punctuation removals, now it sounds dead"
- "5 add back punctuations, just avoid \"–\", only use \",\" \"!\" \"?\" and dont end sentences in \".\""

### New defects surfaced (organized by user-priority theme)

#### Theme 1 — Double messaging (user: "absolutely fix this")

| ID | Title | Evidence |
|---|---|---|
| D-NEW-DM-1 | sei:loop_end re-emits say() that duplicates previous say() bytes-identical | memory-postfix L21 + L27, 13 ms apart. Root cause: sei:loop_end fires follow-up LLM call that re-decides to chat with no debounce/dedupe |
| D-NEW-DM-2 | Triple wrap-up syndrome | wood-postfix lines 88, 94, 99 — "dropping the last jungle log now" / "all 10 wood's down what are we building" / "all 10 wood's down now" |
| D-NEW-DM-3 | Cross-loop parroting | hunt+sand-postfix lines 183/189/197 — "plains is solid got some good loot too" said 3× in 3s across loops 16/17/18 |

#### Theme 2 — Dead tone / over-stripped punctuation (user spec given verbatim)

| ID | Title | Evidence |
|---|---|---|
| D-NEW-TONE-1 | postProcessSay over-strips | Model emits commas/periods/em-dashes in raw `text=` fields, postProcessSay drops them all. **User's spec:** keep `,` `!` `?` and apostrophes; strip only terminal `.` and `–` and `"` and backtick |
| D-NEW-TONE-2 | Iteration-cap fallback uses static "okay, brain melting — taking five." string | User flagged this directly. Let the model write its own wrap-up |

#### Theme 3 — Immediate memory storage (user: "fix")

| ID | Title | Evidence |
|---|---|---|
| D-NEW-MEM-1 | noteToSelf activation rate near-zero in non-memory scenarios | wood-postfix and hunt+sand-postfix had clear noteToSelf opportunities (SSk1tz prefers jungle_log piles delivered at-feet, gets frustrated when bot is silent, called the bot "spacey") — bot fired noteToSelf zero times across 174 KB + 108 KB logs. Plumbing works (memory-postfix proves it); activation prompt not strong enough |
| D-NEW-MEM-2 | noteToSelf SHOULD be exempt from first-turn-say enforcement | 2 of 3 meaningful memory turns paid 2 LLM iterations because the model emitted noteToSelf as the only call → first-turn-say abort → retry with say() prepended. One-line predicate change in shouldRepromptForFirstTurnSay |
| D-NEW-MEM-3 | Diary flush did NOT fire despite 70349 cumulative bytes | Plan 04 says ≥10 loops OR ≥32 KB. Either threshold is loop-counted not byte-counted at runtime, or SIGINT bypasses session-end flush |
| D-NEW-MEM-4 | noteToSelf fires without read-back to user | Bot says "got it remembering that" / "chicken noted we're good" but doesn't quote what it actually stored — user can't tell what got persisted |

#### Theme 4 — Debug log readability (user: "improve human readability")

| ID | Title | Evidence |
|---|---|---|
| D-NEW-LOG-1 | Single physical lines wrap 8000–11000 chars | wood-postfix lines 21, 24. Each `[haiku?]` packs full prompt + ~3 KB diary block + tool list onto one tee'd line. Need event-per-line + newlines between [haiku?]/[haiku!]/[chat->] |
| D-NEW-LOG-2 | Cache-prefix JSON dumped in every `[haiku?]` event | Repeated 22+ times per session in memory-postfix. Should elide after first appearance per session via hash reference (e.g. `<diary @sha=...>`) |

#### Theme 5 — MAJOR DESIGN DECISION (user-flagged): scavenging redesign

| ID | Title | Notes |
|---|---|---|
| D-NEW-SCAV-1 | Veined tallying for in-chunk world description | **MILESTONE-SCOPE.** Replace "16 nearest blocks by distance" with "veins by type, nearest representative + connected count + total visible types". Two trees = two wood veins, not 8 unique log indices |
| D-NEW-SCAV-2 | smart_find primitive for cross-chunk navigation | When nothing visible locally |
| D-NEW-SCAV-3 | find() action mapping natural-language → game IDs | "wood"→"oak_log", "iron"→"iron_ore", etc. so the model picks the right concrete and can plan |

User's exact words: "i think we finally can make scavenging resources work." — these three combine.

#### Theme 6 — New hunt+sand defects

| ID | Title | Evidence |
|---|---|---|
| D-H-12 | Disconnect-on-attacked (HIGH, REGRESSION) | User: "keeps disconnecting when attacked, this is an old issue we've fixed. not sure why it's back". Confirmed in log: `Kicked: Could not reach server` lines 104 + 179, both immediately after `sei:attacked` event. Old known-fixed bug resurfaced |
| D-H-13 | Loop-end re-chat duplication | (covered in D-NEW-DM-1 above) |
| D-H-14 | First-turn-say abort+retry costs extra LLM call every action-first turn | Could be in-prompt prefill rather than post-hoc abort+retry |
| D-H-15 | attackEntity on item entities | Dropped items can't die, burns iterations |
| D-H-16 | Stale follow_target in snapshot persists after explicit unfollow | |
| D-H-17 | Diary not updating in real time during 23+ loop session | (covered in D-NEW-MEM-3) |

#### Theme 7 — New wood defects

| ID | Title | Evidence |
|---|---|---|
| NEW-W-A | dropItem(count=10) actually drops 9 | Off-by-one between hand-slot and inventory accounting. User had to say "no it is not dropped" to get the last one |
| NEW-W-B | dig "Digging aborted" race | Same target dug successfully, then `dig failed: Digging aborted` on next call. Likely mineflayer bot.dig race when previous block's drop hasn't been picked up |
| NEW-W-C | Self-place / pillar-up never attempted | User noted bot "tried to place dirt block under it" but log shows ZERO placeBlock( calls and ZERO equip( calls |
| NEW-W-D | Iteration cap (30) hit during routine wood task | Cap is safety net, not resolution path |
| NEW-W-E | Bot pursues SSk1tz instead of waiting on idle teleport | D-W-1 covered self-assigning *tasks*; this is self-assigning *follow* — distinct |
| NEW-W-F | setGoals never called even for textbook "get 10 wood" task | `owner_goals: (none)` persisted across entire 10-wood task |
| NEW-W-G | Diary stuck in stale "plains" framing on first turn | Loop-1 first say: "back on the plains, looks like we're ready to build" — but actual snapshot showed `surroundings: underground`. Self-corrects next iteration. Need explicit "snapshot overrides diary memory" rule |

#### Theme 8 — New memory defects

| ID | Title | Evidence |
|---|---|---|
| D-M-POST-6 | Bot tone borderline-romantic in noteToSelf summaries | L34 raw text "this is a genuine moment—SSk1tz is asking if they've thanked me before…" close to "purple prose" the compaction prompt explicitly bans. Compaction prompt is one-shot per diary write; this is the personality LLM at the per-turn level. Anti-pattern guidance may need to extend to noteToSelf |

---

## Recommended Classification

### Quick-fix-eligible (fits a single `/gsd-plan-phase 03.1 --gaps` cycle)

- Fix postProcessSay punctuation policy per user's exact spec (Theme 2, D-NEW-TONE-1) — single character-class change
- Suppress duplicate consecutive say() within sei:loop_end (Theme 1, D-NEW-DM-1) — orchestrator dedupe predicate
- Lift iteration-cap fallback off "brain melting" string (Theme 2, D-NEW-TONE-2) — let model write its own
- noteToSelf exempt from first-turn-say (Theme 3, D-NEW-MEM-2) — one-line predicate change
- Snapshot overrides diary memory hint on first turn (NEW-W-G) — small composer change
- Force say() on 2× cant_reach same destination (D-W-7) — verify execution path
- Detect attackEntity on item-class entity, refuse + surface (D-H-15)
- Clear follow_target in snapshot when unfollow resolves (D-H-16)
- Investigate dropItem count off-by-one (NEW-W-A)
- Investigate diary flush threshold not firing at 70 KB (D-NEW-MEM-3)
- D-W-9 force-recompact legacy purple diary entries on next session start

### Needs design discussion (probably new phase or phases)

- D-NEW-SCAV-1/2/3: Veined tallying + smart_find + find() — full snapshot composer rewrite + new tools + closed-world resolver. **MILESTONE-SCOPE.**
- NEW-W-C: Pillar-up / scaffolding behavior — adapter behavior + DIG_DESCRIPTION + new docs
- D-NEW-MEM-1: Strengthen noteToSelf activation OR auto-extract via post-hoc rule-based extractor — push vs pull design choice
- D-H-14: First-turn-say prefill vs abort-retry — architectural choice on prompt-shape vs runtime guard
- D-NEW-LOG-1/2: Log readability — switch from line-tee to event-per-line + cache-prefix elision. Touches logger format used everywhere
- D-H-12: Disconnect regression — bisect needed, then regression test scaffolding decision

---

## Summary — Final

Live verdicts post-replay (37 cited defects from original four findings files):

| Verdict | Count | IDs |
|---|---|---|
| VERIFIED-FIXED | 6 | D-W-1, D-W-4, D-W-6, D-W-10, D-M-1, D-M-4 |
| PARTIAL / PARTIAL-IMPROVED / VERIFIED-FIXED-BUT-OVER-STRIPS | 6 | D-W-2, D-W-3, D-W-7, D-H-1, D-H-3, D-H-4, D-H-6, D-H-11, D-M-5 |
| STILL-REPRODUCING | 4 | D-W-8, D-H-2, D-H-7, D-H-10 |
| NOT-FIXED-IN-LIVE | 1 | D-W-9 (legacy diary entries persist; new-compaction policy not retroactive) |
| NOT-EXERCISED (explore-postfix empty + sand not run + no goTo-to-player + no recall-crowding + no diary flush) | 17 | D-E-1, D-E-2, D-E-3, D-E-4, D-E-5, D-E-6, D-E-7, D-E-8, D-E-9, D-E-10, D-H-5, D-H-8, D-H-9, D-M-2, D-M-6 (15 — plus D-W-5 deferred is also NOT-EXERCISED in postfix) |
| DEFERRED (per CONTEXT D-3 / Plan 04 §deferred_with_rationale, status unchanged) | 4 | D-W-5, D-E-2, D-H-2, D-M-3 |

**Note on counting:** the table buckets above overlap (e.g. D-E-2 is both DEFERRED and NOT-EXERCISED in live; D-H-2 is DEFERRED but live observation = STILL-REPRODUCING). Per-defect Live verdict cells in the four tables above are authoritative; the above bucket counts are approximate aggregates.

**New defects surfaced by live replay:** 17+ new IDs (Themes 1–8) including the user-flagged scavenging redesign (D-NEW-SCAV-1/2/3 — milestone-scope) and the disconnect regression (D-H-12 — high priority).

**Refactor invariants:** 7/7 PASS unchanged from static pass.

**Coverage gap:** explore-postfix.txt empty → all 10 D-E-* defects remain unverified in live. Recommend re-running explore scenario before declaring those FIXED.

**Phase 03.1 status recommendation:** code-complete based on static checks + partial live confirmation; substantive new defects (especially Theme 5 scavenging redesign and Theme 4 log readability) should drive a follow-up `/gsd-plan-phase 03.1 --gaps` cycle plus a new milestone for scavenging.
