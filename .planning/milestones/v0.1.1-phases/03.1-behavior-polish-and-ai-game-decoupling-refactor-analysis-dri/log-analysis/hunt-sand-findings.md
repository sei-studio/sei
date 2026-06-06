# hunt+sand.txt — Findings

**Log:** logs/hunt+sand.txt
**Session summary:** Owner asks for food, then sand for glass; Sei hunts two sheep, drops oak logs on request, then digs sand and delivers — but skips chat acknowledgement on both action sub-tasks and is interrupted mid-second-sand-run.
**Outcome:** partial success — food and oak handoff completed cleanly; sand task interrupted before completion (only 9 sand delivered, second run still in progress when log ends).
**Iterations observed:** 10 loops (loop-1 through loop-10), with internal iteration counts of 1,1,6,1,1,1,2,1,4,6.
**First-turn say() check:** **MISSING on both action sub-tasks.**

- **Hunt sub-task** (loop-3, owner says "we need food", line 12): first turn calls `follow + attackEntity`, NO `say()`. The reasoning prefix says "got it. we need food and there are two sheep nearby. gonna hunt them for you." but no chat tool was called. Quote: `[06:29:58.420] [haiku!] stop=tool_use text=got it. we need food and there are two sheep nearby. gonna hunt them for you. calls=follow({"entity":"#12"}) | attackEntity({"target":"#12","times":5})`
- **Sand sub-task** (loop-9, owner says "im building a house but need sand for glass", line 35): first turn fires SEVEN parallel `dig()` calls, NO `say()`. Quote: `[06:31:22.282] [haiku!] stop=tool_use text=sand everywhere and sskitz needs it for glass—let's load up. i've got 3 already, need a few more. calls=dig×7`
- **Oak handoff sub-task** (loop-7, line 19): also missing first-turn say — went straight to `dropItem` with empty `text`. Quote: `[06:30:59.022] [haiku!] stop=tool_use text= calls=dropItem({"item":"oak_log","count":2})`

This confirms the user's bug report: the 260505-twx "mandatory first-turn say()" rule is not firing whenever the LLM prefers to launch a tool action on the first turn. Internal `text` reasoning is being treated as a substitute for `say()`.

## Defects (with line refs)

### D-H-1: First-turn say() omitted when LLM goes straight to action
- **Where:** lines 12 (hunt), 19 (oak drop), 35 (sand)
- **What:** All three action sub-tasks open with a tool call (`follow/attackEntity`, `dropItem`, `dig`) and the `text=` reasoning channel contains what should have been said in chat ("gonna hunt them for you", "sand everywhere and sskitz needs it for glass—let's load up"). No `say()` tool was emitted.
- **Why it matters:** Owner sees silent action — exactly the friction the user flagged. The bot's intent gets lost in the reasoning channel, never reaches chat.
- **Suspected cause:** First-turn-say guardrail is advisory in the system prompt rather than enforced by the orchestrator. When parallel tool calls are emitted, the model treats prefatory `text` as fulfilling the "speak first" rule. Likely needs an orchestrator-level enforcement: if first turn of a new owner-chat-triggered loop has no `say()`, inject one or reject and retry.

### D-H-2: Reasoning text addresses the player in second person
- **Where:** lines 12, 14, 19 ("gonna hunt them for **you**"), line 28 ("**you've** still got your 3 jungle logs", "do **you** want to build")
- **What:** `text=` (think) channel uses "you" as if speaking to SSk1tz, but it isn't a chat tool — it's internal scratchpad. The model is conflating thought and speech.
- **Why it matters:** When the say() never fires (D-H-1), this player-directed text is silently lost; when say() does fire, it's redundant.
- **Suspected cause:** System prompt likely doesn't sharply differentiate `text` (private reasoning) from `say()` (public chat); the model leaks dialog into reasoning.

### D-H-3: Tone is still "you/me" not "we"
- **Where:** lines 12 ("gonna hunt them for **you**"), 17 ("**i've** got 3 jungle logs"), 22 ("oak logs are **yours**"), 47 ("sand delivery"), 51 ("anything else for **the** house?"), 75 ("how many blocks **you** need?")
- **What:** Almost all chat is "i / you / yours" framing. Only line 14 (`"got 3 mutton. we're fed."`) and line 35's reasoning ("let's load up") use "we".
- **Why it matters:** User asked for "we" framing. The current tone reads servile/transactional rather than partner-y.
- **Suspected cause:** No explicit pronoun rule in system prompt, or the rule is too soft.

