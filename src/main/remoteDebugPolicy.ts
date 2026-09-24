/**
 * Remote-debugging policy for packaged builds (pure, no Electron import).
 *
 * The Electron fuses (electron-builder.yml `electronFuses`) turn off RunAsNode,
 * NODE_OPTIONS and the Node `--inspect` family, but Chromium's
 * `--remote-debugging-port` / `--remote-debugging-pipe` are not covered by any
 * fuse. Without this check any local process could relaunch the signed app
 * with CDP enabled and drive the renderer, which has the preload bridge to
 * privileged IPC and inherits the app's TCC grants.
 *
 * Policy: a packaged STABLE build (no prerelease tag in its version) refuses to
 * start when it sees any of these switches. Packaged BETAS keep allowing them,
 * because installed-app verification on Shawn's Mac relaunches the app with
 * `--remote-debugging-port`. Dev (`!app.isPackaged`) is never affected.
 *
 * The enforcement side lives in `remoteDebugGuard.ts`, imported first by
 * `src/main/index.ts`.
 */

export interface RemoteDebuggingInput {
  /** process.argv (index 0 is the executable and is skipped). */
  argv: readonly string[];
  /** app.isPackaged */
  isPackaged: boolean;
  /** app.getVersion() */
  version: string;
  /** process.platform; Windows also accepts `/switch` prefixes. */
  platform: NodeJS.Platform;
  /**
   * Optional authoritative check against Chromium's parsed command line
   * (app.commandLine.hasSwitch). Catches spellings argv scanning might miss.
   */
  hasSwitch?: (name: string) => boolean;
}

export interface RemoteDebuggingVerdict {
  block: boolean;
  /** Offending switch names found (normalized, without prefix or value). */
  found: string[];
}

/** Exact switch names probed through app.commandLine.hasSwitch. */
export const PROBED_SWITCHES = [
  'remote-debugging-port',
  'remote-debugging-pipe',
  'remote-debugging-address',
  'remote-debugging-io-pipes',
  'js-flags',
  'inspect',
  'inspect-brk',
  'inspect-port',
  'inspect-brk-node',
  'inspect-publish-uid',
] as const;

/** A switch name (lowercased, no prefix, no value) that enables debugging. */
export function isRemoteDebuggingSwitch(name: string): boolean {
  return (
    name.startsWith('remote-debugging-') ||
    name === 'js-flags' ||
    name === 'inspect' ||
    name.startsWith('inspect-') ||
    name === 'debug-port'
  );
}

/**
 * Normalize one argv entry to a switch name, or null when it is not a switch.
 * Mirrors Chromium's CommandLine parsing: `--` and `-` prefixes everywhere,
 * `/` additionally on Windows, names are case-insensitive on Windows. We
 * lowercase on every platform to stay conservative.
 */
export function switchName(arg: string, platform: NodeJS.Platform): string | null {
  let rest: string;
  if (arg.startsWith('--')) rest = arg.slice(2);
  else if (arg.startsWith('-')) rest = arg.slice(1);
  else if (platform === 'win32' && arg.startsWith('/')) rest = arg.slice(1);
  else return null;
  const eq = rest.indexOf('=');
  const name = (eq === -1 ? rest : rest.slice(0, eq)).trim().toLowerCase();
  return name.length > 0 ? name : null;
}

/** Every remote-debugging switch present in argv or Chromium's command line. */
export function findRemoteDebuggingSwitches(
  argv: readonly string[],
  platform: NodeJS.Platform,
  hasSwitch?: (name: string) => boolean,
): string[] {
  const found = new Set<string>();
  // Deliberately keeps scanning past a bare `--` (Chromium stops parsing
  // switches there): a false positive only means a stable build refuses a
  // launch nobody legitimately makes.
  for (const arg of argv.slice(1)) {
    const name = switchName(arg, platform);
    if (name && isRemoteDebuggingSwitch(name)) found.add(name);
  }
  if (hasSwitch) {
    for (const name of PROBED_SWITCHES) {
      try {
        if (hasSwitch(name)) found.add(name);
      } catch {
        // A throwing probe must not turn into "allowed"; argv scan still ran.
      }
    }
  }
  return [...found];
}

/** Stable = no prerelease tag (semver `-`). `0.6.5` stable, `0.6.5-beta.3` not. */
export function isStableVersion(version: string): boolean {
  return !version.includes('-');
}

export function remoteDebuggingVerdict(input: RemoteDebuggingInput): RemoteDebuggingVerdict {
  const found = findRemoteDebuggingSwitches(input.argv, input.platform, input.hasSwitch);
  const block = found.length > 0 && input.isPackaged && isStableVersion(input.version);
  return { block, found };
}
