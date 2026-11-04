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
  watchdogs: a **90s cold-boot budget** (`BOOT_TIMEOUT_MS`, fork to the bot's
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

### Local voices: Fish Audio (261103)

Fish Audio is the third Local voice next to Fast and Kokoro
(`src/main/voice/fishTts.ts`, wired in `tts.ts`).
- **Every request to fish.audio MUST send the header `model: s2.1-pro-free`.**
  Fish reads a missing or unknown header as the paid `s2.1-pro`, which bills
  an account that has credit. `fishHeaders(key)` is the only header builder:
  /v1/tts, the 429 retry and the `/model/{id}` voice lookup all use it, and
  `fishTts.test.ts` pins each one. Never hand-build Fish headers.
- The key is the user's own (BYOK, safeStorage, `fishKeyStore.ts`). Main calls
  api.fish.audio directly, never through the Sei proxy.
- Fish allows 5 requests at a time per account. `openFishStream` keeps at most
  `FISH_MAX_IN_FLIGHT` (4) per key and queues the rest, so a long reply does
  not hit a 429 and change voice part way through.
- If Fish fails, the line is spoken with the Fast voices, and the
  `fish-fallback` notice is sent only once that clip exists. The renderer shows
  it once per reason per call. With no Fast pack installed, the usual
  pack-missing error appears instead.
- Three table voices are pvc voices with retire dates. Replace them in
  `src/shared/fishVoices.ts` before these dates: ivish (en male) 2029-10-25,
  桃桃 (zh female) 2028-10-26, 温柔沉稳男声 (zh male) 2028-10-15.

---


## Area guides (read the one for what you touch)

The detailed notes for each area live in `docs/agents/`. This file stays short so it fits in an agent's context; read the guide for the area you change before editing it, in chunks if it is long. When you learn something worth keeping, add it to that guide, not here.

| Guide | Covers |
|---|---|
| [`docs/agents/bot-llm-internals.md`](docs/agents/bot-llm-internals.md) | Bot and LLM internals in src/bot: brain, FSM, prompts, tools, speech, memory |
| [`docs/agents/guided-first-moment.md`](docs/agents/guided-first-moment.md) | Guided first moment after onboarding |
| [`docs/agents/chess.md`](docs/agents/chess.md) | Chess minigame: engine, reveal protocol, model download |
| [`docs/agents/draw.md`](docs/agents/draw.md) | Draw! minigame |
| [`docs/agents/call-scenes.md`](docs/agents/call-scenes.md) | Call scenes and the backdrop toggle |
| [`docs/agents/avatar-overlay.md`](docs/agents/avatar-overlay.md) | Avatar overlay (always-on-top call overlay, desktop avatar) |
| [`docs/agents/backseat.md`](docs/agents/backseat.md) | Backseat: screen watching, looks, chatter pacing |
| [`docs/agents/minecraft-setup-wizard.md`](docs/agents/minecraft-setup-wizard.md) | Minecraft setup wizard and target version |
| [`docs/agents/game-adapters-stardew-dst.md`](docs/agents/game-adapters-stardew-dst.md) | Game adapters: Stardew Valley and Don't Starve Together (helper mods, IPC, eval) |
| [`docs/agents/instrumenting-surfaces.md`](docs/agents/instrumenting-surfaces.md) | REQUIRED before adding or changing a game or timed surface: analytics events and limits |
| [`docs/agents/continuity-surfaces.md`](docs/agents/continuity-surfaces.md) | REQUIRED for a game or timed surface: continuity and resume |
| [`docs/agents/in-app-fullscreen.md`](docs/agents/in-app-fullscreen.md) | In-app fullscreen for game surfaces |
| [`docs/agents/build-release.md`](docs/agents/build-release.md) | Build and release: CI, signing, notarization, feeds, rollout |

## Directory map

```
src/
  main/                 Electron host (main process)
    boot.ts             entry shim (built as dist/main/index.js): boot guard, updater, safe mode
    index.ts            the app (built as dist/main/app.js), loaded by boot.ts in normal mode
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

### UI languages (260730 zh, 261104 ja, ru, pt-BR, es)

The app UI language is `UserConfig.ui_language`, listed once in
`src/shared/uiLanguage.ts` (`UI_LANGUAGES`, native names, BCP 47 tags,
`formatMessage` with `{name}` and ICU-lite `{n, plural, ...}` forms,
`joinSentences`). The i18n key is the English string; dictionaries live in
`src/renderer/src/lib/i18n/` (`zh.ts` + `zh/*`, `ja.ts`, `ru.ts`, `pt-BR.ts`,
`es.ts`, registered in `DICTIONARIES`). Main-process copy (safe mode, the
Windows update window, the Velopack splash, the free-play reset notice, the
macOS DST grant panel) keeps en and zh inline and takes the four 261104
languages from `src/shared/addedLanguageCopy.ts`.
- **A new English string needs all five translations.**
  `dictionaries.test.ts` fails on a missing key, an empty value, an em dash,
  a "friend" word, or a placeholder that differs from the English key.
- Plurals: write `{n, plural, one {...} few {...} many {...} other {...}}`
  (Russian needs one/few/many). Never build a count by joining words.
- System locale: zh-* to zh, every pt-* (pt-PT included) to pt-BR, every
  es-* to the neutral `es`, everything else English (`uiLanguageForLocale`).
- Fonts: under a ja or zh UI, `--sans` puts the OS CJK face FIRST
  (`--sans-ja` / `--sans-zh` in tokens.css, `html:lang()` rules), so Latin
  inside a label ("ChatGPTログイン") uses the CJK face's own Latin instead of
  Rajdhani, which runs much smaller than kana and hanzi at the same size.
  `--display` (Oswald) and `--mono` are unchanged; en is untouched.
  Cyrillic subsets of the UI faces are self-hosted in `fonts.css` (by
  unicode-range, so other languages render as before). The DST faces
  (Fredericka, Metamorphous) have no Cyrillic and fall back to a serif.
- The plan catalog is server copy (proxy `plan_config` / `topup_config`),
  translated in the client through its English text: `planDisplayName`,
  `planLabel`, `planBlurb` and `topUpCreditsLine` in `lib/planCatalog.ts`
  ("Free" is translated, Quest and Party stay brand names). A blurb the
  proxy changes shows in English until the dictionaries have it.
- The "Continue with ChatGPT" button (`ContinueWithChatGPTButton`, the one
  component every surface uses) is translated like the Google button, with
  "ChatGPT" verbatim. The spec width is a `min-width` (242px): a longer label
  (ru, pt-BR) widens the button instead of overflowing its 20px gutters.
- Only zh changes companion behavior (language pin at creation, SenseVoice,
  zh voices, Draw! and chess character-language paths); the 261104 languages
  translate the interface only.
- Check layout with any `?dashshot=` harness plus `&lang=<code>`.

### UI / design system

The renderer follows the **"Summoning Terminal"** look: dark, sharp-ish 2px
corners (`--radius` / `--radius-sm`, never a literal radius), periwinkle
`#7FB0FF` accent. Always use tokens from
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
  its own budget (`BOOT_TIMEOUT_MS`, 60s, 90s since 261007; phase `boot_timeout`) and the 30s
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
- **The data scope follows the auth STATE, not the auth event (261029)** →
  "restarting locks me on the login page". After a restart the stored access
  token has usually expired, and `auth.getSession()` is NOT a storage-only
  read: it refreshes over the network. Step 0a of `main/index.ts` used it to
  pick the boot scope, so a refresh that failed there (offline for a moment,
  a 5xx) set `'local'` while initAuthState's own getSession() succeeded, and
  the subscription only switched scopes when the user CHANGED between two
  events. Result: signed in, scope `local`, no `app:scope-changed` push, and
  the onboarding sign-in panel (which waits for one) stuck for good; signing
  in again was a same-user SIGNED_IN, a no-op. Now step 0a reads the stored
  session without a refresh (`persistedSessionUserId`), `followAuthScope` in
  authState.ts moves the scope whenever it disagrees with the state (init,
  every event, `transitionToLocal`; `restored` = no sign-in side effects and
  no import offer), and the renderer routes on `sei.authSnapshot()` (state +
  `scopeReady`, `lib/authBoot.ts`) instead of the store's `local` default;
  OnboardApp also confirms readiness through it, so a missed push cannot
  strand the panel. Pinned by `loginLockOnRestart.test.ts` on the real
  supabase-js client. Anything that decides routing from auth must not
  assume it saw every push.
  Review follow-up (261029): offline, `getSession()` takes ~51 s (startup
  refresh backoff, then a second refresh in `__loadSession`), so
  initAuthState no longer awaits it at all. Its first state comes from the
  stored session (`readPersistedSession`, `applyBootScope` in
  `auth/bootScope.ts` for step 0a), it subscribes before any network, and
  supabase-js's own load corrects it through the subscription. An
  INITIAL_SESSION with no session while the stored one is still there means
  the load failed for a network reason: the session is kept (a refused one
  is removed by supabase-js and arrives as SIGNED_OUT). A "real" sign-in is a
  SIGNED_IN (or PASSWORD_RECOVERY: a reset session never arrives as
  SIGNED_IN) with an access token this process has not seen; only it owes the
  sign-in steps (`signInStepsOwed`), which run once even when the scope
  already matched; follow-ups of a superseded or failed move are skipped
  (`scopeRequestSeq`). The renderer never routes on a `loaded:false`
  snapshot (`lib/bootRoute.ts`, polls up to 90 s behind `BootSplash`), and
  the onboarding panel only accepts a scope push or snapshot naming ITS
  account (`lib/signInScopeGate.ts`). `signOut()` returns `{error}` offline
  and keeps the session in storage even with `scope:'local'`, so sign-out
  paths call `dropSessionLocally` (which stops the refresh ticker when even
  the local sign-out fails). A sign-out the user did not ask for is captured
  as `signed_out` with `reason: 'session_rejected'` (`noteUserSignOut`
  marks the user's own). Auth requests have a 15 s fetch timeout
  (`withAuthRequestTimeout`), the profile move's network steps 15 s each.
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
- **Own-key companions stranded or mis-owned on sign-in (261023)** → the
  `local` profile → account import (`src/main/profile/localImport.ts`) is
  offered on EVERY local→account sign-in that finds companions or memories,
  new account or existing (App.tsx; a sign-in inside the first-run scene is
  offered when the scene hands off). It merges, never replaces
  (`profile/memoryMerge.ts`): an account copy of the same id keeps its JSON
  and art, MEMORY.md / archive / chat.jsonl are line-unioned, `worlds.json`
  merges by fingerprint and renumbers the local `## World N` headers. Only
  owner-null companions are stamped with the account; World companions and
  Sui/Lyra/Marv keep their real owner and go into `added_world_ids`
  (stamping them made the sign-in reconcile sweep delete them as leaks).
  Idempotent; moved data is removed from `local`.
  Accounts that signed in on an older build never saw the offer, so it is
  also shown ONCE at boot per account per device (`checkBootImportOffer` in
  `lib/localImportOffer.ts`; only on a calm Home: no modal, tour, first
  moment, call, game or share), and Settings → Account has a "Bring
  companions from this computer" row (`settings/LocalImportRow.tsx`). Any
  answer from any entry point is recorded in the device-global
  `<userData>/local-import-offered.json` (`profile/localImportOffered.ts`,
  IPC `profile:import-offered`). Those two entry points ignore the Sui the
  first-run scene seeded when the player never touched her (no memory
  entry, knowledge, bridge, or non-assistant chat row:
  `peek.untouchedSeedIds`); the sign-in offer does not. A failed import
  keeps the modal up with an error line and "Try again". A local
  `## World N` header with no `worlds.json` entry gets a fresh number above
  every number in use, reserved in the account's registry under
  `UNREGISTERED_WORLD_FP` so the bot never reuses it.
- **A whole-config write reverts other writers (260929)** → every main-process
  write of the profile `config.json` goes through `configStore.updateConfig`
  (locked read-modify-write, path fixed when the call starts) and sets only
  the keys that writer owns. `loadConfig()` then `saveConfig()` is for seeding
  and tests: a game ending in the gap (chess difficulty, the Draw! intro,
  playtime) was reverted by the stale copy. Renderer saves go through
  `saveConfigFromRenderer`; a new `UserConfig` key must be added to
  `RENDERER_SETTABLE_KEYS` or `MAIN_OWNED_KEYS` (a test checks). A writer
  that awaits (network, a character copy) between reading and writing
  captures `getActiveScope()` first and passes `updateConfig(fn, { scope })`,
  or re-checks the scope and gives up; otherwise an account switch in the
  gap lands its write in the next account (cloud default, library add, local
  import, the sign-in reconcile sweep, which also stops when the scope moves).
- **Node fetch ignores the OS proxy (261103, T303)** → a VPN in "system
  proxy" mode carried Chromium's requests but not main's or the bot's, so
  sign-in code exchanges and BYOK calls went out direct and were refused.
  `src/bot/net/` routes undici's global dispatcher per origin:
  `systemProxy.js` installs `proxyDispatcher.js`, main always (Chromium's
  `session.resolveProxy`, `src/main/systemProxy.ts`), the bot only when the
  fork-time snapshot `SEI_SYSTEM_PROXY` names a proxy (`proxyPac.js` decides
  without loading undici). DIRECT stays on Node's built-in Agent: the undici
  package fills the shared global slot with its own Agent when it LOADS, so
  never import `undici` or `proxyDispatcher.js` statically from main or the
  bot entry. A proxy that refuses the connection is skipped for 60 s and the
  request moves down the PAC list, always ending DIRECT; a failed or slow
  (3 s) lookup is DIRECT for 30 s. `undici` is pinned exactly and must share
  its major with Electron's `process.versions.undici` (a test checks).
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

## Design docs

Durable design docs that code comments point at live in `docs/design/` (UI
design system, Party redesign, chat + memory, backseat v2, avatar v0.6, game
adapters, in-app updater, craft tool). The old GSD `.planning/` tree (phase
plans, roadmaps, one-off experiment output) was removed on 261030; it is in
git history if you need it. The repo is public: keep pricing, cost and margin
numbers, security write-ups, personal paths and other internal notes out of
it.
