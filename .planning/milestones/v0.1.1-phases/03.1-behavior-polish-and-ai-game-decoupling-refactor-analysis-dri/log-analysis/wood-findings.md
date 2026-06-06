# wood.txt — Findings

**Log:** logs/wood.txt
**Session summary:** Bot spawned mid-task, gathered sand on its own initiative, then was asked "get 10 wood" by SSk1tz; spent ~80s thrashing between out-of-range dig attempts and short re-position hops, never reaching 10 logs before the log ends.
**Outcome:** failure (only 3 jungle + 2 oak logs collected; loop-6 cut off mid-iteration with no terminal `say()` and no completion)
**Iterations observed:** 6 loops; loop-1=4, loop-2=18, loop-3=1, loop-4=1, loop-5=1, loop-6=14+ (still running at EOF, no terminal log line)

## Defects (with line refs)

### D-W-1: Bot self-assigns task with no owner instruction
- **Where:** lines 26–28 (loop-2 start, event=sei:loop_end)
- **What:** Immediately after greeting SSk1tz, the bot fires a fresh loop on `loop_end` and decides "i'll start gathering sand again" with no goal set, no chat from owner, dropping into `dig` autonomously.
- **Why it matters:** Owner watches bot dig sand they didn't ask for; later when they say "get 10 wood" the bot first has to drop the unwanted sand (line 172). Wastes ~80s of owner attention.
- **Suspected cause:** `sei:loop_end` re-triggers a fresh loop with full diary context. Diary's "i'm the pack mule" framing biases Haiku toward action even with no `owner_goals`.

### D-W-2: 10-call dig fan-out wastes the entire batch on one stale target
- **Where:** lines 34–44, 58–65, 188–198, 244–250
- **What:** Bot repeatedly issues 5–10 parallel `dig` calls to the same `#1`–`#N` block list. After the first dig succeeds, the bot moves and every subsequent call returns "stale target" or "out of range". Line 244 emits five identical `dig({target:"#1"})` calls — five copies of the *same* index — all 5.2m out of range.
- **Why it matters:** Each useful dig costs an LLM round-trip plus 6–9 wasted tool calls. Token bloat in the next snapshot (3000–4000 input tokens at lines 86, 188, 200) from huge tool_result arrays.
- **Suspected cause:** Action registry / system prompt invites parallel calls but doesn't communicate that targets are positional and become stale after movement. No `dig_many` or "chop nearest N" primitive.

### D-W-3: Out-of-range dig retried without first calling goTo
- **Where:** lines 28–29, 155–157, 159–166, 220–250
- **What:** Bot calls `dig({block:"oak_log", maxDistance:32})` (32m search radius) then receives "out of range (5.4m, need ≤4.5)". It then re-issues `dig({target:"#1"})` for the same block five times in a row from the same position (line 244–249) — five identical "out of range 5.2m" failures.
- **Why it matters:** Pure dead-loop. Range is hard-capped at 4.5m server-side; no amount of retries help. Owner sees bot frozen in place.
- **Suspected cause:** `dig` tool description likely advertises `maxDistance:32` which the LLM reads as "I can dig from 32m away". The 4.5m cap is enforced silently by the actor. Also: no auto-pathfind-into-range.

