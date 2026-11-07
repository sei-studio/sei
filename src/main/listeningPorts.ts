/**
 * Enumerate the local machine's listening TCP ports — the loopback replacement
 * for Minecraft's multicast LAN beacon (see src/main/mcPing.ts header for why
 * multicast was dropped). Minecraft's "open to LAN" server binds a *random*
 * free port each session and advertises it only via the beacon; reading the
 * live socket table here recovers that port directly, so a port that changes
 * every time is a non-issue — we never cache or guess it.
 *
 * macOS / Linux use `lsof`; Windows uses `netstat` (plus a memoized `tasklist`
 * lookup for process names — netstat can't name socket owners without
 * elevation). All ship with the OS and none needs elevated privileges or any
 * networking entitlement. Each entry carries the owning process command when
 * available so the watcher can ping likely Minecraft (java) ports first.
 */
import { execFile } from 'node:child_process';

export interface ListeningPort {
  port: number;
  command: string; // best-effort owning-process name ('' when unknown)
  pid: number | null; // best-effort owning-process id (null when unknown)
}

function run(cmd: string, args: string[], timeoutMs = 4000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      // lsof exits non-zero when nothing matches; treat any stdout as usable.
      if (err && !stdout) reject(err);
      else resolve(stdout ?? '');
    });
  });
}

export function parseLsof(out: string): ListeningPort[] {
  const ports = new Map<number, { command: string; pid: number | null }>();
  for (const line of out.split('\n')) {
    if (!line || line.startsWith('COMMAND')) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 9) continue;
    const command = parts[0];
    // PID column (col 2). Best-effort — a non-numeric token degrades to null.
    const pidNum = Number(parts[1]);
    const pid = Number.isInteger(pidNum) && pidNum > 0 ? pidNum : null;
    // NAME column: `*:61871`, `127.0.0.1:54321`, `[::1]:25565`, `localhost:8080`.
    const name = parts[8];
    const m = name.match(/:(\d+)$/);
    if (!m) continue;
    const port = Number(m[1]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    // Keep the first command seen for a port (prefer a named owner over '').
    if (!ports.has(port) || (ports.get(port)?.command === '' && command)) {
      ports.set(port, { command, pid });
    }
  }
  return [...ports.entries()].map(([port, v]) => ({ port, command: v.command, pid: v.pid }));
}

export function parseNetstat(out: string): ListeningPort[] {
  const ports = new Map<number, number | null>();
  for (const line of out.split('\n')) {
    const parts = line.trim().split(/\s+/);
    // TCP rows (both address families — issue #5: modern Java binds "Open to
    // LAN" as a dual-stack socket that appears ONLY in the IPv6 table):
    //   `TCP  0.0.0.0:61871  0.0.0.0:0  LISTENING  1234`
    //   `TCP  [::]:61871     [::]:0     LISTENING  1234`
    // UDP rows have no state column and are skipped by the proto check.
    // Issue #52: some Windows 11 builds (26300.x with KB5127936) report a
    // listener's state as 0, which has no name. netstat then usually drops
    // the row, but a row printed with an empty state column (4 fields) is
    // still a listener by the foreign-port-0 shape below, so keep it.
    if (parts.length < 4) continue;
    if (!/^TCP/i.test(parts[0])) continue;
    // Locale-proof LISTENING detection (issue #5): localized Windows
    // translates the state word (German "ABHÖREN"), so match the shape
    // instead — only a listening socket has a foreign endpoint of port 0
    // (`0.0.0.0:0` / `[::]:0`); every other state carries a real peer port.
    if (!/:0$/.test(parts[2])) continue;
    const m = parts[1].match(/:(\d+)$/);
    if (!m) continue;
    const port = Number(m[1]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    const pidNum = Number(parts[parts.length - 1]);
    const pid = Number.isInteger(pidNum) && pidNum > 0 ? pidNum : null;
    if (!ports.has(port) || ports.get(port) == null) ports.set(port, pid);
  }
  return [...ports.entries()].map(([port, pid]) => ({ port, command: '', pid }));
}

/**
 * Parse `tasklist /fo csv /nh` into pid → image name. Rows look like
 * `"javaw.exe","41234","Console","1","1,204,556 K"` — only the first two
 * fields matter, and the image name cannot contain a quote, so a simple
 * anchored match is enough.
 */
export function parseTasklist(out: string): Map<number, string> {
  const names = new Map<number, string>();
  for (const line of out.split('\n')) {
    const m = line.match(/^"([^"]*)","(\d+)"/);
    if (!m) continue;
    const pid = Number(m[2]);
    if (Number.isInteger(pid) && pid > 0) names.set(pid, m[1]);
  }
  return names;
}

