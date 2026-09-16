// src/bot/index.js — bot entry (forked by Electron main). THE COMPOSER.
//
// Startup: wait for the {type:'init', ...} message over MessagePort, build a
// ConfigSchema-conformant config, dynamic-import the GAME RUNTIME named by the
// init payload's `game` (src/bot/adapter/<game>/runtime.js), and start the
// brain against the adapter that runtime constructs. Lifecycle events
// (BotLifecycle vocabulary, src/shared/ipc.ts D-19) are posted back on the
// same port AND mirrored to stdout for the rolling log file.
//
// Game-adapters M0 (260908): this file is GAME-AGNOSTIC. Nothing under
// ./adapter/ is imported statically — the runtime is loaded by name, so a
// Stardew or Don't Starve session never loads mineflayer. The composer owns:
// config parse, the pack loader hook, brain start (through the runtime's
// createBrain hook), the returned handle, port dispatch, lifecycle and error
// emission. The runtime owns the body: connect, reconnect, adapter +
// telemetry per connection. Contract: RuntimeHooks / RuntimeHandle in
// src/bot/brain/types.js.
//
// (260722: the standalone `sei` CLI path was removed; the bot only runs as a
// utilityProcess now, so it never discovers the world itself — main hands the
// join target over per CONTEXT D-25 / Pitfall 6.)
//
// Sources:
//   - RESEARCH §Pattern 1 (bot side) — parentPort message flow
//   - CONTEXT D-15 (mineflayer ONLY in utilityProcess), D-18 (config over
//     MessagePortMain), D-19 (lifecycle vocabulary), D-25 (bot does NOT
//     re-discover LAN during summon — main hands the cached port over)

import { ConfigSchema, GAME_KINDS } from './config.js'
import { applyLlmInit } from './llmInit.js'
import { preparePackLoader } from './packLoader.js'
import { start as startBrain } from './brain/index.js'

const logger = {
  info:  (m) => console.log(`[sei] ${typeof m === 'string' ? m : JSON.stringify(m)}`),
  warn:  (m) => console.warn(`[sei] ${typeof m === 'string' ? m : JSON.stringify(m)}`),
  error: (m) => console.error(`[sei] ${typeof m === 'string' ? m : JSON.stringify(m)}`),
}

/**
 * Load a game runtime module by kind. Validated against GAME_KINDS so the
 * specifier can never be steered outside ./adapter/. Exported for tests.
 */
export async function loadRuntimeModule(kind) {
  if (!GAME_KINDS.includes(kind)) throw new Error(`unknown game kind: ${String(kind)}`)
  return import(`./adapter/${kind}/runtime.js`)
}

