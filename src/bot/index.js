// src/bot/index.js — bot entry, dual-mode.
//
// Two startup paths:
//   1. Forked by Electron main (process.parentPort exists)
//      → wait for {type:'init', character, apiKey, lanPort, userDataDir,
//        mc_username, preferred_name} message over MessagePort, build a
//        ConfigSchema-conformant config, and start the bot. Lifecycle events
//        (BotLifecycle vocabulary, src/shared/ipc.ts D-19) are posted back
//        on the same port AND mirrored to stdout for the rolling log file.
//   2. Run directly by CLI (`node src/bot/index.js`) — process.parentPort
//      is undefined → existing behavior preserved: discover LAN, loadConfig
//      from ./config.json, start the bot.
//
// Sources:
//   - RESEARCH §Pattern 1 (bot side) — parentPort message flow
//   - CONTEXT D-15 (mineflayer ONLY in utilityProcess), D-18 (config over
//     MessagePortMain), D-19 (lifecycle vocabulary), D-25 (bot does NOT
//     re-discover LAN during summon — main hands the cached port over)
//   - Pitfall 6 (bot must NOT call discoverLanPort during summon) — the
//     legacy CLI bootstrap is gated behind `!process.parentPort` so the
//     Electron path never reaches the discovery call.

import { loadConfig, ConfigSchema } from './config.js'
import { discoverLanPort } from './adapter/minecraft/lanDiscovery.js'  // CLI path only
import { createBotInstance } from './adapter/minecraft/connect.js'

// Default Minecraft Java protocol version for the Electron path. mineflayer's
// auto-detection (the value it would otherwise use when `version` is omitted)
// has been observed to produce protocol-handshake kicks against modern LAN
// worlds — symptom: bot.on('kicked') fires before spawn with a reason whose
// raw text was masked by humanizeReason as "Could not reach server". Pinning
// to a known-supported version matches the working CLI path's config.json
// (`minecraft_version: "1.21.1"`) and side-steps the auto-detect failure.
// When the user upgrades their Minecraft client past mineflayer's supported
// range this becomes a real onboarding setting; until then, '1.21.1' is the
// stable default that matches the predominant LAN client today.
const DEFAULT_MC_VERSION = '1.21.1'
import { createMinecraftAdapter } from './adapter/minecraft/index.js'
import { start as startBrain } from './brain/index.js'

const logger = {
  info:  (m) => console.log(`[sei] ${typeof m === 'string' ? m : JSON.stringify(m)}`),
  warn:  (m) => console.warn(`[sei] ${typeof m === 'string' ? m : JSON.stringify(m)}`),
  error: (m) => console.error(`[sei] ${typeof m === 'string' ? m : JSON.stringify(m)}`),
}

