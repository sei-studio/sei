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
import type { LanHost, LanState } from '../shared/ipc';
import { classifyHostClient } from './hostClient';
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

/** First candidate that answers the Minecraft status ping (with its owning
 *  pid), or null. Resolves as soon as one succeeds (Promise.any) — it does not
 *  wait out slow non-MC ports. */
async function firstMcWorld(
  ports: ListeningPort[],
): Promise<{ status: McStatus; pid: number | null } | null> {
  if (ports.length === 0) return null;
  try {
    return await Promise.any(
      ports.map((p) =>
        mcPing(p.port, '127.0.0.1', PING_TIMEOUT_MS).then((status) => ({ status, pid: p.pid })),
      ),
    );
  } catch {
    return null; // AggregateError — none spoke Minecraft
  }
}

/**
 * A previously-open world is only demoted to closed/unavailable after this
 * many CONSECUTIVE non-open polls (260703). A single slow lsof (4s timeout
 * under load) or one missed ping used to flip the state instantly — and the
 * chat companion would then confidently tell the player their open world "is
 * not broadcasting". Two misses ≈ 4s of real absence before we believe it.
 */
const OPEN_MISS_TOLERANCE = 2;

export function watchLan({ onUpdate }: WatchLanOptions): {
  stop: () => void;
  /**
   * Run one detection pass RIGHT NOW and return the raw fresh state (260703).
   * Used by the chat turn so the companion answers "is my world open?" from
   * live truth instead of an up-to-2s-stale poll — the player often messages
   * seconds after clicking "Open to LAN". Also feeds the shared emit path, so
   * the cached state + renderer pill refresh as a side effect. ~60-100ms on a
   * healthy system (one lsof + loopback pings).
   */
  checkNow: () => Promise<LanState>;
} {
  let stopped = false;
  let inFlight = false;
  let timer: NodeJS.Timeout | null = null;
  let lastEmitted: LanState | null = null;
  let missStreak = 0;
  // Host-client classification cache, keyed `${pid}:${port}`. The cmdline read
  // spawns a subprocess, so it must run once per world session, not per 2s
  // poll. A world close/reopen changes the port (random per session), so a
  // stale entry can't be re-keyed. Bounded as a leak guard.
  const hostCache = new Map<string, LanHost['client']>();
  const HOST_CACHE_MAX = 32;

  const hostFor = async (world: { status: McStatus; pid: number | null }): Promise<LanHost> => {
    const key = `${world.pid ?? '?'}:${world.status.port}`;
    let client = hostCache.get(key);
    if (client === undefined) {
      client = await classifyHostClient(world.pid);
      if (hostCache.size >= HOST_CACHE_MAX) hostCache.clear();
      hostCache.set(key, client);
    }
    return { client, forgeModCount: world.status.forgeModCount };
  };

  const emit = (next: LanState): void => {
    const changed =
      !lastEmitted ||
      lastEmitted.kind !== next.kind ||
      (next.kind === 'open' &&
        lastEmitted.kind === 'open' &&
        (next.port !== lastEmitted.port ||
          next.motd !== lastEmitted.motd ||
          next.host?.client !== lastEmitted.host?.client));
    if (changed) {
      lastEmitted = next;
      onUpdate(next);
    }
  };

  /** Emit with open→non-open hysteresis: transient misses don't demote. */
  const emitDamped = (next: LanState): void => {
    if (next.kind === 'open') {
      missStreak = 0;
      emit(next);
      return;
    }
    if (lastEmitted?.kind === 'open') {
      missStreak += 1;
      if (missStreak < OPEN_MISS_TOLERANCE) return; // hold 'open' through the blip
    }
    emit(next);
  };

  /** One full detection pass: socket table → java-first pings → state. */
  const runCheck = async (): Promise<LanState> => {
    let ports: ListeningPort[];
    try {
      ports = await listeningPorts();
    } catch {
      return { kind: 'unavailable' };
    }
    // Ping likely Minecraft (java) ports first so the common case pokes only
    // the world; fall back to the rest so a non-standard process name still
    // resolves.
    const java = ports.filter((p) => /java/i.test(p.command));
    const rest = ports.filter((p) => !/java/i.test(p.command));
    const world = (await firstMcWorld(java)) ?? (await firstMcWorld(rest));
    if (!world) return { kind: 'closed' };
    return {
      kind: 'open',
      port: world.status.port,
      motd: world.status.motd,
      lastSeenAt: Date.now(),
      host: await hostFor(world),
      // 260720 diagnostics: carry the ping's MC version + protocol through so
      // main can stamp mc_version / mc_protocol onto failed-summon diagnostics.
      versionName: world.status.versionName,
      protocol: world.status.protocol,
    };
  };

  const poll = async (): Promise<void> => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const next = await runCheck();
      if (stopped) return;
      emitDamped(next);
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
    checkNow: async (): Promise<LanState> => {
      if (stopped) return lastEmitted ?? { kind: 'closed' };
      // Deliberately ignores `inFlight` — a concurrent scheduled poll is
      // harmless (both are read-only), and the caller needs an answer now.
      const next = await runCheck();
      // UNDAMPED on purpose (260703): checkNow is a deliberate user-action-time
      // ground-truth read (chat turn, summon click), so it must NOT be held back
      // by the background poll's open→closed hysteresis (emitDamped). Broadcast
      // the fresh result straight through `emit` and reset `missStreak` so a
      // just-observed 'closed' immediately refreshes latestLanState + the pill —
      // a stale 'open' would summon into a dead world (connection error) instead
      // of showing the "open your world" modal. A false 'closed' at click time is
      // self-healing: the next poll flips back to 'open' and the LanModal
      // auto-resumes the pending summon.
      if (!stopped) {
        missStreak = 0;
        emit(next);
      }
      // Return the RAW fresh result: for the asking caller, a just-observed
      // 'closed' is the truth even while any prior damped broadcast held 'open'.
      return next;
    },
  };
}
