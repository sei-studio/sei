/**
 * Terraria world watcher (261113): "is a world loaded with the companion
 * mod?" for the launch panel and the supervisor. Polls the mod's
 * unauthenticated `GET /hello` on the link port and the next few (the mod
 * takes the first free one, and Host and Play runs two processes with the
 * mod: the player's client and the server it hosts). Emits on CHANGE only.
 *
 *   not_installed   no link.json (the mod was never set up)
 *   closed          nothing answers (tModLoader closed or started without the mod)
 *   no_world        the mod answers from the menu
 *   joined_other    the only answer is a client in someone else's server
 *   open            a world this computer runs (single player or hosted)
 *
 * A Host and Play pair answers twice: the server process (role `server`)
 * is the one the companion joins, so it wins over the client.
 */
import type { WorldState } from '../../../shared/gameIpc';
import {
  TERRARIA_LOOPBACK_HOST,
  TERRARIA_PORT_SPAN,
  TERRARIA_PROTOCOL_VERSION,
  TerrariaHelloSchema,
  type TerrariaHello,
  type TerrariaWorldState,
} from '../../../shared/terrariaIpc';
import type { GameWatcher } from '../index';

export const TERRARIA_POLL_INTERVAL_MS = 3000;
const OPEN_MISS_TOLERANCE = 1;

type Inner = TerrariaWorldState extends infer T ? (T extends { game: 'terraria' } ? Omit<T, 'game'> : never) : never;

export interface TerrariaWatcherDeps {
  /** The link port from link.json (null = not installed). */
  getPort: () => Promise<number | null>;
  fetch?: typeof fetch;
  intervalMs?: number;
  helloTimeoutMs?: number;
  logger?: { info: (m: string) => void; warn: (m: string) => void };
  onChange?: (next: Inner, prev: Inner) => void;
}

export async function probeHello(port: number, fetchImpl: typeof fetch, timeoutMs: number): Promise<TerrariaHello | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(`http://${TERRARIA_LOOPBACK_HOST}:${port}/hello`, { signal: ctrl.signal });
    if (!r.ok) return null;
    const parsed = TerrariaHelloSchema.safeParse(await r.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Pure: every answering hello → one state (exported for tests). */
export function stateFromHellos(hellos: TerrariaHello[], now: number, logger?: TerrariaWatcherDeps['logger']): Inner {
  const usable = hellos.filter((h) => {
    if (h.protocol === TERRARIA_PROTOCOL_VERSION) return true;
    logger?.warn(`[terraria] mod protocol ${h.protocol} does not match ${TERRARIA_PROTOCOL_VERSION}; ignoring port ${h.port}`);
    return false;
  });
  if (!usable.length) return { kind: 'closed' };
  const rank = (h: TerrariaHello): number => (h.world.loaded ? (h.role === 'server' ? 3 : h.role === 'single' ? 2 : 1) : 0);
  const best = [...usable].sort((a, b) => rank(b) - rank(a))[0];
  if (!best.world.loaded) return { kind: 'no_world', port: best.port };
  if (best.role === 'client') return { kind: 'joined_other', port: best.port };
  const worldName = best.world.name?.trim() || 'Terraria world';
  return {
    kind: 'open',
    label: worldName,
    lastSeenAt: now,
    port: best.port,
    worldName,
    uniqueId: best.world.uniqueId ?? '',
    role: best.role,
    players: (best.world.players ?? []).slice(0, 16),
  };
}

function sameState(a: Inner, b: Inner): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'open' && b.kind === 'open') {
    return a.uniqueId === b.uniqueId && a.port === b.port && a.role === b.role && a.players.join('\u0000') === b.players.join('\u0000');
  }
  if ((a.kind === 'no_world' || a.kind === 'joined_other') && a.kind === b.kind) return a.port === (b as typeof a).port;
  return true;
}

export function createTerrariaWatcher(deps: TerrariaWatcherDeps): GameWatcher & { latest(): Inner } {
  const fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));
  const intervalMs = deps.intervalMs ?? TERRARIA_POLL_INTERVAL_MS;
  const helloTimeoutMs = deps.helloTimeoutMs ?? 1200;
  let latest: Inner = { kind: 'closed' };
  let timer: ReturnType<typeof setInterval> | null = null;
  let onUpdate: ((s: WorldState) => void) | null = null;
  let misses = 0;
  let inFlight: Promise<Inner> | null = null;

  const emit = (next: Inner): void => {
    if (sameState(latest, next)) {
      if (next.kind === 'open' && latest.kind === 'open') latest = next;
      return;
    }
    const prev = latest;
    latest = next;
    try { deps.onChange?.(next, prev); } catch { /* telemetry must not kill the poll */ }
    try { onUpdate?.({ game: 'terraria', ...next } as WorldState); } catch { /* listener error must not kill the poll */ }
  };

  async function pass(): Promise<Inner> {
    let port: number | null = null;
    try { port = await deps.getPort(); } catch { port = null; }
    if (port == null) {
      misses = 0;
      return { kind: 'not_installed' };
    }
    const ports = Array.from({ length: TERRARIA_PORT_SPAN }, (_, i) => port + i);
    const hellos = (await Promise.all(ports.map((p) => probeHello(p, fetchImpl, helloTimeoutMs)))).filter((h): h is TerrariaHello => h != null);
    if (!hellos.length && latest.kind === 'open' && misses < OPEN_MISS_TOLERANCE) {
      // World saves and autosaves can stall a beat; one miss is not a close.
      misses++;
      return latest;
    }
    misses = 0;
    return stateFromHellos(hellos, Date.now(), deps.logger);
  }

  async function tick(): Promise<Inner> {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const next = await pass();
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
      void tick();
      timer = setInterval(() => { void tick(); }, intervalMs);
      if (typeof timer.unref === 'function') timer.unref();
    },
    async checkNow() {
      const s = await tick();
      return { game: 'terraria', ...s } as WorldState;
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      onUpdate = null;
    },
    latest: () => latest,
  };
}
