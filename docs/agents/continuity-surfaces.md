# Continuity for a game or timed surface (REQUIRED)

**Every surface where the character talks to the player MUST carry continuity
in BOTH directions.** Context flowing IN is the easy half and is usually done
by reflex, because a surface that does not load the persona is obviously
broken. The OUT half is the one that gets skipped, and it is invisible when it
is missing: the game plays fine, and then the character has no idea it ever
happened. Draw! shipped that way first (260727) and was fixed at 260728; chess
had it from the start. The contract is three things.

1. **IN** — the surface's `prepareCall` equivalent passes `persona`, `memory`
   (`readMemoryTail`, the 12000-byte MEMORY.md tail via `humanizeMemoryStamps`),
   `summary` + `history` (`readChatContext`) and `knowledge`
   (`readKnowledgeForPrompt`) into `buildSystemBlocks`. Whole-game constants go
   in `extraStable` so they ride inside the cached region.
2. **OUT, long-term** — offer `REMEMBER_TOOL` (`src/main/chat/chatPrompts.ts`)
   on the surface's turns, so the character can write to the same per-character
   `MEMORY.md` that chat, voice and the bot share. A surface outside a game
   world passes `appendMemory(file, text, undefined, { section: 'app' })` (261020)
   so its lines are not filed under the last game world. In a **tool loop**, answer it
   with a `tool_result` note and treat `appendMemory() === 0` as "duplicate, not
   written" rather than claiming a save. In a **single-shot** call, honor it
   inline after the response (`honorRememberCalls`) or the write is silently
   dropped. Tell the prompt what is NOT worth saving: Draw!'s words come from a
   random bank, so the contract says "save the person, not the round".
3. **OUT, short-term** — write ONE `event: { kind: 'play', ... }` transcript row
   at the surface's single end choke point, carrying enough shape to be worth
   summarizing, then fire `void foldIfDue(characterId, persona.expanded)`
   fire-and-forget. Without the fold the surface's rows are the ones that never
   make it into the rolling summary.

**What happened in a game session (261113, v0.7 consistency D1).** A play row
(`chat/playSummary.ts buildPlayRow`) may carry a story in its event: `recap`,
the companion's own first-person recap, or `lines`, the last few digest lines
when there is no recap. Model-facing only; the renderer shows `text`. Where it
is read:
- the chat transcript (`toMessages`, appended inside the shared-history note);
- the fold: a play row inside a fold's batch is folded as a "Game session"
  line (`chat/continuityCore.ts selectFold`). Play rows never move the
  watermark; a row sits in the batch when its position is inside it, so each
  folds exactly once and leaves the chat history in the same fold its
  neighbours do;
- the MC launch handoff (`launchContinuityFrom`, role `'session'`), which the
  bot's seed reads as "Game session" rows (orchestrator `chat_continuity`).

The bot games' recap comes from the session-end call that already runs when
the PLAYER ends the session (`playerEndNextStep.ts startSessionEnd` with
`recap: true`: the same call, 400 max tokens, a `recap:` line before the plan
lines). `closePlaySession` waits for it at most `RECAP_WAIT_MS` (20 s) and
stops waiting when an account switch begins (`playRecap.ts awaitRecap`,
`scopeBarrier.onScopeSwitchStart`); every other route writes the `lines`
fallback, no LLM. Analytics: `play_recap` (shape only, `playRecapProps`). A
new game surface whose end call could write a recap should pass it to
`buildPlayRow` the same way.

**Facts before the summary (261113, v0.7 consistency D2).** The fold is
shown the memory notes (the chat's 12000-byte tail) and returns, next to its
`<summary>`, a `<remember>` block of durable facts memory does not have yet
(`foldPrompt.ts extractRememberTag`, at most `FOLD_MAX_FACTS`); the bot game's
session-end call returns `remember:` lines the same way (at most three, shown
30 memories). `chat/memoryFacts.ts saveFacts` writes them (fold: app section,
stamped with the batch's newest message) and drops any whose normalized text
matches an entry anywhere in the file. A fact that changed is written with
"now" wording, and `COMPACTION_SYSTEM` keeps only the newest of two entries
that disagree.

`continuityCore.ts` is the pure half of `continuity.ts` (selection, fold call,
reads, handoff, no electron): the consistency eval
(`scripts/quality-eval/consistency`) runs it from the checkout it measures, so
keep electron and anything that imports it out of that file.

Deliberately NOT persisted: the surface's own per-line chat. A guessing turn is
a wall of "cat? dog? is that a house?" that would bury real conversation in the
transcript and re-bill it in every future prompt. Summarize the session in the
play row instead.

One place where following chess is WRONG: chess hands every turn kind a single
tool array so the cache prefix never flips. That is right when turns are
seconds apart, and wrong when they are minutes apart (Draw!'s are three, past
the cache TTL already), where per-turn-kind arrays cost nothing and keep a
guessing turn from being handed a drawing tool. Pick per surface and write down
which you picked.
