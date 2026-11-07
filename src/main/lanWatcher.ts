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
 * Windows extra sources (issue #52, 261107): some Windows 11 builds report a
 * listener's state as 0, so netstat leaves Minecraft's port out while the
 * port still answers. When netstat finds no world, winLanFallback.ts adds
 * Java-owned Get-NetTCPConnection rows with a broken state and, once the
 * table is shown to be broken, Minecraft's own multicast announcement
 * (Windows has no multicast gate). Their ports go through the same status
 * ping, so a wrong hint costs one refused connect. `lan_world_found` records
 * which source found the world; getLanDiagnosis() says why none was found.
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
import { classifyCmdline, cmdlineForPid, hasForgeLaunchTarget } from './hostClient';
import { inspectHostMods } from './hostSetup';
import { listeningPorts, winJavaPids, winStatelessListeners, type ListeningPort } from './listeningPorts';
import { mcPing, type McStatus } from './mcPing';
import { startLanBeacon } from './lanBeacon';
import {
  diagnoseNoWorld,
  mergeCandidates,
  pingTiers,
  setLanDiagnosis,
  verifyCandidates,
  type LanCandidate,
  type LanSource,
  type PingFn,
} from './lanSources';
import { createWinLanFallback, type WinLanFallback } from './winLanFallback';
import { loadAnalytics } from './lazyAnalytics';

const POLL_INTERVAL_MS = 2000;
// Per-ping wall clock. Loopback status answers in single-digit ms; this only
// bounds how long a non-Minecraft listener can stall us.
const PING_TIMEOUT_MS = 700;

/** Shape-only facts about how a world was found (analytics). */
export interface LanFoundMeta {
  source: LanSource;
  sources: LanSource[];
  javaOwned: boolean;
  /** Windows: the #52 broken-state signature was seen this session. */
  brokenStateSeen: boolean;
  /** Windows: the multicast fallback was running. */
  beaconActive: boolean;
}

export const LAN_WORLD_FOUND_EVENT = 'lan_world_found';

export interface WatchLanOptions {
  onUpdate: (state: LanState) => void;
  /** @deprecated multicast-era knob; ignored by the loopback watcher. */
  staleMs?: number;
  // Test seams; production uses the defaults.
  listPorts?: () => Promise<ListeningPort[]>;
  ping?: PingFn;
  /** Windows extra sources (issue #52). Default: created on win32, null elsewhere. */
  fallback?: WinLanFallback | null;
  /** Default: `lan_world_found` through the lazy analytics import. */
  onFound?: (meta: LanFoundMeta) => void;
  platform?: NodeJS.Platform;
}

/** `lan_world_found` props, shape only. */
export function lanFoundProps(meta: LanFoundMeta): Record<string, string | boolean> {
  return {
    source: meta.source,
    sources: meta.sources.join(','),
    java_owned: meta.javaOwned,
    win_state0: meta.brokenStateSeen,
    beacon_active: meta.beaconActive,
  };
}

const trackFound = (meta: LanFoundMeta): void => {
  void loadAnalytics()
    .then((a) => a.capture(LAN_WORLD_FOUND_EVENT, lanFoundProps(meta)))
    .catch(() => {
      /* analytics is never load-bearing */
    });
};

function defaultWinFallback(): WinLanFallback {
  return createWinLanFallback({
    javaPids: winJavaPids,
    statelessEnum: winStatelessListeners,
    startBeacon: () => startLanBeacon(),
    now: Date.now,
  });
}

/**
 * A previously-open world is only demoted to closed/unavailable after this
 * many CONSECUTIVE non-open polls (260703). A single slow lsof (4s timeout
 * under load) or one missed ping used to flip the state instantly — and the
 * chat companion would then confidently tell the player their open world "is
 * not broadcasting". Two misses ≈ 4s of real absence before we believe it.
 */
const OPEN_MISS_TOLERANCE = 2;

export function watchLan({
  onUpdate,
  listPorts = listeningPorts,
  ping = (port) => mcPing(port, '127.0.0.1', PING_TIMEOUT_MS),
  fallback,
  onFound = trackFound,
  platform = process.platform,
}: WatchLanOptions): {
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
  const primarySource: LanSource = platform === 'win32' ? 'netstat' : 'lsof';
  const win: WinLanFallback | null =
    fallback !== undefined ? fallback : platform === 'win32' ? defaultWinFallback() : null;
  // Meta of the world the latest pass found, keyed by port, read by emit().
  let foundMeta: { port: number; meta: LanFoundMeta } | null = null;
  // Host-client classification cache, keyed `${pid}:${port}`. The cmdline read
  // spawns a subprocess, so it must run once per world session, not per 2s
  // poll. A world close/reopen changes the port (random per session), so a
  // stale entry can't be re-keyed. Bounded as a leak guard. 260721: the cache
  // now carries the whole classification (client + Sei-skin-setup mods scan),
  // since a process's loaded mods are fixed at launch. forgeModCount is
  // deliberately NOT cached — it rides each poll's ping.
  const hostCache = new Map<string, Omit<LanHost, 'forgeModCount'>>();
  const HOST_CACHE_MAX = 32;

  const hostFor = async (world: { status: McStatus; pid: number | null }): Promise<LanHost> => {
    const key = `${world.pid ?? '?'}:${world.status.port}`;
    let cached = hostCache.get(key);
    if (cached === undefined) {
      const cmdline = await cmdlineForPid(world.pid);
      const client = classifyCmdline(cmdline);
      // Fabric is (usually) Sei's own skin setup — scan the host's mods dir
      // so lanHostWarning() can tell our setup apart from a genuinely modded
      // world. Other loaders warn regardless, so skip the scan there.
      const mods =
        client === 'fabric'
          ? await inspectHostMods(cmdline)
          : { seiSkinMod: false, otherModCount: null };
      cached = {
        client,
        seiSkinMod: mods.seiSkinMod,
        otherModCount: mods.otherModCount,
        // 260929: strong cmdline evidence for the Forge hard stop.
        forgeLaunchTarget: hasForgeLaunchTarget(cmdline),
      };
      if (hostCache.size >= HOST_CACHE_MAX) hostCache.clear();
      hostCache.set(key, cached);
    }
    return { ...cached, forgeModCount: world.status.forgeModCount };
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
    const newWorld =
      next.kind === 'open' && (lastEmitted?.kind !== 'open' || lastEmitted.port !== next.port);
    if (changed) {
      lastEmitted = next;
      onUpdate(next);
    }
    if (newWorld && foundMeta?.port === next.port) {
      try {
        onFound(foundMeta.meta);
      } catch {
        /* analytics is never load-bearing */
      }
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

  /**
   * One full detection pass:
   *   1. the OS socket table (netstat / lsof), java-first status pings;
   *   2. Windows only, when (1) found nothing: the extra sources (issue #52)
   *      for ports netstat did not list, pinged the same way.
   * Every port is verified by the status ping before it is reported.
   */
  const runCheck = async (): Promise<LanState> => {
    let ports: ListeningPort[] = [];
    let primaryFailed = false;
    try {
      ports = await listPorts();
    } catch {
      primaryFailed = true;
    }
    const primary = mergeCandidates([{ source: primarySource, ports }]);
    let world = primaryFailed ? null : await verifyCandidates(pingTiers(primary), ping);
    let snap: ReturnType<WinLanFallback['candidates']> | null = null;
    let extra: LanCandidate[] = [];
    if (!world && win) {
      snap = win.candidates({ primaryFailed, primaryListenerCount: ports.length });
      const listed = new Set(primary.map((c) => c.port));
      extra = mergeCandidates(snap.lists).filter((c) => !listed.has(c.port));
      world = await verifyCandidates(pingTiers(extra), ping);
    }
    if (!world) {
      setLanDiagnosis({
        discovery: diagnoseNoWorld({
          primaryFailed,
          candidates: [...primary, ...extra],
          win: snap ? { java: snap.java, pending: snap.pending, statelessFailed: snap.statelessFailed } : null,
        }),
        brokenStateSeen: snap?.brokenStateSeen ?? false,
      });
      return primaryFailed ? { kind: 'unavailable' } : { kind: 'closed' };
    }
    setLanDiagnosis(null);
    const { status, candidate } = world;
    win?.noteFound(candidate.sources[0]);
    foundMeta = {
      port: status.port,
      meta: {
        source: candidate.sources[0],
        sources: candidate.sources,
        javaOwned: /java/i.test(candidate.command),
        brokenStateSeen: snap?.brokenStateSeen ?? false,
        beaconActive: snap?.beaconActive ?? false,
      },
    };
    return {
      kind: 'open',
      port: status.port,
      motd: status.motd,
      lastSeenAt: Date.now(),
      host: await hostFor({ status, pid: candidate.pid }),
      // 260720 diagnostics: carry the ping's MC version + protocol through so
      // main can stamp mc_version / mc_protocol onto failed-summon diagnostics.
      versionName: status.versionName,
      protocol: status.protocol,
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
      win?.stop();
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
