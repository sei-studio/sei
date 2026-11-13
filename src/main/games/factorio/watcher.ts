/**
 * Factorio world watcher (261113): "is a game loaded with the Sei mod?" for
 * the launch panel and the supervisor.
 *
 * Every few seconds, while a link port is known, one `{op:'hello'}` goes to
 * the mod over localhost UDP with the bot's own client
 * (src/bot/adapter/factorio/client.js, so the framing lives in one place).
 * The client's socket is CONNECTED, so the OS reports a port nothing listens
 * on (ICMP unreachable) as a refusal, which separates three answers:
 *
 *   reply     the mod answered: a game is loaded            -> open
 *   silent    no reply, no refusal: Factorio holds the port
 *             but the mod is not ticking (main menu, a paused
 *             single player game)                            -> no_game
 *   refused   nothing on the port: Factorio is not running
 *             with the link                                  -> closed
 *
 * One silent or refused poll is tolerated before `open` flips (a save or a
 * slow frame can miss a beat). After that, silence on the port of an open
 * game reads as PAUSED, not gone: single player stops ticking in the menu
 * (docs/agents/game-adapter-factorio.md), so the state stays `open` with
 * `detail.paused` until the mod answers again or the port is refused. The
 * probe never throws and every socket is closed after its poll.
 */
import { z } from 'zod';
import type { WorldState } from '../../../shared/gameIpc';
import { FACTORIO_PROTOCOL_VERSION, type FactorioWorldState } from '../../../shared/factorioIpc';
import type { GameWatcher } from '../index';
import { createFactorioClient } from '../../../bot/adapter/factorio/client.js';

export const FACTORIO_POLL_INTERVAL_MS = 3000;
export const FACTORIO_HELLO_TIMEOUT_MS = 1500;
const OPEN_MISS_TOLERANCE = 1;

export const FactorioHelloSchema = z.object({
  ok: z.literal(true),
  protocol: z.number().int().optional(),
  players: z
    .array(z.object({ i: z.number().int(), name: z.string().max(64) }))
    .max(64)
    .catch([]),
  multiplayer: z.boolean().catch(false),
  paused: z.boolean().nullish(),
  world: z.union([z.string(), z.number()]).nullish(),
});
export type FactorioHello = z.infer<typeof FactorioHelloSchema>;

export type ProbeResult = { kind: 'reply'; reply: unknown } | { kind: 'silent' } | { kind: 'refused' };

type WatchState = Exclude<FactorioWorldState, { kind: 'not_installed' } | { kind: 'unavailable' }>;

/** Pure: one probe answer -> world state. */
export function stateFromProbe(
  r: ProbeResult,
  port: number,
  now: number,
  logger?: { warn: (m: string) => void },
): WatchState {
  if (r.kind === 'refused') return { game: 'factorio', kind: 'closed' };
  if (r.kind === 'silent') return { game: 'factorio', kind: 'no_game', port };
  const parsed = FactorioHelloSchema.safeParse(r.reply);
  if (!parsed.success) return { game: 'factorio', kind: 'no_game', port };
  const h = parsed.data;
  if (h.protocol != null && h.protocol !== FACTORIO_PROTOCOL_VERSION) {
    logger?.warn(`[sei/factorio] mod protocol ${h.protocol} does not match ${FACTORIO_PROTOCOL_VERSION}; treating the game as not open`);
    return { game: 'factorio', kind: 'no_game', port };
  }
  return {
    game: 'factorio',
    kind: 'open',
    label: 'Factorio',
    lastSeenAt: now,
    port,
    detail: {
      players: h.players,
      multiplayer: h.multiplayer,
      world: h.world == null ? '' : String(h.world).slice(0, 80),
      paused: h.paused === true,
    },
  };
}

function sameState(a: WatchState, b: WatchState): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'open' && b.kind === 'open') {
    return (
      a.port === b.port &&
      a.detail.world === b.detail.world &&
      a.detail.multiplayer === b.detail.multiplayer &&
      a.detail.paused === b.detail.paused &&
      a.detail.players.map((p) => p.name).join('\n') === b.detail.players.map((p) => p.name).join('\n')
    );
  }
  if (a.kind === 'no_game' && b.kind === 'no_game') return a.port === b.port;
  return true;
}

