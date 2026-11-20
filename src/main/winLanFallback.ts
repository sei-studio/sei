/**
 * Windows-only extra discovery for when netstat cannot see the world
 * (issue #52: some Windows 11 builds report listeners with state 0, netstat
 * drops them, and Sei sat on "No open world" with the world reachable).
 *
 * Two extra sources, both only consulted after the netstat pass found no
 * world, both verified by the watcher's status ping before use:
 *
 *   1. stateless_enum: Get-NetTCPConnection for the running Java processes
 *      (listeningPorts.winStatelessListeners). PowerShell is expensive, so it
 *      never runs on the 2s poll: a background refresh at most every 10s, and
 *      every 30s once it has come up empty six times for the same Java
 *      processes (playing single player before opening to LAN) or once it
 *      found the world. It only runs while a Java process exists (one cheap
 *      tasklist decides), and stops for the session once netstat itself has
 *      found a world (that machine's table is healthy).
 *   2. multicast: Minecraft's LAN announcement (lanBeacon.ts). Binding UDP
 *      4445 can raise a Windows Firewall prompt, so it starts only on evidence
 *      that the TCP table is broken or unreadable: a broken-state Java row
 *      (the #52 signature), PowerShell failing, tasklist failing, netstat
 *      failing, or netstat listing no listeners at all (a healthy Windows
 *      always lists some, e.g. RPC on 135). A healthy machine never binds it.
 *
 * `candidates()` is synchronous and returns the last known results, kicking a
 * refresh in the background when one is due, so a chat turn's checkNow never
 * waits on PowerShell. The first results land one poll (2s) after Java shows up.
 */
import type { ListeningPort } from './listeningPorts';
import type { BeaconHandle } from './lanBeacon';
import type { LanSource, SourceList } from './lanSources';

export const STATELESS_INTERVAL_MS = 10_000;
export const STATELESS_SLOW_INTERVAL_MS = 30_000;
/** Consecutive empty listings (same Java pids) before slowing down. */
export const STATELESS_EMPTY_RUNS_BEFORE_SLOW = 6;
/** An announcement older than this is ignored (Minecraft sends every ~1.5s). */
export const BEACON_MAX_AGE_MS = 5_000;

export interface WinFallbackDeps {
  javaPids(): Promise<number[]>;
  statelessEnum(pids: number[]): Promise<{ ports: ListeningPort[]; brokenStateSeen: boolean }>;
  startBeacon(): BeaconHandle;
  now(): number;
}

export interface FallbackContext {
  /** netstat threw. */
  primaryFailed: boolean;
  /** How many listeners netstat printed (0 on a healthy Windows is a red flag). */
  primaryListenerCount: number;
}

export interface FallbackSnapshot {
  lists: SourceList[];
  java: 'unknown' | 'none' | 'running';
  /** Java runs and no listing has finished for the current Java processes yet. */
  pending: boolean;
  statelessFailed: boolean;
  /** The #52 signature was seen this session (a Java row with state 0 / empty). */
  brokenStateSeen: boolean;
  beaconActive: boolean;
}

export interface WinLanFallback {
  candidates(ctx: FallbackContext): FallbackSnapshot;
  /** The watcher found a world; `source` is its primary source. */
  noteFound(source: LanSource): void;
  /** Resolves when no refresh is running (tests). */
  idle(): Promise<void>;
  stop(): void;
}

export function createWinLanFallback(deps: WinFallbackDeps): WinLanFallback {
  let stopped = false;
  let inflight: Promise<void> | null = null;
  let lastRunAt = -Infinity;
  let java: FallbackSnapshot['java'] = 'unknown';
  let pidKey = '';
  let pidKeyListed = '';
  let cached: ListeningPort[] = [];
  let emptyRuns = 0;
  let foundViaStateless = false;
  let statelessFailed = false;
  let brokenStateSeen = false;
  let netstatProven = false;
  let beacon: BeaconHandle | null = null;

  const startBeacon = (): void => {
    if (beacon || stopped) return;
    try {
      beacon = deps.startBeacon();
    } catch {
      beacon = null;
    }
  };

  const interval = (): number =>
    java === 'running' && (emptyRuns >= STATELESS_EMPTY_RUNS_BEFORE_SLOW || foundViaStateless)
      ? STATELESS_SLOW_INTERVAL_MS
      : STATELESS_INTERVAL_MS;

  const refresh = async (ctx: FallbackContext): Promise<void> => {
    let pids: number[];
    try {
      pids = await deps.javaPids();
    } catch {
      // No tasklist: cannot target PowerShell at Java, so listen instead.
      java = 'unknown';
      statelessFailed = true;
      startBeacon();
      return;
    }
    if (stopped) return;
    if (pids.length === 0) {
      java = 'none';
      pidKey = '';
      cached = [];
      emptyRuns = 0;
      foundViaStateless = false;
      return;
    }
    java = 'running';
    const key = pids.join(',');
    if (key !== pidKey) {
      pidKey = key;
      emptyRuns = 0;
      foundViaStateless = false;
    }
    if (ctx.primaryFailed || ctx.primaryListenerCount === 0) startBeacon();
    try {
      const r = await deps.statelessEnum(pids);
      if (stopped) return;
      cached = r.ports;
      statelessFailed = false;
      if (r.brokenStateSeen) brokenStateSeen = true;
      emptyRuns = r.ports.length === 0 ? emptyRuns + 1 : 0;
    } catch {
      if (stopped) return;
      cached = [];
      statelessFailed = true;
    }
    pidKeyListed = key;
    if (brokenStateSeen || statelessFailed) startBeacon();
  };

  return {
    candidates(ctx: FallbackContext): FallbackSnapshot {
      const t = deps.now();
      const skipStateless = netstatProven && !ctx.primaryFailed && ctx.primaryListenerCount > 0;
      if (!stopped && !skipStateless && !inflight && t - lastRunAt >= interval()) {
        lastRunAt = t;
        inflight = refresh(ctx)
          .catch(() => undefined)
          .finally(() => {
            inflight = null;
          });
      }
      const lists: SourceList[] = [];
      if (!skipStateless && java === 'running' && cached.length) {
        lists.push({ source: 'stateless_enum', ports: cached });
      }
      if (beacon) {
        lists.push({
          source: 'multicast',
          ports: beacon.entries(BEACON_MAX_AGE_MS).map((e) => ({ port: e.port, pid: null, command: '' })),
        });
      }
      return {
        lists,
        java,
        pending: (java === 'running' && pidKeyListed !== pidKey) || (java === 'unknown' && !statelessFailed && !skipStateless),
        statelessFailed,
        brokenStateSeen,
        beaconActive: beacon != null,
      };
    },
    noteFound(source: LanSource): void {
      if (source === 'netstat') netstatProven = true;
      if (source === 'stateless_enum') foundViaStateless = true;
    },
    idle: async () => {
      while (inflight) await inflight;
    },
    stop(): void {
      stopped = true;
      beacon?.stop();
      beacon = null;
    },
  };
}
