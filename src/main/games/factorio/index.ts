/**
 * Factorio GameModule (261113): the main-process side of the Factorio
 * adapter, registered from src/main/index.ts beside the other games.
 *
 * Owns install detection, the sei-companion mod install, starting Factorio
 * with the Sei link (`--enable-lua-udp <port>`), the port it chose (in
 * memory and in <userData>/factorio-link.json), and the hello watcher. The
 * bot runtime (src/bot/adapter/factorio/runtime.js) gets `{port, label}` as
 * its join target and speaks the protocol itself; nothing here drives the
 * companion.
 *
 * Up to 3 companions per player fit (the mod's cap, enforced mod-side), so
 * `maxBodies` is left unset: the supervisor only enforces a cap of 1.
 */
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { Character } from '../../../shared/characterSchema';
import type { WorldState } from '../../../shared/gameIpc';
import type { FactorioActionFailure, FactorioActionResult, FactorioJoinTarget, FactorioSetupState, FactorioWorldState } from '../../../shared/factorioIpc';
import type { GameInstall, GameJoinContext, GameModule } from '../index';
import { stardewNameFromRaw } from '../../../bot/names.js';
import {
  FactorioInstallError,
  defaultInstallDeps,
  detectFactorio,
  installMod,
  modIsCurrent,
  publicState,
  type FactorioCandidate,
  type FactorioInstallDeps,
} from './install';
import { findSteamExe, launchPlan, spawnPlan, watchLinkLog, type LaunchPlan, type LogWatchDeps } from './launch';
import { createLinkStore, pickLinkPort, type LinkStore } from './link';
import { createFactorioWatcher, type FactorioWatcher, type ProbeResult } from './watcher';
import { createDedupedSink, trackSetupStep, type SetupSink } from '../../setupTelemetry';
import { classifyFailReason, type FailReason } from '../../../shared/setupTelemetry';

/**
 * The companion's in-game name. MIRROR of botUsernameFor in
 * src/bot/adapter/factorio/runtime.js (which reuses stardewNameFromRaw), so
 * the supervisor's collision guard sees the name the mod will show.
 */
export function effectiveFactorioName(c: Pick<Character, 'username' | 'name'>): string {
  const raw = (c.username ?? '').trim() || String(c.name || '');
  return stardewNameFromRaw(raw);
}

export const FACTORIO_NOT_OPEN_MESSAGE =
  'GAME_WORLD_NOT_OPEN: No Factorio game is open with the Sei link. Start Factorio from Sei (Launch Factorio), load a save or start a new game, then press Launch again.';

type Detected = FactorioSetupState & { candidate?: FactorioCandidate };

export interface FactorioModuleDeps {
  install: FactorioInstallDeps;
  links: LinkStore;
  /** Pack root holding the mod (packs.ts ensurePack; the repo root in dev). */
  getPackRoot(): Promise<string>;
  probe?: (port: number) => Promise<ProbeResult>;
  spawn(plan: LaunchPlan): Promise<void>;
  isPortFree?: (port: number) => Promise<boolean>;
  logWatch: LogWatchDeps;
  intervalMs?: number;
  log?: (msg: string) => void;
  /** game_setup_step sink (shape only; analytics sends nothing from dev builds). */
  track?: SetupSink;
}

/** The setup telemetry error code for an action failure (UPPER_SNAKE). */
function failCode(reason: FactorioActionFailure): string {
  return `FACTORIO_${reason.toUpperCase()}`;
}

function failReason(reason: FactorioActionFailure, message: string): FailReason {
  if (reason === 'game_running') return 'game_running';
  if (reason === 'not_found') return 'not_found';
  return classifyFailReason(message);
}

