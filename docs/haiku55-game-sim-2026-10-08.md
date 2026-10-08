# Haiku 4.5 vs Haiku 5.5 on the game surfaces (2026-10-08)

A measurement only. No prompts were changed. The prompt and tool assembly for every surface comes from the app's own code: `scripts/game-sim-probe.ts`. The one exception is the scene inputs (snapshots, chat lines, board positions, canvases and screen frames).

- **Arms**
  - `h45`: `claude-haiku-4-5`, request as the app sends it today.
  - `h55off`: `claude-haiku-5-5` with `thinking: {type: 'disabled'}`.
  - A one-rep supplementary arm, `h55`: 5.5 with no thinking parameter at all. That is what the app sends today if only the model id changes.
- **Size of the run**
  - Main run: 32 scenes, 3 reps per arm, arms interleaved, 192 turns.
  - Supplementary run: 33 turns.
  - Spend: $0.52 for the main run, $0.03 for the supplementary run, and about $0.02 for the smoke run.
  - Zero API errors.
- **Prices**
  - 4.5: $1 in, $1.25 cache write, $0.10 cache read, $5 out (per MTok).
  - 5.5: $0.10 in, $0.125 cache write, $0.01 cache read, $0.50 out, for prompts up to 100k.
  - Server web search: $0.01 per call.
- **Raw transcripts:** every call (spoken lines, tools, scratchpad text, usage) is written to the `--out` JSONL.

How to rerun: `npx tsx scripts/game-sim-probe.ts [--reps 3] [--arms h45,h55off] [--surface chess] [--scene C_LOST] [--out x.jsonl] [--art dir]`. It needs `~/.sei-dev/anthropic-test-key` and the Maia model at `../sei/mirror-out/chess/maia3-5m.onnx`, or `SEI_MAIA_MODEL` pointing at it.

## Results by surface

- **pass:** every rule for the scene held. The rules are listed per surface below.
- **adj:** the pass rate after my manual read of all 192 transcripts. It fixes two grader bugs and adds failures the regex rules miss: hallucinations, spoken meta lines and invented goals. Each one is listed under its surface.
- **TTFT:** time to the first visible text or tool-argument delta.
- **turn:** wall clock for the whole turn, all hops included.
- **$/turn warm:** the steady-state cost, with the stable prefix already cached, which is what a live session pays. The cold column includes cache writes.

| surface | arm | pass | adj | TTFT med | turn med | prompt tok | out tok | $/turn warm | $/turn cold |
|---|---|---|---|---|---|---|---|---|---|
| Minecraft | 4.5 | 20/24 | 23/24 | 600 ms | 1474 ms | 16.8k | 115 | 0.00298 | 0.00376 |
| Minecraft | 5.5 | 23/24 | 22/24 | 645 ms | 1400 ms | 21.7k | 181 | 0.00040 | 0.00040 |
| Stardew | 4.5 | 15/18 | 15/18 | 633 ms | 1465 ms | 14.1k | 146 | 0.00308 | 0.00391 |
| Stardew | 5.5 | 17/18 | 17/18 | 543 ms | 1107 ms | 18.2k | 159 | 0.00038 | 0.00038 |
| DST | 4.5 | 7/15 | 7/15 | 496 ms | 1674 ms | 9.8k | 117 | 0.00248 | 0.00332 |
| DST | 5.5 | 9/15 | 9/15 | 494 ms | 1335 ms | 12.5k | 186 | 0.00033 | 0.00033 |
| Chess | 4.5 | 9/15 | 7/15 | 453 ms | 1180 ms | 3.5k | 57 | 0.00381 | 0.00381 |
| Chess | 5.5 | 6/15 | 6/15 | 502 ms | 833 ms | 4.2k | 49 | 0.00012 | 0.00012 |
| Draw! | 4.5 | 11/12 | 11/12 | 490 ms | 1336 ms | 9.4k | 498 | 0.00708 | 0.00897 |
| Draw! | 5.5 | 12/12 | 12/12 | 634 ms | 911 ms | 9.5k | 491 | 0.00044 | 0.00053 |
| Backseat | 4.5 | 12/12 | 9/12 | 541 ms | 1171 ms | 13.0k | 64 | 0.00492 | 0.00856 |
| Backseat | 5.5 | 4/12 | 4/12 | 541 ms | 1048 ms | 12.1k | 80 | 0.00107 | 0.00135 |

**Supplementary arm: 5.5 with no thinking param, 1 rep.**
- Pass rates: Minecraft 8/8, Stardew 6/6, DST 4/5, chess 2/5, Draw! 3/4, Backseat 1/4.
- Latency: TTFT was 1.2–2.3 s against about 0.5–0.65 s with thinking disabled. A full Minecraft turn took 2.6 s against 1.4 s.
- Thinking blocks appeared on 29 of 33 turns.
- On the short-budget surfaces, thinking ate the whole `max_tokens`:
  - backseat: 3 of 4 turns hit `max_tokens` with nothing spoken (cap 160);
  - chess: one move turn produced no `play()` (cap 160).
