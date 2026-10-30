/**
 * CI driver for the Windows update progress window (261030).
 *
 * Runs the REAL launcher (src/main/updateProgressHelper.ts) the way
 * src/main/windowsUpdateInstall.ts does, without Electron, so
 * .github/workflows/nsis-upgrade-check.yml can put the window up on a real
 * Windows runner before it starts an installer under it. Bundled for the
 * runner with:
 *
 *   npx esbuild scripts/ci/update-progress-launch.ts --bundle --platform=node --outfile=upl.cjs
 *
 * Usage (all optional except --installer and --app):
 *   node upl.cjs --installer C:\path\Sei-win-x64.exe --app C:\path\Sei.exe
 *     [--resources resources\update-progress] [--theme system|midnight|ice|acorn|mint]
 *     [--dark] [--lang en|zh] [--version 0.7.0] [--history 90,104] [--out result.json]
 *
 * Prints one JSON line {ready, reason, dir, ms, estimateSec} (also written to
 * --out) and exits 0 when ready, 1 when not. The window keeps running after
 * this process exits (the script hands over to a grandchild), exactly as it
 * outlives Sei.
 */
import { existsSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildHelperConfig, launchUpdateProgressHelper } from '../../src/main/updateProgressHelper';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const installer = arg('installer');
  const app = arg('app');
  if (!installer || !app) {
    console.error('need --installer and --app');
    process.exit(2);
  }
  const history = (arg('history') ?? '')
    .split(',')
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n) && n > 0);
  const config = buildHelperConfig({
    themeMode: arg('theme') ?? 'system',
    osDark: process.argv.includes('--dark'),
    uiLanguage: arg('lang') ?? 'en',
    history,
    version: arg('version') ?? '0.7.0',
    installerPath: installer,
    appExe: app,
    // As in the app (windowsUpdateInstall.ts): the installer file is there.
    downloaded: existsSync(installer),
  });
  const t0 = Date.now();
  const h = await launchUpdateProgressHelper({
    resourcesDir: path.resolve(arg('resources') ?? 'resources/update-progress'),
    tmpRoot: os.tmpdir(),
    config,
  });
  const out = {
    ready: h.ready,
    reason: h.reason,
    dir: h.dir,
    ms: Date.now() - t0,
    estimateSec: config.plan.estimateSec,
    theme: config.theme,
    lang: config.lang,
  };
  const line = JSON.stringify(out);
  console.log(line);
  const outFile = arg('out');
  if (outFile) writeFileSync(outFile, line);
  process.exit(h.ready ? 0 : 1);
}

void main();