// netstat cannot name a socket's owning process without elevation (`-b`), so
// `parseNetstat` rows carry `command: ''` — which silently disabled the
// watcher's java-first ping ordering on Windows (issue #5). Resolve names via
// `tasklist`, but NEVER once per poll: the watcher polls every 2s and the
// no-per-poll-subprocess rule (see hostClient.ts) applies. Pids are memoized
// for the app session — tasklist runs only when an unseen pid shows up (a new
// listener, e.g. the world being opened to LAN), and a broken tasklist
// disables the lookup for the session. Best effort throughout: any failure
// leaves `command: ''`, which just means unordered pings, never an error.
const winPidCommand = new Map<number, string>();
let winTasklistBroken = false;

async function winFillCommands(ports: ListeningPort[]): Promise<void> {
  const pids = ports.map((p) => p.pid).filter((pid): pid is number => pid != null);
  const unseen = pids.filter((pid) => !winPidCommand.has(pid));
  if (unseen.length && !winTasklistBroken) {
    try {
      const names = parseTasklist(await run('tasklist', ['/fo', 'csv', '/nh']));
      // Cache '' for pids tasklist didn't list so they aren't re-queried.
      for (const pid of unseen) winPidCommand.set(pid, names.get(pid) ?? '');
    } catch {
      winTasklistBroken = true;
    }
  }
  for (const p of ports) {
    if (p.pid != null) p.command = winPidCommand.get(p.pid) ?? '';
  }
}

/**
 * Returns the deduped set of listening TCP ports. Throws when the underlying OS
 * tool is missing or fails — the watcher maps that to the `unavailable` state.
 */
export async function listeningPorts(): Promise<ListeningPort[]> {
  if (process.platform === 'win32') {
    // No `-p TCP` filter (issue #5): it restricts output to the IPv4 table,
    // and a dual-stack Java listener is reported only under TCPv6.
    // parseNetstat keeps TCP rows of both families and drops UDP itself.
    const out = await run('netstat', ['-ano']);
    const ports = parseNetstat(out);
    await winFillCommands(ports);
    return ports;
  }
  // darwin + linux: -nP (no DNS/port-name resolution), TCP listeners only.
  const out = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN']);
  return parseLsof(out);
}

// ---------------------------------------------------------------------------
// Windows fallback: listeners with a broken state (issue #52)
// ---------------------------------------------------------------------------
//
// On some Windows 11 builds (26300.9818 with KB5127936; Microsoft Q&A
// "GetExtendedTcpTable returns dwState 0 for listening sockets") the TCP
// table reports a LISTEN socket with state 0. 0 is not a valid
// MIB_TCP_STATE, so netstat leaves the row out entirely and
// Get-NetTCPConnection shows it with an empty State. The port still accepts
// connections, so the world is reachable; only the listing is wrong.
// Get-NetTCPConnection still lists the row (with its owning pid), so it is
// the fallback enumerator. It runs through PowerShell, which costs ~0.5-1s of
// CPU per call, so the watcher only uses it while a Java process runs and
// netstat has found no world (winLanFallback.ts), never per 2s poll.

/** True for a process image name that is a Java runtime (java.exe, javaw.exe). */
export function isJavaCommand(command: string): boolean {
  return /java/i.test(command);
}

/**
 * Pids of running Java processes, from one `tasklist` call. Also refreshes the
 * pid -> name cache that `winFillCommands` reads, so a pid seen here never
 * costs a second tasklist. Throws when tasklist fails.
 */
export async function winJavaPids(): Promise<number[]> {
  const names = parseTasklist(await run('tasklist', ['/fo', 'csv', '/nh']));
  const pids: number[] = [];
  for (const [pid, name] of names) {
    winPidCommand.set(pid, name);
    if (isJavaCommand(name)) pids.push(pid);
  }
  return pids.sort((a, b) => a - b);
}

/** One row of our Get-NetTCPConnection listing. */
export interface TcpConnRow {
  localAddress: string;
  localPort: number;
  remoteAddress: string;
  remotePort: number | null;
  /** Raw state as printed: MIB_TCP_STATE number ('2' = Listen), a name, or '' when broken. */
  state: string;
  pid: number | null;
}

const SENTINEL = '#sei-done';

/**
 * PowerShell script that lists the TCP rows owned by `pids` as
 * `local|port|remote|rport|state|pid` lines, then a sentinel line so an empty
 * listing can be told apart from a failed run. State is read RAW from the CIM
 * property (a number, so it is also locale-proof): the formatted `.State`
 * cannot show 0, which is exactly the value this fallback exists for.
 * No double quotes in the script, so execFile's Windows quoting stays simple.
 */
export function netTcpConnectionScript(pids: readonly number[]): string {
  const list = pids.filter((p) => Number.isInteger(p) && p > 0).join(',');
  // One line (statements joined by `;`): a newline inside a CreateProcess
  // argument is not something to rely on.
  return (
    "$ErrorActionPreference='SilentlyContinue'; " +
    `Get-NetTCPConnection -OwningProcess ${list} | ForEach-Object { ` +
    // Copy $_ first: a catch block rebinds $_ to the error record.
    '$c=$_; $s=$null; ' +
    "try { $s=$c.CimInstanceProperties['State'].Value } catch {}; " +
    'if ($null -eq $s) { try { $s=[int]$c.State } catch { try { $s=[string]$c.State } catch {} } }; ' +
    "'{0}|{1}|{2}|{3}|{4}|{5}' -f $c.LocalAddress,$c.LocalPort,$c.RemoteAddress,$c.RemotePort,$s,$c.OwningProcess " +
    '}; ' +
    `'${SENTINEL}'`
  );
}

