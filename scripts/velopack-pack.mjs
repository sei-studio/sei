#!/usr/bin/env node
// Pack a built Windows app (release/win-unpacked) as Velopack releases (261030).
// Used by release.yml and velopack-update.yml on a windows runner, after
// electron-builder and with `vpk` on PATH (.github/actions/velopack-tools puts
// Sei's patched Update.exe into vpk's vendor folder first).
//
//   node scripts/velopack-pack.mjs --version 0.7.0 --app release/win-unpacked --out <dir>
//        [--tag v0.7.0] [--prev-feed https://dl.sei.gg/velopack | dir:<path>]
//        [--channels win,beta] [--vpk vpk]
//
// For each channel (scripts/lib/velopackFeed.mjs channelsForRelease) it:
//   1. fetches the newest earlier Full package from the previous feed, so vpk
//      builds a delta against it;
//   2. runs vpk pack (signed through Azure Trusted Signing when every AZURE_*
//      variable is set, unsigned otherwise);
//   3. leaves in <out>/upload: this version's packages, the Setup, the channel's
//      releases.<channel>.json trimmed to this version (a GitHub release carries
//      its own version only; Velopack's GithubSource merges releases) and
//      setup.<channel>.json for the NSIS -> Velopack migration.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  CHANNELS,
  channelsForRelease,
  emptyReleases,
  isValidVersion,
  maxVersion,
  onlyVersion,
  parseReleases,
  previousFull,
} from './lib/velopackFeed.mjs';
import { getJson, openStore, parseArgs } from './lib/velopackStore.mjs';

const AZURE_VARS = [
  'AZURE_TENANT_ID',
  'AZURE_CLIENT_ID',
  'AZURE_CLIENT_SECRET',
  'AZURE_ENDPOINT',
  'AZURE_CODE_SIGNING_ACCOUNT',
  'AZURE_CERT_PROFILE',
];
/**
 * Files vpk would otherwise sign one by one. The app has a few hundred native
 * DLL/.node files under node_modules; signing every one is a signature each,
 * per channel, per release. electron-builder already signed Sei.exe, and vpk
 * signs Update.exe and the Setup itself.
 */
const SIGN_EXCLUDE = '(?i)\\.(dll|node)$';

const args = parseArgs(process.argv.slice(2));
const version = args.version;
if (!isValidVersion(version)) throw new Error(`--version must be a semver version, got ${version}`);
const tag = args.tag ?? `v${version}`;
const app = path.resolve(args.app ?? 'release/win-unpacked');
const out = path.resolve(args.out ?? 'velopack-out');
const vpk = args.vpk ?? 'vpk';
if (!existsSync(path.join(app, 'Sei.exe'))) throw new Error(`${app} has no Sei.exe`);

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const sha256File = (f) => sha256(readFileSync(f));

