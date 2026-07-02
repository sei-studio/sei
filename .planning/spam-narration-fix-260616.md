# Sui chat-spam / narration fix — log bbf5b66f …2026-06-16T03-37

Four issues reported from the 03-37 play log, all reproduced and fixed.

## Root causes & fixes

1. **Spam from sentence breakup.** The splitter turns one model turn into N chat
   pings; the model emitted 2–3 sentences/turn → 2–3 pings. BASELINE line 17 even
   *encouraged* writing two sentences ("just write your two short sentences").
   - Flipped that into a `SEND LESS` directive: every sentence ships as its own
     message; default to ONE sentence/turn, usually none; three pings = spam.
   - At the setGoal moment (driven, idle/spawn) the model monologued its plan.
     `renderHeartbeat` no-goal nudge + `PROACTIVENESS_DIRECTIVES[3]` + the
     `sei:idle` event guidance now say: **the plan lives in setGoal + tool calls,
     NOT chat; one short boast line max, with banned status-narration openers**
     ("i'm spawning…", "empty inventory…", "ouen's 19 blocks…").
   - On routine action-ticks the model used the text block as a scratchpad
     ("i'm mid-goto… staying silent"). The `NUDGES.actionTurn` silent branch now
     leads with **"OUTPUT AN EMPTY TEXT BLOCK"** and explicitly forbids reasoning
     in the block.

2. **3rd-person + coordinate leak** ("ouen's right here", "wood's at 41,111,-4").
   - BASELINE "ADDRESS THE PLAYER AS YOU" now covers the player's **real name**
     as a subject (not just username), with the exact failing examples.
   - "YOUR TEXT BLOCK IS IN-GAME CHAT" now states **coordinates/distances are HUD
     readouts, never speech**, with the "41,111,-4" example.

3. **Unprompted follow / not autonomous** ("gotta catch up first" + follow()).
   - Root cause: the **live profile copy lacked the independence clause** that
     repo `sui.json` already had. Synced the full `expanded` into
     `…/profiles/…/characters/bbf5b66f-….json` (proactiveness kept at 3).

4. **Hallucinated nearby resources** ("punch these trees around us" with no logs
   in the snapshot).
   - New BASELINE rule **"SPEAK ONLY FROM YOUR SNAPSHOT"** — don't invent
     blocks/mobs that aren't listed; nothing "right here" that's across the map.

## Files

- `src/bot/brain/prompts.js` — SEND LESS, snapshot-grounding, real-name 3rd-person,
  coords ban, heartbeat no-goal nudge, `PROACTIVENESS_DIRECTIVES[3]`, actionTurn
  silent branch.
- `src/bot/adapter/minecraft/prompts.js` — `sei:idle` one-boast-line ceiling +
  banned openers.
- live profile `bbf5b66f-….json` — synced expanded (independence clause).
- `scripts/probe-brain.mjs` — added `LOG-SPAWN` + `LOG-ACTIONTICK` scenarios and a
  `spawn-clean` evaluator (asserts ≤2 msgs, no coords, no 3rd-person name, no
  follow, no hallucinated resource).
- `scripts/sim-loop.mjs` — NEW multi-turn loop simulator (chains iterations with a
  mocked world; prints the chat transcript as the player sees it).

## Results (live Haiku, key from ~/.sei-dev/anthropic-test-key)

- `LOG-SPAWN` (all 4 bugs, single turn): **10/10 PASS**
- `sim-loop` (full loop, spawn→search→"im here"→far wood): **1 chat line/loop**
  (was ~10 in the log), realistic goal every run, no chase, no coords, no halluc.
- `TICK-SILENT` / `TICK-GATHER-STAY` (routine action-tick silence): **5/5 PASS** each.
- Regression matrix otherwise green; the only residual FAILs are the pre-existing
  stochastic goal-resume scenarios (`RESUME`, `RESUME2`, `FOLLOW-TICK`), unrelated
  to this fix.

## Residual

Pure **no-goal** mid-action ticks (artificial post-fix, since Sui now sets a goal
at spawn) still narrate ~20–25% of the time — Haiku-with-thinking-off variance.
In the corrected end-to-end flow the action serves a goal, so silence holds (5/5).
