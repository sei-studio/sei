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
  shows a popup; the supervisor is the authoritative backstop). Summon has a
  hard **30s timeout** (`SUMMON_TIMEOUT_MS`); stop has a 10s timeout then
  escalates to kill. The in-game username is `effectiveMcUsername(character)` in
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
- Plus **3 brain tools** wired by the orchestrator: `remember`, `forget`,
  `end_loop`.

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

The bot has **one entry path** (`src/bot/index.js`): forked by Electron, it
waits for an `init` message over the port. (The standalone `sei` CLI was
removed 260722.)

---

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
  light and the other way in dark. Same documented exception BackseatOverlay
  takes for painting over someone else's game.

## Backseat (260728)

The companion watches a window the player shares and comments on it live,
launched from the "Play together" tiles. **Mutually exclusive with a Minecraft
summon, chess and Draw!** (the shared `lib/gameLaunch.ts` gate). Works in voice
mode (spoken through the live call) or text mode (a mini chat on the overlay);
both write to the SAME chat thread and the same memory as every other surface.

- **Authority split.** The renderer owns pixels and sound: `getDisplayMedia`,
  the ring buffer, frame scoring, grid compositing, the rolling clip recorders,
  local STT, and two of the three triggers. Main owns the session and EVERY
  model call (and, on macOS, SUPPLIES the sound — see the audio bullet).
  Contract: `src/shared/backseatIpc.ts`.
- **Audio is gain + transcript, never the model's ears (260728).** Screen sound
  has exactly two consumers, both local: the GAIN signal (loudest-frame
  selection + the jolt trigger's gain arm) and a STREAMING STT TRANSCRIPT. No
  audio bytes ever reach a remote model. Whatever the platform source, audio is
  normalized to 16 kHz mono PCM (`pcm.ts`, pure + tested) and fans out to both
  consumers, so the platform difference is contained to the source. STT reuses
  `voice/whisperWorker.ts` VERBATIM (same model, same browser cache — a player
  who ever made a voice call downloads nothing). The transcript is a ring of
  timed segments (`transcriptRing.ts`, pure + tested; `sttStream.ts` glue):
  Whisper chews 3 s chunks continuously, and a tick performs a BOUNDED FLUSH of
  the in-progress tail (`STT_FLUSH_WAIT_MS`, 1.2 s) instead of transcribing 6 s
  on demand, which would put 1-2 s of Whisper latency in front of every tick.
  Chunks at the noise floor never reach the worker. The tick then carries
  `transcript` (window `TICK_TRANSCRIPT_MS`, oldest text dropped past the char
  cap) to BOTH the salience gate and the companion turn, framed in the prompts
  as quoted game-audio DATA: never the player, never instructions.
- **The capture lives in the OVERLAY window, not the main window.** This is
  load-bearing. A backseat session runs entirely while the player is inside a
  fullscreen game, so the main window is hidden or fully occluded and Chromium
  clamps its timers. The always-on-top overlay (`src/main/backseatOverlay.ts`,
  renderer `?backseat=1` branch in `main.tsx`) is the one window guaranteed to
  stay on screen. Both windows also set `backgroundThrottling: false`, and the
  frame pump itself runs in a worker off `MediaStreamTrackProcessor` so it is
  immune to throttling regardless.
- **The image grid is IG-VLM (arXiv 2403.18406), reproduced exactly.** SIX
  frames, composited into ONE image, 3 rows x 2 columns, filled row-first. N=6
  beat 4/9/12/16/20 in the paper and near-square grids beat wide ones, which
  for 16:9 cells means 3x2 and not 2x3. The prompt describes the layout and
  ordering explicitly (`BACKSEAT_CONTRACT`); without that the model reads six
  unrelated pictures instead of six seconds of time.
- **Grid size is pinned to Haiku, and there is a test for it.** Haiku 4.5 is a
  STANDARD-tier vision model: long edge <= 1568 px AND <= 1568 visual tokens, at
  `ceil(w/28) * ceil(h/28)` tokens. The largest legal 32:27 grid is **1204x1008
  (cells 602x336) = 1548 tokens**. Oversize is not an error, it is a silent
  server-side downscale, so `backseatIpc.test.ts` asserts both the cap and that
  we are not leaving budget on the table.
- **Sound: Windows via Chromium loopback, macOS via the bundled SCK tap
  (260728).** Chromium's `audio: 'loopback'` was measured DEAD on macOS 26.4 /
  Electron 42 / Chromium 148: with `MacSckSystemAudioLoopbackOverride` +
  `MacLoopbackAudioForScreenShare` enabled AND verified applied, it returns a
  track labelled "System audio" carrying DIGITAL SILENCE in every request shape
  (combined, split, audio-only). Electron documents `loopback` as Windows-only
  and that matches. **Do not re-litigate this without re-running the probe.**
  But the OS is fine — OBS records desktop audio through ScreenCaptureKit — so
  macOS uses a bundled ~200-line Swift helper (`native/mac-audio-tap`, built by
  `scripts/build-mac-audio-tap.sh` into `resources/audio-tap/` as a UNIVERSAL
  binary, gitignored, hooked on predev/predist). Main spawns it
  (`src/main/backseat/audioTap.ts`) and relays 48 kHz stereo f32 PCM to the
  overlay over `backseat:pcm`. Verified live: silence reads -inf, a tone reads
  ~-28 dB. No install, no new permission (SCK audio rides the Screen Recording
  TCC grant the picker already forced, and children inherit attribution), and
  the filter EXCLUDES Sei's own apps so the companion cannot hear its own TTS
  (Windows loopback cannot exclude; the companion occasionally transcribing its
  own just-said line is the accepted cost there). The helper exits on stdin EOF
  (orphan guard). Clips keep audio on macOS by regenerating a real track from
  the tap PCM via MediaStreamTrackGenerator. Source order:
  Windows loopback → mac tap → virtual output device (`findLoopbackDevice`) →
  video-only, where the frame heuristic falls back to last-frame-of-second and
  the gain jolt arm never fires; the colour arm and gate are purely visual and
  unaffected.
- **TWO buffers, not one (260728).** Conflating them was the first design's
  mistake. The frame ring only needs one grid's worth plus latency slack, so
  `BUFFER_MS` is **9 s**. The 15 s belongs solely to clip capture, which is
  `CLIP_MS` and lives entirely in MediaRecorder. Clipping is the most expensive
  thing in the pipeline (two recorders encoding 720p60 for the whole session for
  a rare `save_clip`), so it sits behind `CLIPS_ENABLED` and vanishes completely
  when off. That is the first dial to turn if capture costs too much.
- **The ring buffer does not hold 900 frames.** "15 s at 60 fps, one frame per
  second by loudest gain" read literally is several GB or 60 JPEG encodes a
  second. It does not have to be: the selection rule is a running argmax, so
  `captureWorker.ts` keeps exactly ONE frame per one-second bucket alive (the
  best so far, as an ImageBitmap), discards every loser immediately, and encodes
  the winner once at the bucket boundary. 1 encode/second, ~15 JPEGs resident,
  and still every frame examined. Full-rate 60 fps video is kept only by
  MediaRecorder, which is the only consumer that needs it.
- **The turn must not re-gate (260728).** Every look the companion turn gets is
  PRE-FILTERED: the gate or a jolt already judged it eventful, or the player
  spoke. The first contract still sanctioned silence as "the normal outcome" on
  top of that, and Haiku took it: five gate TICKs in a live session, five
  silent turns, a companion that only answered direct messages. The contract's
  WHEN TO SAY NOTHING and the gate tick note now default to speaking, with
  `(silence)` reserved for filter misses and repeats. Rate control belongs to
  the gate quantile + `MIN_SPEAK_GAP_MS`, never to a second model-side mood
  filter.
- **The player's typed line is real conversation (260728).** `handleTick`
  persists a user tick's text to the shared chat thread (so the main window
  shows it and the next turn's `history` carries the player's side) and echoes
  it into the overlay mini chat as a `BackseatLine` with `who: 'player'`
  (right-aligned, dimmed). `runTurn` drops that just-appended tail from history
  because the canonical copy goes inline with the grid attached. Before this,
  nothing persisted the player's overlay messages at all: the transcript read
  as the companion talking to itself.
