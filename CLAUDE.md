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

- **Shape:** N rounds (1-5, setup slider). Each ROUND is two TURNS: the player
  draws while the character guesses, then the character draws while the player
  guesses. Every turn is capped at `TURN_MS` (3 min) and ends early the instant
  the guesser says the word. Contract: `src/shared/drawIpc.ts`.
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
  tokens.css rule: it declares a scoped palette on `.root` instead. Every rule
  and border is a generated squiggle (`squigglePath.ts` / `Squiggle.tsx`), and
  the face is Architects Daughter (OFL), self-hosted like every other font.

## Backseat (260728)

The companion watches a window the player shares and comments on it live,
launched from the "Play together" tiles. **Mutually exclusive with a Minecraft
summon, chess and Draw!** (the shared `lib/gameLaunch.ts` gate). Works in voice
mode (spoken through the live call) or text mode (a mini chat on the overlay);
both write to the SAME chat thread and the same memory as every other surface.

- **Authority split.** The renderer owns pixels and sound: `getDisplayMedia`,
  the ring buffer, frame scoring, grid compositing, the rolling clip recorders,
  and two of the three triggers. Main owns the session and EVERY model call.
  Contract: `src/shared/backseatIpc.ts`.
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
- **The ring buffer does not hold 900 frames.** "15 s at 60 fps, one frame per
  second by loudest gain" read literally is several GB or 60 JPEG encodes a
  second. It does not have to be: the selection rule is a running argmax, so
  `captureWorker.ts` keeps exactly ONE frame per one-second bucket alive (the
  best so far, as an ImageBitmap), discards every loser immediately, and encodes
  the winner once at the bucket boundary. 1 encode/second, ~15 JPEGs resident,
  and still every frame examined. Full-rate 60 fps video is kept only by
  MediaRecorder, which is the only consumer that needs it.
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
pixel the app window has: the IconRail goes, and the chat goes.

State is `useUiStore.gameFullscreen`, and the rule for any NEW game surface is:

- the mounted surface OWNS the flag: it sets it, and **clears it on unmount**
  (`useEffect(() => () => setFullscreen(false), [])`). That is why
  `App.tsx`'s `railHidden` needs no per-view test and the rail can never stay
  hidden after the game is gone;
- games hosted in the chat screen's game area get it for free through
  `GameSurface`; a full-page game route (Draw!) wires its own toggle;
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
