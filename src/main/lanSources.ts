/**
 * Discovery sources for the LAN watcher and how their candidates are merged,
 * ordered and verified (issue #52). Pure apart from the injected ping, so it
 * is unit-tested without sockets.
 *
 * Sources, in priority order (a port listed by several keeps the first as its
 * primary source; all of them are reported):
 *   - netstat / lsof: the OS listening-socket table, every poll.
 *   - stateless_enum: Windows Get-NetTCPConnection rows owned by Java with a
 *     broken (empty / 0) state, which netstat leaves out on some builds.
 *   - multicast: Minecraft's own LAN announcement (Windows only).
 * No source is trusted on its own: a port is only used once the loopback
 * Minecraft status ping answers on it.
 */
import type { ListeningPort } from './listeningPorts';
import type { McStatus } from './mcPing';
import type { LanDiscoveryClass } from '../shared/setupTelemetry';

export type LanSource = 'netstat' | 'lsof' | 'stateless_enum' | 'multicast';

export const LAN_SOURCE_PRIORITY: readonly LanSource[] = ['netstat', 'lsof', 'stateless_enum', 'multicast'];

export interface LanCandidate {
  port: number;
  pid: number | null;
  command: string;
  /** Every source that listed this port, in priority order. */
  sources: LanSource[];
}

export interface SourceList {
  source: LanSource;
  ports: readonly ListeningPort[];
}

const rank = (s: LanSource): number => LAN_SOURCE_PRIORITY.indexOf(s);

/** Dedupe by port across sources. pid / command come from the first source
 *  (by priority) that knows them. */
export function mergeCandidates(lists: readonly SourceList[]): LanCandidate[] {
  const sorted = [...lists].sort((a, b) => rank(a.source) - rank(b.source));
  const byPort = new Map<number, LanCandidate>();
  for (const { source, ports } of sorted) {
    for (const p of ports) {
      const c = byPort.get(p.port);
      if (!c) {
        byPort.set(p.port, { port: p.port, pid: p.pid, command: p.command, sources: [source] });
        continue;
      }
      if (!c.sources.includes(source)) c.sources.push(source);
      if (c.pid == null && p.pid != null) c.pid = p.pid;
      if (!c.command && p.command) c.command = p.command;
    }
  }
  return [...byPort.values()];
}

const isJava = (c: LanCandidate): boolean => /java/i.test(c.command);
const isFallback = (s: LanSource): boolean => s === 'stateless_enum' || s === 'multicast';

/**
 * Ping order: Java-owned ports first (the common case pokes only the world),
 * then ports a fallback source pointed at (Java-owned rows or an actual
 * announcement, so likely), then everything else the socket table listed.
 * Empty tiers are dropped.
 */
export function pingTiers(cands: readonly LanCandidate[]): LanCandidate[][] {
  const java = cands.filter(isJava);
  const hinted = cands.filter((c) => !isJava(c) && c.sources.some(isFallback));
  const rest = cands.filter((c) => !isJava(c) && !c.sources.some(isFallback));
  return [java, hinted, rest].filter((t) => t.length > 0);
}

export type PingFn = (port: number) => Promise<McStatus>;

/**
 * First candidate that answers the status ping, tier by tier. Within a tier
 * the first answer wins (Promise.any), so a slow non-Minecraft port never
 * holds up the world.
 */
export async function verifyCandidates(
  tiers: readonly LanCandidate[][],
  ping: PingFn,
): Promise<{ status: McStatus; candidate: LanCandidate } | null> {
  for (const tier of tiers) {
    if (tier.length === 0) continue;
    try {
      return await Promise.any(tier.map((c) => ping(c.port).then((status) => ({ status, candidate: c }))));
    } catch {
      /* AggregateError: nobody in this tier spoke Minecraft */
    }
  }
  return null;
}

/**
 * Why no world was found (analytics `discovery` class; the closed set lives
 * in src/shared/setupTelemetry.ts as LanDiscoveryClass):
 *   - enum_failed: the OS socket listing itself failed and nothing else found it.
 *   - no_java: Windows, tasklist shows no Java process (Minecraft is not running).
 *   - pending: Windows, the fallback listing (or its Java check) has not
 *     answered yet.
 *   - stateless_failed: Windows, Java runs, netstat found no world and the
 *     Get-NetTCPConnection fallback could not run (blocked or broken PowerShell).
 *   - no_java_listener: no candidate came from a Java process or an
 *     announcement (on a healthy machine: Minecraft is not opened to LAN).
 *   - unverified: Java-owned or announced ports exist but none answered the
 *     status ping.
 */
export type LanDiscoveryFailure = LanDiscoveryClass;

export interface DiagnoseInput {
  primaryFailed: boolean;
  candidates: readonly LanCandidate[];
  /** Windows fallback state; null on macOS / Linux. */
  win: { java: 'unknown' | 'none' | 'running'; pending: boolean; statelessFailed: boolean } | null;
}

export function diagnoseNoWorld(input: DiagnoseInput): LanDiscoveryFailure {
  const { win, candidates } = input;
  const likely = candidates.filter((c) => isJava(c) || c.sources.some(isFallback));
  if (input.primaryFailed && candidates.length === 0) return 'enum_failed';
  if (win?.java === 'none') return 'no_java';
  if (likely.length > 0) return 'unverified';
  if (win?.java === 'running' && win.statelessFailed) return 'stateless_failed';
  if (win?.pending) return 'pending';
  return 'no_java_listener';
}

/** Why the latest pass found no world, for the lan_wait failure event. */
export interface LanDiagnosis {
  discovery: LanDiscoveryFailure;
  brokenStateSeen: boolean;
}

// Held here (not in lanWatcher) so the analytics:track handler can read it
// without importing the watcher's module graph.
let latestDiagnosis: LanDiagnosis | null = null;

export function setLanDiagnosis(d: LanDiagnosis | null): void {
  latestDiagnosis = d;
}

/** The latest pass's no-world diagnosis (null while a world is open or before
 *  the first pass). Read when a lan_wait ends without a world. */
export function getLanDiagnosis(): LanDiagnosis | null {
  return latestDiagnosis;
}
