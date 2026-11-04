/**
 * SeiLink room host launch arguments (261104). No imports on purpose: boot.ts,
 * velopackBoot.ts and velopackMigration.ts read this before anything else, to
 * keep a host launch out of the single-instance lock, the boot guard and the
 * Velopack hooks.
 *
 * Main spawns the same Sei binary as `<exe> [appPath] --seilink-host
 * --seilink-ipc=<pipe> --seilink-userdata=<dir> [--seilink-test]`; the pipe
 * token travels in the SEI_SEILINK_TOKEN environment variable, not argv.
 */
export const SEILINK_HOST_FLAG = '--seilink-host';

export function isSeilinkHostLaunch(argv: readonly string[]): boolean {
  return argv.includes(SEILINK_HOST_FLAG);
}

export interface SeilinkHostArgs {
  ipc: string;
  userData: string;
  /** CI self-test host: honours test-only commands (test-hang). */
  test: boolean;
}

function value(argv: readonly string[], name: string): string | null {
  const prefix = `--${name}=`;
  const hit = argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

/** null when the launch is not a usable host launch. */
export function parseSeilinkHostArgs(argv: readonly string[]): SeilinkHostArgs | null {
  if (!isSeilinkHostLaunch(argv)) return null;
  const ipc = value(argv, 'seilink-ipc');
  const userData = value(argv, 'seilink-userdata');
  if (!ipc || !userData) return null;
  return { ipc, userData, test: argv.includes('--seilink-test') };
}

export function seilinkHostArgv(opts: { ipc: string; userData: string; test: boolean }): string[] {
  return [SEILINK_HOST_FLAG, `--seilink-ipc=${opts.ipc}`, `--seilink-userdata=${opts.userData}`, ...(opts.test ? ['--seilink-test'] : [])];
}
