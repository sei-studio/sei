/**
 * Long-lived LAN watcher (Electron main process) — loopback edition.
 *
 * Detects a Minecraft "open to LAN" world on THIS machine and exposes its port
 * + MOTD to the renderer (the connection pill) and to the bot supervisor (which
 * hands the port to a summoned bot). Sei is same-machine only — the bot always
 * connects to 127.0.0.1:<lanPort> — so loopback discovery is all we need.
 *
 * History: this used to listen for Minecraft's multicast LAN beacon
 * (224.0.2.60:4445). macOS 26 tightened Local Network privacy to silently drop
 * custom multicast for SIGNED apps unless they carry the restricted
 * `com.apple.developer.networking.multicast` entitlement — and that entitlement
 * bricks app launch without an embedded provisioning profile (AMFI -413). The
 * packaged app could therefore never receive the beacon, so the pill stuck on
 * "not connected" and summon had no port. We dropped multicast entirely:
 *
 *   1. Enumerate local listening TCP ports (`listeningPorts()` — lsof/netstat).
 *   2. Status-ping the candidates over loopback (`mcPing()` — raw SLP).
 *   3. The one that speaks Minecraft IS the open world; read its port + MOTD.
 *
 * Loopback TCP is exempt from Local Network privacy, so this needs no
 * entitlement and no permission prompt. Minecraft's LAN port is random per
 * session; reading the live socket table every poll recovers it directly, so a
 * changing port is a non-issue (we never cache or guess it).
 *
 * Behavior:
 *   - Polls every POLL_INTERVAL_MS for the whole app session.
 *   - Emits `open` (with port + motd) while a world answers the ping;
 *     `closed` when none does; `unavailable` when the OS port-listing
 *     tool itself fails (re-evaluated each poll, not sticky). These describe
 *     world DETECTION, not whether a companion has joined.
 */
import type { LanState } from '../shared/ipc';
import { listeningPorts, type ListeningPort } from './listeningPorts';
import { mcPing, type McStatus } from './mcPing';

const POLL_INTERVAL_MS = 2000;
// Per-ping wall clock. Loopback status answers in single-digit ms; this only
// bounds how long a non-Minecraft listener can stall us.
const PING_TIMEOUT_MS = 700;

export interface WatchLanOptions {
  onUpdate: (state: LanState) => void;
  /** @deprecated multicast-era knob; ignored by the loopback watcher. */
  staleMs?: number;
}

/** First candidate that answers the Minecraft status ping, or null. Resolves as
 *  soon as one succeeds (Promise.any) — it does not wait out slow non-MC ports. */
async function firstMcWorld(ports: ListeningPort[]): Promise<McStatus | null> {
  if (ports.length === 0) return null;
  try {
    return await Promise.any(ports.map((p) => mcPing(p.port, '127.0.0.1', PING_TIMEOUT_MS)));
  } catch {
    return null; // AggregateError — none spoke Minecraft
  }
}

export function watchLan({ onUpdate }: WatchLanOptions): { stop: () => void } {
  let stopped = false;
  let inFlight = false;
  let timer: NodeJS.Timeout | null = null;
  let lastEmitted: LanState | null = null;

  const emit = (next: LanState): void => {
    const changed =
      !lastEmitted ||
      lastEmitted.kind !== next.kind ||
      (next.kind === 'open' &&
        lastEmitted.kind === 'open' &&
        (next.port !== lastEmitted.port || next.motd !== lastEmitted.motd));
    if (changed) {
      lastEmitted = next;
      onUpdate(next);
    }
  };

  const poll = async (): Promise<void> => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      let ports: ListeningPort[];
      try {
        ports = await listeningPorts();
      } catch {
        emit({ kind: 'unavailable' });
        return;
      }
      if (stopped) return;
      // Ping likely Minecraft (java) ports first so the common case pokes only
      // the world; fall back to the rest so a non-standard process name still
      // resolves.
      const java = ports.filter((p) => /java/i.test(p.command));
      const rest = ports.filter((p) => !/java/i.test(p.command));
      const world = (await firstMcWorld(java)) ?? (await firstMcWorld(rest));
      if (stopped) return;
      emit(
        world
          ? { kind: 'open', port: world.port, motd: world.motd, lastSeenAt: Date.now() }
          : { kind: 'closed' },
      );
    } finally {
      inFlight = false;
    }
  };

  // Fire immediately, then on a fixed cadence for the session.
  void poll();
  timer = setInterval(() => void poll(), POLL_INTERVAL_MS);

  return {
    stop: () => {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
