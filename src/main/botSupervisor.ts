/**
 * Bot utilityProcess supervisor.
 *
 * Sources:
 *   - RESEARCH §Pattern 1 (full utilityProcess.fork + MessageChannelMain pattern)
 *   - PATTERNS §src/main/botSupervisor.ts
 *   - CONTEXT D-15, D-16, D-18, D-19, D-25
 *   - Pitfall 1 (asar path), Pitfall 2 (stdio:'pipe')
 *   - Project Constraint §5 (30s summon timeout, 10s stop timeout)
 *
 * Lifecycle: the supervisor owns a MAP of concurrent bot sessions keyed by
 * characterId (multi-summon). A summon adds a session without disturbing the
 * others; stop(id) drains one (10s budget) and stop()/shutdown() drains all.
 * Two sessions may never share an in-game username (the world kicks the second
 * with `name_taken`), so summon refuses a colliding name before forking.
 */
import {
  utilityProcess,
  MessageChannelMain,
  app,
  type UtilityProcess,
} from 'electron';
import path from 'node:path';
import type {
  BotStatus,
  LogBatch,
  BotLifecycle,
  ErrorClass,
  CreditsHardStopEvent,
  VisionCapability,
} from '../shared/ipc';
import { effectiveMcUsername, type Character } from '../shared/characterSchema';
import { clampChatLanguage } from '../shared/chatLanguage';
import { getCharacter, patchCharacter } from './characterStore';
import { loadApiKey, hasApiKey, getAiBackendKind, type AiBackendKind } from './apiKeyStore';
import { buildLaunchContinuity } from './chat/continuity';
import { loadConfig as loadUserConfig, saveConfig as saveUserConfig } from './configStore'; // UserConfig for bot init + daily-limit gate
import { paths } from './paths';
import { createLogRouter, type LogRouter } from './logRouter';

const SUMMON_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 10_000;

/**
 * Phase 13-15 (PROXY-07, D-40 sub-delivery a): Fly.io proxy base URL.
 * Read from env so dev/staging/prod can swap targets without a rebuild.
 * The default points at api.sei.gg — the Cloudflare-fronted edge for the
 * production Fly.io deployment (see proxy/fly.toml). Cloudflare injects the
 * origin-lock header so the raw Fly hostname rejects non-Cloudflare traffic.
 */
const PROXY_BASE_URL = process.env.SEI_PROXY_URL ?? 'https://api.sei.gg';

/**
 * Best-effort classification of an arbitrary child / dependency error into
 * an ErrorClass. Used at three failure sites in `_summon` so the renderer
 * always receives a structured `error` field on BotStatus (kind: 'error')
 * — never a raw stack-trace fragment that would leak through ERROR_COPY.
 *
 * Heuristic table mirrors the renderer's classifyRendererError; if you
 * tweak one, tweak the other (or hoist to shared/).
 *
 * NOTE (plan 04-09 manual smoke-test): the INVALID_API_KEY regex must
 * cover the real Anthropic 401 wire format. After implementation the
 * executor captured `sk-fake-key` errors and confirmed the regex below
 * matches; if Anthropic changes their wire format and the smoke test
 * regresses, extend this regex AND the renderer's classifyRendererError.
 */
function classifyChildError(err: unknown): ErrorClass {
  const msg = (err && typeof err === 'object' && 'message' in err)
    ? String((err as { message: unknown }).message)
    : String(err);
  const lower = msg.toLowerCase();
  if (/keychain|safestorage|encryption.*unavailable|decrypt/i.test(lower)) return 'KEYCHAIN_LOCKED';
  if (/invalid.*api.*key|401|unauthorized|x-api-key|authentication_error/i.test(lower)) return 'INVALID_API_KEY';
  if (/429|rate.?limit|throttl/i.test(lower)) return 'RATE_LIMITED';
  if (/enotfound|enetunreach|getaddrinfo|fetch failed/i.test(lower)) return 'NETWORK_OFFLINE';
  if (/econnrefused|could not reach|no minecraft lan|lan/i.test(lower)) return 'LAN_NOT_OPEN';
  if (/eaddrnotavail|multicast/i.test(lower)) return 'LAN_UNAVAILABLE';
  if (/timeout|did not signal ready/i.test(lower)) return 'BOT_START_TIMEOUT';
  return 'BOT_CRASH';
}

const logger = {
  info: (m: string) => console.log(`[sei] ${m}`),
  warn: (m: string) => console.warn(`[sei] ${m}`),
  error: (m: string) => console.error(`[sei] ${m}`),
};

function botEntryPath(): string {
  // Pitfall 1: asar-internal path crashes utilityProcess.fork.
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app.asar.unpacked', 'src/bot/index.js');
  }
  // In dev: __dirname for the bundled main is `<repo>/dist/main`. The bot
  // lives at `<repo>/src/bot/index.js` and is NOT bundled into dist by
  // electron-vite (electron.vite.config.ts only builds main, preload, and
  // renderer). The previous resolution `path.join(__dirname, '../bot/...')`
  // pointed at `dist/bot/index.js`, which never exists, so utilityProcess
  // forked an entry that immediately failed to load and exited with
  // code=1 — the regression captured in 260508-mun. Resolve up two
  // levels and into src/bot/index.js so dev launches against the real
  // source file.
  return path.join(__dirname, '../../src/bot/index.js');
}

export interface BotSupervisorOptions {
  /** Returns the cached LAN port if connected, null otherwise. Wired by main. */
  getLanPort: () => number | null;
  /**
   * Returns the cached LAN world MOTD (level name) if connected, else null.
   * Forwarded into the bot init payload as a human label for the world
   * registry / MEMORY.md section headers (memory/worlds.js). Optional — when
   * absent the bot labels worlds by spawn coords instead.
   */
  getLanMotd?: () => string | null;
  /** Forward to renderer via webContents.send('bot:status', status). */
  sendStatus: (status: BotStatus) => void;
  /**
   * Phase 15 (D-10/VIS-03): forward the bot's `vision-capability` port message
   * to the renderer via webContents.send('vision:capability', cap). The bot
   * emits it on summon-ready and on each backend switch; the renderer holds it
   * in useUiStore.visionCapable so the Settings auto-render toggle (15-05) can
   * disable itself for a non-VLM provider. Optional — undefined no-ops.
   */
  sendVisionCapability?: (cap: VisionCapability) => void;
  /**
   * The live game bot authored a chat message (a reply to a message routed in
   * from the in-app chat while it is in-game). Main persists it to the chat
   * transcript and pushes it to the renderer. Optional — undefined no-ops.
   */
  onBotChat?: (characterId: string, text: string) => void;
  /**
   * Party redesign §2/§5: the live game bot dispatched a world-acting tool
   * (`name` set) or drained back to idle (`name` null). Main forwards this to
   * the renderer over `bot:action` so the presence line can show a verb
   * ("gathering wood…"). The supervisor also calls this with `name: null` when
   * a session stops/exits, so a stale verb never lingers after the bot is gone.
   * Optional — undefined no-ops.
   */
  onBotAction?: (
    characterId: string,
    name: string | null,
    args: Record<string, unknown> | undefined,
    ts: number,
  ) => void;
  /** Forward to renderer via webContents.send('bot:log:batch', batch). Batched. */
  sendLog: (batch: LogBatch) => void;
  /**
   * Returns the loopback skin server's baseUrl (e.g.
   * 'http://127.0.0.1:54321') or null if the server failed to bind on boot.
   * Closure-via-getter so a later restart of the skin server (port-drift
   * recovery) is observable by subsequent summons. The bot supervisor
   * ships this into the bot init payload; the bot logs it for verification
   * (CustomSkinLoader on the host's MC client is the real consumer).
   */
  getSkinServerBaseUrl: () => string | null;
  /**
   * Pre-flight cloud-credit gate (quick/260605). Resolves `true` when the
   * signed-in account is on the cloud-proxy backend AND its balance has fallen
   * below the playable minimum (plan='depleted' — see MIN_PLAYABLE_BALANCE_MICRO
   * in proxyClient). `_summon` consults this BEFORE forking a
   * cloud bot and refuses to summon when `true`, so a no-credit user never
   * joins the world to idle against a 402-ing proxy. MUST fail-open (resolve
   * `false`) on any error or missing session — a transient ledger-read blip can
   * never wrongly block a paying user. BYOK summons skip the check. Wired in
   * index.ts to proxyClient.cloudCreditsDepleted.
   */
  cloudCreditsDepleted: () => Promise<boolean>;
  /**
   * Fan the out-of-playtime hard-stop modal to the renderer (wired to
   * emitCreditsHardStop). `_summon` calls this with reason='depleted' when the
   * credit gate refuses a summon, so the user sees the "add playtime" surface
   * instead of a bot that joins and does nothing.
   */
  emitHardStop: (info: CreditsHardStopEvent) => void;
  /**
   * Voice calls (260705): is a voice call currently open for this character?
   * Read on summon-ready so a bot that spawns MID-call (the launch()-from-a-
   * call handoff) immediately gets {type:'voice-call', active:true} — without
   * this, its say() lines would land in in-game chat instead of the call.
   * Wired to voice/callState.isCallActive; optional so tests can omit it.
   */
  isVoiceCallActive?: (characterId: string) => boolean;
  /**
   * Voice calls (260705): the in-game bot called end_call() — it wants the
   * player's voice call hung up (it stays in the game). Main clears the call
   * state and pushes voice:call-ended to the renderer, which drains the TTS
   * queue (the farewell) before tearing the call down. Optional — no-ops.
   */
  onCallEndRequested?: (characterId: string) => void;
}

