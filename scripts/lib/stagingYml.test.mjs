import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  carryStaging,
  lineDiff,
  PAUSE_PERCENT,
  readStaging,
  readVersion,
  setStaging,
  targetPercent,
} from './stagingYml.mjs';

const require = createRequire(import.meta.url);
// The parser and the staging check the shipped clients run (electron-updater
// 6.8.3), js-yaml resolved from electron-updater itself so it is its copy.
const { AppUpdater } = require('electron-updater/out/AppUpdater.js');
const yaml = createRequire(require.resolve('electron-updater/out/AppUpdater.js'))('js-yaml');

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'set-staging.mjs');

// v0.6.11's real latest-mac.yml and latest.yml, byte for byte.
const MAC = `version: 0.6.11
files:
  - url: Sei-mac-x64.zip
    sha512: qVMBw4B57+autcbFeJKCeD8lDCTeROkxN2iQNTVro0T76DcQu0gpgoQpKZEn3XL2T2tLi/m8Ba+RiyG3z73qbA==
    size: 263140080
  - url: Sei-mac-arm64.zip
    sha512: rk6q3rlH/s0IhMCYcM6ijB4XO1mu3rKWmSxSOCpbMsqlHRAfzOWGTDdMpgNY6NozeLbEfsmGLqbX4lCyXWx2fg==
    size: 255013556
  - url: Sei-mac-x64.dmg
    sha512: 2maHEztWzcuelQKGS/icKFUfEiwq6n1xFcbZo9F+2YJFKUBb5wePsVxgGyMPD7LumGSFu+3VwHWatQXUSsT17g==
    size: 268449463
  - url: Sei-mac-arm64.dmg
    sha512: 9ekyd2BBO2r3jQm/55/0dapWDMfFiaTUzVyJuSBtoRNqBbOKPivPb2f5ttwTSheZ8xreqJpyiuOPjZVuhfyZUw==
    size: 260272050
path: Sei-mac-x64.zip
sha512: qVMBw4B57+autcbFeJKCeD8lDCTeROkxN2iQNTVro0T76DcQu0gpgoQpKZEn3XL2T2tLi/m8Ba+RiyG3z73qbA==
releaseDate: '2026-10-30T22:44:12.791Z'
`;
const WIN = `version: 0.6.11
files:
  - url: Sei-win-x64.exe
    sha512: vIkODOq39h9yFJMtWhi4aal/b77hO2qFlYEUe8bxdlNTpTyv0pSWRCAqC/RNROhZe3TK+Aqf+crp7Ol9HTSGNQ==
    size: 225992840
path: Sei-win-x64.exe
sha512: vIkODOq39h9yFJMtWhi4aal/b77hO2qFlYEUe8bxdlNTpTyv0pSWRCAqC/RNROhZe3TK+Aqf+crp7Ol9HTSGNQ==
releaseDate: '2026-10-30T22:35:01.228Z'
`;

const crlf = (s) => s.replace(/\n/g, '\r\n');
const withoutStaging = (o) => {
  const { stagingPercentage, ...rest } = o;
  return rest;
};

