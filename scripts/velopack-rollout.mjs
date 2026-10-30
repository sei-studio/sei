#!/usr/bin/env node
// Set a staged rollout or the NSIS -> Velopack migration switch in a feed
// (scripts/lib/velopackRollout.mjs).
//
//   node scripts/velopack-rollout.mjs --store <store> --channel win|beta --kind update --version 0.7.1 --percent 20
//   node scripts/velopack-rollout.mjs --store <store> --channel win|beta --kind migration --percent 10 [--epoch 1]
//        [--endpoint https://<account>.r2.cloudflarestorage.com] [--dry-run]
import { setRollout } from './lib/velopackRollout.mjs';
import { openStore, parseArgs } from './lib/velopackStore.mjs';

const args = parseArgs(process.argv.slice(2), ['dry-run']);
for (const k of ['store', 'channel', 'kind', 'percent']) if (args[k] === undefined) throw new Error(`--${k} is required`);
const store = openStore(args.store, { endpoint: args.endpoint, dryRun: !!args['dry-run'] });
await setRollout({
  store,
  channel: args.channel,
  kind: args.kind,
  version: args.version,
  percent: Number(args.percent),
  epoch: args.epoch === undefined ? undefined : Number(args.epoch),
});
