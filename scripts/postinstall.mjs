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
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { applyAll } from './patch-vision-native.mjs';

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

const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit', env });

// 1. Patch gl/nan sources before any compile.
log('applying vision native source patches...');
applyAll();

// 2. electron-builder install-app-deps (rebuilds all native deps incl. gl/canvas).
log('electron-builder install-app-deps...');
run('npx', ['electron-builder', 'install-app-deps']);

// 3. Authoritative gl + canvas rebuild against Electron's ABI.
log('rebuild-vision-native...');
run('node', [join(root, 'scripts/rebuild-vision-native.mjs')]);

log('postinstall complete');
