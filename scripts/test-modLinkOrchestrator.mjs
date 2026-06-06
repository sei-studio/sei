#!/usr/bin/env node
// scripts/test-modLinkOrchestrator.mjs
//
// 260518-o1k T6: smoke-test runModLinkStage end-to-end against a fixture
// .minecraft tree with mixed-version mods.
//
// Test cases:
//   1. Compatible Fabric mod for 1.21.4 → hardlinked into seiGameDir/mods/.
//   2. Incompatible Fabric mod for 1.8.9 → excluded.
//   3. CSL JAR in source mods/ → ignored (NOT linked, NOT in exclusions).
//   4. Re-running with the same source set is idempotent (no entry churn).
//   5. Removing a previously-linked source JAR + re-running unlinks it
//      from seiGameDir/mods/.
//   6. Progress events fire with correct counter shape.
//
// Run:
//   node --import ./scripts/lib/electron-stub-loader.mjs scripts/test-modLinkOrchestrator.mjs

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const __dirname = path.dirname(new URL(import.meta.url).pathname);

const { runModLinkStage } = await import('../src/main/wizard.ts');

// ── Reuse the ZIP writer from test-modScanner.mjs (lifted inline so this
//    harness is self-contained). ────────────────────────────────────────────

function crc32Table() {
  const tbl = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    tbl[n] = c >>> 0;
  }
  return tbl;
}
const CRC_TABLE = crc32Table();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function buildZip(entries) {
  const chunks = [];
  const centralRecords = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    const size = e.data.length;
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0, 6);
    lfh.writeUInt16LE(0, 8);
    lfh.writeUInt16LE(0, 10);
    lfh.writeUInt16LE(0x21, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(size, 18);
    lfh.writeUInt32LE(size, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);
    chunks.push(lfh, nameBuf, e.data);
    const cdr = Buffer.alloc(46);
    cdr.writeUInt32LE(0x02014b50, 0);
    cdr.writeUInt16LE(20, 4);
    cdr.writeUInt16LE(20, 6);
    cdr.writeUInt16LE(0, 8);
    cdr.writeUInt16LE(0, 10);
    cdr.writeUInt16LE(0, 12);
    cdr.writeUInt16LE(0x21, 14);
    cdr.writeUInt32LE(crc, 16);
    cdr.writeUInt32LE(size, 20);
    cdr.writeUInt32LE(size, 24);
    cdr.writeUInt16LE(nameBuf.length, 28);
    cdr.writeUInt16LE(0, 30);
    cdr.writeUInt16LE(0, 32);
    cdr.writeUInt16LE(0, 34);
    cdr.writeUInt16LE(0, 36);
    cdr.writeUInt32LE(0, 38);
    cdr.writeUInt32LE(offset, 42);
    centralRecords.push(Buffer.concat([cdr, nameBuf]));
    offset += lfh.length + nameBuf.length + e.data.length;
  }
  const centralDirStart = offset;
  let centralDirSize = 0;
  for (const r of centralRecords) { chunks.push(r); centralDirSize += r.length; }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirSize, 12);
  eocd.writeUInt32LE(centralDirStart, 16);
  eocd.writeUInt16LE(0, 20);
  chunks.push(eocd);
  return Buffer.concat(chunks);
}

// ── Fixture builders ─────────────────────────────────────────────────────────

function fabricMod(id, version, mcRange) {
  return buildZip([
    {
      name: 'fabric.mod.json',
      data: Buffer.from(JSON.stringify({
        schemaVersion: 1,
        id,
        version,
        depends: { minecraft: mcRange },
      })),
    },
  ]);
}

function cslJar() {
  return buildZip([
    {
      name: 'fabric.mod.json',
      data: Buffer.from(JSON.stringify({
        schemaVersion: 1,
        id: 'customskinloader',
        version: '14.28',
        depends: { minecraft: '<=1.21.11' },
      })),
    },
  ]);
}

// ── Test runner ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
async function check(label, fn) {
  try {
    await fn();
    console.log(`PASS  ${label}`);
    passed++;
  } catch (err) {
    console.error(`FAIL  ${label}`);
    console.error(`  ${err.message}`);
    failed++;
  }
}

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sei-modlink-'));

// Build a fixture .minecraft tree:
//   mcDir/mods/Sodium-compat.jar      (fabric 1.21.4 — compatible)
//   mcDir/mods/SkyHanni-old.jar       (fabric 1.8.9 — incompatible)
//   mcDir/mods/CustomSkinLoader_Fabric-14.28.jar  (CSL — should be ignored)
const mcDir = path.join(tmpRoot, '.minecraft');
const seiGameDir = path.join(mcDir, 'sei');
const sourceMods = path.join(mcDir, 'mods');
const seiMods = path.join(seiGameDir, 'mods');
await fs.mkdir(sourceMods, { recursive: true });
await fs.mkdir(seiMods, { recursive: true });

const sodiumPath = path.join(sourceMods, 'Sodium-compat.jar');
const skyhanniPath = path.join(sourceMods, 'SkyHanni-old.jar');
const cslSourcePath = path.join(sourceMods, 'CustomSkinLoader_Fabric-14.28.jar');
await fs.writeFile(sodiumPath, fabricMod('sodium', '0.6.0', '>=1.21.0'));
await fs.writeFile(skyhanniPath, fabricMod('skyhanni', '3.8.0', '1.8.9'));
await fs.writeFile(cslSourcePath, cslJar());

// Pretend an existing CSL JAR was placed by T5 into the Sei mods/ — the
// reconciler must NEVER unlink it.
const seiCslPath = path.join(seiMods, 'CustomSkinLoader_Fabric-14.28.jar');
await fs.writeFile(seiCslPath, cslJar());