export interface BotSupervisor {
  summon(characterId: string): Promise<void>;
  /** Stop one summoned character, or — with no id — every active session. */
  stop(characterId?: string): Promise<void>;
  /** First active character id (or null). Back-compat: callers that only ask
   *  "is ANY bot running" still work. Prefer getActiveIds()/isActive(id). */
  getActiveId(): string | null;
  /** All currently-summoned character ids (multi-summon). */
  getActiveIds(): string[];
  /** True when this specific character has a live (or connecting) session. */
  isActive(characterId: string): boolean;
  /**
   * Task 4 — route an in-app chat message into a live game session (shared
   * brain + prompt cache). Returns false if no session is live (caller falls
   * back to the standalone chat brain).
   */
  sendSeiChat(characterId: string, payload: { from: string; text: string; voice?: boolean }): boolean;
  /**
   * 260708: record-only mirror of a group-call line into a live session's chat
   * history (context, no reply turn). Returns false if no session is live.
   */
  observeSeiChat(characterId: string, payload: { from: string; text: string }): boolean;
  /** For app.before-quit cleanup. Drains ALL active sessions with the stop timeout. */
  shutdown(): Promise<void>;
  /**
   * Plan 10-06: update the latest known JWT (Supabase access_token) for the
   * utilityProcess channel. Stores the value module-locally so the next summon
   * can include it in the init payload, and — if a session is active — posts a
   * `{type:'jwt', jwt}` message to the active port1 immediately. `null` clears
   * the cached value (used on SIGNED_OUT). Phase 13 is the consumer; in Phase
   * 10 the utilityProcess ignores the inbound jwt message.
   */
  updateJwt(jwt: string | null): void;
  /**
   * WR-05 follow-up: apply a cloud ↔ local backend switch to the RUNNING bot
   * immediately, without a stop+re-summon. No-op when no session is active —
   * the next summon reads `ai_backend_kind` fresh from config.json. Never
   * throws: backend-acquisition failures (missing key, no JWT) are surfaced
   * as a BotStatus error and/or degrade to the cold-summon behavior. Call
   * AFTER persisting the new kind via apiKeyStore.setAiBackendKind so the two
   * sources of truth agree.
   */
  switchBackend(kind: AiBackendKind): Promise<void>;
  /**
   * Voice calls (260705): forward the call open/hang-up toggle into a live
   * game session ({type:'voice-call', active} on port1). While active the
   * bot's say() lines route up to the chat surface (→ TTS) instead of in-game
   * chat, and each turn carries the voice-call primer. Returns true when a
   * live session took the message; false (no-op) when the character has no
   * session — the mode is also re-applied on summon-ready via
   * opts.isVoiceCallActive, so calling this on an idle character is fine.
   */
  setVoiceCall(characterId: string, active: boolean): boolean;
  /**
   * Voice calls (260705): the renderer's call pipeline just went live — ask a
   * live in-game session to greet the player first ({type:'voice-call-greet'}
   * on port1). Returns false when the character has no live session (the
   * caller runs the standalone chat-brain greeting instead).
   */
  greetVoiceCall(characterId: string): boolean;
}

interface ActiveSession {
  characterId: string;
  /**
   * Effective in-game MC username this bot connected under (effectiveMcUsername).
   * Tracked so a second summon can refuse a name collision before forking — two
   * bots sharing a username get the second kicked with `name_taken`.
   */
  username: string;
  /**
   * 260703 hard guard: which AI backend this session was forked under (updated
   * live by _switchBackend). `updateJwt` and the reactive 401 refresh only push
   * JWTs to 'cloud-proxy' sessions — a BYOK bot must NEVER receive the Supabase
   * token, so a local session cannot silently authenticate against the paid
   * proxy even if the bot-side cloudMode guard were to regress.
   */
  backendKind: AiBackendKind;
  startedAtMs: number;
  child: UtilityProcess;
  port1: Electron.MessagePortMain;
  router: LogRouter;
  exited: Promise<void>;
  resolveExited: () => void;
  /**
   * BL-01 (Phase 13 REVIEW): teardown closure returned by setupJwtRotation,
   * populated only when aiBackendKind === 'cloud-proxy'. _stopActive must
   * call this BEFORE port1.close() so the rotation pump doesn't fire a tick
   * into a closed port. undefined for BYOK sessions.
   */
  teardownJwtRotation?: () => void;
  /**
   * 260618: timestamp of the last reactive JWT-refresh request from this bot
   * (it posts {type:'request-jwt'} on a 401 expired_jwt). Debounced so a burst
   * of 401s triggers at most one refreshSession() call.
   */
  lastJwtReqAt?: number;
}

