#!/usr/bin/env node
/**
 * Build the SeiLink desktop-host native addon (native/seilink) against the
 * installed Electron's headers, into resources/seilink/seilink.node.
 *
 *   node scripts/build-seilink-addon.mjs [--force] [--test]
 *
 * - macOS: arm64 + x64, merged with lipo into ONE universal .node (the mac
 *   release builds arm64 and x64 apps in one job; both ship the same file).
 * - Windows: x64 (SEILINK_ARCH overrides).
 * - Anything else: nothing to build. The feature reports "unsupported" there
 *   (src/main/seilink/host/native.ts), and the app runs without it.
 *
 * electron-builder.yml packs resources/seilink via extraResources (mac and
 * win), so it lands at <resources>/seilink/seilink.node, outside app.asar.
 * electron-osx-sign signs the Mach-O there with the app's identity.
 *
 * --test also keeps the CI-only helper addon (seilink_test.node: synthetic
 * clicks for the seilink-host-check workflow) at native/seilink/out/. It is
 * never copied into resources/ and never ships.
 *
 * A compile failure is NOT fatal (predist runs this on every release, and
 * SeiLink is still behind a dev flag): resources/seilink is removed, a loud
 * warning goes to the log and the GitHub annotations, and the release ships
 * without the addon. SEILINK_ADDON_STRICT=1 (the check workflow) makes it
 * fatal. Skips the compile when the output is newer than every source.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(ROOT, 'native', 'seilink');
const BUILD_OUT = path.join(SRC_DIR, 'out');
const RES_DIR = path.join(ROOT, 'resources', 'seilink');
const OUT = path.join(RES_DIR, 'seilink.node');
const TEST_OUT = path.join(BUILD_OUT, 'seilink_test.node');
const force = process.argv.includes('--force');
const withTest = process.argv.includes('--test') || process.env.SEILINK_TEST === '1';
const strict = process.env.SEILINK_ADDON_STRICT === '1';

const platform = process.platform;
if (platform !== 'darwin' && platform !== 'win32') {
  console.log(`seilink addon: nothing to build on ${platform} (SeiLink host is mac/win only)`);
  process.exit(0);
}

function newestSource() {
  let newest = 0;
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'build' || e.name === 'out') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else newest = Math.max(newest, statSync(p).mtimeMs);
    }
  };
  walk(SRC_DIR);
  return Math.max(newest, statSync(fileURLToPath(import.meta.url)).mtimeMs);
}

if (!force && existsSync(OUT) && statSync(OUT).mtimeMs > newestSource() && (!withTest || existsSync(TEST_OUT))) {
  console.log(`seilink addon: up to date (${path.relative(ROOT, OUT)})`);
  process.exit(0);
}

const require = createRequire(import.meta.url);
const electronVersion = require('electron/package.json').version;

function gypBuild(arch) {
  // Resolved here, inside build()'s try: a missing node-gyp is a soft failure like a failed compile.
  const gyp = require.resolve('node-gyp/bin/node-gyp.js');
  const args = [gyp, 'rebuild', `--target=${electronVersion}`, `--arch=${arch}`, '--dist-url=https://electronjs.org/headers'];
  console.log(`seilink addon: node-gyp rebuild (electron ${electronVersion}, ${arch})`);
  execFileSync(process.execPath, args, { cwd: SRC_DIR, stdio: 'inherit' });
  return path.join(SRC_DIR, 'build', 'Release');
}

function build() {
  mkdirSync(BUILD_OUT, { recursive: true });
  const hostArch = process.arch;
  if (platform === 'darwin') {
    const parts = [];
    // Native arch last, so build/Release holds the native-arch test addon afterwards.
    const arches = ['arm64', 'x64'].sort((a, b) => (a === hostArch ? 1 : 0) - (b === hostArch ? 1 : 0));
    for (const arch of arches) {
      const rel = gypBuild(arch);
      const part = path.join(BUILD_OUT, `seilink-${arch}.node`);
      copyFileSync(path.join(rel, 'seilink.node'), part);
      parts.push(part);
      if (arch === hostArch && withTest) copyFileSync(path.join(rel, 'seilink_test.node'), TEST_OUT);
    }
    const merged = path.join(BUILD_OUT, 'seilink.node');
    execFileSync('lipo', ['-create', '-output', merged, ...parts], { stdio: 'inherit' });
    console.log(`seilink addon: universal (${execFileSync('lipo', ['-archs', merged]).toString().trim()})`);
    return merged;
  }
  const arch = process.env.SEILINK_ARCH || 'x64';
  const rel = gypBuild(arch);
  if (withTest) copyFileSync(path.join(rel, 'seilink_test.node'), TEST_OUT);
  const out = path.join(BUILD_OUT, 'seilink.node');
  copyFileSync(path.join(rel, 'seilink.node'), out);
  return out;
}

try {
  const built = build();
  mkdirSync(RES_DIR, { recursive: true });
  copyFileSync(built, OUT);
  console.log(`seilink addon: built ${path.relative(ROOT, OUT)}${withTest ? ` (+ ${path.relative(ROOT, TEST_OUT)})` : ''}`);
} catch (err) {
  rmSync(RES_DIR, { recursive: true, force: true });
  if (strict) {
    console.error(`seilink addon: build FAILED: ${err?.message ?? err}`);
    process.exit(1);
  }
  console.log(
    '::warning title=SeiLink addon not built::The SeiLink desktop-host addon failed to compile. This build ships WITHOUT it and SeiLink reports unsupported. Nothing else is affected.',
  );
  console.error('==================================================================');
  console.error('seilink addon: BUILD FAILED. Continuing WITHOUT it:');
  console.error('  resources/seilink is removed, electron-builder skips it, and');
  console.error('  the SeiLink desktop host reports unsupported.');
  console.error('==================================================================');
}
