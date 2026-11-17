# Bot / LLM internals (`src/bot`)

**Single-layer brain.** One LLM call combines reasoning *and* action dispatch —
there is no separate planner/dispatcher. Default model `claude-haiku-5-5`
(`COMPANION_MODEL` in `src/shared/llmCatalog.ts`, mirrored in `src/bot/config.js`),
**20s timeout** (`anthropic.timeout_ms`). Haiku 5 turns adaptive thinking ON
when a request has no `thinking` field and rejects temperature, fixed thinking
budgets and prefill, so every request builder runs
`applyAnthropicModelDefaults` (`src/bot/brain/llm/anthropicModelDefaults.js`),
which sends `thinking: {type: 'disabled'}` and strips those fields (261008).

**Closed, Zod-typed action registry.** The LLM never writes code or raw
coordinates — it calls registered tools only.

- Generic registry core: `src/bot/registry.js`.
- Minecraft action set: `src/bot/adapter/minecraft/registry.js` — **18 world
  actions** registered (follow/come/goto, dig, find, gather, build, place,
  equip, consume, sleep, container ops, etc.).
- Plus the brain tools wired by the orchestrator: `remember`, `forget`,
  `setGoal` / `clearGoal`, `end_loop`, `say`, `quit_game`, `end_call`, and
  (260909) the web pair `search` / `visit` (below).

**Speech (say() tool).** The LLM's **text output is a private scratchpad** — it
is NOT sent to chat. The bot speaks only by calling the **`say` tool** (a
brain-level inline tool, registered in `personalityTools`); `emitSayCalls()` in
`src/bot/brain/orchestrator.js` emits each call up front (before any action
dispatches, so a boast lands before the swing) and `postProcessSay()` normalizes
it before it reaches in-game chat. No `say()` call → silence. **A say()-only
turn is "silence" for loop purposes** — `say` is in `PERSONALITY_NAMES`, so it is
excluded from `movementCalls`; the turn speaks and the loop ends unless a
world-acting tool was also called (it never keeps the bot busy on its own).
260617: `say` was promoted from a parsed text convention (the old `extractSay`)
to a real tool because Haiku honored the text-only contract 0× across two live
runs while calling real tools reliably. This still gives Haiku a place to reason
before speaking (extended thinking makes it go mute), keeping chain-of-thought
out of chat. `chat_mode: 'full'` additionally surfaces the whole scratchpad to
chat with a `[think]` prefix for live debugging; default `'chat'` keeps it
hidden. The prompt contract lives in `BASELINE_INSTRUCTIONS` and the tool
description in `PERSONALITY_TOOL_DESCRIPTIONS.say` (`src/bot/brain/prompts.js`).

**Event-sourced FSM.** `src/bot/brain/fsm.js` is a priority queue with a
single-flight dispatcher and one `AbortController`:

```
P0_SAFETY (0)  →  P1_CHAT (1)  →  P2_MOVEMENT (2 ...)  →  P3_IDLE (3, 60s fallback)
```

Player chat (P1) preempts any non-P0 work mid-action. Adapter wiring lives in
`src/bot/adapter/minecraft/fsmWires.js`.

**Runtime mode + play/pause (260725).** Proactiveness is NO LONGER a
per-character trait — it was removed from creation/edit/profile and from
`character.metadata` (legacy keys are ignored everywhere; the persona expander
no longer emits the `PROACTIVENESS:` line, though the parser still strips one
if the cloud proxy sends it). Instead the in-app Minecraft dashboard has a
controls window (`McDashboardPanel`) with:
- **reactive / proactive mode** — runtime-only, NEVER persisted; every summon
  starts `proactive`. Maps onto the old tiers (proactive = 2 agentic, reactive
  = 1) via `orchestrator.setGameMode` (mutates `config.persona.proactiveness`
  live, rebuilds the cached system prefix; idle cadence re-samples because
  `idleFallbackMs` is passed as a function). Chat/voice/chess surfaces run at
  a fixed tier 1.
- **play/pause** — `orchestrator.setGamePaused` + `queue.setHold(predicate)`
  (fsm.js). Pause aborts the live loop + long-runner and HOLDS the queue
  (events stay queued, settle ticks are purged, idle timer disarmed). While
  paused on a voice call, only call lines dispatch and every LLM call gets the
  tiny paused notice instead of Minecraft context (`snapshotText()` is the
  choke point; the fresh-loop seed has a paused branch; `startLongRunner`
  refuses world tools). Unpause enqueues an idle tick framed "player just
  unpaused your game" carrying what was mid-flight.
  Pausing the brain is only half of it: the adapter runs autonomous loops that
  never touch the FSM (follow's 1s trailing tick, reflex evasion, combat
  retaliation, survival swim-up/retreat, gaze, auto-eat), so
  `brain.setGamePaused` also calls the OPTIONAL adapter member
  `setWorldPaused` (`adapter/minecraft/behaviors/pause.js`). It flips
  `bot._seiPaused` (each of those loops early-returns on it), drops the
  pathfinder goal + control states + digging/item use, disables auto-eat, and
  clears the reflex/survival goal mutexes: the body stands still and takes
  hits like a player away from their keyboard. `applyWorldPause` re-arms it
  from connect.js on every spawn so a reconnect while paused comes back
  frozen. follow KEEPS its target, so play resumes trailing.
