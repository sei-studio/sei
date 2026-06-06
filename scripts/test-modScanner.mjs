// scripts/test-modScanner.mjs
//
// 260518-o1k T1: synthetic-fixture suite for src/main/modScanner.ts.
//
// We hand-construct minimal valid ZIPs (no compression, single-entry) in
// memory and write them to a temp dir, then call scanModJar against each.
// Six assertions:
//   1. Fabric mod targeting 1.21.4 against target 1.21.4 → compatible.
//   2. Fabric mod targeting 1.8.9 against target 1.21.4 → mc-version-mismatch.
//   3. Forge mod with versionRange "[1.20,1.21)" against 1.20.1 → compatible.
//   4. Forge mod with versionRange "[1.16.5]" against 1.21.4 → mc-version-mismatch.
//   5. JAR with neither metadata file → no-metadata.
//   6. JAR with malformed fabric.mod.json → unparseable.
//
// Plus a best-effort real-world scan against ~/Library/Application Support/minecraft/mods/
// and ~/.minecraft/mods/ for diagnostic output.
//
// Run: node scripts/test-modScanner.mjs

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mod;
try {
  mod = await import('../src/main/modScanner.ts');
} catch (err) {
  console.error('Could not import modScanner.ts directly. If Node <22 try: npx tsx scripts/test-modScanner.mjs');
  console.error('Original error:', err.message);
  process.exit(2);
}
const { scanModJar, satisfiesFabric, satisfiesForgeMavenRange } = mod;

// ── Minimal ZIP writer (STORE-mode, single-entry-at-a-time append) ──────────
//
// We build a valid ZIP file from scratch so we don't need an external dep
// like adm-zip. We use store (no compression) entries which keep the writer
// to ~40 lines of code. Refs: APPNOTE.TXT v6.3, sections 4.3.6–4.3.16.

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

/**
 * @param entries Array<{ name: string; data: Buffer }>
 * @returns Buffer (valid ZIP archive)
 */
function buildZip(entries) {
  const chunks = [];
  const centralRecords = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    const size = e.data.length;

    // Local file header (30 bytes + name + data).
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);           // signature
    lfh.writeUInt16LE(20, 4);                    // version needed
    lfh.writeUInt16LE(0, 6);                     // gp flag
    lfh.writeUInt16LE(0, 8);                     // method (store)
    lfh.writeUInt16LE(0, 10);                    // mtime
    lfh.writeUInt16LE(0x21, 12);                 // mdate (some date)
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(size, 18);                 // compressed size
    lfh.writeUInt32LE(size, 22);                 // uncompressed size
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);                    // extra len
    chunks.push(lfh, nameBuf, e.data);

    // Build the central directory record for this entry.
    const cdr = Buffer.alloc(46);
    cdr.writeUInt32LE(0x02014b50, 0);            // signature
    cdr.writeUInt16LE(20, 4);                     // version made by
    cdr.writeUInt16LE(20, 6);                     // version needed
    cdr.writeUInt16LE(0, 8);                      // gp flag
    cdr.writeUInt16LE(0, 10);                     // method
    cdr.writeUInt16LE(0, 12);                     // mtime
    cdr.writeUInt16LE(0x21, 14);                  // mdate
    cdr.writeUInt32LE(crc, 16);
    cdr.writeUInt32LE(size, 20);
    cdr.writeUInt32LE(size, 24);
    cdr.writeUInt16LE(nameBuf.length, 28);
    cdr.writeUInt16LE(0, 30);                    // extra len
    cdr.writeUInt16LE(0, 32);                    // comment len
    cdr.writeUInt16LE(0, 34);                    // disk #
    cdr.writeUInt16LE(0, 36);                    // internal attrs
    cdr.writeUInt32LE(0, 38);                    // external attrs
    cdr.writeUInt32LE(offset, 42);               // local header offset
    centralRecords.push(Buffer.concat([cdr, nameBuf]));

    offset += lfh.length + nameBuf.length + e.data.length;
  }

  const centralDirStart = offset;
  let centralDirSize = 0;
  for (const r of centralRecords) {
    chunks.push(r);
    centralDirSize += r.length;
  }

  // End of central directory record.
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);                       // disk #
  eocd.writeUInt16LE(0, 6);                       // disk where CD starts
  eocd.writeUInt16LE(entries.length, 8);          // CD entries on this disk
  eocd.writeUInt16LE(entries.length, 10);         // total CD entries
  eocd.writeUInt32LE(centralDirSize, 12);
  eocd.writeUInt32LE(centralDirStart, 16);
  eocd.writeUInt16LE(0, 20);                      // comment len
  chunks.push(eocd);

  return Buffer.concat(chunks);
}

