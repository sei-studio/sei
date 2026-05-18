#!/usr/bin/env node
// scripts/verify-phase9-csl-config.mjs
//
// Phase 9 Plan 05 Task 3B — pure-Node verification harness for
// src/main/customSkinLoader.ts's `writeCustomSkinLoaderConfig(opts)`.
// Calls the function against a tempdir and reads back the written
// `<tmp>/config/CustomSkinLoader/CustomSkinLoader.json` to assert the
// canonical CSL schema shape we ship.
//
// IMPORTANT — Plan-text vs implementation divergence (carried from Plan 04
// Rule 1 deviation):
//   - The Plan 05 plan text references `cfg.loadlist[0].type === 'CustomSkinAPI'`
//     as the expected loader type.
//   - The SHIPPED CODE (src/main/customSkinLoader.ts) writes `type: 'Legacy'`,
//     per upstream-source verification (Common/src/main/java/customskinloader/
//     loader/LegacyLoader.java is the loader for literal-URL PNG backends like
//     ours; CustomSkinAPI is for JSON-returning servers, which our loopback
//     skin server is NOT).
//   - `scripts/verify-csl-config-schema.mjs` (Plan 04 Task 2A research script)
//     is the AUTHORITATIVE schema reference. It re-verifies against upstream
//     Java source on every run.
//
// This harness therefore asserts the implementation-shipped values (`Legacy`),
// matching the Plan 04 Rule 1 corrected schema. The original plan text was a
// doc-trail artifact pinned before the upstream-source research step was run.
//
// Pure Node — no Electron, no real MC install, no network. The companion
// electron-stub-loader.mjs (`node --import`) substitutes the `electron`
// module so the customSkinLoader.ts → paths.ts → `app.getPath('userData')`
// path doesn't throw outside an Electron context.
//
// Re-run via:
//   npm run verify:phase9-csl-config
//
// Seven assertions (matching the SHIPPED schema):
//   T1  cfg.loadlist is an array of length 1
//   T2  loadlist[0].name === 'SeiLocal'
//   T3  loadlist[0].type === 'Legacy'          ← see Plan 04 Rule 1 deviation
//   T4  loadlist[0].skin === '<base>/skins/{USERNAME}.png'
//   T5  loadlist[0].checkPNG === true
//   T6  cfg.enableLocalProfileCache === false
//   T7  cfg.enableCacheAutoClean === true
//
// Exits 0 on PASS 7/7; non-zero with the failing assertion label on FAIL.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

// Set a clean userData override BEFORE importing src/main/* so any
// userData-rooted module-init has a controlled location.
const userDataTmp = mkdtempSync(path.join(os.tmpdir(), 'sei-phase9-csl-userdata-'));
process.env.SEI_USER_DATA_OVERRIDE = userDataTmp;

const { writeCustomSkinLoaderConfig } = await import('../src/main/customSkinLoader.ts');

function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    console.error(`FAIL ${label}: expected ${e} got ${a}`);
    process.exit(1);
  }
  console.log(`OK   ${label}`);
}

// ─── Synthetic install dir ───────────────────────────────────────────────
const tmpInstallDir = mkdtempSync(path.join(os.tmpdir(), 'sei-phase9-csl-install-'));
const skinServerBaseUrl = 'http://127.0.0.1:54321';

// ─── Write the config ───────────────────────────────────────────────────
let configPath;
try {
  const res = await writeCustomSkinLoaderConfig({
    mcInstallDir: tmpInstallDir,
    loaderKind: 'fabric',
    skinServerBaseUrl,
  });
  configPath = res.configPath;
} catch (err) {
  console.error(`FAIL writeCustomSkinLoaderConfig threw: ${err.message}`);
  rmSync(tmpInstallDir, { recursive: true, force: true });
  rmSync(userDataTmp, { recursive: true, force: true });
  process.exit(1);
}

// ─── Read it back + parse ───────────────────────────────────────────────
let cfg;
try {
  const raw = readFileSync(configPath, 'utf8');
  cfg = JSON.parse(raw);
} catch (err) {
  console.error(`FAIL could not parse written config: ${err.message}`);
  rmSync(tmpInstallDir, { recursive: true, force: true });
  rmSync(userDataTmp, { recursive: true, force: true });
  process.exit(1);
}

// ─── Assertions ─────────────────────────────────────────────────────────
assertEq(Array.isArray(cfg.loadlist) && cfg.loadlist.length === 1, true, 'T1 cfg.loadlist length === 1');
assertEq(cfg.loadlist[0]?.name, 'SeiLocal', 'T2 loadlist[0].name === SeiLocal');
// WARNING 6 regression guard (Rule 1 corrected): loader type is `Legacy`,
// NOT `CustomSkinAPI`. See file-header note. The companion script
// scripts/verify-csl-config-schema.mjs proves this against upstream Java source.
assertEq(cfg.loadlist[0]?.type, 'Legacy', 'T3 loadlist[0].type === Legacy');
assertEq(cfg.loadlist[0]?.skin, `${skinServerBaseUrl}/skins/{USERNAME}.png`, 'T4 loadlist[0].skin === <base>/skins/{USERNAME}.png');
assertEq(cfg.loadlist[0]?.checkPNG, true, 'T5 loadlist[0].checkPNG === true');
assertEq(cfg.enableLocalProfileCache, false, 'T6 cfg.enableLocalProfileCache === false');
assertEq(cfg.enableCacheAutoClean, true, 'T7 cfg.enableCacheAutoClean === true');

// ─── Cleanup ────────────────────────────────────────────────────────────
rmSync(tmpInstallDir, { recursive: true, force: true });
rmSync(userDataTmp, { recursive: true, force: true });

console.log('PASS 7/7');
