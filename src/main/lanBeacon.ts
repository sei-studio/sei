/**
 * Minecraft's "Open to LAN" multicast announcement (224.0.2.60:4445), as an
 * extra discovery source on Windows only (issue #52).
 *
 * The world sends `[MOTD]<motd>[/MOTD][AD]<port>[/AD]` about every 1.5 s.
 * Sei stopped listening for it in v0.3.1 because macOS 26 drops custom
 * multicast for signed apps without a restricted entitlement (see the
 * lanWatcher.ts header). Windows has no such gate, and on Windows builds whose
 * TCP table hides listeners (state 0) the announcement is one of the few
 * places the port still shows up. macOS and Linux never start this.
 *
 * Rules:
 *   - A beacon is a HINT. Its port is only used after the loopback status
 *     ping answers, so another PC's world on the same network (the old
 *     "connected when Minecraft is not even open" false positive) can never
 *     be reported: its port does not answer on 127.0.0.1.
 *   - Binding a UDP port on all interfaces can raise the Windows Firewall
 *     prompt, so winLanFallback.ts starts this only when the TCP table is
 *     shown to be broken or unreadable, never on a healthy machine.
 *   - Never throws. A bind or membership failure leaves it inert and it
 *     retries by recreating the socket, like the pre-v0.3.1 watcher did (a
 *     long-lived socket could stop receiving after a summon cycle).
 */
import dgram from 'node:dgram';

export const MC_LAN_GROUP = '224.0.2.60';
export const MC_LAN_PORT = 4445;

/** Recreate the socket after this long without any announcement. */
const RECREATE_IDLE_MS = 30_000;
/** At most this many distinct announced ports are kept (newest first). */
const MAX_ENTRIES = 8;

export interface LanAnnouncement {
  port: number;
  motd: string;
}

export interface BeaconEntry extends LanAnnouncement {
  lastSeenAt: number;
}

/**
 * Parse one announcement datagram. Vanilla sends the bare port in [AD]; a
 * `host:port` form is accepted too. Returns null for anything else.
 */
export function parseLanAnnouncement(text: string): LanAnnouncement | null {
  const ad = text.match(/\[AD\](?:[^[\]]*:)?(\d{1,5})\[\/AD\]/);
  if (!ad) return null;
  const port = Number(ad[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const motd = text.match(/\[MOTD\]([\s\S]*?)\[\/MOTD\]/)?.[1] ?? '';
  return { port, motd };
}

export interface BeaconHandle {
  /** Announced ports seen within `maxAgeMs`, newest first. */
  entries(maxAgeMs: number): BeaconEntry[];
  /** True once a socket has bound and joined the group at least once. */
  readonly listening: boolean;
  stop(): void;
}

export interface BeaconDeps {
  createSocket?: () => dgram.Socket;
  now?: () => number;
}

export function startLanBeacon(deps: BeaconDeps = {}): BeaconHandle {
  const now = deps.now ?? Date.now;
  const createSocket = deps.createSocket ?? (() => dgram.createSocket({ type: 'udp4', reuseAddr: true }));
  const seen = new Map<number, BeaconEntry>();
  let socket: dgram.Socket | null = null;
  let stopped = false;
  let listening = false;
  let lastPacketAt = 0;
  let openedAt = 0;
  let timer: NodeJS.Timeout | null = null;

  const closeSocket = (): void => {
    const s = socket;
    socket = null;
    if (!s) return;
    s.removeAllListeners();
    s.on('error', () => undefined);
    try {
      s.close();
    } catch {
      /* already closed */
    }
  };

  const onMessage = (msg: Buffer): void => {
    const a = parseLanAnnouncement(msg.toString('utf8'));
    if (!a) return;
    const t = now();
    lastPacketAt = t;
    seen.delete(a.port); // re-insert so Map order stays oldest -> newest
    seen.set(a.port, { ...a, lastSeenAt: t });
    while (seen.size > MAX_ENTRIES) {
      const oldest = seen.keys().next().value as number;
      seen.delete(oldest);
    }
  };

  const open = (): void => {
    if (stopped) return;
    closeSocket();
    openedAt = now();
    let s: dgram.Socket;
    try {
      s = createSocket();
    } catch {
      return;
    }
    socket = s;
    s.on('error', () => closeSocket());
    s.on('message', onMessage);
    try {
      s.bind(MC_LAN_PORT, () => {
        if (socket !== s) return;
        try {
          s.addMembership(MC_LAN_GROUP);
          listening = true;
        } catch {
          closeSocket();
        }
      });
    } catch {
      closeSocket();
    }
  };

  open();
  timer = setInterval(() => {
    const t = now();
    const idleSince = Math.max(lastPacketAt, openedAt);
    if (!socket || t - idleSince >= RECREATE_IDLE_MS) open();
  }, 10_000);
  timer.unref?.();

  return {
    entries(maxAgeMs: number): BeaconEntry[] {
      const t = now();
      return [...seen.values()].filter((e) => t - e.lastSeenAt <= maxAgeMs).reverse();
    },
    get listening() {
      return listening;
    },
    stop(): void {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      closeSocket();
      seen.clear();
    },
  };
}