- **status window** — full-width strip fed by the existing dashboard
  telemetry (`activityLabel.js`: actions → "gathering oak logs...", null →
  "idling", plus the synthetic `thinking` verb the orchestrator emits when a
  player-message turn starts). The panel sentence-cases the line for display
  ("Gathering oak logs..."); the bot-side contract stays lowercase.
Plumbing: `mcdash:set-paused` / `mcdash:set-mode` IPC → supervisor
`{type:'game-pause'|'game-mode'}` port messages → `bot/index.js` forwarders.
Renderer state lives in `useMcDashboardStore.controls` (cleared on session end
AND at `launchSummon`, so stale pause/mode never survives into a new summon).

**Iteration cap.** Tool-use chains are bounded by `memory.iteration_cap`
(**default 30**, in `src/bot/config.js`) to stop single-layer runaway.
> The old planning-era CLAUDE.md said 20 — that was wrong; the value is 30.

**Auto-equip on dig (260731).** `behaviors/toolSelect.js` picks and equips the
best tool the bot owns before EVERY swing in `digAction`, so `dig`, `gather`,
`digCuboid` and `digIn` all inherit it. Before this nothing on the dig path
equipped anything: `bot.dig()` swung whatever was in hand, and mineflayer's
`canDigBlock` only checks diggability + reach (it has never looked at the held
item), so `dig.js`'s "unbreakable or **wrong tool**" branch could not fire.
Live, that produced two compounding failures: bare-handed stone is 7500ms
against the old flat 8000ms timeout, so it lost the race under any latency
("timeout digging stone" ×3, then `dug stone` the moment the model happened to
call equip); and stone mined without a pickaxe **drops nothing**, so a gather
could never accumulate. Three details are load-bearing: bare hand is a real
CANDIDATE (otherwise an ms-only comparison equips whatever junk item sits first
in the inventory, since non-tools dig at exactly hand speed); a tool that makes
the block DROP outranks a faster one that does not; and the dig timeout is now
DERIVED from the expected dig time (`estMs * 2 + 2000`, clamped to
8000..`MAX_TIMEOUT_MS` 30000) instead of a flat 8s. When nothing in the
inventory can harvest the block the dig still runs and the result string SAYS
the drop was lost, the same "tell the model" pattern as `weakWeaponNote`. The
`dig`/`gather` tool descriptions now tell the model NOT to call equip first.

**Armor, copper gear and the tool speed table (261111).** User feedback on
Minecraft 26.3 ("won't put on what I give her", "doesn't know what copper
armor is"). `behaviors/armor.js` puts on armor the way `weaponSelect.js` and
`toolSelect.js` handle weapons and tools: when the bag + worn count of some
armor piece goes UP and a bag piece beats the worn one (armor points, then
toughness; unknown worn items like an elytra stay on; binding curse skipped),
she puts it on, waiting while paused, eating, digging or with a container
open. Only a gain triggers it, so `takeOffWorn` (used by `drop`, and so by
`give`) can hand a worn piece over without it going straight back on. The
snapshot shows `wearing: ...; off-hand: ...` when filled, the inventory diff
counts worn items (equipping is no longer an unexplained "-1"), and a gain she
put on reads `+1 copper_helmet (put on)`. `equip` sends armor to its own slot
whatever destination was passed and answers "already wearing X".
Haiku 5.5 believes copper armor is not in vanilla Minecraft, so the world
primer gets `COPPER_GEAR_FACT` when the connected registry has
`copper_helmet` (1.21.9+). `registryFixes.js` runs at spawn and rebuilds
`bot.registry.materials` (a copy; the require-cached JSON is shared): our 26.3
backport points materials at pc/26.2, whose numeric item ids do not match 26.3
(the pickaxe row named minecart and harness items, so every tool dug at hand
speed), and minecraft-data 3.114 has every copper tool at speed 1 instead of 5.

**Where things are, in words (261114, pass 55).** She used to read raw
coordinates out in chat ("already got one down at 174,70,-2 lol", "found iron
at 206,66,0"), because the numbers were the only location she had. Every
`nearby blocks` line and non-hostile `nearby entities` line now ends with
`whereFromYou` (`observers/whereFromYou.js`): "(14 blocks southwest, 6 down)",
"(right by you)", plus ", by <player>" within 4 blocks of them. The
coordinates stay on the line because goTo, dig, gather and build take x,y,z.
The placeBlock success result no longer carries the coordinates of the block
under it (the most quoted source); failures keep them for aiming a retry. Do
not put relative words into tool results: they stay in the history after she
moves and she repeats them ("the table's right by me" 14 blocks away), while
the snapshot is rebuilt every turn. The chat rule in `ACTION_RULES` says to use
those words or a landmark and keep the numbers for tools unless the player asks
for coordinates. Probe: `scripts/quality-eval/pass55-probe.mjs`.

**The curiosity mandate (260731).** `CURIOSITY_CLAUSE` in `promptLibrary.js` is
appended to all three gameplay `PROACTIVENESS_DIRECTIVES`. Before it, the only
"stay genuinely curious about the player" text in the repo lived in
`CHAT_PROACTIVENESS_DIRECTIVES`, which the Minecraft surface never loads, so
the gameplay tiers were ~500 words of setGoal / progression order / teammate
coordination and nothing about the human. Live, asked point-blank to get to
know the player, the character asked one question, got a real answer, wrote a
`remember()`, and walked off to a crafting table — correct for a prompt where
advancing the goal is the standing order every tick and following up on a
person is written down nowhere. `renderFrontierBlock` lost "on the way to
**beating the game**" (the loudest objective in the prompt; the first act of a
session was `setGoal("Reach iron tier")`) and gained shared-activity framing.
**What none of this says is that the progression does not matter** — told that,
the model stops working and the world goes still, which is worse company than a
grinder. The project is the SETTING; both halves are the job.

**Say-suppression (260731).** `IDLE_SAY_GAP_MS` is now **0 = disabled**. The
45s floor compared TIMESTAMPS only, so it could not tell a reworded repeat from
a new thought and killed both: inside one session it swallowed an answer to
something the player had just revealed about themselves (4s) and two
invitations to play together (7s, 21s). The text-comparing dedupe
(`shouldSuppressLoopEndSay`) is still on and is the one that catches an actual
repeat. `shouldSuppressIdleSay` and its tests are kept; restoring the floor is
a one-constant change. Related, same date: `ATTACKED_ADDENDUM_MOB` now REQUIRES
a line naming what is attacking you (it previously offered only tactics, so a
skeleton fight happened in complete silence and the player found out by asking
"are u ok?"), and the mid-action check-in's blanket "call NO say()" now exempts
taking damage.

**Conversation continuity in the game brain (260921).** One 17-minute Stardew
session (Lyra, 48 loops, 166 spoken lines) showed repeated lines while the
player was silent, a question she "did not see", conflicting answers, and web
searches the player never benefited from. None of it was fixed by filtering
what she says; every cause was something her prompt did not contain or a turn
that ran at the wrong time. The pieces, all in `src/bot/brain/` and pinned in
`orchestrator.conversation.test.js`:

- **Quiet is measured from the END of her turn** (`fsm.js`). The idle timer
  counted from an event's ARRIVAL, so at the agentic 5 s cadence it fired while
  the reply to that event was still generating (a turn takes 4-8 s), queued
  behind it, and dispatched the instant the turn closed (measured: 3 ms after).
  The timer callback now skips while a dispatch is in flight and `processNext`
  re-arms it when the dispatch finishes.
- **A line she just said holds the floor** (`REPLY_WINDOW_MS` 20 s,
  `replyWindowRemainingMs`, folded into `idleFallbackMs` in `brain/index.js`).
  This is SCHEDULING, not a gate: nothing she decides to say is dropped. 5 s is
  sized for resuming work and is shorter than the time it takes to open the
  game's chat and type (the player's replies landed 3-15 s after her lines), so
  her question was followed by an idle turn nobody could have answered yet, and
  an idle turn is nudged to speak. The window applies only while her line is
  the last thing said, and opens when the PACED line is readable
  (`_lastChatSendDeadline`), not when it was decided. Replayed over the session:
  35 of its 40 idle turns would have been deferred. Since 260924 it is
  always on only in Stardew; since 261011 it also applies in every game after
  a loop that only TALKED (`_lastLoopTalkOnly`), while a loop that did world
  work keeps the 5 s agentic cadence for resuming the goal. In the Minecraft
  quality eval most repetitive lines were idle turns 5-7 s after a line of
  hers that took no action.