// ─── Core start() — config-in, handle-out ─────────────────────────────────
// The Electron path receives `config` over MessagePort; from here down it is
// load the runtime, let it connect, start the brain per connection.
//
// `hooks`:
//   onReady()            — the runtime reported its FIRST successful spawn
//                          (the Electron path emits `summon-ready`).
//   onError({error, message, retryAfterSeconds?})
//                        — the runtime hit a TERMINAL connect/disconnect
//                          failure, already classified to an ErrorClass.
//   onTerminalError(info)— the BRAIN halted (402 depleted, 429, …).
//   onAuthExpired()      — the brain saw a 401 expired JWT.
//   onDashboard(snapshot)— telemetry snapshots (straight up the port).
//   runtime              — an already-imported runtime module ({createRuntime});
//                          absent → loaded by config.adapter.kind. Tests pass a
//                          fake here to boot the composer without a game.
export async function start(config, hooks = {}) {
  const {
    onReady = () => {},
    onError = () => {},
    onTerminalError = null,
    onAuthExpired = null,
    onDashboard = null,
    // Game-adapters M2 (260908): a runtime that must tell MAIN something
    // outside the lifecycle vocabulary posts it here (the DST runtime reports
    // its loopback listener as {type:'dst-listen', port, token} so main's
    // watcher can hand the mod the address). Raw port message; null in tests.
    postPortMessage = null,
    runtime: runtimeModule = null,
  } = hooks
  const kind = config?.adapter?.kind ?? 'minecraft'
  const mod = runtimeModule ?? await loadRuntimeModule(kind)
  if (typeof mod?.createRuntime !== 'function') {
    throw new Error(`game runtime for "${kind}" exports no createRuntime()`)
  }

  // The brain currently wired to a live body. The runtime tells us when one
  // starts (onBrainReady) and when the body dies (onBrainLost); every port
  // forwarder below reads this pointer. src/bot/portForwarders.test.js pins
  // that each port-dispatched method has a `_brain?.X?.(` forwarder here.
  let _brain = null
  let _runtime = null
  const ownUsername = () => config?.adapter?.[kind]?.username ?? null

  // Game-agnostic brain start, handed to the runtime as createBrain so the
  // runtime can (re)start it per connection while the callbacks stay here.
  const createBrain = (adapter) => startBrain({
    config, adapter, logger, onTerminalError, onAuthExpired,
    // Task 4 — a reply to a message that came in over Sei chat (not in-game)
    // is routed back UP to the chat surface instead of spoken in-world.
    onSeiChatReply: (text) => emitLifecycle({ type: 'chat', from: config?.persona?.name ?? 'your companion', text }),
    // Party redesign §2/§5 — the orchestrator dispatched a world-acting tool
    // (name set) or drained back to idle (name null). Emit an `action`
    // lifecycle so main forwards it to the renderer's presence verb line.
    // Same emit path as onSeiChatReply; emitLifecycle guards the port (a CLI
    // run has no port and just logs). Non-throwing.
    onAction: (payload) => {
      // Dashboard telemetry (260721): the loop translates the current tool
      // into the activity line and emits on change.
      try { _runtime?.telemetry?.setAction(payload?.name ?? null, payload?.args) } catch {}
      try {
        emitLifecycle({ type: 'action', name: payload?.name ?? null, args: payload?.args })
      } catch {}
    },
    // Task 4 — the bot called quit(): leave the game the same graceful way a
    // main-initiated stop would (drain, disconnect, exit → supervisor reaps).
    onQuitRequested: () => { try { gracefulShutdown() } catch {} },
    // Voice calls (260705) — the bot called end_call(): ask main to hang up
    // the player's call (the bot stays in the game). The farewell say() was
    // already routed up before this fires, and the renderer drains its TTS
    // queue before tearing the call down.
    onCallEndRequested: () => emitLifecycle({ type: 'call-end' }),
  })

  _runtime = await mod.createRuntime(config, {
    logger,
    summonDeadlineAt: config?._seiSummonDeadlineAt ?? null,
    createBrain,
    onBrainReady: (brain) => {
      _brain = brain
      // 260618: apply any companion roster known before the brain was ready
      // (init payload, or a {type:'roster'} that arrived during connect / a
      // reconnect). config._seiCompanions is the cross-reconnect source of truth.
      try { _brain.setCompanions?.(config._seiCompanions ?? []) } catch {}
    },
    onBrainLost: () => { _brain = null },
    onConnected: () => {
      try { onReady() } catch (err) {
        logger.warn(`onReady hook threw: ${err && err.message}`)
      }
    },
    onDisconnected: (info) => {
      logger.info(`[sei] ${kind} body disconnected (${info?.reason ?? 'unknown'})${info?.willRetry ? ' — retrying' : ''}`)
    },
    onError: (info) => {
      try { onError(info) } catch (err) {
        logger.warn(`onError hook threw: ${err && err.message}`)
      }
    },
    onDashboard: typeof onDashboard === 'function' ? onDashboard : null,
    postPortMessage: typeof postPortMessage === 'function' ? postPortMessage : null,
    emitVisionCapability,
  })

  return {
    async stop() {
      try { await _runtime?.stop?.() } catch {}
      _brain = null
    },
    /**
     * Phase 13-15 (PROXY-07): push a refreshed Supabase JWT into the bot
     * brain's Anthropic SDK for cloud-proxy mode. No-op when cloudMode is
     * absent or the brain has not yet started. Called by the parentPort
     * {type:'jwt'} message handler when the supervisor forwards a
     * TOKEN_REFRESHED tick from jwtBridge.
     */
    setAuthToken(token) {
      try { _brain?.setAuthToken?.(token) } catch {}
    },
    /**
     * Task 4 (fix 260703): forward an in-app Sei chat message into the live
     * brain as a P1 chat event. This passthrough was MISSING — the parentPort
     * 'sei-chat' handler calls `_running?.deliverSeiChat?.(...)`, and with no
     * such method on this wrapper the optional chain silently no-op'd: every
     * in-app message to an in-game companion was dropped and the chat UI hung
     * on "typing…" forever. The brain method existed all along (brain/index.js
     * deliverSeiChat); it just was never reachable from the port.
     */
    deliverSeiChat(payload) {
      try { _brain?.deliverSeiChat?.(payload) } catch {}
    },
    /**
     * 260708: forward an observed group-call line (a sibling companion's
     * spoken line, or a player line routed to another bot) from the parentPort
     * {type:'sei-chat-observe'} handler into the live brain. Same missing-
     * passthrough trap as deliverSeiChat above: the brain method existed all
     * along, but without this forwarder `_running?.observeSeiChat?.()`
     * silently no-op'd — two in-game companions on a call were deaf to each
     * other's lines while their standalone transcripts recorded everything
     * (the ledger write and this mirror live on different sides of the port).
     * See src/bot/portForwarders.test.js, which pins every port-dispatched
     * method to a forwarder here.
     */
    observeSeiChat(payload) {
      try { _brain?.observeSeiChat?.(payload) } catch {}
    },
    /**
     * Voice-call mode (260705): forward the call-open/hang-up toggle from the
     * parentPort {type:'voice-call'} handler into the live brain. No-op until
     * the brain has started; the supervisor re-sends the current state on
     * summon-ready so a call opened before spawn still applies.
     */
    setVoiceCall(active) {
      try { _brain?.setVoiceCall?.(active) } catch {}
    },
    /**
     * 260725 play/pause: forward the in-app pause toggle from the parentPort
     * {type:'game-pause'} handler into the live brain (FSM hold + orchestrator
     * freeze). The renderer owns the paused DISPLAY state (it initiated it),
     * so the dashboard telemetry is not involved. No-op until the brain has
     * started.
     */
    setGamePaused(paused) {
      try { _brain?.setGamePaused?.(paused) } catch {}
    },
    /**
     * 260725 runtime game mode: forward the reactive/proactive toggle from the
     * parentPort {type:'game-mode'} handler. Never persisted — every summon
     * starts proactive (see the persona.proactiveness seed in rawConfig).
     */
    setGameMode(mode) {
      try { _brain?.setGameMode?.(mode === 'reactive' ? 'reactive' : 'proactive') } catch {}
    },
    /**
     * Voice calls (260705): the call pipeline just went live — prompt the brain
     * to greet the player first (like the spawn greeting, but into the call).
     */
    deliverVoiceCallGreeting() {
      try { _brain?.deliverVoiceCallGreeting?.() } catch {}
    },
    /**
     * 260618: update the roster of OTHER AI companions in this world. Called by
     * the parentPort {type:'roster'} handler whenever the supervisor summons or
     * stops a sibling bot. The runtime filters its own name out and records
     * the list where its body reads it (config._seiCompanions, for chat.js
     * which has no orchestrator handle); the brain gets the same list
     * (snapshot pin/label + companions seed block). No-op list for solo sessions.
     */
    setCompanions(names) {
      let list = null
      try { list = _runtime?.setCompanions?.(names) ?? null } catch {}
      if (!Array.isArray(list)) {
        list = Array.isArray(names)
          ? names.filter(n => typeof n === 'string' && n.trim() && n !== ownUsername())
          : []
        try { config._seiCompanions = list } catch {}
      }
      try { _brain?.setCompanions?.(list) } catch {}
    },
    /**
     * WR-05 follow-up: live-swap the AI backend (cloud-proxy ↔ BYOK) on the
     * running brain without a re-summon. Called by the parentPort
     * {type:'backend-switch'} handler when the supervisor flips
     * ai_backend_kind mid-session. No-op when cloudMode/BYOK is irrelevant or
     * the brain has not yet started. 260828: the local shape also carries the
     * `llm` provider section (see applyLlmSwitch in llmInit.js) so a
     * cloud→local switch lands on the CONFIGURED provider, not Anthropic.
     * @param {{cloudMode?:{baseURL:string,authToken:string}, api_key?:string, llm?:{provider:string,model?:string,base_url?:string,api_key?:string}}} backend
     */
    setBackend(backend) {
      try { _brain?.setBackend?.(backend) } catch {}
    },
    /**
     * Phase 15 (D-10/VIS-03): the active provider's vision capability boolean,
     * surfaced from the brain. The Electron path reads this to push a
     * `vision-capability` lifecycle message up the port so the renderer can
     * gate the Settings auto-render toggle (15-05). Fail-closed: false until a
     * VLM-backed brain reports true (or when the brain hasn't started).
     */
    visionCapable() {
      try { return _brain?.visionCapable?.() === true } catch { return false }
    },
    /**
     * Dashboard (260721): the renderer's visibility flag, forwarded from the
     * parentPort {type:'dashboard-watch'} handler. NOT a brain passthrough —
     * telemetry lives on the runtime side of the seam (portForwarders.test.js
     * exempts it). The runtime remembers the flag so a reconnect's fresh
     * telemetry instance resumes in the same state.
     */
    setDashboardWatch(active) {
      try { _runtime?.setDashboardWatch?.(active) } catch {}
    },
  }
}

