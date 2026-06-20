# HEARTBEAT goals subsystem — natural progression + execution discipline (260615)

Scope: user issue #1 ("natural progression suggestions") + issue #3 ("clean goal
set/unset & sustained execution"). One subsystem. Offline work only — live model
eval is pending a user-provided `ANTHROPIC_API_KEY`.

## The bug this fixes (from the play log)
Sui (proactiveness 3 / Driven) spawned with `oak_log×8 dirt×1` and **no pickaxe**,
then `setGoal("mine down to y:12 and collect diamonds")` — impossible to even
*start* (no pickaxe = can't mine stone, let alone ore). The goal persisted
correctly across loops (set/clear mechanics already worked), but (a) it was
unrealistic for the inventory and (b) after a chat interrupt she called `follow`
and never resumed the goal, despite it sitting live in her heartbeat.

Two root causes:
1. **No realism reference.** Nothing told the model where its inventory sits on
   the Minecraft tech ladder, and the level-3 directive literally used
   "mine down to diamonds" as its example — the exact thing that misled Sui.
2. **Weak execution discipline.** `sei:idle` / `sei:loop_end` guidance let an
   active goal be abandoned for `follow`/idle.

## Design

### TASK 1 — progression + side-event reference (referenced, not recited)
New file `src/bot/brain/memory/suggestions.js` exports:
- `PROGRESSION_LADDER` — terse tech ladder, each rung naming its **gate**
  (wood → wood tools+table → food → stone tools (needs wood pickaxe) → coal+torches
  → shelter before night → iron (needs stone pickaxe) → iron gear → diamonds
  (needs iron pickaxe, ~y:11) → nether/beyond).
- `SIDE_IDEAS` — terse fun detours (tame a wolf, visit a village, delve a cave,
  fish, map/light an area, build something cosmetic, find a structure, farm).
- `renderSuggestions()` — returns a compact `# IDEAS (reference only)` block with
  explicit framing: *pick what fits YOUR character and CURRENT inventory; don't
  recite, don't do in order; NEVER set a goal you can't START — no pickaxe = no
  mining; if you lack the tool, the goal is to get/demand it first.*

Wiring (lowest-risk, backward-compatible): `renderHeartbeat(proactiveness,
goalsText)` in `prompts.js` now appends `renderSuggestions()` after the
goals/directive. **Signature unchanged** — every existing caller/test still
passes. The block ships once per loop in the heartbeat seed (already billed
per-loop), kept tight for token budget.

Realism fixes (persona-neutral):
- `PROACTIVENESS_DIRECTIVES[3]`: removed "mine down to diamonds"; now says set a
  goal you can BEGIN from current inventory, points at the IDEAS ladder, and
  early-game-with-no-tools = wood tools/food/stone tools/shelter, not diamonds.
- `renderHeartbeat`'s no-goal nudge (levels ≥2): now demands a goal startable from
  current inventory and references the IDEAS ladder; "no pickaxe = get tools first".

### TASK 2 — clean set/unset + sustained execution
- `heartbeat.js`: added **near-duplicate dedup** to `appendGoal` (normalize
  lowercase + strip punctuation + collapse whitespace; if an existing goal matches,
  return 0 instead of appending). The `setGoal` description already forbids
  duplicates; this enforces it so a re-stated goal can't pile up loop after loop.
  Verified `removeGoal` (case-insensitive substring, leaves others), multiple-goal
  coexistence, ENOENT seeding, empty/whitespace handling.
- `EVENT_GUIDANCE['sei:idle']` and `['sei:loop_end']` (minecraft prompts):
  re-anchored an active goal as the **default** move — resume its next concrete
  step; do NOT drift to follow/idle or abandon the goal to trail the player
  unless they JUST explicitly asked you to come (an old follow does not override
  a live goal). Preserved the level-0 distinction: a Passive character still
  EXECUTES a standing-order goal but never invents one.
- Mining-down robustness: added a hint (in `sei:loop_end` guidance and the `dig`
  ACTION description) to issue ONE multi-block dig **cuboid column** (`to:` corner,
  feet→target y) instead of single-block digs, so one interrupt can't end the
  whole descent. Hint notes the pickaxe gate.

## Files + regions changed (all within assigned ownership)
- `src/bot/brain/memory/suggestions.js` — NEW (ladder, side ideas, renderSuggestions).
- `src/bot/brain/memory/suggestions.test.js` — NEW (reference + renderHeartbeat integration).
- `src/bot/brain/memory/heartbeat.js` — `normalizeForDedup` helper + dedup in `appendGoal`.
- `src/bot/brain/memory/heartbeat.test.js` — added coexistence, partial-substring clear,
  dedup, distinct-after-dedup, ENOENT-seed tests.
- `src/bot/brain/prompts.js` — import `renderSuggestions`; `PROACTIVENESS_DIRECTIVES[3]`
  realism rewrite; `renderHeartbeat` no-goal nudge + appended IDEAS block.
- `src/bot/adapter/minecraft/prompts.js` — `EVENT_GUIDANCE['sei:idle']` & `['sei:loop_end']`
  execution discipline; `dig` ACTION_DESCRIPTIONS cuboid-column mining hint.
- `scripts/probe-brain.mjs` — extended into a matrix harness (see below).

(Did NOT touch: BASELINE_INSTRUCTIONS, NUDGES, SEED_HEADERS, renderPersona,
intent/movement NUDGES, persona JSONs — owned by the parallel tone agent.)

## Offline test results
```
npx vitest run src/bot/brain/memory/heartbeat.test.js src/bot/brain/memory/suggestions.test.js
  Test Files  2 passed (2)
       Tests  19 passed (19)

npx vitest run src/bot           # full bot suite (regression check)
  Test Files  18 passed (18)
       Tests  160 passed (160)

npx tsc -p tsconfig.node.json --noEmit
  exit 0, no output.
  NOTE: tsconfig.node.json's `include` is src/main + src/preload + src/shared
  only — it does NOT typecheck src/bot/**/*.js, so the bot .js edits are out of
  scope for this typecheck (clean regardless).

node scripts/probe-brain.mjs    # OFFLINE (no key)
  SUMMARY (20 scenarios): OFFLINE-OK=20
  Every scenario assembles a seed containing # HEARTBEAT and # IDEAS.
```

## Live matrix harness (`scripts/probe-brain.mjs`)
Now a persona × proactiveness matrix plus edge cases. Always validates offline
prompt assembly; live model calls are guarded behind `if (ANTHROPIC_API_KEY)`.
No key → prints "LIVE EVAL PENDING KEY" per scenario and still checks assembly.

Scenarios:
- NARRATIVE: A (Marv silent action-tick / tone), B (Marv loop_end → build),
  C (Sui idle → realistic big goal).
- EDGE: `NOTOOL` (the log's no-pickaxe state → must NOT set a mining/diamond goal),
  `RESUME` (active goal + idle → resume, don't follow), `MULTI` (two goals → advance
  one), `DONE` (satisfied goal → clearGoal), `PASSIVE-NOGOAL` (level 0 → no setGoal).
- SWEEP: Marv/Sui/Lyra × levels 0,1,2,3 on the no-tool early-game state.

Heuristic `evaluate()` returns PASS/FAIL/WARN: hard-FAILs a mining/diamond goal
when the snapshot inventory has no pickaxe (the log bug), a passive level setting
a goal, or an execution scenario that drifts to follow-only; checks clearGoal on
satisfied goals; WARNs otherwise for human review.

Run the live matrix:
```
ANTHROPIC_API_KEY=<key> node scripts/probe-brain.mjs                  # full matrix
ANTHROPIC_API_KEY=<key> node scripts/probe-brain.mjs --only NOTOOL    # one scenario
ANTHROPIC_API_KEY=<key> node scripts/probe-brain.mjs --thinking 1024  # with private thinking
```

## Open question — live eval pending key
The live model has not been run (no key in env, per task constraints). The
behavioral claims — that the model now sets *realistic* goals for its inventory
and *resumes* an active goal instead of following — are verified only at the
prompt-assembly level offline. Run the matrix above with a key to confirm; watch
especially `NOTOOL`, `RESUME`, `DONE`, and the level-3 SWEEP rows.

## Risks for integration
- `appendGoal` now returns `0` for a near-duplicate. The orchestrator's `setGoal`
  handler maps that path to `lastActionResult = 'goal set'` / content `'goal set'`
  regardless of return value (it doesn't branch on the count), so a dedup looks
  like a successful no-op to the model — intended. If you ever want the model to
  *know* it was a duplicate, branch on the return there (currently unchanged, in
  your orchestrator region).
- Normalization for dedup is intentionally lossy (strips all punctuation) — two
  goals that differ only in punctuation collapse. That's the desired behavior for
  re-stated goals, but a genuinely different goal that only differs by punctuation
  would be blocked (unlikely for natural goal text).
- The IDEAS block adds a fixed per-loop token cost (terse: ~10-rung ladder +
  ~8-item list + framing). It rides inside the heartbeat block, which is already
  past the prompt-cache breakpoint, so no cache impact — just per-loop tokens.
- Prompt wording lives in shared files; the parallel tone agent edits adjacent
  regions. Edits here used tightly-scoped strings and touched only assigned
  regions; re-verify no merge collision in `prompts.js` (PROACTIVENESS/renderHeartbeat)
  and `minecraft/prompts.js` (EVENT_GUIDANCE/dig) after both agents land.
```
```

---

## Live evaluation (260615, ANTHROPIC_API_KEY via ~/.sei-dev/anthropic-test-key)

Ran the full live matrix (Marv/Sui/Lyra × levels 0–3 + edge cases + 2 tone replays
of the reported log). Haiku is non-deterministic, so per-run scores drift ±2–3
scenarios; conclusions below are from re-running the marginal cases several times.

### Confirmed fixed (issue → evidence)
- **#1 progression realism** — the exact log state (`oak_log×8 dirt`, no pickaxe)
  now yields a **wooden base / wood→stone-tools** goal at every active level, never
  "mine down to diamonds". Characters reason "I have wood → craft tools → *then*
  mine", which is the natural ladder. `NOTOOL`, `C`, all `SWEEP-*-2/3` pass.
- **#2 "wait for me"** — `TONE-WAIT`: bot holds position / does NOT call follow.
- **#2 "got it" filler** — `TONE-GO`: assistant-receipt tokens gone; reply is
  in-character or a silent action.
- **#3 goal resume** — `RESUME2`/`RESUME3` (the level-3 Sui bug): on an idle tick
  with an active goal, the bot advances it (gather/dig/build) instead of drifting
  to follow. `DONE` cleanly fires `clearGoal`; `MULTI` advances one of two goals;
  passive levels invent nothing.

### Residual (variance / by-design, NOT regressions)
- Level-1 (Reactive) characters sometimes `follow` instead of advancing a held
  goal. Defensible: the Reactive directive prioritizes the player's side, matching
  "a character can know a goal but choose not to pursue it." Goal resume is reliable
  at levels 2–3 (the levels that own self-directed work).
- Haiku occasionally emits an em-dash in raw text despite the BASELINE ban; the
  message splitter breaks on em/en-dashes so **none reach chat** (cosmetic only).
- Marv (level 0) at a standing-order finish sometimes narrates intent + `remember`
  instead of immediately calling `build` — soft; he verbally commits and usually
  builds on the next tick.
- Evaluator heuristic: the realism gate runs before the execution check, so a goal
  whose text tacks on a vague "then start mining down" can show FAIL even when the
  bot's actual action advanced the base. This is a SCORER artifact, not bot behavior.

### How to re-run (autonomous — key auto-loads from ~/.sei-dev/anthropic-test-key)
```
node scripts/probe-brain.mjs                 # full matrix
node scripts/probe-brain.mjs --only NOTOOL   # one scenario
node scripts/probe-brain.mjs --only TONE-WAIT
```