/**
 * Parse the script's output. `complete` is false when the sentinel is
 * missing (PowerShell crashed, was blocked, or timed out part way).
 */
export function parseNetTcpConnection(out: string): { rows: TcpConnRow[]; complete: boolean } {
  const rows: TcpConnRow[] = [];
  let complete = false;
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line === SENTINEL) {
      complete = true;
      continue;
    }
    const f = line.split('|');
    if (f.length !== 6) continue;
    const localPort = Number(f[1]);
    if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) continue;
    const rp = f[3].trim() === '' ? NaN : Number(f[3]);
    const pidNum = Number(f[5]);
    rows.push({
      localAddress: f[0].trim(),
      localPort,
      remoteAddress: f[2].trim(),
      remotePort: Number.isInteger(rp) ? rp : null,
      state: f[4].trim(),
      pid: Number.isInteger(pidNum) && pidNum > 0 ? pidNum : null,
    });
  }
  return { rows, complete };
}

// MIB_TCP_STATE names as Get-NetTCPConnection prints them, and their numbers.
const LISTEN_STATES = new Set(['2', 'listen']);
const KNOWN_STATES = new Set([
  '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '100',
  'closed', 'listen', 'synsent', 'synreceived', 'established', 'finwait1', 'finwait2',
  'closewait', 'closing', 'lastack', 'timewait', 'deletetcb', 'bound',
]);

/** A state the OS could not name: empty, 0, or a value outside MIB_TCP_STATE. */
export function isUnknownTcpState(state: string): boolean {
  const s = state.trim().toLowerCase();
  return s === '' || s === '0' || !KNOWN_STATES.has(s);
}

function isUnspecifiedAddress(addr: string): boolean {
  const a = addr.trim().toLowerCase();
  return a === '' || a === '0.0.0.0' || a === '::' || a === '[::]' || a === '::ffff:0.0.0.0';
}

function isLocalListenAddress(addr: string): boolean {
  const a = addr.trim().toLowerCase();
  return isUnspecifiedAddress(a) || a === '::1' || a.startsWith('127.');
}

/**
 * Pick the listener candidates out of Get-NetTCPConnection rows:
 *   - state Listen, or
 *   - an unknown state (empty / 0) on a row that looks like a listener: no
 *     remote peer, or a wildcard/loopback local address, or owned by a Java
 *     process (`javaPids`).
 * Every candidate is only a guess until the status ping answers; that ping is
 * what makes a wrong guess harmless. `brokenStateSeen` reports the issue #52
 * signature (an unknown-state row with no remote peer) for analytics.
 */
export function statelessListenerCandidates(
  rows: readonly TcpConnRow[],
  javaPids: ReadonlySet<number> = new Set(),
): { ports: ListeningPort[]; brokenStateSeen: boolean } {
  const ports = new Map<number, ListeningPort>();
  let brokenStateSeen = false;
  for (const r of rows) {
    const noPeer = r.remotePort === 0 || r.remotePort === null || isUnspecifiedAddress(r.remoteAddress);
    const listen = LISTEN_STATES.has(r.state.trim().toLowerCase());
    const unknown = isUnknownTcpState(r.state);
    if (unknown && noPeer) brokenStateSeen = true;
    const javaOwned = r.pid != null && javaPids.has(r.pid);
    const candidate = listen || (unknown && (noPeer || isLocalListenAddress(r.localAddress) || javaOwned));
    if (!candidate) continue;
    if (!ports.has(r.localPort)) {
      ports.set(r.localPort, {
        port: r.localPort,
        pid: r.pid,
        command: r.pid != null ? (winPidCommand.get(r.pid) ?? '') : '',
      });
    }
  }
  return { ports: [...ports.values()], brokenStateSeen };
}

/**
 * Get-NetTCPConnection for the given Java pids. Throws when PowerShell is
 * missing, blocked, or does not finish (no sentinel), so the caller can tell
 * "nothing listed" from "could not list".
 */
export async function winStatelessListeners(
  javaPids: readonly number[],
): Promise<{ ports: ListeningPort[]; brokenStateSeen: boolean }> {
  if (javaPids.length === 0) return { ports: [], brokenStateSeen: false };
  const out = await run(
    'powershell.exe',
    // No -ExecutionPolicy / -EncodedCommand: policy does not apply to
    // -Command, and both flags are what antivirus heuristics look for.
    ['-NoProfile', '-NonInteractive', '-Command', netTcpConnectionScript(javaPids)],
    10_000,
  );
  const { rows, complete } = parseNetTcpConnection(out);
  if (!complete) throw new Error('GET_NETTCPCONNECTION_INCOMPLETE');
  return statelessListenerCandidates(rows, new Set(javaPids));
}
