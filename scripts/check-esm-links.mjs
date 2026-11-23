#!/usr/bin/env node
// Fails when code that runs unbundled under plain Node ESM in the packaged app
// (src/bot/**, vendored file: deps) has an import Node would reject at link
// time. See scripts/lib/esmLinkCheck.mjs for what is checked and why.
//
//   node scripts/check-esm-links.mjs            # check this checkout
//   node scripts/check-esm-links.mjs --root DIR # check another tree
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkEsmLinks } from './lib/esmLinkCheck.mjs';

const args = process.argv.slice(2);
const rootIdx = args.indexOf('--root');
const root = rootIdx >= 0 ? path.resolve(args[rootIdx + 1]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const started = performance.now();
const { errors, stats } = checkEsmLinks({ root });
const ms = Math.round(performance.now() - started);

if (errors.length) {
  console.error(`ESM link check FAILED (${errors.length} problem${errors.length === 1 ? '' : 's'}):`);
  for (const e of errors) console.error('  ' + e);
  console.error('\nThese files run as plain Node ESM in the packaged app; a broken import kills the process at load.');
  process.exit(1);
}
console.log(
  `ESM link check OK: ${stats.files} files, ${stats.imports} import statements, ${stats.modules} modules parsed, ` +
    `${stats.cjsUnchecked} CommonJS named imports not checked, ${ms} ms`,
);