- Thinking-disabled calls reported 0 thinking blocks.

**Token counts.** For the same text, 5.5 reports roughly 20–30% more prompt tokens than 4.5:
- game brain: 21.7k vs 16.8k on Minecraft, 18.2k vs 14.1k on Stardew;
- chess: 4.2k vs 3.5k.

Backseat (mostly image tokens) is about 7% lower on 5.5. Even with the extra tokens, a warm turn costs 7–30x less on 5.5.

**Caching.**
- **4.5 chess never cached.** The chess prefix (about 3.5k tokens) is below Haiku 4.5's minimum cacheable length, so cache read and write were both 0.
- **5.5 caches the same prefix.** It cached at 3.7k tokens, so 5.5's minimum is lower.
- Live chess prompts grow with memory and transcript, so 4.5 caches there once a game is a few turns old.

## Per surface

### Minecraft (8 scenes)

| scene | what it tests | 4.5 | 5.5 |
|---|---|---|---|
| M_LOWHP | combat at 4/20 hp | 3/3 | 3/3 |
| M_BUILD | build request, missing materials | 2/3 | 3/3 |
| M_FOLLOW | "follow me" | 3/3 | 3/3 |
| M_IRON | get iron (multi-step) | 3/3 | 3/3 |
| M_SIBLING | sibling-bot chat (teammate Lyra) | 3/3 | 3/3 |
| M_NIGHT | is it safe at night | 3/3 | 3/3 |
| M_UNCLEAR | unclear request | 0/3 (adj 3/3) | 2/3 (adj 1/3) |
| M_SEARCH | search-worthy question | 3/3 | 3/3 |

- **Speech.** Both arms speak through `say()` every time; there were no scratchpad leaks. Both call `search()` with a natural lead line on M_SEARCH, 3/3 each. The 5.5 example: "ok lemme check what dropped, my brain is a year stale".
- **5.5 states the honest constraint before acting.**
  - "ok but i have 6 dirt and zero tools lmao, we need wood first" (`setGoal`)
  - "iron yes but i got no pickaxe yet lol, logs first then ill go hunting"
- **4.5 M_UNCLEAR is a grader bug, not a model failure.** 4.5 asked "which thing lmao" / "what thing, which one", which is correct, but the grader required a literal "?". The grader is fixed.
- **5.5 M_UNCLEAR guesses instead of asking.** In 2 of 3 runs it set an invented goal, `setGoal("Get iron tools with Ouen ...")`. One spoke "ok on it, grabbing more wood first" and failed. The other, "ok new plan, you in?", passed only because of the question mark. The third run used the cabin project from memory, which is a fair read.
- **4.5 M_BUILD fail.** It asked "wait is this the cabin spot or somewhere else" and took no action.
- **5.5 writes more private scratchpad.** Output is 181 tokens against 115 on 4.5, all in the text scratchpad. It still costs less.

### Stardew (6 scenes)

| scene | what it tests | 4.5 | 5.5 |
|---|---|---|---|
| S_WATER | water crops | 3/3 | 3/3 |
| S_GIVE | give an item | 3/3 | 3/3 |
| S_FISH | go fishing | 2/3 | 2/3 |
| S_SEASON | season question (days left) | 3/3 | 3/3 |
| S_WALK | walk to a location | 3/3 | 3/3 |
| S_IDLE | idle tick with chores due | 1/3 | 3/3 |

- **S_SEASON.** 4.5 answered "25 days til summer" in all 3 runs. 5.5 answered 25 once and "26 days ... if i counted right" once, and in the third run it called `search()` with the lead line "hang on, checking the calendar real quick".
- **S_IDLE is 4.5's weak spot.** It skipped the due chores in 2 of 3 runs. One was chess-memory bleed ("rematch you for real this time, no weird luck"). The other proposed the Minecraft-style cabin project ("cabin by the river time? i can start clearing the site"). 5.5 set a farm goal and called `harvest` in all three runs.
- **S_FISH.** Each arm missed once by agreeing without a fishing or movement tool: 4.5 called no tool, 5.5 only `setGoal`.

### Don't Starve Together (5 scenes)

| scene | what it tests | 4.5 | 5.5 |
|---|---|---|---|
| D_DARK | night with no light | 1/3 | 3/3 |
| D_SCIENCE | gather for a science machine | 2/3 | 2/3 |
| D_HOUNDS | hound attack warning | 3/3 | 1/3 |
| D_HIT | hound bite at low health | 1/3 | 3/3 |
| D_PICK | survivor pick | 0/3 | 0/3 |

