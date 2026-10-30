/**
 * Runs the Authenticode check (velopackSignature.ts) before Sei runs a
 * downloaded Setup or applies a downloaded Velopack package (261031).
 *
 * The publisher is the WIN_PUBLISHER_NAME this build was signed as, baked in
 * at build time (`import.meta.env.SEI_WIN_PUBLISHER`, electron.vite.config.ts;
 * release.yml sets it only when Azure signing is fully configured). A build
 * without one is unsigned (a dry run, CI, a from-source build): it cannot
 * expect signed updates, so the check is off there and says so in the log.
 * CI's signature scenarios turn it on with SEI_VELOPACK_CI_PUBLISHER.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  AUTHENTICODE_SCRIPT,
  authenticodeEnv,
  parseSignatureRows,
  signatureVerdict,
  type SignatureVerdict,
} from './velopackSignature';
import { runPowerShell } from './winPowerShell';

/** Get-AuthenticodeSignature hashes the whole file (Sei.exe is ~200 MB, twice). */
const CHECK_TIMEOUT_MS = 3 * 60 * 1000;

export type CheckResult = SignatureVerdict | { ok: true; skipped: true };

/** The publisher updates must be signed by, or '' when this build is unsigned. */
export function expectedPublisher(): string {
  if (process.env.SEI_VELOPACK_CI === '1' && process.env.SEI_VELOPACK_CI_PUBLISHER) {
    return process.env.SEI_VELOPACK_CI_PUBLISHER;
  }
  return (import.meta.env.SEI_WIN_PUBLISHER ?? '').trim();
}

/**
 * Checks plain files (a Setup, a staged Sei.exe) and optionally a .nupkg's
 * Sei.exe and Squirrel.exe. Fails closed: a check that cannot run is a
 * rejection, never a pass.
 */
export async function checkSigned(files: string[], packagePath?: string): Promise<CheckResult> {
  const publisher = expectedPublisher();
  if (!publisher) return { ok: true, skipped: true };
  if (process.platform !== 'win32') return { ok: false, reason: 'not on Windows' };
  for (const f of [...files, ...(packagePath ? [packagePath] : [])]) {
    if (!existsSync(f)) return { ok: false, reason: `${path.basename(f)} is missing` };
  }
  try {
    const out = await runPowerShell(AUTHENTICODE_SCRIPT, CHECK_TIMEOUT_MS, authenticodeEnv(files, packagePath));
    return signatureVerdict(parseSignatureRows(out), publisher, { files: files.length, package: !!packagePath });
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

/* -------------------------------------------------------------------------- */
/*  Verdict for a downloaded package, kept beside the staged copy             */
/* -------------------------------------------------------------------------- */

interface Verdict {
  version: string;
  file: string;
  size: number;
  mtimeMs: number;
  staged: boolean;
}

function verdictFile(stageDir: string, version: string): string {
  return path.join(stageDir, `v${version}.sig`);
}

function packageStamp(packagePath: string): { size: number; mtimeMs: number } | null {
  try {
    const s = statSync(packagePath);
    return { size: s.size, mtimeMs: Math.floor(s.mtimeMs) };
  } catch {
    return null;
  }
}

function stagedExe(stageDir: string, version: string): string | null {
  const ok = path.join(stageDir, `v${version}.ok`);
  const exe = path.join(stageDir, `v${version}`, 'Sei.exe');
  return existsSync(ok) && existsSync(exe) ? exe : null;
}

/**
 * True when an earlier check passed for this exact package file (same size
 * and mtime). The staged copy is extracted from that file on this machine, so
 * a pass recorded before the stage finished still covers it.
 */
export function hasPassingVerdict(stageDir: string, version: string, packagePath: string): boolean {
  if (!expectedPublisher()) return true;
  const stamp = packageStamp(packagePath);
  if (!stamp) return false;
  try {
    const v = JSON.parse(readFileSync(verdictFile(stageDir, version), 'utf8')) as Verdict;
    return (
      v.version === version &&
      v.file === path.basename(packagePath) &&
      v.size === stamp.size &&
      v.mtimeMs === stamp.mtimeMs
    );
  } catch {
    return false;
  }
}

/**
 * Checks a downloaded package (and its staged copy when there is one) and
 * records a pass beside the staged copy, so the restart and a later launch
 * apply do not pay for it again.
 */
export async function verifyPackage(stageDir: string, version: string, packagePath: string): Promise<CheckResult> {
  if (hasPassingVerdict(stageDir, version, packagePath)) return { ok: true };
  const staged = stagedExe(stageDir, version);
  const result = await checkSigned(staged ? [staged] : [], packagePath);
  const stamp = packageStamp(packagePath);
  if (result.ok && !('skipped' in result) && stamp) {
    try {
      mkdirSync(stageDir, { recursive: true });
      const v: Verdict = { version, file: path.basename(packagePath), ...stamp, staged: !!staged };
      writeFileSync(verdictFile(stageDir, version), JSON.stringify(v));
    } catch {
      /* checked again at apply */
    }
  }
  return result;
}