// ─── Electron utilityProcess path ─────────────────────────────────────────
// When forked by main, wait for the init message on the transferred
// MessagePort, build a ConfigSchema-conformant config, and bootstrap.
// Lifecycle events go to BOTH parentPort (structured for status row) AND
// stdout (so logRouter sees them and tees to the rolling log file).

let initPort = null
let _running = null         // { stop } returned by start()

// 260618: reactive JWT recovery. The brain calls this (via onAuthExpired) when a
// cloud-proxy call returns 401 expired_jwt. We ask main for a fresh token; main
// (botSupervisor) handles {type:'request-jwt'} → getProxyJwt() → posts a
// cloud-jwt-update back → setAuthToken → the next call succeeds. Without this the
// bot just re-hammers the dead token every idle tick and freezes until stopped.
// Best-effort: a closed port (teardown) silently no-ops.
function requestJwtRefresh() {
  try { initPort?.postMessage({ type: 'request-jwt' }) } catch {}
}
let _shuttingDown = false   // re-entry guard for gracefulShutdown

function emitLifecycle(payload) {
  // payload conforms to BotLifecycle (src/shared/ipc.ts):
  //   {type:'init-ack'} | {type:'connected'} | {type:'disconnected', reason?}
  // | {type:'error', error:ErrorClass, message} | {type:'chat', from, text}
  // | {type:'summon-ready'} | {type:'summon-stopped'} | {type:'exit', code}
  if (initPort) {
    try { initPort.postMessage(payload) } catch {}
  }
  // Also log to stdout for the rolling log file (logRouter parses these tags)
  console.log(`[lifecycle] ${JSON.stringify(payload)}`)
}

/**
 * Init payload → {game, joinTarget, worldLabel, packRoot} (M0, 260908).
 *
 * New shape: `game` ('minecraft' | 'stardew' | 'dontstarve'), `joinTarget`
 * (game-specific; Minecraft `{port, motd, mc_username, skinServerBaseUrl}`),
 * optional `worldLabel`, optional `packRoot`. LEGACY (one release): a payload
 * with no `game` is a Minecraft summon from an older main and its top-level
 * `lanPort`/`lanMotd`/`mc_username`/`skinServerBaseUrl` are folded into the
 * Minecraft joinTarget. Exported for tests.
 */
export function resolveInitGame(initData) {
  const legacy = initData?.game == null
  const game = GAME_KINDS.includes(initData?.game) ? initData.game : 'minecraft'
  let joinTarget = initData?.joinTarget && typeof initData.joinTarget === 'object' ? initData.joinTarget : null
  if (!joinTarget && game === 'minecraft') {
    joinTarget = {
      port: initData?.lanPort ?? null,
      motd: initData?.lanMotd ?? null,
      mc_username: initData?.mc_username ?? '',
      skinServerBaseUrl: initData?.skinServerBaseUrl ?? null,
    }
  }
  const labelRaw = initData?.worldLabel ?? joinTarget?.motd ?? joinTarget?.label ?? (legacy ? initData?.lanMotd : null)
  const worldLabel = (typeof labelRaw === 'string' && labelRaw.trim()) ? labelRaw.trim() : null
  const packRoot = typeof initData?.packRoot === 'string' && initData.packRoot.trim() ? initData.packRoot : null
  return { game, joinTarget, worldLabel, packRoot, legacy }
}

