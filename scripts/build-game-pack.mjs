#!/usr/bin/env node
// scripts/build-game-pack.mjs <game> [--platform darwin|win32] [--arch arm64|x64]
//                                    [--out dir] [--dry-run] [--skip-rebuild] [--keep-staging]
//
// Builds one GAME PACK (260908, game-adapters M0b): the zip a packaged app
// downloads on first use so a game adapter's heavy runtime never ships in the
// installer. Contract + naming: src/shared/gamePacks.ts. Client:
// src/main/games/packs.ts. Design: .planning/game-adapters-260908.md 2.5.
//
// What it does, in order:
//   1. Resolves the PRODUCTION dependency closure of the `packs/<game>` npm
//      workspace with `npm list -w packs/<game> --omit dev --json --long`, the
//      same query electron-builder's collector runs for the app. Every node's
//      `path` is where npm placed it in the HOISTED tree (root node_modules,
//      or nested when versions conflicted), so copying each node to the same
//      relative location under the staging dir preserves Node's resolution
//      exactly. This is "copy from the hoisted tree" rather than a second
//      `npm ci` in a temp dir: the hoisted tree is the one the lockfile pins,
//      the one postinstall already patched + rebuilt, and the one `npm run
//      dev` and the tests exercised.
//   2. Rebuilds native modules against Electron's ABI for the target arch with
//      @electron/rebuild (the nan source patches from patch-vision-native.mjs
//      are applied to the STAGED tree first, same as postinstall does for the
//      repo tree). Modules already built for that arch+ABI (postinstall's
//      output, carried over by the copy) are skipped via their .forge-meta;
//      a cross-arch build (x64 on an arm64 mac) recompiles gl and fetches
//      canvas's x64 N-API prebuild.
//   3. Applies packs/<game>/prune.mjs (the texture / gl-residue / bedrock
//      prunes that used to live in electron-builder.yml) and refuses to
//      continue if any MUST_KEEP path went missing.
//   4. Computes treeHash = sha256 over sorted relative paths + per-file sha256
//      (so two builds of one lockfile compare equal even though the zips do
//      not), writes pack.json, zips with bsdtar (`tar --format zip`, present
//      on macOS and Windows 10+; it records unix modes so .node files come
//      back executable), and writes <zip>.meta.json beside it: the manifest
//      entry CI merges with build-game-pack-manifest.mjs.
//
// --dry-run resolves the closure, validates the prune globs against the
// hoisted tree and checks MUST_KEEP, without copying, rebuilding or zipping.
// It is what ci.yml runs on every push.
//
// Never run from inside Electron; this is a plain node script.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { minimatch } from 'minimatch';
import { applyAll, patchV8MsvcBuiltins } from './patch-vision-native.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const log = (m) => console.log(`[build-game-pack] ${m}`);

// ── Args ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { platform: process.platform, arch: process.arch, out: path.join(ROOT, 'release', 'packs') };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const take = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--platform') out.platform = take();
    else if (a === '--arch') out.arch = take();
    else if (a === '--out') out.out = path.resolve(take());
    else if (a === '--staging') out.staging = path.resolve(take());
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--skip-rebuild') out.skipRebuild = true;
    else if (a === '--keep-staging') out.keepStaging = true;
    else if (a.startsWith('--')) throw new Error(`unknown flag ${a}`);
    else rest.push(a);
  }
  if (rest.length !== 1) throw new Error('usage: build-game-pack.mjs <game> [--platform p] [--arch a] [--out dir] [--dry-run]');
  out.game = rest[0];
  if (!/^[a-z0-9]+$/.test(out.game)) throw new Error(`bad game id ${out.game}`);
  // `--platform any --arch any` names a pack with NO native code (the DST
  // Lua mod pack), served to every platform (gamePacks.ts pickPackEntry).
  // The build refuses it when the closure turns out to carry natives.
  if (!['darwin', 'win32', 'linux', 'any'].includes(out.platform)) throw new Error(`bad --platform ${out.platform}`);
  if (!['arm64', 'x64', 'any'].includes(out.arch)) throw new Error(`bad --arch ${out.arch}`);
  if ((out.platform === 'any') !== (out.arch === 'any')) throw new Error('--platform any requires --arch any (and vice versa)');
  return out;
}