// Sanity-check the writer: a one-entry ZIP must inflate via zlib? (it's
// stored, no inflate needed) — just confirm the magic is right. We could
// also round-trip it through yauzl, but that's exactly what scanModJar
// does so the test cases below cover this implicitly.
{
  const buf = buildZip([{ name: 'test.txt', data: Buffer.from('hi') }]);
  assert.equal(buf.readUInt32LE(0), 0x04034b50, 'ZIP magic at offset 0');
  assert.equal(buf.readUInt32LE(buf.length - 22), 0x06054b50, 'EOCD magic at tail');
}

// ── Fixture helpers ──────────────────────────────────────────────────────────

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sei-modscanner-'));
let testNum = 0;
function makeFixture(name, entries) {
  testNum++;
  const p = path.join(tmpDir, `fixture-${testNum}-${name}.jar`);
  return fs.writeFile(p, buildZip(entries)).then(() => p);
}

let passed = 0;
let failed = 0;
function check(label, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`PASS  ${label}`);
      passed++;
    })
    .catch((err) => {
      console.error(`FAIL  ${label}`);
      console.error(`  ${err.message}`);
      failed++;
    });
}

// Quick smoke on the pure-function range resolvers — these don't need fixtures
// but failing here means the JAR-based assertions can't be trusted.
console.log('── range resolver smoke ──');
await check('satisfiesFabric: >=1.21.0 against 1.21.4', () => {
  assert.equal(satisfiesFabric('>=1.21.0', '1.21.4'), true);
});
await check('satisfiesFabric: 1.8.9 against 1.21.4', () => {
  assert.equal(satisfiesFabric('1.8.9', '1.21.4'), false);
});
await check('satisfiesFabric: ~1.20.1 against 1.20.4', () => {
  assert.equal(satisfiesFabric('~1.20.1', '1.20.4'), true);
});
await check('satisfiesForgeMavenRange: [1.20,1.21) against 1.20.1', () => {
  assert.equal(satisfiesForgeMavenRange('[1.20,1.21)', '1.20.1'), true);
});
await check('satisfiesForgeMavenRange: [1.20,1.21) against 1.21.0', () => {
  assert.equal(satisfiesForgeMavenRange('[1.20,1.21)', '1.21.0'), false);
});
await check('satisfiesForgeMavenRange: [1.16.5] against 1.16.5', () => {
  assert.equal(satisfiesForgeMavenRange('[1.16.5]', '1.16.5'), true);
});
await check('satisfiesForgeMavenRange: [1.16.5] against 1.21.4', () => {
  assert.equal(satisfiesForgeMavenRange('[1.16.5]', '1.21.4'), false);
});

console.log('── fixture-based scanModJar ──');

// FIXTURE 1: Fabric mod targeting 1.21.4 against target 1.21.4 → compatible.
await check('fabric 1.21.4 vs 1.21.4 → compatible', async () => {
  const meta = JSON.stringify({
    schemaVersion: 1,
    id: 'sodium',
    version: '0.6.0',
    name: 'Sodium',
    depends: { minecraft: '>=1.21.0' },
  });
  const p = await makeFixture('fabric-compat', [
    { name: 'fabric.mod.json', data: Buffer.from(meta) },
  ]);
  const r = await scanModJar(p, '1.21.4');
  assert.equal(r.compatible, true, JSON.stringify(r));
  assert.equal(r.loader, 'fabric');
  assert.equal(r.modId, 'sodium');
  assert.equal(r.declaredMc, '>=1.21.0');
});

// FIXTURE 2: Fabric mod targeting 1.8.9 against target 1.21.4 → mismatch.
await check('fabric 1.8.9 vs 1.21.4 → mc-version-mismatch', async () => {
  const meta = JSON.stringify({
    schemaVersion: 1,
    id: 'skyhanni',
    version: '3.8.0',
    depends: { minecraft: '1.8.9' },
  });
  const p = await makeFixture('fabric-mismatch', [
    { name: 'fabric.mod.json', data: Buffer.from(meta) },
  ]);
  const r = await scanModJar(p, '1.21.4');
  assert.equal(r.compatible, false, JSON.stringify(r));
  assert.equal(r.loader, 'fabric');
  assert.equal(r.reason, 'mc-version-mismatch');
  assert.equal(r.declaredMc, '1.8.9');
});