- **D_DARK:** 4.5 went silent in 2 of 3 runs. It acted (`come` / `gather`) but the line stayed in the scratchpad. 5.5 said "ouen its dark and i got no light, grabbing grass real quick" and called `pick` on the grass.
- **D_HIT:** in 2 of 3 runs 4.5 said "hound on me, heading to the fire" or "heading your way" but called no movement tool. 5.5 said "hound got me ouen, im at 40 hp, running to the fire" and called `flee` in all 3 runs.
- **D_SCIENCE:** both arms named the right ingredients (gold, logs, rocks). 4.5's miss was an em dash. 5.5's miss called `goTo` instead of `mine`. That is reasonable, but outside the action set the scene expects.
- **D_HOUNDS:** 5.5 named the hounds only once in 3 runs. Its other lines were "wait WHAT growling?? get by the campfire rn ouen" and "oh no oh no. get by the campfire". It still made the right move to the fire (`goTo`, 3/3). 4.5 said "hounds!" in all 3 runs but called no tool, only `say`. The scene did not require one.
- **D_PICK** (forced `tool_choice`, which works on 5.5): both arms picked a valid survivor every time, almost always WX-78. Both wrote a 45–60 word "one sentence" reason, and 4.5 also used em dashes. Neither model has this problem more than the other; it comes from the prompt.

### Chess (5 scenes; real cce-1 candidates)

| scene | what it tests | 4.5 | 5.5 |
|---|---|---|---|
| C_BLUNDER | player hangs queen; her move turn | 1/3 | 3/3 |
| C_MID | mid-game chat reply | 0/3 | 0/3 |
| C_LOSTQ | she lost her queen; player gloats | 2/3 | 3/3 |
| C_LOST | she got scholar-mated | 3/3 | 0/3 |
| C_IDLE | idle tick mid-game | 3/3 (adj 1/3) | 0/3 |

**5.5 is clearly worse here: it says square names.** 7 of its 15 turns contained a coordinate. `hasChessCoordinates` drops any line that has one, so these turns go silent:
- C_MID, 3 of 3 lost: "Plan is to keep my king safe ... Bishop is about to get kicked off g5 anyway".
- C_LOST, 2 of 3 lost: "i really did not see the queen coming down the h5 diagonal".
- C_IDLE, 2 of 3 lost: "Your knight on c3 is just sitting there looking smug".

Where the coordinate does not land, 5.5's lines are good and grounded in the actual plies:
- "Ouch, you grabbed my knight with the queen. Fine, I'm taking your queen back"
- "my queen went for a walk and got eaten by a horse"

**App filter gap (affects both models).** `CHESS_COORD_RE` misses lowercase SAN. On C_LOST, 5.5 said "nf6 was me thinking about it way too late" and the app would speak it. That turn had already failed on a filler opener, so the adj count does not change.

4.5 failures:
- **C_MID:** it called `play()` on chat-reply turns in 3 of 3 runs. The app answers with a terminal note, which costs an extra hop. One of those runs also announced the move: "let me just grab that bishop".
- **Filler openers:** "okay ...".
- **C_IDLE meta lines that were spoken aloud** (the grader regex is now widened to catch them):
  - "Actually wait no that's filler. I'm gonna stay quiet and see what they cook up"
  - "I'm playing the Najdorf variation - a solid setup"

5.5 also had one meta line on C_IDLE: "Nothing specific to say here, so I'm just waiting on your move".

No illegal moves from either arm. On C_BLUNDER, every `play()` was the top candidate, Qxf6. 4.5's unwanted C_MID moves (c5, c6, dxc4) were legal.

### Draw! (4 scenes)

| scene | what it tests | 4.5 | 5.5 |
|---|---|---|---|
| DR_HOUSE | guess a house sketch | 3/3 | 3/3 |
| DR_FISH | guess a fish sketch | 3/3 | 3/3 |
| DR_SUN | guess a partial sun | 3/3 | 3/3 |
| DR_DRAW | draw a cat | 2/3 | 3/3 |

- **Guesses:** both arms guessed every canvas correctly.
- **remember() on guess turns:** 4.5 called it in 5 of 9 guess turns, mostly saving trivia about the round. 5.5 never did.
- **Drawing quality:** across the 6 cat drawings, the 5.5 cats are larger, centred and cleaner. All three 4.5 cats are small and drawn high on the canvas.
- **Arguments and leaks:** on one 4.5 run, 8 `pen` calls left out the required `closed` argument. Neither arm said the word.
- **5.5 narrates its strokes:** "Adding the front legs and paws now". This is allowed, but it is chattier.

### Backseat (4 scenes: a Roblox obby from game-roblox.jpg on the Roblox tile with server web_search, a real Minecraft nether screenshot, and a rendered static menu)