- **Her lines are recorded when DECIDED, not when the paced send fires**
  (`emitChatMessages`). With realistic typing a line reaches chat 1-6 s after
  the turn that wrote it, and a turn composed inside that gap did not know the
  line existed. That is how "we can sell the stone and fiber at the shipping
  bin" was followed 8 s later by "the rocks don't do much".
- **One chronological transcript replaces the two one-sided lists**
  (`convoMemory.formatConversationBlock`, seed block `recent_conversation`,
  header `SEED_HEADERS.conversation`). Two lists hide the ORDER, and the order
  is the information: a question followed by an unrelated line of hers looks
  identical to an answered one. The same block now rides every mid-loop player
  line (`interruptTurnText`); those turns used to carry the new line ALONE, with
  the only transcript being the seed's, as old as the loop.
- **"MID-ACTION, KEEP GOING" only when something is running.**
  `extractPriorTask` returns the last tool call whether or not it finished, so a
  line that landed between actions was told an action was still running. The
  model re-issued the gather and wrote its answer in the private scratchpad.
  `interruptTurnText` now keys on `loop.inFlight` (or a background action such
  as follow).
- **A player line answered with actions only is delivered once more**, flagged
  as unanswered (`_unansweredRetried`, through the action-tick channel or the
  loop's next call, whichever comes first). The scratchpad is NOT salvaged on
  these turns: beside a world action it is usually reasoning about the chore.
  261011: a TEXT-ONLY answer (no tool at all) gets the same single retry
  (`unansweredRetryFor`): re-called at once with the nudge when nothing is
  running, through the action tick when something is. `end_loop` alone is
  her explicit choice of silence and is never retried.
- **What a web lookup FOUND outlives its loop** (`lookups.js`, seed block
  `lookups`). She searched in three separate turns inside 50 s (four billed
  searches); no turn could see what the previous one found, so each re-derived
  the answer in new words, and by the fourth the search text about multiplayer
  cabins had become "your cabin's in a different spot than mine". The log keeps
  the query, her own post-result conclusion and the line she told the player.
  The baseline also now says WHEN to search (on her own, when unsure of a
  factual answer): the server-side `web_search` tool is schema-less, so before
  this nothing in the prompt said when, only that she could.
- **A game event is not someone speaking** (`gameEvent: true` from the Stardew
  adapter's `systemLine`). "A new day" was framed as a line spoken to her with
  a mandatory reply, and was filed in the transcript as a speaker.
- **The one text filter is an exact match**
  (`isExactRepeatSincePlayerSpoke`): every segment equal, after normalization,
  to a line of hers newer than the player's last line. It does not attempt
  similarity, for the 260731 reason above. Since 260925 it works per SENTENCE
  (`splitRepeatedSegments`): the v0.6.5-beta.2 Stardew session re-asked an
  unanswered question as "i'm here. <the same question>", which the
  whole-line check let through. Now the repeated sentence is dropped, the new
  one is sent (`joinSegments` re-joins survivors so they split back the same),
  and the say() result tells her what was held back and not to answer it
  for the player.
- **Speaker labels cannot collide with her name (260925).** Player lines in
  the transcript read `player (<name>)` (`convoMemory.playerLabel`), sibling
  companions keep their own name (`pushPlayer(..., {companion})`, fed from the
  adapters' `fromCompanion`), and her own lines stay `you:`. The same session's
  player went by "Sei", so the transcript said `Sei: ...` and the app framing
  said "Sei typed this in the Sei app", and her scratchpad attributed her own
  question to the player and answered it. The conversation header says a
  question of hers that has not been answered is waiting on them.

Not done, on purpose: no similarity dedupe, no cancelling of a queued line when
the player speaks first (it is now in her transcript, so the reply that follows
is coherent with it). Unverified live; the numbers above are a replay of the
log's timing, not a new session.

**A voice line that cut her off (261112).** A player on a voice call while she
followed them in Minecraft reported that cutting her off now and then left her
quiet for a long time, mid-chase. A barge-in only cut the audio
in the renderer; the bot never knew, so "stop", "wait" or "hold on" said over
her line read as an order. A bare stop line (or a stop() on an asks-to-stop
line) cancelled the follow and started the 120 s player stop hold, so she
stood still and said nothing on her own for two minutes. Now:

- The renderer pairs a confirmed barge-in with the utterance that caused it
  (`lib/voice/bargeCut.ts`, read in `onBargeIn` before `cutCompanions` clears
  the caption) and sends it to the companion that was audible as
  `chatSend({interrupted: {line}})` -> `routeToBot` -> `sei-chat`
  `{interrupted, cutLine}` -> `deliverSeiChat` -> `voiceLineEvent`.
- The orchestrator (`cutInOf`) marks `_lastPlayerLine.interrupted`, adds
  `NUDGES.cutOff` to that turn only (seed `playerMessageText` or
  `interruptTurnText`), and skips the forced stop rules for it: the
  words-only bare-stop backstop (`unheededPlayerStop`), the end_loop
  bare-stop backstop, and the player stop hold. Her own stop() still stops
  the action, with `INTERRUPT_STOP_HOLD_MS` (20 s,
  `memory.interrupt_stop_hold_ms`) instead of 120 s.
- Typed lines and voice lines with nothing being said are unchanged.
- Analytics: `mc_session_actions` `voice_interrupt_msgs` /
  `voice_interrupt_stops`; `voice_call_ended` `interrupt_cut_lines` (cuts
  whose words reached the cut companion; `interrupt_cuts` minus it is cuts
  whose words never became a turn). Pinned by `bargeInCut.test.js`.

**Memory.** Per-character memory directory.
- **Writes are LLM-driven:** the model calls `remember()` / `forget()` to
  maintain an append-only `MEMORY.md`; `PLAYER.md` tracks the other player.
- **Compaction is a byte-threshold trigger:** after each successful
  `remember()`, if `MEMORY.md` exceeds `memory.compaction_trigger_bytes`
  (**default 8192** since 260725; `seed_memory_budget_bytes` doubled to 16384
  alongside so the trigger stays below the seed budget, and the chat/chess
  `readMemoryTail` mirrors went 6000 → 12000), an async single-flight
  compaction fires.
- **Memory is segmented by world.** A character accumulates memories across many
  LAN worlds; to keep them from bleeding together, `src/bot/brain/memory/worlds.js`
  assigns each world a **stable number** (fingerprinted by world spawn point +
  dimension, persisted in `worlds.json`) on the bot's first spawn. It drops a
  `## World N — <label>` header into `MEMORY.md` when the world changes, and the
  per-turn snapshot leads with `world: #N <label>` so the bot knows which world
  it's in. These headers are deliberately NOT entry lines (`- [`), and both the
  seed-truncation (`readMemoryForSeed`) and the **segment-aware compactor** are
  written to preserve them — touch those two if you change the header format.
  261020: headers name their game, and app-side writers file under
  `APP_SECTION_HEADER` (see "Plans and goals belong to a game" below), so a
  player who alternates a game and texting gets a new header pair every
  session. The compactor therefore merges every occurrence of a section (a
  world by number) into one segment at its last place (`coalesceSegments`),
  and the seed reader pays for headers from its budget and keeps only the
  headers of kept entries plus the last one.
> The old CLAUDE.md framed this as "the LLM decides when to compact at semantic
> boundaries" — misleading. The *write* is LLM-driven; the *compaction* is
> mechanical (byte threshold).

**Knowledge (260725).** Per-character, user-provided reference files (imported
memories from other AI-companion platforms, facts about the player) injected
into EVERY AI surface without the model asking: chat/voice/chess get it via a
block in `buildSystemBlocks` (`src/main/chat/chatPrompts.ts`, right after the
persona block, inside the cached stable region — no fifth `cache_control`);
the Minecraft bot gets it in the summon init payload (`config._seiKnowledge`)
appended to the cached system prefix in `rebuildPersonalitySystem`. Store:
`src/main/knowledge/knowledgeStore.ts` under `paths.knowledgeDir(id)` =
`<profileRoot>/knowledge/<characterId>/` (manifest `index.json` +
`<entryUuid>.md` files) — deliberately OUTSIDE `memoryDir` so "Reset memory"
never wipes it (character delete / remove-from-library / migration / profile
import all handle it). Ingestion is main-only (`knowledge:extract` →
`src/main/knowledge/extractText.ts`): .md/.txt/.text plus .docx via a minimal
in-repo zip reader; legacy .doc rejected; binary-as-text rejected; control +
zero-width/bidi chars stripped; 512 KB/upload, 64 KB/entry, 20 entries. Over
32 KB total at create time the wizard offers an LLM compaction
(`knowledge:compact`, target ≤ 8 KB, replaces all entries with one) — only
Sei's stored copies are compacted, never the user's original files. UI: the
Awaken "Import from another platform" tile (upload phase before the wizard
questions) and the CharacterPage gear menu → Knowledge popup
(`KnowledgeModal`, available for ALL characters). Prompt framing treats
knowledge strictly as reference DATA, never instructions.

**Portrait regenerate + versions (260909).** Owned characters (predicate:
`!is_default && (!owner || owner === currentUserId)`, the CharacterPage
`canShare` rule; `kind:'unique'` Awakened companions ARE owned even though
`viewOnly` blocks their Edit modal) can regenerate the card image up to
`MAX_PORTRAIT_REGENS` (3, lifetime, `characterSchema.ts`) and switch between
every version. Only the version on display reaches the cloud.

- **Storage:** versions are sidecar files `<uuid>-v<n>.png` in the portraits
  dir (served as-is by `sei-portrait://`, filename gate already allows them),
  recorded in `character.metadata.portrait_versions` / `portrait_active` /
  `portrait_regen_count` (metadata rides the cloud row verbatim, no schema
  migration). The first versioned write snapshots an existing canonical file
  as v1 `'original'`; uploads via `PortraitImagePicker` are recorded as
  `'upload'` versions (max `MAX_PORTRAIT_VERSIONS` 8, oldest inactive upload
  evicted). **The list is reconciled against disk on every read** (260917):
  the metadata syncs with the row but the sidecars do not, so on a second
  device `portraitStore` lists only the recorded versions whose files exist,
  treats a `portrait_active` it does not have as "the canonical is showing",
  refuses to select a phantom ("Unknown portrait version", not ENOENT), and
  snapshots that device's canonical before the first write that would
  overwrite it.
- **Selecting = copying onto the canonical file.** Cloud upload reads
  `<uuid>.png` unconditionally (`syncQueue.ts`, `ipc.ts` moderation +
  migration paths) and the storage object name is server-derived, so
  `selectPortraitVersion` copies the sidecar's bytes onto the canonical file
  through `applyPortrait`, which saves the character and enqueues the mirror.
  The md5 `.uploaded.json` marker in `cloudCharacterClient` skips a re-upload
  of bytes already in the cloud (switching back is free).
- **Generation:** `regeneratePortrait()` in `uniqueGeneration.ts` reuses the
  cast pipeline's private pieces (`assemblePortraitPrompt`,
  `generatePortraitPng` KusArt-via-proxy, `zoomToCharacter`,
  `toCompliantPortraitPng`, `resolveKusartStyleId`). Prompt source is the
  stored soulcaster sheet when present, else name + description + persona
  source. Needs a session JWT in every backend mode (the proxy route is
  JWT-authed); signed-out returns `not_signed_in` and the modal disables the
  button with "Sign in to regenerate." Per-character single-flight in
  `ipc.ts` (a second call joins the in-flight promise, so there is no
  `busy` result); typed results `not_signed_in | limit | not_found |
  generation_failed | network`, the cap refusal carrying
  `code = PORTRAIT_REGEN_LIMIT` (constant + copy in `characterSchema.ts`,
  defined once). Injectable `generate` is the test seam
  (`uniqueGeneration.regen.test.ts`).
- **Cleanup:** `src/main/portraitFiles.ts` (`deletePortraitFiles`) removes
  canonical + sidecars + the md5 marker, and is the ONE sweep run by character
  delete, remove-from-library and `removePortrait` alike (removePortrait used
  to unlink canonical + sidecars itself and leave the marker, so a later
  re-upload of identical bytes looked already-uploaded); `_user.png` /
  `_bg.png` never match.
- **IPC:** `chars:portrait-versions`, `chars:portrait-regenerate`,
  `chars:portrait-select` (uuid-gated; select also pins `file` to
  `^<uuid>(-v\d+)?\.png$`). UI: `PortraitVersionsModal` from the
  CharacterPage gear menu ("Card image", owned only) and a `Regenerate`
  button beside the Appearance tab's picker. `bumpPortraitRef()` in
  `portraitSrc.ts` cache-busts the canonical image after a swap.

**Lazy Minecraft skins (261027).** The Gemini skin (proxy `POST
/generate/skin`, billed $0.134 to the player's allowance or credits) is no
longer made at creation. `src/main/skinGeneration.ts` is the ONLY caller of
the route (pinned by `lazySkin.contract.test.ts`).
- **Creation** paints the free local skin (img2skin's no-LLM painter,
  `paintFallbackSkin`) and saves the character with
  `metadata.skin_pending: true` (`SKIN_PENDING_KEY`, `skinPendingOf` in
  characterSchema; metadata rides the cloud row). `applyPng({skinPending:
  true})` keeps the marker; any other applyPng (upload, search, a generated
  skin) and `removePng` clear it.
- **First trip to Minecraft** (`ensureMinecraftSkin`): opening the launch
  panel (`skin:ensure`, `useMinecraftSkinPrep` shows "Making {name}'s
  Minecraft skin...") or any Minecraft launch (the module's `prepareJoin`,
  which also covers the chat/voice `launch()` tool, bounded by
  `SKIN_PREPARE_WAIT_MS` 75 s and outside the summon deadline). Owner only
  (`!is_default && (!owner || owner === userId)`), pending only, once per
  character per app run, single-flight. Shared characters never generate:
  the owner's skin syncs and others download it.
- **The profile button** (`SkinGenerateButton` under the skin preview,
  `skin:generate`): "Make Minecraft skin (uses credits)" or "Regenerate skin
  (uses credits)", a new billed call each press.
- **Billing:** the client sends `x-sei-charge-confirm: 1`; the proxy holds the
  charge and returns `x-sei-charge-id`; the client confirms `{charge_id,
  used}` at `/generate/skin/confirm`, `used: false` when img2skin could not map
  the image (no charge). 402 (`insufficient_credits`), 429 (daily cap) or a
  network failure keep the painted skin and the marker (retried at the next
  app run's launch); a character with no skin at all gets the painted one.
  Nothing here ever blocks a launch. Pre-261027 characters have no marker and
  keep their skin; only the button regenerates them.

The bot has **one entry path** (`src/bot/index.js`): forked by Electron, it
waits for an `init` message over the port. (The standalone `sei` CLI was
removed 260722.)

**Web search (260909).** Two backends, chosen per session by
`webToolsFor()` in `src/bot/web/webTools.js`:

- **Anthropic sessions (cloud proxy + Anthropic BYOK): Anthropic's own
  server-side `web_search` tool** (`SERVER_WEB_SEARCH_TOOL`, type
  `web_search_20250305`, the variant Haiku 4.5 supports, `max_uses` 3 per
  request) plus our `visit`. The search runs INSIDE the response: the model
  searches, reads, and answers in one turn; no scraping, no key, no
  dependence on the user's network. The proxy forwards the body verbatim so
  the tool passes through; each search is billed by Anthropic per search on
  top of tokens (the proxy's ledger does not meter that yet). Two mechanics:
  `stop_reason: 'pause_turn'` (a long search) is resumed by pushing the
  assistant content back verbatim and calling again (bot `runIterations`,
  chat hop loop); and the `server_tool_use` + `web_search_tool_result`
  blocks stay in the loop history verbatim: the docs say a continuation
  whose `encrypted_content` is missing or modified is a 400, and dropping
  the whole pair is untested from this machine (region gate). The cost is
  bounded to one loop; chat rebuilds its transcript from text rows. The bot's cached
  tool prose skips schema-less server tools. On the blocking typed-chat path
  the text written BEFORE the search ("lemme check") is pushed immediately and
  only the post-search text is the reply (`splitTextAroundServerSearch`).
- **Every other provider (OpenAI-compatible, Gemini, Ollama): our
  `search()` / `visit()`**, below. Capability flag: bot
  `anthropicProvider.CAPABILITIES.serverWebSearch`; main `llm.kind ===
  'anthropic'`. The "Before searching, let the player know" line sits as
  literal text in both baselines (promptLibrary.js must stay import-free for
  the prompt-editor script) so the announce rule holds on either backend.

**Client web search: `search()` / `visit()`.** Two tools the model can call
on EVERY conversational surface, with ONE rule that makes the loop: the
result comes back as an ordinary `tool_result` and the surface's existing tool
loop calls the model again, until it stops calling tools. Nothing new was
built for the loop itself.

- **Core:** `src/bot/web/webTools.js`, no mineflayer import and no static
  Electron import: its only Electron touch is the OPTIONAL dynamic
  `import('electron')` inside `electronFetchProvider`, which fails soft under
  plain Node, so the bot (raw ESM, asar-unpacked), main (bundled) and the
  test runner all import it. `createWebSession()` is the only state: a lettered result table plus a
  per-turn budget. Tool definitions (`SEARCH_TOOL` / `VISIT_TOOL`) are shared
  verbatim by both sides so the model meets one contract.
- **Context is the cost, so the model never sees a URL.** `search(query)`
  returns up to 5 lines `a. Title (host) - snippet` (title 70 chars, snippet
  150, ~250 tokens total); `visit(ref, page?)` takes a letter (or a raw URL)
  and returns ~2400 chars of de-boilerplated text per part with a `part n/m`
  header. Labels run a..z, aa.. and are session-wide, so a `visit("b")` on a
  later turn still resolves. HTML→text is regex-only (`htmlToText`): drop
  script/style/nav/header/footer/aside, prefer `<main>`/`<article>` when
  substantial, block tags → newlines. The tag regex tolerates `>` inside
  quoted attributes (Wikipedia's `data-mw` JSON leaked otherwise).
- **Fetch through Chromium, not Node (260909, rebuilt on `net.request`
  260917).** `electronFetchProvider()` resolves Electron's `net` lazily
  (available in main AND in the bot's utilityProcess): browser TLS
  fingerprint + OS proxy. Measured from this machine: minecraft.wiki,
  valorant.fandom.com and html.duckduckgo.com all answer 200 under Chromium's
  stack where Node's undici gets a 403 / bot challenge. The first cut used
  `net.fetch` with redirects followed and the FINAL `res.url` gated, and that
  was a hole: `net.fetch` returns a constructed Response whose `.url` is ''
  (electron.d.ts documents `.url` as incorrect), so the gate compared '' to
  the request URL and never ran, and `net.fetch` cannot do
  `redirect: 'manual'` (no 'redirect' listener, so a manual redirect is
  cancelled). A public URL that 302'd to 127.0.0.1 / 169.254.169.254 / a LAN
  host had its body returned to the model. The provider is now
  `createNetRequester(net)`: `net.request({redirect:'manual'})`, headers via
  `setHeader`, POST body written, and in the `'redirect'` event the caller's
  gate runs on the redirect URL and hops are counted against `maxRedirects`
  BEFORE `followRedirect()` (which Electron requires to be called
  synchronously); a failing gate aborts the request, so nothing past the
  redirect is read. Body cap, timeout and the outer abort signal match the
  Node path. `fetchCapped` stays the single entry and accepts either
  transport (`{request}` or `{fetch, manualRedirects}`); a follow-mode fetch
  whose `res.url` is EMPTY is refused as "unknown landing", never trusted as
  same-origin. Plain Node (tests, scripts) keeps the manual-redirect loop.
  Electron gotcha met while probing: an ESM entry that top-level-awaits
  `app.whenReady()` deadlocks (ready is deferred until the module evaluates);
  probe scripts must be CJS or use `.then`.
- **Game wikis are asked DIRECTLY (260909).** `GAME_WIKIS` (webTools.js) maps
  game names in the query to MediaWiki hosts (minecraft.wiki,
  valorant.fandom.com, wiki.leagueoflegends.com, terraria.wiki.gg, ...).
  `search()` runs `api.php?list=search` on each matched wiki (game name
  stripped from the query) in parallel with the general chain and lists the
  wiki hits FIRST: for a game question the wiki page IS the answer, and the
  engines are the ones that hand back a storefront homepage. The bot passes
  `alwaysWikiHosts: ['minecraft.wiki']` so an in-game "how do i tame a fox"
  hits the Minecraft Wiki without saying "minecraft". `visit()` on a known
  wiki host reads through `action=parse` (cleaner than the rendered page,
  answers from any network; HTML fallback), and an unknown `/wiki/` host
  behind a bot wall is retried through its `api.php`. Fextralife (Elden Ring)
  is not MediaWiki and is deliberately absent. A DuckDuckGo challenge OR a
  timeout arms a 90 s cooldown (`ddgBlockedUntil`) instead of re-asking a
  rate-limited or blackholed engine; Bing has the same clock
  (`bingBlockedUntil`, timeout-armed). Keyless search endpoints (the
  DDG/Bing/Wikipedia chain and the wiki `list=search` calls) run on
  `searchTimeoutMs` (4 s), since the chain is sequential and used to cost
  `fetchTimeoutMs` per engine on a dead network; keyed APIs and `visit` keep
  `fetchTimeoutMs` (8 s). Every engine fetch carries the turn's abort
  signal (`searchCtx` injects it, so a provider cannot forget), and a search
  preempted mid-flight throws rather than returning stale results.
- **Providers: keyless by default.** `providerChain()` tries a keyed provider
  first only when its key is present (Brave `X-Subscription-Token` GET,
  Tavily `Bearer` POST, Serper `X-API-KEY` POST; request/response shapes
  verified against each vendor's docs 260909), then the keyless chain
  DuckDuckGo HTML → Bing HTML → Wikipedia API. The first provider that yields
  a result wins; a challenge page, an empty scrape, or (scraped engines only)
  a result set that shares fewer than two query words with any hit
  (`looksRelevant`: Bing from this egress returned dictionary entries for
  "latent" when asked about the Latent Space podcast) moves the chain on.
  Wikipedia is the floor that always answers. Parsers are pinned on real
  fixtures in `src/bot/web/fixtures/`. From a flagged egress (this dev
  machine sits behind a shared proxy) DDG serves a bot challenge to curl but
  answers Node fetch with browser headers; Cloudflare-walled sites
  (minecraft.wiki, wikiHow) refuse `visit` and the tool says so
  ("blocks automated readers. Try another result.") instead of inventing.
- **Safety:** `assertPublicHttpUrl` gates the initial URL and every redirect
  hop before it is followed (http(s) only, no credentials, no
  loopback/link-local/RFC1918 literals, `.local`), 5 hops max. On the
  Electron path that gate runs inside `net.request`'s `'redirect'` event
  ahead of `followRedirect()` (`createNetRequester`); on the Node path it is
  the manual loop in `fetchCapped` (`redirect: 'manual'`, one fetch per hop).
  A follow-mode transport that cannot report where it landed (empty
  `res.url`) is refused, not trusted. Bodies are streamed with a 1.5 MB cap
  and an 8 s timeout (4 s for keyless search endpoints); the outer loop's
  abort signal cancels an in-flight fetch on both paths. Non-text content
  types are refused rather than dumped. Pinned in `webTools.test.js`: a
  private-host redirect is aborted before its body is read, a public one is
  followed with the final url recorded, and hops past `maxRedirects` reject.
- **Bot brain wiring:** `search`/`visit` are in `INLINE_METADATA` (result
  fills synchronously, no suspend) but deliberately NOT in
  `PERSONALITY_NAMES`, so they count as `movementCalls` and `continueLoop`
  stays true: `runIterations` calls the model again with the result. Also in
  `ACTION_VERB_SKIP` (no presence verb). Budget is per LOOP
  (`config.web.max_calls_per_loop`, default 6, armed once per `runIterations`
  entry via `loop._webBudgetArmed`). `config.web` (`src/bot/config.js`) is
  bridged from main as `init.webSearch = {provider, api_key}`;
  `enabled:false` withholds both tools. `_webSessionOverride` on
  `createOrchestrator` is the test seam (`orchestrator.webSearch.test.js`).
- **A line beside the lookup is nudged, not required.** The tool
  description ends with one short line, "Before searching, let the player
  know", so a lookup is not a silent pause. In the game a `say()` in the same turn as `search()`
  is emitted up front by `emitSayCalls` like a say beside a dig, and the loop
  still continues. In typed chat the blocking path kept only the LAST hop's
  text, so "lemme check" was dropped; now a hop with text AND a web tool call
  persists + pushes that text immediately over `chat:message` (the renderer
  queues pushed companion lines with its typing pacing) and the returned
  replies carry only what came after the results. Voice already streams every
  hop's sentences.
- **Chat/voice wiring:** `chatService` offers both tools on every text and
  voice list (greeting, companion and idle turns included, so the cached
  tools+system prefix stays identical across turn kinds), dispatches them
  from a per-character session (`getChatWebSession`, 1 h idle TTL, in
  `src/main/llm/webSearchSettings.ts`), and `MAX_HOPS` went 3 → 6. Chess,
  Draw! and backseat do NOT offer them (game turns, prompt-cache churn).
  260917: the list is built in ONE place (`chatTools(llm, voice)`) so the
  four voice turn kinds cannot drift, and the three SINGLE-SHOT voice turns
  (greeting, companion reaction, idle nudge) no longer drop a lookup they
  announced: `followUpWebTools` runs the response's web tool_uses (or resumes
  a `pause_turn`) and makes exactly ONE follow-up call, bounded on purpose,
  with the pre-search line spoken before the answer. Also fixed the same
  day: when a server-side search and a client `visit()` rode ONE response
  the pre-search line was pushed twice (the client-tool emit used the full
  text instead of the already-split remainder), and `textOf` joins text
  blocks with a space, not `''`.
- **Settings:** the "Web search" tab of the "Games & search" group
  (`SearchSettingsSection`, an `extraTabs` entry of `GamesSettingsGroup`;
  its own group above About until 261023) is the only UI: provider `Seg` (Auto (free) / Brave / Tavily / Serper) plus a
  masked key editor shown only for a keyed provider. Persisted as
  `UserConfig.web_search_provider` / `web_search_api_key` (both `.optional()`
  with NO default so the renderer's whole-config literals keep typechecking;
  absent = auto), plain in config.json like `provider_config` keys.
  `resolveWebSearchSettings()` also honors `SEI_SEARCH_PROVIDER` /
  `SEI_SEARCH_API_KEY` env overrides for development. A normal user never
  opens the group: the keyless chain needs no setup.

---

## Walks and dig reach (Minecraft skills)

- **A walk does not end where its goal says.** mineflayer-pathfinder checks
  the goal on the CELL the feet are in and stops once the body is within 0.35
  of the last node on each axis, so the eyes can end ~0.7m from where the cell
  center put them. Two reach numbers in `behaviors/dig.js` keep that from
  failing digs: `DIG_REACH` (4.5, eyes to block center) decides when a dig,
  gather or cuboid walks first, and that walk aims for `DIG_REACH - 0.3`;
  `DIG_MAX_REACH` (5.0) is where `digAction` refuses (mineflayer's
  `canDigBlock` allows 5.1, the 1.21 server 4.5 + 1 to the block's box). A dig
  still a step short after its walk gets one short close-in walk
  (`closeInForDig`, aimed at 3.5, 4s; only when the walk said `reached`) in the
  dig tool and in gather before the
  block is marked unreachable. Until 261107 (pass 45) the refusal was 4.5 and
  "out of range (4.5m-5.0m) ... (the walk toward it ended: reached)" came up on
  every gather_craft free-play run.
- **goTo walks on while it is getting closer.** One leg is
  `pathfinder_timeout_ms` (12s, about 25-35m without sprint). A leg that timed
  out after closing at least `PROGRESS_MIN_M` (4m) walks again, up to
  `PROGRESS_LEGS` (3) more legs, for goTo(player) and goTo(x,y,z)
  (`registry.js`). A leg that went nowhere still ends the goTo, so a wedged
  walk answers as fast as before. Repro: `pathing-repro.mjs` cases
  `dig_buried_stone`, `stone_02b_*` and `goto_far_player`.
- **placeBlock picks from every open cell in reach (261108, pass 46).**
  `behaviors/placeSpots.js` ranks cells that are empty or hold a plant the
  block replaces (grass tufts, tall grass, snow), with a full solid floor to
  click, no body in them (her own hitbox included), in reach and in sight;
  water comes last. place.js tries the best 3, then steps once to the nearest
  open standing spot (`findOpenStandSpot`, 8 blocks) and tries again, and only
  then puts it in water. Never click a tuft or water: the server places INTO a
  replaceable block, so mineflayer waits on the cell above, times out, and the
  tool said "no open spot" for a table that was in fact down. craft() with a
  crafting_table in the bag puts it down instead of walking to a world table
  more than 8m off, or when that walk fails. Repro: `place-repro.mjs`.
