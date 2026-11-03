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
 *
 * A world with caves is TWO server processes (the forest master shard and
 * the cave shard), and the helper runs and heartbeats on both, each listing
 * only the players on its own shard (261104). Heartbeats are therefore kept
 * PER SHARD: the world view merges them (players from every shard, world
 * facts from the shard the host is on), and an offer is handed only to the
 * shard where its player is, else to the master shard. Before this the
 * offer went to whichever shard beat first, so about half the summons into a
 * caves world spawned the body alone in the pitch-dark caves, where the
 * darkness (Charlie) killed it 10-20 s later: the DST_BODY_DIED ~24 s after
 * joining seen in 31% of DST sessions (reproduced on a headless two-shard
 * server, see native/dst-mod/sei/README.md).
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

export interface ShardBeat {
  key: string;
  hb: DstHeartbeat;
  at: number;
}

/** One key per shard: the helper's shard id (0.3.1+), else forest vs caves. */
export function dstShardKey(hb: DstHeartbeat): string {
  if (hb.shard) return `id:${hb.shard}`;
  return hb.caves ? 'caves' : 'master';
}

/** Is this heartbeat from the master (forest) shard? Older helpers: not caves. */
export function isDstMasterShard(hb: DstHeartbeat): boolean {
  return hb.mastershard ?? !hb.caves;
}

/**
 * The shard an offer must spawn on, from the fresh shards (master first):
 * the one listing the offer's player; with no player named, the first shard
 * that has anyone on it; otherwise the master shard (a player the helper
 * does not list, e.g. mid-migration, gets the old portal spawn there). Never
 * a secondary shard the player is not on: with no master shard heard from,
 * null, and the offer waits for one (or expires).
 * Pure; exported for the tests.
 */
export function dstOfferShard(nearUserid: string, fresh: readonly ShardBeat[]): string | null {
  if (fresh.length === 0) return null;
  if (nearUserid) {
    const withPlayer = fresh.find((s) => s.hb.players.some((p) => p.userid === nearUserid));
    if (withPlayer) return withPlayer.key;
  } else {
    const occupied = fresh.find((s) => s.hb.players.length > 0);
    if (occupied) return occupied.key;
  }
  return fresh.find((s) => isDstMasterShard(s.hb))?.key ?? null;
}

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
  const shards = new Map<string, ShardBeat>();
  let bindError: string | null = null;
  let lastEmitted: string | null = null;
  const offers = new Map<string, DstSummonOffer>();

  /** Shards heard from inside the stale window, master first, then newest. */
  function freshShards(): ShardBeat[] {
    const t = now();
    const fresh: ShardBeat[] = [];
    for (const [key, s] of shards) {
      if (t - s.at <= staleMs) fresh.push(s);
      else shards.delete(key);
    }
    return fresh.sort((a, b) => Number(isDstMasterShard(b.hb)) - Number(isDstMasterShard(a.hb)) || b.at - a.at);
  }

  /**
   * One heartbeat for the whole world: every shard's players (master's
   * first, deduped), the rest from the shard the first of them is on (where
   * a summon spawns), else the master shard.
   */
  function merged(): { hb: DstHeartbeat; at: number } | null {
    const fresh = freshShards();
    if (fresh.length === 0) return null;
    const players: DstHeartbeat['players'] = [];
    const seen = new Set<string>();
    for (const s of fresh) {
      for (const p of s.hb.players) {
        const id = p.userid || `name:${p.name}`;
        if (seen.has(id)) continue;
        seen.add(id);
        players.push(p);
      }
    }
    const host = players[0];
    const primary = (host && fresh.find((s) => s.hb.players.some((p) => p.userid === host.userid && p.name === host.name))) || fresh[0];
    return { hb: { ...primary.hb, players }, at: Math.max(...fresh.map((s) => s.at)) };
  }

  function compute(): DstWorldState {
    if (bindError) return { game: 'dontstarve', kind: 'unavailable', reason: bindError };
    const m = merged();
    if (m) {
      const last = m.hb;
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
        lastSeenAt: m.at,
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

  /** The first live offer whose destination is the shard that just beat. */
  function takeOffer(key: string): DstSummonOffer | null {
    const t = now();
    const fresh = freshShards();
    for (const [id, o] of offers) {
      if (o.expiresAt <= t) {
        offers.delete(id);
        continue;
      }
      if (dstOfferShard(o.nearUserid, fresh) !== key) continue;
      offers.delete(id);
      return o;
    }
    return null;
  }

  function handleHello(raw: unknown): DstHelloResponse {
    const parsed = DstHeartbeatSchema.safeParse(raw);
    // A heartbeat that does not parse still gets an ok (the helper keeps
    // going) but never an offer: the offer's shard has to be known.
    if (!parsed.success) return { ok: true, app: DST_HELLO_APP };
    const key = dstShardKey(parsed.data);
    shards.set(key, { key, hb: parsed.data, at: now() });
    emitIfChanged();
    const offer = takeOffer(key);
    if (!offer) return { ok: true, app: DST_HELLO_APP };
    const { expiresAt: _drop, ...wire } = offer;
    const where = isDstMasterShard(parsed.data) ? 'master shard' : `${parsed.data.caves ? 'cave' : 'secondary'} shard`;
    log(`handing summon of ${wire.prefab} "${wire.name}" to the world, ${where} (bot port ${wire.botPort})`);
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
    latestHeartbeat: () => (bindError ? null : merged()?.hb ?? null),
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
