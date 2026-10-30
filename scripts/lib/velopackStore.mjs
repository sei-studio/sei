// Where a Velopack feed lives, for the release scripts (261030). Dependency-free.
//
//   dir:<path>                    a local folder (CI, tests)
//   s3://<bucket>/<prefix>        an S3-compatible bucket through the aws CLI
//                                 (Cloudflare R2 behind dl.sei.gg; pass --endpoint)
//   https://...                   read-only HTTP (the previous feed for deltas)
//
// A dry run reads for real and writes nothing; every write it skips is logged.

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

function checkKey(key) {
  if (typeof key !== 'string' || !key || key.startsWith('/') || key.split('/').some((p) => p === '..' || p === '')) {
    throw new Error(`bad store key ${key}`);
  }
}

export function dirStore(root, { dryRun = false, log = console.log } = {}) {
  return {
    describe: `dir:${root}`,
    async get(key) {
      checkKey(key);
      const f = path.join(root, key);
      return existsSync(f) ? readFileSync(f) : null;
    },
    async putFile(key, file) {
      checkKey(key);
      if (dryRun) return log(`[dry-run] would copy ${file} -> ${root}/${key}`);
      const f = path.join(root, key);
      mkdirSync(path.dirname(f), { recursive: true });
      copyFileSync(file, f);
    },
    async putJson(key, value) {
      checkKey(key);
      if (dryRun) return log(`[dry-run] would write ${root}/${key}: ${JSON.stringify(value)}`);
      const f = path.join(root, key);
      mkdirSync(path.dirname(f), { recursive: true });
      writeFileSync(f, JSON.stringify(value, null, 2) + '\n');
    },
  };
}

export function httpStore(base) {
  const b = base.replace(/\/+$/, '');
  return {
    describe: b,
    async get(key) {
      checkKey(key);
      const res = await fetch(`${b}/${key}`, { signal: AbortSignal.timeout(10 * 60 * 1000) });
      if (res.status === 404 || res.status === 403) return null;
      if (!res.ok) throw new Error(`GET ${b}/${key}: HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    },
    async putFile() {
      throw new Error('an http feed is read-only');
    },
    async putJson() {
      throw new Error('an http feed is read-only');
    },
  };
}

export function s3Store(url, { endpoint, dryRun = false, log = console.log, aws = 'aws', tmpDir } = {}) {
  const m = /^s3:\/\/([^/]+)\/?(.*)$/.exec(url);
  if (!m) throw new Error(`bad s3 url ${url}`);
  const bucket = m[1];
  const prefix = m[2].replace(/\/+$/, '');
  if (!prefix) throw new Error('refusing an s3 store without a prefix');
  const ep = endpoint ? ['--endpoint-url', endpoint] : [];
  const uri = (key) => `s3://${bucket}/${prefix}/${key}`;
  const run = (args) => spawnSync(aws, [...args, ...ep], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  const tmp = tmpDir ?? path.join(process.env.RUNNER_TEMP ?? process.env.TMPDIR ?? '/tmp', 'velopack-store');
  return {
    describe: `s3://${bucket}/${prefix}`,
    async get(key) {
      checkKey(key);
      const r = run(['s3', 'cp', uri(key), '-', '--only-show-errors']);
      if (r.status === 0) return r.stdout;
      const err = r.stderr.toString();
      if (/\(404\)|Not Found|NoSuchKey|does not exist/i.test(err)) return null;
      throw new Error(`aws s3 cp ${uri(key)}: ${err.trim()}`);
    },
    async putFile(key, file, { cacheControl } = {}) {
      checkKey(key);
      if (dryRun) return log(`[dry-run] would upload ${file} -> ${uri(key)}`);
      const cc = cacheControl ? ['--cache-control', cacheControl] : [];
      const r = run(['s3', 'cp', file, uri(key), '--only-show-errors', ...cc]);
      if (r.status !== 0) throw new Error(`upload ${uri(key)}: ${r.stderr.toString().trim()}`);
    },
    async putJson(key, value, { cacheControl } = {}) {
      checkKey(key);
      if (dryRun) return log(`[dry-run] would write ${uri(key)}: ${JSON.stringify(value)}`);
      mkdirSync(tmp, { recursive: true });
      const f = path.join(tmp, key.replace(/\//g, '_'));
      writeFileSync(f, JSON.stringify(value, null, 2) + '\n');
      const cc = cacheControl ? ['--cache-control', cacheControl] : [];
      const r = run(['s3', 'cp', f, uri(key), '--only-show-errors', '--content-type', 'application/json', ...cc]);
      if (r.status !== 0) throw new Error(`upload ${uri(key)}: ${r.stderr.toString().trim()}`);
    },
  };
}

export function openStore(spec, opts = {}) {
  if (spec.startsWith('dir:')) return dirStore(path.resolve(spec.slice(4)), opts);
  if (spec.startsWith('s3://')) return s3Store(spec, opts);
  if (/^https?:\/\//.test(spec)) return httpStore(spec);
  throw new Error(`unknown store ${spec} (use dir:<path>, s3://<bucket>/<prefix> or an https url)`);
}

/** Minimal --flag value / --flag parser. */
export function parseArgs(argv, booleans = []) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    const k = a.slice(2);
    if (booleans.includes(k)) out[k] = true;
    else {
      const v = argv[++i];
      if (v === undefined) throw new Error(`--${k} needs a value`);
      out[k] = v;
    }
  }
  return out;
}

export async function getJson(store, key) {
  const buf = await store.get(key);
  return buf ? JSON.parse(buf.toString('utf8')) : null;
}