async function bootstrapWithInit(initData) {
  const {
    character,
    apiKey,
    // 260801: epoch ms at which the supervisor's summon watchdog fires. Sized
    // by main so the connect guard below can report a specific failure a beat
    // BEFORE the generic one lands. Absent on older main → connect.js falls
    // back to its flat CONNECT_TIMEOUT_MS.
    summonDeadlineAt,    // number | undefined
    userDataDir,
    preferred_name,      // seeds player_username for player-recognition
    // Phase 13-15 (PROXY-07): when the user has selected `cloud-proxy` as
    // their AI backend (apiKeyStore.getAiBackendKind()), the supervisor ships
    // `{ baseURL, authToken }` here so the SDK routes through the Fly.io
    // proxy with Bearer auth instead of BYOK x-api-key. authToken is the
    // user's Supabase access_token; jwt rotation arrives via parentPort
    // {type:'jwt'} messages below.
    cloudMode,           // {baseURL, authToken} | undefined
    // 260816 (china-compat W2): the LLM provider selection, bridged by the
    // supervisor from UserConfig.provider + provider_config for LOCAL (BYOK)
    // sessions. {provider, model?, base_url?, api_key} | undefined. Mapped
    // onto config.llm by applyLlmInit below; absent (older main, or
    // cloud-proxy mode) → the Anthropic default path, unchanged.
    llm: llmInit,        // {provider, model?, base_url?, api_key?} | undefined
    // The user-facing Looking (vision) mode, bridged by the supervisor from
    // UserConfig.vision_mode. Maps into config.vision below; the remaining
    // vision knobs (cadence, image_quality, resolution_px, cap) come from the
    // bot ConfigSchema / orchestrator defaults.
    visionMode,           // 'off' | 'on-demand' | 'continuous' | undefined
    // Appearance & feel: the "Realistic typing" toggle, bridged by the
    // supervisor from UserConfig.realistic_typing. Maps into
    // config.realistic_typing below. undefined (older main / CLI) → default true.
    realisticTyping,      // boolean | undefined
    // 260709: conversation language, bridged by the supervisor from
    // UserConfig.chat_language. Maps into config.chat_language below (drives
    // the # LANGUAGE directive in the cached system prefix). undefined (older
    // main / CLI standalone) → ConfigSchema default 'en'.
    chatLanguage,         // 'en'|'zh'|'ja'|'ko'|'fr'|'es' | undefined
    // 260618: in-game usernames of the OTHER AI companions summoned into this
    // same world (multi-bot sessions). Seeds the roster so the bot knows its
    // teammates from the first tick; the supervisor re-broadcasts on every
    // summon/stop via a {type:'roster'} port message. Absent / [] for solo bots.
    companions,           // string[] | undefined
    // Phase 18/19: { summary, recent[] } from the in-app chat, so the companion
    // carries the app conversation into the world. null when there is no prior
    // chat. Stashed on config as _seiContinuity and injected by the orchestrator.
    continuity,           // { summary: string, recent: {role,text}[] } | null
    // 260725 Knowledge: user-provided reference text (capped + sanitized in
    // main by knowledgeStore). Stashed as config._seiKnowledge and appended to
    // the cached system prefix by the orchestrator. '' / undefined = none.
    knowledge,            // string | undefined
    // Voice calls (260707): true when spawning INTO an open call. Seeds the
    // orchestrator's voiceCallActive from the start so say() routes to the call
    // and the cold FIRST CONTACT greeting is skipped on the first tick (no race
    // with the post-spawn {type:'voice-call'} message). See orchestrator.js.
    voiceCallActive: initVoiceCallActive,   // boolean | undefined
    // 260909: web search settings bridged from UserConfig.web_search_* by
    // the supervisor: { provider, api_key } | undefined. Maps into config.web
    // below; absent (older main) -> keyless 'auto' chain.
    webSearch,            // { provider?: string, api_key?: string } | undefined
  } = initData

  // Game-adapters M0: which game, where to join, what to call the world.
  const { game, joinTarget, worldLabel, packRoot } = resolveInitGame(initData)
  // The in-game player username collected in onboarding (Minecraft: inside
  // the join target; legacy payloads carried it top-level).
  const mc_username = joinTarget?.mc_username ?? initData.mc_username

  // The game pack resolve hook must be in place BEFORE the runtime module is
  // resolved (src/bot/packLoader.js registers it; a no-op in dev, where the
  // pack root is the repo itself).
  await preparePackLoader(packRoot)
  let runtimeModule
  try {
    runtimeModule = await loadRuntimeModule(game)
  } catch (err) {
    emitLifecycle({
      type: 'error',
      error: 'BOT_CRASH',
      message: `Could not load the ${game} game runtime: ${String((err && err.message) || err)}`,
    })
    return
  }

  // Build a config shape that satisfies ConfigSchema.parse (see
  // src/bot/config.js — the adapter.<game> block comes from the runtime's
  // adapterConfigFrom; for Minecraft that is {host, auth, username, port,
  // version}). Username comes from the persona / character.username (NOT
  // from character.id — characters are personas, not game accounts).
  // player_username is seeded from preferred_name so the bot recognises the
  // human player from the first chat.
  //
  // Memory paths are explicit: player_md_path + memory_md_path. A
  // `memory.dir` wrapper is NOT part of ConfigSchema — passing one would
  // be silently stripped by Zod, leaving the defaults (./memory/...)
  // which EROFS in the read-only packaged Sei.app bundle.
  const memDir = `${userDataDir}/memory/${character.id}`
  // 260508-nkk root cause #1: the Electron path was constructing this object
  // and passing it directly to start(config). The CLI path runs config
  // through ConfigSchema.parse(...) which fills Zod defaults
  // (memory.seed_diary_budget_bytes=3072, memory.iteration_cap=30,
  // memory.spawn_settle_delay_ms=500, llm.rate_limit_per_min=30,
  // anthropic.timeout_ms=20000, etc). Without those, createDiary({...,
  // seedDiaryBudgetBytes: undefined}) throws synchronously inside
  // startBrain because its guard requires seedDiaryBudgetBytes >= 1.
  // The throw propagates up through `await start(config)` and the
  // outer catch below emits a BOT_CRASH lifecycle, but until 260508-nkk
  // the supervisor's summonResolved gate only triggered on summon-ready,
  // so the renderer could end up in an indefinite Connecting state
  // pending the full 30s outer timer. Run through ConfigSchema.parse so
  // every required default is populated from one source of truth.
  // The bot's in-game login name is game-specific (Minecraft: the persona's
  // character.username, else the persona name sanitized to MC's username
  // rules; see adapter/minecraft/runtime.js botUsernameFor). The runtime
  // owns the rule so a game with different naming constraints supplies its own.
  const bot_mc_username = typeof runtimeModule.botUsernameFor === 'function'
    ? runtimeModule.botUsernameFor(character)
    : String(character?.name || 'Sei')

  // player_username is a label/pin only — v1.0 single-human LAN no longer
  // gates owner-recognition on a username match (chat.js treats any non-bot
  // chatter as the player; sessionState adopts the first human it sees). We
  // still seed a sensible value: mc_username if present (legacy), else the
  // preferred_name, else 'Player'.
  const playerName = (typeof mc_username === 'string' && mc_username.trim())
    || (typeof preferred_name === 'string' && preferred_name.trim())
    || 'Player'

  // 260516-0yw: read the LLM-expanded persona prompt off character.persona.expanded.
  // The old character.persona_prompt / character.description fields have been
  // retired in favor of { source, expanded } per the new CharacterSchema. If
  // the migrated character has an empty expanded prompt, throw an explicit
  // error so the user knows to re-save in the GUI (no backwards-compat shim).
  if (!character.persona || typeof character.persona.expanded !== 'string' || character.persona.expanded.trim() === '') {
    emitLifecycle({
      type: 'error',
      error: 'BOT_CRASH',
      message: 'persona expansion missing — re-save the character in the GUI to populate persona.expanded',
    })
    return
  }
  // preferred_name is what the LLM should call the player. Empty falls back
  // to the MC username inside chat.js's substitution.
  const playerDisplayName = (typeof preferred_name === 'string' && preferred_name.trim()) || ''

  const rawConfig = {
    chat_mode: 'chat',  // default for v1; renderer can flip in a later phase
    // Appearance & feel: mirror the in-app "Realistic typing" toggle. Default
    // true when the supervisor didn't ship it (older main / CLI standalone).
    realistic_typing: realisticTyping !== false,
    // 260709: conversation language. Only spread a KNOWN code so junk from an
    // older/foreign supervisor falls to the ConfigSchema default ('en')
    // instead of failing the whole parse.
    ...(['en', 'zh', 'ja', 'ko', 'fr', 'es'].includes(chatLanguage)
      ? { chat_language: chatLanguage }
      : {}),
    player_username: playerName,
    player_display_name: playerDisplayName,
    // World label for the memory registry / section headers (Minecraft: the
    // LAN MOTD). null when absent so the adapter's getWorldIdentity() falls
    // back to its own label.
    world_label: worldLabel,
    persona: {
      // persona.name is the MC-safe sanitized name so the bot's in-chat
      // identity and login username always match.
      name: bot_mc_username,
      expanded: character.persona.expanded,
      // 260725: proactiveness is a RUNTIME mode, not a character trait. Any
      // legacy character.metadata.proactiveness is deliberately ignored.
      // Every summon starts at 2 (proactive: the bot plays alongside you);
      // the in-app MC controls flip it to 1 (reactive: acts only on your
      // instruction) live via the game-mode port message.
      proactiveness: 2,
      // Texting punctuation register off character.metadata (260705). Only the
      // exact 'deliberate' value opts out of the casual trailing-period strip;
      // anything else (missing, junk) falls to the ConfigSchema default
      // ('casual'). MIRROR: src/main/chat/chatService.ts clampPunctuation()
      // applies the same read for the chat surface — keep the two in sync.
      ...(character.metadata?.punctuation === 'deliberate' ? { punctuation: 'deliberate' } : {}),
      // 260730: per-character language pin (metadata.language, stamped at
      // creation under the Chinese UI). Only known codes pass; anything else
      // falls through to config.chat_language. MIRROR:
      // src/shared/chatLanguage.ts characterLanguage() for the main-process
      // surfaces — keep the two reads in sync.
      ...(['en', 'zh', 'ja', 'ko', 'fr', 'es'].includes(character.metadata?.language)
        ? { language: character.metadata.language }
        : {}),
    },
    // Phase 13-15: when cloudMode is provided, the SDK routes through the
    // proxy with Bearer auth (apiKey is unused — anthropicClient passes
    // apiKey:null to suppress the X-Api-Key header). Otherwise the legacy
    // BYOK path is preserved (D-57).
    anthropic: cloudMode
      ? { api_key: '', cloudMode: { baseURL: cloudMode.baseURL, authToken: cloudMode.authToken } }
      : { api_key: apiKey },
    // The game's adapter block, built by its runtime from the join target
    // (Minecraft: loopback host, offline auth, version 'auto' → resolved by a
    // status ping in the runtime).
    adapter: {
      kind: game,
      [game]: typeof runtimeModule.adapterConfigFrom === 'function'
        ? runtimeModule.adapterConfigFrom({ joinTarget, botUsername: bot_mc_username, character })
        : {},
    },
    memory: {
      player_md_path: `${memDir}/PLAYER.md`,
      memory_md_path: `${memDir}/MEMORY.md`,
      // Goals are per GAME (260909): the first DST summon read the character's
      // Minecraft goals ("reach stone pickaxe tier") out of HEARTBEAT.md and
      // was told to pursue them in the Constant. Minecraft keeps the bare name
      // so existing installs keep their goals; other games get a suffixed file.
      heartbeat_md_path: game === 'minecraft' ? `${memDir}/HEARTBEAT.md` : `${memDir}/HEARTBEAT.${game}.md`,
      worlds_json_path: `${memDir}/worlds.json`,
    },
    // Bridge the vision tier + cadence into config.vision. Every other vision
    // field (image_quality, resolution_px ≤512 cap) is
    // filled by the ConfigSchema vision defaults. The `.default({})` on the
    // vision block means omitting it entirely is also valid; absent init
    // fields fall to the schema defaults via the conditional spread.
    vision: {
      ...(visionMode != null ? { mode: visionMode } : {}),
    },
    web: {
      ...(webSearch?.provider ? { provider: webSearch.provider } : {}),
      ...(typeof webSearch?.api_key === 'string' ? { api_key: webSearch.api_key } : {}),
    },
    // llm: applied by applyLlmInit below (260816). When main ships no llm
    // section (older main / cloud-proxy) the Zod default fills the entire {}
    // sub-tree and the bot runs Anthropic, exactly as before.
  }
  let config
  try {
    config = ConfigSchema.parse(applyLlmInit(rawConfig, llmInit, apiKey))
  } catch (err) {
    emitLifecycle({
      type: 'error',
      error: 'BOT_CRASH',
      message: `Config validation failed: ${String((err && err.message) || err)}`,
    })
    return
  }

  // 260618: stash the initial companion roster on the (mutable) parsed config
  // so chat.js — which runs without an orchestrator handle — can read it to skip
  // interrupts aimed at a sibling. Re-applied to the brain after it starts, and
  // updated live via the {type:'roster'} port message.
  try {
    config._seiCompanions = Array.isArray(companions)
      ? companions.filter(c => typeof c === 'string' && c.trim() && c !== bot_mc_username)
      : []
  } catch {}

  // Phase 18/19: stash the in-app chat continuity ({summary, recent}) so the
  // orchestrator can inject it as an early cached seed block. Best-effort.
  try {
    config._seiContinuity =
      continuity && typeof continuity === 'object' ? continuity : null
  } catch {}

  // 260725 Knowledge: stash the user-provided reference text so the
  // orchestrator can append it to the cached system prefix. Best-effort.
  try {
    config._seiKnowledge = typeof knowledge === 'string' ? knowledge : ''
  } catch {}

  // 260801: the supervisor's watchdog deadline, read by connect.js to size its
  // connect guard so a stalled join names its own cause. Stashed post-parse
  // like _seiKnowledge — ConfigSchema strips unknown keys.
  try {
    config._seiSummonDeadlineAt =
      Number.isFinite(summonDeadlineAt) ? Number(summonDeadlineAt) : null
  } catch {}

  // Voice calls (260707): stash whether this bot is spawning into an open call
  // so the orchestrator seeds voiceCallActive true from its first tick (say()
  // routes to the call; the cold FIRST CONTACT greeting is skipped). Read in
  // createOrchestrator. Best-effort.
  try {
    config._seiVoiceCallActive = initVoiceCallActive === true
  } catch {}

  emitLifecycle({ type: 'init-ack' })

  // Trust main's handover — it owns the per-game watcher and revalidates
  // freshness itself. The bot never re-discovers the world (Pitfall 6,
  // CONTEXT D-25); this is only the bot-side backstop for a payload with
  // nothing to join (Minecraft: LAN_NOT_OPEN, same message as before).
  const missing = typeof runtimeModule.checkJoinTarget === 'function'
    ? runtimeModule.checkJoinTarget(joinTarget)
    : null
  if (missing) {
    emitLifecycle({ type: 'error', error: missing.error ?? 'BOT_CRASH', message: missing.message ?? 'Nothing to join.' })
    return
  }
  logger.info(
    `${game} join target ${JSON.stringify(joinTarget ?? null)}, starting "${character.name}" ` +
    `(username=${bot_mc_username}, player=${config.player_username})`,
  )
  // Log the skin-server URL so a developer running `npm run dev` can
  // confirm the supervisor → bot init handover. The bot
  // never fetches from this URL (CustomSkinLoader on the host's MC client is
  // the actual consumer); this line exists purely for verification.
  if (joinTarget?.skinServerBaseUrl) {
    logger.info(`[sei] skin server URL handed to bot: ${joinTarget.skinServerBaseUrl}`)
  }

  // 260508-nkk root cause #2: previously `summon-ready` fired immediately
  // after `await start(config)` resolved, but start() resolves once
  // bringUp+startBrain have wired up — BEFORE mineflayer's TCP handshake
  // and 'spawn' event. The status flip "Connecting → Online" therefore
  // had no relationship to the bot actually being in the world. Move the
  // emit into the onReady hook so it fires off mineflayer's first spawn.
  // start() rejecting still surfaces as a BOT_CRASH lifecycle below.
  let _running_local = null
  try {
    _running_local = await start(config, {
      runtime: runtimeModule,
      onReady: () => {
        emitLifecycle({ type: 'summon-ready' })
      },
      // 260618: reactive JWT recovery — bot → main "send me a fresh token".
      onAuthExpired: requestJwtRefresh,
      // Dashboard telemetry (260721): snapshots go straight up the port.
      // Deliberately NOT emitLifecycle — its stdout mirror would spam the
      // rolling log with a ~1.5KB base64 minimap every 2s.
      onDashboard: (snapshot) => {
        try { initPort?.postMessage({ type: 'dashboard', snapshot }) } catch {}
      },
      // Game-adapters M2: raw port messages a runtime needs main to see
      // (the DST runtime's {type:'dst-listen', port, token}). Not a
      // lifecycle event; the supervisor routes it before lifecycleToStatus.
      postPortMessage: (payload) => {
        try { initPort?.postMessage(payload) } catch {}
        // Type only: the DST message carries a per-summon token that must
        // not land in the rolling log file.
        console.log(`[lifecycle] ${JSON.stringify({ type: payload?.type ?? 'port-message' })}`)
      },
      // A TERMINAL connect/disconnect failure, classified by the game runtime
      // (contract v2 classifyConnectError) to the class whose ERROR_COPY gives
      // the user the right next step.
      onError: (info) => {
        const message = String(info?.message ?? '')
        emitLifecycle({
          type: 'error',
          error: info?.error ?? 'BOT_START_TIMEOUT',
          message,
          ...(info?.retryAfterSeconds != null ? { retryAfterSeconds: info.retryAfterSeconds } : {}),
        })
        // The bot can't recover on its own (initial connect exhausted, a live
        // session dropped, or spawn stalled). Run the same graceful shutdown
        // the supervisor's stop signal would, so the utilityProcess exits, the
        // brain dies with it (no orphaned idle-tick Anthropic burn / phantom
        // chat), and the supervisor stops treating the row as live. Mirrors
        // onTerminalError; the 150ms delay lets the error lifecycle flush to
        // the renderer first.
        setTimeout(() => { gracefulShutdown().catch(() => {}) }, 150)
      },
      // Phase 13: the brain calls this when the cloud proxy returns 402 and
      // the orchestrator latches into halted mode. Surface the depleted
      // banner to the renderer, then run the same graceful-shutdown path the
      // supervisor's stop signal would (brain.stop + bot.quit + lifecycle
      // 'summon-stopped' + process.exit). Idempotent re-entry guard inside
      // gracefulShutdown handles the case where the supervisor's stop
      // arrives concurrently.
      onTerminalError: (info) => {
        emitLifecycle({
          type: 'error',
          error: info?.error ?? 'BOT_CRASH',
          message: info?.message ?? 'Bot halted.',
          // Forwarded for DAILY_LIMIT_REACHED so the supervisor can persist the
          // reset window and the GUI can show "come back after X".
          retryAfterSeconds: info?.retryAfterSeconds,
        })
        setTimeout(() => { gracefulShutdown().catch(() => {}) }, 150)
      },
    })
    _running = _running_local
    // Phase 15 (D-10/VIS-03): once start() resolves the brain is fully wired
    // (bringUp → startBrain assigned _brain), so the active provider's vision
    // capability is now readable. Push it up the port → main → renderer so the
    // Settings auto-render toggle (15-05) gates its disabled state on a REAL
    // signal instead of inferring from ai_backend_kind. A later backend switch
    // re-emits via the parentPort 'backend-switch' handler below.
    emitVisionCapability()
  } catch (err) {
    emitLifecycle({
      type: 'error',
      error: 'BOT_CRASH',
      message: String((err && err.message) || err),
    })
  }
}