describe('setStaging', () => {
  it('adds the field at the end and keeps every other byte', () => {
    const out = setStaging(MAC, 20);
    expect(out).toBe(`${MAC}stagingPercentage: 20\n`);
    expect(readStaging(out)).toBe(20);
    const parsed = yaml.load(out);
    expect(parsed.stagingPercentage).toBe(20);
    expect(withoutStaging(parsed)).toEqual(yaml.load(MAC));
  });

  it('changes an existing field in place', () => {
    const at20 = setStaging(WIN, 20);
    const at50 = setStaging(at20, 50);
    expect(at50).toBe(`${WIN}stagingPercentage: 50\n`);
    // A field electron-builder wrote mid-file stays where it is.
    const mid = WIN.replace("releaseDate:", 'stagingPercentage: 10\nreleaseDate:');
    const changed = setStaging(mid, 50);
    expect(changed).toBe(WIN.replace("releaseDate:", 'stagingPercentage: 50\nreleaseDate:'));
  });

  it('removes the field, returning the original bytes', () => {
    expect(setStaging(setStaging(MAC, 20), null)).toBe(MAC);
    const mid = WIN.replace("releaseDate:", 'stagingPercentage: 10\nreleaseDate:');
    expect(setStaging(mid, null)).toBe(WIN);
    // Removing an absent field is a no-op.
    expect(setStaging(WIN, null)).toBe(WIN);
  });

  it('preserves sha512 and the files list', () => {
    for (const src of [MAC, WIN]) {
      for (const p of [0, 1, 20, 50, null]) {
        const before = yaml.load(src);
        const after = yaml.load(setStaging(src, p));
        expect(after.sha512).toBe(before.sha512);
        expect(after.files).toEqual(before.files);
        expect(after.path).toBe(before.path);
        expect(after.version).toBe(before.version);
        expect(after.releaseDate).toBe(before.releaseDate);
        const shaLines = (t) => t.split(/\r?\n/).filter((l) => l.includes('sha512:'));
        expect(shaLines(setStaging(src, p))).toEqual(shaLines(src));
      }
    }
  });

  it('is CRLF-safe: keeps CRLF files CRLF and LF files LF', () => {
    const src = crlf(MAC);
    const out = setStaging(src, 20);
    expect(out).toBe(`${src}stagingPercentage: 20\r\n`);
    expect(out.replace(/\r\n/g, '')).not.toContain('\n');
    expect(setStaging(out, 50)).toBe(`${src}stagingPercentage: 50\r\n`);
    expect(setStaging(out, null)).toBe(src);
    expect(yaml.load(out).stagingPercentage).toBe(20);
    const lf = setStaging(MAC, 20);
    expect(lf).not.toContain('\r');
  });

  it('handles a file without a final newline', () => {
    const noNl = WIN.slice(0, -1);
    const out = setStaging(noNl, 30);
    expect(out).toBe(`${noNl}\nstagingPercentage: 30`);
    expect(setStaging(out, null)).toBe(`${noNl}\n`);
    expect(yaml.load(out).stagingPercentage).toBe(30);
  });

  it('only touches the top-level key', () => {
    const nested = WIN.replace('    size: 225992840\n', '    size: 225992840\n    stagingPercentage: 5\n');
    const out = setStaging(nested, 20);
    expect(out).toContain('    stagingPercentage: 5\n');
    expect(readStaging(out)).toBe(20);
  });

  it('refuses bad percents and non-feeds', () => {
    for (const bad of [-1, 101, 20.5, NaN, '20']) expect(() => setStaging(WIN, bad)).toThrow(/integer 0-100/);
    expect(() => setStaging('hello: world\n', 20)).toThrow(/not an electron-updater feed/);
    expect(() => setStaging(`${WIN}stagingPercentage: 1\nstagingPercentage: 2\n`, 20)).toThrow(/more than one/);
  });
});

describe('targetPercent', () => {
  it('maps the actions', () => {
    expect(targetPercent('set', 20)).toBe(20);
    expect(targetPercent('set', 0)).toBe(0);
    expect(targetPercent('set', 100)).toBeNull();
    expect(targetPercent('pause')).toBe(PAUSE_PERCENT);
    expect(targetPercent('pause', 70)).toBe(0);
    expect(targetPercent('promote')).toBeNull();
    expect(() => targetPercent('set')).toThrow(/integer 0-100/);
    expect(() => targetPercent('rollback', 1)).toThrow(/set, pause or promote/);
  });
});

describe('electron-updater 6.8.3 reads the rewrite as intended', () => {
  // 64 fake devices spread over the bucket range (the last 4 bytes of the
  // .updaterId UUID are the bucket).
  const devices = Array.from({ length: 64 }, (_, i) => {
    const tail = Math.floor(((i + 0.5) / 64) * 0xffffffff).toString(16).padStart(8, '0');
    return `12345678-1234-4234-8234-1234${tail}`;
  });
  const offered = async (text) => {
    const info = yaml.load(text);
    let n = 0;
    for (const id of devices) {
      const self = { stagingUserIdPromise: { value: Promise.resolve(id) }, _logger: { info() {}, warn() {} } };
      if (await AppUpdater.prototype.isStagingMatch.call(self, info)) n++;
    }
    return n;
  };

  it('pause (0) offers the update to nobody, promote to everyone', async () => {
    expect(await offered(setStaging(WIN, targetPercent('pause')))).toBe(0);
    expect(await offered(setStaging(WIN, targetPercent('promote')))).toBe(64);
    expect(await offered(WIN)).toBe(64);
  });

  it('a percent offers it to that share of devices', async () => {
    expect(await offered(setStaging(WIN, 25))).toBe(16);
    expect(await offered(setStaging(crlf(MAC), 50))).toBe(32);
  });
});

describe('carryStaging (mirror-release.yml)', () => {
  it('keeps the incoming value when it has one', () => {
    expect(carryStaging(setStaging(WIN, 50), setStaging(WIN, 20))).toEqual({ percent: 50, carried: false });
  });
  it('carries the mirror value for the same version', () => {
    expect(carryStaging(WIN, setStaging(WIN, 20))).toEqual({ percent: 20, carried: true });
    expect(carryStaging(WIN, setStaging(WIN, 0))).toEqual({ percent: 0, carried: true });
  });
  it('never carries across versions or from junk', () => {
    const older = setStaging(WIN.replace('version: 0.6.11', 'version: 0.6.10'), 20);
    expect(carryStaging(WIN, older)).toEqual({ percent: null, carried: false });
    expect(carryStaging(WIN, '')).toEqual({ percent: null, carried: false });
    expect(carryStaging(WIN, '<html>404</html>')).toEqual({ percent: null, carried: false });
    expect(carryStaging(WIN, WIN)).toEqual({ percent: null, carried: false });
    expect(carryStaging(WIN, `${WIN}stagingPercentage: abc\n`)).toEqual({ percent: null, carried: false });
  });
});

