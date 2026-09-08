#!/usr/bin/env node
// scripts/build-game-pack-manifest.mjs <dir> [--out dir] [--version v] [--from-meta]
//
// Writes game-packs-<version>.json, the per-release manifest the client
// (src/main/games/packs.ts) fetches to find its pack:
//
//   { version, packs: [{ game, platform, arch, file, sha256, bytes, treeHash }] }
//
// Two inputs, one output:
//   default      <dir> holds sei-pack-*.zip files. Each is hashed (sha256 +
//                size) and its pack.json is read out of the zip for treeHash.
//                Needs jszip from node_modules (a dev machine).
//   --from-meta  <dir> holds the <zip>.meta.json sidecars build-game-pack.mjs
//                writes beside every zip (recursively; CI downloads one
//                artifact per build leg into subdirs). No dependencies at
//                all, which is why the release job can run it on a bare
//                checkout without npm ci.
//
// The version comes from --version, else from the inputs (every pack must
// agree), else from the root package.json. Contract: src/shared/gamePacks.ts.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const log = (m) => console.log(`[build-game-pack-manifest] ${m}`);

const PACK_RE = /^sei-pack-([a-z0-9]+)-(.+)-([a-z0-9]+)-([a-z0-9]+)\.zip$/;

function parseArgs(argv) {
  const out = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out.out = path.resolve(argv[++i]);
    else if (a === '--version') out.version = argv[++i];
    else if (a === '--from-meta') out.fromMeta = true;
    else if (a.startsWith('--')) throw new Error(`unknown flag ${a}`);
    else rest.push(a);
  }
  if (rest.length !== 1) throw new Error('usage: build-game-pack-manifest.mjs <dir> [--out dir] [--version v] [--from-meta]');
  out.dir = path.resolve(rest[0]);
  out.out ??= out.dir;
  return out;
}

function walk(dir, pred, out = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, pred, out);
    else if (pred(ent.name)) out.push(p);
  }
  return out;
}

function entryFromMeta(file) {
  const m = JSON.parse(readFileSync(file, 'utf8'));
  for (const k of ['game', 'platform', 'arch', 'file', 'sha256', 'bytes', 'treeHash']) {
    if (m[k] === undefined || m[k] === null) throw new Error(`${file}: missing ${k}`);
  }
  return { version: m.version, entry: { game: m.game, platform: m.platform, arch: m.arch, file: m.file, sha256: m.sha256, bytes: m.bytes, treeHash: m.treeHash } };
}

async function entryFromZip(file) {
  const name = path.basename(file);
  const m = PACK_RE.exec(name);
  if (!m) throw new Error(`${name} is not a pack asset name`);
  const buf = readFileSync(file);
  const sha256 = createHash('sha256').update(buf).digest('hex');
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(buf);
  const pj = zip.file('pack.json');
  if (!pj) throw new Error(`${name} has no pack.json`);
  const pack = JSON.parse(await pj.async('string'));
  if (!/^[0-9a-f]{64}$/.test(pack.treeHash ?? '')) throw new Error(`${name}: pack.json has no treeHash`);
  if (pack.game !== m[1] || pack.platform !== m[3] || pack.arch !== m[4]) {
    throw new Error(`${name}: pack.json (${pack.game}/${pack.platform}/${pack.arch}) does not match the file name`);
  }
  return {
    version: m[2],
    entry: { game: m[1], platform: m[3], arch: m[4], file: name, sha256, bytes: statSync(file).size, treeHash: pack.treeHash },
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!existsSync(opts.dir)) throw new Error(`no such dir ${opts.dir}`);
  const inputs = opts.fromMeta
    ? walk(opts.dir, (n) => n.endsWith('.zip.meta.json'))
    : walk(opts.dir, (n) => PACK_RE.test(n));
  if (inputs.length === 0) throw new Error(`no ${opts.fromMeta ? 'meta sidecars' : 'pack zips'} under ${opts.dir}`);
  const results = [];
  for (const f of inputs.sort()) results.push(opts.fromMeta ? entryFromMeta(f) : await entryFromZip(f));

  const versions = new Set(results.map((r) => r.version).filter(Boolean));
  let version = opts.version;
  if (!version) {
    if (versions.size > 1) throw new Error(`packs disagree on version: ${[...versions].join(', ')}; pass --version`);
    version = [...versions][0] ?? JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  }
  const seen = new Set();
  const packs = [];
  for (const { entry } of results) {
    const key = `${entry.game}/${entry.platform}/${entry.arch}`;
    if (seen.has(key)) throw new Error(`duplicate pack for ${key}`);
    seen.add(key);
    packs.push(entry);
  }
  packs.sort((a, b) => `${a.game}/${a.platform}/${a.arch}`.localeCompare(`${b.game}/${b.platform}/${b.arch}`));
  const manifest = { version, packs };
  mkdirSync(opts.out, { recursive: true });
  const outFile = path.join(opts.out, `game-packs-${version}.json`);
  writeFileSync(outFile, JSON.stringify(manifest, null, 2) + '\n');
  log(`wrote ${outFile} (${packs.length} pack(s): ${packs.map((p) => `${p.game}/${p.platform}/${p.arch}`).join(', ')})`);
}

main().catch((err) => {
  console.error(`[build-game-pack-manifest] FAILED: ${err?.stack ?? err}`);
  process.exit(1);
});