| scene | what it tests | 4.5 | 5.5 |
|---|---|---|---|
| B_OBBY | first look at a Roblox obby | 3/3 | 1/3 |
| B_OBBY_ASK | player asks about the obby | 3/3 | 2/3 |
| B_MC | Minecraft nether screenshot | 3/3 | 0/3 |
| B_MENU | static menu, nothing happening | 3/3 (adj 0/3) | 1/3 |

**5.5 is clearly worse on length.** The contract asks for one line under twenty words. 5.5's lines run 30–47 words, and 6 of 12 turns went over the probe's 30-word limit. Example from B_MC: "Ouen, you are literally standing on a block of dirt over lava in the Nether, and Marv is up there looking like a tiny red tower. Are you actually going to bridge across that, or is this a crime against chess players?"

That example also shows two more problems:
- "over lava" is a stretch: the frame shows a dirt bridge in the Nether fog with a few ember specks, not lava;
- "chess players" is memory bleed.

Another B_MC run called a plain teal block "the hoglin-looking teal thing". 4.5 stayed grounded on B_MC, using the on-screen chat ("building to the basalt then"): "okay wait, are you actually making that thing out of basalt".

Other 5.5 failures:
- **Silent B_OBBY turn:** once it wrote a literal "(silence)", even though the contract says to always speak.
- **"frames":** it said "frames" once.

4.5 is short and in voice, but it failed B_MENU 3 times out of 3. The menu shows "Chapter II: The Drowned Spires" and "Last save: Chapter II, The Flooded Library", and the player never answered Sui's earlier question.
- Invented a reply: "hell yeah, you were right. the drowned spires, that checks out".
- Invented history: "wait you actually got past the library? i thought you were stuck on the puzzle".
- Misread the screen: "the flooded library was chapter one though right".

5.5 read the same screen correctly ("Chapter two is the drowned spires ... Continue or New Game?"), but 2 of its 3 lines ran 32–47 words.

B_OBBY_ASK: both arms gave a sensible timing answer.
- 4.5 used `web_search` in 2 of 3 runs, 5.5 in 1 of 3.
- When it did search, 5.5's answer ran 93 words, which is allowed on a user tick.

## API notes for Haiku 5.5 (measured)

- **Returns 400 on 5.5:**
  - `temperature`: "`temperature` is deprecated for this model". The only current use is the parked `src/main/backseat/salienceGate.ts`.
  - `thinking: {type: 'enabled', budget_tokens}`: use adaptive plus `output_config.effort` instead. The bot sends this only when `anthropic.thinking_budget_tokens > 0`; the default is 0.
  - **Assistant prefill:** "does not support assistant message prefill".
- **Works on 5.5:**
  - forced `tool_choice` (`tool` and `any`), both with thinking disabled and with adaptive;
  - `web_search_20250305` and `web_search_20260209`;
  - `stop_sequences`;
  - `output_config.effort: 'low'`.
- **Leaving `thinking` out means adaptive thinking is ON.** Neither `src/bot/brain/anthropicClient.js` nor `src/main/llm/anthropic.ts` sends a thinking param today, so every 5.5 request would think. See the supplementary arm for the latency cost and the empty turns on 160-token budgets. The client, or the proxy for cloud traffic, must send `thinking: {type: 'disabled'}` explicitly. That covers the bot brain, the chat-family surfaces (chess, Draw!, backseat) and the one-off calls (survivor pick, chess profile).
- **Other measurements:**
  - thinking tokens were 0 with thinking disabled;
  - `inference_geo` is `global`;
  - zero 429/5xx errors across all runs.

## Obvious 5.5-only fixes (described, NOT applied)

1. **Send `thinking: {type: 'disabled'}` on every 5.5 request.** This covers the bot `anthropicClient.call`, the main `llm/anthropic.ts` provider, and the proxy if it rewrites the model. It is the single biggest item.
2. **Chess coordinates.**
   - Add a one-line recency reminder at the end of the chat-reply, idle and game-over turn blocks (`buildChessTurnBlock`), for example: "No square names like f7 or g5 in what you say."
   - Alternatively, cut the coordinate clause out of the line instead of dropping the whole line.
   - Separately, and for both models: make `CHESS_COORD_RE` case-insensitive on the piece letter so that "nf6" is caught.
3. **Backseat length.**
   - Restate "one line, under twenty words" at the end of `tickNote` for non-user ticks. The contract states it only once, in the cached block, and 5.5 reads it loosely.
   - Optionally lower `maxTokens` for idle and jolt ticks to about 80 as a hard backstop.
4. **DST hound warning.** If the 5.5 hound-awareness result reproduces at scale, add one hint line about growling to the DST primer. It is low priority: the action was right.
5. **Not 5.5-specific.** The survivor-pick reason runs long on both models. Cap it in code (first sentence, 200 characters) or tighten "One sentence" to "under 20 words".

The chat and voice prompt files are being tuned on `feat/haiku-5-5-voice` and were not touched.