// ── Workspace + versions ────────────────────────────────────────────────────

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

function loadWorkspace(game) {
  const dir = path.join(ROOT, 'packs', game);
  const pkgPath = path.join(dir, 'package.json');
  if (!existsSync(pkgPath)) throw new Error(`no workspace at packs/${game}/package.json`);
  const rootPkg = readJson(path.join(ROOT, 'package.json'));
  const ws = Array.isArray(rootPkg.workspaces) ? rootPkg.workspaces : [];
  if (!ws.some((g) => minimatch(`packs/${game}`, g))) {
    throw new Error(`packs/${game} is not covered by root package.json "workspaces" (${JSON.stringify(ws)})`);
  }
  const pkg = readJson(pkgPath);
  if (rootPkg.dependencies?.[pkg.name] || rootPkg.devDependencies?.[pkg.name]) {
    throw new Error(`root package.json must NOT depend on ${pkg.name}; electron-builder would pack it`);
  }
  const electronRange = rootPkg.devDependencies?.electron;
  if (!electronRange) throw new Error('root devDependencies.electron missing');
  const electronVersion = readJson(path.join(ROOT, 'node_modules/electron/package.json')).version;
  const { getAbi } = require('node-abi');
  return {
    dir,
    pkg,
    version: rootPkg.version,
    electronVersion,
    electronRange,
    abi: String(getAbi(electronVersion, 'electron')),
  };
}

async function loadPrune(game, platform) {
  const p = path.join(ROOT, 'packs', game, 'prune.mjs');
  if (!existsSync(p)) return { globs: [], mustKeep: [] };
  const mod = await import(pathToFileURL(p).href);
  const globs = typeof mod.pruneGlobsFor === 'function' ? mod.pruneGlobsFor(platform) : [];
  for (const g of globs) {
    if (typeof g !== 'string' || !g) throw new Error(`prune.mjs: bad glob ${JSON.stringify(g)}`);
    minimatch.makeRe(g, { dot: true }); // throws on a malformed pattern
  }
  return { globs, mustKeep: Array.isArray(mod.MUST_KEEP) ? mod.MUST_KEEP : [] };
}

/**
 * Game-side ASSETS a pack carries beside node_modules (game-adapters M2,
 * 260908): `packs/<game>/assets.mjs` exports ASSET_DIRS = [{from, to}], both
 * repo-relative posix paths. The DST pack ships the Lua mod this way
 * (native/dst-mod/sei -> assets/dst-mod/sei); in dev the pack root IS the
 * repo root and the installer falls back to the `from` path, so the two must
 * agree (src/main/games/dontstarve/install.ts MOD_SOURCE_RELATIVE).
 */
async function loadAssets(game) {
  const p = path.join(ROOT, 'packs', game, 'assets.mjs');
  if (!existsSync(p)) return [];
  const mod = await import(pathToFileURL(p).href);
  const dirs = Array.isArray(mod.ASSET_DIRS) ? mod.ASSET_DIRS : [];
  for (const d of dirs) {
    if (!d || typeof d.from !== 'string' || typeof d.to !== 'string' || !d.to.startsWith('assets/')) {
      throw new Error(`assets.mjs: bad entry ${JSON.stringify(d)} (to must start with assets/)`);
    }
    if (!existsSync(path.join(ROOT, ...d.from.split('/')))) throw new Error(`assets.mjs: ${d.from} does not exist`);
  }
  return dirs;
}

function copyAssets(dirs, staging) {
  for (const d of dirs) {
    const dest = path.join(staging, ...d.to.split('/'));
    mkdirSync(path.dirname(dest), { recursive: true });
    cpSync(path.join(ROOT, ...d.from.split('/')), dest, { recursive: true, dereference: true });
  }
}

