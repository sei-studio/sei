#!/usr/bin/env node
// scripts/test-lunarDetect.mjs
//
// 260518-o1k T3: smoke-test the Lunar-detection branch in scanMcInstalls.
//
// Builds a fixture homedir tree with a `.lunarclient/` subdir on each
// platform (darwin/linux/win32) and calls scanMcInstalls with
// homedirOverride + platformOverride to verify a Lunar McInstall row is
// emitted with kind='lunar', compatibility='limited', loader=null,
// csl_installed=false. Also asserts the row is ABSENT when the fixture
// homedir has no `.lunarclient/` subdir.
//
// Run:
//   node --import ./scripts/lib/electron-stub-loader.mjs scripts/test-lunarDetect.mjs
//
// (The electron-stub-loader is required because mcInstallScan.ts
// transitively imports paths.ts, which depends on the electron `app`
// global. The stub provides a no-op app implementation rooted at a
// tempdir so module-init doesn't crash outside an Electron context.)

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanMcInstalls } from '../src/main/mcInstallScan.ts';

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sei-lunar-detect-'));

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

// Helper: build a fixture homedir with a `.lunarclient/` subdir.
async function fixtureHome(label) {
  const home = path.join(tmpRoot, label);
  await fs.mkdir(path.join(home, '.lunarclient'), { recursive: true });
  return home;
}

// ── Cases ────────────────────────────────────────────────────────────────────

await check('darwin homedir with .lunarclient → Lunar row emitted', async () => {
  const home = await fixtureHome('darwin-with-lunar');
  const installs = await scanMcInstalls({ homedirOverride: home, platformOverride: 'darwin' });
  const lunar = installs.find((i) => i.kind === 'lunar');
  assert.ok(lunar, `no lunar row in ${JSON.stringify(installs)}`);
  assert.equal(lunar.compatibility, 'limited');
  assert.equal(lunar.label, 'Lunar Client');
  assert.equal(lunar.loader, null);
  assert.equal(lunar.csl_installed, false);
  assert.equal(lunar.mc_version, null);
  assert.equal(lunar.sei_enabled, false);
  assert.equal(lunar.path, path.join(home, '.lunarclient'));
});

await check('linux homedir with .lunarclient → Lunar row emitted', async () => {
  const home = await fixtureHome('linux-with-lunar');
  const installs = await scanMcInstalls({ homedirOverride: home, platformOverride: 'linux' });
  const lunar = installs.find((i) => i.kind === 'lunar');
  assert.ok(lunar, `no lunar row in ${JSON.stringify(installs)}`);
  assert.equal(lunar.compatibility, 'limited');
});

await check('win32 homedir with .lunarclient → Lunar row emitted', async () => {
  const home = await fixtureHome('win-with-lunar');
  const installs = await scanMcInstalls({ homedirOverride: home, platformOverride: 'win32' });
  const lunar = installs.find((i) => i.kind === 'lunar');
  assert.ok(lunar, `no lunar row in ${JSON.stringify(installs)}`);
  assert.equal(lunar.compatibility, 'limited');
});

await check('darwin homedir WITHOUT .lunarclient → no Lunar row', async () => {
  const home = path.join(tmpRoot, 'darwin-no-lunar');
  await fs.mkdir(home, { recursive: true });
  const installs = await scanMcInstalls({ homedirOverride: home, platformOverride: 'darwin' });
  const lunar = installs.find((i) => i.kind === 'lunar');
  assert.equal(lunar, undefined);
});

// Cleanup tmp.
try {
  await fs.rm(tmpRoot, { recursive: true, force: true });
} catch {
  /* ignore */
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
