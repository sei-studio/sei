#!/usr/bin/env node
// scripts/rebuild-vision-native.mjs
//
// Phase 15 (in-game vision) — reproducible native build for the headless render path.
// Run as the LAST step of `postinstall` (after `electron-builder install-app-deps`) to
// guarantee gl + canvas are rebuilt against the installed Electron's ABI.
//
// WHY THE PATCHES (15-01 de-risk spike, 15-RESEARCH.md Pitfall 1):
//   The render path needs `gl` (headless-gl) + `canvas` (node-canvas) loadable inside the
//   Electron 42 bot utilityProcess. Two stock-build blockers:
//
//   1. `canvas@^2` (pinned by node-canvas-webgl@0.3.0) is nan-based and CANNOT build against
//      Electron 42's V8. package.json `overrides` force `canvas@^3` (N-API, ABI-stable) —
//      that builds clean, no patch.
//
//   2. `gl@8.1.6` is nan-based. Electron 42's V8 made TWO breaking changes nan (<=2.27.0) has
//      not adopted:
//        - `v8::External::New(isolate, value)` now REQUIRES a 3rd arg `ExternalPointerTypeTag`.
//        - `v8::External::Value()` now REQUIRES that same tag.
//      V8 exposes `kExternalPointerTypeTagDefault = 0` for embedders that don't type-tag; we
//      append it at every nan call site (patch-vision-native.mjs). We also bump gl's
//      binding.gyp c++17 -> c++20 (Electron 42's V8 headers use C++20 concepts).
//
// BUILD ENV (macOS clean machine): Xcode CLT + a Python with `distutils` (3.11 or earlier;
// 3.12+ removed it — pass via npm_config_python) + canvas native libs
// (`brew install pkg-config cairo pango jpeg giflib librsvg pixman`, then
// `PKG_CONFIG_PATH` must include the keg-only jpeg). See 15-01-SUMMARY.md.

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { applyAll } from './patch-vision-native.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const log = (m) => console.log(`[rebuild-vision-native] ${m}`);

// --- Build environment for the gl native compile -----------------------------------
// gl's node-gyp imports Python `distutils` (removed in 3.12+). Pick a distutils-capable
// Python; honor an explicit override first. Also surface the keg-only jpeg pkgconfig so
// canvas@3 finds libjpeg on macOS/homebrew.
function distutilsPython() {
  if (process.env.npm_config_python && existsSync(process.env.npm_config_python)) {
    return process.env.npm_config_python;
  }
  const candidates = [
    '/opt/homebrew/opt/python@3.11/bin/python3.11',
    '/opt/homebrew/opt/python@3.10/bin/python3.10',
    '/usr/bin/python3', // Apple system Python still ships distutils
    'python3',
    'python', // Windows (actions/setup-python exposes `python`, not `python3`)
  ];
  for (const p of candidates) {
    try {
      execFileSync(p, ['-c', 'import distutils'], { stdio: 'ignore' });
      return p;
    } catch { /* try next */ }
  }
  return undefined; // let node-gyp use its own default and fail loudly
}

const env = { ...process.env };
const py = distutilsPython();
if (py) { env.npm_config_python = py; log(`using Python (distutils): ${py}`); }
else log('WARNING: no distutils-capable Python found — gl build may fail on this machine');

// keg-only jpeg pkgconfig (homebrew) for canvas; harmless if the dir is absent.
const jpegPc = '/opt/homebrew/opt/jpeg/lib/pkgconfig';
const brewPc = '/opt/homebrew/lib/pkgconfig';
env.PKG_CONFIG_PATH = [jpegPc, brewPc, env.PKG_CONFIG_PATH].filter(Boolean).join(':');

// Re-apply patches defensively (install-app-deps may have restored pristine sources).
applyAll();

const electronVersion = JSON.parse(
  readFileSync(join(root, 'node_modules/electron/package.json'), 'utf8'),
).version;

log(`rebuilding gl + canvas against Electron ${electronVersion} ABI...`);
execFileSync(
  'npx',
  ['electron-rebuild', '-f', '-w', 'gl,canvas', '-v', electronVersion],
  // shell on Windows: electron-rebuild resolves to a .cmd shim CreateProcess can't exec directly.
  { cwd: root, stdio: 'inherit', env, shell: process.platform === 'win32' },
);
log('rebuild complete');
