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
    if (parts.length < 5) continue;
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
