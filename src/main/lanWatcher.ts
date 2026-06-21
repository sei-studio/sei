/**
 * Long-lived multicast LAN watcher (Electron main process).
 *
 * Sources:
 *   - RESEARCH §Pattern 3 (lines 491–541) — verbatim algorithm
 *   - PATTERNS §src/main/lanWatcher.ts — refactor target
 *   - CONTEXT D-20, D-21, D-22 (three-state pill)
 *
 * Behavior:
 *   - Opens once at app boot; lives for the whole app session.
 *   - UDP socket bound to 4445 with reuseAddr:true; joins 224.0.2.60.
 *   - Emits `connected` after each fresh packet; `not_connected` after staleMs;
 *     `unavailable` (sticky) on addMembership failure.
 *
 * Renderer consumes via webContents.send('lan:state', ...) wired in plan 05.
 */
import dgram from 'node:dgram';
import os from 'node:os';
import type { LanState } from '../shared/ipc';

const MC_LAN_GROUP = '224.0.2.60';
const MC_LAN_PORT = 4445;

/**
 * Sei only joins LAN worlds on the SAME machine — the bot always connects to
 * `127.0.0.1:<lanPort>` (see src/bot/index.js). A Minecraft open-to-LAN beacon
 * is multicast to the whole subnet, so on a network with more than one PC
 * running Minecraft (or while testing across a Mac + Windows box at once) the
 * watcher would otherwise pick up ANOTHER machine's beacon and report
 * "connected" for a world that loopback can't reach — the observed Windows
 * "says connected when Minecraft isn't even open" false positive. We therefore
 * accept a beacon only when its sender address is this host's (loopback or one
 * of the local interface addresses).
 */
function isLoopbackAddr(addr: string): boolean {
  return (
    addr === '127.0.0.1' ||
    addr.startsWith('127.') ||
    addr === '::1' ||
    addr === '::ffff:127.0.0.1'
  );
}

/** Set of this machine's own addresses (loopback + every interface), incl. the
 *  IPv4-mapped IPv6 form a udp4 socket may surface for v4 senders. Recomputed
 *  per call — cheap, and stays correct across Wi-Fi/VPN interface changes. */
function localAddressSet(): Set<string> {
  const set = new Set<string>(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list ?? []) {
        set.add(ni.address);
        if (ni.family === 'IPv4') set.add(`::ffff:${ni.address}`);
      }
    }
  } catch {
    /* best-effort — fall back to the loopback-only seed set */
  }
  return set;
}

function isLocalSender(addr: string | undefined): boolean {
  if (!addr) return false;
  return isLoopbackAddr(addr) || localAddressSet().has(addr);
}

/**
 * ITEM 6 (quick/260523-t8d): re-attempt addMembership every 5s while the
 * launcher is disconnected. This catches the "world opened BEFORE launcher
 * started" case where the initial addMembership() races a not-yet-ready
 * network interface — without retry, the launcher stays 'not_connected'
 * forever even after Minecraft starts beaconing every ~1.5s.
 *
 * Combined latency for the "world opened first" path: 5s rescan + up to
 * 1.5s next beacon = ≤ 6.5s to flip to 'connected'.
 */
const LAN_RESCAN_INTERVAL_MS = 5000;

export interface WatchLanOptions {
  onUpdate: (state: LanState) => void;
  staleMs?: number; // default 3000ms (D-22)
}

