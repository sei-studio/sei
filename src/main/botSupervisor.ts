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
} from '../shared/ipc';
import type { Character } from '../shared/characterSchema';
import { getCharacter } from './characterStore';
import { loadApiKey } from './apiKeyStore';
import { loadConfig as loadUserConfig } from './configStore'; // BLOCKER-4: UserConfig (mc_username, preferred_name) for bot init
import { paths } from './paths';
import { createLogRouter, type LogRouter } from './logRouter';

const SUMMON_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 10_000;

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
  /** Forward to renderer via webContents.send('bot:log:batch', batch). Batched. */
  sendLog: (batch: LogBatch) => void;
  /**
   * Phase 9 (09-02): returns the loopback skin server's baseUrl (e.g.
   * 'http://127.0.0.1:54321') or null if the server failed to bind on boot.
   * Closure-via-getter so a later restart of the skin server (Plan 05 port-
   * drift recovery) is observable by subsequent summons. The bot supervisor
   * ships this into the bot init payload; the bot logs it for verification
   * (CustomSkinLoader on the host's MC client is the real consumer).
   */
  getSkinServerBaseUrl: () => string | null;
}

export interface BotSupervisor {
  summon(characterId: string): Promise<void>;
  stop(): Promise<void>;
  getActiveId(): string | null;
  /** For app.before-quit cleanup. Drains any active session with the stop timeout. */
  shutdown(): Promise<void>;
}

interface ActiveSession {
  characterId: string;
  startedAtMs: number;
  child: UtilityProcess;
  port1: Electron.MessagePortMain;
  router: LogRouter;
  exited: Promise<void>;
  resolveExited: () => void;
}

export function createBotSupervisor(opts: BotSupervisorOptions): BotSupervisor {
  let active: ActiveSession | null = null;

  const lifecycleToStatus = (
    e: BotLifecycle,
    characterId: string,
    startedAtMs: number,
  ): BotStatus | null => {
    switch (e.type) {
      case 'connected':
      case 'summon-ready':
        return { kind: 'online', uptimeMs: Date.now() - startedAtMs, characterId };
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

    // GUI-05: loadApiKey can throw KEYCHAIN_UNAVAILABLE / decrypt errors when
    // the user is locked out of their keychain. classify before forwarding so
    // the renderer's CharacterPage shows ERROR_COPY[KEYCHAIN_LOCKED] copy
    // (not the raw safeStorage stack frame).
    let apiKey: string;
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

    // BLOCKER-4 fix: load UserConfig so the bot's adapter.minecraft.username
    // (Microsoft account) and owner_username (preferred_name) are populated
    // from onboarding. ConfigSchema.parse in the bot will throw if username
    // is missing, so we refuse to fork early with a clear error.
    const userCfg = await loadUserConfig();
    const mc_username = (userCfg.mc_username ?? '').trim();
    const preferred_name = (userCfg.preferred_name ?? '').trim();
    if (!mc_username) {
      const status: BotStatus = {
        kind: 'error',
        error: 'BOT_CRASH',
        message: 'Minecraft username is missing. Re-run onboarding from Settings.',
        characterId,
      };
      opts.sendStatus(status);
      throw new Error('MC_USERNAME_MISSING');
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
    const child = utilityProcess.fork(botEntryPath(), [], {
      stdio: 'pipe', // Pitfall 2 — required for stdout/stderr access
      serviceName: `sei-bot-${characterId}`,
      env: {
        ...process.env,
        SEI_USER_DATA: paths.userData(),
        SEI_CHARACTER_ID: characterId,
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

    port1.on('message', (e: { data: BotLifecycle }) => {
      const data = e.data;
      if (data.type === 'summon-ready' && !summonResolved) {
        summonResolved = true;
        clearTimeout(summonTimer);
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

    child.once('spawn', () => {
      // BLOCKER-4 fix: ship mc_username + preferred_name from UserConfig so
      // the bot can satisfy ConfigSchema (adapter.minecraft.username) and
      // seed owner_username for owner-recognition without disk reads.
      //
      // Phase 9 (09-02): also ship skinServerBaseUrl so the bot can log it for
      // verification (the actual CustomSkinLoader consumer is the host's MC
      // client; the bot itself never hits the skin server). The bot also
      // prefers character.username over the legacy sanitizeMcName(character.name)
      // fallback so each persona connects under its own MC in-game name.
      child.postMessage(
        {
          type: 'init',
          character,
          apiKey,
          lanPort,
          userDataDir: paths.userData(),
          mc_username,
          preferred_name,
          skinServerBaseUrl: opts.getSkinServerBaseUrl(),
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
      session.resolveExited();
    });

    // Wait for summon-ready or fail
    try {
      await summonPromise;
    } catch (err) {
      // Cleanup on failure
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

  return {
    summon: _summon,
    stop: () => _stopActive(STOP_TIMEOUT_MS),
    getActiveId: () => active?.characterId ?? null,
    shutdown: async () => {
      if (active) await _stopActive(STOP_TIMEOUT_MS);
    },
  };
}

export type { BotSupervisor as BotSupervisorType };
