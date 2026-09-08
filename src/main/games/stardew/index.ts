/**
 * Stardew Valley GameModule (game-adapters M1, 260908): the main-process
 * plug-in the supervisor and the world:* channels dispatch on. Discovery is
 * the hello watcher; the join target is the mod's port + token from its
 * config.json plus the farm name; install/launch wrap install.ts/launch.ts.
 * No game protocol here (that is the bot's adapter).
 */
import type { Character } from '../../../shared/characterSchema';
import type { WorldState } from '../../../shared/gameIpc';
import type { StardewJoinTarget, StardewWorldState } from '../../../shared/stardewIpc';
import type { GameModule, GameJoinContext } from '../index';
import { detectStardew, installStardew, readModConfig, type StardewInstallEnv } from './install';
import { launchStardew } from './launch';
import { createStardewWatcher, STARDEW_POLL_INTERVAL_MS } from './watcher';

/**
 * The companion's in-game display name. MIRROR of botUsernameFor in
 * src/bot/adapter/stardew/runtime.js (the bot re-derives it; the two must
 * agree so the supervisor's collision guard and the mod's NAME_TAKEN check
 * see the same name).
 */
export function effectiveStardewName(c: Pick<Character, 'username' | 'name'>): string {
  const raw = (c.username ?? '').trim() || String(c.name || '');
  const cleaned = raw.replace(/[^A-Za-z0-9_ \-]/g, '').trim().slice(0, 24);
  return cleaned || 'Sei';
}

export interface StardewModuleOpts {
  env?: StardewInstallEnv;
  fetch?: typeof fetch;
  intervalMs?: number;
  logger?: { info: (m: string) => void; warn: (m: string) => void };
}

export function createStardewGameModule(opts: StardewModuleOpts = {}): GameModule {
  const logger = opts.logger ?? { info: (m) => console.log(m), warn: (m) => console.warn(m) };
  let cachedToken: string | null = null;

  /** The mod's port from its config.json (also caches the token for the join target). */
  const getPort = async (): Promise<number | null> => {
    const state = await detectStardew(opts.env);
    if (!state.gamePath || !state.modInstalled) {
      cachedToken = null;
      return null;
    }
    const cfg = await readModConfig(state.gamePath);
    cachedToken = cfg?.Token || null;
    return cfg?.Port ?? null;
  };

  const watcher = createStardewWatcher({
    getPort,
    fetch: opts.fetch,
    intervalMs: opts.intervalMs ?? STARDEW_POLL_INTERVAL_MS,
    logger,
  });

  const tag = (s: StardewWorldState): WorldState => ({ game: 'stardew', ...s });

  return {
    id: 'stardew',
    displayName: 'Stardew Valley',
    effectiveUsername: (character) => effectiveStardewName(character),
    // The mod compares names case-insensitively (NAME_TAKEN).
    collides: (a, b) => a.toLowerCase() === b.toLowerCase(),
    watcher,
    getWorldState: () => tag(watcher.latest()),
    getJoinTarget(_ctx: GameJoinContext): StardewJoinTarget | null {
      const latest = watcher.latest();
      if (latest.kind !== 'open') return null;
      if (!cachedToken) return null;
      return { port: latest.port, token: cachedToken, label: latest.farmName ? `${latest.farmName} Farm` : null, uniqueId: latest.uniqueId || null };
    },
    joinTargetMissingError: {
      error: 'GAME_WORLD_NOT_OPEN',
      message: 'No open farm found. Start Stardew Valley through SMAPI with the Sei companion mod, load your farm, then press Launch again.',
    },
    install: {
      detect: async () => {
        const state = await detectStardew(opts.env);
        return { installed: !!state.gamePath, detail: state as unknown as Record<string, unknown> };
      },
      install: async (o) => {
        await installStardew({ env: opts.env, onProgress: (ev) => o?.onProgress?.(ev) });
      },
      // Copying the mod folder IS enabling it; SMAPI loads every folder in Mods/.
      enable: async () => {},
      launch: async () => {
        const r = await launchStardew({ env: opts.env, fetch: opts.fetch });
        if (!r.launched && r.message && /^[A-Z_]+:/.test(r.message)) throw new Error(r.message);
      },
    },
  };
}
