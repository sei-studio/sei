#!/usr/bin/env node
/**
 * Phase 9 master verification harness.
 *
 * Runs all four Phase 9 sub-harnesses in series. Each must exit 0; otherwise
 * this script exits with code 1 and prints which harness(es) failed.
 *
 * Run via:  node scripts/verify-phase9.mjs    (npm run verify:phase9)
 *
 * Sub-harnesses covered:
 *   - Plan 02 — loopback skin HTTP server contract (scripts/verify-skinServer.mjs)
 *   - Plan 03 — Mojang lookup pipeline incl. legacy 64×32 → 64×64 normalization
 *     (scripts/verify-mojangSkinLookup.mjs)
 *   - Plan 05 — cross-platform MC install scanner with temp-dir trees
 *     (scripts/verify-phase9-installs.mjs; uses the Node --import electron-stub hook)
 *   - Plan 05 — CustomSkinLoader config writer; asserts the verified `Legacy`
 *     loader type per Plan 04's upstream-source check (WARNING 6)
 *     (scripts/verify-phase9-csl-config.mjs)
 *
 * Notes:
 *   - tsx is a real devDependency (INFO 9 fix from Plan 03) so `npx tsx ...`
 *     resolves to the local copy with no `--yes` / `--no-save` workaround.
 *   - The install + config harnesses use the self-contained Node `--import`
 *     hook trio from Plan 05 (scripts/lib/electron-stub-loader.mjs) to avoid
 *     the tsx + chained-hook ordering bug on Node 25 / tsx 4.22.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

const HARNESSES = [
  {
    name: 'Plan 02 — skin HTTP server contract',
    cmd: 'node',
    args: ['scripts/verify-skinServer.mjs'],
  },
  {
    name: 'Plan 03 — Mojang lookup (incl. legacy 64x32 → 64x64 normalization)',
    cmd: 'npx',
    args: ['tsx', 'scripts/verify-mojangSkinLookup.mjs'],
  },
  {
    name: 'Plan 05 — MC install scanner (cross-platform temp-dir trees)',
    cmd: 'node',
    args: [
      '--import',
      './scripts/lib/electron-stub-loader.mjs',
      'scripts/verify-phase9-installs.mjs',
    ],
  },
  {
    name: 'Plan 05 — CustomSkinLoader config writer (Legacy loader type)',
    cmd: 'node',
    args: [
      '--import',
      './scripts/lib/electron-stub-loader.mjs',
      'scripts/verify-phase9-csl-config.mjs',
    ],
  },
];

let totalPass = 0;
let totalFail = 0;
const failures = [];

for (const h of HARNESSES) {
  process.stdout.write(`\n=== ${h.name} ===\n`);
  const r = spawnSync(h.cmd, h.args, {
    cwd: repoRoot,
    stdio: 'inherit',
    encoding: 'utf8',
  });
  if (r.status === 0) {
    totalPass++;
  } else {
    totalFail++;
    failures.push(`${h.name} (exit ${r.status})`);
  }
}

console.log(`\n=== Phase 9 verification summary ===`);
console.log(`  PASS: ${totalPass}/${HARNESSES.length}`);
if (totalFail > 0) {
  console.log(`  FAIL: ${totalFail}`);
  for (const f of failures) console.log(`    - ${f}`);
  process.exit(1);
}
console.log(`  Phase 9 verification: PASS`);
process.exit(0);
