/**
 * Don't Starve Together world watcher (game-adapters M2, 260908).
 *
 * Discovery is INBOUND: the mod inside the player's game can only make HTTP
 * requests to localhost, so main keeps a long-lived `node:http` listener on
 * the fixed discovery port (DST_DEFAULT_PORT, UserConfig.dst_port) and the
 * mod GETs /hello?q=<json> every 2 s (PROTOCOL.md). A heartbeat inside
 * DST_HEARTBEAT_STALE_MS = the world is open; nothing for longer = closed.
 * `not_installed` is decided by the module (install detection), not here.
 *
 * The /hello response is where a SUMMON is handed to the mod: once the bot
 * runtime reports its loopback listener ({type:'dst-listen'} through the
 * supervisor), the module calls setSummonOffer(characterId, offer) and the
 * next heartbeat carries it. An offer is delivered once, expires with the
 * supervisor's summon deadline, and one offer per heartbeat keeps a
 * two-companion summon orderly (the second rides the following beat).
 *
 * Bind failure (EADDRINUSE) is reported as state `unavailable` with a reason
 * so the settings section can say "change the port"; nothing throws.
 */
import http from 'node:http';
import type { WorldState } from '../../../shared/gameIpc';
import {
  DST_DEFAULT_PORT,
  DST_HEARTBEAT_STALE_MS,
  DstHeartbeatSchema,
  type DstHeartbeat,
  type DstHelloResponse,
  type DstSummonOffer,
  type DstWorldState,
} from '../../../shared/dstIpc';

export interface DstWatcherOptions {
  port?: number;
  staleMs?: number;
  now?: () => number;
  log?: (msg: string) => void;
  /** Change-detection cadence for the open->closed edge. */
  pollMs?: number;
}

export interface DstWatcher {
  start(opts: { onUpdate: (state: WorldState) => void }): void;
  checkNow(): Promise<WorldState>;
  stop(): void;
  getState(): DstWorldState;
  /** The latest heartbeat (for the join target), or null when closed. */
  latestHeartbeat(): DstHeartbeat | null;
  setSummonOffer(characterId: string, offer: DstSummonOffer | null): void;
  /** Rebind on a new port (settings change). Idempotent for the same port. */
  setPort(port: number): Promise<void>;
  readonly port: number;
  /** Test seam: handle one /hello body directly (no socket). */
  handleHello(raw: unknown): DstHelloResponse;
}

const MAX_QUERY_BYTES = 16_384;

export function createDstWatcher(opts: DstWatcherOptions = {}): DstWatcher {
  const now = opts.now ?? (() => Date.now());
  const staleMs = opts.staleMs ?? DST_HEARTBEAT_STALE_MS;
  const log = opts.log ?? ((m: string) => console.log(`[sei/dst] ${m}`));
  const pollMs = opts.pollMs ?? 1000;
  let port = opts.port ?? DST_DEFAULT_PORT;

  let server: http.Server | null = null;
  let onUpdate: ((s: WorldState) => void) | null = null;
  let timer: NodeJS.Timeout | null = null;
  let last: DstHeartbeat | null = null;
  let lastAt = 0;
  let bindError: string | null = null;
  let lastEmitted: string | null = null;
  const offers = new Map<string, DstSummonOffer>();

  function compute(): DstWorldState {
    if (bindError) return { game: 'dontstarve', kind: 'unavailable', reason: bindError };
    if (last && now() - lastAt <= staleMs) {
      return {
        game: 'dontstarve',
        kind: 'open',
        label: last.world || 'Your world',
        worldName: last.world,
        day: last.day,
        season: last.season,
        phase: last.phase,
        caves: last.caves,
        players: last.players.map((p) => ({ userid: p.userid, name: p.name })),
        lastSeenAt: lastAt,
      };
    }
    return { game: 'dontstarve', kind: 'closed' };
  }

  function emitIfChanged(): DstWorldState {
    const s = compute();
    // Day/phase ticks change every heartbeat; only edges + label/day changes
    // are worth a push (the renderer pill shows the day).
    const key = s.kind === 'open' ? `open:${s.worldName}:${s.day}:${s.phase}:${s.players.length}` : s.kind === 'unavailable' ? `unavailable:${s.reason}` : s.kind;
    if (key !== lastEmitted) {
      lastEmitted = key;
      onUpdate?.(s);
    }
    return s;
  }

  function takeOffer(): DstSummonOffer | null {
    const t = now();
    for (const [id, o] of offers) {
      if (o.expiresAt <= t) {
        offers.delete(id);
        continue;
      }
      offers.delete(id);
      return o;
    }
    return null;
  }

  function handleHello(raw: unknown): DstHelloResponse {
    const parsed = DstHeartbeatSchema.safeParse(raw);
    if (parsed.success) {
      last = parsed.data;
      lastAt = now();
      emitIfChanged();
    }
    const offer = takeOffer();
    if (!offer) return { ok: true };
    const { expiresAt: _drop, ...wire } = offer;
    log(`handing summon of ${wire.prefab} "${wire.name}" to the world (bot port ${wire.botPort})`);
    return { ok: true, summon: wire };
  }

  function requestHandler(req: http.IncomingMessage, res: http.ServerResponse): void {
    const send = (code: number, body: unknown): void => {
      const text = JSON.stringify(body);
      res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
      res.end(text);
    };
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      return send(400, { ok: false });
    }
    if (url.pathname !== '/hello') return send(404, { ok: false });
    const q = url.searchParams.get('q') ?? '';
    if (q.length > MAX_QUERY_BYTES) return send(413, { ok: false });
    let body: unknown = {};
    if (q) {
      try {
        body = JSON.parse(q);
      } catch {
        return send(400, { ok: false });
      }
    }
    // Drain any request body (a POST variant) without reading it.
    req.resume();
    send(200, handleHello(body));
  }

  function listen(): Promise<void> {
    return new Promise((resolve) => {
      const s = http.createServer(requestHandler);
      s.on('error', (err: NodeJS.ErrnoException) => {
        bindError = err.code === 'EADDRINUSE' ? `port ${port} is in use` : err.message;
        log(`discovery listener failed on ${port}: ${bindError}`);
        server = null;
        emitIfChanged();
        resolve();
      });
      s.listen(port, '127.0.0.1', () => {
        bindError = null;
        server = s;
        log(`discovery listening on 127.0.0.1:${port}`);
        emitIfChanged();
        resolve();
      });
    });
  }

  function closeServer(): Promise<void> {
    return new Promise((resolve) => {
      const s = server;
      server = null;
      if (!s) return resolve();
      try { s.closeAllConnections?.(); } catch { /* older node */ }
      s.close(() => resolve());
    });
  }

  return {
    get port() {
      return port;
    },
    start({ onUpdate: cb }) {
      onUpdate = cb;
      if (server || timer) return;
      void listen();
      timer = setInterval(() => emitIfChanged(), pollMs);
      if (typeof timer.unref === 'function') timer.unref();
    },
    async checkNow() {
      return emitIfChanged();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      void closeServer();
      onUpdate = null;
    },
    getState: compute,
    latestHeartbeat: () => (compute().kind === 'open' ? last : null),
    setSummonOffer(characterId, offer) {
      if (offer) offers.set(characterId, offer);
      else offers.delete(characterId);
    },
    async setPort(next) {
      if (next === port && server) return;
      port = next;
      await closeServer();
      bindError = null;
      if (onUpdate) await listen();
    },
    handleHello,
  };
}