export function watchLan({ onUpdate, staleMs = 3000 }: WatchLanOptions): { stop: () => void } {
  let socket: dgram.Socket | null = null;
  let lastSeenAt = 0;
  let lastPort: number | null = null;
  let lastMotd = '';
  let unavailable = false;
  let staleTimer: NodeJS.Timeout | null = null;
  let lastEmitted: LanState | null = null;
  let stopped = false;
  // ITEM 6: rescan timer — only runs while we're disconnected.
  let rescanTimer: NodeJS.Timeout | null = null;

  const compute = (): LanState => {
    if (unavailable) return { kind: 'unavailable' };
    const fresh = lastSeenAt > 0 && Date.now() - lastSeenAt <= staleMs;
    if (fresh && lastPort !== null) {
      return { kind: 'connected', port: lastPort, motd: lastMotd, lastSeenAt };
    }
    return { kind: 'not_connected' };
  };

  // ITEM 6: start / stop the re-scan loop based on state.
  //   - Disconnected (kind === 'not_connected' | 'unavailable') → ensure timer.
  //   - Connected → ensure timer is stopped.
  //
  // The timer RECREATES the receive socket (fresh bind + addMembership). This
  // is deliberately heavier than a bare addMembership retry: a summon/unsummon
  // cycle can leave the long-lived socket no longer receiving the host's LAN
  // beacon (observed bug: the pill flips connected → not_connected and stays
  // stuck there). On the existing socket, re-issuing addMembership throws
  // "already a member" and never re-establishes multicast delivery — so the
  // only reliable recovery is a brand-new socket. A real packet within ~1.5s
  // of the fresh bind then promotes the state back to 'connected'.
  const startRescan = (): void => {
    if (rescanTimer || stopped) return;
    rescanTimer = setInterval(() => {
      createSocket();
    }, LAN_RESCAN_INTERVAL_MS);
  };

  const stopRescan = (): void => {
    if (rescanTimer) {
      clearInterval(rescanTimer);
      rescanTimer = null;
    }
  };

  const emit = (): void => {
    const next = compute();
    // Only fire when state.kind changes OR connected payload changes
    const changed =
      !lastEmitted ||
      lastEmitted.kind !== next.kind ||
      (next.kind === 'connected' &&
        lastEmitted.kind === 'connected' &&
        (next.port !== lastEmitted.port || next.motd !== lastEmitted.motd));
    if (changed) {
      lastEmitted = next;
      onUpdate(next);
    }
    // ITEM 6: keep the rescan loop in sync with current state.
    if (next.kind === 'connected') stopRescan();
    else startRescan();
  };

  const scheduleStale = (): void => {
    if (staleTimer) clearTimeout(staleTimer);
    staleTimer = setTimeout(emit, staleMs + 100);
  };

  const onMessage = (msg: Buffer, rinfo: dgram.RemoteInfo): void => {
    // Reject beacons from other machines — only same-host worlds are reachable
    // over the loopback the bot connects through (see isLocalSender note above).
    if (!isLocalSender(rinfo?.address)) return;
    const text = msg.toString('utf-8');
    const portMatch = text.match(/\[AD\](\d{1,5})\[\/AD\]/);
    if (!portMatch) return;
    const port = Number(portMatch[1]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return;
    lastPort = port;
    lastMotd = text.match(/\[MOTD\](.*?)\[\/MOTD\]/)?.[1] ?? '';
    lastSeenAt = Date.now();
    emit();
    scheduleStale();
  };

  // (Re)create the receive socket. Called once at startup and again by the
  // rescan loop to recover from a dropped multicast subscription. The old
  // socket (if any) is closed first so we never leak fds across recreations.
  const createSocket = (): void => {
    if (stopped) return;
    const prev = socket;
    if (prev) {
      prev.removeAllListeners();
      try {
        prev.close();
      } catch {
        // ignore — may already be closed
      }
    }
    const next = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    socket = next;
    next.on('error', () => {
      // Only act on the live socket; a stale handler from a closed socket
      // must not clobber state.
      if (socket !== next) return;
      unavailable = true;
      emit();
    });
    next.on('message', (msg: Buffer, rinfo: dgram.RemoteInfo) => {
      if (socket !== next) return;
      onMessage(msg, rinfo);
    });
    next.bind(MC_LAN_PORT, () => {
      if (socket !== next) return;
      try {
        next.addMembership(MC_LAN_GROUP);
        // A fresh join clears any prior 'unavailable'; a real packet will
        // promote to 'connected'. If nothing arrives, scheduleStale's expiry
        // (or the next rescan) keeps the state correct.
        unavailable = false;
        emit();
      } catch {
        unavailable = true;
        emit();
      }
      // ITEM 6: ensure the rescan loop is running whenever we're not connected.
      startRescan();
    });
  };

  createSocket();

  // Fire initial state synchronously after bind kicks off
  setImmediate(emit);

  return {
    stop: () => {
      stopped = true;
      if (staleTimer) clearTimeout(staleTimer);
      stopRescan();
      if (socket) {
        socket.removeAllListeners();
        try {
          socket.close();
        } catch {
          // ignore — socket may already be closed
        }
        socket = null;
      }
    },
  };
}
