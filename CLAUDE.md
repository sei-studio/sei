# Sei — Contributor Guide

Sei is a Minecraft AI companion. This repository is the **client**: an Electron
desktop app ("Sei Launcher") for non-technical users that spawns an AI-driven
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
- **One bot at a time.** `botSupervisor.ts` owns exactly one session: a new
  summon stops the active one first. Summon has a hard **30s timeout**
  (`SUMMON_TIMEOUT_MS`); stop has a 10s timeout then escalates to kill.
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

**Speech.** The bot's voice is the LLM's **text block**, not a tool call (the
agent-loop model: a turn emits any mix of `text` + `tool_use`; text goes to
in-game chat, tools execute). Text is post-processed before it reaches chat —
see `postProcessSay()` in `src/bot/brain/orchestrator.js`. `chat_mode: 'full'`
additionally surfaces the model's private scratch text to chat with a `[think]`
prefix.

**Event-sourced FSM.** `src/bot/brain/fsm.js` is a priority queue with a
single-flight dispatcher and one `AbortController`:

```
P0_SAFETY (0)  →  P1_CHAT (1)  →  P2_MOVEMENT (2 ...)  →  P3_IDLE (3, 60s fallback)
```

Player chat (P1) preempts any non-P0 work mid-action. Adapter wiring lives in
`src/bot/adapter/minecraft/fsmWires.js`.

**Iteration cap.** Tool-use chains are bounded by `memory.iteration_cap`
(**default 30**, in `src/bot/config.js`) to stop single-layer runaway.
> The old planning-era CLAUDE.md said 20 — that was wrong; the value is 30.

**Memory.** Per-character memory directory.
- **Writes are LLM-driven:** the model calls `remember()` / `forget()` to
  maintain an append-only `MEMORY.md`; `PLAYER.md` tracks the other player.
- **Compaction is a byte-threshold trigger:** after each successful
  `remember()`, if `MEMORY.md` exceeds `memory.compaction_trigger_bytes`
  (**default 4096**), an async single-flight Haiku compaction fires.
> The old CLAUDE.md framed this as "the LLM decides when to compact at semantic
> boundaries" — misleading. The *write* is LLM-driven; the *compaction* is
> mechanical (byte threshold).

The bot has **two entry paths** (`src/bot/index.js`): forked by Electron (waits
for an `init` message over the port) or run standalone via the `sei` CLI
(`src/bot/cli/index.js`, discovers LAN + reads `./config.json`).

---

## Directory map

```
src/
  main/                 Electron host (main process)
    index.ts            entry
    ipc.ts              IPC handler registration
    botSupervisor.ts    utilityProcess.fork + MessageChannelMain, one-bot lifecycle
    apiKeyStore.ts      safeStorage key + getAiBackendKind()
    configStore.ts      <userData>/config.json (Zod-validated, atomic)
    characterStore.ts   local character library
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
    index.js            bot entry (forked or CLI)
    config.js           Zod config schema (iteration_cap, compaction, providers)
    registry.js         generic action registry
    brain/              orchestrator, fsm, llm/ providers, memory, prompts, anthropicClient
    adapter/minecraft/  mineflayer adapter: connect, behaviors, observers, registry
    cli/                standalone `sei` CLI
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

---

## Build & release

Bundler is **electron-vite** (`electron.vite.config.ts`), three targets:

- `main` and `preload` use `externalizeDepsPlugin`; **preload outputs `.cjs`**.
- Build-time `define` injects `SUPABASE_URL`, `SUPABASE_ANON_KEY` (public by
  design — RLS is the security boundary), and `SEI_PROXY_URL` from `.env`. See
  `.env.example`.

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
