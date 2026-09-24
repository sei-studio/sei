/**
 * Don't Starve Together game module (game-adapters M2, 260908): the main
 * process side of the DST adapter, registered from src/main/index.ts beside
 * the Minecraft module. Owns the discovery watcher (the fixed-port heartbeat
 * listener), install detection + the mod copy, the Steam launch, and the
 * summon handoff: when the forked bot reports its loopback listener
 * ({type:'dst-listen'} through the supervisor), `setSummonOffer` turns it
 * into the offer the next heartbeat carries to the mod.
 *
 * The join target carries every character's stored survivor pick (the
 * supervisor's GameJoinContext has no character id, and the bot does), so
 * the bot's adapterConfigFrom picks its own row by character.id and the
 * offer built here reads the same UserConfig.dst_survivor; both fall back to
 * Wilson when the pick was never made (the launch panel makes it before
 * Launch, the chat `launch` tool may not).
 */
import type { Character, UserConfig } from '../../../shared/characterSchema';
import type { WorldState } from '../../../shared/gameIpc';
import {
  type DstInstallState,
  type DstJoinTarget,
  type DstListenMessage,
  type DstSummonOffer,
} from '../../../shared/dstIpc';
import { DST_DEFAULT_SURVIVOR, isDstSurvivorPrefab, renderDstSurvivorBrief } from '../../../shared/dstSurvivors';
import type { GameModule, GameJoinContext, GameInstall } from '../index';
import { createDstWatcher, type DstWatcher } from './watcher';
import { detectInstall, enableMod, installMod, isHelperCurrent, type MacGrant } from './install';
import { launchDst } from './launch';

/** The offer lives this long past the bot's report (the supervisor's summon
 *  watchdog is 30 s; a heartbeat lands every 2 s). */
const OFFER_TTL_MS = 30_000;

export interface DstModuleDeps {
  loadConfig(): Promise<UserConfig>;
  getCharacter(id: string): Promise<Pick<Character, 'name'> | null>;
  /** Pack root for the mod files (src/main/games/packs.ts ensurePack). */
  getPackRoot(): Promise<string>;
  detect: typeof detectInstall;
  install: typeof installMod;
  enable: typeof enableMod;
  /** Read-only: is the helper in `modsDir` as new as the pack's and enabled? */
  isCurrent: (packRoot: string, modsDir: string) => Promise<boolean>;
  launch: () => Promise<void>;
  watcher?: DstWatcher;
  log?: (msg: string) => void;
}

export interface DstGameModule extends GameModule {
  /** The bot runtime is listening: hand the mod a summon on the next heartbeat. */
  setSummonOffer(characterId: string, listen: Pick<DstListenMessage, 'port' | 'token'> | null): Promise<void>;
  getInstallState(): Promise<DstInstallState>;
  /**
   * Copy + enable the helper. `grant` = this run comes from a click in Sei,
   * so on macOS it may show the Open panel and fall back to Finder (260925);
   * without one (a game launch) it never shows a dialog.
   */
  runInstall(onProgress?: (state: DstInstallState) => void, opts?: { grant?: MacGrant }): Promise<DstInstallState>;
  readonly watcherDst: DstWatcher;
  /** Install detection cached from the last detect pass (null = not run yet). */
  readonly lastInstall: DstInstallState | null;
}

/** MIRROR of src/bot/adapter/dontstarve/runtime.js botUsernameFor. */
export function effectiveDstUsername(c: Pick<Character, 'name'>): string {
  const raw = String(c?.name ?? '').replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim();
  return (raw || 'Sei').slice(0, 32);
}

function defaultDeps(): DstModuleDeps {
  return {
    loadConfig: async () => (await import('../../configStore')).loadConfig(),
    getCharacter: async (id) => (await import('../../characterStore')).getCharacter(id),
    getPackRoot: async () => (await import('../packs')).ensurePack('dontstarve'),
    detect: detectInstall,
    install: installMod,
    enable: enableMod,
    isCurrent: (packRoot, modsDir) => isHelperCurrent(packRoot, modsDir),
    launch: () => launchDst(),
    log: (m) => console.log(`[sei/dst] ${m}`),
  };
}

