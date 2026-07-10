/**
 * Host Minecraft client classifier (260709).
 *
 * Sei only speaks the vanilla protocol, so before summoning into a LAN world
 * we want to know what CLIENT is hosting it: a Forge/NeoForge/Fabric install
 * (client-side mods are fine, content mods refuse vanilla joiners) or Lunar
 * Client (joins fine, but loads no mods, so CustomSkinLoader can't show the
 * companion's skin there). The renderer uses this to show a one-time
 * pre-summon disclaimer; nothing here ever blocks a summon.
 *
 * Detection is deliberately lightweight and local:
 *   - Sei is same-machine only, so the integrated server always runs inside a
 *     java process on THIS machine. `listeningPorts()` already yields that
 *     process's pid; one `ps` (darwin/linux) or PowerShell CIM query (win32)
 *     reads its full command line.
 *   - The command line carries unambiguous loader markers: Fabric's
 *     `net.fabricmc.loader` main class, Forge's `cpw.mods.bootstraplauncher`,
 *     NeoForge's `neoforge` artifacts, Lunar's `.lunarclient` install paths.
 *   - Deliberately NO bare 'forge' marker: CurseForge instance paths contain
 *     "curseforge" even when the instance itself is vanilla.
 *
 * The lookup runs at most once per (pid, port) pair — lanWatcher caches the
 * result — so the 2s poll loop never spawns per-poll subprocesses.
 *
 * Failure mode is always 'unknown' (no disclaimer), never a thrown error: a
 * missing `ps`, a dead pid, or a truncated command line must not break LAN
 * detection.
 */
import { execFile } from 'node:child_process';
import type { LanHostClient } from '../shared/ipc';

/** Wall clock for the one-shot cmdline read (CLAUDE.md: every external call
 *  has a timeout). `ps` answers in ms; PowerShell cold-start needs a margin. */
const CMDLINE_TIMEOUT_MS = 4000;

/**
 * Classify a java process command line. Pure — exported for tests.
 * '' / whitespace → 'unknown' (we learned nothing, so no disclaimer).
 */
export function classifyCmdline(cmdline: string): LanHostClient {
  const c = cmdline.toLowerCase();
  if (!c.trim()) return 'unknown';
  // Lunar first: its runtime bundles Fabric internals, so the fabric marker
  // would otherwise win on a Lunar process.
  if (c.includes('.lunarclient') || c.includes('moonsworth') || c.includes('lunarclient')) {
    return 'lunar';
  }
  if (c.includes('neoforge')) return 'neoforge';
  if (c.includes('net.fabricmc') || c.includes('fabric-loader')) return 'fabric';
  if (
    c.includes('cpw.mods.bootstraplauncher') ||
    c.includes('cpw.mods.modlauncher') ||
    c.includes('minecraftforge') ||
    c.includes('fml.loading') ||
    c.includes('fmlclient')
  ) {
    return 'forge';
  }
  // Vanilla main class, and no loader marker matched above.
  if (c.includes('net.minecraft.client.main.main')) return 'vanilla';
  return 'unknown';
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: CMDLINE_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err && !stdout) reject(err);
        else resolve(stdout ?? '');
      },
    );
  });
}

/** Read a process's full command line, or '' when unavailable. */
async function cmdlineForPid(pid: number): Promise<string> {
  // Defense in depth: pid is parsed from lsof/netstat as a positive integer,
  // but it lands in a subprocess argument, so re-validate here.
  if (!Number.isInteger(pid) || pid <= 0) return '';
  try {
    if (process.platform === 'win32') {
      return await run('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`,
      ]);
    }
    return await run('ps', ['-o', 'command=', '-p', String(pid)]);
  } catch {
    return '';
  }
}

/**
 * Classify the client hosting the LAN world by its owning process id.
 * Never throws; null/unreadable pid → 'unknown'.
 */
export async function classifyHostClient(pid: number | null): Promise<LanHostClient> {
  if (pid == null) return 'unknown';
  return classifyCmdline(await cmdlineForPid(pid));
}
