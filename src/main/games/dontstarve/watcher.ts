/**
 * Don't Starve Together world watcher (game-adapters M2, 260908).
 *
 * Discovery is INBOUND: the mod inside the player's game can only make HTTP
 * requests to localhost, so main keeps a long-lived `node:http` listener on
 * the first FREE port of DST_DISCOVERY_PORTS (260909: was one fixed,
 * user-settable port) and the mod probes the same list, GETting
 * /hello?q=<json> every 2 s on whichever answered as Sei (PROTOCOL.md). A
 * heartbeat inside DST_HEARTBEAT_STALE_MS = the world is open; nothing for
 * longer = closed. `not_installed` is decided by the module (install
 * detection), not here.
 *
 * The /hello response is where a SUMMON is handed to the mod: once the bot
 * runtime reports its loopback listener ({type:'dst-listen'} through the
 * supervisor), the module calls setSummonOffer(characterId, offer) and the
 * next heartbeat carries it. An offer is delivered once, expires with the
 * supervisor's summon deadline, and one offer per heartbeat keeps a
 * two-companion summon orderly (the second rides the following beat).
 *
 * Only when EVERY candidate refuses to bind is the state `unavailable`, with
 * a reason the launch panel shows; nothing throws.
 */
import http from 'node:http';
import type { WorldState } from '../../../shared/gameIpc';
import {
  DST_DISCOVERY_PORTS,
  DST_HELLO_APP,
  DST_HEARTBEAT_STALE_MS,
  DstHeartbeatSchema,
  type DstHeartbeat,
  type DstHelloResponse,
  type DstSummonOffer,
  type DstWorldState,
} from '../../../shared/dstIpc';

export interface DstWatcherOptions {
  /** Candidate ports, tried in order; the first free one is bound. `port: 0` (tests) = any free port. */
  ports?: readonly number[];
  /** Single-candidate shorthand for `ports`. */
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
  /** Close and bind again (walks the candidates from the top). */
  rebind(): Promise<void>;
  /** The bound port; the first candidate while nothing is bound. */
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
  const candidates: readonly number[] = opts.ports ?? (opts.port != null ? [opts.port] : DST_DISCOVERY_PORTS);
  let port = candidates[0];

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
    if (!offer) return { ok: true, app: DST_HELLO_APP };
    const { expiresAt: _drop, ...wire } = offer;
    log(`handing summon of ${wire.prefab} "${wire.name}" to the world (bot port ${wire.botPort})`);
    return { ok: true, app: DST_HELLO_APP, summon: wire };
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

  /** Try to bind ONE port; resolves to the error code (null = bound). */
  function tryListen(p: number): Promise<string | null> {
    return new Promise((resolve) => {
      const s = http.createServer(requestHandler);
      s.on('error', (err: NodeJS.ErrnoException) => {
        resolve(err.code === 'EADDRINUSE' ? `port ${p} is in use` : err.message);
      });
      s.listen(p, '127.0.0.1', () => {
        server = s;
        port = (s.address() as { port: number }).port;
        resolve(null);
      });
    });
  }

  /** Walk the candidates; the first free one wins. */
  async function listen(): Promise<void> {
    const reasons: string[] = [];
    for (const p of candidates) {
      const reason = await tryListen(p);
      if (reason == null) {
        bindError = null;
        log(`discovery listening on 127.0.0.1:${port}${reasons.length ? ` (${reasons.join('; ')})` : ''}`);
        emitIfChanged();
        return;
      }
      reasons.push(reason);
    }
    bindError = reasons.join('; ') || 'no candidate port';
    server = null;
    log(`discovery listener failed: ${bindError}`);
    emitIfChanged();
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
    async rebind() {
      await closeServer();
      bindError = null;
      port = candidates[0];
      if (onUpdate) await listen();
    },
    handleHello,
  };
}
