import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mirrorRelease, velopackAssetNames } from './velopackMirror.mjs';
import { setRollout } from './velopackRollout.mjs';
import { dirStore, getJson, openStore, parseArgs, s3Store } from './velopackStore.mjs';

const dirs = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});
function tmp() {
  const d = mkdtempSync(path.join(tmpdir(), 'vpmirror-'));
  dirs.push(d);
  return d;
}
const sha = (b) => createHash('sha256').update(b).digest('hex');
const quiet = () => {};

/** A release's assets as velopack-pack.mjs leaves them. */
function release(version, { channels = ['win'], tag = `v${version}`, setup = true } = {}) {
  const d = tmp();
  for (const ch of channels) {
    const suffix = ch === 'win' ? '' : `-${ch}`;
    const fullName = `Sei-${version}${suffix}-full.nupkg`;
    const body = Buffer.from(`full ${version} ${ch}`);
    writeFileSync(path.join(d, fullName), body);
    const assets = [{ Version: version, FileName: fullName, Type: 'Full', Size: body.length, SHA256: sha(body) }];
    writeFileSync(path.join(d, `releases.${ch}.json`), JSON.stringify({ Assets: assets }));
    if (setup) {
      const file = `Sei-${ch}-Setup.exe`;
      const exe = Buffer.from(`setup ${version} ${ch}`);
      writeFileSync(path.join(d, file), exe);
      writeFileSync(path.join(d, `setup.${ch}.json`), JSON.stringify({ version, tag, file, sha256: sha(exe), size: exe.length }));
    }
  }
  writeFileSync(path.join(d, 'Sei-win-x64.exe'), 'nsis');
  writeFileSync(path.join(d, 'latest.yml'), 'version: x');
  return d;
}

describe('mirrorRelease', () => {
  it('uploads packages and the Setup, merges the index and writes the setup manifest', async () => {
    const feed = tmp();
    const store = dirStore(feed, { log: quiet });
    await mirrorRelease({ assetsDir: release('0.7.0', { channels: ['win', 'beta'] }), tag: 'v0.7.0', store, log: quiet });
    await mirrorRelease({ assetsDir: release('0.7.1'), tag: 'v0.7.1', store, log: quiet });
    const win = await getJson(store, 'releases.win.json');
    expect(win.Assets.map((a) => a.Version)).toEqual(['0.7.0', '0.7.1']);
    expect((await getJson(store, 'releases.beta.json')).Assets.map((a) => a.FileName)).toEqual(['Sei-0.7.0-beta-full.nupkg']);
    expect(existsSync(path.join(feed, 'Sei-0.7.1-full.nupkg'))).toBe(true);
    expect(existsSync(path.join(feed, 'setup/v0.7.1/Sei-win-Setup.exe'))).toBe(true);
    expect((await getJson(store, 'setup.win.json')).version).toBe('0.7.1');
    expect((await getJson(store, 'setup.beta.json')).version).toBe('0.7.0');
    expect(existsSync(path.join(feed, 'Sei-win-x64.exe'))).toBe(false);
  });

  it('never moves the setup manifest backwards (an older release mirrored late)', async () => {
    const store = dirStore(tmp(), { log: quiet });
    await mirrorRelease({ assetsDir: release('0.7.1'), tag: 'v0.7.1', store, log: quiet });
    await mirrorRelease({ assetsDir: release('0.7.0'), tag: 'v0.7.0', store, log: quiet });
    expect((await getJson(store, 'setup.win.json')).version).toBe('0.7.1');
    expect((await getJson(store, 'releases.win.json')).Assets).toHaveLength(2);
  });

  it('refuses assets that do not match their index or manifest', async () => {
    const store = dirStore(tmp(), { log: quiet });
    const bad = release('0.7.0');
    writeFileSync(path.join(bad, 'Sei-0.7.0-full.nupkg'), 'tampered!!');
    await expect(mirrorRelease({ assetsDir: bad, tag: 'v0.7.0', store, log: quiet })).rejects.toThrow(/size|sha256/);
    const wrongTag = release('0.7.0');
    await expect(mirrorRelease({ assetsDir: wrongTag, tag: 'v0.7.9', store, log: quiet })).rejects.toThrow(/for v0.7.0/);
    expect(await store.get('releases.win.json')).toBeNull();
  });

  it('is a no-op for a release without Velopack assets, and a dry run writes nothing', async () => {
    const feed = tmp();
    const d = tmp();
    writeFileSync(path.join(d, 'Sei-win-x64.exe'), 'nsis');
    expect((await mirrorRelease({ assetsDir: d, tag: 'v0.6.10', store: dirStore(feed), log: quiet })).channels).toEqual([]);
    const logs = [];
    await mirrorRelease({ assetsDir: release('0.7.0'), tag: 'v0.7.0', store: dirStore(feed, { dryRun: true, log: (m) => logs.push(m) }), log: quiet });
    expect(await dirStore(feed).get('releases.win.json')).toBeNull();
    expect(logs.some((m) => m.includes('[dry-run] would write') && m.includes('releases.win.json'))).toBe(true);
  });

  it('picks the Velopack files out of a release', () => {
    expect(
      velopackAssetNames(['Sei-0.7.0-full.nupkg', 'releases.win.json', 'setup.beta.json', 'Sei-win-Setup.exe', 'Sei-win-x64.exe', 'latest.yml']),
    ).toEqual(['Sei-0.7.0-full.nupkg', 'releases.win.json', 'setup.beta.json', 'Sei-win-Setup.exe']);
  });
});