// ── Closure ─────────────────────────────────────────────────────────────────

/**
 * The workspace's production closure as npm placed it in the hoisted tree:
 * [{ name, version, path, rel, optional }], one per unique location.
 */
function resolveClosure(game, wsName) {
  const args = [
    'list', '-a', '--include', 'prod', '--include', 'optional', '--omit', 'dev',
    '--json', '--long', '--silent', '--loglevel=error', '-w', `packs/${game}`,
  ];
  // npm exits 1 on ELSPROBLEMS (e.g. an extraneous package or an override it
  // reports as "invalid") while still printing the full tree; electron-builder
  // ignores that exit code for `npm list` and so do we.
  const res = spawnSync(isWin ? 'npm.cmd' : 'npm', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    shell: isWin,
  });
  if (!res.stdout || !res.stdout.trim().startsWith('{')) {
    throw new Error(`npm list produced no JSON (exit ${res.status}): ${res.stderr?.slice(0, 500)}`);
  }
  const tree = JSON.parse(res.stdout);
  const wsNode = tree.dependencies?.[wsName];
  if (!wsNode) throw new Error(`npm list did not include workspace ${wsName}`);
  const nmRoot = path.join(ROOT, 'node_modules');
  const byPath = new Map();
  const skipped = [];
  const walk = (node, parentName) => {
    for (const [name, dep] of Object.entries(node.dependencies ?? {})) {
      if (!dep || typeof dep !== 'object') continue;
      if (!dep.path) {
        // A missing optional dep (platform-gated prebuild package) has no
        // location; a missing required dep is a broken install.
        if (dep.missing && !dep.optional && !dep.problems?.some((p) => /optional/i.test(p))) {
          if (dep.required) throw new Error(`required dependency ${name} of ${parentName} is missing from node_modules`);
        }
        skipped.push(`${name} (of ${parentName})`);
        walk(dep, name);
        continue;
      }
      const real = path.resolve(dep.path);
      if (!byPath.has(real)) {
        const rel = path.relative(nmRoot, real).split(path.sep).join('/');
        if (rel.startsWith('..')) {
          // A workspace link or a `file:` symlink outside node_modules cannot
          // be shipped by location; the pack copies real directories only.
          throw new Error(`dependency ${name} resolves outside node_modules: ${real}`);
        }
        byPath.set(real, { name, version: dep.version, path: real, rel, optional: Boolean(dep.optional) });
      }
      walk(dep, name);
    }
  };
  walk(wsNode, wsName);
  return { nodes: [...byPath.values()].sort((a, b) => a.rel.localeCompare(b.rel)), skipped };
}

// ── File walking ────────────────────────────────────────────────────────────

/** Depth-first list of every file under `dir` as posix paths relative to `base`. */
function listFiles(dir, base, out = []) {
  for (const name of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, name.name);
    if (name.isDirectory()) listFiles(p, base, out);
    else if (name.isFile()) out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}

function matchesAny(rel, globs, isDir) {
  for (const g of globs) {
    if (minimatch(rel, g, { dot: true })) return g;
    if (isDir && minimatch(`${rel}/`, g, { dot: true })) return g;
  }
  return null;
}

/** Delete everything under `root` matching a glob; returns per-glob hit counts. */
function pruneTree(root, globs) {
  const hits = new Map(globs.map((g) => [g, 0]));
  let removedFiles = 0;
  let removedBytes = 0;
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      const rel = path.relative(root, p).split(path.sep).join('/');
      const isDir = ent.isDirectory();
      const g = matchesAny(rel, globs, isDir);
      if (g) {
        if (isDir) {
          for (const f of listFiles(p, p)) {
            removedFiles++;
            removedBytes += statSync(path.join(p, f)).size;
          }
        } else {
          removedFiles++;
          removedBytes += statSync(p).size;
        }
        hits.set(g, hits.get(g) + 1);
        rmSync(p, { recursive: true, force: true });
        continue;
      }
      if (isDir) walk(p);
    }
  };
  walk(root);
  return { hits, removedFiles, removedBytes };
}

