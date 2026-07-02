#!/usr/bin/env node
// scripts/postinstall.mjs
//
// Unified postinstall for Sei. Order matters for the Phase 15 vision render path:
//   1. Apply gl/nan source patches (must precede any gl compile — see patch-vision-native.mjs).
//   2. `electron-builder install-app-deps` — rebuilds ALL native deps against Electron's ABI.
//   3. rebuild-vision-native.mjs — authoritative gl + canvas rebuild with the correct build
//      environment (distutils-Python + keg-only jpeg pkgconfig), re-applying patches defensively.
//
// A single entrypoint lets us export the build environment ONCE so install-app-deps (step 2)
// and electron-rebuild (step 3) both see a distutils-capable Python. See 15-01-SUMMARY.md.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { applyAll, patchV8MsvcBuiltins } from './patch-vision-native.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const log = (m) => console.log(`[postinstall] ${m}`);

// --- Resolve a distutils-capable Python (gl's old node-gyp needs distutils, gone in 3.12+) ---
function distutilsPython() {
  if (process.env.npm_config_python && existsSync(process.env.npm_config_python)) {
    return process.env.npm_config_python;
  }
  for (const p of [
    '/opt/homebrew/opt/python@3.11/bin/python3.11',
    '/opt/homebrew/opt/python@3.10/bin/python3.10',
    '/usr/bin/python3',
    'python3',
    'python', // Windows (actions/setup-python exposes `python`, not `python3`)
  ]) {
    try { execFileSync(p, ['-c', 'import distutils'], { stdio: 'ignore' }); return p; }
    catch { /* next */ }
  }
  return undefined;
}

const env = { ...process.env };
const py = distutilsPython();
if (py) { env.npm_config_python = py; log(`build Python (distutils): ${py}`); }
else log('WARNING: no distutils-capable Python found — gl build may fail');
env.PKG_CONFIG_PATH = [
  '/opt/homebrew/opt/jpeg/lib/pkgconfig',
  '/opt/homebrew/lib/pkgconfig',
  env.PKG_CONFIG_PATH,
].filter(Boolean).join(':');

// On Windows, `npx`/`electron-builder` resolve to `.cmd` shims that CreateProcess
// cannot exec directly (spawnSync ENOENT) — they must go through the shell. mac/linux
// keep the direct exec (no shell) so the working build path is unchanged.
const isWin = process.platform === 'win32';
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit', env, shell: isWin });

// 1. Patch gl/nan sources before any compile.
log('applying vision native source patches...');
applyAll();

// 1b. Windows only: gl compiles against Electron's V8 headers, which use the
// GCC/Clang builtin __builtin_frame_address (MSVC C3861). Pre-fetch the Electron
// headers into the same devdir @electron/rebuild uses (~/.electron-gyp), then
// inject the MSVC shim so the gl compile in step 2 finds patched headers.
if (isWin) {
  try {
    const electronVersion = JSON.parse(
      readFileSync(join(root, 'node_modules/electron/package.json'), 'utf8'),
    ).version;
    const devdir = join(homedir(), '.electron-gyp');
    log(`Windows: pre-fetching Electron ${electronVersion} headers into ${devdir}...`);
    run('npx', ['node-gyp', 'install', `--devdir=${devdir}`, `--target=${electronVersion}`,
      '--dist-url=https://electronjs.org/headers', '--arch=x64']);
    patchV8MsvcBuiltins(join(devdir, electronVersion, 'include', 'node'));
  } catch (e) {
    log(`WARNING: Windows header pre-patch failed (${e.message}) — gl may fail to compile`);
  }
}

// 2. electron-builder install-app-deps (rebuilds all native deps incl. gl/canvas).
log('electron-builder install-app-deps...');
run('npx', ['electron-builder', 'install-app-deps']);

// 3. Authoritative gl + canvas rebuild against Electron's ABI.
log('rebuild-vision-native...');
run('node', [join(root, 'scripts/rebuild-vision-native.mjs')]);

log('postinstall complete');