// Minimal McInstall fixture — only the fields runModLinkStage reads.
const install = {
  id: 'fixture-install',
  kind: 'vanilla',
  label: 'Fixture Vanilla',
  path: mcDir,
  mc_version: '1.21.4',
  loader: 'fabric',
  loader_version: '0.16.0',
  csl_installed: false,
  csl_version: null,
  sei_enabled: false,
  compatibility: 'full',
};

const progressEvents = [];
const onProgress = (ev) => progressEvents.push(ev);

// FIRST RUN ──────────────────────────────────────────────────────────────────
let firstRunResult;
await check('first run scans + links compatible mods', async () => {
  firstRunResult = await runModLinkStage({
    install,
    seiGameDir,
    targetMc: '1.21.4',
    signal: new AbortController().signal,
    onProgress,
    priorManifest: null,
  });
  // Compatible Sodium is linked.
  const sodiumLinked = await fs.lstat(path.join(seiMods, 'Sodium-compat.jar'));
  assert.ok(sodiumLinked, 'sodium link missing');
  // Incompatible SkyHanni is NOT linked.
  let skyhanniExisted = true;
  try { await fs.lstat(path.join(seiMods, 'SkyHanni-old.jar')); }
  catch { skyhanniExisted = false; }
  assert.equal(skyhanniExisted, false, 'skyhanni should not be linked');
  // CSL JAR in seiMods is still there (never touched).
  await fs.access(seiCslPath);
  // Summary numbers.
  assert.equal(firstRunResult.summary.linked, 1);
  assert.equal(firstRunResult.summary.excluded, 1);
  assert.equal(firstRunResult.summary.linkedJars[0].sourceName, 'Sodium-compat.jar');
  assert.equal(firstRunResult.summary.excludedJars[0].name, 'SkyHanni-old.jar');
  assert.equal(firstRunResult.summary.excludedJars[0].reason, 'mc-version-mismatch');
  assert.equal(firstRunResult.summary.excludedJars[0].declaredMc, '1.8.9');
});

await check('first run progress events fire with correct shape', async () => {
  const linkEvents = progressEvents.filter((e) => e.stage === 'mods-linking');
  assert.ok(linkEvents.length >= 2, `expected ≥2 mods-linking events, got ${linkEvents.length}`);
  // First event has totalEstimate=null.
  assert.equal(linkEvents[0].totalEstimate, null);
  // Subsequent events have a concrete totalEstimate (2 — sodium + skyhanni;
  // CSL is filtered out before the count).
  const withTotal = linkEvents.find((e) => e.totalEstimate != null);
  assert.equal(withTotal.totalEstimate, 2);
  // Final event reports scanned=2, linked=1, excluded=1.
  const last = linkEvents[linkEvents.length - 1];
  assert.equal(last.scanned, 2);
  assert.equal(last.linked, 1);
  assert.equal(last.excluded, 1);
});

// SECOND RUN (idempotent) ────────────────────────────────────────────────────
await check('second run is idempotent (same source set)', async () => {
  const before = (await fs.readdir(seiMods)).sort();
  progressEvents.length = 0;
  const r2 = await runModLinkStage({
    install,
    seiGameDir,
    targetMc: '1.21.4',
    signal: new AbortController().signal,
    onProgress,
    priorManifest: firstRunResult.manifest,
  });
  const after = (await fs.readdir(seiMods)).sort();
  assert.deepEqual(after, before, `mods set changed: ${before} → ${after}`);
  assert.equal(r2.summary.linked, 1);
  assert.equal(r2.summary.excluded, 1);
});

// THIRD RUN (remove Sodium from source → reconciler unlinks) ─────────────────
let thirdRunResult;
await check('removing source mod unlinks from seiMods on next run', async () => {
  await fs.unlink(sodiumPath);
  progressEvents.length = 0;
  thirdRunResult = await runModLinkStage({
    install,
    seiGameDir,
    targetMc: '1.21.4',
    signal: new AbortController().signal,
    onProgress,
    priorManifest: firstRunResult.manifest,
  });
  // seiMods no longer contains Sodium.
  let sodiumStill = true;
  try { await fs.lstat(path.join(seiMods, 'Sodium-compat.jar')); }
  catch { sodiumStill = false; }
  assert.equal(sodiumStill, false, 'sodium link should have been reconciled away');
  // CSL still untouched.
  await fs.access(seiCslPath);
  // Summary now shows zero linked.
  assert.equal(thirdRunResult.summary.linked, 0);
  assert.equal(thirdRunResult.summary.excluded, 1);
});

// FOURTH RUN — abort signal already fired → throws cancellation marker. ─────
await check('aborted signal yields MOD_DOWNLOAD_FAILED: cancelled', async () => {
  // Re-add sodium so there's something to scan; abort partway means abort
  // before the first JAR scan.
  await fs.writeFile(sodiumPath, fabricMod('sodium', '0.6.0', '>=1.21.0'));
  const ac = new AbortController();
  ac.abort();
  let thrown = null;
  try {
    await runModLinkStage({
      install,
      seiGameDir,
      targetMc: '1.21.4',
      signal: ac.signal,
      onProgress: () => {},
      priorManifest: thirdRunResult.manifest,
    });
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, 'expected runModLinkStage to throw on aborted signal');
  assert.match(thrown.message, /cancelled/i);
});

// Cleanup tmp.
try {
  await fs.rm(tmpRoot, { recursive: true, force: true });
} catch {
  /* ignore */
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
