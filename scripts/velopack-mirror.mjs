#!/usr/bin/env node
// Mirror a release's Velopack assets into a feed (scripts/lib/velopackMirror.mjs).
//
//   node scripts/velopack-mirror.mjs --assets <dir> --tag v0.7.0 --store <store>
//        [--endpoint https://<account>.r2.cloudflarestorage.com] [--dry-run]
//
// <store> is dir:<path> or s3://<bucket>/<prefix>. --dry-run reads the live
// index and logs every write instead of making it.
import { mirrorRelease } from './lib/velopackMirror.mjs';
import { openStore, parseArgs } from './lib/velopackStore.mjs';

const args = parseArgs(process.argv.slice(2), ['dry-run']);
for (const k of ['assets', 'tag', 'store']) if (!args[k]) throw new Error(`--${k} is required`);
const store = openStore(args.store, { endpoint: args.endpoint, dryRun: !!args['dry-run'] });
const summary = await mirrorRelease({ assetsDir: args.assets, tag: args.tag, store });
console.log(JSON.stringify(summary, null, 2));
