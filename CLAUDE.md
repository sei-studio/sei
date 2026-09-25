# Sei — Contributor Guide

Sei is a Minecraft AI companion. This repository is the **client**: an Electron
desktop app ("Sei", productName in electron-builder.yml) for non-technical users that spawns an AI-driven
[mineflayer](https://github.com/PrismarineJS/mineflayer) bot into a **LAN
(offline-mode) Minecraft Java world**. You pick a character, the bot joins your
world, and it talks and plays alongside you.

v1.0 is LAN-worlds only — offline mode, no Mojang/Microsoft auth, no Mojang
UUIDs. Identity is the in-game username plus (for cloud users) a Supabase
account.

> **Scope note.** This repo is the client only. The cloud backend it talks to
> (the LLM proxy, Supabase database, billing webhooks) is a **separate private
> service**. Everything here that mentions "the proxy" or "the server" refers to
> that external component — there is no server code in this tree.

---

## Architecture: three-process Electron

Electron is split into three trust zones plus a forked bot subprocess. The
boundaries are load-bearing — respect them.

```
┌───────────────┐  IPC (contextIsolation)   ┌────────────────┐
│   renderer    │ ───── window.sei ───────▶ │      main      │
│  React 19 +   │ ◀──── (preload bridge) ─── │  Electron host │
│   Zustand     │                            └───────┬────────┘
└───────────────┘                                    │ utilityProcess.fork
   src/renderer            src/preload                │ + MessageChannelMain
                                                      ▼
                                            ┌────────────────┐
                                            │   bot (LLM +   │
                                            │   mineflayer)  │
                                            └────────────────┘
                                                  src/bot
```

| Process | Source | Role |
|---|---|---|
| **main** | `src/main/` (entry `src/main/index.ts`) | Electron host: window, IPC, stores, auth, cloud, updater, bot supervisor. The only process that touches the OS keychain and the network for cloud/auth. |
| **renderer** | `src/renderer/` | React 19 + Zustand UI. `contextIsolation` is ON; it has **no Node access** and reaches main **only** through the `window.sei` bridge. |
| **preload** | `src/preload/index.ts` | Typed `RendererApi` over `ipcRenderer.invoke`, exposed as `window.sei` via `contextBridge`. Compiled to **`.cjs`**. |
| **bot** | `src/bot/` | The companion: LLM brain + mineflayer. Forked by `src/main/botSupervisor.ts` via `utilityProcess.fork`, talks to main over `MessageChannelMain`. |

### Invariants (do not break these)

- **mineflayer is imported only in `src/bot`.** It must run in the
  utilityProcess, never in main or renderer.
- **The renderer never imports from `src/main`.** All renderer→main traffic goes
  through `window.sei` (preload) → IPC channels declared in `src/shared/ipc.ts`.
- **Plaintext secrets cross to the bot only over `MessagePortMain`**, never
  through the renderer. `src/main/apiKeyStore.ts` decrypts the API key in main
  and hands it to the forked bot in the init message.
- **Multiple bots, one per character.** `botSupervisor.ts` owns a
  `Map<characterId, ActiveSession>` — `summon(id)` forks an *additional* bot
  without disturbing the others; `stop(id)` drains one, `stop()`/`shutdown()`
  drain all. Each character is its own `utilityProcess` + brain + memory dir, so
  sessions are fully independent. **Two bots may never share an in-game
  username** (the world kicks the second with `name_taken`), so `summon` refuses
  a colliding effective username before forking (the renderer pre-checks and
  shows a popup; the supervisor is the authoritative backstop). Summon has two
  watchdogs: a **60s cold-boot budget** (`BOOT_TIMEOUT_MS`, fork to the bot's
  `init-ack`) and then a **30s ready budget** (`SUMMON_TIMEOUT_MS`, `init-ack`
  to `summon-ready`); stop has a 10s timeout then
  escalates to kill. A stop during a PENDING summon cancels it instead: the
  child is killed at once and the summon rejects with `SUMMON_CANCELLED`
  (silent, no error status or diagnostic). App quit (`shutdown()`) is
  hard-capped at 4s. The in-game username is `effectiveMcUsername(character)` in
  `src/shared/characterSchema.ts` (`character.username` ?? sanitized name).
- IPC contracts and shared Zod schemas live in `src/shared` and are the single
  source of truth for both sides of the bridge.

---

## Local vs Cloud mode

The bot reaches an LLM through one of two backends, selected by
`ai_backend_kind` in `<userData>/config.json` (**default `'local'`**), read via
`getAiBackendKind()` in `src/main/apiKeyStore.ts`.

| | **local** (BYOK) | **cloud-proxy** |
|---|---|---|
| Auth | User's own Anthropic API key, encrypted at rest via Electron `safeStorage` (OS keychain) | Supabase account; JWT (`access_token`) sent as a Bearer token |
| Endpoint | Anthropic direct | `https://api.sei.gg` (the private proxy) |
| Credits UI | Hidden | Pricing / credits / hard-stop surfaces shown |

**Runtime wiring** lives in `src/bot/brain/anthropicClient.js` →
`buildSdkOptions()`:

- **local:** `{ apiKey: <decrypted key> }`.
- **cloud:** `{ baseURL, authToken, apiKey: null }`. Passing `apiKey: null` is
  deliberate — it suppresses the `x-api-key` header so only the
  `Authorization: Bearer <jwt>` is sent. JWTs rotate **live** via
  `setAuthToken()` (mutates the SDK instance in place; no re-summon needed).

A cloud↔local switch can rebuild the SDK instance without re-summoning the bot.

### Multi-provider LLM factory

Anthropic (incl. the cloud proxy) is the default, but the brain supports a
broader provider set via the factory in `src/bot/brain/llm/index.js`, selected
by `llm.provider` in `src/bot/config.js`:

- `anthropic` (`src/bot/brain/llm/anthropicProvider.js`)
- `gemini` (`geminiProvider.js`)
- `ollama` (`ollamaProvider.js`, local)
- ~10 OpenAI-compatible providers via `openaiCompatProvider.js`: `openai`,
  `grok`, `openrouter`, `deepseek`, `mistral`, `together`, `groq`, `fireworks`,
  `cerebras`, `perplexity`.

### Cloud plumbing (client side)

- **Auth** — `src/main/auth/`: Supabase client (`supabaseClient.ts`), PKCE
  loopback OAuth (`loopbackPkce.ts` uses an ephemeral port; `loopbackCallback.ts`
  uses the fixed callback port **54321**), session persisted via `safeStorage`
  (`sessionStore.ts`), and `jwtBridge.ts` which pushes fresh JWTs down to the
  running bot.
- **Billing / cloud characters** — `src/main/cloud/`: `proxyClient.ts` is the
  client to the proxy — `creditsGet()`, `subscriptionStatus()`, and
  **server-minted** Polar checkout/portal URLs (the write-scoped billing token
  never reaches the client). Also `cloudCharacterClient.ts`, `syncQueue.ts`
  (offline-first character sync), `moderationGate.ts`, `cacheOnDemand.ts`.
- **Roster mirror (260801)** — `src/main/cloud/librarySync.ts` mirrors which
  FOREIGN characters are in the user's Home roster
  (`UserConfig.added_default_ids` + `added_world_ids`) into the cloud
  `character_library` table. `characters.owner` records who AUTHORED a row,
  which is a different question from who HAS it, so before this nothing
  server-side knew an account had adopted Sui or a shared character, and
  analytics could only infer it from `character_id` event properties — blind to
  a character that is only ever texted, and to anyone opted out. It reconciles
  the WHOLE SET rather than hooking each write: membership is written from at
  least six places (four library IPC handlers, the unpublish reconcile sweep,
  two one-shot config migrations, onboarding), and a per-write hook would be
  silently wrong the day a seventh appears. So callers just
  `void syncLibraryRoster('reason')` after their config write, and the sign-in
  pass is both the backfill for installs predating the table and the safety net
  for every writer that never learned the mirror exists. Own characters are
  deliberately NOT recorded (already covered by `characters.owner`). Never
  throws; single-flight; signed-out/offline/RLS-rejected all mean "next time".
- **Pre-flight credit gate** — before forking a *cloud* bot, `botSupervisor.ts`
  consults the credit ledger and refuses the summon when depleted (showing the
  "add playtime" surface). It **fails open** on any error and is skipped
  entirely for BYOK, so a transient hiccup never blocks a paying or local user.

---

## Bot / LLM internals (`src/bot`)

**Single-layer brain.** One LLM call combines reasoning *and* action dispatch —
there is no separate planner/dispatcher. Default model `claude-haiku-4-5`, **20s
timeout** (`anthropic.timeout_ms`).

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
  35 of its 40 idle turns would have been deferred.
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
- **Settings:** the "Search" group in Settings (bottom, above About) is the
  only UI: provider `Seg` (Auto (free) / Brave / Tavily / Serper) plus a
  masked key editor shown only for a keyed provider. Persisted as
  `UserConfig.web_search_provider` / `web_search_api_key` (both `.optional()`
  with NO default so the renderer's whole-config literals keep typechecking;
  absent = auto), plain in config.json like `provider_config` keys.
  `resolveWebSearchSettings()` also honors `SEI_SEARCH_PROVIDER` /
  `SEI_SEARCH_API_KEY` env overrides for development. A normal user never
  opens the group: the keyless chain needs no setup.

---

## Guided first moment (260926)

A new player's first session ends in their companion's chat, with the
companion greeting first and one concrete next step under the greeting. Before
this, onboarding landed on Home: 24% of new installs never used any surface.

- **Who gets it.** `firstMomentCompanion(res, suiId)` (`lib/firstMoment.ts`)
  in `App.tsx` `handleOnboardComplete`, only on the `res.tutorial` branch (a
  NEW player; the returning-user / `accountHasProfile` route passes
  `tutorial:false` and never arms). The companion is the generated one, else
  Sui. Every backend works: the greeting is the ordinary first-meeting turn on
  `buildLlmProvider()`.
- **Flow.** `useFirstMomentStore.arm(id)` starts a Minecraft install probe.
  The tutorial still runs; its end (`TutorialOverlay.finish` ->
  `enterFirstMoment()`) navigates to that companion's chat instead of Home.
  `useChatStore.load()` on the empty transcript asks `greetingOptions` (waits
  at most `MC_PROBE_WAIT_MS` for the probe) and passes
  `chatOpened(id, {firstMoment: {primary}})`; main adds
  `thoughtFirstMoment(primary)` after `THOUGHT_FIRST_MEETING`, so the greeting
  (which already knows `preferred_name`) ends on the invitation. After the
  whole greeting is revealed the store goes `ready` and `ChatScreen` renders
  `FirstMomentCard` at the end of the message list (hidden while the tour is
  active or a game is open). The full tour opens the chat at its say-hi step,
  so the greeting can land mid-tour; the card waits for the tour to end.
- **Buttons reuse existing paths.** Chess and Minecraft go through
  `requestGameLaunch` + `openGame` (the Play together tiles), the call through
  `startOrOpenCall`. Minecraft is offered only when a LAN world is open (then
  it leads) or an install was detected; otherwise chess leads, with no install.
  "Not now", any tile, or the player typing a message instead (`typed`)
  retires the card for the session. Nothing persists; an account scope change
  resets the store. LAN state is read from main at planning time (the state
  main's greeting turn sees), falling back to the renderer's cached copy.
- **Failure is silent.** An existing transcript, a chat already loaded this
  app session (`already_loaded`), a message typed before the card was up
  (`typed_first`), an empty greeting, a thrown greeting call or a planning
  error settles the store as `failed`: the plain chat, no card, no error.
  Main pushes the greeting's thoughts only after `prepareChatTurn` succeeds,
  so a failed prep cannot leave "a button will appear" queued for the
  player's first message. The one-time Backseat tip is held back while the
  moment is pending or showing (`shouldShowBackseatTip.firstMomentLive`).
- **Analytics (shape only, renderer `sei.track`):** `first_moment_shown
  {primary, minecraft_offered, companion: sui|generated}`,
  `first_moment_action {action: chess|minecraft|call|dismiss|typed, primary,
  ms_since_shown}`, `first_moment_fallback {reason}`. Not session events, so
  nothing to add to `SESSION_EVENTS`.
- **Verify in a tab:** `?dashshot=chatfirst` (chess + Minecraft + call),
  `&nomc=1` (chess + call), `&lan=1` (Minecraft leads). The harness greeting is
  a stub; the live greeting's wording is the model's.

## Chess minigame (260710)

An in-app untimed chess game against the character, launched from the "Play
together" tiles. **Mutually exclusive with a Minecraft summon** per character.

- **Engine:** `vendor/cce-1` (public repo `sei-studio/cce-1`, AGPL-3.0) — the
  Character Chess Engine: Maia-3 ONNX (Elo-conditioned human move
  distributions, via onnxruntime-node) + tempered Gumbel-top-4 sampling +
  blunder/blinder layers + Stockfish WASM (bundled, 7 MB) + plain-language
  translation. The engine fixes STRENGTH; the LLM picks among 4 candidates and
  can only express STYLE. The 21 MB Maia model (`maia3-5m.onnx`, our own ONNX
  export of the official AGPL-3.0 Maia3-5M checkpoint from CSSLab/maia3, via
  cce-1 `scripts/export-maia3.py`) is NOT bundled — it downloads on first
  chess launch (`src/main/chess/modelStore.ts`, cce-1 GitHub release asset,
  cached in userData; dev machines use `~/.sei-dev/cce/`).
- **Service:** `src/main/chess/chessService.ts` owns the authoritative board
  (chess.js) + the LLM turn runner (chat-brain path, tools `play` /
  `propose_draw` / `forfeit`; illegal moves get a retry tool_result). Since
  260714 turns ride the game-agnostic FSM core (`src/bot/brain/fsm.js`, one
  queue per session): P1 player chat (consecutive sends coalesce into ONE
  reply turn), P2 `your_move` (the decision — atomic, never aborted or
  re-run), P3 idle ticks (sampled 25–90s with silent-streak backoff; the
  prompt says a line is optional and silence is normal). The decided move
  enters a presentation HOLD: a sampled prethink think-delay (cce-1 `think`
  signals: Maia policy entropy + candidate eval closeness → log-normal, so
  most moves answer fast with occasional tanks) before commentary +
  `pendingAiMove` present, then the renderer's 2s-quiet postthink gate
  (`useAiMoveReveal` settle window) before the ack commits. A player chat
  during the hold NEVER rolls the move back: the reply turn is told the
  queued move and can revise it (`play()` again, free — same cached
  candidates) or hold it back (`wait()`: pendingAiMove retracts, only player
  messages/idle ticks wake it, cap disarmed). A hard cap (4 reply cycles or
  45s, `CHESS_TIMING`) force-commits so chat spam cannot stall the game.
  Move prompts carry translated last-two-ply delta sentences + move number,
  never raw SAN history (the commentary-hallucination fix); table talk is
  optional (a silent `play()` ends the turn). Protocol contract:
  `src/shared/chessIpc.ts`.
- **Chat routing:** while a game is open, `chat:send` is handled by
  `handlePlayerChat` in the chess service (game-aware replies, queued at P1
  on the session FSM), not the standalone chat brain.
- **Profile:** per-character strength/style at `character.metadata.chess`
  (`{elo 400-2000, styleNote, source auto|user}`) — auto-derived from the
  persona by a one-off LLM call on first game
  (`src/main/chess/chessProfile.ts`), user-editable in Edit companion → Games.
- **UI:** `src/renderer/src/components/chess/` (board, panel, reveal-gating
  hook) + `useChessStore`; the board opens as a right-side panel inside
  ChatScreen, compressing chat to a narrow column.
- **Packaging:** onnxruntime-node ships all-platform prebuilds; per-OS `files`
  excludes in `electron-builder.yml` drop the foreign ones.

## Draw! minigame (260727)

Turn-based sketch guessing, launched from the "Play together" tiles. **Mutually
exclusive with a Minecraft summon and with chess** per character (the shared
`lib/gameLaunch.ts` gate).

- **Shape:** always `ROUNDS` (3) rounds; the 1-5 setup chooser was removed
  260728, since it is a choice nobody has the information to make before their
  first game and does not want to make again after it. MIN/MAX survive only as
  the bounds main clamps an incoming `drawStart` to. Each ROUND is two
  TURNS: the player draws while the character guesses, then the character draws
  while the player guesses. Every turn is capped at `TURN_MS` (3 min) and ends
  early the instant the guesser says the word. Contract:
  `src/shared/drawIpc.ts`. Before each of the PLAYER's turns a `'pick'` phase
  offers `WORD_CHOICES` (3) words and the turn clock does not start until they
  choose (`beginTurn` sets the phase, `startDrawingPhase` arms the clock, and
  `pickDrawWord` is the only thing between them). The character is dealt its
  word directly, so `wordChoices` in the pushed state never reveals anything it
  drew. "Play again" returns to the setup screen (`drawNewGame`) rather than
  restarting in place, so the player lands somewhere they can stop.
- **The chat log is a PROMPT, and it used to leak (260728).** Every system line
  is replayed verbatim into the character's next call, so
  `"Round 1 of 3. Your turn to draw: horn."` did two things at once: handed the
  GUESSER the answer, and read as second-person instruction to the model, which
  is why the character believed it had drawn the player's words and
  misattributed whole rounds. Fixed with `DrawChatMessage.modelText` — an
  optional third-person, secret-free wording that `renderChat` prefers and the
  renderer ignores. **Any new system line written in the second person, or
  naming a live word, MUST carry one.** `drawPrompts.test.ts` pins this. The
  same call sites also now get an explicit `roundsRecap` (who drew what, who
  got it) in all three turn blocks, because chat only ever implies attribution.
- **The instructions go BELOW the chat log, and every block ends on the role
  (260728).** The recap above was not enough on its own, because the chat
  sections were appended to the END of each turn block and they are the biggest
  thing in it: the last text the model read before answering was chat from the
  PREVIOUS turn. Live capture: the character guessed the player's drawing
  correctly, and its turn-end line was "hehe ok you're reading these too fast,
  that's not fair" — a drawer's frame, continued straight out of the banter
  sitting at the bottom of the prompt, while `YOU GOT IT` sat 2000 tokens above
  it. `contextSections()` now emits recap + chat (chronological) FIRST, and each
  block closes on one line naming the role ("Right now: you are GUESSING..."),
  pinned by `drawPrompts.test.ts`. Applies to any new turn kind.
- **Game surfaces do not get the chat baseline (260728).** `buildSystemBlocks`
  takes `surface: 'chat' | 'game'`; Draw! and chess pass `'game'`, which swaps
  `CHAT_BASELINE` for `GAME_SURFACE_BASELINE` (`promptLibrary.js`) and drops two
  chat-only tails: the timestamped-messages note and the Minecraft
  connection/`launch()` status block. The old prompt told a character sitting at
  a canvas "This is a text chat, not a game... your text output IS the message
  the player reads, like a real person texting", and it showed: it talked about
  the player "reading" its drawing and said "waiting for you to read this lol"
  mid-turn. It was also being briefed on a `launch` tool no game surface passes.
  Backseat and voice stay on `'chat'`.
- **Two things that baseline swap broke, and their fixes (260728).** Worth
  knowing before writing any new surface baseline. (1) `CHAT_BASELINE` ended
  with "like a real person texting", and that was the ONLY thing in the whole
  prompt telling the model its output was unformatted. The replacement said
  "not like someone texting", and Haiku started emphasising its guesses ("is it
  a **hearing aid**?") to match the markdown of the prompt around it.
  `GAME_SURFACE_BASELINE` now bans markup outright AND `plainLine()`
  (`src/main/chat/plainLine.ts`) strips it on the way out, the same
  deterministic backstop the bot has had since 260615 in `postProcessSay`.
  Wired into Draw!'s three emit points; chess, backseat and chat still pass
  markup through. (2) The role sentence that closes every turn block names the
  player, so the LAST thing the model read was their name in the third person,
  and it began calling them by name in chat instead of "you". Fixed in the same
  recency slot: the closer now carries "say you, never their name", and the
  contract block repeats it.
- **The drawer's own word never reaches chat.** `saysWord` (the tolerant
  redaction pattern asked as a question) drops the line WHOLE for both sides and
  posts a system line in its place; the character additionally reads "you are
  drawing it, not guessing it, do not respond". The old behaviour patched the
  word to `[...]` in place, which still pointed at exactly where the answer went
  and read as a bug rather than as the game stepping in.
- **Guessing is literal, not semantic.** `matchesWord` (`guessMatch.ts`) is
  whole-word containment in any sentence, forgiving only case/punctuation, a
  trailing plural on either side, and a closed-up two-word answer ("hotdog").
  Fuzzy matching was rejected deliberately: the guesser cannot tell why a
  near-miss counted. `redactWord` is the backstop that keeps the DRAWER from
  handing the round away.
- **Own canvas, no dependency.** tldraw's SDK is not free, Excalidraw is far
  too heavy, and `perfect-freehand` gives variable width where the game wants
  one thickness. The real requirement was a stroke DATA model (needed for the
  stroke eraser, snapshots, playback and export), so it is hand-rolled:
  `drawRender.ts` is the single painter shared by the live canvas, the snapshot
  the character looks at, and the gallery PNG.
- **The character's GUESSING turn** rides a 500ms poll over a PURE policy in
  `guessSchedule.ts` (3 strokes since the last dispatch, or 10s; never within
  5s of the previous guess COMPLETING; single flight). "At most one queued
  guess" needs no queue: strokes drawn during an in-flight call leave the
  counter high and the single dispatch that follows resets it. Two edge cases
  are load-bearing and tested: an UNCHANGED canvas never reaches the model (the
  snapshot PNG is hashed), and a LONG single stroke still triggers (the
  snapshot includes the in-progress stroke, so no committed stroke is needed).
- **The character's DRAWING turn** is a real tool-use thread on `s.draw.thread`
  carried across hops, NOT a fresh call per hop. A picture needs more strokes
  than one response returns (the model stops on `tool_use`), and without the
  thread it re-starts the picture every hop, because "you have drawn 4 strokes"
  says nothing about WHERE. The `pen` tool is adapted from tldraw's
  agent-template `PenAction` (MIT), narrowed to `{intent, points, style,
  closed}` — no colour, no fill, no ids, since black-at-one-thickness is all
  either player gets.
- **The drawer gets EYES, rationed (260728).** It used to draw blind: the
  guesser was sent a real snapshot every few seconds and the drawer got the
  sentence "3/16 strokes used". So it could not tell that its picture was two
  overlapping blobs filling a tenth of the page, and it stopped after three
  strokes with two minutes left because it believed it was done. Now a hop woken
  by a player line attaches a snapshot of the character's OWN canvas
  (`selfLookNote`), rationed like the guess scheduler: only when the player just
  said something, and never twice inside `SELF_LOOK_COOLDOWN_MS` (12s). It comes
  with a `clear` tool (wipe and start again, `MAX_CLEARS` 2 per turn, bumping
  `DrawGameState.clearSeq` so the renderer drops its locally revealed strokes
  without ending the turn) because a model that cannot pick a stroke to erase
  needs all-or-nothing. The stroke guidance is a FLOOR now ("at least 6, do not
  stop before the outline and the main internal structure exist"); it used to
  read "16 at most, and fewer is usually better", which is a ceiling plus a nudge
  downward, and the character took it. A clear is a promise to redraw IN THE
  SAME TURN, and relying on the model to keep that promise down a long thread
  kept failing live (260728's single blank-nudge hop was not enough either). So
  260729 ports the web engine's RESTART design: a clear that is not followed by
  a redraw in the same response RESETS the drawing thread, and the next call
  opens fresh on a `DrawRestart` block ("the page is blank, start again")
  carrying the wiped attempt's own stroke `intent` strings so it draws the word
  a DIFFERENT way instead of the same picture twice. The engine also wipes a
  failed picture itself (auto-clear: `AUTO_CLEAR_WRONG_GUESSES` 6 wrong lines,
  once per turn, only past `AUTO_CLEAR_MIN_STROKES` and with
  `AUTO_CLEAR_MIN_LEFT_MS` left) — waiting for the model to decide to clear was
  measured optimistic. A text-only response on a BLANK canvas (cleared or
  never-drawn) gets a bounded corrective hop (`blankNudges` <= 2, reset per
  wipe) folded into the next user note before the turn may park.
- **The drawing turn has an idle backup (260729, from the web).** A parked
  runner (done, or out of strokes) used to wake ONLY on player chat, so a
  silent player meant the character sat on a three-stroke picture for the rest
  of the turn — the "no changes to drawing for 30 seconds" bug. The AI turn's
  free poll slot hosts `tickDrawIdle`: after `DRAW_IDLE_NUDGE_MS` (30s) of
  quiet (not inside the last `DRAW_IDLE_FLOOR_MS` 20s), the runner re-enters
  with `idleNudge`, which bypasses the park conditions for exactly one hop,
  attaches fresh eyes on its own canvas, and says "they have not guessed it
  yet: add the giveaway detail or clear and draw it differently". The
  guesser-side `UNCHANGED_NUDGE_MS` also dropped 30s -> 10s (equal to the time
  trigger) so a paused player still hears something every ~10s.
- **The game is the referee (260729, from the web).** Live, the character told
  the player a wrong guess was right ("yes! that's it!") and invented a round
  change, because nothing said the engine adjudicates. `drawContractBlock` now
  states it (never declare a guess correct, never write a `[game]`-prefixed
  line), the drawing turn restates it, the pending-chat note says every line
  already failed the check, and `isFakeGameLine` drops fabricated `[game]`
  lines at all three emit points as the backstop.
- **The character's lines wait for their strokes (260729, from the web).**
  Main pushes chat the instant the model emits it, but stroke reveal plays at
  hand speed, so "you've got all the parts there" used to land while the canvas
  was two strokes in. `DrawCanvas` exposes a playback-barrier seam
  (`DrawCanvasControl.queueBarrier`): DrawScreen holds each of the character's
  drawing-turn lines behind a barrier queued at arrival, released when playback
  reaches it. Barriers FIRE on turn reset rather than vanish, so a held line
  can never leak.
- **Chat routing + voice calls (260729).** While a Draw! game is live
  (`drawing`/`turn-end`), `chat:send` routes into `drawService.handlePlayerChat`
  exactly as chess does — which is also how a line DICTATED on a live voice
  call lands in the game as a guess. The reply comes back over the draw:state
  push, so the handler returns `{replies: [], streamed: true}`. On a live call
  every line the character says in the game is additionally pushed as a
  `voice: true` chat message (`speakOnCall`) — spoken by the renderer, never
  rendered, and deliberately NOT persisted (the per-line game chat stays out of
  the transcript). Calls are NOT exclusive with games: `isGameSurfaceOpen`
  (callLaunch.ts) and CallMiniBar's `gameActive` both count Draw! and backseat,
  so the phone starts the call in place and ending the game returns to the
  fullscreen call view.
- **Game chrome (260729).** The Draw! page carries the same universal bottom
  button row as the chat-hosted surfaces: `GameChromeRow`, extracted from
  GameSurface — fullscreen toggle, the call cluster (or the phone chip that
  starts a call when none is running), and the unified end "x" with the
  end-game confirm. The old top-right corner fullscreen/x buttons are gone.
- **Mid-turn hops re-state the address rule (260728).** The drawing turn's
  opening block closes on "say you, never their name", but by hop five that
  line is thousands of tokens up the thread and recency wins (the same failure
  contextSections exists for): live, mid-drawing scratchpad lines like
  referring to the player as "they" landed in chat. Every hop's user note now
  ends on the address rule + "you have NO private channel", the contract block
  bans "they/them" and inner monologue outright, and both turn-block closers
  say `never their name or "they"`.
- **Humanization** (`strokeHumanize.ts`) resamples, offsets along the normal by
  smooth noise, overshoots the end, and samples playback timing. It is seeded
  from the stroke id and therefore DETERMINISTIC — the gallery and the exported
  PNG must redraw exactly what the player watched appear.
- **Streamed playback:** strokes leave on `draw:ai-stroke` as their tool_use
  block completes, so the first stroke is on the player's canvas seconds before
  the model has finished the picture. `strokes` in the pushed state is
  deliberately NOT authoritative during the character's turn (main knows the
  whole picture early); the renderer reveals from the push and snaps to state
  at turn end. Same idea as the chess reveal gate, without the ack.
- **`word` is never sent to the guesser.** `visibleWord()` returns it only
  while the local player is drawing, or once the turn has ended.
- **Continuity (260728):** both turn kinds offer `remember()` (tool_result note
  on the drawing turn's loop, honored inline on the single-shot guessing turn),
  and `finishGame` writes one play row naming the words each side drew, then
  fires `foldIfDue`. The per-line game chat is deliberately never persisted.
  See the continuity contract below.
- **UI:** `src/renderer/src/components/draw/` + `useDrawStore`. It is a
  full-page ROUTE (`{kind:'draw'}`, IconRail KEPT; only in-app fullscreen drops
  it), not a chat-screen aside,
  because the game wants canvas-beside-chat and a white handdrawn register.
  `draw.module.css` is a **deliberate, documented exception** to the
  tokens.css rule: it declares a scoped palette on `.root` instead. Three rules
  hold the surface together, and each one was a bug before it was a rule
  (260728):
  - **ONE INK.** Black on white and nothing between. No hairlines, no dimmed
    captions, no soft placeholder, no green "correct" text. Anything that needs
    to recede does it by being small or by being said once. The only
    non-monochrome value is `--accent`, and it is a highlighter that only ever
    sits BEHIND black text.
  - **TWO SIZES.** `--fs-title` and `--fs-body` are the whole handwritten
    scale. That face has no weights to grade with, so a third size reads as a
    mistake rather than as hierarchy. The typed half (Roboto Mono, Apache-2.0,
    self-hosted, Draw!-only) is a separate voice at one much smaller size
    (`--fs-typed`), used for the game's own apparatus: round counter, clock,
    system lines, speaker names. Both faces use ordinary letter casing.
  - **ONE PEN.** Every line is `--hand-stroke`, republished by `DrawCanvas` onto
    the surface ROOT (not its own parent) so the rules, chat box and buttons
    track the canvas scale instead of drifting onto a static fallback. Nothing
    may use `text-decoration: underline` (use `SquiggleUnderline`), a CSS
    border, or a native control that draws its own track — an
    `<input type=range>` is why the round chooser is gone. `-webkit-text-stroke`
    corrects the TITLE only: applying it to body text was tried and reverted,
    because at 22px it does not read as a heavier pen, it reads as bold.
  - **THE START PAGE DOODLES ARE VECTORS, NOT IMAGES.** They are shown at three
    different sizes (crown small, shrimp and horse large), and a scaled bitmap
    scales its line weight with it, which lands three different pen widths on a
    page whose whole premise is one pen. So `doodles.ts` holds their
    CENTRELINES, generated by `scripts/trace-doodles.py` (threshold, Zhang-Suen
    thinning, spur pruning, graph walk, Ramer-Douglas-Peucker), and `Doodle.tsx`
    draws them with `vector-effect: non-scaling-stroke` so `stroke-width` means
    screen px: geometry scales, stroke does not, and the width is
    `--hand-stroke` like everything else. Two traps that cost real time and are
    worth knowing before touching that script: `Image.convert('L')` DISCARDS
    alpha, so a transparent-background source reads as solid ink and the trace
    comes back as the bounding box; and an 8-connected skeleton has redundant
    diagonal shortcuts that look like junctions, which shreds every stroke into
    crumbs the length filter then deletes. Both are handled and commented.
  - **THE YELLOW IS A HIGHLIGHTER.** `--accent` only ever sits BEHIND black,
    never as a text colour, and its shape is `SquiggleHighlight` (a rough,
    bleeding blob, `rect` or `ellipse`) rather than a CSS background. A filled
    rectangle is the one shape this surface does not draw. It is always mounted
    and revealed with opacity, because `:hover` cannot mount a component and
    re-seeding the shape per pointer-entry makes it crawl. Anything that must
    stay readable on top of it needs `.btnLabel` — a bare text node has no box
    to raise above an absolutely-positioned sibling. On a winning guess the
    swipe sits behind the WORD, not the sentence (260728): main locates it
    (`findWordMatch` in `guessMatch.ts`, the same token walk as `matchesWord`
    with raw-text spans) and ships `DrawChatMessage.correctRange`; the
    whole-line swipe survives only as the fallback when the span is missing.
- **The saved PNG is a square share tile,** not a screenshot of the page: a
  big centred lowercase `draw!` on the yellow highlighter blob (260729; the
  web tile says `draw! with sui` because it fronts one character — the app
  tile stays just `draw!`), a row per player with the art scaled to whatever
  fits 2 x rounds cells, `sei.gg/draw` bottom right, and NO score (the same
  reasoning that keeps results out of the play row). Cell size is the smaller
  of the width-fit and height-fit, which is what stops one round producing two
  enormous cells. The on-screen gallery matches (260729, from the web): no
  header, scores in the row names, guessed words on the highlighter, cells a
  flex row hugging height-driven art (a 1fr grid left a moat of slack). The
  bug that motivated the redesign: the gallery reused the game view's `.score`
  class, whose `height: 100%` made a one-line paragraph swallow the page and
  starve the `flex: 1 1 0` rows to zero — the "empty gallery". It previously rendered a magnified crop of each
  drawing's corner: `paintStrokes` resets the transform outright, so a caller
  that translated first had its translate discarded and got clipped to where it
  meant to paint. Pass `PaintOpts.translate` instead of translating first.
  "Save to Downloads" confirms with an in-page popup (260728): "Saved!", the tile
  itself, and an x button. It is anchored to `.gallery` (position: relative) so
  the paper-toned backdrop never covers the IconRail, and it opens only after
  the file is actually on disk — `useDrawStore.saveGallery` resolves the
  written path (null on failure) precisely so the popup cannot claim a save
  that did not happen.
- **A single drawing saves too (260801, ported from the web).** Clicking a
  gallery cell composes `composeCellPng` — the same square sheet, pen and
  credit line as the game tile, carrying ONE drawing large with the caption
  "according to {name}, this is a {word}." on two lines, the word on the
  highlighter. The game tile is a set of thumbnails, so the one round somebody
  actually wants to post came out of it at a fraction of the resolution. Two
  details are load-bearing: the caption arrives from the component ALREADY
  localized but with `{word}` still in it (the composer has to know where the
  word sits to put the highlighter behind it alone, and `t` lives in React);
  and the drawer is named, not "you", because the file is made to leave this
  machine — the same reason the exported game tile's rows use real names while
  the on-screen sheet says "you". The popup is now shared: the whole-game save
  opens it as a confirmation ("Saved!"), a clicked cell opens it as a preview
  with the save still to offer. An empty round is inert, not a button that
  does nothing, and the affordance on a played one is the cursor alone (a
  hover tint would be a second ink).

## Call scenes + the backdrop toggle (260730)

A voice call has two views now, switched by the mountain pill beside
mute/deafen (`CallControls`, opt-in via props so GameSurface's in-game cluster
keeps its original three): the avatar tiles, or the character filling the
window. Sui is the first and currently only character with a real SCENE (her
onboarding grass field); everyone else's backdrop is their own art.

- **Scenes are DATA, not a special case.** `src/shared/callScene.ts` is the
  descriptor (backdrop layers split `back`/`front` with the actor sandwiched
  between, plus actor poses `idle`/`talk`/`walk`, rest position, entrance);
  `renderer/src/lib/callScenes.ts` is the registry + resolver + pure geometry;
  `components/call/CallScene.tsx` is the generic renderer. The whole point of
  the seam is that user-authored scenes only have to produce a descriptor —
  `resolveCallScene` starts reading `character.metadata` and nothing else
  changes. Every visual slot is one `ScenePaint` union (`images` cycled on a
  timer, or a `video`), so "scene image/video" and "talking animation
  image/video" are the same thing to the renderer.
- **Every pose degrades.** Only `idle` is required: no `walk` fades in at the
  rest position, no `talk` stands and speaks. The customization UI will let
  people upload one image and nothing else, and that has to work.
- **The `back`/`front` split is load-bearing.** Sui stands ON the ground art
  but BEHIND the grass tufts, which is what makes her read as in the field
  rather than pasted on it. Any scene with foreground detail needs the seam.
- **SCALE LOCK,** inherited from `onboard/OnboardScene.tsx` and for the same
  reason: layers and sprite live in ONE fixed-aspect stage that covers the
  window bottom-anchored, so both scale by one factor. Sui's 66% width is not
  framing taste, it is the size at which her line weight matches the layer
  art's. All descriptor positions are stage FRACTIONS, never px.
- **The choreography, and why the order matters.** The backdrop is up the
  instant the call view mounts (pressing call must land you somewhere; waiting
  on a connection would make the scene read as a loading screen). The character
  waits off-stage and walks on when the call goes LIVE, so the walk reads as
  her answering. Her first line waits until she has ARRIVED — otherwise she
  greets you from off-screen mid-stride.
  Only a call that is ALREADY LIVE at mount may skip the entrance. The first
  cut tested "status is not connecting", which meant every dial skipped it and
  she was simply drawn standing: pressing call mounts the screen and dials from
  an effect, and child effects run before the parent's, so the store still says
  `idle` for one tick. For the same reason the error/idle release must fire on a
  TRANSITION, not on the mount value.
- **`speakingId` now means AUDIBLE, not queued (260730).** It used to be set
  when a line reached the audio queue's playhead, which for a streamed clip is
  before the TTS request has even been sent: the whole synthesis round trip sat
  between the signal and the first sample. Every visible sign of speech in the
  app was therefore early — the avatar rings on all five call surfaces, the
  caption, and (where it became impossible to ignore) the scene's talking
  animation. `useVoiceStore` now publishes the START of speech from the queue's
  `onAudible` callback, which already existed for the barge-in grace window and
  now carries the speaker and the line; only the STOP still comes from
  `onSpeakingChange`. The dictation half-duplex hold deliberately stays on the
  SLOT (see the comment there) — the synthesis gap must keep the stiffer barge
  bar. So: anything the player SEES follows `onAudible`; anything arbitrating
  the microphone follows the playhead.
- **The greeting gate reuses the buffer that already existed.**
  `useVoiceStore.introHold` (+ `setIntroHold`) extends the `'connecting'`
  buffering window that `flushPendingCompanionLines` already drains; the
  greeting is still fired at dial time and generated during the ring, nothing
  is regenerated or dropped. THREE layers keep a scene bug from muting a call:
  `CallScene`'s timer backs up its own `transitionend`, `CallSceneHost` drops
  the hold on error/idle/unmount, and `setIntroHold(true)` arms an
  `INTRO_HOLD_CAP_MS` (8s) auto-release.
- **No scene? The character's art,** full-bleed, painted `cover` and draggable
  vertically (`CallBackdrop` + the pure maths in `lib/callBackdrop.ts`). One
  `cover` rule covers both pane shapes: on a wide window a portrait is
  width-driven and overflows vertically (the "fit to width, drag up and down"
  case), and in a narrow split column it flips to height-driven and simply
  fills instead of letterboxing. Drag maps px→`background-position-y` % through
  the real overflow so the art tracks the cursor 1:1. Characters with no
  uploaded art fall back to their procedural portrait as pixelated wallpaper.
- **Group calls never get a scene** (a scene stages ONE actor): they always get
  split art, one equal column per participant, with the non-speaker dimmed
  since the portraits that used to say who is talking are gone. Adding a
  participant to a live scene call unmounts the scene into the split, and the
  unmount releases the intro hold.
- **The preference is per-character and SPARSE.** `UserConfig.call_backdrop` is
  a `Record<characterId, boolean>` keyed on the DIALED character
  (`participants[0]`), hydrated into `useUiStore.callBackdropByCharacter`. An
  absent key means "never chosen", which is NOT false: a character with a scene
  opens in it, everyone else opens on the tiles. Writing false for every
  character on first call would flatten that, which is why the Zod field has no
  `.default({})` either.
- **Chrome hides in backdrop mode.** Name, status and the control pills
  collapse into one bar revealed on pointer-proximity to the bottom edge (the
  same reveal GameSurface uses), always shown while not live so a ringing or
  failed call is never un-hangupable. Captions and the STT-fallback offer stay
  visible — an accessibility aid you have to hover to read is not one.
  `.stageBackdrop` sets `isolation: isolate` because positioned children paint
  above static siblings, so without a stacking context the art would cover the
  captions it sits behind. The bar has **no panel behind it** — a box cuts a
  rectangle out of the picture the mode exists to show. What separates it from
  the art instead is a drop-shadow plus a theme-INDEPENDENT treatment for
  anything sitting on top: `CallControls`' `onArt` variant (fixed dark scrim,
  white icons, hang-up keeps its red) and white chrome text. The theme's own
  colours are chosen against the app's surface, so on art they fail one way in
  light and the other way in dark. Same reasoning the share view uses when it
  paints its own chrome over someone else's screen.

## Avatar overlay (260804, grew out of the 260706 "call overlay")

The always-on-top overlay window is now the companion's desktop presence:
static portrait tiles or a per-character Live2D model, shown per
`avatar_mode` in UserConfig: `'off' | 'activity' | 'always'` ('activity' =
any live surface: call, chess, Draw!, backseat, MC summon; 'always' falls
back to the LAST-INTERACTED companion — the Home wall's `lastInteractionAt`
recency, not the open chat, so switching chats never swaps the desk
companion). The field is OPTIONAL with no default;
**read it only through `effectiveAvatarMode`** (characterSchema), which folds
the deprecated `call_overlay_enabled` boolean (`true` → `'activity'`) so old
configs keep their overlay without a migration. The player's own tile is
GONE; the overlay is AI-only. Design doc: `.planning/avatar-v06-260804.md`.

- **Window** (`src/main/callOverlay.ts`): click-through by default with
  `setIgnoreMouseEvents(true, {forward: true})` so hover still reaches the
  page (forward is Win/mac only; Linux stays display-only). Interaction is
  split into VIEW and EDIT modes (260805; camera rework + per-region
  interactivity 260806): view cannot resize — hover shows the chrome buttons
  bottom-right, raised one button height off the bottom edge (pencil with
  the hold-to-drag move button above it, plus mute + captions while a
  call/backseat is live) and, for STATIC tiles only, the outline (a Live2D
  companion stays frameless until edit mode); clicking the pencil enters
  edit mode, where it becomes a tick and the window/character controls
  split: the corner handles are the ONLY way to resize the window
  (`avatar:overlay-resize`), the hold-to-drag button (both modes) is the
  ONLY way to move it, and the wheel + drag over a Live2D tile act on the
  CHARACTER instead — a per-character camera (zoom to half body/face, pan
  within the tile) streamed over `avatar:overlay-camera` and persisted in
  `avatar_overlay.cameras` (Live2DView applies it on top of the contain fit,
  in tile fractions so a framing survives resizes). **The character herself
  is click-through like the caption window** (260806): real clicks
  (`avatar:overlay-interactive`) are requested only while the pointer is
  over the chrome BUTTON COLUMN (a 160 ms leave-delay keeps the flag from
  flapping at its edge) or for the whole edit mode, so a click over the
  tile lands on whatever is under her. That is also why the drag button is
  ordinary chrome streaming screen deltas (`avatar:overlay-move`, mirrors
  the caption window's move) and NOT `-webkit-app-region: drag` — an
  app-region swallows pointer events, which would blind the column's
  enter/leave tracking. The window is
  **`resizable: false`**:
  a frameless resizable window keeps invisible OS resize-frame regions along
  its edges — exactly where the corner handles sit — and a click there is
  window-frame interaction (macOS ACTIVATED the app; the frame fought the
  handles' CSS cursor). All programmatic resizing is setBounds, which
  ignores `resizable`; the corner handles stream BOTH tile axes (free-form
  since 260807: `avatar_overlay.width` beside `size`, absent = square), so
  the window resizes into any rectangle — the Live2D tile contain-fits it,
  static portrait tiles stay square at the smaller axis. Both overlay windows also set
  **`acceptFirstMouse: true`** (260806): without it, the FIRST click into the
  window while Sei is not the active macOS app is an activation click — it
  raised the main Sei window and never reached the handle. Geometry persists in
  `UserConfig.avatar_overlay`, written by MAIN only (not renderer-settable).
  **Every SETTLED bounds change is clamped fully inside the matched display's
  work area** (`clampToWorkArea`, 260819: creation, display change, the resize
  stream, move END; the caption window's move end matches) — geometry
  persisted on a big monitor otherwise landed the window off-screen or bigger
  than a small screen, and off-screen chrome on a click-through window is
  unrecoverable by mouse. The move STREAM itself stays unclamped so a drag
  can cross displays 1:1 under the pointer; persisted tile sizes keep their
  requested values, so the full size comes back on a bigger monitor.
  `setContentProtection(true)` keeps the overlay out of every screen capture
  (including Sei's own backseat share), unless `UserConfig.avatar_in_captures`
  is on (260807) — the share picker's "Show avatar in screen recordings"
  toggle, OFF by default, applied to both overlay windows live from the
  `config:save` handler via `setAvatarCaptureVisible`. It is ONE switch because
  the underlying flag is one: `NSWindowSharingNone` / `WDA_EXCLUDEFROMCAPTURE`
  are per-window and drop the window from EVERY capture path, so "visible to
  OBS, hidden from backseat" is not expressible. Turning it on therefore means
  a companion sharing an ENTIRE SCREEN sees her own tile (a window share cannot
  contain another window, so that path is unaffected) and her blink/lip-sync
  can trip the colour jolt arm, whose 4x3 block split is exactly the scale of
  the tile. The alternatives, if that ever needs solving properly: mask the
  overlay rect out of `captureWorker.ts`'s cell AND thumb draws, or keep her
  off the shared display entirely (second monitor) and let OBS window-capture
  her. `backgroundThrottling: false` so
  Live2D animates under a fullscreen game. Tile size is CSS off the window
  height (`--tile`), so main's sizing and the renderer's layout cannot drift.
- **Call buttons + captions window (260806).** While `onCall` (voice call
  live/connecting or a backseat share; pushed by CallOverlayPusher with
  `muted` and the `lastSpoken` line), the overlay's chrome column grows a
  mute button (relayed `avatar:overlay-mute` → main broadcasts
  `avatar:mute-request` → the pusher flips `useUiStore.callMuted`, the mic's
  single source of truth, and the icon updates via the state re-push) and a
  captions button. Captions toggle a SECOND overlay window
  (`src/main/captionOverlay.ts`, `?captions=1` → `CaptionOverlay.tsx`): white
  companion lines over a darkened box, riding the same `voice:overlay-state`
  pushes (main enriches the renderer-pushed state with `cameras` +
  `captionsOn` before forwarding). The caption window is click-through ALWAYS
  outside edit mode (no hover chrome, plain `setIgnoreMouseEvents(true)` — the
  cursor works on whatever is under it); the avatar overlay's pencil relays
  edit mode over `avatar:overlay-editing`, which makes it interactive: corner
  handles resize, drag anywhere moves, +/- buttons step the font. The font
  size is FIXED by design — a line that does not fit is broken into chunks
  (`lib/avatar/captionChunks.ts`, pure + tested, CJK counted double) and paged
  at reading speed, so a bigger font just pages more often. The caption
  FOLLOWS THE VOICE (260806): chunks advance only while the speaker is
  audible, the linger after speech is short (1.5 s), and a confirmed barge-in
  clears `lastSpoken` outright (useVoiceStore onBargeIn) so an interrupted
  line's caption vanishes with the audio instead of paging on. Captions are
  OFF by default (main-side `enabled = false` until toggled). Edit mode also
  SUBSTITUTES for the live call in the caption window's show condition
  (260806): with captions enabled, entering edit brings the box up with its
  placeholder even off-call, so it can be positioned and sized before any
  call exists. Geometry + font + enabled persist in
  `UserConfig.avatar_captions` (MAIN-owned, like `avatar_overlay`).
- **Per-character prefs** (`UserConfig.avatar_prefs`, sparse like
  call_backdrop): `frame` ('circle' | 'square') + `always_bright` (kills the
  talking indicator: no idle dim, no ring) + `tab` (which profile sub-tab,
  Static or Live2D, was last chosen). Deliberately NOT in
  `character.metadata` — metadata cloud-syncs verbatim and is not editable on
  foreign characters. Edited from the profile's third tab (CharacterPage →
  Avatar → Static), which writes read-modify-write through `saveConfig`.
- **Live2D store** (`src/main/avatar/avatarStore.ts`): a model ZIP imports
  into `<profileRoot>/avatars/<id>/` (manifest.json + extracted tree),
  LOCAL-ONLY — nothing rides metadata, a character adopted elsewhere just
  falls back to the portrait tile. **Cloud seam (260819, upload side not
  built yet):** `cloudAvatarOf` in characterSchema reads an optional
  `metadata.avatar = {url, size_bytes}` descriptor (https only; malformed =
  null). When present and nothing is imported locally, the profile's Live2D
  tab swaps the upload box for a user-uploaded-content disclaimer (many free
  Live2D models forbid commercial use, so the copy must say Sei is not
  affiliated + point at Report; 'live2d' is a report reason, mirrored in the
  proxy's `REPORT_REASONS`) and a "Download (xx MB)" button — `avatar:
  download` resolves the URL from the character row IN MAIN (the renderer
  only names the character) and runs the fetched zip through the same import
  pipeline. The upload state carries a give-credit-in-your-description line
  for third-party avatars. Import NORMALIZES the stored model3.json
  because real VTuber exports ship expressions the settings never reference
  and sometimes no EyeBlink group (both measured on the first test model):
  it registers every `*.exp3.json`, ensures the EyeBlink group, maps
  expression names → the closed `AvatarEmotion` set by bilingual filename
  keywords (泪→sad, 害羞→shy, ...), and rejects traversal/junk entries. Zip
  filenames decode GBK-first (VTube Studio on Chinese Windows; cp437 is the
  spec fiction). **Every stored path is renamed ASCII-safe and all settings
  refs (Moc/Textures/Physics/Pose/DisplayInfo/UserData/Expressions/Motions)
  are rewritten to match** (`buildSafePathMap`): the plugin's FileLoader
  compares `encodeURI(webkitRelativePath)` against RAW refs, so any name
  encodeURI changes — non-ASCII, even a space — fails its existence check
  and the model refuses to load (measured: the moc3 itself "doesn't exist").
  Display names (manifest.name, expression Names) keep the originals, which
  is what the emotion table keys on. manifest `version: 2` marks a renamed
  store; `getAvatarManifest` lazily re-runs the same normalization over a
  v1 store's on-disk tree so early imports heal in place.
  Delete/remove-from-library/profile-import handle the dir like
  `knowledge/`.
- **Simple rig avatars (260817).** The same import flow accepts a second zip
  kind: `rig.json` + aligned full-canvas PNG layers (the chibi-rig pipeline's
  output, `~/slop/sei-studio/chibi-rig`), for characters without a real
  Cubism model. Detection is by content — no model3.json with a Moc but a
  rig.json present — and the manifest carries `kind: 'rig'` (absent =
  'live2d'); `parseRigSpec` in avatarStore validates the spec and the same
  ASCII-safe rename rewrites its refs. Rendering: hosts use
  `lib/avatar/AvatarView.tsx` (picks by manifest kind), never Live2DView
  directly; `lib/rig/RigView.tsx` is a 2d-canvas runtime implementing blink
  (160 ms triangle), the same speaking/levelRef mouth drive as Live2D (two
  open/closed patches with vertical squash), Live2DView's gaze
  (wander/cursor alternation + constant-speed glide) mapped to a head-group
  pixel translation, and damped spring followers for hair layers
  (`physics: {k, c}` per layer — hair chases the head, overshoots,
  re-converges at rest). Everything downstream (participant `live2d` flag,
  lip-sync level arming, cursor polling, overlay camera) works unchanged
  because the flag just means "has an imported avatar". Rigs have no
  expressions, so emotion/accessory plumbing no-ops on them.
- **Rendering** (`src/renderer/src/lib/live2d/`): pixi.js 7 +
  `pixi-live2d-display-lipsyncpatch` (cubism4), ALL dynamically imported.
  The proprietary Cubism 5 Core is fetched at build time by
  `scripts/fetch-live2d-core.mjs` into `src/renderer/public/live2d/`
  (gitignored — its license permits shipping it in the app, not committing
  it); `loadCubismCore()` script-injects it before the plugin import. Models
  load as in-memory `File[]` over IPC (`avatar:model-files`) — no custom
  protocol, no file:// fetches — with the manifest's entry file sorted FIRST:
  the loader picks its settings file by
  `find(name.endsWith("model.json") || name.endsWith("model3.json"))`, and
  VTube Studio extras like `items_pinned_to_model.json` match that sniff, so
  unsorted readdir order picked the wrong "settings" nondeterministically. Idle life: SDK breath/sway/blink run free on
  a motionless model (the EyeBlink group is why import guarantees it), plus
  gaze. **Gaze alternates between wander and following the real cursor**
  (260806): every 6-14 s it re-picks (45% cursor when the feed is fresh) —
  wander keeps the 2.6-7.5 s saccade cadence with correlated small steps +
  rare larger glances (full-range jumps every few hundred ms read as
  TWITCHING, the 260805 report); cursor-follow rides main's cheap
  `screen.getCursorScreenPoint()` poll (120 ms, armed only while a Live2D
  tile shows), pushed normalized around the window center over
  `avatar:overlay-cursor-state` — only the overlay window receives it, so
  the profile preview just wanders. **The focusController is fed a per-frame
  GLIDING target with `instant=true`, never a stepped one** — the SDK's
  FocusController pursues its target at constant speed (~5.3 units/s,
  decelerating only on arrival), so the old direct saccade retargets (mean
  ~5 s) yanked the face ahead for about a second mid-drift: the "jitters
  every ~5 seconds" report. The glide is CONSTANT SPEED (0.9 units/s, easing
  only in the last 0.06 units — 260806, was a 450 ms time constant: at
  constant TIME a big glance whips and a small one crawls; at constant speed
  travel time scales with distance) and is the sole focusController writer,
  which also makes the wander/cursor mode switches glide. The mouth and the gaze are written
  INSIDE a wrapped `motionManager.update` so the SDK layers blink/breath/
  physics after them in the same frame.
- **Lip sync**: TTS plays in the MAIN window, so `avatarLevelTap.ts` samples
  the clip there (RMS envelope, ~25 Hz) and relays `{id, level}` via
  `avatar:overlay-level`. **An element can only ever have ONE
  MediaElementSourceNode** — the tap reuses pitchBus's node when the clip is
  pitch-shifted (`pitchSourceFor`) and builds its own only otherwise, and it
  is armed by the pusher ONLY while a shown participant is actually Live2D
  (rerouting rate-1 clips through WebAudio is not free). No levels arriving
  while `speaking` is true → the tile pseudo-envelopes rather than freezing.
- **Expressions at speech time**: `classifyEmotion` (bilingual lexicon,
  `lib/avatar/emotion.ts`) runs on the line at first-audible
  (lastSpoken/lastSpokenId), ships in the overlay push, maps through the
  manifest's emotion table, and lives for 150% of its line: it holds while
  the line plays and lingers half the line's duration after it ends
  (EXPRESSION_LINGER_FRACTION), refreshed early by the next emotive line —
  never a fixed clock, so a quip flashes and a story holds. Deliberately not
  LLM-driven in v1 (tags would touch every surface's prompt contract); the
  upgrade replaces that one call site. Two fixes make it actually visible
  (260806): (1) an unmapped emotion borrows a mapped neighbor
  (`resolveEmotionExpression`, `EMOTION_FALLBACKS` — happy↔excited,
  surprised→excited, love→happy; negative emotions never substitute) because
  real VTuber exports rarely ship a happy/surprised face and those are the two
  classifications casual talk fires most — without the fallback the face
  almost never changed; (2) after the decay-reset, Live2DView writes
  `currentExpression = defaultExpression` on the ExpressionManager, because
  the plugin's `resetExpression` deliberately keeps `currentExpression` and
  `setExpression` refuses the current name — so the SAME emotion twice in a
  row (i.e. most sessions: happy, decay, happy) applied once and then never
  again. Both verified in the browser harness against the real model.
- **Accessory toggles (260806)**: the emotion-UNMAPPED expressions are item
  toggles (Snow Bear Girl: hat, phone, mic, controller, coat), now flippable
  per character from the profile Avatar → Live2D tab and persisted as
  `manifest.accessories` (`avatar:set-accessory` → `setAvatarAccessory`; main
  broadcasts the manifest on `avatar:manifest-state` so live views re-apply
  without reloading). They CANNOT ride the expressionManager (it holds ONE
  expression; the next emotion would knock the hat state off), so
  Live2DView resolves each toggled expression's exp3 params to ABSOLUTE
  targets against the model's parameter defaults
  (`lib/avatar/accessoryParams.ts`, pure + tested; Add/Multiply/Overwrite
  composed in order) and writes them every frame inside the wrapped
  `motionManager.update`, like the mouth. Two details are load-bearing:
  Cubism params persist frame to frame, so a toggle-OFF must write the
  dropped params back to their defaults once or the item sticks forever;
  and the v1→v2 manifest heal carries `accessories` over while a fresh
  import resets them (new model, new names). Sui's model ships "1 帽"
  (Key1 hat -1, Key22 crown +1): toggled ON = the author's no-hat crown look.
- **Pusher** (`components/CallOverlayPusher.tsx`): mode + activity stores →
  `computeAvatarIds` (pure, tested) → `voice:overlay-set`. Zod in
  `main/ipc.ts` must name every participant field the overlay renders
  (undeclared keys are STRIPPED — the backseat gridSmall lesson).

## Backseat (260728, rebuilt 260801-260804)

The companion watches a screen the player shares and talks about it live.
**Started from the CALL CONTROLS**, not from the games picker: sharing a screen
is not a game, it is what you do on a call, so it works the way Discord's does
(share button → source picker → the preview takes over the call window and the
avatars shrink to a strip). It requires a call and ends with one. Still
**mutually exclusive with a Minecraft summon** via the shared
`lib/gameLaunch.ts` gate, because a companion cannot be watching your screen
and standing in your world at once. Lines go to the SAME chat thread and the
same memory as every other surface.

The design and its measurements are committed at
`.planning/backseat-v2-260801.md`. **Read that before changing anything here.**

- **Authority split.** The renderer owns pixels and sound: `getDisplayMedia`,
  the ring buffer, grid compositing, the rolling clip recorders, local STT, and
  two of the three wakes. Main owns the session, EVERY model call, the window
  title, and (on macOS) the audio tap. Contract: `src/shared/backseatIpc.ts`.
- **Capture runs in the MAIN window (260803).** It used to run in a separate
  always-on-top overlay, because Chromium clamps timers in a hidden or occluded
  renderer and a session runs entirely while the player is inside a fullscreen
  game. That reason no longer holds alone: the main window sets
  `backgroundThrottling: false` (`windowChrome.ts`) and the frame pump is a
  `MediaStreamTrackProcessor` in a worker, which is throttle-immune regardless.
  Deleting the overlay removed a second renderer, a duplicated state copy, and
  a push fan-out. `useBackseatStore` now OWNS the capture handle for the app.
- **Four wakes, `user > start > jolt > idle`, strict priority (260801, 260803).** Higher
  preempts lower; nothing is ever queued, because a queued reaction describes a
  moment that has passed and reads as confusion rather than lateness. `user`
  always answers. `jolt` is a local gain or colour discontinuity, no model
  involved. `idle` is a shifted-exponential timer over [12 s, 60 s], memoryless
  on purpose so the player cannot learn its rhythm, reset whenever the
  companion speaks. `MIN_SPEAK_GAP_MS` (8 s) drops jolt and idle, never user.
- **A content switch waits out a dwell; only GAIN jolts are immediate (260806).**
  A colour jolt fires AT the discontinuity, and on an Instagram Reels session
  that timing made the companion reliably ONE REEL BEHIND: the swipe raised the
  tick, the grid at that instant was five cells of the old reel and a sliver of
  the new, and she reacted to the clip the player had just left, every time.
  So a colour jolt or a share-label change no longer raises a tick — it arms
  the SWITCH DWELL (`SWITCH_DWELL_MS` 6 s = the grid span, `switchDwell.ts`,
  pure + tested): the wake fires only once the new content has held with no
  further change, every further change restarts the clock, and a fast scroll
  stays silent until the player settles. The tick goes up as `jolt:'switch'`
  with `sinceSwitchS`, and the note claims the content for NOW ("everything you
  can see is the new thing... do not remark on the switch itself" — pinned in
  `backseatPrompts.test.ts`). Two supporting changes: the share-label poll
  dropped 5 s -> 2.5 s (the dwell's promise is only as accurate as the poll),
  and a dwell that expires inside `MIN_SPEAK_GAP_MS` is DEFERRED past the gap
  in the controller rather than sent-and-dropped by main, because a swipe tends
  to follow a spoken line by a second or two and the settled reel would
  otherwise go unremarked until the next idle look. The offline sim still runs
  the immediate-colour path; the dwell lives in the controller above it.
- **A new turn's speech supersedes the old one's queue (260806).** Backseat
  turns land every 10-20 s while TTS playback of a multi-part reply can run
  longer, so a new turn's lines queued behind the old turn's and the VOICE
  drifted a full turn behind the screen even when the ticks did not. Every
  turn's parts now push with `speech.turn` (one UUID per turn, plus the
  prev/more prosody context the streamed chat reply already had), and the audio
  queue drops a same-speaker QUEUED clip whose tag differs from the newly
  enqueued one — the clip at the playhead always finishes, which is the
  "current sentence ends" boundary since parts are sentence-sized. Untagged
  lines (greetings, chess, chat) are never dropped; `turn` is stripped before
  the TTS request. Backseat is the only setter today.
- **The feed rules (260806, from the same live session).** The companion called
  the recommendations feed "your feed" and "that guy's feed", treated
  consecutive clips as related, and remarked on the scrolling. SCROLLING SHORT
  VIDEOS now states what a feed IS (app-picked clips by different, unrelated
  creators; no clip replies to the previous one) and bans feed-meta commentary
  outright. Pinned in `backseatPrompts.test.ts`.
- **The remember() feedback loop, and watching is not making (260808).** On a
  reels session the companion decided caption-overlay clips were the player
  "editing captions in premiere", filed that via remember() on nearly EVERY
  jolt turn (30 entries in 14 minutes), and each next turn read its own guess
  back as established fact — three explicit corrections from the player could
  not break the loop, because twenty memory lines outweigh one history line.
  Side effect: every write churned the memory block inside the cached prefix,
  so cacheRead sat at 0 all session. Two-part fix: `honorRemember` throttles
  SCREEN-driven remembers to one per `REMEMBER_COOLDOWN_MS` (180s) — a
  remember on a USER tick is always honored, since dropping those is how a
  correction gets forgotten — and the contract gained WATCHING IS NOT MAKING
  (finished-video shapes like word-by-word captions and repeated takes are not
  evidence of editing; the player's own account OUTRANKS the screen
  permanently; memory saves what they SAID, never a screen reading). Pinned in
  `backseatPrompts.test.ts`.
- **Register loops on a static screen (260807).** The email session: six turns
  against one unchanging inbox frame and a monosyllabic player, five of six
  lines opened "wait / you're actually..." — the same take re-litigated as a
  fresh discovery each turn. Replayed offline (harness + all measured arms in
  `.backseat-sim/email-replay/`, 16 runs x 6 turns per arm): the persona's own
  "actually"/"wait" sample lines are NOT the cause (stripping them all moved
  nothing), and quoting the offending phrase inside a contract ban FEEDS it
  (+16 pts) — name the shape in prose, never quote the line, which sharpens
  260806's lesson. REPEATING YOURSELF was rewritten (same length) to ban
  shape-level repetition: same opener as your last line, pet words your recent
  lines already used, re-presenting known facts as discoveries, re-opening
  answered questions. Measured across 156 lines/arm: "actually" 47%→37%,
  loop sessions 54%→38%. That is the prompt-space ceiling — the residue is
  Haiku's register prior under speak-every-turn + opinion-not-narration on a
  still screen, and the reliable next step if it still grates live is
  mechanical, stripDashes-style (drop a reappraisal opener when the previous
  line used one).
- **The contract carries NO example dialogue (260806, user direction).** The
  260803 BAD/GOOD pairs fixed the shapes they named (narration 0/10 -> 10/10
  asking) but Haiku imitated the GOOD lines' register across whole sessions —
  the same stock quips ("is this a bit", "unhinged") every session. Modeled
  dialogue teaches a voice while teaching a shape, and the voice belongs to
  the persona. Bans now NAME THE SENTENCE SHAPE in prose ("you went from X to
  Y", the report-opener quotes) — a test pins that no `BAD:`/`GOOD:` blocks
  return. If narration measurably comes back, name the offending shape more
  precisely; do not restore example lines.
  `start` fires ONCE per session, `START_LOOK_MS` (1.8 s) after the share opens,
  because showing someone your screen is an opening move and the session used to
  answer it with silence (nothing has jolted yet, and the idle floor is 12 s).
  Not zero: at 10 Hz the frame ring has no history to composite yet, and the
  picker is still dismissing over the thing being shared. It sits BELOW `user`
  so a player who speaks during the opening look is answered, not talked over.
- **The small VLM salience gate is GONE (260801).** It was replaced by the idle
  schedule, not repaired. Measured end to end, the narration-novelty scheme
  meant to fix it carried almost no signal (0.037 of real temporal separation
  against 0.25 of pure resampling noise) and the gate itself said yes to
  everything. `salienceGate.ts` is parked in-tree, unreferenced.
- **Log-spaced frames (260801).** A uniform 10 Hz JPEG ring, and the grid takes
  the nearest sample to each of `GRID_OFFSETS_S = [6, 3, 1.5, .75, .375, .1875]`
  seconds ago. The old rule (one frame per second, chosen by loudest audio) is
  what caused "no sense of sequence": consecutive cells landed anywhere from
  40 ms to 1.9 s apart while the prompt claimed a second. The clip's own HUD
  proved the fix: one grid's ammo counter reads 5/1/6/6/5/4, resolving a
  reload-and-re-engage that 1 Hz sampling renders as a single frame.
- **The image grid is IG-VLM (arXiv 2403.18406), reproduced exactly.** Up to SIX
  frames in ONE image, 3 rows x 2 columns, filled row-first. N=6 beat
  4/9/12/16/20 in the paper and near-square grids beat wide ones. The prompt
  describes layout, ordering AND the uneven spacing (`BACKSEAT_CONTRACT`);
  without that the model reads six unrelated pictures instead of six seconds.
  (Fewer than six when duplicates were dropped, see below; the layout stays
  near-square at every count and never goes three cells wide, because
  3 * 602 = 1806 px is past Haiku's 1568 px long edge.)
- **Grid size is pinned to Haiku, and there is a test for it.** Haiku 4.5 is a
  STANDARD-tier vision model: long edge <= 1568 px AND <= 1568 visual tokens, at
  `ceil(w/28) * ceil(h/28)`. The largest legal 32:27 grid is **1204x1008 (cells
  602x336) = 1548 tokens**. Oversize is a silent server-side downscale rather
  than an error, so `backseatIpc.test.ts` asserts both the cap and that we are
  not leaving budget on the table.
- **The companion remembers the last grid (260802).** From the second look on,
  the turn carries the PREVIOUS grid at half size (`PREV_GRID_*`, 396 visual
  tokens) ahead of the current one, plus how long ago it was taken. It sits
  AFTER the cache breakpoint, so it never invalidates the prefix. It exists to
  make repetition visible to the model, which became the dominant failure mode
  the moment silence was removed.
- **The share label replaced OCR (260804).** Every tick carries `shareLabel`:
  the shared window's CURRENT title, or on a whole-screen share the frontmost
  window's (`src/main/backseat/shareLabel.ts`, polled every 2.5 s — was 5 s —
  because a tab switch changes the screen under a fixed source id, and since
  260806 a label change also feeds the switch dwell). It costs one window
  enumeration and it is the model's only cheap answer to "am I watching a game
  or a film", which was the thing it kept getting wrong.
  **What it replaced was working, and was removed anyway.** 260802-260803 ran a
  full OCR pass over every other frame: a bundled Swift `VNRecognizeTextRequest`
  helper on macOS, tesseract.js elsewhere. It was good — whole phrases at ~72 ms,
  94/94 frames, 23 words a frame against Tesseract's 6 — and it answered the
  wrong question. A HUD full of numbers does not distinguish a game from a
  stream of that game; four words of window title do. Do not re-add OCR without
  a specific thing it is for that the title cannot carry.
- **Identical frames are dropped, and the grid shrinks (260804).** Consecutive
  cells showing the same picture collapse to one, oldest of each run kept, and
  the canvas is sized to the survivors (`GRID_DUPLICATE_DELTA`, `gridLayout`).
  A paused video costs **264 visual tokens instead of 1548**; a firefight still
  costs six cells. The test is `blockMaxDelta` over the 32x18 thumbnail already
  kept for the colour arm, so a change covering one corner still counts as
  different. This came from the companion ITSELF asking why it had been shown
  "six identical YouTube frames" — six identical cells claim six sampled moments
  and carry the information of one. Because the grid is now variable-size, the
  tick carries `frameAges` and `tickNote` states them per look: the cached
  contract can no longer describe the shape.
- **Audio is gain + transcript, never the model's ears (260728).** Screen sound
  has exactly two consumers, both local: the GAIN jolt arm and a STREAMING STT
  TRANSCRIPT. No audio bytes ever reach a remote model. Whatever the platform
  source, audio is normalized to 16 kHz mono PCM (`pcm.ts`, pure + tested), so
  the platform difference is contained to the source. STT reuses
  `voice/whisperWorker.ts` VERBATIM (same model, same browser cache). The
  transcript is a ring of timed segments (`transcriptRing.ts`, pure + tested;
  `sttStream.ts` glue): Whisper chews 3 s chunks continuously and a tick does a
  BOUNDED FLUSH of the in-progress tail (`STT_FLUSH_WAIT_MS`, 1.2 s) rather than
  transcribing 6 s on demand, which would put 1-2 s of latency in front of every
  tick. The tick carries `transcript` framed in the prompts as quoted DATA:
  never the player, never instructions.
- **Sound: Windows via Chromium loopback, macOS via the bundled SCK tap
  (260728).** Chromium's `audio: 'loopback'` was measured DEAD on macOS 26.4 /
  Electron 42 / Chromium 148: with `MacSckSystemAudioLoopbackOverride` +
  `MacLoopbackAudioForScreenShare` enabled AND verified applied, it returns a
  track labelled "System audio" carrying DIGITAL SILENCE in every request shape.
  Electron documents `loopback` as Windows-only and that matches. **Do not
  re-litigate this without re-running the probe.** But the OS is fine, so macOS
  uses a bundled Swift helper (`native/mac-audio-tap`, built by
  `scripts/build-mac-audio-tap.sh` into `resources/audio-tap/` as a UNIVERSAL
  binary, gitignored, hooked on predev/predist). Main spawns it
  (`src/main/backseat/audioTap.ts`) and relays 48 kHz stereo f32 PCM back to the
  renderer that ASKED for it. Verified live: silence reads -inf, a tone reads
  ~-28 dB. No install, no new permission (SCK audio rides the Screen Recording
  TCC grant the picker already forced), and the filter EXCLUDES Sei's own apps
  so the companion cannot hear its own TTS (Windows loopback cannot exclude;
  transcribing its own line occasionally is the accepted cost there). The helper
  exits on stdin EOF (orphan guard). Clips keep audio on macOS by regenerating a
  real track from the tap PCM via MediaStreamTrackGenerator. Source order:
  Windows loopback → mac tap → virtual output device (`findLoopbackDevice`) →
  video-only, where the gain arm never fires and the colour arm still does.
- **The jolt thresholds are RELATIVE, and per-arm (260802).** The colour arm is
  a block-max over a 4x3 split of the thumbnail (a whole-frame mean erases any
  localised change at any threshold), read at TWO lookbacks (1.0 s and 2.5 s,
  max taken), against a bar of `median + JOLT_COLOR_MAD * MAD` with a floor.
  No absolute number can work: on the test clip the block-max delta's own
  median is 0.313, so a fixed 0.34 fires continuously in a shooter and never in
  a calm game. Gain and colour hold SEPARATE refractory clocks, because the
  moment colour got sensitive it started swallowing confirmed gain events, and
  since 260803 separate PERIODS too: gain keeps `JOLT_REFRACTORY_MS` (20 s) and
  colour uses `signals.COLOR_REFRACTORY_MS` (**6 s**). A run of scene changes is
  a run of different subjects; a run of loudness spikes is one scene. Measured
  on a Reels recording with six verified swipes, every gap under 20 s: the
  shared period meant the refractory clock, not the picture, chose which were
  noticed. The 6 s floor is set by `COLOR_LOOKBACKS_MS`, since a change stays
  inside the 2.5 s window for 2.5 s after it ends and a shorter period
  double-counts it (measured: 5 s re-fired, 3 s re-fired).
  `JOLT_COLOR_MAD` is the one-line sensitivity dial. Kernels live in
  `signals.ts` as pure functions over explicit state, which is what lets the
  offline sim run the SAME code rather than a re-implementation.
- **TWO buffers, not one (260728).** The frame ring needs one grid plus latency
  slack, so `BUFFER_MS` is **9 s**. The 15 s belongs solely to clip capture
  (`CLIP_MS`, MediaRecorder). Clipping is the most expensive thing in the
  pipeline (two recorders encoding 720p60 all session for a rare `save_clip`),
  so it sits behind `CLIPS_ENABLED` and vanishes when off. First dial to turn if
  capture costs too much.
- **THE COMPANION ALWAYS SPEAKS, and the reason is three failed attempts
  (260802).** The contract has been through three positions on silence. 260728
  sanctioned it as "the normal outcome" and produced a mute companion (five
  ticks, five silent turns). 260801 delegated the decision to the per-tick note
  and measured 68%. Reviewing that run, the silences were not taste, they were
  error. So the option is GONE: every look produces a line, and silence is a
  MECHANICAL decision made before the model is called (`MIN_SPEAK_GAP_MS`), a
  rule that cannot misjudge a moment because it never looks at one.
  `isSilenceFiller` still parses, because a stray `(silence)` must never be
  spoken aloud, but it now logs as an anomaly.
- **Lines must not NARRATE (260803).** Speaking every time exposed what the
  lines actually were: "you just got caught", "you just used a skill", "health
  is dropping". All true, all describing a screen the player is looking at.
  `THE POINT OF A LINE` and `SAY SOMETHING THEY CAN ANSWER` fix it by spending
  the line on what the player does NOT have (an opinion, a question, a want),
  and they carry BAD/GOOD contrast pairs, which moved the needle where abstract
  instruction did not: 0/10 lines asked anything before, 10/10 after, and the
  median dropped from ~35 words to 20.
- **Em dashes are STRIPPED, not asked away (260803).** "Do not use em dashes"
  sat in the contract for a day and Haiku wrote one in eight of ten lines.
  `stripDashes` in `backseatPrompts.ts` fixes it after the fact, replacing with
  a full stop or comma. It matters here more than in chat because these lines
  are SPOKEN, and a dash is not a sound.
- **remember() turns can leak the scratchpad, and the gate is mechanical
  (260807).** Chat-family surfaces have no say() split: the text output IS the
  spoken line, and that contract breaks specifically on turns that CALL
  remember() — filing a memory puts Haiku in working mode and the text block
  slips into note register. Live (Marv, backseat): the tool input was correct
  and honored, and the SPOKEN line was "character note: sei's curious..." /
  "remember sei's into watching...". `isNoteLeak` (`src/main/chat/noteLeak.ts`,
  pure + tested, pinned on both leaked lines verbatim) drops such parts at all
  spoken choke points: backseat's part filter, persistReplies' voice path
  (callers pass `rememberCalled`), and the streaming bubble emitter (first
  tier only — a streamed sentence can precede the turn's tool_use blocks, so
  the remember-aware tier cannot arm there). Two tiers, asymmetric: "character
  note:"/"note to self" openers drop always; "remember <third person>..."
  drops only when a remember tool_use rode the same turn, and never when the
  next word addresses the player ("remember when we...", "remember, you...").
  The REMEMBER_TOOL description also now says the memory goes in the tool
  input ONLY — prose the model will still sometimes ignore, which is why the
  gate exists.
- **Attaching TOOLS suppresses speech.** Measured, n=60 per condition: 100% of
  turns produce a line with no tools, 78% with `REMEMBER_TOOL` alone, 68% with
  the pair backseat ships. A tool description that reads as a general judgement
  about how interesting moments usually are leaks from "do not use the tool" to
  "do not speak", and asking the model not to do that does not help. **Suspect
  this first whenever any surface goes quiet.**
- **Clips.** `save_clip` writes the last 15 s to
  `<profileRoot>/clips/<characterId>/` and attaches it to the chat line that
  asked for it (`ChatMessage.clip`, rendered by `ClipCard`). A WebM segment is
  only decodable from its own header, so the tail of a chunk list is not a clip:
  two recorders staggered by half a period mean the longest-running one always
  yields a complete file containing the requested window. The honest cost is
  that a saved clip runs 15-30 s rather than exactly 15.
- **Cache layout is the cost model, not hygiene.** Every tick carries a fresh
  1548-token image at a 12-60 s cadence. The fourth breakpoint therefore sits on
  the last HISTORY message, not on the image message (which is unique forever
  and can never be read back), and the history window is ANCHORED rather than
  slid, so appending a line does not change `message[0]` and invalidate the
  whole prefix. Same trick as the Minecraft brain's `cachedSystemBlocks`
  identity: a breakpoint is worth exactly whether the bytes above it are
  byte-identical next time.
- **The player's typed line is real conversation (260728).** `handleTick`
  persists a user tick's text to the shared chat thread, and `runTurn` drops
  that just-appended tail from history because the canonical copy goes inline
  with the grid attached. **On a call that row carries `voice: true`** like
  every other call line: it is spoken, so a chat row would be a caption. This
  was missed when user turns started routing through backseat and the player's
  own half of the call filled the transcript.
- **TWO entry points (260803).** The share pill in `CallControls` (needs a call
  already) and the **Backseat button in `ChatTopBar`** (does not). The second
  exists because the first is unreachable without already knowing the feature
  is there. From the header, confirming a source arms a **pending share** in
  `useBackseatStore` and routes to the call; `CallMiniBar` starts the capture
  when the call reaches `live`. It cannot be inline: the ~40 MB voice module's
  install gate can hold the dial for minutes or refuse it. The arm carries a
  180 s deadline, is re-checked against the wall clock before firing (timers
  lag across sleep), and is dropped on `status === 'error'`. A one-time
  localStorage tip (`lib/backseatTipPref`) hangs under the CHAT HEADER's
  Backseat button, tail pointing up at it. Not the call controls: those only
  exist once you are on a call, and a notice about a feature is worth nothing to
  someone already that far in. **"Got it" is the only thing that retires it.**
  Sharing used to as well, on the reasoning that someone who found the feature
  does not need telling; live, that silenced exactly the people the beta notice
  was for, since anyone who used backseat in an earlier build wrote the flag on
  their first share. **The key carries both a version and the PROFILE SCOPE**
  (`user.id`, or `local`): localStorage is one bucket for the whole app and is
  NOT moved when the scope changes, so without the scope a second account on the
  same machine inherits the first's dismissal. Bumping the version re-announces
  to everyone without anyone clearing storage by hand.
- **UI (260803, 260804).** Entry is the share pill in `CallControls`; the picker
  is `ShareScreenModal` (a `ModalShell`, **Window / Entire screen as two tabs**
  since 260804 — stacked sections put the screens below the fold behind however
  many windows the player had open); the live view is the preview plus a demoted
  avatar strip inside `VoiceCallScreen`. There is no overlay window, no games
  tile, no text mode (there is nowhere to type) and no pause button (the share
  toggle is it). `useBackseatStore.active` still feeds the IconRail activity
  badge and the cross-launch gate.
- **THERE IS ONE CONVERSATION, NOT TWO (260804).** While a companion is sharing,
  `dispatchUserTurn` routes the player's utterance to `capture.sendUserTick`
  and SKIPS that companion's ordinary voice turn; anyone else on the call still
  takes one. Without this there were literally two turn loops running against
  the same chat thread and the same call: backseat's, which had the grid and no
  microphone, and the director's, which had the microphone and no grid. The
  player got a companion who could see their screen and never heard them,
  talking over one who could hear them and could not see. Nothing was broken in
  either loop — there were two of them and neither knew. **Anything that gives a
  companion a turn has to check `useBackseatStore.sharingFor` first.** The share
  is the more informed loop, so it is always the one that wins.
- **Barge-in is decided by a WORD, not by loudness (260804).** Two stages, with
  deliberately opposite temperaments. Stage one DUCKS the companion to SILENCE
  (260806, was 8%: at 8% every real interrupt carried on "really quietly" for
  the whole confirmation window; a wrong duck now resumes through the 60 ms
  ramp as a brief dropout, the accepted cost) on one
  frame over a low bar (~130 ms, against ~400 ms before, and with no 600 ms
  grace-window blind spot at the start of every clip); it is reversible, which
  is the entire reason the bar can be that low. Stage two transcribes the
  ~400 ms collected since the duck and COMMITS only if `hasSpokenWord` says a
  real word came back, otherwise it un-ducks and the clip carries on. Six rounds
  of threshold tuning across three separate "cannot interrupt her" / "she cuts
  herself off" reports never resolved that conflict, because it is structural:
  energy cannot tell a cough from a word, and a cleared queue cannot be undone.
  Sustained energy survives only as a slow fallback (`BARGE_CONFIRM_MS`, now
  1400 ms) for when transcription cannot answer at all. `hasSpokenWord` is
  stricter than the finished-utterance junk filter — it runs on 400 ms of audio
  where every engine invents — and it is **scoped to Latin script for the
  repeated-letter rule**, because 等等 is a word and rejecting it would make
  barge-in silently impossible in Chinese.
  A confirmed barge also calls `backseatInterrupt`: clearing the queue only
  silences what is already synthesised, and the turn behind it would otherwise
  land its line a second later.
- **The echo gate: speakers into the mic (260807).** On speakers at max volume
  the mic hears THREE voices, and two of them used to become "the player".
  Measured across two live Instagram sessions: reel dialogue was transcribed
  and dispatched as the player's own words ("Get ready with us, but Stas is
  picking my outfit..." persisted as a user voice line — the companion's "is
  this you on camera?" confusion was correct reasoning over counterfeit
  input), and her own TTS leaking past AEC kept confirming word-gated
  barge-ins against her. Chromium's AEC (the same self-referenced AEC3
  Discord runs) covers only Electron's own output, degrades on clipped
  max-volume echo, and has NO reference for another app's sound; the call
  apps' answer is headphones. Sei's is `voice/echoGate.ts` (pure + tested):
  before a transcript is dispatched as the player or commits a barge,
  `micEchoCheck` (useVoiceStore) tests it against (1) the companion's own
  audible lines — text only, the queue's onAudible/stop callbacks record
  exact windows — and (2) the shared screen's audio via the capture handle's
  `echoProbe`: the tap's loudness contour cross-correlated over the
  speaker-path lag plus the screen transcript ring's words. The thresholds
  are calibrated, not guessed: max-over-lags Pearson on independent
  talk-cadence envelopes reads spurious ~0.66-0.93 under 2 s, so correlation
  is `valid` only past 2.5 s and only CORR_STRONG (0.85) may condemn without
  matching words (music has no transcript). Everything shorter or softer goes
  'ambiguous' and waits ONE bounded screen-STT flush for the words to decide
  — so double-talk (the player speaking OVER the reel) stays the player's,
  costing ~1 s of latency on exactly those utterances and nothing on the
  rest. The asymmetry is deliberate everywhere: text condemns, the envelope
  alone almost never does, and a barge echo-abort only delays a real
  interrupt to utterance end while a wrong commit destroys her line. The
  contract's identity rule ("a person on screen is never the player", pinned)
  is the prompt-side backstop, not the fix.
- **Session log rides the bot log pipeline (260728).** `backseatLog.ts` mirrors
  chessLog: every diagnostic goes through `slog()` to BOTH the terminal and a
  per-session logRouter (`backseat-<characterId>-<ts>.log` + batched IPC into
  the in-app LogsBar). A `console.log` that skips `slog` is invisible in-app.
  Renderer-side capture diagnostics are now plain console lines in the main
  window, reachable in devtools.
- **Dev grid dumps.** Unpackaged runs overwrite
  `<userData>/backseat-debug/grid-<kind>-latest.jpg` on every tick (the dir is
  logged at session start), so what the model is actually shown can be checked
  by eye.
- **Verify offline, never by launching Electron.** `npx tsx
  scripts/backseat-sim.ts [--dry]` runs the real clip through the real
  `signals.ts`, the real offsets and the real prompts and writes a voice-over;
  `scripts/backseat-render.ts` turns that run into a review video with the grid,
  the share label, and both signal plots beside the footage. The sim CANNOT
  check prompt caching: its stub prefix is ~1.1k tokens and Haiku will not cache
  below 2048, so cache hits have to be read off a live session's log. **Caching
  is confirmed live (260803 session): `cacheRead=9017` steady from the second
  tick, `cacheWrite` near zero.**
- **Anything the service reads off a tick MUST be in the zod schema in
  `main/ipc.ts`.** Zod strips undeclared keys, so a field the renderer sends and
  the schema does not name arrives as `undefined` with no error anywhere.
  `gridSmall` was in exactly that state from 260802 to 260804: the previous-grid
  memory shipped, was documented, and never once reached the model, and it was
  invisible because a null `prevGrid` is a legal state on the first tick of
  every session.
- **Continuity + analytics** follow the contracts below: `REMEMBER_TOOL` honored
  inline (single-shot turns, no tool loop), one `event: {kind:'play'}` row at
  `endBackseat` plus `foldIfDue`, and `backseat_started` / `backseat_ended` with
  `duration_ms`. Per-tick commentary is deliberately NOT persisted beyond the
  normal chat messages the companion actually said.
- **Tool-array policy:** ONE array for every tick kind (chess-style). Ticks are
  6-8 s apart, well inside the cache TTL, so per-tick-kind arrays would
  invalidate the prefix almost every turn for nothing.

**Extracted:** the screen-watching half is mirrored as a public standalone repo
at `sei-studio/backseat` (AGPL-3.0) with a plain-language architecture README.
Changes here should be mirrored there when the design moves.

**Owed:** (1) only two clips have ever been measured against, one of them an
EDITED MONTAGE whose colour jolts are partly its edit cuts. The colour arm's
6 s period and 0.15 floor are justified by argument plus those two, not by a
corpus. (2) On the Reels recording the two swipes at 00:50 and 00:53 are NOT
separable by amplitude from the video's own motion in the same stretch (peaks
0.187 / 0.179 against 0.176 / 0.177); the lower floor catches them but is
buying sensitivity, not discrimination. (3) the mac audio tap is a bundled binary
that has never been through a signed mac `dist` — verify it with `codesign` on
the first one. (4) `salienceGate.ts` and its `SEI_GATE_*` env knobs are parked
unreferenced rather than deleted; either revive them or remove them.

## Minecraft setup wizard: the target version (260916)

> Superseded in part by the games branch (260916, same day): the wizard now builds
> ONE "Sei <version>" profile PER version with a picker in the setup list, and
> readiness is per profile (`sei_ready_versions`). The version rule below
> (newest supported, never last-played) still holds; see "Minecraft's setup
> step, and the detection bug" in the Game adapters section for the current shape.

The skin-setup wizard builds a "Sei" Fabric profile in the vanilla launcher,
and **the version it builds it for is the newest one in minecraft-protocol's
`supportedVersions`**, never the launcher's last-played version
(`selectTargetMcVersion` in `src/shared/mcSetup.ts`, the only place the rule
lives; `src/shared/minecraft-protocol-version.d.ts` types the CJS table for
main and renderer alike). It used to take the last-played version with a
pinned 1.21.4 fallback only when that was unreadable, so once Minecraft 26.2
shipped (June 2026) any machine that had played it got a Sei profile the bot
could not join, and the version-not-supported popup pointed the player at the
profile Sei had just made for them. Measured on the 260914 support case (a
new user who spent 30 minutes on it and gave up), and on 6 of the 13 users
who tried a summon that week. CurseForge instances keep their own version:
they carry their own loader and cannot be moved. The scanner now reports
every Fabric profile's version (`McInstall.fabric_mc_versions`) so readiness
means Fabric for a JOINABLE version plus the skin mod, not "Fabric exists".
When the protocol bump lands, the wizard follows it with no change here.

Two more things from the same case, since they are why he never got in:

- **The Anthropic key is required only when Anthropic is the provider.** The
  bot's `ConfigSchema` used to refine the `anthropic` sub-object alone
  ("api_key required unless cloudMode"), which cannot see `llm.provider`, so
  the one keyless provider (Ollama) shipped an empty key and died on config
  validation before pinging the world, on every summon and every Minecraft
  version. Every other provider passed by accident (its vendor key was copied
  into `anthropic.api_key`). Now a top-level `superRefine`, pinned in
  `src/bot/llmInit.test.js` with the production shape (empty key). If a
  provider ever goes quiet at fork time, check this first.
- **"I've been here before" + a login with no account resumes the scene.**
  Google sign-in creates the account on the spot, so the returning branch used
  to complete a brand-new player as returning: no config written, no name, no
  companion, and the first summon refused with "your name is missing".
  260917: the route is decided by whether the profile HAS A NAME
  (`accountHasProfile` reads `preferred_name` off `sei.getConfig()`; main
  backfills it from the cloud profile before the scope flips, and only the
  app's own setup ever writes that column), so a veteran on a second machine
  reads as onboarded and a minutes-old Google sign-in does not. The two age
  heuristics (`signedIntoFreshAccount` under 10 minutes, `signedIntoExistingAccount`
  over 48 h) survive only as the fallback when that read fails. A returning
  login with no profile sends the scene
  to the `no-account` phase: Sui walks back in, says so, and re-asks the
  new-here question. The boot sign-in variant has no scene to resume and
  replays the full one. A password sign-in cannot tell "no account" from
  "wrong password" (same server error), so that panel names the way out.

## Game adapters: Stardew Valley + Don't Starve Together (260908)

The companion can be launched into the player's own Stardew Valley farm or
hosted Don't Starve Together world the way it is launched into a Minecraft
LAN world. Design and research: `.planning/game-adapters-260908.md` (+
`.planning/research/game-adapters-*-260908.md`, `dst-survivors-260908.md`).
Both tiles are `available: true` in `src/shared/games.ts` (flipped 260908 so
the user can run the live checklist from the app itself); the live checklist
(plan section 5, M3, per game) is still owed, and neither game self-launches
(`selfLaunch` off: each needs a player-run install pass first). Settings
hosts every game under ONE "Games" group (`GamesSettingsGroup`: left column
picks the game, right column shows that game's registered section).

- **Neither game has a mineflayer.** DST has no headless client and Steam
  allows one instance per account; a Stardew split-screen farmhand is
  gamepad-only. So in both games the companion is a BODY spawned by a
  Sei-owned mod inside the host's own game, visible to everyone in the world,
  and driven by the existing Node brain over localhost. The brain is not
  forked: `src/bot/brain/*` is one implementation and each game supplies an
  adapter (contract v2 in `src/bot/brain/types.js`).
- **Discovery in main, protocol in the bot**, like Minecraft (`lanWatcher`
  vs `adapter/minecraft/connect.js`). `src/main/games/<game>/watcher.ts`
  answers "is a world open"; `src/bot/adapter/<game>/runtime.js` speaks the
  game protocol. No game protocol code in main.
- **Reflexes live in the mod, decisions in the brain.** Retaliation,
  fleeing below a health floor, eating, darkness, end-of-day sleep run in the
  game process at frame rate (the Minecraft `behaviors/*` loops are the
  precedent) and report through the same `sei:attacked` / `sei:survival`
  event vocabulary. The LLM issues closed Zod-typed verbs; composite verbs
  (`gather(kind, count)`) loop mod-side so one call does a job.

**M0, the shared seams (all three games plug into these):**

- Bot: the composer `src/bot/index.js` is game-agnostic and dynamic-imports
  `src/bot/adapter/<kind>/runtime.js` (`botUsernameFor`, `adapterConfigFrom`,
  `checkJoinTarget`, `createRuntime(config, hooks) -> RuntimeHandle`), so
  mineflayer never loads for a non-Minecraft session. `adapter.kind` is
  `z.enum(GAME_KINDS)` with a real sub-schema per game in `src/bot/config.js`.
  Adapter contract v2 (`ADAPTER_INTERFACE_VERSION = 2`): every Minecraft name
  that had leaked into the brain is now an optional adapter member with a
  Minecraft default in `src/bot/brain/adapterDefaults.js` (`gameName`,
  `chatMaxChars`, `backgroundActions`, `progressActions`, `visionActions`,
  `prefilterToolBatch`/`postProcessToolBatch`, `surfaceBaseline`,
  `sessionEndClause`, `stuckNudges`, `eventAddendum` as the ONLY source of
  idle/attacked/survival/death prose, `getWorldIdentity`, `createTelemetry`,
  `classifyConnectError`), plus the optional `onIdleNudge` handler (a P3 idle
  tick with a named reason, ignored before the first spawn).
  `src/bot/brain/systemBlocks.minecraft.test.js` pins the Minecraft cached
  system prefix and tool list BYTE-FOR-BYTE against a fixture generated on the
  pre-refactor tree; touch the brain and that test tells you whether the model
  sees anything different.
- Main: `src/main/games/index.ts` `GameModule` registry (`effectiveUsername`,
  `collides`, `watcher`, `getJoinTarget`, `joinTargetMissingError`,
  `install`), registered from `src/main/index.ts`. `botSupervisor.summon(id,
  game)`; every `BotStatus` carries `game`; the play row, `bot_session_ended
  {game}` and `foldIfDue` (which Minecraft had been missing) key on the
  module. `src/shared/gameIpc.ts`: `GameId`, the `WorldState` and
  `GameDashboardSnapshot` unions, `world:*` and `gamedash:*` channels
  (`lan:*` / `mcdash:*` stay as Minecraft aliases). The chat-surface `launch`
  tool takes a `game` validated against catalog rows with `selfLaunch &&
  available`.
- Renderer: `registerGameSurface`, `registerSummonFlow`, `BOT_ERROR_ROUTES`
  by `(game, errorClass)`, `registerGameSettingsSection`,
  `registerGameSetupModal`; each game's `register*.ts` is imported once from
  `App.tsx`. `useMcDashboardStore.launch[id]` is the game whose launch panel
  is open. The controls window + status strip are shared
  (`mcdash/McDashControls.tsx`, `games/GameControlsWindow.tsx`), not copied.

**Game packs (260908, the user's decision 1).** Adapter runtimes are
DOWNLOADED on first use, Minecraft included: its deps (`minecraft-data`
429 MB, `prismarine-viewer` 392 MB, `gl` 218 MB on disk) live in the npm
workspace `packs/minecraft` which the root package does NOT depend on, so
electron-builder's npm collector (`npm list --omit dev` from the root) leaves
them out of the installer: measured 1.1 GB -> 706 MB app, 48 MB zip. Root
`npm ci` still hoists them, so dev and vitest are unchanged.
`scripts/build-game-pack.mjs <game> --platform --arch` builds
`sei-pack-<game>-<version>-<platform>-<arch>.zip` (Minecraft per platform
with natives rebuilt against Electron's ABI and the same texture prunes as
`electron-builder.yml`; Stardew and DST as `any-any` asset packs carrying
the game-side mod under `assets/`); `pack.json` carries a `treeHash` over
sorted paths + contents so a re-download is skipped when the content did not
change. The release workflow builds every pack beside the app and the release
job writes ONE `game-packs-<version>.json` manifest (sha256 per zip);
`mirror-release.yml` mirrors it all to `dl.sei.gg/updates/`. Client:
`src/shared/gamePacks.ts` (descriptors, asset names, mirror-first URLs),
`src/main/games/packs.ts` (`getPackState`, `ensurePack`: manifest, download
with progress, sha256 verify, jszip extract with traversal rejection,
`installed.json`, older versions pruned, single-flight; dev short-circuits
to the repo root, `SEI_GAME_PACKS_DIR` exercises the real path in dev),
`game:pack-*` IPC, `useGamePackStore` + `GamePackCard` in every launch
panel. **A treeHash match is not proof of a usable pack (260924).**
v0.6.5-beta.1 shipped a 745-byte DST pack: the builder hashed the staged
mod under `assets/` but zipped only `pack.json node_modules`, and the
client's extractor required `node_modules/`, which failed every Stardew
install (no node_modules in an asset pack) with ENOENT. Now the builder
zips every staged entry and re-reads each zip
(`scripts/lib/gamePackVerify.mjs`: treeHash re-derived from the zip bytes,
file count, the game's required payload), CI builds the two any-any packs
for real on every push, and the client checks `GAME_PACKS[game].requiredPaths`
(+ pack.json `files` on re-link and extract), so a payload-less install
reads as missing and is downloaded again even when its treeHash matches. The supervisor awaits `ensurePack(game)` BEFORE `startedAtMs` so a
multi-minute download never eats the 30 s summon deadline, and ships
`packRoot` in the init payload; `src/bot/packLoader.js` registers a
`module.register()` resolve hook (normal resolution first, pack second) plus
NODE_PATH for the CJS `createRequire` path BEFORE the composer imports the
runtime. **The composer's runtime import must stay dynamic**: a static
import is hoisted past the hook. Two traps: the root `overrides` entry for
`gl` must be the literal tarball spec (an override cannot reference a
workspace dep), and a fresh worktree needs `npm install --ignore-scripts` to
link `node_modules/@sei/*` before the pack builder's `npm list` sees the
workspaces.

**Stardew Valley (M1)** `native/stardew-mod/SeiCompanion/` (C#, net6.0,
SMAPI >= 4.5, MIT; `PROTOCOL.md` beside it, mirrored in
`src/shared/stardewIpc.ts`). Body = a vanilla `NPC` (the visible sprite,
default placeholder art generated by `scripts/gen-stardew-placeholder-art.mjs`)
paired with an invisible `BotFarmer : Farmer` shadow (Farmtronics pattern)
that performs tool use, combat and placement through the game's own APIs;
the shadow is NEVER added to `Game1.otherFarmers`. Decompile facts that
shaped it, cited in code: `MeleeWeapon.DoDamage` returns early for a
non-local farmer (combat goes through `location.damageMonster`),
`Farmer.Money` throws for anyone but `Game1.player` (own wallet in
`modData`), `Crop.harvest` hands items to `Game1.player` (re-implemented),
`WarpPathfindingCache` ignores the Farm (own BFS over warps + doors),
monsters target only `location.farmers` (contact damage is simulated by the
reflex loop). Transport: `HttpListener` on `http://localhost:<port>/`,
`GET /hello` unauthenticated for the watcher, `/ws?token=` NDJSON for the
bot (every client dials `localhost`, not `127.0.0.1`, for Windows
`HttpListener`). 20 verbs in `src/bot/adapter/stardew/registry.js`. Install
(`src/main/games/stardew/install.ts`) ports SMAPI's GameScanner logic,
downloads the SMAPI installer (mirror first), runs it `--install --no-prompt`,
copies the mod from `<packRoot>/assets/stardew-mod/SeiCompanion`. The setup
only runs while something is missing, so `launchStardew` calls
`upgradeModIfNewer` before it starts the game (260925): when the pack's
`manifest.json` Version is newer than the installed one it re-places the mod,
keeping `config.json` (token + port). A game started through Steam instead
keeps its old mod until the next launch from Sei. **Bump the manifest Version
with every mod change** or installed copies never update. **The mod
compiles only against the game's assemblies** (verified clean against
1.6.15 + SMAPI 4.5.2 on this machine), so `assets/stardew-mod/` is a TRACKED
build output the release packs with `--skip-build`; rebuild and commit it
with any C# change. Verified live 260910 (see the Stardew live-test
paragraph below): the SMAPI installer driven from Node on macOS, the NPC
walking (with the barrier hop), fishing, tool swings, cross-map travel and
the shop. Still unverified: combat in the mines (spring 5+), a farmhand.

**Discovery has no setting (260909).** Main binds the first free port of
`DST_DISCOVERY_PORTS` (27424..27428, `src/shared/dstIpc.ts`) and the mod
probes the same list every beat until one answers `app: "sei"`, then sticks
to it (three misses = probe again). The M2 build had one fixed port with a
Settings row and a mod option that had to agree, which is a setup step a
player cannot be asked for; `UserConfig.dst_port` survives as a dead field so
old configs parse. The other two player steps the game itself forces are
written into `DstSteps` (shown after the tile AND in the setup modal): the
helper must be in the game BEFORE it starts (mods are indexed once, at game
start, so `install.ts` reports `needsRestart` when the running game predates
the helper files, from `ps`/CIM start times; a live heartbeat clears it), and
a world must be hosted.

**macOS: the DST helper installs with one in-app click (260925, measured).**
The game's mods folder is `dontstarve_steam.app/Contents/mods/`, inside the
app bundle, and it holds both `mods/sei/` and `modsettings.lua`. Since macOS
13 writing into another app's bundle is gated: without a grant every write
there from Sei is EPERM (the folder itself is owner-writable; the refusal is
TCC). The binary hard-codes `../mods/` relative to its executable, so there is
no other folder (research: `~/suisei/research/dst-mod-install-no-appmgmt-2026-09-25.md`).
What works, measured on a signed v0.6.5-beta.2 with App Management OFF
(`~/suisei/reports/dst-grant-test-260925/`):
- **The Open panel grants the folder.** `dialog.showOpenDialog(win,
  {defaultPath: modsDir, properties: ['openDirectory','treatPackageAsDirectory',
  'createDirectory'], buttonLabel: 'Install helper', message})`; once the
  player clicks the button with `mods` selected (it opens there, so one click),
  macOS writes a `com.apple.macl` grant and Sei can mkdir, copy, delete,
  rewrite `modsettings.lua` and write-temp-then-rename inside `mods`.
  Choosing `dontstarve_steam.app` itself grants the whole bundle. Writes
  outside the chosen folder stay EPERM. The grant survived a full quit and
  relaunch of Sei; across a REBOOT or a DST UPDATE it is untested, which is
  why the write is always tried first and the panel shown only on EPERM.
- **Finder is exempt.** `tell application "Finder" to duplicate ... with
  replacing`, sent through `/usr/bin/osascript` from Sei, shows one "Sei wants
  access to control Finder" prompt and then works. A replaced file comes back
  0644 with a fresh mtime. No automation entitlement: the event is sent by
  osascript, and the test build had none. `NSAppleEventsUsageDescription` in
  `mac.extendInfo` is only the prompt's explanation line.
The flow (`installMod` + `grantAndInstall` + `finderInstall` in `install.ts`,
the Electron half in `macGrant.ts`): a CLICK ("Add Sei's helper", "Try
again", "Update helper", "Turn the helper back on"; `dst:install` passes a
`MacGrant`) tries the plain install; on a darwin EPERM it shows the Open panel
as a sheet on the Sei window, accepts only a realpath equal to `modsDir` or the
`.app` (case-insensitive), re-shows it once with a hint for any other folder,
and retries. Cancel means no: the one line plus "Try again", no Finder. A
second wrong folder, a retry that still EPERMs, or a panel that threw goes
to Finder: the mod and the new `modsettings.lua` are staged in a temp dir and
duplicated in with replacing (a replaced folder is replaced whole, so an
upgrade drops stale scripts), source file modes are put back where macOS
allows (best effort), everything is read back, and the staging is removed.
Only when both fail does `DstSteps` show the one App Management line plus
"Try again". **Nothing without a click ever shows a dialog.** A game launch
(`install.launch`) and the setup poll's re-enable run with no grant: a
refused write counts as success when the helper is already current and
enabled (the every-launch recopy is a refresh), otherwise the launch goes
ahead with whatever helper is there and the module sets `grantNeeded` on the
found state, so the helper step comes back with the button (cleared again
when a later detection sees the helper current and enabled) (a disabled
`modsettings.lua` shows as "Turn the helper back on" straight from detection).
The error still PERSISTS as before: `useDstStore` skips the poll while an
install is in flight and `mergeDetected` keeps an error until the helper is in
the game. `dst:open-app-management` still exists, unused. Windows and Linux
never take the grant path (their mods folder sits beside the exe; an EPERM
there is a plain error). Unverified on a Mac as built: the whole flow end to
end in a packaged build, the Finder "replace a folder whole" semantics, and
grant persistence across a reboot or a DST update.

**First live DST session (260909), and what it broke.** The end-to-end run
(tile, helper, restart, Host Game, Launch, greeting, come, follow) works, and
five things were wrong on the way that are worth knowing before the next
adapter. (1) `composeSeedBlocks` sent an EMPTY `seed_cuboid_grammar` text
block for any adapter without a cuboid grammar (DST, Stardew); Anthropic
answers an empty text block with 400 and the cloud proxy surfaced it as a
502, so the body spawned and every brain call failed. The block is now
omitted and the cache breakpoint moves to `seed_player`. Suspect this shape
first when a new surface's calls all fail while the same prompt works for
Minecraft. (2) Goals were per character, not per game: the first DST turn
read "reach stone pickaxe tier" out of `HEARTBEAT.md` and was told to pursue
it. Non-Minecraft games now use `HEARTBEAT.<game>.md` (`src/bot/index.js`);
Minecraft keeps the bare name so existing goals survive. (3) `come`/`follow`
resolved the player only inside the 24-unit perception sweep, and "come here"
is asked exactly when the body has wandered out of it (measured: 75 units,
"no player nearby"). Both now fall back to the pinned player's USERID
(`goto`/`follow` with `userid` in the mod, resolved against `AllPlayers`;
`""` means nearest). (4) The mod's heartbeat rode `DoPeriodicTask`, which
is sim time and stops on every server autopause (the survivor lobby, the
pause menu), so Sei flapped the world open/closed; it is `DoStaticPeriodicTask`
now. (5) `DisableLocalModWarning()` does NOT suppress the "Mods Installed"
force-enable notice, which shows on EVERY launch until the player ticks
"Don't show this again"; the step copy says to press "I understand". Also
measured: the real menu path is Host Game (not Play, then Host), a saved
world resumes through the survivor lobby, and DST DROPS all input while it
is not the frontmost app (background computer-use clicks worked for the
menus only because the game had focus; keystrokes never reached it), so a
computer-use test has to `open` the app bundle first and can only talk to
the companion through the Sei chat, which the brain frames as "NOT in the
game with you" by design (the Minecraft framing; a player who IS the host
gets the same wording).

**Second live DST round (260909, later): pause, crash, second companion.**
Verified: Pause holds the body still (a creature walked past a frozen
Wickerbottom for 20 s), Resume and the Reactive/Proactive switch take,
chop / pickup / goTo / come / gather / build (with a correct
missing-ingredient result) all ran from one chat instruction, killing the
game process stopped the bot inside 10 s with GAME_WORLD_NOT_OPEN and the
"Try again" re-summoned into the resumed save, and a bot killed with SIGKILL
raised the app's Connection lost modal. Left overnight, host AFK, the body
DIED: dusk in the dark (Charlie), sanity to zero, then starvation; the
death path itself worked (death event, memory write, DST_BODY_DIED, clean
stop, play row written). ONE COMPANION PER WORLD is now enforced: the helper
runs a single body and a second character's offer replaced the first
through a link-reset race (Despawn posts "despawned" then drops the link;
with `Net.Configure` called BEFORE `Companion.Summon` both landed on the new
runtime, which quit, while the old one starved of heartbeats and quit too,
leaving a brainless survivor). `GameModule.maxBodies = 1` +
`DST_ONE_COMPANION` in the supervisor, and `DstLaunchPanel` names the
occupant instead of offering Launch. The mod also gained a DEAD-RUNTIME
WATCHDOG (`Net.DEAD_AFTER` consecutive transport failures -> `Net.onDead` ->
Despawn "runtime gone", measured 4 s after a SIGKILL) and every Despawn step
is pcall-guarded and logged, because the first watchdog despawn logged and
still left a body standing (cause under investigation with the new logging).
Computer-use notes for the next round: DST needs to be the frontmost app
(`open` the bundle; Chrome steals focus back whenever the user browses), the
first click on a DST widget only HOVERS it and the second fires (send single
clicks twice, not a double-click), background screenshots of an unfocused
DST are STALE frames, keystrokes never reach the game, offline mode cannot
resume an online-created world (create a new one), and `client_log.txt` is
rewritten per launch.

**Every launch panel is a one-step setup window in the game's register
(260909).** The three bot-backed games' pre-launch surfaces (`McLaunchPanel`,
`StardewLaunchPanel`, `DstLaunchPanel`) share one shape, centered on the
game art: title, pack card, an OPTIONAL setup window, the big button, the
help link. The window is `components/games/SetupStepper.tsx`: it shows ONE
step at a time (Step n of m, the step's copy and its one button, Back /
Next, dots), so it is never taller than its tallest step and the big button
stays in view under it. The first cut drew every step as a numbered list on
the panel (McSteps, DstSteps) and the list pushed Launch below the fold of
the game aside. The steps are DATA from a per-game hook
(`useMcSetupSteps`, `useStardewSetupSteps`, `useDstSetupSteps`), each step
carrying its live `done` flag, so the window always shows the current state
rather than instructions, and the SAME hook feeds the token-styled setup
MODAL (DstSetupBody still renders the whole list there). Two window modes:
`setup` opens on the first step that is not done, FOLLOWS progress (a step
completing moves it on) and closes itself once everything is done; `help`
opens on step 1 for reading through. The panel's big button reads "Set up"
until the ONE-TIME part is done (`complete`: Minecraft = Java found and a
Sei-ready install or "Do not show again"; Stardew = `install.ready`; DST =
the helper in the game), then "Launch"; under an open window on an
unfinished setup it is a disabled "Launch", the goal. "How do I set up
launch?" shows only once the setup is complete and reopens the same window
in help mode. The per-session steps (a world open to LAN, a farm open, a
hosted world) are the last step of each list; a Launch pressed without one
still goes through the summon flow's own setup modal. Each panel paints the
window and buttons in its game's register through `StepperSkin` +
`StepSkin` (class maps + the game's button component): the vanilla
Minecraft dialog and raised gray button in Monocraft (OFL, a face drawn
after the game's typeface; Press Start 2P only works at label sizes), the
Stardew wooden frame with the cream face in Pixelify Sans, the Don't Starve
parchment sheet in Fredericka + Metamorphous, all as documented token
exceptions in their own CSS modules. `.content` uses `justify-content: safe
center` so a stack taller than the aside scrolls instead of clipping the
title. Verify with `?dashshot=mclaunch|dstlaunch|stardewlaunch` (+`&ready=1`
for the set-up state) on the dev server.

**Minecraft's setup step, and the detection bug (260909).** Step 2 of the
Minecraft list is what changed the product: the skin wizard used to be
offered once at onboarding and once on the first Minecraft open, and a
player who clicked past it had no way back but Settings. Now the step is
offered on every open until an install is ready or the player presses "Do
not show again" (`UserConfig.mc_setup_dismissed`; a ready install shows as
done even after a dismissal). "Ready" is `shared/mcSetup.ts`
`mcInstallReadyVersion`: a `versions/fabric-loader-<loader>-<mc>` profile
for a version Sei's networking stack can join AND the companion-skin mod,
so the scanner reports every Fabric profile's version
(`McInstall.fabric_mc_versions`) and Fabric for a snapshot no longer counts.
The VERSION half is what the wizard used to get wrong: it installed Fabric
for whatever the launcher last ran (snapshots included) and fell back to a
pinned 1.21.4 only when the version was unreadable, so once 26.2 shipped any
machine that had played it got a Sei profile the bot could not join (the
260914 support case: 6 of the 13 users who tried a summon that week hit the
version popup on 26.2). **Since 260916 the launcher's last-played version is
not an input at all.** `selectTargetMcVersion` (shared/mcSetup.ts, the only
place the rule lives) takes the version the player picked in the setup
list's row picker when Sei can join it, else the newest entry of
minecraft-protocol's supported table; the hand-kept VERIFIED list is gone.
**One "Sei <version>" profile per version**, each with its own game dir at
`<.minecraft>/sei/<version>/` (the pre-260916 single profile used
`<.minecraft>/sei/` and is left alone), because Fabric loads every jar in
mods/ and the skin mod is built per version, so two versions cannot share
one folder. Link manifests are keyed `installId@version` for the same
reason. Readiness is per PROFILE: the scanner reads launcher_profiles.json
and reports `McInstall.sei_ready_versions` (Fabric profiles whose own mods
folder has the skin mod), falling back to the old whole-install rule only
when that file is unreadable. The picker rides `runWizardInstall.mcVersions`
(named in the main/ipc.ts zod or it is stripped). The bug: the
first cut of `useMcSetupStore.scan` read `detectMcInstalls()` as a bare
array while the bridge answers `{ installs }`, so every scan came back as
"no Minecraft found" on a machine with a vanilla install and a Sei profile.
The tests had stubbed the bridge with an array, which is why they passed;
the harness stub and `McSteps.test.tsx` now use the real shape.

**Stardew live test on this Mac (260910), and what it changed.** Run from
the app with computer use on the dev Electron only (the game window was
never granted, so a `DevCommands` gate in the mod's config.json unlocks
developer frames: `newFarm` starts a game through the character menu with
the intro skipped, `loadFarm` reloads a save from the title, `devSleep`
ends the day through the bed path, `devTime` sets the clock, `devState` /
`devDebris` / `devTiles` report state; the app never sets the flag). The
game's `startup_preferences` was switched to windowed for the session (its
borderless-fullscreen default put the Sei window on an unreachable Space).
Findings, all fixed on `feat/game-adapters`:
- SMAPI "installed" was `StardewModdingAPI.dll` alone; this Mac had the dll
  (unpacked to compile the mod) with the vanilla launcher and no deps.json,
  so the installer was skipped and the game started without SMAPI forever.
  `smapiInstalledIn` requires the dll + `StardewModdingAPI.deps.json` + the
  launch hook (`StardewModdingAPI.exe`; on macOS/Linux the `StardewValley`
  script replaced by SMAPI's unix-launcher.sh, which runs
  `./StardewModdingAPI`). `spawnGame` sets `SMAPI_NO_TERMINAL` so the
  launcher does not open a Terminal window. A `require('../../paths')` in
  the installer's temp-dir resolver broke inside the electron-vite bundle
  ("Cannot find module"); it is a dynamic import now. The zip is 42 MB.
- Every map exit carries the `NPCBarrier` tile property and both the NPC
  pathfinder and the NPC's step collision honor it: the companion could not
  leave the farm. `TryPath` searches as a farmer (the shadow) and drives
  the NPC controller with that path; `BarrierHop` in Tick steps a stalled
  body across (or off) an NPC-only tile. `IsWalkable` uses the same farmer
  collision (the occupancy mask counted tilled soil as an obstacle).
  `Router.Exits` adds buildings with an inside, or nothing routed home.
- `Farmer.addItemToInventoryBool` refused every drop for the shadow (25
  pieces of debris, nothing in the bag) and `Debris.collect` threw on the
  cosmetic chunks: `TakeItem` manages the bag itself and `CollectDebris`
  lifts the item out of OBJECT/RESOURCE/ARCHAEOLOGY debris.
- A felled tree only finishes falling in the map's current-location update,
  which runs for the host's map alone; with the host indoors the chop loop
  swung to its cap (80 energy a tree, no wood). `ChopAt` ticks a falling
  tree itself. This is the general shape of "the companion works on a map
  the host is not on"; anything else that needs the location update
  (debris landing, machines are fine, they run on the clock) owes the same.
- Following undid every commanded door warp (the follow tick routed the
  body back to the host inside); a commanded map change now clears the
  follow target and says so. The observation is refreshed after every verb
  so the turn after a warp reads the new map's coordinates. The owner line
  names the host farmer, not the account's pinned name. Big stumps and
  boulders are marked as needing an upgraded tool in the snapshot.
- The heartbeat's "reachable next" list was EMPTY for Stardew, so the
  companion asked the player what the move was three ways in a minute and
  never acted. `observers/progression.json` is the first fortnight of a new
  farm (patch, the chest seeds, 50 wood, forage, town, seeds at Pierre's, a
  fish, the mines on spring 5, copper), each label an invitation with a part
  for the player; predicates read the mod's new `farm` (whole-Farm counts)
  and `host` blocks plus one-way latches from verb results. Latches live in
  the adapter instance, so they reset on re-summon (owed: persist them
  beside HEARTBEAT.stardew.md). The Stardew prompt gained a new-player rule
  (one concrete step and your half of it, mechanics when relevant, controls
  on request, stakes around the day's one big thing), a following rule, the
  shipping bin, the player's crafting recipes and the first-spring calendar.
- An app-typed line that lands mid-action was framed "NOT in the game with
  you" (the Minecraft assumption) and its say() answer stayed in the game:
  the framing is game-aware now and a loop that absorbed an app line
  mirrors its lines to the app (`loop._seiChatFolded`).
- The search branch is merged: every game bot also asks its own wiki
  (contract v2 `wikiHosts`: stardewvalleywiki.com, dontstarve.wiki.gg).
Verified live with the model: greeting, a committed project from the
frontier, leaving the house, 45 pieces of debris cleared with drops, the
dashboard strip; and by hand with a test body on the socket (the fastest
loop, no model): debris, wood, forage lookup, farm to Pierre's and back with
a purchase, till, plant, water, fish, chest take/put, sleep, a day end. Not
yet verified: in-game typed chat and voice (no game window), pause/mode on
Stardew, combat, a second companion, a farmhand.

**Stardew follow + pathing (260925, mod 0.1.2, unverified in game).** From
the v0.6.5-beta.2 playtest log (`~/suisei/reports/playtest-v065b2/`):
- **Walks stalled INTO the player.** All six "stuck" results in the SMAPI log
  had the next path tile equal to the player's tile with both collision
  checks false. The game's path search (`PathFindController.findPath`, run
  as the shadow farmer) never looks at farmers, while the NPC's step
  collision refuses to walk into one, so any path across the player stalled
  on the tile before it; `goTo` to the player's own coordinates could never
  arrive. Now: `TryPath` detours with the mod's own 4-connected A*
  (`Body/GridPath.cs`, pure, tested by `native/stardew-mod/GridPathTests`,
  `dotnet run` with no game) when the game's path crosses a farmer tile,
  keeping the game's path when no detour exists; `BarrierHop` steps THROUGH
  a farmer after 1 s stalled (the doorway case); `WalkTo` treats a
  farmer-occupied target as "next to it", drops farmer tiles from its goal
  ring, re-paths (max 2) on a stall, and reports "arrived" when a stall
  leaves it beside an adjacent-ok target; `come` takes one more leg when the
  player walked on; the follow tick picks the free tile beside the player on
  the body's side and counts stalls every tick (it counted 1 tick in 6-16).
- **Follow was cleared for good by any commanded map change** (and by
  bedtime/sleep), so "follow me, we're heading outside" died the moment the
  model walked out first. Now a commanded trip to a map the player is not on
  puts following ON HOLD (`SeiBody.FollowHoldAt`, obs `followHold`, snapshot
  `follow_target: X (on hold ...)`), released when the player leaves that
  map or reaches the body, which keeps the 260910 fix (no dragging back
  through the door). Following survives the night (`Sleeping` pauses it).
  The Stardew Following/Stuck rules in `prompts.js` say so, but ONLY when
  the connected mod reports 0.1.2+ in its welcome/hello
  (`adapter/stardew/modVersion.js`, `actionRules(modVersion)`,
  `composeSnapshot({ modVersion })`); an older mod still ends follow on a
  trip, so it gets `ACTION_RULES_LEGACY` and the bare follow name. Gate any
  future prompt text that describes new mod behavior the same way: the app
  ships before the Mac-built DLL.
- Review follow-ups (same PR): a command aborts a background follow-travel
  (it used to warp the body mid-purchase); stall counters (follow tick,
  BarrierHop, WalkTo) skip ticks where `!Game1.shouldTimePass()` (a chest
  menu teleported the body); follow-side `FreeTileNear(..., reachable: true)`
  needs the tile within 2 x radius steps of the player (`GridPath.WithinSteps`,
  never across a fence corner); detours are capped at
  `GridPath.DetourBudget` (4x the game's path, 16..400 nodes); follow never
  travels or warps into a festival, an event or a temporary map (`Temp`,
  `IsTemporary` by reflection), it waits.
- The mod source is at 0.1.2 but `assets/stardew-mod/` is still the OLD
  build (its DLL even reports assembly 0.1.0): rebuild on a machine with the
  game (`scripts/build-stardew-mod.sh`) and commit the output, which also
  carries the 0.1.2 manifest. Do not bump the asset manifest by hand without
  the DLL, or installs would record 0.1.2 with old code and never update.

**Stardew chores + hand-off (260926, mod 0.1.3, unverified in game).** From
the same playtest (goal: parsnips; she had no seeds, the host had 16, a 15-tile
field was 15 till calls, and "water the crops" reached 20 tiles while the
snapshot counted the whole farm). Audit: `~/suisei/reports/stardew-capability-audit-2026-09-26.md`.
- **till a patch in one call** (every mod version): `till({x, y, width,
  height})` up to `MAX_TILL_TILES` (40) is composed APP-side in
  `registry.js` `tillPatch` from single-tile tills, serpentine order, stones
  and grass skipped and named, energy / no hoe / abort / 4 unreachable tiles
  in a row stop it, progress via `onProgress` ("- 6/15" in in_flight). The
  mod's own interrupts (bedtime, retreating, knocked out, interrupted,
  superseded, paused, aborted) also stop it: sending the next tile would
  start a new command on top of the retreat or the walk home. The mod's
  till refuses any tile with a terrain feature, bush or clump (0.1.3).
- **Timeouts:** a farm-scope water/harvest gets a 15 min cap plus a 240 s
  no-progress timeout (`commandTimeouts` in `client.js`, reset by each
  `progress` frame); any `cmd` that times out is also CANCELLED in the mod.
- **water / harvest `scope: "farm"`** (0.1.3): walk to the Farm and cover the
  whole map (default 120, max 200). With no tile, water refills the can at
  the nearest water (`Tools.NearestWater`, up to 3 refills) instead of
  stopping at 40, and both step over up to 5 crops they cannot walk to.
  Harvest stops at a full bag and leaves the crop in the ground
  (`SeiBody.HasRoomFor`). An older mod gets `scope` dropped by the registry
  and the chores line says its calls reach 20 tiles.
- **ship / give** (0.1.3, `Actions/Shipping.cs`): ship walks to the farm's
  shipping bin and drops produce (crops/forage/fish by default, or a named
  item); give walks to the HOST and puts an item in their bag
  (`addItemToInventoryBool`, host only: a farmhand's inventory lives on
  their machine; nothing leaves her bag until the add has landed). Before these a harvest sat in the companion's bag.
  `CHORES_VERBS` are hidden from `listActions` and refused by the registry
  on an older mod.
- **Proactive layer:** the snapshot gains a `chores:` line
  (`farmChores`: dry / ready crops with the farm-wide call, ready machines,
  produce to ship), the player line says what the host is holding and when
  they are in a menu or cutscene (`host.holding/menu/inEvent`), the date line
  carries tomorrow's forecast (`tomorrow`). The new-day notice now waits
  (max `DAY_OBS_WAIT_MS`) for the new day's first observation and names the
  morning's chores. `fsmWires` raises `onIdleNudge({reason:
  'player_activity'})` when the host keeps a tool out for 3 s (once per
  60 s, same activity once per 5 min, proactive mode only (tier 2, read
  live from `config.persona.proactiveness`), never in a menu/event, off-map
  or while the body is busy) and the idle addendum pitches "your half" of that
  job (`ACTIVITY_SUGGESTIONS`).
- Prompt text for all of it is gated on 0.1.3 (`ACTION_RULES_CHORES`,
  `CAPABILITY_PARAGRAPH_CHORES`, `describeAction`); 0.1.2 keeps
  `ACTION_RULES` (plus the till patch, which is app-side). Same rule as
  0.1.2: `assets/stardew-mod/` is NOT rebuilt here; rebuild on the Mac and
  commit, which also ships the 0.1.3 manifest. New game APIs used (compile
  and verify on the Mac): `Item.canBeShipped`, `Object.sellToStorePrice`,
  `Farm.buildings` + `ShippingBin`, `Farm.getShippingBin(..).Add`,
  `Farmer.addItemToInventoryBool` on the host, `Farmer.CurrentItem`,
  `Game1.eventUp`, `Game1.weatherForTomorrow`,
  `GameLocation.getLargeTerrainFeatureAt`.

**Stardew companions look like themselves (260921).** Every Stardew body used
to be the one shared placeholder NPC sprite. It is now drawn as a FARMER
dressed with the game's own character creator knobs: gender, skin, hairstyle,
hair color, eye color, shirt, pants, pants color, accessory. No hat (not a
creator knob, and it hides the hair).
- **One LLM call per character, in main.**
  `src/main/games/stardew/appearance.ts` follows `chessProfile.ts` (forced
  tool call `set_stardew_appearance`, through `buildLlmProvider`, so cloud and
  BYOK both work) and `survivorPick.ts` (injectable deps, persisted SPARSE in
  `UserConfig.stardew_appearance[characterId]`, not in `character.metadata`,
  which cloud-syncs verbatim and is not editable on a default such as Lyra).
  Input is `gatherAppearanceText`: the soulcaster sheet's appearance block and
  image prompt first, then the description, then the persona source (the
  expanded persona only as a last resort). The character text sits between
  `<character>` tags and the system prompt says it is data. Two deliberate
  differences from the two precedents: a FAILED derivation is never persisted
  (a stored fallback would make the character generic forever because of one
  network error; the cost is at most one retry per summon), and the result is
  salvaged FIELD BY FIELD (`coerceStardewAppearance`: a model that gets eight
  knobs right and invents a shirt number still produced a usable look; fewer
  than 5 valid fields counts as a failure).
- **The legend is the feature.** The model cannot see the sprite sheets, so
  `src/shared/stardewAppearance.ts` lists every ALLOWED index with a short
  description of what it looks like, and the schema admits nothing else (42
  hairstyles, 70 shirts, 24 skins, 4 pants, 13 accessories). Tool properties
  are plain `integer` with the legend in the description, not JSON-schema
  number enums, because not every provider accepts those; the Zod schema is
  the gate. Ranges and the legend come from the game itself, not from a wiki:
  the 1.6.15 assemblies were read with Mono.Cecil (`changeSkinColor` wraps at
  0..23, `changeAccessory` at -1..29, shirts and pants are STRING item ids in
  1.6), `Data/Shirts` and `Data/Pants` were unpacked and parsed (the creator's
  own set is the rows with `CanChooseDuringCharacterCustomization`: shirts
  "1000".."1111", pants "0".."3"), `Data/HairData` adds hairstyles 100..122 to
  the sheet's 0..55, and the hair, shirt, accessory and pants sheets were
  unpacked (the game's MonoGame LZX decoder, run from a scratch tool) and
  looked at composited on the farmer body. The config row is deliberately
  LOOSE in `characterSchema.ts`; the strict legend check runs in the reader,
  so removing an index from a legend re-derives one character instead of
  failing the whole config parse.
- **Plumbing.** `GameModule.prepareJoin({characterId, character})` is a new
  optional async seam. The supervisor awaits it beside `ensurePack`, BEFORE
  `startedAtMs`, so it never comes out of the 30 s summon deadline, and merges
  what it returns into the join target (`getJoinTarget` is synchronous and
  does not know the character). Stardew's returns `{appearance}` from
  `appearanceForSummon`: a stored look at once, else a first derivation
  awaited for at most `APPEARANCE_SUMMON_WAIT_MS` (6 s), then the summon goes
  ahead WITHOUT the field while the single-flight derivation finishes and
  persists for next time. `adapterConfigFrom` copies it into `adapter.stardew`
  (loose schema with `.catch(undefined)` in `src/bot/config.js`: looks must
  never fail a bot config) and `runtime.js` adds it to the `spawn` frame, on
  reconnect spawns too. The field is optional end to end and
  `STARDEW_PROTOCOL_VERSION` is unchanged: an old mod ignores it, an old app
  never sends it.
- **The mod draws the shadow Farmer in the NPC's place, and the NPC stays the
  body.** `Body/Appearance.cs` clamps the frame field by field against what
  THE RUNNING GAME accepts (`Farmer.GetAllHairstyleIndices()`,
  `Game1.shirtData` / `pantsData`), not against the app's legend, so the
  legend can grow without a mod rebuild; then applies it through the game's
  own `change*` methods, gender first (it swaps the base texture and re-applies
  the shirt). `Body/BodyDraw.cs` is a Harmony PREFIX on
  `NPC.draw(SpriteBatch, float)` that, for a registered body, calls
  `FarmerRenderer.draw` with the shadow and skips the NPC's own draw. A prefix
  rather than an SMAPI `Rendered*` event because the farmer has to be inside
  the world's depth-sorted batch to pass behind trees; rather than an NPC
  subclass because `location.characters` is a NetCollection of NPC. Rendering
  the 16 walk frames into a sprite sheet was the fallback and was not needed.
  The decompile facts above still hold: the shadow is in neither
  `Game1.otherFarmers` nor `location.farmers`, and `BotFarmer.draw` stays a
  no-op so there is one draw path. Load-bearing details: the farmer is drawn
  16 px LOWER than the NPC position (an NPC's box is y+16..y+48, a farmer's
  y..y+32, both draw feet at the box bottom, so without it the feet float
  above the ground shadow and the collision box); depth is the NPC's own rule
  (`StandingPixel.Y / 10000`); the ground shadow needs nothing because
  `Game1.DrawWorld` draws character shadows separately from `NPC.draw`; the
  tool-use hop still shows because `getLocalPosition` carries `yJumpOffset`;
  emotes are kept by calling `npc.DrawEmote`. The shadow's `Update` never
  runs, so `SeiBody.AnimateShadow` advances the walk cycle each tick from
  whether the NPC moved (`FarmerSprite.animate(walkUp|Right|Down|Left, 16)`,
  else `StopAnimation` + `faceDirection`), only on the host's current map
  (FarmerSprite's footstep dust and sound are written for the map on screen),
  and the paused branch of `Tick` refreshes `_lastPos` or the walk cycle would
  run on the spot for the whole pause. Any failure (apply, animate, draw)
  flips that body back to the placeholder sprite for good and logs once;
  `FarmerLook: false` in the mod's config.json turns the whole thing off.
  No appearance in the frame means the mod's neutral default farmer, which is
  the ONLY default (main sends no field rather than a second copy of it).
- **Dev frame:** `devAppearance` (same `DevCommands` gate) returns the clamped
  request, the rejected fields, the values read back from the shadow farmer
  and the sprite frame / facing / base texture. `scripts/fake-stardew-mod.mjs`
  records the field and answers the same frame.
- **Unverified (the game was not launched for this change):** that the farmer
  actually draws in place and at the right height, the walk cycle in four
  directions, depth sorting against trees and buildings, the look of each
  legend entry on a dressed body in motion (the legend was written from the
  sheets, some hair entries from silhouettes only), what a farmhand sees
  (their game has no registry entry, so it should be the placeholder), and the
  quality of the model's picks for real characters. Tool-use animations are
  not implemented: a swing is still the NPC hop. Owed: a user override in the
  launch panel (`source: 'user'` is already in the stored row and is kept
  as is), and re-deriving when a character's description changes
  (`clearAppearance` exists; nothing calls it yet).
- **260925: the model sees the portrait, and the look is shared (v2).** The
  v0.6.5-beta.2 playtest drew Sui with wild blue spikes and a bright purple
  shirt. Root cause: the defaults have no description and no sheet, so the
  model got the personality blurb ("tomboy gremlin") and invented a look; it
  never saw the character. Now:
  - The portrait goes in as an IMAGE when the active backend can see
    (`activeLlmVision() === 'yes'`: cloud proxy, Anthropic BYOK, vision local
    models), read from `paths.portraitPath(id)` (cache-on-demand puts a cloud
    character's art there) or its https URL, and the prompt makes the picture
    the truth. The options are one labelled MENU in the message
    (`renderStardewAppearanceMenu`, hair grouped by length), and the tool call
    starts with an `observed` sentence. `scripts/stardew-appearance-probe.ts`
    runs v1 against v2 on the fixture portraits with the dev key. Measured
    (Haiku 4.5, 3 runs each): Sui's hair went from 8 (wild spikes) every run to
    a long style (115/24/110) in lavender every run; Lyra from a chin-length bob
    to long brown hair and a black top with a white collar; Marv from grey skin
    to red skin and bald, every run.
  - **The look lives in the CLOUD** (`src/main/cloud/gameProfileClient.ts`,
    table `character_game_profiles` + `POST /games/profile` in sei-proxy):
    read under RLS, written only through the proxy, FIRST WRITE WINS, and the
    response carries the stored row so a race loser adopts the winner's look.
    Every user then gets the same Sui. Resolution: local `user` row (this
    user's override) > cloud row at the current version (or the owner's cloud
    `user` edit) > local `auto` row at the current version > a new derivation.
    The config row is only a cache for when the cloud has no answer.
  - A derivation is offered to the cloud only when it SAW the portrait, or the
    character has no art at all: a blind text guess by a BYOK model without
    vision stays local, so it cannot become everyone's look.
  - `STARDEW_APPEARANCE_VERSION` (2) tags every row; older `auto` rows (every
    v1 look already in a config) are ignored and redone, and the proxy lets a
    higher version replace an `auto` row but never a `user` one.

**Dashboards in the games' own registers (260909).** Both bot-backed
dashboards are now DELIBERATE, CONTAINED EXCEPTIONS to the design tokens,
under the same contract as `McDashboardPanel` (which the Stardew panel used
to borrow wholesale, vanilla-gray windows and all): a game's live view
should read like that game's HUD, not like a settings page. Each panel's
CSS module declares its own palette on `.panel` and nothing outside the
component references it.
- `DstDashboardPanel` (+ `dstDashboard.ts`, pure + tested): ink ground,
  aged-parchment sheets with burnt edges and hand-cut corners, the three
  vitals as the HUD BADGES (dark ring, parchment face, the meter as coloured
  liquid rising from the bottom, the organ icon on top, pulsing when low),
  the CLOCK as the 16-segment day ring split day/dusk/night per season
  (`DST_PHASE_SPLIT`; the mod reports the phase, not the segment, so the
  whole phase is lit), body temperature with the game's freezing (<=0) and
  overheating (>=70) bands, and the inventory bar as dark slots in rows of
  15 with the equipped hand item in its own slot. Prefabs map to in-game
  names (`dstItemLabel`). Fonts: Fredericka the Great for figures,
  Metamorphous for labels (both OFL, DST-only).
- `StardewDashboardPanel` (+ `stardewDashboard.ts`, pure + tested): the
  wooden menu frame drawn in CSS (outline, wood band with highlight, inner
  line, cream face), dark-plum text with the tan drop shadow in Pixelify
  Sans (OFL, Stardew-only), ENERGY/HEALTH as the vertical HUD bars (green ->
  yellow under a quarter -> red under a tenth), the DATE BOX (weekday from
  the day number since day 1 is always Monday, weather + season icons, the
  day dial from 6 AM to 2 AM, HUD-cased time, gold in its own box), and the
  12 x 3 inventory with the held slot framed red.
- **Several companions in one game share the dashboard (260909).** A
  dashboard is mounted for ONE character, but Minecraft and Stardew run a
  body per character, so the status strip became a STATUS ROW: this
  companion's window first (titled with their name once there is company),
  then one window per other companion online in the same game, each a
  button that opens that companion's chat. Membership comes from
  `useDataStore.summons` (same `game`, kind `online`), not from what is on
  screen; the activity line needs that companion's telemetry, which main
  samples only while WATCHED, so `useGameCompanions`
  (`components/games/useGameCompanions.ts`) arms the watch flag for every
  sibling while the dashboard is mounted and shows an ellipsis until the
  first snapshot lands. All three dashboards use it (the Minecraft strip
  grew `name` + `companions` props). DST is one body per world, so its row
  never grows, but it rides the same code.
- **The width is spent (260909).** Both game-styled bodies are CSS grids:
  status row, then instruments, then inventory, with a PORTRAIT CARD in
  the fourth column spanning rows 2-3 (the companion's own art via
  `DashPortrait`, same seed + palette as the Home wall; name, survivor or
  location, held item). Whatever width the fixed windows leave goes to the
  face. The art is absolutely positioned inside its box so its canvas adds
  no intrinsic height (otherwise the spanning card GREW the rows it spans:
  measured, the first cut was a 700 px portrait). Under a container query
  (`.panel` is `container-type: inline-size`; 1000 px DST, 900 px Stardew)
  the card drops to a full-width row with the art on the left.
- **The controls are ONE hook, `components/games/useGameControls.ts`**
  (paused/mode/disconnect/hover hint + `GAME_CONTROL_DESCRIPTIONS`); each
  game paints its own buttons. `GameControlsWindow` (the token-styled
  generic version) rides the same hook and is now unused by any registered
  game; keep it for a future game that has no register of its own.
- **Verify in a browser tab, not a summon:** `?dashshot=1` (or
  `?dashshot=dontstarve|stardew`) on the dev server renders both panels
  over fixture snapshots (`components/games/DevDashShot.tsx`).
  `lib/ipcClient.ts` captures `window.sei` at module evaluation, and
  main.tsx's static import of App reaches it first, so the harness stubs
  live in `devHarnessStubs.ts`, which MUST stay main.tsx's first import.
  Render tests (`*DashboardPanel.test.tsx`) pin the meters, the clock, the
  slots and the zh coverage; CSS-module class names are hashed under vitest,
  so the tests count `data-slot` attributes rather than class names.

**Don't Starve Together (M2)** `native/dst-mod/sei/` (Lua, MIT, server-only,
`all_clients_require_mod = false`, luacheck clean; `PROTOCOL.md`, mirrored in
`src/shared/dstIpc.ts`). Body = a vanilla survivor prefab spawned on the
master sim with `scripts/brains/seibrain.lua` (FAtiMA-DST skeleton): safety
layer first (run away under 35% health, find light at dusk, fight back when
told, eat under 25% hunger), then the command slot. **Transport direction is
inverted**: a mod can only reach out through `TheSim:QueryServer` to
127.0.0.1 (Klei blocked third-party URLs in Jan 2025, hotfix 653007 carved
localhost back out; no headers, bodies under ~20 KB), so main's watcher hosts
a discovery port and answers the mod's 2 s heartbeat with a summon offer `{token, botPort, ...}` after the bot's
runtime reports its ephemeral `node:http` port over a `dst-listen` port
message; the mod then POSTs `/obs` at 3 Hz (delta-compressed, <= 8 KB) and
polls `GET /cmd` with a 400 ms bounded hold (measure it against the
undocumented QueryServer timeout on day one). 21 verbs. **The character picks
her survivor** (user decision 3): `src/main/games/dontstarve/survivorPick.ts`
is a one-off LLM call over the persona + the roster brief in
`src/shared/dstSurvivors.ts` (15 eligible; Wes, Wonkey, Woodie, Wanda
excluded, reasons in the brief), persisted sparse in
`UserConfig.dst_survivor[characterId]`, user-overridable in the launch panel;
the chosen survivor's perks ride the world primer, and each survivor's
special needs (meat-only, vegetarian, souls, wetness, fire, frailty) are DATA
read by both the BT and the primer, never branches. Install = mod copy into
`<install>/mods/sei/` + `modsettings.lua` (`ForceEnableMod("sei")`,
`DisableLocalModWarning()`), re-applied on every launch because game updates
rewrite that file; the mod copy also runs on every launch, and when the
pack's `modinfo.lua` version is newer the old `mods/sei/` is removed first
(260925); launch = `steam://rungameid/322330`. Four spikes wait for
the live checklist: a joiner with `all_clients_require_mod = false`,
ownerless `inst:Remove()`, a caves-enabled host, the QueryServer hold.

**DST helper 0.3.0: habits, alerts, frontier (260926).** Audit and headless
results: `~/suisei/reports/dst-capability-audit-2026-09-26.md`. Three things
worth knowing before touching the DST body:
- **Combat never landed a hit before this.** `ChaseAndAttack` calls
  `combat:TryAttack`, which only pushes `doattack`, and survivor stategraphs
  have no handler for it (players swing through the ATTACK action).
  `companion.lua` now translates `doattack` into a buffered ATTACK.
- **Survival chores are habits in the mod** (`scripts/sei/reflexes.lua`):
  dusk torch, night light, fire tending, gear-up, defending the player,
  healing, food choice. They report `survival` events that do NOT wake the
  brain (`fsmWires.js`); they surface as the snapshot's `your_habits` line.
  The brain is woken by `observers/alerts.js` (starving with no food,
  freezing, low health with nothing hostile near) and nudged at P3 (dusk with
  no way to make light, low sanity, player hungry, season turning) only when
  `persona.proactiveness` >= 1; passive characters see them in `heads_up`. The
  prompt tells the model the habits cannot plan: keeping the makings on hand
  is its job. `observers/progression.js` gives the heartbeat a frontier.
- **Everything new gates on the helper's reported version**
  (`modVersion.js`, `CAPS_MIN_MOD`). A world keeps the helper it started
  with, so an older helper gets the old prompts, verbs and wake routing.
  Bump `modinfo.lua` and `scripts/sei/version.lua` together (a test checks).
- **"Am I lit" is ONE test**, `Reflexes.LitByOthers`: the engine light
  (`TheSim:GetLightAtPoint`) at the body's feet with its own held lights
  switched off for the reading, with hysteresis (0.2 in, 0.1 out). Light,
  tool and gear habits all use it, so the torch and the axe cannot swap
  every tick. In the dark a work command walks there with the torch and
  refuses ("too dark to chop here") unless something else lights the spot.
- **Sleeping lights light nothing.** Entities away from a real client sleep
  (also in real play when the body is far from the host). `SetCanSleep(false)`
  does not wake an entity that is already asleep, only one set in the frame
  it spawns. So the equip listener keeps held lights awake, and
  `Reflexes.KeepFiresAwake` respawns the flame of a burning fire near the
  body awake (released at day or when she leaves). No light on the body.
- **Habits never undo an explicit `equip`** (`Reflexes.Hold`/`CommandHeld`)
  except dark with no light. Defend needs a `hostile` tag or a hit on the
  player in the last 6 s, never shadow creatures. `give` needs an exact name.
Headless testing (Linux dedicated server + `scripts/dst-headless-harness.mjs`)
is in `native/dst-mod/sei/README.md`.

**Credits:** every reused project is in the README Acknowledgements with its
license (user decision 7); copied code carries a header credit and
`native/<mod>/THIRD_PARTY_NOTICES.md`.

## Instrumenting a game or timed surface (REQUIRED)

**Every new game, minigame, or timed surface MUST emit analytics before it
ships.** This is not optional polish. Chess shipped in v0.5.0 with zero
instrumentation and voice calls shipped in v0.4.x the same way, so for three
weeks the dashboard's "minutes" meant *Minecraft only* and the question "is
anyone playing chess?" had no answer from any source: PostHog had no chess
event, and `ledger_consumption` records spend with no surface column, so the
cost could not be attributed either. Fixed 260728.

The contract is two events per surface:

- **`<surface>_started`** — fired when the surface actually opens, with the
  parameters that shape the session (for chess: `player_color`, `ai_elo`,
  `profile_source`).
- **`<surface>_ended`** — fired at the single lifecycle choke point, carrying
  **`duration_ms`**. That key name is load-bearing: the analytics dashboard
  sums playtime with one query across every event in its `SESSION_EVENTS` list
  (`analytics/server.mjs`), so a surface that names its duration field anything
  else is invisible in playtime. Also send `character_id` and an outcome.

Rules that follow from the existing implementations:

- Fire `_ended` on **abandoned/aborted** sessions too, with a `reason` — that
  time was still spent. `chessService.endSession` is the choke point precisely
  because every exit path (resign, draw, checkmate, abandon, engine failure)
  routes through it.
- Emit only **shape, never content**: no board state, no chat text, no persona.
- Use a **lazy `await import('../analytics')` inside a fire-and-forget block**,
  so the module graph and the tests never depend on analytics being
  initialized. `capture()` is already a no-op when uninitialized or opted out.
  260926: chess, Draw! and backseat go through `loadAnalytics()`
  (`src/main/lazyAnalytics.ts`), one cached lazy import. Two separate
  `import('../analytics')` calls in the same tick can resolve to different
  instances under vitest mocking, so a mocked `capture` silently misses the
  second event. Prefer it for new capture sites.
- Then add the new `_ended` name to `SESSION_EVENTS` in the analytics repo
  (`~/slop/sei-studio/analytics/server.mjs`) and a label in `SURFACE_LABEL`
  (`public/app.js`). That is the only dashboard change needed.

Current members: `bot_session_ended` (Minecraft), `chess_game_ended`,
`voice_call_ended`, `draw_game_ended`, `backseat_ended`, `chat_session_ended`.

**Text chat counts too (260801).** Chat was the last surface with no
instrumentation at all, so playtime meant "everything except the thing people
do most" and a user who only ever texted had an empty character list on the
dashboard. `src/main/chat/chatSession.ts` models a session as a run of messages
closed by a 5 minute idle gap, NOT as ChatScreen mount/unmount: a chat window
left open in the background is not playtime, and the chat screen HOSTS the
other surfaces, so mounted time would double-count every chess game, Draw!
round and call against the chat clock. The overlap is excluded structurally —
`noteChatMessage` is called from exactly one place in the `chat:send` handler,
past the point where chess and Draw! have declined the message and with
`inCall` false, so a line typed into a live game or spoken on a call is only
ever counted by that surface. `duration_ms` spans first message to LAST
message, never the idle tail, so a one-message session honestly reports 0 ms
and `messages` carries the shape. `endAllChatSessions()` runs on `before-quit`
BEFORE `shutdownAnalytics()`, because quitting mid-conversation is the normal
way a chat ends.

**Every event carries `ui_language` (260801).** `commonProps()` in
`src/main/analytics.ts` stamps the APP UI language (not the per-character
`chat_language`) on every event and `$set`s it on the person. Before this the
only cloud-side trace of a non-English user was `characters.metadata.language`,
which is written at character CREATION — so anyone using only the bundled
defaults was invisible. Cached, not read per event (commonProps is sync);
`setUiLanguage()` is refreshed from the `config:save` IPC handler, the single
path both Settings and the onboarding Sui stage write it through.

**`installer_first_launch` fires once per install (260926).** It carries
`platform`, `arch`, `os_version`, `packaged`, `arm64_translation`, and on macOS
`in_applications`, `translocated` and a coarse `app_location` enum
(`applications`/`translocated`/`volume`/`downloads`/`other`, never a path).
"Once" is the device-global `<userData>/install-marker.json`, created with an
exclusive open by `noteLaunch()` as the FIRST step of `bootstrap()`
(`src/main/firstLaunch.ts`). It cannot key on `analytics_install_id`: that id
lives in the profile-scoped config, so a first sign-in would mint a new one.
The marker step also probes for older Sei state (`PRIOR_STATE_ENTRIES`), so an
existing install updating to the first build with this code is classified
`upgrade` and sends nothing. Keep that list in sync if a new device-global
file appears, and keep `noteLaunch()` ahead of anything that writes userData.

### The play row is ONE sentence, shared (260728)

`src/main/chat/playSummary.ts` owns it, and every game surface calls it:

```
You and Marv played Draw! for 7 minutes.
```

No results, no score, no move count, no window name. Each surface used to
compose its own, and read back in the chat log that was four registers for the
same event, with the detail aging worst: a scoreline from four days ago is the
least interesting thing about having played. `playSummaryText(name, game, ms)`
is the only way to write one, and `playSummary.test.ts` pins the shape.

This is also what the character reads later through the rolling summary, so
dropping results is a deliberate trade: the companion remembers the SESSION
rather than the scoreline. Anything genuinely worth keeping is what
`remember()` is for, and every surface already offers it.

## Continuity for a game or timed surface (REQUIRED)

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
   `MEMORY.md` that chat, voice and the bot share. In a **tool loop**, answer it
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

## In-app fullscreen for game surfaces

The fullscreen control on a game surface means **in-app**, not OS window
fullscreen (260728: it used to call `window:fullscreen-toggle`, which took over
the whole display and was awkward to undo). It gives the mounted game every
pixel the app window has: the IconRail goes, the chat goes, and (260729) the
ChatTopBar goes too — the top bar's own load-bearing buttons (call, end) live
in the game's bottom chrome row (`GameChromeRow`), so nothing up there is
needed while it is hidden.

State is `useUiStore.gameFullscreen`, and the rule for any NEW game surface is:

- the mounted surface OWNS the flag: it sets it, and **clears it on unmount**
  (`useEffect(() => () => setFullscreen(false), [])`). That is why
  `App.tsx`'s `railHidden` needs no per-view test and the rail can never stay
  hidden after the game is gone;
- games hosted in the chat screen's game area get it for free through
  `GameSurface`; a full-page game route (Draw!) mounts `GameChromeRow` itself;
- a full-page game route hides the chat by virtue of being a route, so it
  keeps the IconRail by DEFAULT and only drops it in fullscreen. Do not add the
  route to `railHidden` — that is for onboarding-style ritual surfaces.

The `windowFullscreenToggle` / `windowIsFullscreen` IPC still exists on the
preload bridge but no renderer surface calls it.

**The game/chat split (260917).** Three rules in `ChatScreen`:
- A game DASHBOARD with no user-dragged split sizes the game area to its
  content (`.gameFit`: `height: auto`, capped at the column minus a 200px
  chat band), so the Stardew / DST / Minecraft dashboards never scroll
  internally at a normal window height. The dashboards were laid out for the
  full picture and at the old 62% default their `.body` grids hid the bottom
  rows. Chess and the launch panels keep an explicit default, now
  `min(72%, calc(100% - 240px))` (was 62% / 280px), because they paint
  absolute art that needs a definite height. A dragged split turns the fit
  off; double-click on the handle restores it.
- The drag handle goes ALL THE WAY DOWN: fewer than `SPLIT_COLLAPSE_CHAT_PX`
  (96px) of chat left snaps into the existing expanded state (the same one
  the "V" toggles) instead of leaving a sliver, and dragging back up leaves
  it. The old 220px chat floor is gone.
- The composer dock is IN-FLOW below the message list, not floating over it.
  The floating dock's window-coloured band went transparent over a custom app
  background, so the conversation showed under and beside the message box;
  in-flow, the list is clipped where the dock begins and the background can
  still show through. `MiniTile` measures `[data-chat-composer]` by rect, so
  it is unaffected.
`?dashshot=chat|chatdst` mounts a dashboard inside the real ChatScreen (a
Proxy over the stub bridge answers whatever the screen asks) for checking
any of this in a plain tab.

## Directory map

```
src/
  main/                 Electron host (main process)
    index.ts            entry
    ipc.ts              IPC handler registration
    botSupervisor.ts    utilityProcess.fork + MessageChannelMain, multi-bot lifecycle (Map<characterId, session>)
    apiKeyStore.ts      safeStorage key + getAiBackendKind()
    configStore.ts      <userData>/config.json (Zod-validated, atomic)
    characterStore.ts   local character library
    backseat/           screen-watch session, tick arbitration, share label
    auth/               Supabase, PKCE loopback OAuth, session, jwtBridge
    cloud/              proxyClient, credits/billing, cloud character sync, moderation
    updater.ts          electron-updater driver (packaged builds only)
    updatePolicy.ts     version.json policy decisions (pure, dev-safe)
    migration.ts        config/data migrations
    profile/            multi-account profile scoping + import
  preload/
    index.ts            window.sei bridge (RendererApi), compiled to .cjs
  renderer/             React 19 + Zustand UI
    src/App.tsx
    src/screens/        CharactersScreen, Settings, Credits, Onboarding, ...
    src/components/      reusable UI (Button, CharacterCard, modals, ...)
    src/lib/stores/     Zustand stores (useAuthStore, useCreditsStore, ...)
    src/styles/tokens.css   design tokens (see below)
  bot/                  LLM brain + mineflayer (utilityProcess)
    index.js            bot entry (forked by Electron main)
    config.js           Zod config schema (iteration_cap, compaction, providers)
    registry.js         generic action registry
    brain/              orchestrator, fsm, llm/ providers, memory, prompts, anthropicClient
    adapter/minecraft/  mineflayer adapter: connect, behaviors, observers, registry
  shared/               cross-process contracts
    ipc.ts              IPC channel + payload contracts
    characterSchema.ts  character Zod schema
    errorClasses.ts     typed error vocabulary
    legalVersions.ts    ToS/privacy version pins
```

### UI / design system

The renderer follows the **"Summoning Terminal"** look: dark, sharp-edged,
periwinkle `#7FB0FF` accent. Always use tokens from
`src/renderer/src/styles/tokens.css` — never literal hex/px — and reuse existing
primitives (`Button`, `CharacterCard`, modal patterns) before writing new CSS.

**No em dashes in user-facing text.** Any copy a user can read — UI labels,
hints, error messages, modal bodies, tooltips, in-game bot messages, page
titles — must not contain an em dash (`—`). Rewrite with a period, comma,
colon, or restructure the sentence. This applies everywhere user copy lives
(renderer, main-process error strings, `src/bot` canned messages), and to
LLM-generated user-visible output via prompt rules + normalization
(in the bot a dash is a message BREAK in `splitChatMessages`, and the unsplit
voice-call line normalizes it to a hyphen — both in `orchestrator.js`; plus
the dash strip in `personaExpansion.ts` / `uniqueGeneration.ts`, soulcaster's
"No em-dashes in your prose"). Exceptions:
code comments, developer logs, test names, and model-facing prompt text are
fine; an en dash is allowed as an empty-value placeholder glyph (`$–`) or a
range (`A–Z`), never as prose punctuation.

---

## Build & release

Bundler is **electron-vite** (`electron.vite.config.ts`), three targets:

- `main` and `preload` use `externalizeDepsPlugin`; **preload outputs `.cjs`**.
- Build-time `define` injects OPTIONAL overrides from `.env`: `SUPABASE_URL` +
  `SUPABASE_ANON_KEY` (direct-to-Supabase, for self-hosters; anon key is public
  by design — RLS is the security boundary) and `SEI_PROXY_URL`. Since the
  260704 anon-key migration a build with NO `.env` is fully functional:
  `src/main/env.ts` routes Supabase through the proxy's transparent
  `/supabase/*` reverse proxy (`https://api.sei.gg/supabase`) with a
  placeholder key the proxy swaps for the real anon key server-side.
  `SEI_PROXY_URL` is defined ONLY when set — an unconditional `?? ''` define
  used to replace `process.env.SEI_PROXY_URL` with `''` and dead-code every
  `?? 'https://api.sei.gg'` runtime fallback. See `.env.example`.

Packaging is **electron-builder** (`electron-builder.yml`):

- `appId: com.sei.app` is **LOCKED** — changing it strands every existing user's
  `safeStorage` keychain entries. Treat as irrevocable.
- `asar: true`, with `asarUnpack` for **`src/bot/**`**, **`node_modules/**`**
  (so the forked bot can resolve its native + ESM deps from outside the asar),
  and **`resources/skins/**`**.
- **macOS:** per-arch (`arm64`/`x64`) `dmg` + `zip`, `hardenedRuntime` +
  notarization (Apple Team ID from the `APPLE_TEAM_ID` env var). The `zip` is
  what electron-updater installs from; the `dmg` is manual download only.
- **Windows:** NSIS x64, **unsigned** for v1 (SmartScreen "unknown publisher"
  is accepted UX).
- **Linux:** AppImage (best-effort unsigned).
- `postinstall` runs `electron-builder install-app-deps` to rebuild native
  modules against Electron's ABI.
- **Version bumps:** run `npm install --package-lock-only` only where
  `node_modules` is already installed. In a fresh worktree without it
  (v0.6.5-beta.2) it looped through postinstall and stripped the `libc`
  fields from the lockfile; after a bump, `git diff package-lock.json` should
  show only the version lines.

**No remote debugging in stable builds (260925).** The fuses
(`electronFuses` in `electron-builder.yml`) turn off RunAsNode, NODE_OPTIONS and
`--inspect`, but Chromium's `--remote-debugging-port` / `--remote-debugging-pipe`
have no fuse: any local process could relaunch the signed app with CDP and drive
the renderer (preload IPC + TCC grants). `src/main/remoteDebugGuard.ts`, the
FIRST import of `src/main/index.ts`, calls `process.exit(1)` when a packaged
build whose version has no prerelease tag sees `--remote-debugging-*`,
`--inspect*`, `--debug-port` or `--js-flags` (argv scan plus
`app.commandLine.hasSwitch`; pure policy in `remoteDebugPolicy.ts`). Packaged
betas (`X.Y.Z-beta.N`) and dev are unaffected. Measured on Linux: Chromium
opens the DevTools port only AFTER the main script has evaluated, so exiting
there means the port never listens. Consequence: **installed-app CDP
verification (`open -a Sei --args --remote-debugging-port=...`) only works on a
beta**; a stable install quits immediately. Keep the guard the first import, and
never `appendSwitch` a debugging switch in production code.

Common scripts: `npm run dev` (electron-vite dev), `npm run build`,
`npm run dist:mac` / `dist:win` / `dist:linux`.

### Updater

`src/main/updater.ts` drives **electron-updater** over the **GitHub Releases**
feed (`publish: github`, `sei-studio/sei`). It is loaded **only behind
`app.isPackaged`** — `autoUpdater` throws when unpackaged, so dev runs the pure
policy functions only. A side-channel `GET https://sei.gg/version.json` carries
`{ version, apply, changelog }` to decide ask-first vs silent install. On macOS
updates install from the zip artifact.

**The download never blocks the app (260801).** Two renderer surfaces, split by
whether the state needs a decision right now: `UpdatePopup` is the modal (the
optional-update offer with its changelog, the post-update what's-new, and the
`apply:'now'` restart), `UpdatePill` is a corner card that never takes the
pointer (download progress, then "ready, restart to apply"). Before the split,
`app:update-progress` drove the popup into a scrimmed `downloading` state with
no dismiss path, so a routine MANDATORY patch, which updater.ts deliberately
downloads without asking, locked the user out of the app until it finished.
The consented flow no longer auto-installs either: the accepted download may
land minutes later with the user mid-game, so `autoInstallOnAppQuit` applies it
on the next quit and the pill only OFFERS the restart. `forced` is the one
state that still takes the window, because main quits a few seconds later
regardless. The `downloading` pill has no dismiss (nothing to decide while it
works), so `App.tsx` must clear it on `app:update-error` or a dead download
pins it at whatever percent it reached.

---

## Critical pitfalls

- **Pathfinder silent hangs** → every pathfinder call is wrapped with a
  wall-clock timeout (`adapter.minecraft.pathfinder_timeout_ms`, default 12s).
  No exceptions.
- **Single-layer iteration runaway** → bounded by `iteration_cap` (default 30).
- **A nested timeout only wins if it is sized against the outer one** →
  connect.js armed a flat 20s guard at `createBot` while `botSupervisor.ts`
  arms `SUMMON_TIMEOUT_MS` (30s) at `fork`, and the comment claimed ~10s of
  margin. The real margin is 10s minus process boot minus the status ping (up
  to 5s), which a cold packaged Windows start eats whole, so the child's
  SPECIFIC error never reached main and every stalled join surfaced as a bare
  `ready_timeout`. Measured 260801: a user whose world was open and answering
  pings was told to go check that their LAN world was open. Fixed by shipping
  the supervisor's deadline itself (`summonDeadlineAt`, absolute epoch ms —
  same machine, same clock, and it cannot drift out of step with the constant
  the way a duplicated budget would) in the init payload; `connectTimeoutFor`
  sizes the guard to land inside it with `REPORT_MARGIN_MS` (3s) to spare, and
  floors at 5s so a slow boot never invents a failure on a healthy handshake.
  The error text now distinguishes "the status ping ANSWERED, so the world is
  reachable and the JOIN stalled" from "never resolved a version", and
  `ERROR_COPY.BOT_START_TIMEOUT` leads with the retry that actually works
  instead of sending the player to verify the one thing already known to be
  fine. Anything else nested inside a supervisor deadline owes the same
  treatment.
- **The summon deadline used to include the bot's cold boot** → until 260926
  the 30s watchdog started at `fork`, and a packaged Windows boot (module graph
  plus Defender scanning every file it opens) measured 21-24s before
  `createBot`, so the connect guard sat on its 5s floor and BOT_START_TIMEOUT
  was the top Windows summon failure (14 people in 30 days). Now the boot has
  its own 60s budget (`BOOT_TIMEOUT_MS`, phase `boot_timeout`) and the 30s
  ready budget starts at `init-ack`; the bot starts the same budget on its side
  from `readyBudgetMs` in the init payload. The status carries
  `stage: 'starting' | 'joining'` so the launch button shows progress.
  `src/bot/bootTiming.js` stamps each boot phase and main folds them into
  `summon_failed` / `character_summoned` as flat `boot_<phase>_ms` props (ms
  since fork) plus `boot_last_phase`. The biggest boot cost was the vision
  stack: `visualize.js` statically imported the POV renderer, which loaded
  native `gl`, `canvas`, `three` and prismarine-viewer (about 80% of the
  runtime's bytes read at import) on every summon. It now loads lazily through
  `render/povStackLoader.js`, warmed 6s after spawn only when the model can
  take images. The loader must never hold the event loop for long (the bot is
  in the world by then, and a blocked loop misses the server keep-alive and
  gets kicked): it reads every file of the stack asynchronously first (so the
  disk read and antivirus scan happen off the loop), then requires three,
  canvas and gl one per event-loop turn, and logs its timings to the bot log.
  A failed load is final for the session (a failed ESM import stays cached);
  `look()` says so once in full. Keep heavy or native modules out of the
  runtime's static import graph.
- **Renderer caches outlive an account switch** → main re-points every
  per-profile store on `app:scope-changed`, but a Zustand store keeps what it
  already read, and the bundled defaults (Sui, Lyra, ...) share their UUIDs
  across profiles. Until 260926 the next account opened the previous
  account's chat transcript straight from `useChatStore`. `App.tsx` now calls
  `resetAccountScopedState()` (`lib/scopeReset.ts`) first in its scope-changed
  handler; the chat store also drops the results of any load / send / push
  begun before the reset (`scopeEpoch`). Any NEW renderer cache keyed by
  character id or holding account data must be cleared there.
- **An account switch ends every live session first (260926)** →
  `switchScopeForAuth` used to stop only the game bots, so a chess game, a
  Draw! round, a backseat share and a voice call kept running under the
  previous account (and authState has already applied the NEW JWT by then).
  Now `endAccountSessions` (`src/main/profile/accountSessions.ts`) runs before
  the scope moves: `endAllChess` / `endAllDraw` / `endAllBackseat`, main's
  `endVoiceCallsForAccountSwitch` (index.ts, timed from the renderer's
  `live:true` connect report; the renderer's late hang-up report is dropped
  via `consumeClosedByMain`), `endAllChatSessions('account_switch')`, then
  `app:scope-ending` to the renderer (`endLiveSurfaces` in `scopeReset.ts`:
  hang up, stop capture, clear the game mirrors, go Home), then
  `supervisor.stop()`. Every `_ended` event carries `reason: 'account_switch'`.
  Closing rows are written fire-and-forget and resolve `paths.*` when they hit
  the disk, so each is registered with `trackScopedWrite`
  (`profile/scopeBarrier.ts`) and the switch `drainScopedWrites()` before it
  re-points the scope. **A new surface with a closing row must track it and
  add an `endAll*` to `endAccountSessions`.** While the teardown runs
  `foldIfDue` defers (it would bill the new account), and a fold whose
  summarizer straddles the switch is dropped rather than written into the
  next account's bridge.
  Guarantees around it (review, 260926):
  - Switches are serialized (a promise chain in `profileScope.ts`; prev/next
    scope are read inside it, same scope = no-op) and the whole teardown is
    bounded by `withAccountTeardown` (10s ceiling): a hung end step never
    keeps the scope from moving or leaves the fold deferred. The end promises
    are tracked like rows, so the bounded drain is the only wait.
  - From the moment a switch is requested until main has sent
    `app:scope-changed`, session starts are refused (`beginSessionStart`,
    error `ACCOUNT_SWITCHING`). A start whose awaits straddle a switch
    re-checks `stillValid()` right before `sessions.set` and unwinds.
    **A new session surface must take the same guard.** The renderer's
    scope-changed reset does not end the live surfaces a second time after
    `app:scope-ending` (that would orphan a session started in the new
    account in the gap); `useBackseatStore.share` ends main's session if the
    scope epoch changed under it.
  - Chat turns are refused during a switch and tagged with the scope they
    began in (`withScopedTurn`); a turn still running when the account
    changes is aborted (`cancelAllInflightTurns`) and writes no transcript row,
    MEMORY.md line or fold (`turnMayWrite` / `scopedTurnCurrent`). The
    last_chatted stamp is not gated.
  - A companion hang-up (`end_call`) whose renderer report has not arrived
    is kept in `callState` (`endCallFromCompanion`) so the switch closes it
    and writes its row in the old account; `applyCallReport` is the pure
    composition the `voice:call-state` handler runs.
- **Native ABI mismatch** → `@electron/rebuild` / `install-app-deps` runs in
  `postinstall`. Test packaged builds on a clean machine.
- **Bot ESM module type in packaged builds** → `src/bot/package.json` exists
  ONLY to declare `{"type":"module"}`. The bot ships as raw ESM source (not
  bundled) and is asar-**unpacked** to `app.asar.unpacked/src/bot/`. The root
  `package.json` (with its own `"type":"module"`) is sealed inside `app.asar`,
  so when Node resolves the unpacked bot it walks the real filesystem, finds no
  `"type"`, defaults `.js` to CommonJS, and fails to parse the `import`
  statements — the bot crashes before connecting (symptom: "module type … is
  not specified and it doesn't parse as CommonJS", then summon fails on packaged
  installs only — `npm run dev` is unaffected). Do not delete `src/bot/package.json`.
- **Stale `.js` shadows `.tsx` in Vite** → `tsc --build` emits sibling `.js`
  files next to `.tsx`; Vite then serves the stale `.js` and silently ignores
  your renderer edits. These artifacts are gitignored (`src/**/*.js`, except
  `src/bot`). If renderer edits aren't taking effect: delete the stray `.js`
  artifacts (do **not** delete the real ones under `src/bot`) and restart dev.

---

## GSD planning

This project uses the GSD planning system; artifacts live in `.planning/`.
Start with `.planning/STATE.md` (current state) and `.planning/ROADMAP.md`
(phases) before picking up cross-cutting work. Commit planning docs alongside
the code they describe.