/**
 * Phase 15 (D-10/VIS-03): read the active provider's vision capability off the
 * running brain and push a `{type:'vision-capability', visionCapable}` message
 * up the port. The supervisor routes it to main → renderer (useUiStore). Fails
 * closed (visionCapable:false) when the brain hasn't started or can't report.
 * Idempotent — safe to call on summon-ready and again on a backend switch.
 */
function emitVisionCapability() {
  let visionCapable = false
  try { visionCapable = _running?.visionCapable?.() === true } catch { visionCapable = false }
  if (initPort) {
    try { initPort.postMessage({ type: 'vision-capability', visionCapable }) } catch {}
  }
  // Mirror to stdout for log-file visibility (parity with emitLifecycle).
  console.log(`[lifecycle] ${JSON.stringify({ type: 'vision-capability', visionCapable })}`)
}

async function gracefulShutdown() {
  // Re-entry guard. Both the bot's own onTerminalError and the supervisor's
  // {type:'stop'} can drive shutdown concurrently (the daily-limit / depleted
  // backstop in botSupervisor.ts now actively drains the session on the same
  // error the bot self-latches on). Without this, stop() runs twice and two
  // process.exit timers race; the doc comment on onTerminalError long claimed
  // this guard existed — now it actually does.
  if (_shuttingDown) return
  _shuttingDown = true
  // Hard deadline: the avatar must LEAVE the world. _running.stop() awaits
  // brain.stop() → adapter.closeAnySessions(), any of which could stall (a
  // hung container-close ack, a wedged pathfinder). If stop() never resolves
  // the process would stay alive and socket-connected and the avatar would
  // freeze in-game — exactly the trial-rate-limit symptom. So race stop()
  // against a timeout and exit unconditionally either way: process death
  // closes the socket and the server reaps the player.
  const STOP_DEADLINE_MS = 3_000
  try {
    if (_running && typeof _running.stop === 'function') {
      await Promise.race([
        Promise.resolve(_running.stop()).catch(() => {}),
        new Promise((r) => setTimeout(r, STOP_DEADLINE_MS)),
      ])
    }
  } catch {}
  emitLifecycle({ type: 'summon-stopped' })
  // Give the lifecycle message a tick to flush before exiting
  setTimeout(() => process.exit(0), 100)
}

