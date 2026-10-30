// Runs Authenticode cases through the app's own check (261031): the same
// PowerShell (AUTHENTICODE_SCRIPT), the same runner (runPowerShell: Windows
// PowerShell 5.1, -EncodedCommand, inputs in the environment) and the same
// verdict as src/main/velopackVerify.ts checkSigned. Cases come from
// authenticode.ps1:
//   { name, files?, package?, publisher, ok, reason?, rows?, env? }
// reason is a regex the rejection reason must match; rows is how many entries
// the package must have contributed.
//   node --experimental-strip-types scripts/velopack-ci/authenticode-check.mjs <cases.json>
import { readFileSync } from 'node:fs';
import {
  AUTHENTICODE_SCRIPT,
  authenticodeEnv,
  parseSignatureRows,
  signatureVerdict,
} from '../../src/main/velopackSignature.ts';
import { runPowerShell } from '../../src/main/winPowerShell.ts';

const raw = readFileSync(process.argv[2], 'utf8').replace(/^﻿/, '');
const cases = [].concat(JSON.parse(raw));
let failed = 0;
for (const c of cases) {
  const files = c.files == null ? [] : [].concat(c.files);
  const env = { ...authenticodeEnv(files, c.package || undefined), ...(c.env ?? {}) };
  const t0 = Date.now();
  const out = await runPowerShell(AUTHENTICODE_SCRIPT, 180_000, env);
  let rows = [];
  let verdict;
  try {
    rows = parseSignatureRows(out);
    verdict = signatureVerdict(rows, c.publisher, { files: files.length, package: !!c.package });
  } catch (err) {
    verdict = { ok: false, reason: err.message };
  }
  const problems = [];
  if (verdict.ok !== c.ok) problems.push(`expected ${c.ok ? 'accept' : 'reject'}`);
  if (!verdict.ok && c.reason && !new RegExp(c.reason).test(verdict.reason)) problems.push(`reason should match /${c.reason}/`);
  const pkgRows = rows.filter((r) => !/^file\d+$/.test(r.name)).length;
  if (c.rows != null && pkgRows !== c.rows) problems.push(`expected ${c.rows} package entries, got ${pkgRows}`);
  const result = verdict.ok ? 'accepted' : `rejected (${verdict.reason})`;
  console.log(`${problems.length ? 'FAIL' : 'ok  '} ${c.name}: ${result} in ${Date.now() - t0} ms`);
  for (const r of rows) console.log(`       ${r.name} ${r.status} ${r.subject}`);
  if (problems.length) {
    failed++;
    console.log(`::error::authenticode case "${c.name}": ${problems.join('; ')}; got ${result}`);
  }
}
console.log(`${cases.length - failed}/${cases.length} cases as expected`);
process.exit(failed ? 1 : 0);