function defaultDeps(): FactorioModuleDeps {
  return {
    install: defaultInstallDeps(),
    links: createLinkStore(),
    getPackRoot: async () => (await import('../packs')).ensurePack('factorio'),
    spawn: spawnPlan,
    logWatch: {
      readText: async (p) => defaultInstallDeps().readText(p),
      mtime: async (p) => {
        try {
          return (await stat(p)).mtimeMs;
        } catch {
          return null;
        }
      },
      setTimer: (fn, ms) => {
        const t = setTimeout(fn, ms);
        if (typeof t.unref === 'function') t.unref();
        return t;
      },
      clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
      now: () => Date.now(),
    },
    log: (m) => console.log(`[sei/factorio] ${m}`),
    track: trackSetupStep,
  };
}

export interface FactorioGameModule extends GameModule {
  /** Fresh detection (no writes). */
  getSetupState(): Promise<FactorioSetupState>;
  /** Copy + enable the mod. Refused while Factorio runs. */
  runInstall(): Promise<FactorioActionResult>;
  /** Install/update the mod as needed, pick a port, start Factorio with the link. */
  runLaunch(): Promise<FactorioActionResult>;
  readonly watcherFactorio: FactorioWatcher;
}

export function createFactorioGameModule(overrides: Partial<FactorioModuleDeps> = {}): FactorioGameModule {
  const deps: FactorioModuleDeps = { ...defaultDeps(), ...overrides };
  const log = deps.log ?? (() => {});
  /** The port Factorio was last started with (this run, else the saved one). */
  let port: number | null = null;
  let portLoaded = false;
  /** Factorio logged that `port` could not be opened. Cleared by the next launch. */
  let portInUse = false;
  let lastDetect: Detected | null = null;
  let logWatch: { stop(): void } | null = null;
  let onUpdate: ((s: WorldState) => void) | null = null;
  let actionInFlight: Promise<FactorioActionResult> | null = null;
  const track: SetupSink = (input) => {
    try {
      deps.track?.(input);
    } catch {
      /* telemetry never breaks setup */
    }
  };
  const trackOnce = createDedupedSink(track);
  /** When this process last started Factorio (world_seen wait_ms). */
  let launchedAt: number | null = null;
  let worldSeen = false;

  async function loadPort(): Promise<void> {
    if (portLoaded) return;
    portLoaded = true;
    try {
      const rec = await deps.links.read();
      if (port == null) port = rec.port;
    } catch {
      /* no saved port */
    }
  }

  const watcher = createFactorioWatcher({
    getPort: () => (portInUse ? null : port),
    probe: deps.probe,
    intervalMs: deps.intervalMs,
    logger: { info: log, warn: log },
  });

  function tagged(): FactorioWorldState {
    const s = watcher.latest();
    if (s.kind === 'open') return s;
    if (portInUse) return { game: 'factorio', kind: 'unavailable', reason: 'udp_port_in_use' };
    if (s.kind === 'closed' && lastDetect?.kind === 'not_found') return { game: 'factorio', kind: 'not_installed' };
    return s;
  }

  function publish(): void {
    const s = tagged();
    if (s.kind === 'open' && !worldSeen) {
      worldSeen = true;
      track({ game: 'factorio', step: 'world_seen', outcome: 'ok', wait_ms: launchedAt != null ? deps.logWatch.now() - launchedAt : null });
    }
    try {
      onUpdate?.(s);
    } catch {
      /* listener errors never break the module */
    }
  }

  async function detect(): Promise<Detected> {
    await loadPort();
    const before = tagged().kind;
    try {
      lastDetect = await detectFactorio(deps.install, { port, portInUse });
    } catch (err) {
      log(`detection failed: ${(err as Error).message}`);
      lastDetect = lastDetect ?? { kind: 'not_found', searched: [] };
    }
    if (tagged().kind !== before) publish();
    const d = lastDetect;
    if (d.kind === 'not_found') {
      trackOnce('find_game', 'none', { game: 'factorio', step: 'find_game', outcome: 'fail', error_code: 'GAME_NOT_INSTALLED', reason: 'not_found' });
    } else {
      trackOnce('find_game', `${d.install.store}|${d.install.supported}`, {
        game: 'factorio',
        step: 'find_game',
        outcome: 'ok',
        store: d.install.store,
        version_ok: d.install.supported,
      });
    }
    return d;
  }

  function fail(reason: FactorioActionFailure, message: string, state: Detected | null): Extract<FactorioActionResult, { ok: false }> {
    return { ok: false, reason, message, state: state ? publicState(state) : null };
  }

  function storeOf(s: Detected | null): string | null {
    return s?.kind === 'found' ? s.install.store : null;
  }

  /** Send the outcome of one action step and pass the result through. */
  function tracked(step: 'mod_copy' | 'launch', s: Detected | null, r: FactorioActionResult): FactorioActionResult {
    if (r.ok) track({ game: 'factorio', step, outcome: 'ok', store: storeOf(s) });
    else track({ game: 'factorio', step, outcome: 'fail', store: storeOf(s), error_code: failCode(r.reason), reason: failReason(r.reason, r.message) });
    return r;
  }

  function preflight(s: Detected): FactorioActionResult | null {
    if (s.kind !== 'found' || !s.candidate) return fail('not_found', 'GAME_NOT_INSTALLED: Factorio was not found on this computer.', s);
    if (s.install.supported === false) {
      return fail('unsupported_version', `Factorio ${s.install.version ?? '?'} is installed; the Sei mod needs Factorio 2.1.`, s);
    }
    return null;
  }

  async function doInstall(s: Detected): Promise<FactorioActionResult> {
    if (s.kind !== 'found') return fail('not_found', 'GAME_NOT_INSTALLED: Factorio was not found on this computer.', s);
    track({ game: 'factorio', step: 'mod_copy', outcome: 'start', store: storeOf(s) });
    return tracked('mod_copy', s, await copyMod(s));
  }

  async function copyMod(s: Extract<Detected, { kind: 'found' }>): Promise<FactorioActionResult> {
    try {
      const packRoot = await deps.getPackRoot();
      const r = await installMod({ packRoot, modsDir: s.modsDir }, deps.install);
      log(`mod ${r.folder} installed in ${s.modsDir}`);
      return { ok: true, state: publicState(await detect()) };
    } catch (err) {
      if (err instanceof FactorioInstallError) return fail(err.reason, err.message, s);
      return fail('failed', `GAME_PACK_DOWNLOAD_FAILED: ${(err as Error).message}`, s);
    }
  }

  function single(fn: () => Promise<FactorioActionResult>): Promise<FactorioActionResult> {
    if (actionInFlight) return actionInFlight;
    actionInFlight = fn().finally(() => {
      actionInFlight = null;
    });
    return actionInFlight;
  }

  async function runInstall(): Promise<FactorioActionResult> {
    return single(async () => {
      const s = await detect();
      const pre = preflight(s);
      if (pre) return pre;
      if (s.kind === 'found' && s.gameRunning === true) {
        return tracked('mod_copy', s, fail('game_running', 'Factorio is running. Close it, then add the mod again.', s));
      }
      return doInstall(s);
    });
  }

  async function runLaunch(): Promise<FactorioActionResult> {
    return single(async () => {
      track({ game: 'factorio', step: 'launch', outcome: 'start' });
      let detected: Detected | null = null;
      const r = await launchOnce((d) => (detected = d));
      return tracked('launch', detected, r);
    });
  }

  async function launchOnce(seen: (s: Detected) => void): Promise<FactorioActionResult> {
    let s = await detect();
    seen(s);
    const pre = preflight(s);
    if (pre) return pre;
    if (s.kind !== 'found' || !s.candidate) return fail('not_found', 'GAME_NOT_INSTALLED: Factorio was not found on this computer.', s);
    if (s.gameRunning === true) {
      return fail('game_running', 'Factorio is already running. Close it first: it has to start from Sei so the companion can connect.', s);
    }
    // Bring the mod up to the pack's version (or put it in) while the game is closed.
    let current = false;
    try {
      current = await modIsCurrent(await deps.getPackRoot(), s.modsDir, deps.install);
    } catch {
      current = false;
    }
    if (!current) {
      const r = await doInstall(s);
      if (!r.ok) return r;
      s = (await detect()) as Detected;
      if (s.kind !== 'found' || !s.candidate) return fail('not_found', 'GAME_NOT_INSTALLED: Factorio was not found on this computer.', s);
    }
    const rec = await deps.links.read().catch(() => ({ port: null, bad: [] as number[] }));
    const chosen = await pickLinkPort(rec, deps.isPortFree);
    if (chosen == null) return fail('no_free_port', 'No free local port for the Sei link (34990 to 34999 are all taken).', s);
    const steamExe = deps.install.platform === 'win32' && s.candidate.store === 'steam' ? await findSteamExe(deps.install) : null;
    const plan = launchPlan(s.candidate, chosen, deps.install.platform, steamExe);
    const startedAt = deps.logWatch.now();
    try {
      await deps.spawn(plan);
    } catch (err) {
      return fail('failed', `Factorio did not start: ${(err as Error).message}`, s);
    }
    log(`started Factorio (${plan.via}) with the Sei link on UDP ${chosen}`);
    launchedAt = startedAt;
    port = chosen;
    portLoaded = true;
    portInUse = false;
    await deps.links.write({ port: chosen, bad: rec.bad.filter((p) => p !== chosen) }).catch(() => undefined);
    logWatch?.stop();
    const logPath = (deps.install.platform === 'win32' ? path.win32 : path.posix).join(s.userDataDir, 'factorio-current.log');
    logWatch = watchLinkLog(
      logPath,
      {
        since: startedAt,
        onFailure: () => {
          log(`Factorio could not open the Lua UDP socket on ${chosen}; the next launch picks another port`);
          if (port === chosen) portInUse = true;
          track({ game: 'factorio', step: 'link_port', outcome: 'fail', error_code: 'FACTORIO_UDP_PORT_IN_USE', store: storeOf(s) });
          void deps.links
            .read()
            .then((r) => deps.links.write({ port: null, bad: [...r.bad.filter((p) => p !== chosen), chosen] }))
            .catch(() => undefined);
          publish();
        },
      },
      deps.logWatch,
    );
    void watcher.checkNow().catch(() => undefined);
    publish();
    return { ok: true, state: publicState({ ...s, port: chosen, portInUse: false, gameRunning: true }), port: chosen };
  }

  const install: GameInstall = {
    detect: async () => {
      const s = await detect();
      return { installed: s.kind === 'found' && s.modInstalled, detail: publicState(s) as unknown as Record<string, unknown> };
    },
    install: async () => {
      const r = await runInstall();
      if (!r.ok) throw new Error(r.message);
    },
    // Copying the mod in also writes mod-list.json; there is no separate enable.
    enable: async () => {},
    launch: async () => {
      const r = await runLaunch();
      if (!r.ok) throw new Error(r.message);
    },
  };

  const mod: FactorioGameModule = {
    id: 'factorio',
    displayName: 'Factorio',
    effectiveUsername: (c) => effectiveFactorioName(c),
    collides: (a, b) => a.toLowerCase() === b.toLowerCase(),
    watcher: {
      start({ onUpdate: cb }) {
        onUpdate = cb;
        void loadPort().finally(() => {
          watcher.start({ onUpdate: () => publish() });
          void detect().catch(() => undefined);
        });
      },
      async checkNow() {
        await loadPort();
        await watcher.checkNow().catch(() => undefined);
        if (lastDetect == null || lastDetect.kind !== 'found') await detect().catch(() => undefined);
        return tagged();
      },
      stop() {
        watcher.stop();
        logWatch?.stop();
        logWatch = null;
        onUpdate = null;
      },
    },
    getWorldState: tagged,
    getJoinTarget(_ctx: GameJoinContext): FactorioJoinTarget | null {
      const s = watcher.latest();
      if (s.kind !== 'open') return null;
      return { port: s.port, label: s.label };
    },
    joinTargetMissingError: { error: 'GAME_WORLD_NOT_OPEN', message: FACTORIO_NOT_OPEN_MESSAGE },
    install,
    getSetupState: async () => publicState(await detect()),
    runInstall,
    runLaunch,
    get watcherFactorio() {
      return watcher;
    },
  };
  return mod;
}