describe('setRollout', () => {
  it('sets a rollout only for a version in the feed', async () => {
    const store = dirStore(tmp(), { log: quiet });
    await mirrorRelease({ assetsDir: release('0.7.0'), tag: 'v0.7.0', store, log: quiet });
    await expect(setRollout({ store, channel: 'win', kind: 'update', version: '0.7.1', percent: 10, log: quiet })).rejects.toThrow(/not in releases/);
    await setRollout({ store, channel: 'win', kind: 'update', version: '0.7.0', percent: 10, log: quiet });
    expect(await getJson(store, 'rollout.win.json')).toEqual({ version: '0.7.0', percent: 10 });
    await expect(setRollout({ store, channel: 'stable', kind: 'update', version: '0.7.0', percent: 10, log: quiet })).rejects.toThrow(/channel/);
  });

  it('turns the migration on only with a setup manifest, and keeps the epoch', async () => {
    const store = dirStore(tmp(), { log: quiet });
    await setRollout({ store, channel: 'win', kind: 'migration', percent: 0, log: quiet });
    expect(await getJson(store, 'migration.win.json')).toEqual({ percent: 0, epoch: 0 });
    await expect(setRollout({ store, channel: 'win', kind: 'migration', percent: 5, log: quiet })).rejects.toThrow(/no setup/);
    await mirrorRelease({ assetsDir: release('0.7.0'), tag: 'v0.7.0', store, log: quiet });
    await setRollout({ store, channel: 'win', kind: 'migration', percent: 5, epoch: 2, log: quiet });
    await setRollout({ store, channel: 'win', kind: 'migration', percent: 50, log: quiet });
    expect(await getJson(store, 'migration.win.json')).toEqual({ percent: 50, epoch: 2 });
  });
});

describe('stores', () => {
  it('rejects keys that escape the feed', async () => {
    const store = dirStore(tmp());
    await expect(store.get('../x')).rejects.toThrow(/bad store key/);
    await expect(store.get('/etc/passwd')).rejects.toThrow(/bad store key/);
    await expect(store.putJson('a//b', {})).rejects.toThrow(/bad store key/);
  });
  it('refuses an s3 store without a prefix and opens by spec', () => {
    expect(() => s3Store('s3://sei-dl')).toThrow(/prefix/);
    expect(() => s3Store('s3://sei-dl/')).toThrow(/prefix/);
    expect(s3Store('s3://sei-dl/velopack-scratch/').describe).toBe('s3://sei-dl/velopack-scratch');
    expect(openStore('https://dl.sei.gg/velopack/').describe).toBe('https://dl.sei.gg/velopack');
    expect(() => openStore('ftp://x')).toThrow(/unknown store/);
  });
  it('an s3 dry run never calls the CLI to write', async () => {
    const d = tmp();
    const fakeAws = path.join(d, 'aws.sh');
    writeFileSync(fakeAws, `#!/bin/sh\necho "$@" >> ${path.join(d, 'calls')}\necho "An error occurred (404) when calling the HeadObject operation: Not Found" >&2\nexit 1\n`, { mode: 0o755 });
    const logs = [];
    const store = s3Store('s3://sei-dl/velopack', { dryRun: true, aws: fakeAws, log: (m) => logs.push(m) });
    expect(await store.get('releases.win.json')).toBeNull();
    await store.putJson('releases.win.json', { Assets: [] });
    mkdirSync(path.join(d, 'f'));
    writeFileSync(path.join(d, 'f', 'x'), 'x');
    await store.putFile('x', path.join(d, 'f', 'x'));
    const calls = readFileSync(path.join(d, 'calls'), 'utf8').trim().split('\n');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('s3://sei-dl/velopack/releases.win.json -');
    expect(logs).toHaveLength(2);
  });
  it('parses flags', () => {
    expect(parseArgs(['--a', '1', '--dry-run', '--b', 'x'], ['dry-run'])).toEqual({ a: '1', 'dry-run': true, b: 'x' });
    expect(() => parseArgs(['x'])).toThrow(/unexpected/);
    expect(() => parseArgs(['--a'])).toThrow(/needs a value/);
  });
});