describe('readers', () => {
  it('reads version and staging', () => {
    expect(readVersion(MAC)).toBe('0.6.11');
    expect(readVersion("version: '0.6.12'\nfiles:\n")).toBe('0.6.12');
    expect(readStaging(MAC)).toBeNull();
    expect(readStaging(`${MAC}stagingPercentage: 7\n`)).toBe(7);
    expect(readStaging(`${MAC}stagingPercentage: abc\n`)).toBe('abc');
  });
  it('lineDiff shows only the field', () => {
    const d = lineDiff(WIN, setStaging(WIN, 20)).split('\n');
    expect(d.filter((l) => l.startsWith('+ ') || l.startsWith('- '))).toEqual(['+ stagingPercentage: 20']);
  });
});

describe('set-staging.mjs CLI', () => {
  const dirs = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
  });
  const tmp = () => {
    const d = mkdtempSync(path.join(tmpdir(), 'staging-'));
    dirs.push(d);
    return d;
  };
  const run = (...args) => execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const runFail = (...args) => {
    try {
      run(...args);
    } catch (err) {
      return String(err.stderr);
    }
    throw new Error('expected a failure');
  };

  it('sets, pauses and promotes files in place', () => {
    const d = tmp();
    const mac = path.join(d, 'latest-mac.yml');
    const win = path.join(d, 'latest.yml');
    writeFileSync(mac, MAC);
    writeFileSync(win, crlf(WIN));
    const out = run('--action', 'set', '--percent', '20', '--expect-version', '0.6.11', mac, win);
    expect(out).toContain('latest-mac.yml (0.6.11): stagingPercentage absent (everyone) -> 20%');
    expect(readFileSync(mac, 'utf8')).toBe(`${MAC}stagingPercentage: 20\n`);
    expect(readFileSync(win, 'utf8')).toBe(`${crlf(WIN)}stagingPercentage: 20\r\n`);
    expect(run('--action', 'pause', mac)).toContain('20% -> 0 (paused: nobody)');
    expect(readStaging(readFileSync(mac, 'utf8'))).toBe(0);
    run('--action', 'promote', mac, win);
    expect(readFileSync(mac, 'utf8')).toBe(MAC);
    expect(readFileSync(win, 'utf8')).toBe(crlf(WIN));
  });

  it('dry run writes nothing', () => {
    const d = tmp();
    const win = path.join(d, 'latest.yml');
    writeFileSync(win, WIN);
    const out = run('--action', 'set', '--percent', '20', '--dry-run', win);
    expect(out).toContain('+ stagingPercentage: 20');
    expect(out).toContain('DRY RUN');
    expect(readFileSync(win, 'utf8')).toBe(WIN);
  });

  it('refuses or skips another version', () => {
    const d = tmp();
    const win = path.join(d, 'latest.yml');
    writeFileSync(win, WIN);
    expect(runFail('--action', 'pause', '--expect-version', '0.6.12', win)).toMatch(/serves 0.6.11, not 0.6.12/);
    expect(run('--action', 'pause', '--expect-version', '0.6.12', '--skip-other-version', win)).toContain('SKIPPED');
    expect(readFileSync(win, 'utf8')).toBe(WIN);
  });

  it('carries the mirror value over', () => {
    const d = tmp();
    const incoming = path.join(d, 'latest.yml');
    const existing = path.join(d, 'existing.yml');
    writeFileSync(incoming, WIN);
    writeFileSync(existing, setStaging(WIN, 20));
    expect(run('--carry-from', existing, incoming)).toContain("kept the mirror's stagingPercentage 20%");
    expect(readFileSync(incoming, 'utf8')).toBe(`${WIN}stagingPercentage: 20\n`);
    // A missing mirror copy leaves the incoming file alone.
    writeFileSync(incoming, WIN);
    expect(run('--carry-from', path.join(d, 'nope.yml'), incoming)).toContain('as released');
    expect(readFileSync(incoming, 'utf8')).toBe(WIN);
  });

  it('rejects bad input', () => {
    const d = tmp();
    const win = path.join(d, 'latest.yml');
    writeFileSync(win, WIN);
    expect(runFail('--action', 'set', win)).toMatch(/integer 0-100/);
    expect(runFail('--action', 'set', '--percent', '150', win)).toMatch(/integer 0-100/);
    expect(runFail('--action', 'set', '--percent', '20')).toMatch(/no feed files/);
    expect(runFail('--action', 'nuke', win)).toMatch(/set, pause or promote/);
  });
});