function run(cmd, argv, { log } = {}) {
  console.log(`> ${cmd} ${argv.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
  const r = spawnSync(cmd, argv, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 45 * 60 * 1000 });
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (log) writeFileSync(log, text);
  if (r.status !== 0) {
    console.log(text.split('\n').slice(-80).join('\n'));
    throw new Error(`${cmd} exited ${r.status ?? r.signal ?? r.error}`);
  }
  return text;
}

// ---------------------------------------------------------------- signing
const azureSet = AZURE_VARS.filter((k) => process.env[k]);
let signArgs = [];
if (azureSet.length > 0 && azureSet.length < AZURE_VARS.length) {
  throw new Error(`partial Azure Trusted Signing config (${azureSet.join(', ')} set); set all of ${AZURE_VARS.join(', ')} or none`);
}
const signing = azureSet.length === AZURE_VARS.length;
mkdirSync(out, { recursive: true });
if (signing) {
  const help = run(vpk, ['--skip-updates', 'pack', '-H']);
  if (!/--signExclude\b/.test(help)) {
    throw new Error('this vpk has no --signExclude: refusing to sign every DLL in the app (one signature each)');
  }
  const meta = path.join(out, 'azure-signing.json');
  writeFileSync(
    meta,
    JSON.stringify({
      Endpoint: process.env.AZURE_ENDPOINT,
      CodeSigningAccountName: process.env.AZURE_CODE_SIGNING_ACCOUNT,
      CertificateProfileName: process.env.AZURE_CERT_PROFILE,
    }),
  );
  signArgs = ['--azureTrustedSignFile', meta, '--signExclude', SIGN_EXCLUDE];
  console.log('signing: Azure Trusted Signing (DLL and .node files excluded)');
} else {
  console.log('signing: not configured, packing UNSIGNED');
}
{
  const exes = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.exe$/i.test(e.name)) exes.push(path.relative(app, p));
    }
  };
  walk(app);
  console.log(`app: ${exes.length} .exe file(s) vpk may sign per channel: ${exes.join(', ')}`);
}

// ---------------------------------------------------------------- channels
const prev = args['prev-feed'] ? openStore(args['prev-feed']) : null;
async function prevReleases(ch) {
  if (!prev) return emptyReleases();
  const j = await getJson(prev, `releases.${ch}.json`);
  return j ? parseReleases(j) : emptyReleases();
}
const channels = args.channels
  ? args.channels.split(',').map((c) => c.trim()).filter(Boolean)
  : channelsForRelease(version, maxVersion(await prevReleases('beta')));
for (const ch of channels) if (!CHANNELS.includes(ch)) throw new Error(`unknown channel ${ch}`);
console.log(`${version} -> channels ${channels.join(', ')}`);

const upload = path.join(out, 'upload');
mkdirSync(upload, { recursive: true });
const summary = [];

for (const ch of channels) {
  const work = path.join(out, `work-${ch}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  // 1. the delta base
  const before = await prevReleases(ch);
  if (before.Assets.some((a) => a.Version === version)) {
    throw new Error(`${version} is already in the ${ch} feed of ${prev.describe}; a published version is never repacked`);
  }
  const base = previousFull(before, version);
  if (base) {
    const buf = await prev.get(base.FileName);
    if (!buf) throw new Error(`${prev.describe} lists ${base.FileName} but does not serve it`);
    if (base.SHA256 && sha256(buf).toLowerCase() !== String(base.SHA256).toLowerCase()) throw new Error(`${base.FileName}: sha256 does not match the feed`);
    writeFileSync(path.join(work, base.FileName), buf);
    writeFileSync(path.join(work, `releases.${ch}.json`), JSON.stringify({ ...before, Assets: [base] }));
    console.log(`${ch}: delta base ${base.Version} (${(buf.length / 1048576).toFixed(1)} MB)`);
  } else {
    console.log(`${ch}: no earlier Full package in the feed, packing without a delta`);
  }

  // 2. vpk
  const t0 = Date.now();
  run(
    vpk,
    [
      '--skip-updates', 'pack',
      '-u', 'Sei', '-v', version, '-p', app, '-e', 'Sei.exe',
      '--runtime', 'win-x64', '--packTitle', 'Sei', '--packAuthors', 'Sei',
      '--channel', ch, '--noPortable',
      '--icon', 'build/installerHeaderIcon.ico', '--aumid', 'com.sei.app',
      '--skipVeloAppCheck',
      ...signArgs,
      '-o', work,
    ],
    { log: path.join(out, `vpk-${ch}.log`) },
  );
  const packS = Math.round((Date.now() - t0) / 1000);

  // 3. collect
  const after = onlyVersion(parseReleases(readFileSync(path.join(work, `releases.${ch}.json`), 'utf8')), version);
  const full = after.Assets.find((a) => a.Type === 'Full');
  if (!full) throw new Error(`vpk wrote no Full package for ${version} on ${ch}`);
  const delta = after.Assets.find((a) => a.Type === 'Delta');
  if (base && !delta) console.log(`::warning::${ch}: a delta base was present but vpk wrote no delta package`);
  for (const a of after.Assets) {
    const f = path.join(work, a.FileName);
    if (existsSync(path.join(upload, a.FileName))) throw new Error(`${a.FileName} collides with another channel's file`);
    copyFileSync(f, path.join(upload, a.FileName));
  }
  writeFileSync(path.join(upload, `releases.${ch}.json`), JSON.stringify(after, null, 2) + '\n');

  const setups = readdirSync(work).filter((n) => /^Sei-[A-Za-z0-9]+-Setup\.exe$/.test(n));
  if (setups.length !== 1) throw new Error(`expected one Setup in ${work}, found ${setups.join(', ') || 'none'}`);
  const setupFile = setups[0];
  copyFileSync(path.join(work, setupFile), path.join(upload, setupFile));
  const setup = {
    version,
    tag,
    file: setupFile,
    sha256: sha256File(path.join(work, setupFile)),
    size: statSync(path.join(work, setupFile)).size,
  };
  writeFileSync(path.join(upload, `setup.${ch}.json`), JSON.stringify(setup, null, 2) + '\n');

  // 4. the package must carry Sei's Update.exe (Velopack copies it over the
  // installed one on every update). vpk rewrites its icon resource, so look for
  // the patch's own flag rather than a hash.
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(readFileSync(path.join(work, full.FileName)));
  const squirrel = Object.keys(zip.files).find((n) => n.toLowerCase().endsWith('squirrel.exe'));
  if (!squirrel) throw new Error(`${full.FileName} has no Squirrel.exe`);
  const exe = await zip.file(squirrel).async('nodebuffer');
  if (!exe.includes(Buffer.from('seiOverlay'))) throw new Error(`${full.FileName}: Update.exe is not Sei's patched build`);

  summary.push({
    channel: ch,
    full: `${full.FileName} ${(full.Size / 1048576).toFixed(1)} MB`,
    delta: delta ? `${delta.FileName} ${(delta.Size / 1048576).toFixed(1)} MB` : null,
    setup: `${setupFile} ${(setup.size / 1048576).toFixed(1)} MB`,
    packSeconds: packS,
  });
}

console.log(JSON.stringify({ version, tag, signed: signing, channels: summary }, null, 2));
console.log(`upload/: ${readdirSync(upload).sort().join(', ')}`);
