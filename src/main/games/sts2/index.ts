/**
 * Slay the Spire 2 GameModule (261115): the main-process side of the StS2
 * adapter, registered from src/main/index.ts beside the other games.
 *
 * Owns install detection, the Sei mod copy, starting the player's game
 * through Steam, the heartbeat watcher (status files from the mod, link.ts),
 * and per session: a fresh link port + token written to link.json and the
 * companion's own game window (launch.ts), closed again when the session
 * ends. The bot runtime (src/bot/adapter/sts2/runtime.js) listens on the
 * port; the mod in the companion's window connects to it and is her seat.
 *
 * The world is "open" when the player's window hosts a Sei co-op lobby or
 * run over the game's localhost ENet transport (the mod's "Play with ..."
 * button), because that is what the companion window's `-fastmp join` can
 * join. One companion window per run for now (maxBodies 1).
 */
import path from 'node:path';
import type { Character } from '../../../shared/characterSchema';
import type { WorldState } from '../../../shared/gameIpc';
import {
  STS2_STATUS_STALE_MS,
  STS2_LINK_PORT_FIRST,
  type Sts2ActionFailure,
  type Sts2ActionResult,
  type Sts2JoinTarget,
  type Sts2SetupState,
  type Sts2StatusFile,
  type Sts2WorldState,
} from '../../../shared/sts2Ipc';
import type { GameInstall, GameJoinContext, GameModule } from '../index';
import type { MacGrant } from '../dontstarve/install';
import { stardewNameFromRaw } from '../../../bot/names.js';
import {
  MOD_FILES,
  Sts2InstallError,
  defaultInstallDeps,
  findSts2Install,
  installMod,
  modStatus,
  resolveModSource,
  writeJsonAtomic,
  type Sts2Found,
  type Sts2InstallDeps,
} from './install';
import { LINK_FILE, linkDirFor, newToken, parseStatus, pickLinkPort, statusFile, type LinkRecord } from './link';
import { STEAM_RUN_URL, spawnCompanionWindow, type CompanionWindow } from './launch';
import { createDedupedSink, trackSetupStep, type SetupSink } from '../../setupTelemetry';
import { classifyFailReason, type FailReason } from '../../../shared/setupTelemetry';

/** MIRROR of botUsernameFor in src/bot/adapter/sts2/runtime.js. */
export function effectiveSts2Name(c: Pick<Character, 'username' | 'name'>): string {
  const raw = (c.username ?? '').trim() || String(c.name || '');
  return stardewNameFromRaw(raw);
}

export const STS2_NOT_OPEN_MESSAGE =
  'GAME_WORLD_NOT_OPEN: No Slay the Spire 2 co-op lobby is open for the companion. Start Slay the Spire 2, click "Play with Sei" in the main menu, then press Launch again.';

export const POLL_MS = 2_000;

/** Pure: the player's window heartbeat as a world state. */
export function worldFromStatus(host: Sts2StatusFile | null, now: number, installed: boolean | null): Sts2WorldState {
  if (host && now - host.ts < STS2_STATUS_STALE_MS) {
    if (host.lobby === 'enet') {
      return {
        game: 'sts2',
        kind: 'open',
        label: 'Slay the Spire 2',
        lastSeenAt: host.ts,
        detail: { screen: host.screen, players: host.players, inRun: host.in_run },
      };
    }
    return { game: 'sts2', kind: 'no_lobby', screen: host.screen, lobby: host.lobby };
  }
  return installed === false ? { game: 'sts2', kind: 'not_installed' } : { game: 'sts2', kind: 'closed' };
}

export interface Sts2ModuleDeps {
  install: Sts2InstallDeps;
  /** Pack root holding assets/sts2-mod (packs.ts ensurePack; the repo root in dev). */
  getPackRoot(): Promise<string>;
  /** The link folder (link.ts linkDirFor). */
  linkDir: string;
  readText(p: string): Promise<string | null>;
  writeJson(p: string, value: unknown): Promise<void>;
  pickPort(): Promise<number | null>;
  token(): string;
  openExternal(url: string): Promise<void>;
  spawnCompanion(binary: string): CompanionWindow;
  now(): number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(t: unknown): void;
  log?: (msg: string) => void;
  track?: SetupSink;
}