export function createBotSupervisor(opts: BotSupervisorOptions): BotSupervisor {
  // Multi-summon: zero-or-more concurrent sessions keyed by characterId. A
  // fresh summon adds an entry; it no longer stops the others. The common case
  // (one bot) is just a one-entry map, so single-summon behavior is unchanged.
  const sessions = new Map<string, ActiveSession>();
  // 260705 (issue #6): synchronous summon reservations. `_summon`'s
  // sessions.has() guard alone spans ~10 awaits (including the network credit
  // gate) between check and sessions.set, so two interleaved summons could
  // both pass it and both fork — the second child's sessions.set overwrote the
  // first's entry, the world kicked one with name_taken, its teardown deleted
  // the entry, and the surviving child was left alive with NO map entry: an
  // unstoppable orphan burning LLM spend until app quit. The reservation is
  // taken before `_summon`'s first await and held until the attempt settles
  // (the 30s watchdog guarantees it does), which overlaps sessions.set — so
  // there is no instant where a character is neither reserved nor registered.
  const pendingSummons = new Map<string, Promise<void>>();
  // Effective MC username of each pending (pre-registration) summon, so the
  // duplicate-username guard can also see attempts that haven't reached
  // sessions.set yet (two DIFFERENT characters sharing a username, summoned
  // together, would otherwise both fork and one gets kicked `name_taken`).
  const pendingUsernames = new Map<string, string>();
  // Plan 10-06: latest known Supabase access_token (JWT). The jwtBridge
  // module-level closure calls updateJwt() on every TOKEN_REFRESHED / SIGNED_IN
  // / USER_UPDATED / SIGNED_OUT (T-10-06-01: only the JWT, never the refresh
  // token). Stored even when no session is active so the next summon's init
  // payload carries a fresh value.
  let latestJwt: string | null = null;

  const lifecycleToStatus = (
    e: BotLifecycle,
    characterId: string,
    startedAtMs: number,
  ): BotStatus | null => {
    switch (e.type) {
      case 'connected':
      case 'summon-ready':
        return { kind: 'online', uptimeMs: Date.now() - startedAtMs, startedAtMs, characterId };
      case 'disconnected':
        // Map to a transitional state; renderer can keep the row visible
        // but flip the dot back to amber until reconnect.
        return { kind: 'connecting', characterId };
      case 'error':
        return { kind: 'error', error: e.error, message: e.message, characterId };
      case 'exit':
        // Exit is handled separately — supervisor flips to 'idle' when no
        // active session remains (see _stopActive).
        return null;
      case 'init-ack':
      case 'chat':
      case 'summon-stopped':
      default:
        return null;
    }
  };

  async function _stop(characterId: string, timeoutMs: number): Promise<void> {
    // 260705 (issue #6): a stop landing in the pre-registration window (status
    // already "Connecting…", sessions.set not reached) used to find no session,
    // report success — and the bot joined anyway seconds later. Wait for the
    // pending attempt to settle (bounded by the summon watchdog) and stop the
    // session it registered; if it failed, there is genuinely nothing to stop.
    const pending = pendingSummons.get(characterId);
    if (pending) await pending.catch(() => { /* failed summon == nothing to stop */ });
    const session = sessions.get(characterId);
    if (!session) {
      // No live session — but the renderer may still be showing a stale entry
      // for this id (e.g. a mid-session crash that already dropped the session
      // without a terminal push). Emit `idle` so a "Disconnect" click always
      // clears the widget instead of no-op'ing on an orphaned status.
      opts.sendStatus({ kind: 'idle', characterId });
      return;
    }
    // BL-01: kill the JWT rotation pump BEFORE port1.close() so a pending
    // tick (in the middle of a refreshSession await) cannot postMessage
    // onto a disposed port. setupJwtRotation re-checks `running` between
    // the await and the postMessage; the teardown closure flips that flag.
    try { session.teardownJwtRotation?.(); } catch { /* best-effort */ }
    try {
      session.port1.postMessage({ type: 'stop' });
    } catch {
      // port may already be closed if child crashed
    }

    const exited = await Promise.race<boolean>([
      session.exited.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), timeoutMs)),
    ]);
    if (!exited) {
      logger.warn(`bot stop timed out after ${timeoutMs}ms — escalating to kill`);
      try {
        session.child.kill();
      } catch {
        // best-effort
      }
      // Wait briefly for kill to settle (best-effort)
      await Promise.race<void>([
        session.exited,
        new Promise<void>((r) => setTimeout(r, 1000)),
      ]);
    }
    try {
      await session.router.close();
    } catch {
      // best-effort
    }
    try {
      session.port1.close();
    } catch {
      // best-effort
    }
    if (sessions.get(characterId) === session) sessions.delete(characterId);
    // 260618: a companion left — refresh the survivors' rosters.
    broadcastRoster();
    opts.sendStatus({ kind: 'idle', characterId });
    // Party redesign §5: the session is gone — clear any lingering action verb
    // so the roster line doesn't stick on "gathering wood…" after Disconnect.
    opts.onBotAction?.(characterId, null, undefined, Date.now());
  }

  /** Drain every active session in parallel (sign-out / before-quit). */
  async function _stopAll(timeoutMs: number): Promise<void> {
    // Include pending (pre-registration) summons so an app shutdown mid-summon
    // drains the child that attempt is about to register (_stop awaits the
    // reservation) instead of leaving it to die with the parent process.
    const ids = new Set([...sessions.keys(), ...pendingSummons.keys()]);
    await Promise.all([...ids].map((id) => _stop(id, timeoutMs)));
  }

  /**
   * 260618 (multi-agent): tell every live bot which OTHER AI companions share
   * the world right now. Each bot receives the list of the other sessions'
   * in-game usernames (never its own). The bot uses it to (a) not wake on a
   * message aimed only at a sibling, (b) see + coordinate with teammates in its
   * snapshot, and (c) know it may direct a fellow companion. Re-broadcast on
   * every summon/stop/exit so the roster tracks the live session set. A solo
   * session just gets [] (no behavior change). Best-effort per port.
   */
  function broadcastRoster(): void {
    for (const session of sessions.values()) {
      const companions = [...sessions.values()]
        .filter((s) => s !== session)
        .map((s) => s.username);
      try {
        session.port1.postMessage({ type: 'roster', companions });
      } catch {
        /* port closed during teardown; ignore */
      }
    }
  }

  /**
   * 260618 (freeze fix): a cloud-proxy bot posts {type:'request-jwt'} when a
   * call returns 401 expired_jwt. The proactive 30-min rotation pump can miss
   * (machine asleep, a refresh tick that failed), leaving the bot hammering a
   * dead token and frozen until stopped. Fetch a fresh token on demand
   * (getProxyJwt refreshes when near/past expiry) and push it straight back on
   * the same cloud-jwt-update channel the pump uses, so the bot's next call
   * succeeds. Debounced per session. NEVER logs the token (T-13-14-01).
   */
  async function handleJwtRefreshRequest(characterId: string): Promise<void> {
    const session = sessions.get(characterId);
    if (!session) return;
    // 260703 hard guard: only a cloud-proxy session may be handed a JWT. A
    // BYOK bot never legitimately sends request-jwt; if one does, ignore it.
    if (session.backendKind !== 'cloud-proxy') return;
    const now = Date.now();
    if (session.lastJwtReqAt && now - session.lastJwtReqAt < 8_000) return;
    session.lastJwtReqAt = now;
    try {
      const { getProxyJwt } = await import('./auth/proxyJwtFetcher');
      const jwt = await getProxyJwt();
      latestJwt = jwt;
      try {
        session.port1.postMessage({ kind: 'cloud-jwt-update', jwt });
        logger.info(`[sei/sup] pushed a fresh JWT to ${characterId} after a 401 recovery request`);
      } catch {
        /* port closed during teardown; ignore */
      }
    } catch (err) {
      // PROXY_NO_SESSION (signed out) or PROXY_REFRESH_FAILED. Nothing to push;
      // the signed-out case is owned by the renderer's auth / hard-stop flow.
      logger.warn(
        `[sei/sup] reactive JWT refresh for ${characterId} failed: ${(err as Error)?.message}`,
      );
    }
  }

  async function _summon(characterId: string): Promise<void> {
    // Multi-summon: do NOT stop the other bots. Re-summoning an already-running
    // character is a no-op (the UI shows "unsummon" for live characters, so the
    // only way here is a double-fire) — never fork a duplicate child for it.
    if (sessions.has(characterId)) return;

    const character: Character | null = await getCharacter(characterId);
    if (!character) throw new Error(`Character not found: ${characterId}`);

    // Duplicate in-game-name guard: two bots can't share a username (the world
    // kicks the second with `name_taken`). Refuse to fork when a live session
    // already uses this character's effective MC username. The renderer
    // pre-checks and raises a popup on the common path; this is the
    // authoritative backstop that closes the click-twice-fast race. Compared
    // case-insensitively to match MC's username handling.
    const username = effectiveMcUsername(character);
    for (const s of sessions.values()) {
      if (s.username.toLowerCase() === username.toLowerCase()) {
        throw new Error(`SUMMON_USERNAME_CONFLICT: ${username}`);
      }
    }
    // 260705 (issue #6): also refuse when a PENDING summon (pre-registration,
    // not yet in `sessions`) holds this username. Check-then-set is safe here —
    // no await between them, so two attempts serialize on the event loop.
    for (const [otherId, otherName] of pendingUsernames) {
      if (otherId !== characterId && otherName.toLowerCase() === username.toLowerCase()) {
        throw new Error(`SUMMON_USERNAME_CONFLICT: ${username}`);
      }
    }
    pendingUsernames.set(characterId, username);

    // Phase 13-15 (PROXY-07, D-57): branch on AI backend kind.
    //   - 'cloud-proxy' → bot routes Anthropic traffic through the Fly.io
    //     proxy with the user's Supabase JWT as Bearer auth. No local API
    //     key needed; `cloudMode` is shipped in the init payload.
    //   - 'local' (BYOK)  → legacy path; loadApiKey() from safeStorage.
    // The kind read defaults to 'local' for existing users (apiKeyStore.ts).
    const aiBackendKind = await getAiBackendKind();
    let apiKey: string = '';
    let cloudMode: { baseURL: string; authToken: string } | undefined;
    if (aiBackendKind === 'cloud-proxy') {
      // The bot needs a JWT at fork time. jwtBridge calls updateJwt() on
      // every SIGNED_IN / TOKEN_REFRESHED, so latestJwt should be populated
      // whenever the user has an active session. A null value means the
      // user is signed out — the proxy will 401 and the renderer's
      // hard-stop modal flow takes over. We still fork (don't block summon
      // on JWT presence) because the 13-14 rotation pump can push a JWT
      // mid-session via parentPort {type:'jwt'}.
      cloudMode = { baseURL: PROXY_BASE_URL, authToken: latestJwt ?? '' };

      // Pre-flight credit gate (quick/260605). Refuse to fork a cloud bot when
      // the account's ledger is exhausted: otherwise the bot joins the LAN
      // world, every proxy call 402s, and the user stares at an idle, silent
      // companion. Surface the out-of-playtime hard-stop instead and abort the
      // summon so nothing joins. cloudCreditsDepleted fails OPEN (false on any
      // error / no session / BYOK), so this never blocks a funded or
      // own-key user. The early throw runs BEFORE the 'connecting' status
      // below, so the model row stays idle rather than flashing a connect.
      if (await opts.cloudCreditsDepleted()) {
        logger.warn(
          '[sei/sup] summon blocked: out of playtime (balance below the playable minimum) — raising popup, not forking the bot',
        );
        opts.emitHardStop({ reason: 'depleted' });
        opts.sendStatus({ kind: 'idle', characterId });
        throw new Error('CLOUD_CREDITS_DEPLETED');
      }

      // Daily-play-limit gate (trial $5/day spend cap, 260617). A prior session
      // that hit the cap persisted daily_limited_until; refuse to fork until the
      // window resets — the bot would just 429 daily_dollar and bounce. Raise the
      // same daily-limit popup the mid-session path uses. Subscribers never hit
      // the trial cap, and the renderer clears this flag on subscription-active,
      // so a paid upgrade unblocks immediately; a config glitch fails OPEN.
      try {
        const cfg = await loadUserConfig();
        const untilIso = cfg.daily_limited_until;
        if (untilIso) {
          const untilMs = Date.parse(untilIso);
          if (Number.isFinite(untilMs) && Date.now() < untilMs) {
            const sec = Math.max(1, Math.ceil((untilMs - Date.now()) / 1000));
            logger.warn(`[sei/sup] summon blocked: daily play limit active ${sec}s more`);
            opts.emitHardStop({ reason: 'rate_limited', retry_after_seconds: sec });
            opts.sendStatus({ kind: 'idle', characterId });
            throw new Error('DAILY_LIMIT_REACHED');
          }
          // Window elapsed — clear the stale flag so this and future summons pass.
          await saveUserConfig({ ...cfg, daily_limited_until: null });
        }
      } catch (e) {
        if ((e as Error)?.message === 'DAILY_LIMIT_REACHED') throw e;
        logger.warn(
          `[sei/sup] daily-limit gate check failed (allowing summon): ${(e as Error).message}`,
        );
      }
    } else {
      // 260703 hard guard: local (BYOK) mode must NEVER fall back to the cloud
      // JWT. A missing key fails HERE — visibly, before any fork — instead of
      // surfacing as an opaque ENOENT-flavored BOT_CRASH (or worse, a summon
      // that quietly rode the signed-in user's Supabase token through the
      // paid proxy). INVALID_API_KEY is the closest ERROR_COPY class; the
      // explicit message tells the user exactly which state they're in.
      if (!(await hasApiKey())) {
        const message =
          'Local mode is on but no API key is saved. Add your API key in Settings, or switch to managed billing.';
        opts.sendStatus({ kind: 'error', error: 'INVALID_API_KEY', message, characterId });
        throw new Error(`LOCAL_NO_API_KEY: ${message}`);
      }
      // GUI-05: loadApiKey can throw KEYCHAIN_UNAVAILABLE / decrypt errors when
      // the user is locked out of their keychain. classify before forwarding so
      // the renderer's CharacterPage shows ERROR_COPY[KEYCHAIN_LOCKED] copy
      // (not the raw safeStorage stack frame).
      try {
        apiKey = await loadApiKey();
      } catch (err) {
        const ec = classifyChildError(err);
        const message = (err && typeof err === 'object' && 'message' in err)
          ? String((err as { message: unknown }).message)
          : String(err);
        opts.sendStatus({ kind: 'error', error: ec, message, characterId });
        throw err;
      }
    }

    // Load UserConfig so the bot's player_username / player_display_name are
    // populated from onboarding. mc_username is no longer collected in the GUI
    // (260605) — it stays in the DB but may be empty, so the bot derives
    // player recognition from preferred_name when it's absent. Onboarding is
    // now gated on preferred_name ("Name"); refuse to fork without it.
    const userCfg = await loadUserConfig();
    const mc_username = (userCfg.mc_username ?? '').trim();
    const preferred_name = (userCfg.preferred_name ?? '').trim();
    // Bridge the user-facing Looking (vision) mode from UserConfig into the
    // bot's config.vision at fork time. The renderer never talks to the bot
    // ConfigSchema directly — main is the translator. The remaining vision
    // knobs (cadence, image_quality, resolution_px cap)
    // come from the bot config / orchestrator defaults.
    const visionMode = userCfg.vision_mode ?? 'on-demand';
    // Appearance & feel: bridge the "Realistic typing" toggle into the bot so
    // in-game replies get the same reading/typing pacing as the in-app chat.
    // Default ON (matches UserConfig.realistic_typing) when the field is absent.
    const realisticTyping = userCfg.realistic_typing !== false;
    // 260709: bridge the conversation language into the bot's # LANGUAGE
    // directive. Fork-time like vision_mode — a Settings change applies at the
    // next summon (the chat surface re-reads it per turn).
    const chatLanguage = clampChatLanguage(userCfg.chat_language);
    if (!preferred_name) {
      const status: BotStatus = {
        kind: 'error',
        error: 'BOT_CRASH',
        message: 'Your name is missing. Re-run onboarding from Settings.',
        characterId,
      };
      opts.sendStatus(status);
      throw new Error('PREFERRED_NAME_MISSING');
    }

    const lanPort = opts.getLanPort();
    if (lanPort == null) {
      const status: BotStatus = {
        kind: 'error',
        error: 'LAN_NOT_OPEN',
        message: 'No LAN world detected. Open one to LAN in Minecraft.',
        characterId,
      };
      opts.sendStatus(status);
      throw new Error('LAN_NOT_OPEN');
    }

    const startedAtMs = Date.now();
    opts.sendStatus({ kind: 'connecting', characterId });

    const router = await createLogRouter({ characterId, sendBatch: opts.sendLog });
    // Cross-surface continuity (Phase 18/19): the rolling summary + recent
    // window, so the companion carries the app conversation into the world.
    // PURE DISK READ (260702) — compaction runs only as a chat-surface
    // background task (foldIfDue), so a summon never waits on an LLM call.
    // Still kicked off before the fork and awaited inside the 'spawn' handler:
    // when this was an await between fork and the child event registrations,
    // the child's one-shot 'spawn' event fired before the listener attached —
    // init was never posted and the bot exited silently with code 0 (the
    // 260702 "stuck connecting" regression).
    const continuityP: Promise<Awaited<ReturnType<typeof buildLaunchContinuity>>> =
      buildLaunchContinuity(characterId).catch(() => null);
    // ITEM 1 (quick/260523-t8d): expose the AI-backend mode + has-key state to
    // the bot child so brain/log.js can suppress the noisy game-state +
    // [haiku?] prompt logs when running in local (BYOK) mode without a key —
    // those calls never fire successfully in that state, and the snapshot
    // output is pure cognitive noise for the user staring at the LogsBar.
    // As soon as either condition flips (key added OR backend → cloud-proxy),
    // the logs reappear unmodified on the next bot fork.
    const seiBackend = aiBackendKind; // 'local' | 'cloud-proxy'
    const seiHasApiKey = apiKey ? '1' : '';
    const child = utilityProcess.fork(botEntryPath(), [], {
      stdio: 'pipe', // Pitfall 2 — required for stdout/stderr access
      serviceName: `sei-bot-${characterId}`,
      env: {
        ...process.env,
        // Profile-scoped root (NOT the device userData root): the bot derives
        // its memory dir as `${userDataDir}/memory/<id>`, so this must point at
        // the active account's profile so memory partitions per-account.
        SEI_USER_DATA: paths.profileRoot(),
        SEI_CHARACTER_ID: characterId,
        SEI_BACKEND: seiBackend,
        SEI_HAS_API_KEY: seiHasApiKey,
      },
    });
    const { port1, port2 } = new MessageChannelMain();

    let resolveExited!: () => void;
    const exitedP = new Promise<void>((resolve) => {
      resolveExited = resolve;
    });

    const session: ActiveSession = {
      characterId,
      username,
      backendKind: aiBackendKind,
      startedAtMs,
      child,
      port1,
      router,
      exited: exitedP,
      resolveExited,
    };
    sessions.set(characterId, session);

    // stdout/stderr line-split → router. We also keep the last ~4KB of
    // stderr/stdout so the exit-before-ready handler can attach the actual
    // crash trace to the BotStatus.message field (260508-mun: previously
    // the renderer only saw "Bot exited before summon-ready (code=1)" with
    // no signal about which require()/throw blew up).
    const buffers = { stdout: '', stderr: '' };
    const tails = { stdout: '', stderr: '' };
    const TAIL_MAX = 4096;
    const sink = (chunk: Buffer, key: 'stdout' | 'stderr') => {
      const chunkText = chunk.toString('utf-8');
      // Mirror to the Electron-main terminal so a developer running
      // `npm run dev` sees bot startup errors immediately, even before
      // the LogsBar is opened in the renderer.
      // eslint-disable-next-line no-console
      (key === 'stderr' ? console.error : console.log)(`[bot-${key}] ${chunkText.replace(/\n$/, '')}`);
      // Maintain rolling tail buffer for exit diagnostics.
      tails[key] = (tails[key] + chunkText).slice(-TAIL_MAX);
      // Original line-split → router behavior.
      const text = buffers[key] + chunkText;
      const lines = text.split('\n');
      buffers[key] = lines.pop() ?? '';
      for (const line of lines) if (line) router.append(line);
    };
    child.stdout?.on('data', (c: Buffer) => sink(c, 'stdout'));
    child.stderr?.on('data', (c: Buffer) => sink(c, 'stderr'));

    // Lifecycle messages
    let summonResolved = false;
    let summonResolve: () => void = () => {};
    let summonReject: (err: Error) => void = () => {};
    const summonPromise = new Promise<void>((resolve, reject) => {
      summonResolve = resolve;
      summonReject = reject;
    });
    const summonTimer = setTimeout(() => {
      if (summonResolved) return;
      summonResolved = true;
      const err: ErrorClass = 'BOT_START_TIMEOUT';
      opts.sendStatus({
        kind: 'error',
        error: err,
        message: 'Bot did not signal ready within 30s.',
        characterId,
      });
      summonReject(new Error(err));
    }, SUMMON_TIMEOUT_MS);

    port1.on('message', (e: { data: BotLifecycle | { type: 'vision-capability'; visionCapable: boolean } }) => {
      const data = e.data;
      // Phase 15 (D-10/VIS-03): the bot pushes its active-provider vision
      // capability on summon-ready and on each backend switch. Route it to the
      // dedicated renderer channel (NOT BotStatus) and return early — it is not
      // a BotLifecycle event, so the lifecycleToStatus path below must not run.
      if (data.type === 'vision-capability') {
        opts.sendVisionCapability?.({ visionCapable: data.visionCapable === true });
        return;
      }
      // 260618 (freeze fix): the bot hit a 401 expired_jwt and is asking for a
      // fresh token. Fetch on demand and push it back. Not a BotLifecycle event,
      // so return before lifecycleToStatus.
      if ((data as { type?: string }).type === 'request-jwt') {
        void handleJwtRefreshRequest(characterId);
        return;
      }
      // The in-game bot is replying to a message that was routed in from the
      // in-app chat (task 4). Deliver it to the chat transcript + renderer. Not
      // a BotStatus event, so return before lifecycleToStatus.
      if (data.type === 'chat') {
        opts.onBotChat?.(characterId, (data as { text?: string }).text ?? '');
        return;
      }
      // Voice calls (260705): the in-game bot called end_call() — hang up the
      // player's call (the bot stays in the game). Not a BotStatus event.
      if ((data as { type?: string }).type === 'call-end') {
        opts.onCallEndRequested?.(characterId);
        return;
      }
      // Party redesign §2/§5: current world action. `name` set = a world-acting
      // tool started; `name` null = the loop drained to idle. Forward to the
      // renderer's presence-verb line. Not a BotStatus event — return before
      // lifecycleToStatus.
      if (data.type === 'action') {
        opts.onBotAction?.(characterId, data.name ?? null, data.args, Date.now());
        return;
      }
      if (data.type === 'summon-ready' && !summonResolved) {
        summonResolved = true;
        clearTimeout(summonTimer);
        // Voice calls (260705): if the player has a call open with this
        // character (it launch()ed into the world mid-call), apply the mode
        // now — the bot only learns it over the port.
        try {
          if (opts.isVoiceCallActive?.(characterId)) {
            port1.postMessage({ type: 'voice-call', active: true });
          }
        } catch { /* port raced closed — the call toggle will re-send */ }
        // Stamp last_launched on successful connect — never-launched personas
        // still show '—' until they reach summon-ready at least once.
        void (async () => {
          try {
            await patchCharacter(characterId, (c) => ({ ...c, last_launched: new Date().toISOString() }));
          } catch (err) {
            logger.warn(`failed to stamp last_launched for ${characterId}: ${(err as Error).message}`);
          }
        })();
        summonResolve();
      }
      // 260508-nkk: lifecycle 'error' is terminal for the summon promise.
      // Previously only summon-ready cleared summonResolved, so a structured
      // error from the bot (e.g. BOT_START_TIMEOUT from connect.js's wall-
      // clock guard, or BOT_CRASH from a config validation throw) would
      // arrive at the renderer correctly via lifecycleToStatus, but the
      // outer 30s summonTimer would still tick and eventually OVERWRITE the
      // specific error with a generic BOT_START_TIMEOUT message. Resolve
      // the promise immediately so bot:summon's IPC caller unblocks at the
      // moment we have actionable information, not 30s later.
      if (data.type === 'error' && !summonResolved) {
        summonResolved = true;
        clearTimeout(summonTimer);
        summonReject(new Error(`${data.error}: ${data.message}`));
      }
      // Out-of-playtime popup (260616): a CLOUD_CREDITS_DEPLETED lifecycle error
      // can arrive MID-SESSION — the running bot drew its balance below the
      // playable minimum and the proxy 402'd its next turn, so orchestrator.js
      // latched and is tearing the bot down (it leaves the world on its own).
      // The pre-flight summon gate (_summon → cloudCreditsDepleted) only covers
      // summon time, so raise the same out-of-playtime popup here for a session
      // that depletes while live. emitHardStop is idempotent (sets
      // hardStopActive=true); fires whether or not the summon promise resolved.
      if (data.type === 'error' && data.error === 'CLOUD_CREDITS_DEPLETED') {
        logger.warn('[sei/sup] bot depleted mid-session — raising out-of-playtime popup');
        opts.emitHardStop({ reason: 'depleted' });
        // The bot latches halted and self-exits, but that self-shutdown is
        // best-effort: if its gracefulShutdown stalls (a hung brain.stop /
        // adapter teardown, or a delayed process.exit in the utilityProcess),
        // the child stays alive and socket-connected and the avatar FREEZES
        // in-world. Drive the same authoritative drain→kill path as a
        // user-initiated stop so the character is guaranteed to leave: _stop
        // posts {type:'stop'}, waits STOP_TIMEOUT_MS, then child.kill(). It
        // no-ops if the bot already exited (session gone). Fire-and-forget.
        void _stop(characterId, STOP_TIMEOUT_MS);
      }
      // Daily play limit ($5/day trial spend cap) hit MID-SESSION: the bot
      // latched and is leaving the world quietly (no in-game chat). Raise the
      // daily-limit popup and PERSIST the reset window so re-summons are blocked
      // until it clears (the summon gate reads daily_limited_until).
      // retryAfterSeconds is the honest reset countdown; default 24h if absent.
      if (data.type === 'error' && data.error === 'DAILY_LIMIT_REACHED') {
        const sec =
          typeof data.retryAfterSeconds === 'number' && data.retryAfterSeconds > 0
            ? data.retryAfterSeconds
            : 86_400;
        logger.warn(`[sei/sup] bot hit daily play limit — popup + persisting ${sec}s block`);
        opts.emitHardStop({ reason: 'rate_limited', retry_after_seconds: sec });
        void (async (): Promise<void> => {
          try {
            const cfg = await loadUserConfig();
            await saveUserConfig({
              ...cfg,
              daily_limited_until: new Date(Date.now() + sec * 1000).toISOString(),
            });
          } catch (e) {
            logger.warn(`[sei/sup] failed to persist daily-limit block: ${(e as Error).message}`);
          }
        })();
        // Same backstop as the depleted path above: the bot is supposed to
        // leave the world on its own, but a stalled self-shutdown would leave
        // the avatar frozen in-game (still connected). Authoritatively drain
        // and, on timeout, kill the child so the character actually leaves.
        void _stop(characterId, STOP_TIMEOUT_MS);
      }
      const status = lifecycleToStatus(data, characterId, startedAtMs);
      if (status) opts.sendStatus(status);
    });
    port1.start();

    // BL-01 (Phase 13 REVIEW): wire the 30-min JWT rotation pump for
    // cloud-proxy sessions. The pump:
    //   - fires once IMMEDIATELY (seed) to give the bot a fresh JWT,
    //   - then every 30 min (well within the 1h Supabase JWT expiry),
    //   - posts `{kind:'cloud-jwt-update', jwt}` onto port1 → bot's
    //     parentPort handler calls _running.setAuthToken (BL-02 fix).
    //
    // Lifecycle: the teardown closure is stored on `session` so
    // `_stopActive` calls it BEFORE port1.close(). For BYOK sessions
    // we skip the pump entirely (no proxy traffic to authenticate).
    //
    // Without this wiring, `setupJwtRotation` was dead code — the bot
    // relied on Supabase TOKEN_REFRESHED → jwtBridge → updateJwt for
    // its rolling JWT, with no documented 30-min safety net.
    // NOTE: every child.once/child.on registration from here through the
    // 'exit' handler below MUST stay synchronous with the fork above — an
    // `await` in between loses one-shot events ('spawn' especially) that fire
    // while main is parked on the microtask queue. The JWT rotation pump and
    // the continuity await both live elsewhere for exactly this reason.
    child.once('spawn', () => {
      void (async (): Promise<void> => {
        // Wait (briefly) for the pre-fork continuity build. Capped so a slow
        // summarization degrades to a continuity-less join instead of eating
        // the 30s summon budget — the fold still lands in bridge.json for the
        // next launch.
        const continuity = await Promise.race([
          continuityP,
          new Promise<null>((r) => setTimeout(() => r(null), 4_000)),
        ]);
        // Ship mc_username, preferred_name, and skinServerBaseUrl so the bot
        // can satisfy ConfigSchema, seed player_username for player-recognition
        // without disk reads, and log the skin server URL for verification.
        // The bot itself never hits the skin server — the consumer is the host
        // MC client via CustomSkinLoader. character.username is preferred over
        // sanitizeMcName(character.name) so each persona connects under its
        // own in-game name.
        try {
          child.postMessage(
            {
              type: 'init',
              character,
              apiKey,
              lanPort,
              // World label for the memory registry / section headers (best-effort).
              lanMotd: opts.getLanMotd?.() ?? null,
              // Profile-scoped root — the bot resolves memory under this dir, so it
              // must be the active account's profile (paths.profileRoot()), never
              // the device-global userData root.
              userDataDir: paths.profileRoot(),
              mc_username,
              preferred_name,
              // The bridged Looking (vision) mode. The bot's bootstrapWithInit
              // reads this into config.vision.mode before ConfigSchema.parse.
              visionMode,
              // Appearance & feel: the "Realistic typing" toggle. The bot's
              // bootstrapWithInit reads this into config.realistic_typing.
              realisticTyping,
              // 260709: conversation language (UserConfig.chat_language). The
              // bot's bootstrapWithInit reads this into config.chat_language.
              chatLanguage,
              // 260618 (multi-agent): the OTHER AI companions already in this world,
              // so the new bot knows its teammates from its first tick. The new
              // session is already in `sessions` (added before this spawn handler),
              // so filter it out. broadcastRoster() keeps this current afterwards.
              companions: [...sessions.values()]
                .filter((s) => s.characterId !== characterId)
                .map((s) => s.username),
              skinServerBaseUrl: opts.getSkinServerBaseUrl(),
              // Plan 10-06: ship the latest known JWT so a bot summoned while
              // signed_in has a token in hand before TOKEN_REFRESHED fires. Phase
              // 13 reads this; in Phase 10 the bot loop ignores it.
              // 260703 hard guard: cloud-proxy sessions ONLY — a BYOK bot has no
              // business holding the Supabase token at all, even unused.
              initialJwt: aiBackendKind === 'cloud-proxy' ? latestJwt : null,
              // Phase 13-15 (PROXY-07): when the user has selected cloud-proxy as
              // their AI backend, ship the proxy baseURL + initial Supabase JWT.
              // The bot constructs the Anthropic SDK with
              // {baseURL, authToken, apiKey:null} so all Anthropic traffic flows
              // through Sei's Fly.io proxy (D-40 sub-delivery a). undefined here
              // means BYOK — bot uses the legacy `apiKey` path.
              cloudMode,
              // Phase 18/19: { summary, recent } from the in-app chat, seeded into
              // the bot's prompt so it knows what you were just talking about. null
              // when there is no prior chat. See chat/continuity.ts.
              continuity,
              // Voice calls (260707): true when this bot is spawning INTO an open
              // call (launch()ed or summoned mid-call). Shipped in the init
              // handshake — not the post-spawn {type:'voice-call'} message — so
              // voiceCallActive is set BEFORE the first-spawn tick runs and the
              // bot skips its cold FIRST CONTACT greeting (which would otherwise
              // double the standalone launch reply). Deterministic; no race.
              voiceCallActive: opts.isVoiceCallActive?.(characterId) ?? false,
            },
            [port2],
          );
        } catch (err) {
          // Child died between spawn and the (post-continuity) post. The 'exit'
          // handler owns the failure surface; just log.
          logger.warn(`init postMessage failed for ${characterId}: ${(err as Error).message}`);
        }
      })();
    });

    // GUI-05: `child.on('error')` covers the rare case where Node emits an
    // explicit error event on the UtilityProcess (e.g. failure-to-spawn on
    // some platforms, or future Electron versions that surface fork errors
    // here). Classify so the renderer sees an ErrorClass instead of a raw
    // stack frame. Most spawn failures still surface via 'exit' below.
    (child as UtilityProcess & { on: (ev: string, cb: (err: Error) => void) => void }).on?.(
      'error',
      (err: Error) => {
        logger.error(`bot child error: ${err.message}`);
        if (!summonResolved) {
          summonResolved = true;
          clearTimeout(summonTimer);
          const ec = classifyChildError(err);
          opts.sendStatus({ kind: 'error', error: ec, message: err.message, characterId });
          summonReject(err);
        }
      },
    );

    child.on('exit', (code) => {
      // Accumulate playtime regardless of exit reason (clean stop or crash).
      // We only count time between summon-ready and exit; if the bot never
      // reached summon-ready (summonResolved still true via reject path),
      // duration may still reflect connect-attempt time — that's fine.
      const sessionMs = Date.now() - startedAtMs;
      const playtimeWrite: Promise<void> =
        sessionMs > 0
          ? (async () => {
              try {
                await patchCharacter(characterId, (c) => ({
                  ...c,
                  playtime_ms: (c.playtime_ms ?? 0) + sessionMs,
                }));
                // Also fold into the profile-wide cumulative total so it
                // survives this character being deleted later (the deleted
                // character's time stays counted). Separate from the per-
                // character write above; a failure in one shouldn't lose the other.
                try {
                  const { addPlaytimeMs } = await import('./configStore');
                  await addPlaytimeMs(sessionMs);
                } catch (err) {
                  logger.warn(`failed to accumulate total playtime: ${(err as Error).message}`);
                }
              } catch (err) {
                logger.warn(`failed to accumulate playtime for ${characterId}: ${(err as Error).message}`);
              }
            })()
          : Promise.resolve();
      if (!summonResolved) {
        summonResolved = true;
        clearTimeout(summonTimer);
        // GUI-05 + 260508-mun hardening: include the last ~1KB of stderr
        // (or stdout if stderr is empty) in the message so the renderer's
        // Banner / model row error label shows actionable text rather than
        // the bare exit code. Classification still runs against the
        // combined tail so signals like "Cannot find module" can promote
        // BOT_CRASH to a more specific ErrorClass over time.
        const stderrTail = tails.stderr.slice(-1024).trim();
        const stdoutTail = tails.stdout.slice(-1024).trim();
        const tail = stderrTail || stdoutTail;
        const baseMessage = `Bot exited before summon-ready (code=${code ?? 'null'})`;
        const message = tail ? `${baseMessage}\n${tail}` : baseMessage;
        // eslint-disable-next-line no-console
        console.error(`[sei] ${baseMessage}\n--- bot stderr tail ---\n${stderrTail || '(empty)'}\n--- bot stdout tail ---\n${stdoutTail || '(empty)'}`);
        const ec = classifyChildError(message);
        opts.sendStatus({ kind: 'error', error: ec, message, characterId });
        summonReject(new Error(message));
      } else {
        // The bot WAS live (reached summon-ready) and has now exited without
        // going through `_stop` — a spontaneous end: the player closed their
        // world, the connection dropped, or the child crashed mid-session.
        // Nothing else emits a terminal status on this path, so without this the
        // renderer's `summons[id]` stays stuck at 'online'/'connecting' and the
        // floating widget keeps a stale "Disconnect" button. Push `idle` so the
        // widget clears. (A clean `_stop` also emits idle after `exited`
        // resolves; a duplicate idle is harmless — the delete is idempotent.)
        opts.sendStatus({ kind: 'idle', characterId });
      }
      // Resolve `exited` only AFTER the playtime write lands. _stop awaits
      // `exited` before emitting the idle status, and the renderer refreshes the
      // character's last_launched / total playtime when it sees idle — so the
      // store must already reflect this session's playtime by that point.
      //
      // Drop the dead session from the map here too: a MID-SESSION crash (exit
      // after summon-ready) never goes through _stop, so without this the slot
      // would linger — `_summon`'s `sessions.has(id)` early-return would then
      // silently swallow a "try again", and the username would stay reserved
      // against the duplicate-name guard. Deleting BEFORE resolveExited means a
      // concurrent _stop sees an empty slot (skips its own delete) but still
      // emits its idle status. Guarded by identity so a re-summon that already
      // replaced this entry is left untouched.
      void playtimeWrite.finally(() => {
        if (sessions.get(characterId) === session) sessions.delete(characterId);
        // 260618: a mid-session crash removes a companion — refresh the roster
        // of the survivors so they stop treating this bot as present.
        broadcastRoster();
        // Party redesign §5: session ended (clean exit or crash) — clear the
        // action verb so a stale "gathering…" doesn't outlive the bot.
        opts.onBotAction?.(characterId, null, undefined, Date.now());
        session.resolveExited();
      });
    });

    // BL-01 (Phase 13 REVIEW): wire the 30-min JWT rotation pump for
    // cloud-proxy sessions. The pump:
    //   - fires once IMMEDIATELY (seed) to give the bot a fresh JWT,
    //   - then every 30 min (well within the 1h Supabase JWT expiry),
    //   - posts `{kind:'cloud-jwt-update', jwt}` onto port1 → bot's
    //     parentPort handler calls _running.setAuthToken (BL-02 fix).
    // Lifecycle: the teardown closure is stored on `session` so `_stop`
    // calls it BEFORE port1.close(). BYOK sessions skip the pump entirely.
    // Runs AFTER all child event registrations — this `await import` was the
    // first async gap that could swallow the one-shot 'spawn' event.
    if (aiBackendKind === 'cloud-proxy') {
      try {
        const { setupJwtRotation } = await import('./auth/proxyJwtFetcher');
        session.teardownJwtRotation = setupJwtRotation(port1);
      } catch (err) {
        // The pump is a safety net — if the dynamic import fails for any
        // reason (path mismatch in a packaged build, module load error),
        // we log and keep going. The bot will still receive JWTs via
        // updateJwt() on TOKEN_REFRESHED ticks.
        logger.warn(
          `setupJwtRotation failed to load — continuing without rotation pump: ${(err as Error).message}`,
        );
      }
    }

    // Wait for summon-ready or fail
    try {
      await summonPromise;
      // 260618: the new bot is live — tell it (and every existing bot) the
      // current companion roster so they all recognize each other immediately.
      broadcastRoster();
    } catch (err) {
      // Cleanup on failure
      // BL-01: tear down the rotation pump first — same ordering as
      // _stopActive, so a pending tick doesn't postMessage onto a port
      // we're about to close.
      try { session.teardownJwtRotation?.(); } catch { /* best-effort */ }
      try {
        await router.close();
      } catch {
        // best-effort
      }
      try {
        port1.close();
      } catch {
        // best-effort
      }
      try {
        child.kill();
      } catch {
        // best-effort
      }
      if (sessions.get(characterId) === session) sessions.delete(characterId);
      throw err;
    }
  }

  /**
   * WR-05 follow-up: live-swap the AI backend on the RUNNING bot. Posts a
   * `{type:'backend-switch'}` message that the bot forwards into the live
   * Anthropic SDK (anthropicClient.setBackend rebuilds the SDK instance), so
   * the swap lands on the bot's NEXT Anthropic call instead of waiting for a
   * manual restart. Mirrors the credential acquisition + JWT-rotation
   * lifecycle of `_summon`, just retargeted at an already-forked child.
   */
  async function _switchBackend(kind: AiBackendKind): Promise<void> {
    if (sessions.size === 0) return; // idle — next summon reads ai_backend_kind fresh
    // Multi-summon: a backend switch is a per-account setting, so it applies to
    // EVERY running bot. Acquire the shared credential once, then fan the
    // `backend-switch` message out to each live session.
    if (kind === 'cloud-proxy') {
      // Acquire a fresh JWT for the immediate switch. Fall back to the cached
      // latestJwt if the on-demand fetch fails — the proxy then 401s and the
      // renderer's hard-stop / sign-in flow takes over, exactly as a cold
      // summon with a missing JWT does.
      let jwt = latestJwt ?? '';
      try {
        const { getProxyJwt } = await import('./auth/proxyJwtFetcher');
        jwt = await getProxyJwt();
        latestJwt = jwt;
      } catch (err) {
        logger.warn(
          `switchBackend(cloud-proxy): getProxyJwt failed, using cached token: ${(err as Error).message}`,
        );
      }
      for (const session of sessions.values()) {
        // Track the live kind so updateJwt / the reactive 401 refresh treat
        // this session as a legitimate JWT consumer from here on (260703).
        session.backendKind = 'cloud-proxy';
        try {
          session.port1.postMessage({
            type: 'backend-switch',
            cloudMode: { baseURL: PROXY_BASE_URL, authToken: jwt },
          });
        } catch {
          /* port closed during teardown — ignore */
        }
        // (Re)wire the 30-min rotation pump if this session doesn't already have
        // one (i.e. it was summoned in BYOK mode). Idempotent: a session
        // summoned in cloud-proxy mode keeps its existing pump. Set up AFTER the
        // backend-switch post so the bot is already in cloud mode before the
        // pump's seed tick lands a `cloud-jwt-update` (setAuthToken no-ops until
        // cloudMode is set).
        if (!session.teardownJwtRotation) {
          try {
            const { setupJwtRotation } = await import('./auth/proxyJwtFetcher');
            session.teardownJwtRotation = setupJwtRotation(session.port1);
          } catch (err) {
            logger.warn(
              `switchBackend(cloud-proxy): setupJwtRotation failed — continuing without rotation pump: ${(err as Error).message}`,
            );
          }
        }
      }
    } else {
      // local / BYOK. Load the key once; surface a keychain/missing-key error
      // (parity with _summon) but STILL flip every live SDK to BYOK below — the
      // dominant safety property is that a visible switch to "your own key" must
      // stop routing through the paid cloud immediately (the inverse of the
      // WR-05 surprise). Bots 401 on their next call until a key is set + re-summon.
      let apiKey = '';
      let keyError: unknown = null;
      try {
        // 260703: a MISSING key gets the same clear INVALID_API_KEY surface as
        // a cold summon (see _summon) instead of an ENOENT that classifies as
        // an opaque BOT_CRASH. The SDK still flips to BYOK below either way.
        if (!(await hasApiKey())) {
          throw new Error(
            'LOCAL_NO_API_KEY: Local mode is on but no API key is saved. Add your API key in Settings, or switch to managed billing.',
          );
        }
        apiKey = await loadApiKey();
      } catch (err) {
        keyError = err;
      }
      for (const session of sessions.values()) {
        // 260703 hard guard: flip the tracked kind FIRST so no concurrent
        // updateJwt tick can post a token to a session that is now BYOK.
        session.backendKind = 'local';
        if (keyError) {
          const message = (keyError && typeof keyError === 'object' && 'message' in keyError)
            ? String((keyError as { message: unknown }).message)
            : String(keyError);
          const ec = message.startsWith('LOCAL_NO_API_KEY')
            ? ('INVALID_API_KEY' as const)
            : classifyChildError(keyError);
          // ADVISORY, not terminal: this session STAYS LIVE — the bot remains
          // connected in-world and just 401s on its next LLM call. Flag
          // transient so broadcastStatus does not drop it from onlineIds (which
          // would silently reroute in-game chat to the standalone brain) or post
          // a spurious mid-session "played for X" row (260703).
          opts.sendStatus({
            kind: 'error',
            error: ec,
            message,
            characterId: session.characterId,
            transient: true,
          });
        }
        // Tear down the rotation pump BEFORE flipping the SDK so a pending tick
        // can't post a stray cloud-jwt-update after the switch.
        try { session.teardownJwtRotation?.(); } catch { /* best-effort */ }
        session.teardownJwtRotation = undefined;
        try {
          session.port1.postMessage({ type: 'backend-switch', apiKey });
        } catch {
          /* port closed during teardown — ignore */
        }
      }
    }
  }

  /**
   * 260705 (issue #6): the only public entry to `_summon`. Reserves the
   * characterId synchronously — before `_summon`'s first await — so a second
   * summon landing anywhere in the check-to-register gap joins the in-flight
   * attempt (same promise, same outcome) instead of forking a duplicate child.
   */
  function summon(characterId: string): Promise<void> {
    const pending = pendingSummons.get(characterId);
    if (pending) return pending;
    const attempt = _summon(characterId).finally(() => {
      if (pendingSummons.get(characterId) === attempt) pendingSummons.delete(characterId);
      pendingUsernames.delete(characterId);
    });
    pendingSummons.set(characterId, attempt);
    return attempt;
  }

  return {
    summon,
    stop: (characterId?: string) =>
      characterId ? _stop(characterId, STOP_TIMEOUT_MS) : _stopAll(STOP_TIMEOUT_MS),
    switchBackend: _switchBackend,
    getActiveId: () => {
      const first = sessions.keys().next();
      return first.done ? null : first.value;
    },
    getActiveIds: () => [...sessions.keys()],
    // Pending (pre-registration) summons count as active: every isActive gate
    // is a "refuse while the bot is running" check (delete / reset memory /
    // skin swaps), and a character mid-summon is about to be running — letting
    // those proceed in the fork window would race the boot's memory reads.
    isActive: (characterId: string) => sessions.has(characterId) || pendingSummons.has(characterId),
    /**
     * Task 4 — route an in-app chat message INTO a live game session so both
     * surfaces share one conversation (same brain + prompt cache). Posts a
     * `sei-chat` command over the port; the bot injects it as a priority chat
     * event and replies back over the `type:'chat'` lifecycle. Returns false
     * (caller falls back to the standalone chat brain) if no session is live.
     */
    sendSeiChat: (characterId: string, payload: { from: string; text: string; voice?: boolean }): boolean => {
      const session = sessions.get(characterId);
      if (!session) return false;
      try {
        session.port1.postMessage({
          type: 'sei-chat',
          from: payload.from,
          text: payload.text,
          // 260708: a live voice-call utterance, not an out-of-band app text.
          // The bot frames it as in-game speech instead of "Sei chat".
          voice: payload.voice === true,
        });
        return true;
      } catch {
        return false;
      }
    },
    /**
     * 260708: record-only mirror of a group-call line into a live session's
     * chat history (a sibling companion's spoken line, or a player line routed
     * to another bot). The bot records it without waking, except a companion
     * line that names this bot (directed request). False → no live session.
     */
    observeSeiChat: (characterId: string, payload: { from: string; text: string }): boolean => {
      const session = sessions.get(characterId);
      if (!session) return false;
      try {
        session.port1.postMessage({ type: 'sei-chat-observe', from: payload.from, text: payload.text });
        return true;
      } catch {
        return false;
      }
    },
    // Voice calls (260705): forward the open/hang-up toggle into the live
    // session. Same port-may-be-closed tolerance as sendSeiChat.
    setVoiceCall: (characterId: string, active: boolean): boolean => {
      const session = sessions.get(characterId);
      if (!session) return false;
      try {
        session.port1.postMessage({ type: 'voice-call', active });
        return true;
      } catch {
        return false;
      }
    },
    // Voice calls (260705): ask a live in-game session to greet the player
    // now that the call pipeline is live. False → caller uses the chat brain.
    greetVoiceCall: (characterId: string): boolean => {
      const session = sessions.get(characterId);
      if (!session) return false;
      try {
        session.port1.postMessage({ type: 'voice-call-greet' });
        return true;
      } catch {
        return false;
      }
    },
    shutdown: async () => {
      await _stopAll(STOP_TIMEOUT_MS);
    },
    // Plan 10-06: cache the latest JWT and, if a session is live, push it on
    // port1 with a `{type:'jwt'}` message. The utilityProcess in Phase 10
    // ignores the message — that's expected; Phase 13 wires the consumer.
    // We swallow post-message errors because the port may have closed during
    // teardown (a SIGNED_OUT-triggered updateJwt(null) can race the bot's
    // own exit handler).
    updateJwt: (jwt: string | null) => {
      latestJwt = jwt;
      for (const session of sessions.values()) {
        // 260703 hard guard: BYOK sessions never receive the Supabase token —
        // the bot-side setAuthToken already no-ops without cloudMode, but the
        // token must not cross into a local child's process at all.
        if (session.backendKind !== 'cloud-proxy') continue;
        try { session.port1.postMessage({ type: 'jwt', jwt }); }
        catch { /* port closed during teardown; ignore */ }
      }
    },
  };
}

export type { BotSupervisor as BotSupervisorType };
