#!/usr/bin/env node
// Rewrite stagingPercentage in electron-updater feed ymls in place
// (scripts/lib/stagingYml.mjs). Used by .github/workflows/rollout.yml and
// mirror-release.yml; dependency-free so the workflows need no npm ci.
//
//   node scripts/set-staging.mjs --action set --percent 20 latest.yml latest-mac.yml
//   node scripts/set-staging.mjs --action pause   latest.yml   # 0 = nobody
//   node scripts/set-staging.mjs --action promote latest.yml   # field removed = everyone
//        [--expect-version 0.6.12]  refuse a file of any other version
//        [--skip-other-version]     ...or leave it untouched and say so
//        [--dry-run]                print the change, write nothing
//
//   node scripts/set-staging.mjs --carry-from <mirror copy> <incoming yml>
//        mirror-release.yml: keep the mirror's value for the same version when
//        the incoming yml has none (stagingYml.mjs carryStaging).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import {
  assertFeed,
  carryStaging,
  describeStaging,
  lineDiff,
  readStaging,
  readVersion,
  setStaging,
  targetPercent,
} from './lib/stagingYml.mjs';

function parse(argv) {
  const opts = { files: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run' || a === '--skip-other-version') opts[a.slice(2)] = true;
    else if (a === '--action' || a === '--percent' || a === '--expect-version' || a === '--carry-from') {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      opts[a.slice(2)] = argv[++i];
    } else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else opts.files.push(a);
  }
  return opts;
}

function carry(opts) {
  if (opts.files.length !== 1) throw new Error('--carry-from takes exactly one incoming file');
  const file = opts.files[0];
  const incoming = readFileSync(file, 'utf8');
  assertFeed(incoming, file);
  const existing = existsSync(opts['carry-from']) ? readFileSync(opts['carry-from'], 'utf8') : '';
  const { percent, carried } = carryStaging(incoming, existing);
  if (!carried) {
    console.log(`${path.basename(file)}: stagingPercentage ${describeStaging(readStaging(incoming))} (as released)`);
    return;
  }
  writeFileSync(file, setStaging(incoming, percent, file));
  console.log(
    `${path.basename(file)}: kept the mirror's stagingPercentage ${describeStaging(percent)} for ${readVersion(incoming)} ` +
      '(the release asset has none; run rollout.yml action=promote to open it fully)',
  );
}

function rollout(opts) {
  if (!opts.files.length) throw new Error('no feed files given');
  const percent = opts.percent === undefined || opts.percent === '' ? undefined : Number(opts.percent);
  const target = targetPercent(opts.action, percent);
  let changed = 0;
  for (const file of opts.files) {
    const name = path.basename(file);
    const before = readFileSync(file, 'utf8');
    assertFeed(before, name);
    const version = readVersion(before);
    if (opts['expect-version'] && version !== opts['expect-version']) {
      if (opts['skip-other-version']) {
        console.log(`${name}: SKIPPED, it serves ${version}, not ${opts['expect-version']} (left as is)`);
        continue;
      }
      throw new Error(`${name} serves ${version}, not ${opts['expect-version']}`);
    }
    const after = setStaging(before, target, name);
    console.log(
      `${name} (${version}): stagingPercentage ${describeStaging(readStaging(before))} -> ${describeStaging(readStaging(after))}`,
    );
    if (after === before) {
      console.log('  unchanged');
      continue;
    }
    changed++;
    console.log(lineDiff(before, after).replace(/^/gm, '  '));
    if (!opts['dry-run']) writeFileSync(file, after);
  }
  console.log(opts['dry-run'] ? `DRY RUN: ${changed} file(s) would change, nothing written` : `${changed} file(s) changed`);
}

try {
  const opts = parse(process.argv.slice(2));
  if (opts['carry-from'] !== undefined) carry(opts);
  else rollout(opts);
} catch (err) {
  console.error(`set-staging: ${err.message}`);
  process.exit(1);
}
