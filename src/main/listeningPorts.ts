/**
 * Enumerate the local machine's listening TCP ports — the loopback replacement
 * for Minecraft's multicast LAN beacon (see src/main/mcPing.ts header for why
 * multicast was dropped). Minecraft's "open to LAN" server binds a *random*
 * free port each session and advertises it only via the beacon; reading the
 * live socket table here recovers that port directly, so a port that changes
 * every time is a non-issue — we never cache or guess it.
 *
 * macOS / Linux use `lsof`; Windows uses `netstat`. Both ship with the OS and
 * neither needs elevated privileges or any networking entitlement. Each entry
 * carries the owning process command when available so the watcher can ping
 * likely Minecraft (java) ports first.
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
    if (!/LISTENING/i.test(line)) continue;
    const parts = line.trim().split(/\s+/);
    // `TCP  0.0.0.0:61871  0.0.0.0:0  LISTENING  1234`
    const local = parts[1];
    if (!local) continue;
    const m = local.match(/:(\d+)$/);
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
 * Returns the deduped set of listening TCP ports. Throws when the underlying OS
 * tool is missing or fails — the watcher maps that to the `unavailable` state.
 */
export async function listeningPorts(): Promise<ListeningPort[]> {
  if (process.platform === 'win32') {
    const out = await run('netstat', ['-ano', '-p', 'TCP']);
    return parseNetstat(out);
  }
  // darwin + linux: -nP (no DNS/port-name resolution), TCP listeners only.
  const out = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN']);
  return parseLsof(out);
}
