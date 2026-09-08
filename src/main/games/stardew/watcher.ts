/**
 * Stardew world watcher (game-adapters M1): "is a farm open?" for the
 * launch panel and the supervisor. Polls the mod's unauthenticated
 * `GET /hello` every 3 s on the port the mod's config.json names
 * (re-read every ~30 s and on checkNow, since the installer may write it
 * mid-session). Emits on CHANGE only, like the LAN watcher.
 *
 *   not_installed         no game folder / no mod config to read a port from
 *   closed                the port does not answer (game not running, or
 *                         running without SMAPI / the mod)
 *   game_running_no_save  hello answers with save.loaded=false (title screen)
 *   open                  a farm is loaded: name, save id, day, season
 *
 * One missed poll is tolerated before open flips to closed (a save or a day
 * change pauses the game thread; the hello runs off-thread but a slow
 * machine can still miss a beat).
 */
import type { WorldState } from '../../../shared/gameIpc';
import { STARDEW_PROTOCOL_VERSION, StardewHelloSchema, type StardewHello, type StardewWorldState } from '../../../shared/stardewIpc';
import type { GameWatcher } from '../index';

export interface StardewWatcherDeps {
  /** Port from the mod config (null = not installed / unreadable). */
  getPort: () => Promise<number | null>;
  fetch?: typeof fetch;
  intervalMs?: number;
  helloTimeoutMs?: number;
  /** Re-read the port every N polls. */
  portRefreshPolls?: number;
  logger?: { info: (m: string) => void; warn: (m: string) => void };
}

export const STARDEW_POLL_INTERVAL_MS = 3000;
const OPEN_MISS_TOLERANCE = 1;

export function stateLabel(s: StardewWorldState): string {
  return s.kind === 'open' ? `${s.farmName} Farm, ${s.season} ${s.day}` : s.kind;
}

/** Pure: hello JSON → world state (exported for tests). */
export function stateFromHello(hello: unknown, port: number, now: number, logger?: StardewWatcherDeps['logger']): StardewWorldState {
  const parsed = StardewHelloSchema.safeParse(hello);
  if (!parsed.success) return { kind: 'closed' };
  const h: StardewHello = parsed.data;
  if (h.protocol !== STARDEW_PROTOCOL_VERSION) {
    logger?.warn(`[stardew] mod protocol ${h.protocol} does not match ${STARDEW_PROTOCOL_VERSION}; treating the farm as closed`);
    return { kind: 'closed' };
  }
  if (!h.save.loaded) return { kind: 'game_running_no_save', port };
  const farmName = h.save.farmName?.trim() || 'Unnamed';
  const uniqueId = h.save.uniqueId ?? '';
  const day = h.save.day ?? 0;
  const season = h.save.season ?? '';
  const year = h.save.year ?? 1;
  return { kind: 'open', farmName, uniqueId, day, season, year, port, lastSeenAt: now, label: `${farmName} Farm, ${season} ${day}` };
}

function sameState(a: StardewWorldState, b: StardewWorldState): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'open' && b.kind === 'open') {
    return a.uniqueId === b.uniqueId && a.day === b.day && a.season === b.season && a.farmName === b.farmName && a.port === b.port;
  }
  return true;
}

export async function probeHello(port: number, fetchImpl: typeof fetch, timeoutMs: number): Promise<unknown | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(`http://127.0.0.1:${port}/hello`, { signal: ctrl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function createStardewWatcher(deps: StardewWatcherDeps): GameWatcher & { latest(): StardewWorldState; checkNowRaw(): Promise<StardewWorldState> } {
  const fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));
  const intervalMs = deps.intervalMs ?? STARDEW_POLL_INTERVAL_MS;
  const helloTimeoutMs = deps.helloTimeoutMs ?? 1200;
  const portRefreshPolls = deps.portRefreshPolls ?? 10;
  let latest: StardewWorldState = { kind: 'closed' };
  let timer: ReturnType<typeof setInterval> | null = null;
  let onUpdate: ((s: WorldState) => void) | null = null;
  let port: number | null = null;
  let polls = 0;
  let misses = 0;
  let inFlight: Promise<StardewWorldState> | null = null;

  const emit = (next: StardewWorldState) => {
    if (sameState(latest, next)) {
      if (next.kind === 'open' && latest.kind === 'open') latest = next; // refresh lastSeenAt
      return;
    }
    latest = next;
    try { onUpdate?.({ game: 'stardew', ...next }); } catch { /* listener error must not kill the poll */ }
  };

  async function pass(forcePort: boolean): Promise<StardewWorldState> {
    if (forcePort || port == null || polls % portRefreshPolls === 0) {
      try { port = await deps.getPort(); } catch { port = null; }
    }
    polls++;
    if (port == null) {
      misses = 0;
      return { kind: 'not_installed' };
    }
    const hello = await probeHello(port, fetchImpl, helloTimeoutMs);
    if (hello == null) {
      if (latest.kind === 'open' && misses < OPEN_MISS_TOLERANCE) {
        misses++;
        return latest;
      }
      misses = 0;
      return { kind: 'closed' };
    }
    misses = 0;
    return stateFromHello(hello, port, Date.now(), deps.logger);
  }

  async function tick(forcePort = false): Promise<StardewWorldState> {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const next = await pass(forcePort);
        emit(next);
        return next;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  return {
    start(opts) {
      onUpdate = opts.onUpdate;
      if (timer) return;
      void tick(true);
      timer = setInterval(() => { void tick(); }, intervalMs);
      if (typeof timer.unref === 'function') timer.unref();
    },
    async checkNow() {
      const s = await tick(true);
      return { game: 'stardew', ...s };
    },
    checkNowRaw: () => tick(true),
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      onUpdate = null;
    },
    latest: () => latest,
  };
}