if (process.parentPort) {
  // Electron forked path. The supervisor only reports useful diagnostics if
  // (a) errors reach stderr (mirrored to the parent's terminal as of
  // 260508-mun) and (b) the lifecycle 'error' message reaches port1 BEFORE
  // we exit. Catch synchronous throws inside the message handler and grace
  // the process exit so the parent's stderr sink + lifecycle message both
  // flush. Also install last-resort unhandled-rejection / uncaught-exception
  // hooks for the same reason — surface the trace, then exit cleanly.
  const surfaceCrash = (label, err) => {
    const stack = (err && err.stack) || String(err)
    // Write to BOTH stderr (so the supervisor's tail buffer captures it)
    // and the lifecycle channel (so the renderer's Banner shows ErrorClass
    // copy instead of the raw "exited before summon-ready" string).
    console.error(`[sei-bot ${label}] ${stack}`)
    try {
      emitLifecycle({
        type: 'error',
        error: 'BOT_CRASH',
        message: `${label}: ${stack.split('\n')[0]}`,
      })
    } catch {}
    // 50ms grace so the lifecycle postMessage and stderr buffers can flush
    // before the utilityProcess tears down.
    setTimeout(() => process.exit(1), 50)
  }

  process.on('uncaughtException', (err) => surfaceCrash('uncaughtException', err))
  process.on('unhandledRejection', (err) => surfaceCrash('unhandledRejection', err))

  process.parentPort.once('message', (msg) => {
    try {
      const ports = msg.ports || []
      if (!ports.length) {
        // A first message with no transferred MessagePort means the init
        // handshake is broken (or something else beat init onto parentPort).
        // This used to `return` silently — the once() listener was consumed,
        // the event loop drained, and the bot exited code 0 with zero output
        // (the 260702 "stuck connecting" symptom). Surface it loudly instead.
        surfaceCrash(
          'parentPort.message',
          new Error('first parentPort message carried no MessagePort — expected the init handshake with [port2]'),
        )
        return
      }
      initPort = ports[0]
      initPort.start()
      // Future commands from main (e.g. {type:'stop'} during graceful
      // shutdown — supervisor sends this via port1.postMessage) arrive here.
      initPort.on('message', (e) => {
        try {
          const data = (e && e.data !== undefined) ? e.data : e
          if (data && data.type === 'stop') {
            gracefulShutdown()
          } else if (data && data.type === 'sei-chat') {
            // Task 4: the player messaged this bot through Sei chat while it is
            // in-game. Inject it into the brain as an out-of-band chat event so
            // it runs on the SAME session (brain + prompt cache) and replies
            // back to the chat surface (see onSeiChatReply above).
            try { _running?.deliverSeiChat?.({ from: data.from, text: data.text, voice: data.voice === true }) } catch {}
          } else if (data && data.type === 'sei-chat-observe') {
            // 260708: a group-call line this bot HEARD but is not the routed
            // recipient of (a sibling companion spoke, or the player line went
            // to another bot). Recorded as context; wakes only on a by-name
            // companion request (see brain observeSeiChat).
            try { _running?.observeSeiChat?.({ from: data.from, text: data.text }) } catch {}
          } else if (data && data.type === 'voice-call') {
            // Voice-call mode (260705): the player opened (active:true) or hung
            // up (active:false) a voice call with this companion. While active,
            // say() lines route up to the chat surface (→ TTS in the renderer)
            // and in-game chat stays silent; each turn carries the voice-call
            // primer at the start of its prompt.
            try { _running?.setVoiceCall?.(data.active === true) } catch {}
          } else if (data && data.type === 'dashboard-watch') {
            // Minecraft dashboard (260721): the renderer's dashboard surface
            // went visible (active:true) or hidden (active:false). While
            // visible the telemetry loop samples the minimap and posts
            // {type:'dashboard'} snapshots back up this port.
            try { _running?.setDashboardWatch?.(data.active === true) } catch {}
          } else if (data && data.type === 'voice-call-greet') {
            // Voice calls (260705): the renderer's call pipeline just went live
            // — ask the brain to speak first (say() routes into the call).
            try { _running?.deliverVoiceCallGreeting?.() } catch {}
          } else if (data && data.type === 'game-pause') {
            // 260725: in-app play/pause button. paused:true freezes the brain
            // (FSM hold + abort of live work); paused:false resumes with the
            // "player just unpaused your game" tick.
            try { _running?.setGamePaused?.(data.paused === true) } catch {}
          } else if (data && data.type === 'game-mode') {
            // 260725: runtime reactive/proactive mode. Never persisted; every
            // summon starts proactive.
            try { _running?.setGameMode?.(data.mode) } catch {}
          } else if (data && data.type === 'roster') {
            // 260618: the supervisor's roster of OTHER AI companions in this
            // world changed (a sibling bot was summoned or stopped). Apply it so
            // the bot's snapshot, seed block, and chat filter stay current.
            try { _running?.setCompanions?.(Array.isArray(data.companions) ? data.companions : []) } catch {}
          } else if (data && data.type === 'jwt') {
            // Phase 13-15 (PROXY-07): forward the refreshed Supabase JWT into
            // the live Anthropic SDK. No-op if cloudMode is not active or the
            // brain has not yet started. The supervisor sends this on every
            // TOKEN_REFRESHED / SIGNED_IN tick from jwtBridge.
            try { _running?.setAuthToken?.(data.jwt) } catch {}
          } else if (data && data.kind === 'cloud-jwt-update' && typeof data.jwt === 'string') {
            // Phase 13-14 (PROXY-08): cloud-proxy bearer JWT rotation.
            // setupJwtRotation in src/main/auth/proxyJwtFetcher.ts posts this
            // every 30 min (well before the 1h Supabase JWT expiry) so the
            // bot's brain/anthropicClient.js sees a fresh token on its next
            // call. Distinct from Phase 10's data.type === 'jwt' channel
            // (Supabase user JWT for IPC) so the two never alias.
            //
            // BL-02 (Phase 13 REVIEW): we previously wrote
            // `process.env.CLOUD_PROXY_JWT = data.jwt`, but
            //   (a) no module reads CLOUD_PROXY_JWT — the Anthropic SDK reads
            //       its env via ANTHROPIC_AUTH_TOKEN at construction only, and
            //   (b) env-var writes do not propagate to a live SDK instance;
            //       the mutable surface is `sdk.authToken` (see
            //       anthropicClient.js:26-37). Forward to the same setter as
            //       the data.type === 'jwt' branch so rotation actually
            //       reaches the live SDK.
            try { _running?.setAuthToken?.(data.jwt) } catch {}
          } else if (data && data.type === 'backend-switch') {
            // WR-05 follow-up: the user flipped cloud ↔ local in Settings
            // while the bot is running. The supervisor ships the new routing
            // descriptor (cloudMode for proxy; apiKey + llm section for BYOK)
            // and the live provider is rebuilt in place — no stop+re-summon.
            // Previously this required a manual restart (the "Restart your
            // bot" banner).
            //
            // 260828: the local descriptor now carries the SAME `llm` section
            // the summon init payload does ({provider, model?, base_url?,
            // api_key} from src/main/llmInitSection.ts). Without it, a
            // cloud→local switch left the brain on Anthropic with stale
            // defaults regardless of the configured provider. The brain folds
            // it in via applyLlmSwitch (src/bot/llmInit.js) and rebuilds its
            // provider instance when the kind changes. Absent llm (older
            // main) falls back to the historical anthropic BYOK path.
            try {
              _running?.setBackend?.(
                data.cloudMode
                  ? { cloudMode: { baseURL: data.cloudMode.baseURL, authToken: data.cloudMode.authToken } }
                  : {
                      api_key: typeof data.apiKey === 'string' ? data.apiKey : '',
                      ...(data.llm && typeof data.llm === 'object' ? { llm: data.llm } : {}),
                    },
              )
              // Phase 15 (D-10/VIS-03): a cloud↔local switch can change the
              // active provider's vision capability — re-emit so the renderer's
              // Settings auto-render toggle (15-05) updates its disabled state.
              emitVisionCapability()
            } catch {}
          }
        } catch (err) {
          surfaceCrash('initPort.message', err)
        }
      })
      // 260508-nkk root cause: the init payload was delivered alongside the
      // port transfer in THIS parentPort message (supervisor calls
      // `child.postMessage({type:'init', ...}, [port2])` — Electron carries
      // both `data` and the transferList in the same MessageEvent). The bot
      // previously ignored msg.data and waited for an 'init' message on
      // initPort that main never sent, so bootstrapWithInit never ran. The
      // bot loaded its modules, sat idle, and the supervisor's 30s outer
      // timer fired. Read the init data directly.
      const data = msg.data
      if (data && data.type === 'init') {
        bootstrapWithInit(data).catch((err) => surfaceCrash('bootstrapWithInit', err))
      } else {
        // The one-shot listener just consumed a non-init message: bootstrap can
        // never run and the process would otherwise exit 0 in total silence.
        // Only init is ever posted on parentPort (everything else rides the
        // transferred port), so this is always a handshake bug — say so.
        surfaceCrash(
          'parentPort.message',
          new Error(`first parentPort message was not init (type=${data && data.type}) — bootstrap cannot run`),
        )
      }
    } catch (err) {
      surfaceCrash('parentPort.message', err)
    }
  })
}

// (260722: the standalone CLI path that lived here — discoverLanPort +
// loadConfig('./config.json') behind a !process.parentPort guard — was
// removed. The bot only starts as an Electron utilityProcess.)