function defaultDeps(): Sts2ModuleDeps {
  const install = defaultInstallDeps();
  const log = (m: string) => console.log(`[sei/sts2] ${m}`);
  return {
    install,
    getPackRoot: async () => (await import('../packs')).ensurePack('sts2'),
    linkDir: linkDirFor(install.platform, install.home, install.env),
    readText: install.readText,
    writeJson: writeJsonAtomic,
    pickPort: () => pickLinkPort(),
    token: newToken,
    openExternal: async (url) => {
      const { shell } = await import('electron');
      await shell.openExternal(url);
    },
    spawnCompanion: (binary) => spawnCompanionWindow(binary, { log }),
    now: () => Date.now(),
    setInterval: (fn, ms) => {
      const t = setInterval(fn, ms);
      if (typeof t.unref === 'function') t.unref();
      return t;
    },
    clearInterval: (t) => clearInterval(t as ReturnType<typeof setInterval>),
    log,
    track: trackSetupStep,
  };
}

export interface Sts2GameModule extends GameModule {
  getSetupState(): Promise<Sts2SetupState>;
  /** Copy the mod in. Refused while the game runs. `grant` = a click in Sei on macOS. */
  runInstall(opts?: { grant?: MacGrant }): Promise<Sts2ActionResult>;
  /** Install or update the mod as needed (game closed), then start the game through Steam. */
  runStartGame(opts?: { grant?: MacGrant }): Promise<Sts2ActionResult>;
  /** Test seam: one watcher pass. */
  pollNow(): Promise<void>;
}