### D-W-4: Re-narrating inventory every turn
- **Where:** lines 67, 86, 200, 203, 212, 220, 227, 234, 241, 244, 251, 261, 264, 271
- **What:** 13+ consecutive turns open with "i've got N logs" / "i've got 5 logs and need 5 more" / "i've got 5 logs (3 jungle, 2 oak)". The model literally restates inventory in `text` every turn even though the snapshot already provides it.
- **Why it matters:** Burns output tokens on noise; makes loop reasoning look like spinning. If `text` ever leaked to chat (it doesn't here, but compare line 125–127), it'd be insufferable.
- **Suspected cause:** Prompt likely encourages "narrate state before deciding". Should be discouraged when snapshot is present.

### D-W-5: Internal `text` contains player-facing prose that never reaches chat
- **Where:** lines 125–128 (loop-3, attacked branch)
- **What:** The model's `text` field is literally `"ow—what's that about?\n\nso you teleported to me and immediately smacked me. looks like i was mid-dig on sand..."` — a full multi-paragraph chat reply — but only the first line is passed to `say({text:"ow—what's that about?"})`. The richer reasoning is wasted.
- **Why it matters:** Owner sees a curt "ow" while the model produced a much warmer reply that got truncated to one phrase. Recent fix (260505-twx) made first/last `say()` mandatory but didn't fix the say/think split.
- **Suspected cause:** Model treats `text` as scratchpad even when content is conversational. No clear contract that `text` is private.

### D-W-6: Snapshot positional indices change between turns, defeating `target:"#N"` references
- **Where:** lines 73 (#1=sand@-31,62,-49), 85 (#1=sand@-31,61,-49), 187 (#1=jungle_log@-31,64,-38), 199 (#1=oak_log@-26,65,-40)
- **What:** The same index `#1` rotates to a different block every snapshot as the bot moves and the sort order shifts. The model issues a batch of `dig({target:"#1"}) ... dig({target:"#10"})` based on *current* indices, but those indices are already invalid for the second through tenth call because the first dig changes position.
- **Why it matters:** Root cause behind D-W-2's stale-target storm. Indices are ephemeral but the prompt shape suggests they're stable.
- **Suspected cause:** Block enumeration in snapshot is re-sorted each tick by distance. Either freeze IDs across a snapshot's lifetime, or accept only coordinate-based dig.

### D-W-7: Pathing oscillates while owner walks away
- **Where:** lines 90–117, 146–154, 252–272
- **What:** Bot sets goTo target → SSk1tz has already moved (e.g. line 92 SSk1tz@-28,64,-47; line 95 @-28,64,-47; line 97 @-25,65,-47; line 100 @-14,65,-48; line 103 @-8,67,-51; line 106 @0,65,-56; line 109 @4,62,-60). Each LLM turn the bot picks a stale waypoint and fails `cant_reach`. Owner is also actively breaking the bot's `follow` by teleporting and walking.
- **Why it matters:** 18-iteration loop-2 (line 119) is mostly pathfinding thrash. Owner sends "what are u doing rn" (line 93) and "hello?" (line 113) because the bot is silent and visibly stuck.
- **Suspected cause:** `follow` semantics not used; bot manually re-issues `goTo({x,y,z})` snapshot after snapshot. Long pathfinder failures (timeout at line 213) compound.

### D-W-8: Bot fails to communicate progress under owner pressure
- **Where:** lines 93 (owner: "what are u doing rn") → line 98 reply only after another `goTo`; line 113 ("hello?") → line 119 loop terminates due to attack, no chat reply at all to "hello?"
- **What:** When SSk1tz asks "hello?" the bot is mid-pathfind, returns `cant_reach`, then the loop terminates from a P0 attack event without ever calling `say()` to acknowledge "hello?".
- **Why it matters:** Direct social failure — owner asked, bot ghosted, then bot got hit (probably out of frustration). Recent fix mandates terminal `say()` but PLAYER INTERRUPT preempted into a P0-safety branch and skipped it.
- **Suspected cause:** Interrupt handling drops queued chat acknowledgments when a higher-priority event fires.

### D-W-9: Diary self-narration is fictional / over-romantic
- **Where:** lines 12, 27, 132, 139, 145 (diary content repeated each loop)
- **What:** Diary entries describe "quiet moments where we both just stood there in the dirt together" and "feeling like we'd finally found our groove" — sentimental retconning of mostly-silent sessions where the bot stood empty-handed near a llama trader.
- **Why it matters:** Tone the user wants is "we"-framed and unsentimental; diary leaks florid prose into every prompt's context, biasing Haiku toward purple text. Also burns ~1100+ chars of cache per turn (`[+1121 chars]`, `[+2197 chars]`, `[+2388 chars]`).
- **Suspected cause:** Diary compactor LLM prompt encourages narrative; no length cap; no tone constraint.

### D-W-10: dropItem of 10 sand discards owner-visible work in one call without comment
- **Where:** line 172
- **What:** On hearing "get 10 wood", bot calls `dropItem({item:"sand",count:10}) | dig(...)` in the same batch. No `say()` like "okay dropping the sand we collected" to the owner. They just see the bag of sand vanish.
- **Why it matters:** Owner asked for the sand earlier (per diary), then gets it dumped silently when priorities shift. Trust friction.
- **Suspected cause:** Single-layer LLM treats chat and tool dispatch as interchangeable; no rule that destructive inventory ops must be narrated.

## Positive observations
- Snapshot block enumeration is rich (e.g. line 92 shows 8 oak_log + 6 jungle_log positions clearly) — when bot is in range it does pick correct targets.
- Loop-1 (lines 14–24) terminated cleanly in 4 iterations with a friendly say().
- Bot correctly recognized owner_goals=(none) when asked at line 137 and didn't fabricate goals.
- Haiku output stays lower-case + dash-separated, matching desired tone, in every `say()` (lines 23, 128, 134, 141).

## Token / cache notes
- Cache reads stable around 5312 for fresh loops, growing to 12816 mid-loop-6 (line 271).
- Cache creation spike: line 67 (cache_creation=2194 mid-loop) and line 203 (cache_creation=3831) caused by large tool_result blobs being re-prefixed; happens whenever a 10-call dig batch returns 10 stale-target rows.
- Largest single input was line 200 with 4286 input_tokens, driven by accumulated tool_result history during the dig storm.

## Quotes worth showing the planner
- Line 244: `calls=dig({"target":"#1"}) | dig({"target":"#1"}) | dig({"target":"#1"}) | dig({"target":"#1"}) | dig({"target":"#1"})` → all five return `out of range (5.2m, need ≤4.5) for oak_log @-26,64,-40` — the model literally retried the same impossible call 5x in parallel.
- Line 125–127: `text=ow—what's that about?\n\nso you teleported to me and immediately smacked me. looks like i was mid-dig on sand (hit cant_reach on the last swing)... what's the move?` — but `say()` only got `"ow—what's that about?"`.
- Line 271: `i've got 5 logs (3 jungle, 2 oak) and SSk1tz is 5 blocks away at -35,63,-34. i need 5 more logs to hit 10 total.` — the 13th consecutive turn opening with an inventory restate; loop never reached 10 before EOF.
