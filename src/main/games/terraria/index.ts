/**
 * Terraria GameModule (261113): the main-process side of the Terraria
 * adapter, registered from src/main/index.ts beside the other games.
 *
 * Owns tModLoader detection, the sideloaded SeiCompanion mod (copied into
 * the tModLoader save folder, never the Workshop), link.json (port + token),
 * starting tModLoader through Steam and the hello watcher. The bot runtime
 * (src/bot/adapter/terraria/runtime.js) gets `{port, token, label}` as its
 * join target and speaks the protocol itself.
 *
 * The companion body is a mod-owned NPC drawn with the player renderer, so
 * several companions can share a world (the mod caps them); `maxBodies` is
 * left unset.
 */
import type { Character } from '../../../shared/characterSchema';
import type { WorldState } from '../../../shared/gameIpc';
import type { TerrariaActionFailure, TerrariaActionResult, TerrariaJoinTarget, TerrariaSetupState, TerrariaWorldState } from '../../../shared/terrariaIpc';
import type { StardewAppearance } from '../../../shared/stardewAppearance';
import type { GameInstall, GameJoinContext, GameModule } from '../index';
import { defaultEnv, detectTerraria, installTerrariaMod, packModVersion, readLink, tmlSaveDir, type TerrariaInstallEnv } from './install';
import { createTerrariaWatcher } from './watcher';
import { launchTerraria } from './launch';
import { terrariaAppearanceFrom } from './appearance';
import { createDedupedSink, trackSetupStep, type SetupSink } from '../../setupTelemetry';
import { classifyFailReason } from '../../../shared/setupTelemetry';

/** Mirror of MAX_NAME_CHARS in src/bot/adapter/terraria/runtime.js. */
const MAX_NAME_CHARS = 20;

/**
 * The companion's in-game name. MIRROR of botUsernameFor in
 * src/bot/adapter/terraria/runtime.js, so the supervisor's collision guard
 * sees the name the mod will show.
 */
