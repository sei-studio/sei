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
import type { LanState } from '../shared/ipc';

const MC_LAN_GROUP = '224.0.2.60';
const MC_LAN_PORT = 4445;

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
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  let lastSeenAt = 0;
  let lastPort: number | null = null;
  let lastMotd = '';
  let unavailable = false;
  let staleTimer: NodeJS.Timeout | null = null;
  let lastEmitted: LanState | null = null;
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
  // The timer attempts addMembership; on success we tentatively clear the
  // `unavailable` flag and re-emit (a real packet within ~1.5s will then
  // flip the state to 'connected'). On failure we stay polling.
  const startRescan = (): void => {
    if (rescanTimer) return;
    rescanTimer = setInterval(() => {
      try {
        socket.addMembership(MC_LAN_GROUP);
        if (unavailable) {
          // Tentatively recover from 'unavailable'; a real packet will
          // promote to 'connected'. If nothing arrives, scheduleStale's
          // expiry returns the state to 'not_connected'.
          unavailable = false;
          emit();
        }
      } catch {
        // still unavailable — keep polling
      }
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

  socket.on('error', () => {
    unavailable = true;
    emit();
  });

  socket.on('message', (msg: Buffer) => {
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
  });

  socket.bind(MC_LAN_PORT, () => {
    try {
      socket.addMembership(MC_LAN_GROUP);
    } catch {
      unavailable = true;
      emit();
    }
    // ITEM 6: kick off the rescan loop now that bind has resolved (either
    // direction — success or failure path needs the retry).
    startRescan();
  });

  // Fire initial state synchronously after bind kicks off
  setImmediate(emit);

  return {
    stop: () => {
      if (staleTimer) clearTimeout(staleTimer);
      stopRescan();
      try {
        socket.close();
      } catch {
        // ignore — socket may already be closed
      }
    },
  };
}
