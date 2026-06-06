# explore.txt — Findings

**Log:** logs/explore.txt
**Session summary:** Sei joins on a beach, proposes scouting inland for a base, gets repeatedly stuck in jungle/forest pathfinding, owner teleports it to a plains biome, idle tick fires, diary written.
**Outcome:** partial — owner had to /tp the bot out of a water pit; conversation never produced an actual built structure
**Iterations observed:** 10 loops (loops 1–10), iteration counts mostly 1–2, two long ones at 9 and 11

## Defects (with line refs)

### D-E-1: goTo flails on near-arbitrary inland coordinates
- **Where:** lines 41–105 (consecutive `cant_reach` chain across loops 4 and 6)
- **What:** Bot calls `goTo({x:100,y:64,z:0,range:30})`, then 20, 0, -100, -40, etc. — at least 9 consecutive `cant_reach` returns. It never simplifies the strategy (e.g., dig path, place blocks, climb). Eventually owner teleports it (line 110).
- **Why it matters:** This is the dominant failure mode in the entire log. The bot looks helpless and verbal output ("stuck in a water pit, can't pathfind out. help?", line 107) is the only escape.
- **Suspected cause:** LLM picks goal coordinates with no awareness of pathfinder's actual reachability radius/obstacles. No fallback: bot doesn't try `dig` to clear a vertical column, doesn't `placeBlock` to bridge water, doesn't break the goal into smaller hops first. Snapshot doesn't surface "you are surrounded by water/leaves" semantically.

### D-E-2: Internal `text` leaks into `say()` verbatim — duplicate first-person thinking
- **Where:** line 113
- **What:** `text=i got teleported to you, nice. we're in a plains biome now—looks way better than that forest mess. what should we do here?` and `say({text:"i got teleported to you, nice. we're in a plains biome now—looks way better than that forest mess. what should we do here?"})` — identical strings.
- **Why it matters:** The reasoning channel and the chat channel collapse. Long internal monologues will start hitting chat verbatim when the model is lazy.
- **Suspected cause:** No prompt-level discouragement against copying `text` to `say`. The "first/last turn say() mandatory" fix (260505-twx) may have made models reach for `text` content as the most-recent thought.

### D-E-3: "We" framing is inconsistent; "you/me" still dominant
- **Where:** lines 15, 21, 30, 38, 57, 64, 134, 167
- **What:** Mix of "we explore inland" (good), "what're we doing today?" (good) but also "stuck in a water pit, can't pathfind out. help?" (line 107), "what kind of base are we building?" (line 134, good) vs internal "I" everywhere ("I'm at -64,63,45...", "I'm stuck...", line 89). Punctuation: hyphens, em-dashes, question marks all present despite stated tone goal of "no punctuation."
- **Why it matters:** Tone target from project notes — "we" framing + no punctuation — not yet enforced.
- **Suspected cause:** System prompt isn't asserting these tone constraints, or model is overriding them when reasoning intensifies.

### D-E-4: Asks redundant clarifying questions back-to-back
- **Where:** lines 21, 30, 64, 71, 123, 134, 167
- **What:** `"what's the plan?"` → owner says "up to you" → `"thinking we explore inland, scope out where to build a real base?"` → `"good spot to build?"` → forest rejected → `"want me to scout somewhere else?"` → `"build here or scout more?"` → `"what kind of base are we building?"` → after diary, again `"what kind of structure do you want?"`. Six "what should we do?"-class messages in 3 minutes.
- **Why it matters:** Diary explicitly says "SSk1tz appreciates action over endless questions" (line 12) — bot ignored its own owner-fact. Direct contradiction with stored memory.
- **Suspected cause:** Diary content not actually steering behavior; model treats it as flavor text rather than instructions. No mechanism to surface owner-prefs as constraints.

### D-E-5: Ignores explicit owner instruction "come here" partially
- **Where:** lines 98–107
- **What:** Owner says "come here". PLAYER INTERRUPT fires (line 99). Bot acknowledges "got it, coming to you now" (line 103) and calls `goTo({x:-81,y:60,z:58,range:2})` — but this immediately `cant_reach`. Bot then loops on `cant_reach`, never escalates to digging/swimming/placing, and finally just chats "stuck in a water pit, can't pathfind out. help?" (line 107) terminating the loop without resolving.
- **Why it matters:** Direct owner command unfulfilled. The bot gives up by chatting rather than persisting.
- **Suspected cause:** No retry-with-different-strategy logic at loop level when same tool fails repeatedly. Loop terminates on `say()` regardless of whether owner's request was honored.

### D-E-6: Snapshot scenery descriptions are generic and miss obvious features
- **Where:** lines 40, 49, 79, 91
- **What:** Snapshot at line 40 shows 13 grass_block, 12 vine, 9 oak_leaves — bot says "dense jungle, lots of vines and leaves." But snapshot at line 79 includes 4 salmon entities and the bot never mentions seeing fish. Line 91 shows a river biome with squid; bot just says "stuck in a river." Line 121 lists 2 pigs and 5+ salmon; bot says only "nice flat plains, decent spot."
- **Why it matters:** Bot fails to narrate the world richly — the diary becomes generic ("trial-and-error teamwork") instead of specific ("we passed a pod of salmon, two pigs grazing"). Hurts personality and memorability.
- **Suspected cause:** Snapshot lists entities but prompt doesn't instruct LLM to weave them into observations. Possibly entity list buried after `nearby blocks` and gets de-prioritized.

