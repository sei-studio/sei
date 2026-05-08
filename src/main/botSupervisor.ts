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
  // In dev: __dirname is dist/main; bot lives at src/bot/index.js relative
  // to repo root. electron-vite's main bundle preserves this layout.
  return path.join(__dirname, '../bot/index.js');
}

export interface BotSupervisorOptions {
  /** Returns the cached LAN port if connected, null otherwise. Wired by main. */
  getLanPort: () => number | null;
  /** Forward to renderer via webContents.send('bot:status', status). */
  sendStatus: (status: BotStatus) => void;
  /** Forward to renderer via webContents.send('bot:log:batch', batch). Batched. */
  sendLog: (batch: LogBatch) => void;
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

    const apiKey = await loadApiKey(); // throws if missing/locked — caller maps to ErrorClass

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

    // stdout/stderr line-split → router
    const buffers = { stdout: '', stderr: '' };
    const sink = (chunk: Buffer, key: 'stdout' | 'stderr') => {
      const text = buffers[key] + chunk.toString('utf-8');
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
      const status = lifecycleToStatus(data, characterId, startedAtMs);
      if (status) opts.sendStatus(status);
    });
    port1.start();

    child.once('spawn', () => {
      // BLOCKER-4 fix: ship mc_username + preferred_name from UserConfig so
      // the bot can satisfy ConfigSchema (adapter.minecraft.username) and
      // seed owner_username for owner-recognition without disk reads.
      child.postMessage(
        {
          type: 'init',
          character,
          apiKey,
          lanPort,
          userDataDir: paths.userData(),
          mc_username,
          preferred_name,
        },
        [port2],
      );
    });

    child.on('exit', (code) => {
      if (!summonResolved) {
        summonResolved = true;
        clearTimeout(summonTimer);
        summonReject(new Error(`Bot exited before summon-ready (code=${code ?? 'null'})`));
      }
      session.resolveExited();
    });
    child.on('error', (err: Error) => {
      logger.error(`bot child error: ${err.message}`);
      if (!summonResolved) {
        summonResolved = true;
        clearTimeout(summonTimer);
        summonReject(err);
      }
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