export function createDontStarveGameModule(overrides: Partial<DstModuleDeps> = {}): DstGameModule {
  const deps: DstModuleDeps = { ...defaultDeps(), ...overrides };
  const log = deps.log ?? (() => {});
  const watcher = deps.watcher ?? createDstWatcher({ log });
  let lastInstall: DstInstallState | null = null;
  /**
   * macOS (260925): a run without a click (a game launch) needed to write the
   * helper and was refused. No dialog may appear then, so the step comes back
   * in the UI instead (`grantNeeded` on the found state) until a clicked
   * install succeeds.
   */
  let grantNeeded = false;
  /** The pack the refused run used, so the poll can re-check without ensurePack. */
  let grantPackRoot: string | null = null;
  let lastEnableError = '';
  let onUpdate: ((s: WorldState) => void) | null = null;

  function tagged(): WorldState {
    const s = watcher.getState();
    // A live heartbeat proves the game is installed whatever detection said.
    if (s.kind === 'closed' && lastInstall?.kind === 'not_found') return { game: 'dontstarve', kind: 'not_installed' };
    return s;
  }

  async function refreshInstall(): Promise<DstInstallState> {
    const before = tagged().kind;
    lastInstall = await deps.detect();
    if (lastInstall.kind === 'found' && lastInstall.modInstalled && !lastInstall.enabled) {
      // Re-apply modsettings.lua: game updates and Steam verify rewrite it.
      // Write-only, never a dialog: this runs at Sei start and on the setup
      // poll. On macOS without the grant it fails, detection keeps
      // `enabled: false`, and the helper step offers the click that fixes it.
      try {
        await deps.enable(lastInstall.modsDir);
        lastInstall = { ...lastInstall, enabled: true };
        lastEnableError = '';
      } catch (err) {
        const msg = (err as Error).message;
        if (msg !== lastEnableError) log(`re-enable failed: ${msg}`);
        lastEnableError = msg;
      }
    }
    if (grantNeeded && lastInstall.kind === 'found' && lastInstall.modInstalled && lastInstall.enabled && grantPackRoot) {
      // Fixed some other way (App Management turned on, a manual copy):
      // detection sees the helper current and enabled, so nothing is pending.
      if (await deps.isCurrent(grantPackRoot, lastInstall.modsDir).catch(() => false)) grantNeeded = false;
    }
    if (grantNeeded && lastInstall.kind === 'found') lastInstall = { ...lastInstall, grantNeeded: true };
    // A heartbeat is the helper talking, so whatever the file times say the
    // running game HAS loaded it (a re-enable just above cannot fire one).
    if (lastInstall.kind === 'found' && lastInstall.needsRestart && watcher.getState().kind === 'open') {
      lastInstall = { ...lastInstall, needsRestart: false };
    }
    if (tagged().kind !== before) onUpdate?.(tagged());
    return lastInstall;
  }

  const install: GameInstall = {
    detect: async () => {
      const s = await refreshInstall();
      return { installed: s.kind === 'found' && s.modInstalled, detail: s as unknown as Record<string, unknown> };
    },
    install: async () => {
      await mod.runInstall();
    },
    enable: async () => {
      const s = lastInstall?.kind === 'found' ? lastInstall : await refreshInstall();
      if (s.kind === 'found') await deps.enable(s.modsDir);
    },
    launch: async () => {
      await mod.runInstall().catch(() => undefined);
      await deps.launch();
    },
  };

  const mod: DstGameModule = {
    id: 'dontstarve',
    displayName: "Don't Starve Together",
    effectiveUsername: (c) => effectiveDstUsername(c),
    // Two survivors with the same nameplate would be indistinguishable in
    // chat announcements; keep the Minecraft rule.
    collides: (a, b) => a.toLowerCase() === b.toLowerCase(),
    maxBodies: 1,
    oneBodyError: {
      error: 'DST_ONE_COMPANION',
      message: "DST_ONE_COMPANION: Don't Starve Together fits one companion at a time. Disconnect the companion already in your world, then press Play.",
    },
    watcher: {
      start({ onUpdate: cb }) {
        onUpdate = cb;
        watcher.start({ onUpdate: () => cb(tagged()) });
        void refreshInstall().catch(() => undefined);
      },
      async checkNow() {
        await watcher.checkNow();
        if (lastInstall == null || lastInstall.kind !== 'found') await refreshInstall().catch(() => undefined);
        return tagged();
      },
      stop() {
        watcher.stop();
        onUpdate = null;
      },
    },
    getWorldState: tagged,
    getJoinTarget(ctx: GameJoinContext): DstJoinTarget | null {
      const hb = watcher.latestHeartbeat();
      if (!hb) return null;
      const host = hb.players[0];
      const survivors: DstJoinTarget['survivors'] = {};
      for (const [id, row] of Object.entries(ctx.userConfig.dst_survivor ?? {})) {
        if (isDstSurvivorPrefab(row.prefab)) survivors[id] = { prefab: row.prefab, brief: renderDstSurvivorBrief(row.prefab) };
      }
      return {
        session: hb.session,
        label: hb.world || 'Your world',
        day: hb.day,
        season: hb.season,
        phase: hb.phase,
        caves: hb.caves,
        nearUserid: host?.userid ?? '',
        nearName: host?.name ?? '',
        survivors,
        defaultPrefab: DST_DEFAULT_SURVIVOR,
        defaultBrief: renderDstSurvivorBrief(DST_DEFAULT_SURVIVOR),
        announce: true,
      };
    },
    joinTargetMissingError: {
      error: 'GAME_WORLD_NOT_OPEN',
      message: "No Don't Starve Together world is open. Host a world in the game (with Sei's helper enabled) and press Play again.",
    },
    install,
    async setSummonOffer(characterId, listen) {
      if (!listen) {
        watcher.setSummonOffer(characterId, null);
        return;
      }
      const [cfg, character, hb] = await Promise.all([
        deps.loadConfig().catch(() => null),
        deps.getCharacter(characterId).catch(() => null),
        Promise.resolve(watcher.latestHeartbeat()),
      ]);
      const stored = cfg?.dst_survivor?.[characterId]?.prefab;
      const prefab = isDstSurvivorPrefab(stored) ? stored : DST_DEFAULT_SURVIVOR;
      const offer: DstSummonOffer = {
        token: listen.token,
        botPort: listen.port,
        name: effectiveDstUsername(character ?? { name: 'Sei' }),
        prefab,
        nearUserid: hb?.players[0]?.userid ?? '',
        announce: true,
        expiresAt: Date.now() + OFFER_TTL_MS,
      };
      watcher.setSummonOffer(characterId, offer);
      log(`summon offer queued for ${offer.name} (${prefab}) -> bot port ${listen.port}`);
    },
    getInstallState: () => refreshInstall(),
    async runInstall(onProgress, opts = {}) {
      const packRoot = await deps.getPackRoot();
      onProgress?.({ kind: 'installing', step: 'copying' });
      let s = await deps.install({ packRoot, grant: opts.grant, onProgress: (step) => onProgress?.({ kind: 'installing', step }) });
      if (s.kind === 'error' && s.permission && !opts.grant) {
        // A launch-time write macOS refused: no dialog without a click, so
        // flag it and hand back what is on disk (the launch goes ahead with
        // whatever helper is there).
        grantNeeded = true;
        grantPackRoot = packRoot;
        s = await refreshInstall();
      } else if (s.kind === 'found' && s.modInstalled && s.enabled) {
        grantNeeded = false;
      }
      lastInstall = s;
      onProgress?.(s);
      onUpdate?.(tagged());
      return s;
    },
    get watcherDst() {
      return watcher;
    },
    get lastInstall() {
      return lastInstall;
    },
  };
  return mod;
}