### D-H-4: Punctuation everywhere despite "no punctuation" preference
- **Where:** every chat line, e.g. line 14 `"got 3 mutton. we're fed."`, line 16 `"got food sorted. what's the play—shelter, tools, or exploring?"`, line 51 `"sand is down. need anything else for the house?"`, line 75 `"got 4 sand so far. how many blocks you need?"`
- **What:** Periods, em-dashes, question marks, apostrophes throughout chat output.
- **Why it matters:** User explicitly asked for no punctuation. Not addressed yet.
- **Suspected cause:** No punctuation constraint in prompt, or model overrides it.

### D-H-5: 7-way parallel dig() barrage
- **Where:** line 35 (`calls=dig×7`), line 56 (`calls=dig×5`)
- **What:** Sand collection fires up to 7 parallel `dig({"block":"sand","maxDistance":32})` calls in one turn. Result: at least one consistently fails with "dig failed: Digging aborted" (line 41, line 61) because the bot can't be in two places at once.
- **Why it matters:** Wastes tool slots, produces noisy `is_error` results that the model has to reason over, and one of every batch reliably aborts. Worse: there is no `setGoals` for sand — the bot uses raw multi-dig as a substitute for a "collect N sand" loop.
- **Suspected cause:** No goal-loop primitive for "collect N of resource"; LLM hacks around it by spamming parallel digs. Should be a single `setGoals({"collect": "sand", "count": N})`-style action or a server-side dig-loop.

### D-H-6: First `follow()` of every combat turn returns "target gone"
- **Where:** line 12 (`[06:29:58.421] [act!] follow → target gone`), repeated at 06:30:03, 06:30:09, 06:30:14
- **What:** Every paired `follow + attackEntity` call sees `follow` immediately resolve as "target gone". The attackEntity call still works.
- **Why it matters:** Either follow has wrong semantics for entities the bot is about to attack, or parallel-tool ordering means follow runs after attackEntity already grabbed the target. Either way, follow is a no-op here and shouldn't be paired.
- **Suspected cause:** Race between parallel tool calls — attackEntity sets a combat target that mutually excludes follow's tracker, or follow validates after attackEntity already removed/killed the entity. Could also be a snapshot staleness issue (entity #12 referenced from snapshot taken before combat).

