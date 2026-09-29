#!/usr/bin/env node
// scripts/build-linux-experimental.mjs
//
// Builds the EXPERIMENTAL Linux x64 AppImage (260930). Not wired into
// release.yml: CI builds mac + win only, and this is a hand-run build for a
// small number of Linux testers. Run it on a Linux x64 host after `npm ci`:
//
//   npm run dist:linux:experimental
//
// Steps:
//   1. Refuse when a .env file is present. electron-vite bakes a few .env keys
//      into dist/main at build time (electron.vite.config.ts `define`), and a
//      developer .env can hold dev-only keys (SEI_GATE_DEV_KEY). A build with
//      no .env is fully functional (Supabase routes through the proxy), which
//      is exactly what CI ships minus the public Supabase override.
//   2. Build the Minecraft game pack for linux-x64 with the normal pack builder
//      (natives rebuilt for Electron's ABI, prunes applied, zip verified) and
//      KEEP its staged tree at release/linux-bundled-packs/minecraft. The
//      `linux:` block of electron-builder.yml copies that tree into the
//      AppImage as resources/game-packs/minecraft (no published manifest has a
//      linux Minecraft pack, so the AppImage carries its own; see packs.ts
//      bundledRoot). The zip lands in release/packs/ as a by-product.
//   3. `npm run dist:linux -- --publish never`: never publish from here.
//
// Flags: --skip-pack reuses an already staged pack (step 2 skipped).

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGED = path.join(ROOT, 'release', 'linux-bundled-packs', 'minecraft');
const log = (m) => console.log(`[build-linux-experimental] ${m}`);
const fail = (m) => {
  console.error(`[build-linux-experimental] ${m}`);
  process.exit(1);
};

if (process.platform !== 'linux' || process.arch !== 'x64') {
  fail(`this builds the linux-x64 AppImage and must run on linux-x64 (here: ${process.platform}-${process.arch})`);
}

const envFiles = readdirSync(ROOT).filter((f) => f.startsWith('.env') && f !== '.env.example');
if (envFiles.length) {
  fail(`refusing to build with ${envFiles.join(', ')} present: its keys would be baked into dist/main. Move it aside and re-run.`);
}

const skipPack = process.argv.includes('--skip-pack');
const run = (cmd, args) => execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });

if (!skipPack) {
  log('building the Minecraft game pack for linux-x64 (staged tree kept for the AppImage)');
  run(process.execPath, [
    'scripts/build-game-pack.mjs',
    'minecraft',
    '--platform', 'linux',
    '--arch', 'x64',
    '--out', path.join('release', 'packs'),
    '--staging', STAGED,
    '--keep-staging',
  ]);
}

const packJsonPath = path.join(STAGED, 'pack.json');
if (!existsSync(packJsonPath)) fail(`no staged pack at ${STAGED} (run without --skip-pack)`);
const pack = JSON.parse(readFileSync(packJsonPath, 'utf8'));
const appVersion = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
if (pack.game !== 'minecraft' || pack.platform !== 'linux' || pack.arch !== 'x64' || pack.version !== appVersion) {
  fail(`staged pack is ${pack.game} ${pack.version} ${pack.platform}-${pack.arch}, want minecraft ${appVersion} linux-x64`);
}
log(`bundling staged pack: ${pack.files} files, treeHash ${String(pack.treeHash).slice(0, 16)}...`);

run('npm', ['run', 'dist:linux', '--', '--publish', 'never']);
log('done: see release/ for the AppImage');