// ─── Core start() — config-in, {stop}-out ─────────────────────────────────
// Refactored from the prior CLI-internal helper so both startup paths share
// one entrypoint: the CLI builds `config` via loadConfig+discoverLanPort, the
// Electron path receives `config` over MessagePort. Behavior is identical
// from this function down — connect, attach adapter, start brain.
//
// 260508-nkk: an optional `hooks` arg lets callers receive (a) `onReady()`
// when mineflayer's actual `'spawn'` event fires (NOT just when bringUp
// returns — bringUp resolves before mineflayer connects), and (b)
// `onConnectError(err)` when the connect-level wall-clock timeout in
// connect.js trips because spawn never fired. The Electron path uses these
// to emit `summon-ready` / `error` lifecycle messages that reflect the bot's
// actual world state rather than just "brain initialized."
export async function start(config, hooks = {}) {
  const { onReady = () => {}, onConnectError = () => {}, onTerminalError = null } = hooks
  const mc = config.adapter.minecraft

  let _brain = null
  let _bot = null
  let _adapter = null
  let _stopped = false
  let _reconnectTimer = null
  // 260508-nkk: only forward the FIRST spawn → onReady; subsequent
  // reconnect-spawns are normal recovery and must not duplicate
  // summon-ready (the supervisor already gates on summonResolved, but
  // belt-and-suspenders).
  let _readyFired = false
  // 260508-nkk follow-up: cap reconnects so a stale/wrong LAN port stops
  // hammering the server (and racking up Anthropic calls from each new
  // brain spawned by bringUp). Reset on first successful spawn.
  const MAX_RECONNECT_ATTEMPTS = 3
  let _reconnectAttempts = 0

  const bringUp = async () => {
    _bot = createBotInstance({
      host: mc.host,
      port: mc.port,
      auth: mc.auth,
      username: mc.username,
      version: mc.version,
      config,
      logger,
      onSpawn: () => {
        // brain wires session start via adapter.attach onSpawn; this hook is
        // for the surrounding lifecycle (summon-ready emit). 260508-nkk: was
        // a no-op; now fires onReady the first time mineflayer's spawn event
        // lands so the supervisor's "Connecting…" → "Online" flip happens at
        // the right moment.
        if (_readyFired) return
        _readyFired = true
        // 260508-nkk follow-up: a successful spawn means the server is
        // reachable; reset the reconnect counter so future drops don't
        // count against the original cap.
        _reconnectAttempts = 0
        try { onReady() } catch (err) {
          logger.warn(`onReady hook threw: ${err && err.message}`)
        }
      },
      onEnd: (humanizedReason) => {
        if (_stopped) return
        // Tear down adapter listeners before discarding the bot reference.
        // Otherwise the OLD bot's listeners only become
        // GC-eligible when the closure releases, leaving a window where the
        // adapter still has dangling listeners on a dead mineflayer instance.
        try { _adapter?.detach?.() } catch {}
        _adapter = null
        _bot = null
        clearTimeout(_reconnectTimer)

        // POST-SPAWN drop: the bot was in the world and the socket closed. On a
        // localhost LAN that almost always means the player closed the world /
        // quit Minecraft. The previous code reconnected here, but two bugs made
        // that path actively harmful:
        //   1. The `_reconnectAttempts = 0` reset below was gated on
        //      `_readyFired`, so the counter was wiped to 0 on EVERY post-spawn
        //      drop and then bumped to 1 — it never exceeded the cap. The bot
        //      reconnected FOREVER (the field log showed a perpetual
        //      "attempt 1/3"), so it never surfaced a terminal error and the
        //      supervisor never learned the session ended → the GUI stayed
        //      "online" until the user force-stopped it.
        //   2. The brain from the dead session was never stopped. Its
        //      orchestrator loop kept running on a detached adapter — firing
        //      idle-tick Anthropic calls and emitting [chat->] lines the player
        //      never saw (phantom chat into a closed socket).
        // Treat a post-spawn drop as terminal instead: surface a LAN_NOT_OPEN
        // error and shut the process down cleanly (onConnectError →
        // gracefulShutdown stops the brain, quits the bot, and exits). The user
        // re-summons from the GUI in one click.
        if (_readyFired) {
          _stopped = true
          logger.info(
            `[sei] Lost connection to the LAN world (${humanizedReason}) — stopping. ` +
            `Re-open the world to LAN and click Summon again.`,
          )
          try {
            onConnectError(new Error(
              `LAN_NOT_OPEN: Lost connection to the LAN world (${humanizedReason}). ` +
              `Re-open the world to LAN in Minecraft and click Summon again.`,
            ))
          } catch (cbErr) {
            logger.warn(`onConnectError hook threw: ${cbErr && cbErr.message}`)
          }
          return
        }

        // PRE-SPAWN: never reached the world yet (stale/wrong LAN port, or a
        // world that isn't actually open). Bounded reconnect — the counter is
        // correct here because _readyFired is false, so a wrong port gives up
        // after MAX_RECONNECT_ATTEMPTS instead of hammering the server and
        // spawning a fresh brain (+greeting Anthropic call) on every retry.
        _reconnectAttempts += 1
        if (_reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
          _stopped = true
          logger.error(
            `[sei] Giving up after ${MAX_RECONNECT_ATTEMPTS} failed connect attempts ` +
            `(${humanizedReason}). Re-open LAN in Minecraft and click Summon again.`,
          )
          try {
            onConnectError(new Error(
              `LAN_NOT_OPEN: Could not reach the LAN world after ${MAX_RECONNECT_ATTEMPTS} attempts ` +
              `(${humanizedReason}). Re-open the world to LAN in Minecraft and click Summon again.`,
            ))
          } catch (cbErr) {
            logger.warn(`onConnectError hook threw: ${cbErr && cbErr.message}`)
          }
          return
        }
        logger.info(
          `Reconnecting in ${mc.reconnect_delay_ms}ms ` +
          `(attempt ${_reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}, ${humanizedReason})...`,
        )
        _reconnectTimer = setTimeout(() => {
          if (_stopped) return
          logger.info('Attempting reconnect...')
          bringUp().catch(err => logger.error(`Reconnect failed: ${err.message}`))
        }, mc.reconnect_delay_ms)
      },
      onError: (err) => logger.warn(`Connection error: ${err && err.message}`),
      // 260508-nkk: connect.js's wall-clock connect timeout fires this when
      // mineflayer's 'spawn' never lands within CONNECT_TIMEOUT_MS. Surface
      // up so the supervisor sees a structured BOT_START_TIMEOUT lifecycle
      // error instead of waiting the full 30s outer summon timer with no
      // diagnostic signal. Per CLAUDE.md "every external call has a timeout".
      onConnectTimeout: (err) => {
        if (_readyFired || _stopped) return
        try { onConnectError(err) } catch (cbErr) {
          logger.warn(`onConnectError hook threw: ${cbErr && cbErr.message}`)
        }
      },
    })

    _adapter = createMinecraftAdapter({ bot: _bot, config })
    // Keep the brain local until we've confirmed the connection survived the
    // startBrain await. onEnd (a fast-failing reconnect, or the user closing
    // the world) can fire DURING this await — it nulls _bot and _adapter. If
    // we assigned _brain unconditionally and then touched _bot._sei_startChat,
    // we hit "Cannot read properties of null (reading '_sei_startChat')" on
    // every dropped reconnect (observed in the field log).
    const brain = await startBrain({ config, adapter: _adapter, logger, onTerminalError })
    if (_stopped || !_bot) {
      // The connection dropped (or we were stopped) while startBrain awaited.
      // This brain is already orphaned — tear it down instead of wiring chat
      // onto a dead/null bot. Any reconnect was already scheduled by onEnd.
      try { await brain.stop() } catch {}
      return
    }
    _brain = brain

    // Wire the legacy chat behavior (bot.on('chat') with player/addressed/
    // nearby filtering and sei:chat_received emission) without an
    // orchestrator handle. fsmWires translates sei:chat_received into
    // brain.onChat; the brain priority queue handles player-chat preemption
    // (P1→P0 escalation when a non-P0 action is in flight). Stop-verb
    // fast-path body-cancel was previously a synchronous side-effect of
    // chat.js when given an orchestrator; with the brain↔adapter seam,
    // that fast path runs through the normal queue (one extra Haiku
    // round-trip on "stop").
    try { _bot._sei_startChat?.(null) } catch (err) {
      logger.warn(`startChat hookup failed: ${err && err.message}`)
    }
  }

  await bringUp()

  return {
    async stop() {
      _stopped = true
      clearTimeout(_reconnectTimer)
      if (_brain) {
        try { await _brain.stop() } catch {}
      }
      // Same teardown as onEnd to guarantee clean listener disposal on
      // graceful shutdown, not just on reconnect.
      try { _adapter?.detach?.() } catch {}
      _adapter = null
      if (_bot) {
        try { _bot.quit('Sei stopping') } catch {}
        _bot = null
      }
      logger.info('Bot stopped.')
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
     * WR-05 follow-up: live-swap the AI backend (cloud-proxy ↔ BYOK) on the
     * running brain without a re-summon. Called by the parentPort
     * {type:'backend-switch'} handler when the supervisor flips
     * ai_backend_kind mid-session. No-op when cloudMode/BYOK is irrelevant or
     * the brain has not yet started.
     * @param {{cloudMode?:{baseURL:string,authToken:string}, api_key?:string}} backend
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
  }
}

// ─── Electron utilityProcess path ─────────────────────────────────────────
// When forked by main, wait for the init message on the transferred
// MessagePort, build a ConfigSchema-conformant config, and bootstrap.
// Lifecycle events go to BOTH parentPort (structured for status row) AND
// stdout (so logRouter sees them and tees to the rolling log file).

let initPort = null
let _running = null         // { stop } returned by start()

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

async function bootstrapWithInit(initData) {
  const {
    character,
    apiKey,
    lanPort,
    userDataDir,
    mc_username,         // Minecraft username collected in onboarding
    preferred_name,      // seeds player_username for player-recognition
    skinServerBaseUrl,   // Logged for verification; the real consumer is
                         // CustomSkinLoader on the host's MC client. The bot itself never
                         // hits this URL — the setup wizard stamps it into
                         // customskinloader.json on the user's MC install.
    // Phase 13-15 (PROXY-07): when the user has selected `cloud-proxy` as
    // their AI backend (apiKeyStore.getAiBackendKind()), the supervisor ships
    // `{ baseURL, authToken }` here so the SDK routes through the Fly.io
    // proxy with Bearer auth instead of BYOK x-api-key. authToken is the
    // user's Supabase access_token; jwt rotation arrives via parentPort
    // {type:'jwt'} messages below.
    cloudMode,           // {baseURL, authToken} | undefined
    // Phase 15 (D-05): the user-facing auto-render toggle, bridged by the
    // supervisor from UserConfig.vision_auto_render. Maps into
    // config.vision.auto_render below; the remaining vision knobs come from the
    // bot ConfigSchema defaults. undefined/absent → false (auto-render OFF).
    visionAutoRender,    // boolean | undefined
  } = initData

  // Build a config shape that satisfies ConfigSchema.parse (see
  // src/bot/config.js — adapter.minecraft requires {host, auth, username}
  // and `version` must be a string, not boolean). v1 hardcodes
  // `auth: 'microsoft'` per CONN-02. Username comes from onboarding's
  // UserConfig (NOT from character.id — characters are personas, not
  // Minecraft accounts). player_username is seeded from preferred_name so
  // the bot recognises the human player from the first chat.
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
  // The bot's MC login name must NOT collide with the LAN host's own player
  // (else the server kicks with multiplayer.disconnect.name_taken). Derive it
  // from the character's persona, sanitized to MC's username constraints:
  // [A-Za-z0-9_], ≤16 chars, non-empty. Falls back to 'Sei' if the persona
  // name reduces to empty after sanitization.
  const sanitizeMcName = (s) => {
    const cleaned = String(s || '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 16)
    return cleaned || 'Sei'
  }
  // Prefer per-persona character.username over the legacy sanitized name
  // fallback. The username field has regex /^[A-Za-z0-9_]+$/ + length cap 16
  // baked into CharacterSchema, so it's already MC-valid by the time it
  // reaches this code. Null/empty falls back to the sanitized persona name.
  const bot_mc_username = (typeof character.username === 'string' && character.username.trim())
    ? character.username.trim()
    : sanitizeMcName(character.name)

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
    player_username: playerName,
    player_display_name: playerDisplayName,
    persona: {
      // persona.name is the MC-safe sanitized name so the bot's in-chat
      // identity and login username always match.
      name: bot_mc_username,
      expanded: character.persona.expanded,
    },
    // Phase 13-15: when cloudMode is provided, the SDK routes through the
    // proxy with Bearer auth (apiKey is unused — anthropicClient passes
    // apiKey:null to suppress the X-Api-Key header). Otherwise the legacy
    // BYOK path is preserved (D-57).
    anthropic: cloudMode
      ? { api_key: '', cloudMode: { baseURL: cloudMode.baseURL, authToken: cloudMode.authToken } }
      : { api_key: apiKey },
    adapter: {
      kind: 'minecraft',
      minecraft: {
        host: '127.0.0.1',
        port: lanPort,
        auth: 'offline',
        username: bot_mc_username,
        version: DEFAULT_MC_VERSION,
      },
    },
    memory: {
      player_md_path: `${memDir}/PLAYER.md`,
      memory_md_path: `${memDir}/MEMORY.md`,
    },
    // Phase 15 (D-05): bridge the auto-render toggle into config.vision. Only
    // auto_render is user-toggled in v1.0; every other vision field
    // (render_interval_ms, image_quality, resolution_px ≤512 cap,
    // explicit_cap_per_hour) is filled by the ConfigSchema vision defaults. The
    // `.default({})` on the vision block means omitting it entirely is also valid;
    // we set only auto_render so a missing/false toggle parses to the safe OFF state.
    vision: { auto_render: visionAutoRender === true },
    // llm: omitted — Zod default fills the entire {} sub-tree.
  }
  let config
  try {
    config = ConfigSchema.parse(rawConfig)
  } catch (err) {
    emitLifecycle({
      type: 'error',
      error: 'BOT_CRASH',
      message: `Config validation failed: ${String((err && err.message) || err)}`,
    })
    return
  }

  emitLifecycle({ type: 'init-ack' })

  // Trust main's handover — it owns the LAN watcher and revalidates port
  // freshness via its 3-second stale window. Bot-side re-discovery was
  // briefly added as a workaround when summon was failing for unrelated
  // protocol-handshake reasons; logs proved both ports always agreed
  // (handover working as designed). Removed per Pitfall 6 (CONTEXT D-25):
  // discoverLanPort lives only on the CLI path below the !parentPort guard.
  if (lanPort == null) {
    emitLifecycle({
      type: 'error',
      error: 'LAN_NOT_OPEN',
      message:
        'No LAN broadcast detected. Make sure your Minecraft world is open to LAN ' +
        '(ESC → Open to LAN → Start LAN World) and click Summon again.',
    })
    return
  }
  logger.info(
    `LAN connected at port ${lanPort}, starting "${character.name}" ` +
    `(mc_username=${config.adapter.minecraft.username}, ` +
    `player=${config.player_username}, version=${config.adapter.minecraft.version})`,
  )
  // Log the skin-server URL so a developer running `npm run dev` can
  // confirm the supervisor → bot init handover. The bot
  // never fetches from this URL (CustomSkinLoader on the host's MC client is
  // the actual consumer); this line exists purely for verification.
  if (skinServerBaseUrl) {
    logger.info(`[sei] skin server URL handed to bot: ${skinServerBaseUrl}`)
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
      onReady: () => {
        emitLifecycle({ type: 'summon-ready' })
      },
      onConnectError: (err) => {
        const message = String((err && err.message) || err)
        emitLifecycle({
          type: 'error',
          // A dropped live session and an exhausted initial-connect retry both
          // arrive tagged "LAN_NOT_OPEN:"; a silent spawn stall (connect.js's
          // wall-clock guard) is a BOT_START_TIMEOUT. Route to the class whose
          // ERROR_COPY gives the user the right next step.
          error: message.startsWith('LAN_NOT_OPEN') ? 'LAN_NOT_OPEN' : 'BOT_START_TIMEOUT',
          message,
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
  try {
    if (_running && typeof _running.stop === 'function') await _running.stop()
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
      if (!ports.length) return
      initPort = ports[0]
      initPort.start()
      // Future commands from main (e.g. {type:'stop'} during graceful
      // shutdown — supervisor sends this via port1.postMessage) arrive here.
      initPort.on('message', (e) => {
        try {
          const data = (e && e.data !== undefined) ? e.data : e
          if (data && data.type === 'stop') {
            gracefulShutdown()
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
            // descriptor (cloudMode for proxy, apiKey for BYOK) and the live
            // SDK is rebuilt in place — no stop+re-summon. Previously this
            // required a manual restart (the "Restart your bot" banner).
            try {
              _running?.setBackend?.(
                data.cloudMode
                  ? { cloudMode: { baseURL: data.cloudMode.baseURL, authToken: data.cloudMode.authToken } }
                  : { api_key: typeof data.apiKey === 'string' ? data.apiKey : '' },
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
      }
    } catch (err) {
      surfaceCrash('parentPort.message', err)
    }
  })
}

// ─── CLI path (existing behavior, gated behind !parentPort) ──────────────
// Pitfall 6: `discoverLanPort` is reachable ONLY when this guard holds —
// never when summoned by Electron main (which posts the cached lanPort
// over MessagePort per CONTEXT D-25).
if (!process.parentPort) {
  // Pitfall 6 lexical guard: `discoverLanPort` is reachable ONLY here.
  // The Electron path (`if (process.parentPort)` above) never falls through.
  if (import.meta.url === `file://${process.argv[1]}`) {
    ;(async () => {
      logger.info('Searching for an open LAN world...')
      const { port, motd } = await discoverLanPort({ timeoutMs: 5000 })
      logger.info(`Found LAN world "${motd}" on port ${port}`)
      const config = loadConfig('./config.json', { port })
      await start(config)
    })().catch((err) => {
      console.error(`[sei] Startup failed: ${err.message}`)
      process.exit(1)
    })
  }
}