### D-H-7: Snapshot entity refs by # number across turns
- **Where:** line 12 (`follow({"entity":"#12"})` — but #12 in the prior snapshot was SSk1tz, not a sheep; the current-turn snapshot in the same loop shows #4 sheep / #5 sheep / #6 SSk1tz)
- **What:** The model called `entity:"#12"` for a sheep on the very first turn of loop-3, but the loop-3 first turn is BEFORE any tool result, so its snapshot indexing is from the pre-loop state. Next iteration (line 12 cont'd) the snapshot shows #4 sheep, #5 sheep, #6 SSk1tz — totally different numbering, and the model correctly switches to `#4` then `#11` then `#14`.
- **Why it matters:** The first turn worked anyway (attackEntity hit something), but the index-#12 mapping looks fragile. If the snapshot the model saw on turn 1 had different indexing than what the act-layer resolved against, this is silently brittle.
- **Suspected cause:** Snapshot indices are recomputed every turn, so `#N` references are turn-local. If the LLM caches an index from an older snapshot, it dereferences against fresh data.

### D-H-8: PLAYER INTERRUPT injected twice for one chat
- **Where:** lines 67–70
- **What:** `SSk1tz: what are u doing rn?` arrives once at 06:31:50.066, but the orch logs `PLAYER INTERRUPT preserved` twice (`history=6`, then `history=7`) and the haiku gets two consecutive interrupt-prefixed turns (06:31:50.081 and 06:31:50.583). Only the second has the actual chat text inlined.
- **Why it matters:** Wasted LLM call; the first interrupt turn appears to fire without the chat content (no `say()`, no useful action), then a second fires with the content.
- **Suspected cause:** Race between the in-flight haiku call (which was already mid-flight when chat arrived) and the interrupt injection. The orchestrator preserves twice — likely interrupt event AND the chat-receive event both trigger the preservation path.

### D-H-9: goTo "cant_reach" with no recovery strategy
- **Where:** line 64 (`[06:31:49.978] [act!] goTo → cant_reach`)
- **What:** First goTo to SSk1tz at (-35,63,-57) fails as cant_reach. The fix on next turn is just to add `range:3` (line 71) which then succeeds.
- **Why it matters:** Two LLM turns burned on a pathing-precision issue that could be a default. Suggests `goTo` should default to a small range when targeting a player who's standing on a solid block.
- **Suspected cause:** Default goTo precision is exact-block; SSk1tz's tile is occupied so exact destination unreachable.

### D-H-10: Empty say() reasoning prefix on action-only turns
- **Where:** line 19 (`text= calls=dropItem`), line 22 (`text=done.`)
- **What:** Some turns emit empty or near-empty `text=` ("done.", ""). The model isn't using the reasoning channel at all on these turns — implying it sees `text` as optional commentary, not as required private reasoning.
- **Why it matters:** Indicates the prompt doesn't enforce a structured think→act discipline. Also relates to D-H-1: when text is empty, there's clearly no acknowledgement happening anywhere.
- **Suspected cause:** No required reasoning template.

### D-H-11: No combat-time say(); user gets a wall of silence during 4 attack iterations
- **Where:** lines 12 (3 iterations), 13 (2 iterations) — entire loop-3 of 6 iterations only chats once at the end (`got 3 mutton. we're fed.` at 06:30:22.419)
- **What:** From "we need food" (06:29:56) through "got 3 mutton" (06:30:22) — 26 seconds of attack/chase activity, no chat. The bot quietly hunted both sheep with zero verbal updates.
- **Why it matters:** The user experiences this as the bot ignoring them for half a minute. Reinforces D-H-1 — first-turn say is the simplest fix, but mid-task progress chat ("lost one, chasing the second") would also help.
- **Suspected cause:** No prompt rule for periodic progress updates during multi-iteration tasks.

## Positive observations
- Loop accounting is clean: every loop has matched start/terminal markers with iteration counts and cumulative byte tallies (lines 11, 15, 16, 24, 26, 30, 31, 52, 53, 54, 76).
- Final-turn say() rule **does** fire on the hunt task (line 14: `say({"text":"got 3 mutton. we're fed."})`) — the last-turn half of the rule works; only first-turn is broken.
- Owner-prompted handoffs work: "give me the oak ones" → drops 2 oak (lines 17–22). "need sand" → digs and delivers (lines 32–51).
- PLAYER INTERRUPT mechanism resumes prior task correctly: after the "what are u doing rn?" interrupt, the bot answers AND continues toward SSk1tz with the right range fix (lines 71–75).
- Token usage is well-cached: cache_read_input_tokens of 5312 across nearly every turn means the system+context block is hitting the cache reliably; only ~120–650 cache_creation tokens per turn for the dynamic delta. Total per-turn input is mostly 400–900 tokens.

## Token / cache notes
- Steady-state cache hits: 5312 cache_read tokens recurring (lines 12, 16, 17, 18, 19, 22, 28, 35, 56) — system prompt + diary block is cached cleanly.
- Cache deltas (cache_creation) seen: 155, 126, 123, 16, 412, 537, 514, 514, 481, 648 — moderate, no spikes.
- One bigger top-up: 5942 cache_read on line 50 (sand-delivery turn) and 6679 on line 74 — the cache is growing as the loop accrues tool_result history. Worth watching for the >10k inflection.
- Output tokens: 60–410 per turn, with 411 (line 35, the 7-way dig spam) and 343 (line 56, the 5-way dig) being notable spikes — both correspond to D-H-5.
- No cache-bust events visible in this log.

## Quotes worth showing the planner

> **Missing first-turn say() on hunt** (line 12):
> `[06:29:58.420] [haiku!] stop=tool_use text=got it. we need food and there are two sheep nearby. gonna hunt them for you. calls=follow({"entity":"#12"}) | attackEntity({"target":"#12","times":5})`

> **Missing first-turn say() on sand** (line 35):
> `[06:31:22.282] [haiku!] stop=tool_use text=sand everywhere and sskitz needs it for glass—let's load up. i've got 3 already, need a few more. calls=dig×7`

> **Missing first-turn say() on oak handoff** (line 19):
> `[06:30:59.022] [haiku!] stop=tool_use text= calls=dropItem({"item":"oak_log","count":2})`

> **Tone — only "we" line in the entire session** (line 14):
> `[chat->] got 3 mutton. we're fed.`

> **Punctuation example** (line 16):
> `[chat->] got food sorted. what's the play—shelter, tools, or exploring?`

> **Parallel dig storm + guaranteed abort** (lines 35–41):
> `calls=dig({"block":"sand"…}) × 7` → 5 succeed, 1 `dig failed: Digging aborted`, 1 succeeds.

> **follow no-op pattern** (line 12):
> `[06:29:58.421] [act!] follow → target gone` (immediately after a paired follow+attackEntity, target was alive).

> **Double interrupt** (lines 67–70):
> `[sei/orch] PLAYER INTERRUPT preserved (loop=loop-10-motoiw5x, history=6)` … then `(history=7)` for one chat message.

> **goTo precision fix-up** (lines 64–71):
> `goTo → cant_reach` then `goTo({"x":-35,"y":63,"z":-57,"range":3}) → reached` — burned a turn on default-range.