export function effectiveTerrariaName(c: Pick<Character, 'username' | 'name'>): string {
  const raw = typeof c.username === 'string' && c.username.trim() ? c.username.trim() : String(c.name || '');
  // eslint-disable-next-line no-control-regex
  const clean = raw.replace(/[\u0000-\u001f\u007f[\]<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_CHARS).trim();
  return clean || 'Sei';
}

export const TERRARIA_NOT_OPEN_MESSAGE =
  'GAME_WORLD_NOT_OPEN: No Terraria world is open with the Sei mod. Start tModLoader, open a world in single player or Host and Play, then press Launch again.';

export interface TerrariaModuleDeps {
  env: TerrariaInstallEnv;
  fetch?: typeof fetch;
  openExternal(url: string): Promise<void>;
  intervalMs?: number;
  logger?: { info: (m: string) => void; warn: (m: string) => void };
  /** Test seam: the stored character look (default: stardew appearanceForSummon). */
  appearanceFor?: (characterId: string) => Promise<{ appearance: StardewAppearance; source: string }>;
  /** game_setup_step sink (shape only; analytics sends nothing from dev builds). */
  track?: SetupSink;
  /** Test seam: the pack root when the pack is on disk, else null (no download). */
  packStateRoot?: () => Promise<string | null>;
}

export interface TerrariaGameModule extends GameModule {
  getSetupState(): Promise<TerrariaSetupState>;
  runInstall(): Promise<TerrariaActionResult>;
  runLaunch(): Promise<TerrariaActionResult>;
}

function defaultDeps(): TerrariaModuleDeps {
  return {
    env: defaultEnv(),
    openExternal: async (url) => {
      const { shell } = await import('electron');
      await shell.openExternal(url);
    },
    logger: { info: (m) => console.log(m), warn: (m) => console.warn(m) },
    track: trackSetupStep,
  };
}

function failCode(reason: TerrariaActionFailure): string {
  return `TERRARIA_${reason.toUpperCase()}`;
}

export function createTerrariaGameModule(overrides: Partial<TerrariaModuleDeps> = {}): TerrariaGameModule {
  const deps: TerrariaModuleDeps = { ...defaultDeps(), ...overrides };
  const logger = deps.logger ?? { info: () => {}, warn: () => {} };
  const track: SetupSink = (input) => {
    try {
      deps.track?.(input);
    } catch {
      /* telemetry never breaks setup */
    }
  };
  const trackOnce = createDedupedSink(track);
  let token: string | null = null;
  let installed = true;
  let launchedAt: number | null = null;
  let worldSeen = false;
  let actionInFlight: Promise<TerrariaActionResult> | null = null;

  const getPort = async (): Promise<number | null> => {
    const link = await readLink(tmlSaveDir(deps.env)).catch(() => null);
    token = link?.token ?? null;
    installed = link != null;
    return link?.port ?? null;
  };

  const watcher = createTerrariaWatcher({
    getPort,
    fetch: deps.fetch,
    intervalMs: deps.intervalMs,
    logger,
    onChange: (next) => {
      if (next.kind === 'open' && !worldSeen) {
        worldSeen = true;
        track({ game: 'terraria', step: 'world_seen', outcome: 'ok', wait_ms: launchedAt != null ? Date.now() - launchedAt : null });
      }
    },
  });

  const tagged = (): TerrariaWorldState => ({ game: 'terraria', ...watcher.latest() }) as TerrariaWorldState;

  async function setupState(): Promise<TerrariaSetupState> {
    const packVersion = await packModVersion({ ...deps.env, getPackRoot: localPackRoot }).catch(() => null);
    const { saveDir: _saveDir, ...state } = await detectTerraria(deps.env, { packVersion });
    trackOnce('find_game', `${state.tmlInstalled}|${state.terrariaInstalled}`, {
      game: 'terraria',
      step: 'find_game',
      outcome: state.tmlInstalled === false ? 'fail' : 'ok',
      store: 'steam',
      ...(state.tmlInstalled === false ? { error_code: 'GAME_NOT_INSTALLED', reason: 'not_found' as const } : {}),
    });
    return state;
  }

  /**
   * The pack root for detection only: never starts a download (the pack is
   * fetched by install / launch). In dev it is the repo root.
   */
  async function localPackRoot(): Promise<string> {
    const lookup = deps.packStateRoot ?? (async () => {
      const st = await (await import('../packs')).getPackState('terraria');
      return st.kind === 'ready' ? st.root : null;
    });
    const root = await lookup();
    if (!root) throw new Error('pack not on disk');
    return root;
  }

  function fail(reason: TerrariaActionFailure, message: string, state: TerrariaSetupState | null): Extract<TerrariaActionResult, { ok: false }> {
    return { ok: false, reason, message, state };
  }

  function tracked(step: 'mod_copy' | 'launch', r: TerrariaActionResult): TerrariaActionResult {
    if (r.ok) track({ game: 'terraria', step, outcome: 'ok', store: 'steam' });
    else track({ game: 'terraria', step, outcome: 'fail', store: 'steam', error_code: failCode(r.reason), reason: classifyFailReason(r.message) });
    return r;
  }

  function single(fn: () => Promise<TerrariaActionResult>): Promise<TerrariaActionResult> {
    if (actionInFlight) return actionInFlight;
    actionInFlight = fn().finally(() => {
      actionInFlight = null;
    });
    return actionInFlight;
  }

  function preflight(s: TerrariaSetupState): TerrariaActionResult | null {
    if (s.tmlInstalled === false) {
      return fail('no_tml', 'GAME_NOT_INSTALLED: tModLoader was not found in your Steam library. Install tModLoader from Steam (it is free with Terraria), then try again.', s);
    }
    return null;
  }

  async function runInstall(): Promise<TerrariaActionResult> {
    return single(async () => {
      const s = await setupState();
      const pre = preflight(s);
      if (pre) return tracked('mod_copy', pre);
      track({ game: 'terraria', step: 'mod_copy', outcome: 'start', store: 'steam' });
      try {
        const r = await installTerrariaMod(deps.env);
        logger.info(`[sei/terraria] companion mod ${r.upgraded ? `${r.from ?? 'none'} -> ${r.to}` : `${r.to} already current`}`);
      } catch (err) {
        const msg = (err as Error)?.message ?? String(err);
        return tracked('mod_copy', fail(/GAME_PACK|download/i.test(msg) ? 'pack_missing' : 'failed', msg, s));
      }
      void watcher.checkNow().catch(() => undefined);
      return tracked('mod_copy', { ok: true, state: await setupState() });
    });
  }

  async function runLaunch(): Promise<TerrariaActionResult> {
    return single(async () => {
      track({ game: 'terraria', step: 'launch', outcome: 'start', store: 'steam' });
      const s = await setupState();
      const pre = preflight(s);
      if (pre) return tracked('launch', pre);
      const r = await launchTerraria({ env: deps.env, openExternal: deps.openExternal, fetch: deps.fetch, logger });
      if (!r.launched && 'error' in r) return tracked('launch', fail('failed', `tModLoader did not start: ${r.error}`, s));
      if (r.launched) launchedAt = Date.now();
      void watcher.checkNow().catch(() => undefined);
      return tracked('launch', { ok: true, state: await setupState() });
    });
  }

  const install: GameInstall = {
    detect: async () => {
      const s = await setupState();
      return { installed: s.modInstalled && s.modEnabled && s.linked, detail: s as unknown as Record<string, unknown> };
    },
    install: async () => {
      const r = await runInstall();
      if (!r.ok) throw new Error(r.message);
    },
    // Copying the mod in also lists it in enabled.json.
    enable: async () => {},
    launch: async () => {
      const r = await runLaunch();
      if (!r.ok) throw new Error(r.message);
    },
  };

  return {
    id: 'terraria',
    displayName: 'Terraria',
    effectiveUsername: (c) => effectiveTerrariaName(c),
    collides: (a, b) => a.toLowerCase() === b.toLowerCase(),
    watcher: {
      start({ onUpdate }) {
        watcher.start({ onUpdate: (s) => onUpdate(s) });
      },
      async checkNow(): Promise<WorldState> {
        return watcher.checkNow();
      },
      stop() {
        watcher.stop();
      },
    },
    getWorldState: () => tagged() as WorldState,
    getJoinTarget(_ctx: GameJoinContext): TerrariaJoinTarget | null {
      const s = watcher.latest();
      if (s.kind !== 'open' || !token || !installed) return null;
      return {
        port: s.port,
        token,
        label: s.label,
        uniqueId: s.uniqueId || null,
        // Single player has exactly one player; with more, the mod picks the host.
        ...(s.players.length === 1 ? { owner: s.players[0] } : {}),
      };
    },
    joinTargetMissingError: { error: 'GAME_WORLD_NOT_OPEN', message: TERRARIA_NOT_OPEN_MESSAGE },
    prepareJoin: async ({ characterId }) => {
      try {
        const lookup = deps.appearanceFor ?? (async (id: string) => (await import('../stardew/appearance')).appearanceForSummon(id));
        const resolved = await lookup(characterId);
        if (resolved.source === 'default') return null;
        const appearance = terrariaAppearanceFrom(resolved.appearance);
        return Object.keys(appearance).length ? { appearance } : null;
      } catch (err) {
        logger.warn(`[sei/terraria] appearance lookup failed (default look): ${(err as Error).message}`);
        return null;
      }
    },
    install,
    getSetupState: setupState,
    runInstall,
    runLaunch,
  };
}