/** Count what the prune globs WOULD hit in the hoisted tree (dry run). */
function dryRunPrune(nodes, globs) {
  const hits = new Map(globs.map((g) => [g, 0]));
  const nmRoot = path.join(ROOT, 'node_modules');
  for (const n of nodes) {
    const stack = [n.path];
    while (stack.length) {
      const dir = stack.pop();
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        // Nested packages are their own closure nodes; do not descend twice.
        if (ent.isDirectory() && ent.name === 'node_modules' && dir === n.path) continue;
        const rel = `node_modules/${path.relative(nmRoot, p).split(path.sep).join('/')}`;
        const g = matchesAny(rel, globs, ent.isDirectory());
        if (g) {
          hits.set(g, hits.get(g) + 1);
          continue;
        }
        if (ent.isDirectory()) stack.push(p);
      }
    }
  }
  return hits;
}

// ── Copy ────────────────────────────────────────────────────────────────────

function copyClosure(nodes, staging) {
  const nm = path.join(staging, 'node_modules');
  mkdirSync(nm, { recursive: true });
  for (const n of nodes) {
    const dest = path.join(nm, ...n.rel.split('/'));
    mkdirSync(path.dirname(dest), { recursive: true });
    const nested = path.join(n.path, 'node_modules');
    cpSync(n.path, dest, {
      recursive: true,
      dereference: true,
      // Nested packages are separate closure nodes (copied by their own
      // entry, or deliberately absent); the copy of a node stops at its own
      // node_modules/.
      filter: (src) => src !== nested,
    });
  }
}

// ── Natives ─────────────────────────────────────────────────────────────────

function distutilsPython() {
  if (process.env.npm_config_python && existsSync(process.env.npm_config_python)) return process.env.npm_config_python;
  for (const p of [
    '/opt/homebrew/opt/python@3.11/bin/python3.11',
    '/opt/homebrew/opt/python@3.10/bin/python3.10',
    '/usr/bin/python3',
    'python3',
    'python',
  ]) {
    try {
      execFileSync(p, ['-c', 'import distutils'], { stdio: 'ignore' });
      return p;
    } catch {
      /* next */
    }
  }
  return undefined;
}