export function createSts2GameModule(overrides: Partial<Sts2ModuleDeps> = {}): Sts2GameModule {
  const deps: Sts2ModuleDeps = { ...defaultDeps(), ...overrides };
  const log = deps.log ?? (() => {});
  const track: SetupSink = (input) => {
    try {
      deps.track?.(input);
    } catch {
      /* telemetry never breaks setup */
    }
  };
  const trackOnce = createDedupedSink(track);

  let found: Sts2Found | null = null;
  let installed: boolean | null = null;
  let host: Sts2StatusFile | null = null;
  let seat: Sts2StatusFile | null = null;
  let world: Sts2WorldState = { game: 'sts2', kind: 'closed' };
  let onUpdate: ((s: WorldState) => void) | null = null;
  let timer: unknown = null;
  let grantNeeded = false;
  let packRoot: string | null = null;
  let actionInFlight: Promise<Sts2ActionResult> | null = null;
  /** The companion window Sei started, and for whom. */
  let companion: { window: CompanionWindow; characterId: string } | null = null;
  let session: { characterId: string; link: LinkRecord } | null = null;
  let startedGameAt: number | null = null;
  let modLoadedSeen = false;
  let lobbySeen = false;

  const p = (): typeof path.posix => (deps.install.platform === 'win32' ? path.win32 : path.posix);

  async function readStatuses(): Promise<void> {
    const [h, s] = await Promise.all([
      deps.readText(p().join(deps.linkDir, statusFile('host'))),
      deps.readText(p().join(deps.linkDir, statusFile('seat'))),
    ]);
    host = parseStatus(h, 'host');
    seat = parseStatus(s, 'seat');
  }

  const fresh = (s: Sts2StatusFile | null): boolean => s != null && deps.now() - s.ts < STS2_STATUS_STALE_MS;

  function publish(): void {
    const next = worldFromStatus(host, deps.now(), installed);
    const changed = JSON.stringify({ ...next, lastSeenAt: 0 }) !== JSON.stringify({ ...world, lastSeenAt: 0 });
    world = next;
    if (fresh(host) && !modLoadedSeen) {
      modLoadedSeen = true;
      track({ game: 'sts2', step: 'mod_loaded', outcome: 'ok', wait_ms: startedGameAt != null ? deps.now() - startedGameAt : null });
    }
    if (world.kind === 'open' && !lobbySeen) {
      lobbySeen = true;
      track({ game: 'sts2', step: 'lobby_seen', outcome: 'ok', wait_ms: startedGameAt != null ? deps.now() - startedGameAt : null });
    }
    if (changed) {
      try {
        onUpdate?.(world);
      } catch {
        /* listener errors never break the module */
      }
    }
  }

  async function pollNow(): Promise<void> {
    await readStatuses().catch(() => undefined);
    publish();
  }

  async function detect(): Promise<Sts2SetupState> {
    let searched: string[] = [];
    try {
      const r = await findSts2Install(deps.install);
      found = r.found;
      searched = r.searched;
    } catch (err) {
      log(`detection failed: ${(err as Error).message}`);
      found = null;
    }
    await readStatuses().catch(() => undefined);
    if (!found) {
      installed = false;
      trackOnce('find_game', 'none', { game: 'sts2', step: 'find_game', outcome: 'fail', error_code: 'GAME_NOT_INSTALLED', reason: 'not_found' });
      publish();
      return { kind: 'not_found', searched };
    }
    installed = true;
    trackOnce('find_game', found.store, { game: 'sts2', step: 'find_game', outcome: 'ok', store: found.store });
    const src = packRoot ? await resolveModSource(packRoot, deps.install).catch(() => null) : null;
    const mod = await modStatus(found.modsDir, src, deps.install);
    if (grantNeeded && mod.installed && (src == null || mod.current)) grantNeeded = false;
    publish();
    return {
      kind: 'found',
      install: { gameDir: found.gameDir, binary: found.binary, store: found.store },
      modsDir: found.modsDir,
      modInstalled: mod.installed,
      modVersion: mod.version,
      // Without the pack at hand (no install or launch yet this run) an installed mod counts as current.
      modCurrent: mod.installed && (src == null || mod.current),
      // The installed build has run at least once: its heartbeat carries the same version.
      modLoaded: mod.installed && [host, seat].some((s) => s != null && s.version === mod.version),
      gameRunning: fresh(host),
      lobbyOpen: world.kind === 'open',
      companionRunning: (companion?.window.alive() ?? false) || fresh(seat),
      grantNeeded,
    };
  }

  function fail(reason: Sts2ActionFailure, message: string, state: Sts2SetupState | null): Sts2ActionResult {
    return { ok: false, reason, message, state };
  }

  function tracked(step: 'mod_copy' | 'start_game', r: Sts2ActionResult): Sts2ActionResult {
    if (r.ok) track({ game: 'sts2', step, outcome: 'ok', store: found?.store ?? null });
    else {
      const reason: FailReason = r.reason === 'game_running' ? 'game_running' : r.reason === 'not_found' ? 'not_found' : r.reason === 'permission' ? 'permission' : classifyFailReason(r.message);
      track({ game: 'sts2', step, outcome: 'fail', store: found?.store ?? null, error_code: `STS2_${r.reason.toUpperCase()}`, reason });
    }
    return r;
  }

  function single(fn: () => Promise<Sts2ActionResult>): Promise<Sts2ActionResult> {
    if (actionInFlight) return actionInFlight;
    actionInFlight = fn().finally(() => {
      actionInFlight = null;
    });
    return actionInFlight;
  }

  /** macOS App Management: the Open panel on the mods folder, then Finder. */
  async function installWithGrant(root: string, modsDir: string, grant: MacGrant): Promise<boolean> {
    const real = (x: string): Promise<string | null> =>
      grant.realpath(x).then(
        (r) => r.replace(/[\\/]+$/, '').normalize('NFC').toLowerCase(),
        () => null,
      );
    const bundle = path.dirname(path.dirname(path.dirname(modsDir))); // <app>/Contents/MacOS/mods
    const accepted = (await Promise.all([real(modsDir), real(bundle)])).filter((x): x is string => x != null);
    for (let hint = false; ; hint = true) {
      const picked = await grant.pickFolder({ defaultPath: modsDir, hint }).then(
        (x) => x,
        () => undefined,
      );
      if (picked === null) return false;
      if (picked === undefined) break;
      const chosen = await real(picked);
      if (chosen == null || !accepted.includes(chosen)) {
        if (hint) break;
        continue;
      }
      try {
        await installMod({ packRoot: root, modsDir }, deps.install);
        return true;
      } catch (err) {
        if (!(err instanceof Sts2InstallError) || err.reason !== 'permission') throw err;
        break;
      }
    }
    // Finder is exempt from App Management (one Automation prompt).
    const src = await resolveModSource(root, deps.install);
    if (!src) return false;
    try {
      await grant.finderDuplicate(
        MOD_FILES.map((f) => path.join(src, f)),
        modsDir,
      );
    } catch {
      return false;
    }
    return (await modStatus(modsDir, src, deps.install)).current;
  }

  async function copyMod(opts: { grant?: MacGrant }): Promise<Sts2ActionResult> {
    if (!found) return fail('not_found', 'GAME_NOT_INSTALLED: Slay the Spire 2 was not found on this computer.', null);
    track({ game: 'sts2', step: 'mod_copy', outcome: 'start', store: found.store });
    let root: string;
    try {
      root = await deps.getPackRoot();
      packRoot = root;
    } catch (err) {
      return tracked('mod_copy', fail('failed', `GAME_PACK_DOWNLOAD_FAILED: ${(err as Error).message}`, await detect()));
    }
    try {
      await installMod({ packRoot: root, modsDir: found.modsDir }, deps.install);
    } catch (err) {
      if (err instanceof Sts2InstallError && err.reason === 'permission') {
        if (!opts.grant) {
          grantNeeded = true;
          return tracked('mod_copy', fail('permission', err.message, await detect()));
        }
        let ok = false;
        try {
          ok = await installWithGrant(root, found.modsDir, opts.grant);
        } catch (e) {
          return tracked('mod_copy', fail('failed', String((e as Error)?.message ?? e), await detect()));
        }
        if (!ok) {
          grantNeeded = true;
          return tracked('mod_copy', fail('permission', err.message, await detect()));
        }
      } else if (err instanceof Sts2InstallError) {
        return tracked('mod_copy', fail(err.reason, err.message, await detect()));
      } else {
        return tracked('mod_copy', fail('failed', String((err as Error)?.message ?? err), await detect()));
      }
    }
    grantNeeded = false;
    log(`mod installed in ${found.modsDir}`);
    return tracked('mod_copy', { ok: true, state: await detect() });
  }

  async function runInstall(opts: { grant?: MacGrant } = {}): Promise<Sts2ActionResult> {
    return single(async () => {
      const s = await detect();
      if (s.kind !== 'found') return tracked('mod_copy', fail('not_found', 'GAME_NOT_INSTALLED: Slay the Spire 2 was not found on this computer.', s));
      // The game holds its mod DLLs open while it runs (Windows refuses the copy outright).
      if (s.gameRunning || s.companionRunning) {
        return tracked('mod_copy', fail('game_running', 'Slay the Spire 2 is running. Close it, then add the mod again.', s));
      }
      return copyMod(opts);
    });
  }

  async function runStartGame(opts: { grant?: MacGrant } = {}): Promise<Sts2ActionResult> {
    return single(async () => {
      track({ game: 'sts2', step: 'start_game', outcome: 'start' });
      let s = await detect();
      if (s.kind !== 'found') return tracked('start_game', fail('not_found', 'GAME_NOT_INSTALLED: Slay the Spire 2 was not found on this computer.', s));
      if (s.gameRunning) return tracked('start_game', { ok: true, state: s });
      // Bring the mod up to date while the game is closed (needs the pack to compare).
      if (!packRoot) {
        packRoot = await deps.getPackRoot().catch(() => null);
        s = await detect();
      }
      if (s.kind === 'found' && (!s.modInstalled || !s.modCurrent)) {
        const r = await copyMod(opts);
        if (!r.ok) return r;
      }
      try {
        await deps.openExternal(STEAM_RUN_URL);
      } catch (err) {
        return tracked('start_game', fail('failed', `Slay the Spire 2 did not start through Steam: ${(err as Error).message}`, await detect()));
      }
      startedGameAt = deps.now();
      return tracked('start_game', { ok: true, state: await detect() });
    });
  }

  /**
   * Per summon, before the bot forks: a fresh link port + token in
   * link.json, and the companion's game window (unless one is already up).
   * The bot listens on the port; the window's mod connects once it booted.
   */
  async function prepareJoin({ characterId }: { characterId: string; character: Character }): Promise<Record<string, unknown> | null> {
    if (!found) await detect().catch(() => undefined);
    const port = await deps.pickPort();
    if (port == null) {
      log('no free local port for the Sei link');
      return null;
    }
    const link: LinkRecord = { v: 1, port, token: deps.token() };
    await deps.writeJson(p().join(deps.linkDir, LINK_FILE), link);
    session = { characterId, link };
    const ours = companion?.window.alive() === true;
    if (!ours && !fresh(seat) && found) {
      try {
        const w = deps.spawnCompanion(found.binary);
        companion = { window: w, characterId };
        w.onExit((code) => {
          log(`companion window exited (${code ?? 'signal'})`);
          if (companion?.window === w) companion = null;
        });
        track({ game: 'sts2', step: 'companion_window', outcome: 'ok', store: found.store });
        log(`started the companion window (pid ${w.pid ?? '?'})`);
      } catch (err) {
        track({ game: 'sts2', step: 'companion_window', outcome: 'fail', store: found.store, error_code: 'STS2_SPAWN_FAILED', reason: classifyFailReason((err as Error).message) });
        log(`companion window did not start: ${(err as Error).message}`);
      }
    } else if (companion) {
      companion.characterId = characterId;
    }
    return { port: link.port, token: link.token };
  }

  function onSessionEnd(characterId: string): void {
    if (session?.characterId === characterId) session = null;
    // The mod quits the window on sei/bye; this is the backstop.
    if (companion && companion.characterId === characterId) {
      const w = companion.window;
      companion = null;
      w.stop(8_000);
    }
  }

  const install: GameInstall = {
    detect: async () => {
      const s = await detect();
      return { installed: s.kind === 'found' && s.modInstalled, detail: s as unknown as Record<string, unknown> };
    },
    install: async () => {
      const r = await runInstall();
      if (!r.ok) throw new Error(r.message);
    },
    // The player turns the mod on in the game (Settings, Mods).
    enable: async () => {},
    launch: async () => {
      const r = await runStartGame();
      if (!r.ok) throw new Error(r.message);
    },
  };

  return {
    id: 'sts2',
    displayName: 'Slay the Spire 2',
    effectiveUsername: (c) => effectiveSts2Name(c),
    collides: (a, b) => a.toLowerCase() === b.toLowerCase(),
    maxBodies: 1,
    oneBodyError: {
      error: 'STS2_ONE_COMPANION',
      message: 'STS2_ONE_COMPANION: Slay the Spire 2 fits one companion at a time for now. Stop the companion already in your run, then press Play.',
    },
    watcher: {
      start({ onUpdate: cb }) {
        onUpdate = cb;
        if (timer == null) timer = deps.setInterval(() => void pollNow(), POLL_MS);
        void detect().catch(() => undefined);
      },
      async checkNow() {
        await pollNow();
        if (installed == null) await detect().catch(() => undefined);
        return world;
      },
      stop() {
        if (timer != null) deps.clearInterval(timer);
        timer = null;
        onUpdate = null;
      },
    },
    getWorldState: () => world,
    getJoinTarget(_ctx: GameJoinContext): Sts2JoinTarget | null {
      if (world.kind !== 'open') return null;
      // prepareJoin replaces port + token with the session's own.
      return { port: STS2_LINK_PORT_FIRST, token: '', label: world.label };
    },
    joinTargetMissingError: { error: 'GAME_WORLD_NOT_OPEN', message: STS2_NOT_OPEN_MESSAGE },
    prepareJoin,
    onSessionEnd,
    install,
    getSetupState: () => detect(),
    runInstall,
    runStartGame,
    pollNow,
  };
}