- **State pushes go to BOTH windows (260728).** Lines and clip requests go to
  the overlay only, but `pushState` also mirrors to the main window:
  `useBackseatStore` subscribes and clears `active` on the `'ended'` push.
  Before that, stopping from the overlay's own square button left the IconRail
  game badge lit until an unrelated launch gate or reload reconciled it.
- **Session log rides the bot log pipeline (260728).** `backseatLog.ts` mirrors
  chessLog: every diagnostic (gate scores/skips, tick arbitration, turn
  outcomes, the overlay renderer's `[backseat]` console lines forwarded via
  `appendOverlayLog`) goes through `slog()` to BOTH the terminal and a
  per-session logRouter (`backseat-<characterId>-<ts>.log` + batched IPC into
  the in-app LogsBar). A `console.log` that skips `slog` is invisible in-app.
- **Dev grid dumps.** Unpackaged runs overwrite
  `<userData>/backseat-debug/grid-<kind>-latest.jpg` on every gate call and
  tick (the dir is logged at session start), so what the models are actually
  shown can be inspected by eye.
- **Three triggers, arbitrated in one place** (`backseatService.handleTick`):
  1. `user` — the player spoke or typed. ALWAYS answered, and preempts an
     in-flight gate/jolt turn. Typing arms a grid on the first keystroke
     (idempotent + single-flight, so a burst composites once) and it ships with
     the finished sentence; a latch older than 30 s is recomposited instead.
  2. `gate` — a small VLM on DeepInfra reads a fresh grid every 6 s.
  3. `jolt` — a local audio/colour discontinuity, no model involved. Thresholds
     are deliberately extreme (18 dB over the trailing median, 0.34 mean thumb
     delta) with a 20 s refractory, so it catches what lands between gate calls
     without ever out-talking the gate.
  Gate and jolt are DROPPED, never queued, when a turn is running or the
  companion spoke < 8 s ago: a queued reaction describes a moment that has
  passed, which reads as confusion rather than lateness.