### D-E-7: Coordinate talk leaks into both `text` and `say()`
- **Where:** lines 44, 53, 86, 89, 92, 106
- **What:** Internal: "SSk1tz is at -81,60,58", "i'm at -64,63,45". Player-facing `say()` mostly avoids coordinates (good), but lines like "stuck in a water pit, can't pathfind out. help?" expose technical helplessness. Bot reasons in raw coords, not landmarks.
- **Why it matters:** Robotic affect. Project goal is companion-feel; coord-arithmetic-as-cognition undermines that.
- **Suspected cause:** Snapshot leads with raw `pos: -64,63,52` and absolute coords for every nearby block. Model's spatial reasoning anchors on those.

### D-E-8: Idle tick produces a goTo+chat instead of standing/observing
- **Where:** lines 126–134 (loop-9 fired by `event=sei:idle` after ~60s of inactivity)
- **What:** Idle event fires, bot teleports its position from -90,66,48 → -97,66,42 (just walks 10 blocks toward owner) and asks yet another question. Idle behavior is functionally identical to a chat-triggered loop.
- **Why it matters:** Idle should be ambient/observational ("watches the pigs", "scans the horizon") — not another nag-the-owner loop. Currently idle == "ask another question."
- **Suspected cause:** No idle-specific prompt branch. The orchestrator passes idle event but the LLM treats it the same as any other turn.

### D-E-9: Loop iteration count of 9 with no terminal say()
- **Where:** lines 33–65 (loop-4-motox3h7, iterations=9)
- **What:** Loop-4 runs 9 LLM turns chaining goTo/dig/dig/goTo/say/goTo/say. Mid-loop `say()` calls fire (lines 38, 57, 64), but the loop terminates only because the LLM decided to. The `say()` was a terminal coincidence, not a structural property.
- **Why it matters:** "First/last turn say() mandatory" rule (per project notes) doesn't appear enforced — first turn at line 35 has no `say()` (it's combined with `goTo`, OK), but middle turns at 41, 44, 50, 53, 60, 62 have neither, leaving the owner with no progress narration during a 30-second pathfinder thrash.
- **Suspected cause:** Mandatory-say is enforced only at loop start/end, not "if no progress in N iterations, narrate." Owner sees silence while bot flails.

### D-E-10: Memory recall is shallow — diary referenced but not internalized
- **Where:** Diary loaded at every turn (e.g., line 12), repeats "SSk1tz appreciates action over endless questions" three times. Bot's behavior (D-E-4) directly violates this.
- **Why it matters:** Diary occupies ~5KB cached input every turn but doesn't change behavior. Either we trim it or we make it operationally binding.
- **Suspected cause:** Diary stored as narrative prose, not as an "owner_preferences" dict. LLM treats it as backstory, not policy.

## Positive observations

- Cache hit rates excellent: most turns show `cache_read_input_tokens: 5312` while `cache_creation_input_tokens: 0` (lines 20, 29, 70, 113). System prompt+diary+owner block is stable and well-cached.
- PLAYER INTERRUPT mechanism worked (line 99): owner's "come here" preempted the goTo loop within ~500ms.
- Diary compaction fired at expected boundary (line 137–162) and produced a coherent ~140-token entry.
- `say()` did fire on first turn and last turn of most loops (lines 14, 21, 30, 64, 70, 107, 113, 134, 167) — the 260505-twx fix is largely working.
- Tone in `say()` outputs is mostly casual lowercase and short (good): "back on the beach. got jungle logs and sand—what's the plan?" (line 21).

## Token / cache notes

- Steady-state input: ~440–900 tokens per turn with cache hits returning ~5,300 cached. Output: 90–230 tokens.
- Cache-bust spike at line 162 (diary write): `input_tokens: 13,109, cache_read: 0` — diary compaction prompt does not reuse the standard cached prefix. One-shot full-context dump, expected.
- Minor cache creation churn (~18–620 tokens) on most turns from the recent_events delta — line 56 (621), line 133 (642), line 166 (1077) — these are normal incremental writes.
- No iteration-cap (30) hits; longest loops were 9 and 11 iterations.

## Quotes worth showing the planner

- **Goal-vs-memory contradiction:** Diary says "SSk1tz appreciates action over endless questions" (line 12) ↔ bot asks 6 clarifying questions in 3 minutes (lines 21, 30, 64, 71, 123, 134).
- **Help-by-chatting failure:** "stuck in a water pit, can't pathfind out. help?" (line 107) — bot's escape from 9 consecutive `cant_reach` is to ask owner to /tp.
- **Verbatim text→say leak:** Line 113, identical reasoning copied to chat.
- **Generic diary outcome:** "it was less about grand plans and more about trial-and-error teamwork" (line 162) — bland, no specific landmarks/entities/coords-as-places retained.
- **Idle = nag:** Loop-9 (line 126), idle-triggered, ends with "alright, we're here. what kind of base are we building?" — nothing observational.