async function rebuildNatives(staging, ws, arch) {
  // Same patches postinstall applies to the repo tree, on the staged copies
  // (the copy carried the already-patched files, so this is a no-op unless
  // something re-extracted pristine sources; it is cheap and idempotent).
  applyAll(staging);
  const py = distutilsPython();
  if (py) process.env.npm_config_python = py;
  else log('WARNING: no distutils-capable Python found; a gl source build will fail');
  process.env.PKG_CONFIG_PATH = ['/opt/homebrew/opt/jpeg/lib/pkgconfig', '/opt/homebrew/lib/pkgconfig', process.env.PKG_CONFIG_PATH]
    .filter(Boolean)
    .join(':');
  if (isWin) {
    // gl compiles against Electron's V8 headers, which need the MSVC shim
    // (see patch-vision-native.mjs). Make sure the headers exist first.
    const devdir = path.join(homedir(), '.electron-gyp');
    try {
      execFileSync('npx', ['node-gyp', 'install', `--devdir=${devdir}`, `--target=${ws.electronVersion}`,
        '--dist-url=https://electronjs.org/headers', `--arch=${arch}`], { cwd: ROOT, stdio: 'inherit', shell: true });
    } catch (e) {
      log(`WARNING: electron header fetch failed (${e.message})`);
    }
    patchV8MsvcBuiltins(path.join(devdir, ws.electronVersion, 'include', 'node'));
  }
  const { rebuild } = await import('@electron/rebuild');
  log(`@electron/rebuild: electron ${ws.electronVersion} (abi ${ws.abi}) arch ${arch} in ${staging}`);
  const t0 = Date.now();
  await rebuild({
    buildPath: staging,
    electronVersion: ws.electronVersion,
    arch,
    // Not forced: a module whose build/Release/.forge-meta already says
    // `${arch}--${abi}` (postinstall's output, copied over) is skipped, which
    // is what makes the host-arch pack build fast. A cross-arch target
    // mismatches the meta and rebuilds.
    force: false,
    types: ['prod', 'optional'],
    useCache: false,
  });
  log(`rebuild done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

/** Every .forge-meta under staging must say the target arch + ABI. */
function verifyNativeMeta(staging, arch, abi, listOnly = false) {
  const want = `${arch}--${abi}`;
  const found = [];
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name === '.forge-meta') found.push(p);
    }
  };
  walk(path.join(staging, 'node_modules'));
  if (listOnly) return found.map((p) => path.relative(staging, p).split(path.sep).join('/'));
  const bad = found.filter((p) => readFileSync(p, 'utf8').trim() !== want);
  if (bad.length) {
    throw new Error(`native modules not built for ${want}: ${bad.map((p) => path.relative(staging, p)).join(', ')}`);
  }
  return found.map((p) => path.relative(staging, path.dirname(path.dirname(path.dirname(p)))).split(path.sep).join('/'));
}

// ── Hash + zip ──────────────────────────────────────────────────────────────

function sha256File(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

/** sha256 over sorted relative paths and per-file sha256s (pack.json excluded). */
function treeHashOf(staging) {
  const files = listFiles(staging, staging).filter((f) => f !== 'pack.json').sort();
  const h = createHash('sha256');
  let bytes = 0;
  for (const f of files) {
    const p = path.join(staging, ...f.split('/'));
    bytes += statSync(p).size;
    h.update(`${f}\n${sha256File(p)}\n`);
  }
  return { treeHash: h.digest('hex'), files: files.length, bytes };
}

function zipStaging(staging, zipPath) {
  rmSync(zipPath, { force: true });
  mkdirSync(path.dirname(zipPath), { recursive: true });
  const ver = spawnSync('tar', ['--version'], { encoding: 'utf8' });
  if (!/bsdtar/.test(ver.stdout ?? '')) {
    throw new Error(`bsdtar is required to write the zip (found: ${(ver.stdout || ver.stderr || '').trim() || 'no tar'})`);
  }
  const args = ['--format', 'zip', '-cf', zipPath];
  if (process.platform === 'darwin') args.push('--no-xattrs', '--no-mac-metadata');
  args.push('-C', staging, 'pack.json', 'node_modules');
  if (existsSync(path.join(staging, 'assets'))) args.push('assets');
  const res = spawnSync('tar', args, { stdio: 'inherit' });
  if (res.status !== 0) throw new Error(`tar exited ${res.status}`);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();
  const opts = parseArgs(process.argv.slice(2));
  const ws = loadWorkspace(opts.game);
  const prune = await loadPrune(opts.game, opts.platform);
  const assets = await loadAssets(opts.game);
  log(`${opts.game}: app ${ws.version}, electron ${ws.electronVersion} (abi ${ws.abi}), target ${opts.platform}-${opts.arch}`);

  const { nodes, skipped } = resolveClosure(opts.game, ws.pkg.name);
  log(`closure: ${nodes.length} packages (${nodes.filter((n) => n.rel.includes('/node_modules/')).length} nested)` +
    (skipped.length ? `; ${skipped.length} without a location (missing optional): ${skipped.slice(0, 6).join(', ')}${skipped.length > 6 ? ', ...' : ''}` : ''));

  if (opts.dryRun) {
    const hits = dryRunPrune(nodes, prune.globs);
    for (const [g, n] of hits) log(`prune ${n === 0 ? '(no match here)' : `${n} hit(s)`}: ${g}`);
    const missing = prune.mustKeep.filter((m) => !existsSync(path.join(ROOT, ...m.split('/'))));
    if (missing.length) throw new Error(`MUST_KEEP paths absent from the hoisted tree: ${missing.join(', ')}`);
    log(`dry run OK: ${nodes.length} packages, ${prune.globs.length} prune globs, ${prune.mustKeep.length} must-keep paths, ${assets.length} asset dir(s) (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    return;
  }

  const staging = opts.staging ?? path.join(ROOT, 'release', 'pack-staging', `${opts.game}-${opts.platform}-${opts.arch}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  writeFileSync(path.join(staging, 'package.json'), JSON.stringify({ ...ws.pkg, version: ws.version }, null, 2));
  log(`copying closure to ${staging}`);
  copyClosure(nodes, staging);
  // A pack with no npm dependencies (DST: the Lua mod only) still ships a
  // node_modules/ dir because the client's extractor expects one.
  mkdirSync(path.join(staging, 'node_modules'), { recursive: true });
  if (nodes.length === 0) writeFileSync(path.join(staging, 'node_modules', '.sei-pack-keep'), '');
  if (assets.length) {
    copyAssets(assets, staging);
    log(`assets: ${assets.map((a) => `${a.from} -> ${a.to}`).join(', ')}`);
  }

  const anyPlatform = opts.platform === 'any';
  if (anyPlatform) {
    // A platform-neutral pack must not carry natives; nothing to rebuild.
    const found = verifyNativeMeta(staging, 'any', ws.abi, true);
    if (found.length) throw new Error(`--platform any but the closure carries native modules: ${found.join(', ')}`);
  } else if (opts.skipRebuild) log('skipping native rebuild (--skip-rebuild)');
  else await rebuildNatives(staging, ws, opts.arch);
  const natives = anyPlatform ? [] : verifyNativeMeta(staging, opts.arch, ws.abi);
  log(`natives verified for ${opts.arch}--${ws.abi}: ${natives.join(', ') || '(none)'}`);

  const pr = pruneTree(staging, prune.globs);
  log(`pruned ${pr.removedFiles} files / ${(pr.removedBytes / 1048576).toFixed(1)}MB`);
  for (const [g, n] of pr.hits) if (n === 0) log(`prune (no match): ${g}`);
  const missing = prune.mustKeep.filter((m) => !existsSync(path.join(staging, ...m.split('/'))));
  if (missing.length) throw new Error(`prune removed MUST_KEEP paths: ${missing.join(', ')}`);
  // package.json was only there for @electron/rebuild; the pack root carries
  // pack.json alone.
  rmSync(path.join(staging, 'package.json'), { force: true });

  const { treeHash, files, bytes } = treeHashOf(staging);
  const packJson = {
    game: opts.game,
    version: ws.version,
    platform: opts.platform,
    arch: opts.arch,
    electron: ws.electronVersion,
    abi: ws.abi,
    treeHash,
    files,
    bytes,
    builtAt: new Date().toISOString(),
  };
  writeFileSync(path.join(staging, 'pack.json'), JSON.stringify(packJson, null, 2));
  log(`tree: ${files} files, ${(bytes / 1048576).toFixed(1)}MB, treeHash ${treeHash.slice(0, 16)}...`);

  const zipName = `sei-pack-${opts.game}-${ws.version}-${opts.platform}-${opts.arch}.zip`;
  const zipPath = path.join(opts.out, zipName);
  log(`zipping -> ${zipPath}`);
  zipStaging(staging, zipPath);
  const zipBytes = statSync(zipPath).size;
  const sha256 = sha256File(zipPath);
  const meta = { game: opts.game, platform: opts.platform, arch: opts.arch, file: zipName, sha256, bytes: zipBytes, treeHash };
  writeFileSync(`${zipPath}.meta.json`, JSON.stringify({ version: ws.version, ...meta }, null, 2));
  if (!opts.keepStaging) rmSync(staging, { recursive: true, force: true });
  log(`done: ${zipName} ${(zipBytes / 1048576).toFixed(1)}MB sha256 ${sha256.slice(0, 16)}... in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error(`[build-game-pack] FAILED: ${err?.stack ?? err}`);
  process.exit(1);
});
