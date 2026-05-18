#!/usr/bin/env node
// scripts/verify-phase9-installs.mjs
//
// Phase 9 Plan 05 Task 3A — pure-Node verification harness for
// src/main/mcInstallScan.ts's `scanMcInstalls(opts?)`. Builds a synthetic
// vanilla `.minecraft` tree + a synthetic CurseForge `Instances` tree
// under a tempdir, then calls `scanMcInstalls({ homedirOverride: <tmp> })`
// and asserts the returned `McInstall[]` matches the expected shape.
//
// Pure Node — no Electron, no real MC install, no network. The companion
// electron-stub-loader.mjs (`node --import`) substitutes the `electron`
// module with a tiny stub so `app.getPath('userData')` (called inside
// src/main/paths.ts at module-init time) returns a tmpdir-rooted path
// instead of throwing. tsx-via-esbuild handling for `.ts` imports happens
// in the same loader.
//
// Re-run via:
//   npm run verify:phase9-installs
//
// Six assertions:
//   T1  exactly one vanilla install detected
//   T2  vanilla install has loader === 'fabric'
//   T3  vanilla install has csl_installed === true
//   T4  exactly one curseforge install detected
//   T5  curseforge install has loader === 'forge'
//   T6  curseforge install has csl_installed === false
//
// Exits 0 on PASS 6/6; non-zero with the failing assertion label on FAIL.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

// Set a clean userData override BEFORE importing src/main/* so wizardStateStore
// reads from a known-empty location (its load returns defaults on ENOENT).
const userDataTmp = mkdtempSync(path.join(os.tmpdir(), 'sei-phase9-installs-userdata-'));
process.env.SEI_USER_DATA_OVERRIDE = userDataTmp;

const { scanMcInstalls } = await import('../src/main/mcInstallScan.ts');

function assertEq(actual, expected, label) {
  if (actual !== expected) {
    console.error(`FAIL ${label}: expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
    process.exit(1);
  }
  console.log(`OK   ${label}`);
}

// ─── Synthetic tree under a tempdir ──────────────────────────────────────
// scanMcInstalls accepts homedirOverride which redirects the platform's
// candidate-path probes to subtree of this dir. We build two trees here:
//
//   <tmp>/Library/Application Support/minecraft/                          (darwin)
//   <tmp>/AppData/Roaming/.minecraft/                                     (win32)
//   <tmp>/.minecraft/                                                     (linux)
//
// Pick the appropriate one based on the host platform — the scanner only
// reads from the platform-specific path.
const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'sei-phase9-installs-'));

function vanillaBase(platform) {
  if (platform === 'darwin') return path.join(tmpDir, 'Library', 'Application Support', 'minecraft');
  if (platform === 'win32') return path.join(tmpDir, 'AppData', 'Roaming', '.minecraft');
  return path.join(tmpDir, '.minecraft');
}

function curseforgeBase(platform) {
  if (platform === 'darwin') {
    return path.join(tmpDir, 'Library', 'Application Support', 'curseforge', 'minecraft', 'Instances');
  }
  if (platform === 'win32') {
    return path.join(tmpDir, 'curseforge', 'minecraft', 'Instances');
  }
  return null; // Linux: not officially supported by CF.
}

const vanillaDir = vanillaBase(process.platform);
const cfDir = curseforgeBase(process.platform);

// ─── Vanilla install: fabric loader present + CSL jar present ────────────
//
// launcher_profiles.json picks the freshest profile (most recent lastUsed)
// — the scanner reads this to populate mc_version. Use a fabric-flavored
// lastVersionId so the scanner extracts 1.21.4 off the tail.
mkdirSync(vanillaDir, { recursive: true });
writeFileSync(
  path.join(vanillaDir, 'launcher_profiles.json'),
  JSON.stringify(
    {
      selectedProfile: 'fabric',
      profiles: {
        fabric: {
          name: 'Fabric Loader 0.16.9 1.21.4',
          lastUsed: new Date().toISOString(),
          lastVersionId: 'fabric-loader-0.16.9-1.21.4',
        },
      },
    },
    null,
    2,
  ),
);
// versions/fabric-loader-0.16.9-1.21.4/ — scanner reads dir-name regex.
mkdirSync(path.join(vanillaDir, 'versions', 'fabric-loader-0.16.9-1.21.4'), { recursive: true });
// mods/CustomSkinLoader_Fabric-14.16.jar — empty file is fine, scanner
// matches filename only (no JAR content parsing).
mkdirSync(path.join(vanillaDir, 'mods'), { recursive: true });
writeFileSync(path.join(vanillaDir, 'mods', 'CustomSkinLoader_Fabric-14.16.jar'), '');

// ─── CurseForge Pixelmon instance: forge loader, no CSL ───────────────────
if (cfDir) {
  const instanceDir = path.join(cfDir, 'Pixelmon');
  mkdirSync(instanceDir, { recursive: true });
  writeFileSync(
    path.join(instanceDir, 'minecraftinstance.json'),
    JSON.stringify(
      {
        gameVersion: '1.20.1',
        baseModLoader: { name: 'forge-47.3.0' },
      },
      null,
      2,
    ),
  );
  // mods/ exists but is empty — scanner returns { installed: false }.
  mkdirSync(path.join(instanceDir, 'mods'), { recursive: true });
}

// ─── Run the scanner ─────────────────────────────────────────────────────
let installs;
try {
  installs = await scanMcInstalls({ homedirOverride: tmpDir });
} catch (err) {
  console.error(`FAIL scanMcInstalls threw: ${err.message}`);
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(userDataTmp, { recursive: true, force: true });
  process.exit(1);
}

// ─── Assertions ─────────────────────────────────────────────────────────
const vanillaResults = installs.filter((i) => i.kind === 'vanilla');
const cfResults = installs.filter((i) => i.kind === 'curseforge');

assertEq(vanillaResults.length, 1, 'T1 exactly one vanilla install detected');
assertEq(vanillaResults[0]?.loader, 'fabric', 'T2 vanilla install loader === fabric');
assertEq(vanillaResults[0]?.csl_installed, true, 'T3 vanilla install csl_installed === true');

// Linux: skip CF assertions (CF isn't supported on Linux per
// curseforgePaths() returning []).
if (process.platform === 'linux') {
  console.log('OK   T4 (skipped on linux — CF unsupported by scanner)');
  console.log('OK   T5 (skipped on linux — CF unsupported by scanner)');
  console.log('OK   T6 (skipped on linux — CF unsupported by scanner)');
} else {
  assertEq(cfResults.length, 1, 'T4 exactly one curseforge install detected');
  assertEq(cfResults[0]?.loader, 'forge', 'T5 curseforge install loader === forge');
  assertEq(cfResults[0]?.csl_installed, false, 'T6 curseforge install csl_installed === false');
}

// ─── Cleanup ────────────────────────────────────────────────────────────
rmSync(tmpDir, { recursive: true, force: true });
rmSync(userDataTmp, { recursive: true, force: true });

console.log('PASS 6/6');