type ClientFactory = typeof createFactorioClient;

const SILENT_LOGGER = { info() {}, warn() {}, error() {}, debug() {}, log() {} };

/** One hello on `port`. Never throws; the socket is always closed. */
export async function probeHello(port: number, timeoutMs = FACTORIO_HELLO_TIMEOUT_MS, createClient: ClientFactory = createFactorioClient): Promise<ProbeResult> {
  let client: ReturnType<ClientFactory> | null = null;
  try {
    client = createClient({ gamePort: port, host: '127.0.0.1', logger: SILENT_LOGGER });
    await client.open();
    const c = client;
    return await new Promise<ProbeResult>((resolve) => {
      let done = false;
      const finish = (r: ProbeResult): void => {
        if (done) return;
        done = true;
        resolve(r);
      };
      c.on('unreachable', () => finish({ kind: 'refused' }));
      c.request({ op: 'hello' }, { timeoutMs }).then(
        (reply: unknown) => finish({ kind: 'reply', reply }),
        () => finish(c.lastRefusedAt > 0 ? { kind: 'refused' } : { kind: 'silent' }),
      );
    });
  } catch {
    // The local socket could not even open: report nothing listening.
    return { kind: 'refused' };
  } finally {
    try {
      client?.close();
    } catch {
      /* already closed */
    }
  }
}

export interface FactorioWatcherDeps {
  /** The link port to probe right now (null = none known: closed without a probe). */
  getPort: () => number | null;
  probe?: (port: number) => Promise<ProbeResult>;
  intervalMs?: number;
  logger?: { info: (m: string) => void; warn: (m: string) => void };
  now?: () => number;
}

export interface FactorioWatcher extends GameWatcher {
  latest(): WatchState;
}

export function createFactorioWatcher(deps: FactorioWatcherDeps): FactorioWatcher {
  const probe = deps.probe ?? ((port: number) => probeHello(port));
  const intervalMs = deps.intervalMs ?? FACTORIO_POLL_INTERVAL_MS;
  const now = deps.now ?? (() => Date.now());
  let latest: WatchState = { game: 'factorio', kind: 'closed' };
  let timer: ReturnType<typeof setInterval> | null = null;
  let onUpdate: ((s: WorldState) => void) | null = null;
  let misses = 0;
  let inFlight: Promise<WatchState> | null = null;

  const emit = (next: WatchState): void => {
    if (sameState(latest, next)) {
      latest = next; // refresh lastSeenAt
      return;
    }
    latest = next;
    try {
      onUpdate?.(next);
    } catch {
      /* a listener error must not kill the poll */
    }
  };

  async function pass(): Promise<WatchState> {
    let port: number | null = null;
    try {
      port = deps.getPort();
    } catch {
      port = null;
    }
    if (port == null) {
      misses = 0;
      return { game: 'factorio', kind: 'closed' };
    }
    let r: ProbeResult;
    try {
      r = await probe(port);
    } catch {
      r = { kind: 'refused' };
    }
    const next = stateFromProbe(r, port, now(), deps.logger);
    if (next.kind !== 'open' && latest.kind === 'open' && latest.port === port) {
      if (misses < OPEN_MISS_TOLERANCE) {
        misses++;
        return latest;
      }
      // A game that answered and went quiet is paused (single player menu).
      if (r.kind === 'silent') return { ...latest, detail: { ...latest.detail, paused: true } };
    }
    misses = 0;
    return next;
  }

  function tick(): Promise<WatchState> {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const next = await pass();
        emit(next);
        return next;
      } catch {
        return latest;
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
      timer = setInterval(() => void tick(), intervalMs);
      if (typeof timer.unref === 'function') timer.unref();
    },
    checkNow: () => tick(),
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      onUpdate = null;
    },
    latest: () => latest,
  };
}