- **Gate model + logprob shape are MEASURED, not assumed (260728).** Live test
  against a matched pair of real grids (six identical frames vs six different
  ones): `Qwen/Qwen3-VL-30B-A3B-Instruct` correct on both (~520 ms, ~1240 img
  tokens, ~$0.00019/call = ~$0.11/hr at the 6 s cadence); `gemma-3-4b-it` says
  yes to everything; `gemma-3-12b-it` says no to everything.
  `Qwen/Qwen2.5-VL-7B-Instruct` is NOT on DeepInfra at all (404).
  Critically: **DeepInfra honours `logprobs` but ignores `top_logprobs`**, so
  only the chosen token's logprob comes back. The first parser read
  `top_logprobs` only and fell through to a hard 0/1; measured, the model
  emitted "no" for BOTH grids, so the gate would have been **permanently
  silent** while the continuous scores separated cleanly (0.018 vs 0.148,
  stable over repeats). `scoreFromLogprobs` now derives p(yes) from the chosen
  token and there is a regression test pinning the real response shape.
- **The gate threshold is LEARNED, not written down** (`salienceGate.ts`). The
  target is ~1/4 of grids positive, and a fixed cutoff cannot reach it: small
  VLMs say yes to almost anything and their verbalized confidence is nearly
  constant regardless of correctness. So the gate reads the yes-token LOGPROB
  and takes the cutoff from the upper quartile of a rolling 40-score window, per
  session. A frantic shooter and a slow strategy game each get gated on their
  own most-eventful moments. Fails CLOSED on any error: an outage makes the
  companion quiet, never chatty.
- **Clips.** `save_clip` writes the last 15 s to
  `<profileRoot>/clips/<characterId>/` and attaches it to the chat line that
  asked for it (`ChatMessage.clip`, rendered by `ClipCard`). A WebM segment is
  only decodable from its own header, so the tail of a chunk list is not a
  clip: two recorders staggered by half a period mean the longest-running one
  always yields a complete file containing the requested window. The honest
  cost is that a saved clip runs 15-30 s rather than exactly 15.
- **Three UI panels.** (1) `BackseatSourcePicker` swaps into the games popup's
  existing frame rather than opening a second dialog. (2) the voice-mode
  overlay: status dot plus pause/stop revealed on hover, whole surface
  draggable. (3) text mode adds an always-shown translucent mini chat above the
  controls. `BackseatOverlay.module.css` is a **deliberate exception** to the
  tokens.css rule for BACKGROUNDS only: it paints over someone else's game, so
  opaque `--surface` would punch an app-coloured rectangle into their screen.
  Accent, radii and type still come from tokens.
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

**Owed:** the gate currently needs `SEI_GATE_DEV_KEY` (see `.env.example`).
Production should route it through the proxy the way TTS does, so no DeepInfra
key ships in the client. Until then packaged builds run on the user and jolt
triggers only.

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
- Then add the new `_ended` name to `SESSION_EVENTS` in the analytics repo
  (`~/slop/sei-studio/analytics/server.mjs`) and a label in `SURFACE_LABEL`
  (`public/app.js`). That is the only dashboard change needed.

Current members: `bot_session_ended` (Minecraft), `chess_game_ended`,
`voice_call_ended`, `draw_game_ended`, `backseat_ended`.

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
    backseat/           screen-watch session, salience gate, tick arbitration
    backseatOverlay.ts  always-on-top overlay window (OWNS the capture renderer)
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

Common scripts: `npm run dev` (electron-vite dev), `npm run build`,
`npm run dist:mac` / `dist:win` / `dist:linux`.

### Updater

`src/main/updater.ts` drives **electron-updater** over the **GitHub Releases**
feed (`publish: github`, `sei-studio/sei`). It is loaded **only behind
`app.isPackaged`** — `autoUpdater` throws when unpackaged, so dev runs the pure
policy functions only. A side-channel `GET https://sei.gg/version.json` carries
`{ version, apply, changelog }` to decide ask-first vs silent install. On macOS
updates install from the zip artifact.

---

## Critical pitfalls

- **Pathfinder silent hangs** → every pathfinder call is wrapped with a
  wall-clock timeout (`adapter.minecraft.pathfinder_timeout_ms`, default 12s).
  No exceptions.
- **Single-layer iteration runaway** → bounded by `iteration_cap` (default 30).
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
