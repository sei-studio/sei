/**
 * Small helpers for running Windows PowerShell and child processes from main
 * (shared by the Velopack migration and the Velopack updater). Windows only in
 * practice: powerShellExe() is null anywhere else.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export function powerShellExe(): string | null {
  const root = process.env.SystemRoot ?? 'C:\\Windows';
  const exe = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return existsSync(exe) ? exe : null;
}

export interface ExitResult {
  code: number | null;
  timedOut: boolean;
  error?: string;
}

export function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<ExitResult> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: ExitResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* gone */
      }
      finish({ code: null, timedOut: true });
    }, timeoutMs);
    child.once('error', (err) => finish({ code: null, timedOut: false, error: err.message }));
    child.once('exit', (code) => finish({ code, timedOut: false }));
  });
}

/**
 * The environment Windows PowerShell 5.1 runs in: this process's, plus
 * `extra`, minus PSModulePath. A Sei started from PowerShell 7 (a terminal,
 * a script, the CI harness) inherits a PSModulePath that lists PowerShell 7's
 * own module folders first, and 5.1 then fails to load even its built-in
 * Microsoft.PowerShell.Security ("the module could not be loaded"), so
 * Get-AuthenticodeSignature never runs and every signed update is rejected
 * (261031 CI, sig-accept). Without the variable 5.1 builds its default path.
 */
export function powerShellEnv(
  base: NodeJS.ProcessEnv,
  extra?: Record<string, string>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ...(extra ?? {}) };
  for (const k of Object.keys(env)) if (k.toLowerCase() === 'psmodulepath') delete env[k];
  return env;
}

/**
 * Runs a script with -EncodedCommand (so nothing in it needs quoting) and
 * returns its stdout, or null when PowerShell is missing, failed to start,
 * timed out or exited non-zero. `env` is added to this process's environment
 * (powerShellEnv): pass paths through it rather than pasting them into the
 * script.
 */
export async function runPowerShell(
  script: string,
  timeoutMs: number,
  env?: Record<string, string>,
): Promise<string | null> {
  const exe = powerShellExe();
  if (!exe) return null;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: powerShellEnv(process.env, env),
    });
  } catch {
    return null;
  }
  let out = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (d: string) => (out += d));
  const r = await waitForExit(child, timeoutMs);
  return r.code === 0 ? out.trim() : null;
}