// FIXTURE 3: Forge mod with versionRange [1.20,1.21) against 1.20.1 → compatible.
await check('forge [1.20,1.21) vs 1.20.1 → compatible', async () => {
  const toml = `
modLoader="javafml"
loaderVersion="[40,)"
license="MIT"

[[mods]]
modId="examplemod"
version="1.0.0"
displayName="Example Mod"

[[dependencies.examplemod]]
modId="forge"
mandatory=true
versionRange="[40,)"
ordering="NONE"
side="BOTH"

[[dependencies.examplemod]]
modId="minecraft"
mandatory=true
versionRange="[1.20,1.21)"
ordering="NONE"
side="BOTH"
`;
  const p = await makeFixture('forge-compat', [
    { name: 'META-INF/mods.toml', data: Buffer.from(toml) },
  ]);
  const r = await scanModJar(p, '1.20.1');
  assert.equal(r.compatible, true, JSON.stringify(r));
  assert.equal(r.loader, 'forge');
  assert.equal(r.modId, 'examplemod');
  assert.equal(r.declaredMc, '[1.20,1.21)');
});

// FIXTURE 4: Forge mod with versionRange [1.16.5] against 1.21.4 → mismatch.
await check('forge [1.16.5] vs 1.21.4 → mc-version-mismatch', async () => {
  const toml = `
modLoader="javafml"
loaderVersion="[36,)"

[[mods]]
modId="pixelmon"
version="9.1.0"

[[dependencies.pixelmon]]
modId="minecraft"
mandatory=true
versionRange="[1.16.5]"
`;
  const p = await makeFixture('forge-mismatch', [
    { name: 'META-INF/mods.toml', data: Buffer.from(toml) },
  ]);
  const r = await scanModJar(p, '1.21.4');
  assert.equal(r.compatible, false, JSON.stringify(r));
  assert.equal(r.loader, 'forge');
  assert.equal(r.reason, 'mc-version-mismatch');
  assert.equal(r.declaredMc, '[1.16.5]');
});

// FIXTURE 5: JAR with neither metadata file → no-metadata.
await check('no metadata files → no-metadata', async () => {
  const p = await makeFixture('no-meta', [
    { name: 'pack.mcmeta', data: Buffer.from('{}') },
    { name: 'some/random/class.txt', data: Buffer.from('placeholder') },
  ]);
  const r = await scanModJar(p, '1.21.4');
  assert.equal(r.compatible, false, JSON.stringify(r));
  assert.equal(r.loader, null);
  assert.equal(r.reason, 'no-metadata');
});

// FIXTURE 6: JAR with malformed fabric.mod.json → unparseable.
await check('malformed fabric.mod.json → unparseable', async () => {
  const p = await makeFixture('fabric-bad', [
    { name: 'fabric.mod.json', data: Buffer.from('{this is not valid JSON') },
  ]);
  const r = await scanModJar(p, '1.21.4');
  assert.equal(r.compatible, false, JSON.stringify(r));
  assert.equal(r.loader, null);
  assert.equal(r.reason, 'unparseable');
});

// ── Best-effort real-world scan (informational only — never affects pass/fail) ─
console.log('── best-effort real-world scan ──');
const realWorldCandidates = [
  path.join(os.homedir(), 'Library', 'Application Support', 'minecraft', 'mods'),
  path.join(os.homedir(), '.minecraft', 'mods'),
];
for (const dir of realWorldCandidates) {
  try {
    const entries = await fs.readdir(dir);
    const jars = entries.filter((n) => n.toLowerCase().endsWith('.jar'));
    if (jars.length === 0) {
      console.log(`  ${dir}: no JARs`);
      continue;
    }
    console.log(`  ${dir}: ${jars.length} JARs`);
    for (const j of jars.slice(0, 6)) {
      try {
        const r = await scanModJar(path.join(dir, j), '1.21.4');
        console.log(`    ${j}: ${JSON.stringify(r)}`);
      } catch (err) {
        console.log(`    ${j}: <error> ${err.message}`);
      }
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log(`  ${dir}: (absent — skipping)`);
    } else {
      console.log(`  ${dir}: <error> ${err.message}`);
    }
  }
}

// Cleanup tmp.
try {
  await fs.rm(tmpDir, { recursive: true, force: true });
} catch {
  /* ignore */
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
