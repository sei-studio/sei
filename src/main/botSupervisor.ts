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
 * Lifecycle: the supervisor owns ONE bot at a time. Switching characters
 * stops the current bot (10s budget) before starting the new one.
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
import type { Character } from '../shared/characterSchema';
import { getCharacter, saveCharacter } from './characterStore';
import { loadApiKey, getAiBackendKind, type AiBackendKind } from './apiKeyStore';
import { loadConfig as loadUserConfig } from './configStore'; // UserConfig (mc_username, preferred_name) for bot init
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
   * signed-in account is on the cloud-proxy backend AND its ledger is exhausted
   * (balance 0 / plan='depleted'). `_summon` consults this BEFORE forking a
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
}

export interface BotSupervisor {
  summon(characterId: string): Promise<void>;
  stop(): Promise<void>;
  getActiveId(): string | null;
  /** For app.before-quit cleanup. Drains any active session with the stop timeout. */
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
}

interface ActiveSession {
  characterId: string;
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
}

export function createBotSupervisor(opts: BotSupervisorOptions): BotSupervisor {
  let active: ActiveSession | null = null;
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
        return { kind: 'connecting' };
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

  async function _stopActive(timeoutMs: number): Promise<void> {
    if (!active) return;
    const session = active;
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
    if (active === session) active = null;
    opts.sendStatus({ kind: 'idle' });
  }

  async function _summon(characterId: string): Promise<void> {
    // D-16: stop current bot first if any (graceful disconnect via bot.quit
    // before a fresh fork — guarantees ONE bot at a time).
    if (active) {
      await _stopActive(STOP_TIMEOUT_MS);
    }

    const character: Character | null = await getCharacter(characterId);
    if (!character) throw new Error(`Character not found: ${characterId}`);

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
        opts.emitHardStop({ reason: 'depleted' });
        opts.sendStatus({ kind: 'idle' });
        throw new Error('CLOUD_CREDITS_DEPLETED');
      }
    } else {
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
    // Phase 15 (D-05): bridge the user-facing auto-render toggle from UserConfig
    // into the bot's config.vision.auto_render at fork time. The renderer never
    // talks to the bot ConfigSchema directly — main is the translator. Only
    // auto_render is user-toggled in v1.0; the other vision knobs
    // (render_interval_ms, image_quality, resolution_px cap, explicit_cap_per_hour)
    // come from the bot config.json defaults. Defaults to false when the field
    // is absent (pre-Phase-15 config.json), matching the schema default.
    const visionAutoRender = userCfg.vision_auto_render === true;
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
    opts.sendStatus({ kind: 'connecting' });

    const router = await createLogRouter({ characterId, sendBatch: opts.sendLog });
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
      startedAtMs,
      child,
      port1,
      router,
      exited: exitedP,
      resolveExited,
    };
    active = session;

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
      if (data.type === 'summon-ready' && !summonResolved) {
        summonResolved = true;
        clearTimeout(summonTimer);
        // Stamp last_launched on successful connect — never-launched personas
        // still show '—' until they reach summon-ready at least once.
        void (async () => {
          try {
            const c = await getCharacter(characterId);
            if (c) await saveCharacter({ ...c, last_launched: new Date().toISOString() });
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

    child.once('spawn', () => {
      // Ship mc_username, preferred_name, and skinServerBaseUrl so the bot
      // can satisfy ConfigSchema, seed player_username for player-recognition
      // without disk reads, and log the skin server URL for verification.
      // The bot itself never hits the skin server — the consumer is the host
      // MC client via CustomSkinLoader. character.username is preferred over
      // sanitizeMcName(character.name) so each persona connects under its
      // own in-game name.
      child.postMessage(
        {
          type: 'init',
          character,
          apiKey,
          lanPort,
          // Profile-scoped root — the bot resolves memory under this dir, so it
          // must be the active account's profile (paths.profileRoot()), never
          // the device-global userData root.
          userDataDir: paths.profileRoot(),
          mc_username,
          preferred_name,
          // Phase 15 (D-05): the bridged auto-render toggle. The bot's
          // bootstrapWithInit reads this into config.vision.auto_render before
          // ConfigSchema.parse. undefined/absent → false (auto-render OFF).
          visionAutoRender,
          skinServerBaseUrl: opts.getSkinServerBaseUrl(),
          // Plan 10-06: ship the latest known JWT so a bot summoned while
          // signed_in has a token in hand before TOKEN_REFRESHED fires. Phase
          // 13 reads this; in Phase 10 the bot loop ignores it.
          initialJwt: latestJwt,
          // Phase 13-15 (PROXY-07): when the user has selected cloud-proxy as
          // their AI backend, ship the proxy baseURL + initial Supabase JWT.
          // The bot constructs the Anthropic SDK with
          // {baseURL, authToken, apiKey:null} so all Anthropic traffic flows
          // through Sei's Fly.io proxy (D-40 sub-delivery a). undefined here
          // means BYOK — bot uses the legacy `apiKey` path.
          cloudMode,
        },
        [port2],
      );
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
                const c = await getCharacter(characterId);
                if (c) {
                  await saveCharacter({
                    ...c,
                    playtime_ms: (c.playtime_ms ?? 0) + sessionMs,
                  });
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
      }
      // Resolve `exited` only AFTER the playtime write lands. _stopActive awaits
      // `exited` before emitting the idle status, and the renderer refreshes the
      // character's last_launched / total playtime when it sees idle — so the
      // store must already reflect this session's playtime by that point.
      void playtimeWrite.finally(() => session.resolveExited());
    });

    // Wait for summon-ready or fail
    try {
      await summonPromise;
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
      if (active === session) active = null;
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
    if (!active) return; // idle — next summon reads ai_backend_kind fresh
    const session = active;
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
    } else {
      // local / BYOK. Tear down the rotation pump BEFORE flipping the SDK so a
      // pending tick can't post a stray cloud-jwt-update after the switch.
      try { session.teardownJwtRotation?.(); } catch { /* best-effort */ }
      session.teardownJwtRotation = undefined;
      let apiKey = '';
      try {
        apiKey = await loadApiKey();
      } catch (err) {
        // Surface the keychain / missing-key error (parity with _summon), but
        // STILL flip the live SDK to BYOK with an empty key below: the
        // dominant safety property is that a visible switch to "your own key"
        // must stop routing through the paid cloud immediately (the inverse of
        // the WR-05 surprise). The bot 401s on its next call until the user
        // sets a key + re-summons.
        const ec = classifyChildError(err);
        const message = (err && typeof err === 'object' && 'message' in err)
          ? String((err as { message: unknown }).message)
          : String(err);
        opts.sendStatus({ kind: 'error', error: ec, message, characterId: session.characterId });
      }
      try {
        session.port1.postMessage({ type: 'backend-switch', apiKey });
      } catch {
        /* port closed during teardown — ignore */
      }
    }
  }

  return {
    summon: _summon,
    stop: () => _stopActive(STOP_TIMEOUT_MS),
    switchBackend: _switchBackend,
    getActiveId: () => active?.characterId ?? null,
    shutdown: async () => {
      if (active) await _stopActive(STOP_TIMEOUT_MS);
    },
    // Plan 10-06: cache the latest JWT and, if a session is live, push it on
    // port1 with a `{type:'jwt'}` message. The utilityProcess in Phase 10
    // ignores the message — that's expected; Phase 13 wires the consumer.
    // We swallow post-message errors because the port may have closed during
    // teardown (a SIGNED_OUT-triggered updateJwt(null) can race the bot's
    // own exit handler).
    updateJwt: (jwt: string | null) => {
      latestJwt = jwt;
      if (active) {
        try { active.port1.postMessage({ type: 'jwt', jwt }); }
        catch { /* port closed during teardown; ignore */ }
      }
    },
  };
}

export type { BotSupervisor as BotSupervisorType };
