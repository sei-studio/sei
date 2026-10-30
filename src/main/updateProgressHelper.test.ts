import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CURVE_CAP,
  DEFAULT_INSTALL_SECONDS,
  DOWNLOAD_DONE_SHARE,
  OPENING_FILL_SEC,
  HELPER_COPY,
  HELPER_FILES,
  buildHelperConfig,
  buildPlan,
  estimateInstallSeconds,
  launchUpdateProgressHelper,
  powershellArgs,
  powershellPath,
  processNameOf,
  progressAt,
  resolveHelperLang,
  resolveHelperTheme,
  statusAt,
  sweepStaleHelperDirs,
  type HelperConfig,
  type HelperHandle,
} from './updateProgressHelper';

const RESOURCES = path.resolve(__dirname, '../../resources/update-progress');
const EM_DASH = '\u2014';

describe('progress curve (Harrison et al.)', () => {
  it('starts at 0, is strictly increasing, and never reaches 100%', () => {
    for (const e of [45, 100, 173, 300]) {
      let prev = progressAt(0, e);
      expect(prev).toBe(0);
      for (let t = 0.5; t <= e * 6; t += 0.5) {
        const p = progressAt(t, e);
        expect(p).toBeGreaterThanOrEqual(prev);
        expect(p).toBeLessThanOrEqual(CURVE_CAP);
        expect(p).toBeLessThan(1);
        prev = p;
      }
    }
  });

  it('moves fast early: a visible burst in the first seconds', () => {
    expect(progressAt(1, 100)).toBeGreaterThan(0.04);
    expect(progressAt(5, 100)).toBeGreaterThan(0.13);
  });

  it('is front-loaded around the estimate and still moving past it', () => {
    const e = 100;
    expect(progressAt(e / 2, e)).toBeGreaterThan(0.4);
    expect(progressAt(e / 2, e)).toBeLessThan(0.55);
    expect(progressAt(e, e)).toBeGreaterThan(0.65);
    expect(progressAt(e, e)).toBeLessThan(0.8);
    // Slow quartile (1.7x): high but not stalled.
    expect(progressAt(1.7 * e, e)).toBeLessThan(0.9);
    expect(progressAt(1.7 * e + 10, e) - progressAt(1.7 * e, e)).toBeGreaterThan(0.005);
  });

  it('after a completed download, opens at the download share and runs the rest over the estimate', () => {
    const s0 = DOWNLOAD_DONE_SHARE;
    expect(s0).toBe(0.4);
    for (const e of [45, 100, 173, 300]) {
      let prev = progressAt(0, e, s0);
      expect(prev).toBe(s0);
      for (let t = 0.5; t <= e * 6; t += 0.5) {
        const p = progressAt(t, e, s0);
        expect(p).toBeGreaterThanOrEqual(prev);
        expect(p).toBeLessThanOrEqual(CURVE_CAP);
        prev = p;
      }
    }
    const e = 100;
    // No second burst after the opening fill: calm, but never flat.
    expect(progressAt(5, e, s0) - s0).toBeLessThan(0.04);
    expect(progressAt(5, e, s0) - s0).toBeGreaterThan(0.01);
    expect(progressAt(e / 2, e, s0)).toBeGreaterThan(0.6);
    expect(progressAt(e / 2, e, s0)).toBeLessThan(0.7);
    expect(progressAt(e, e, s0)).toBeGreaterThan(0.75);
    expect(progressAt(e, e, s0)).toBeLessThan(0.85);
    expect(progressAt(1.7 * e, e, s0)).toBeLessThan(0.93);
    expect(progressAt(1.7 * e + 10, e, s0) - progressAt(1.7 * e, e, s0)).toBeGreaterThan(0.003);
  });

  it('start 0 is the plain curve (no faked progress without a download)', () => {
    for (const t of [0, 1, 5, 50, 100, 400]) expect(progressAt(t, 100, 0)).toBe(progressAt(t, 100));
  });
});

describe('estimate', () => {
  it('defaults to the real-user median', () => {
    expect(estimateInstallSeconds(undefined)).toBe(DEFAULT_INSTALL_SECONDS);
    expect(estimateInstallSeconds([])).toBe(DEFAULT_INSTALL_SECONDS);
  });

  it('uses the median of the last three samples, clamped', () => {
    expect(estimateInstallSeconds([300, 60, 80, 70])).toBe(70);
    expect(estimateInstallSeconds([80, 90])).toBe(85);
    expect(estimateInstallSeconds([12, 20, 30])).toBe(45);
    expect(estimateInstallSeconds([900, 1000, 1200])).toBe(300);
    expect(estimateInstallSeconds([5, Number.NaN, 4000])).toBe(DEFAULT_INSTALL_SECONDS);
  });
});

describe('status lines', () => {
  const en = HELPER_COPY.en;
  it('counts down in rounded buckets, then says it is late plainly', () => {
    expect(statusAt(0, 300, en)).toBe('About 5 minutes left');
    // 100 s rounds UP to two minutes: finishing early beats a broken promise.
    expect(statusAt(0, 100, en)).toBe('About 2 minutes left');
    expect(statusAt(20, 100, en)).toBe('About a minute left');
    expect(statusAt(60, 100, en)).toBe('Less than a minute left');
    expect(statusAt(95, 100, en)).toBe('A few seconds left');
    expect(statusAt(110, 100, en)).toBe('Almost done');
    expect(statusAt(200, 100, en)).toBe('Taking a little longer than usual');
  });

  it('never promises fewer than 2 minutes in the minutes line', () => {
    expect(statusAt(0, 140, en)).toBe('About 2 minutes left');
  });

  it('copy is plain: no em dashes, every key in both languages', () => {
    for (const lang of ['en', 'zh'] as const) {
      const c = HELPER_COPY[lang];
      expect(Object.keys(c).sort()).toEqual(Object.keys(HELPER_COPY.en).sort());
      for (const v of Object.values(c)) {
        expect(v).not.toContain(EM_DASH);
        expect(v.length).toBeGreaterThan(0);
      }
      expect(c.minutes).toContain('{n}');
    }
  });
});

describe('plan', () => {
  it('covers 4x the estimate at 1 s, monotonic, with status only on change', () => {
    const plan = buildPlan(100, HELPER_COPY.en);
    expect(plan.estimateSec).toBe(100);
    expect(plan.curve).toHaveLength(401);
    expect(plan.curve[0]).toEqual([0, 0]);
    for (let i = 1; i < plan.curve.length; i++) {
      expect(plan.curve[i][0]).toBe(i);
      expect(plan.curve[i][1]).toBeGreaterThanOrEqual(plan.curve[i - 1][1]);
      expect(plan.curve[i][1]).toBeLessThanOrEqual(CURVE_CAP);
    }
    const lines = plan.status.map(([, l]) => l);
    expect(new Set(lines).size).toBe(lines.length);
    expect(plan.status[0][0]).toBe(0);
    expect(lines.at(-1)).toBe('Taking a little longer than usual');
  });

  it('a download-done plan starts at the share with a short opening fill; otherwise at 0 with none', () => {
    const done = buildPlan(100, HELPER_COPY.en, DOWNLOAD_DONE_SHARE);
    expect(done.startShare).toBe(DOWNLOAD_DONE_SHARE);
    expect(done.curve[0]).toEqual([0, DOWNLOAD_DONE_SHARE]);
    expect(done.openingFillSec).toBe(OPENING_FILL_SEC);
    expect(OPENING_FILL_SEC).toBeGreaterThanOrEqual(0.4);
    expect(OPENING_FILL_SEC).toBeLessThanOrEqual(0.6);
    // The time-left line follows the estimate, not the bar.
    expect(done.status).toEqual(buildPlan(100, HELPER_COPY.en).status);
    const fresh = buildPlan(100, HELPER_COPY.en);
    expect(fresh.startShare).toBe(0);
    expect(fresh.openingFillSec).toBe(0);
  });

  it('fits in a small config file', () => {
    expect(JSON.stringify(buildPlan(300, HELPER_COPY.zh)).length).toBeLessThan(40_000);
  });
});

describe('config inputs', () => {
  it('maps theme_mode like the renderer (system follows the OS)', () => {
    expect(resolveHelperTheme('system', true)).toBe('midnight');
    expect(resolveHelperTheme('system', false)).toBe('ice');
    expect(resolveHelperTheme(undefined, false)).toBe('ice');
    expect(resolveHelperTheme('acorn', true)).toBe('acorn');
    expect(resolveHelperTheme('mint', true)).toBe('mint');
    expect(resolveHelperTheme('dark', false)).toBe('midnight');
    expect(resolveHelperTheme('light', true)).toBe('ice');
  });

  it('maps ui_language, absent = en', () => {
    expect(resolveHelperLang('zh')).toBe('zh');
    expect(resolveHelperLang('en')).toBe('en');
    expect(resolveHelperLang(undefined)).toBe('en');
  });

  it('process names drop the folder and .exe (Get-Process -Name)', () => {
    expect(processNameOf('C:\\Users\\a\\AppData\\Local\\sei-updater\\pending\\Sei-win-x64.exe')).toBe('Sei-win-x64');
    expect(processNameOf('C:\\Users\\a\\AppData\\Local\\Programs\\sei\\Sei.EXE')).toBe('Sei');
    expect(processNameOf('/tmp/Sei')).toBe('Sei');
  });

  it('builds a full config', () => {
    const cfg = buildHelperConfig({
      themeMode: 'system',
      osDark: true,
      uiLanguage: 'zh',
      history: [120],
      version: 'v0.7.0',
      installerPath: 'C:\\x\\pending\\Sei-win-x64.exe',
      appExe: 'C:\\Programs\\sei\\Sei.exe',
    });
    expect(cfg.lang).toBe('zh');
    expect(cfg.theme).toBe('midnight');
    expect(cfg.copy).toBe(HELPER_COPY.zh);
    expect(cfg.plan.estimateSec).toBe(120);
    expect(cfg.version).toBe('0.7.0');
    expect(cfg.installerName).toBe('Sei-win-x64');
    expect(cfg.appName).toBe('Sei');
    expect(cfg.installerWaitSec).toBeGreaterThan(5);
    // Not marked downloaded: no head start.
    expect(cfg.plan.startShare).toBe(0);
    const dl = buildHelperConfig({
      osDark: false,
      version: '0.7.0',
      installerPath: 'Sei-win-x64.exe',
      appExe: 'Sei.exe',
      downloaded: true,
    });
    expect(dl.plan.startShare).toBe(DOWNLOAD_DONE_SHARE);
  });

  it('runs Windows PowerShell by absolute path, process-scope bypass, STA', () => {
    expect(powershellPath({ SystemRoot: 'C:\\Windows' })).toBe(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    );
    expect(powershellPath({})).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    const a = powershellArgs('s.ps1', 'c.json');
    expect(a).toContain('-STA');
    expect(a.slice(a.indexOf('-ExecutionPolicy'), a.indexOf('-ExecutionPolicy') + 2)).toEqual([
      '-ExecutionPolicy',
      'Bypass',
    ]);
    expect(a.slice(-4)).toEqual(['-File', 's.ps1', '-ConfigPath', 'c.json']);
  });
});

describe('shipped resources', () => {
  it('has every file the launcher copies, the font licenses, and an ASCII script', () => {
    for (const rel of HELPER_FILES) expect(existsSync(path.join(RESOURCES, rel)), rel).toBe(true);
    expect(existsSync(path.join(RESOURCES, 'fonts', 'OFL-Oswald.txt'))).toBe(true);
    expect(existsSync(path.join(RESOURCES, 'fonts', 'OFL-Rajdhani.txt'))).toBe(true);
    const ps1 = readFileSync(path.join(RESOURCES, 'update-progress.ps1'));
    // Windows PowerShell 5.1 reads a BOM-less script in the ANSI code page.
    expect([...ps1].every((b) => b < 0x80)).toBe(true);
  });

  it('every config key the script reads exists in the config', () => {
    const ps1 = readFileSync(path.join(RESOURCES, 'update-progress.ps1'), 'utf8');
    const used = new Set([...ps1.matchAll(/\$cfg\.([A-Za-z]+)/g)].map((m) => m[1]));
    const copyUsed = new Set([...ps1.matchAll(/\$cfg\.copy\.([A-Za-z]+)/g)].map((m) => m[1]));
    const cfg: HelperConfig = buildHelperConfig({
      osDark: false,
      version: '0.7.0',
      installerPath: 'Sei-win-x64.exe',
      appExe: 'Sei.exe',
    });
    for (const k of used) expect(Object.keys(cfg), k).toContain(k);
    for (const k of copyUsed) expect(Object.keys(cfg.copy), k).toContain(k);
  });

  it('never passes a bare integer literal to [math]::Min/Max', () => {
    // [math]::Min(1, $x) with $x a function's return value resolves to the
    // Int32 overload and rounds $x: the bar sat at 0% then jumped to 100% the
    // moment the curve passed 0.5, on a real Windows runner.
    const ps1 = readFileSync(path.join(RESOURCES, 'update-progress.ps1'), 'utf8');
    const bad = [...ps1.matchAll(/\[math\]::(?:Min|Max)\(([^()]*(?:\([^()]*\))?[^()]*)\)/gi)]
      .map((m) => m[0])
      .filter((call) => /\(\s*-?\d+\s*,|,\s*-?\d+\s*\)/.test(call));
    expect(bad).toEqual([]);
  });

  it('never spells one variable two ways (PowerShell names ignore case)', () => {
    // $logo (a BitmapImage) once overwrote $Logo (the XAML element), and the
    // script died before its first frame on a real Windows runner.
    const ps1 = readFileSync(path.join(RESOURCES, 'update-progress.ps1'), 'utf8');
    const spellings = new Map<string, Set<string>>();
    for (const [, name] of ps1.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)) {
      const key = name.toLowerCase();
      if (!spellings.has(key)) spellings.set(key, new Set());
      spellings.get(key)!.add(name);
    }
    const clashes = [...spellings.values()].filter((v) => v.size > 1).map((v) => [...v].join('/'));
    expect(clashes).toEqual([]);
  });
});

describe('launchUpdateProgressHelper (fail safe)', () => {
  let tmpRoot: string;
  let scripts: string;
  const handles: HelperHandle[] = [];
  const config = buildHelperConfig({
    osDark: false,
    version: '0.7.0',
    installerPath: 'Sei-win-x64.exe',
    appExe: 'Sei.exe',
  });
  const fake = (name: string, body: string): string => {
    const p = path.join(scripts, name);
    writeFileSync(p, body);
    return p;
  };
  const launch = (script: string, extra: Partial<Parameters<typeof launchUpdateProgressHelper>[0]> = {}) =>
    launchUpdateProgressHelper({
      resourcesDir: RESOURCES,
      tmpRoot,
      config,
      readyTimeoutMs: 3_000,
      command: process.execPath,
      args: (_s, configPath) => [script, configPath],
      ...extra,
    }).then((h) => {
      handles.push(h);
      return h;
    });

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'sei-upw-test-'));
    scripts = mkdtempSync(path.join(tmpdir(), 'sei-upw-scripts-'));
  });
  afterEach(() => {
    for (const h of handles.splice(0)) h.kill();
    rmSync(tmpRoot, { recursive: true, force: true });
    rmSync(scripts, { recursive: true, force: true });
  });

  it('is ready once the script writes `ready`, with the files and config copied out', async () => {
    const script = fake(
      'ok.js',
      `const fs=require('fs'),p=require('path');const d=p.dirname(process.argv[2]);
       setTimeout(()=>fs.writeFileSync(p.join(d,'ready'),'ready'),150);setInterval(()=>{},1000);`,
    );
    const h = await launch(script);
    expect(h.ready).toBe(true);
    expect(h.reason).toBe('');
    for (const rel of HELPER_FILES) expect(existsSync(path.join(h.dir, rel)), rel).toBe(true);
    const cfg = JSON.parse(readFileSync(path.join(h.dir, 'config.json'), 'utf8')) as HelperConfig;
    expect(cfg.installerName).toBe('Sei-win-x64');
    expect(path.dirname(h.dir)).toBe(tmpRoot);
  });

  it('is not ready when the script exits first', async () => {
    const h = await launch(fake('exit.js', 'process.exit(3)'));
    expect(h.ready).toBe(false);
    expect(h.reason).toContain('exited early (code 3)');
  });

  it('follows a first stage that exits 0 and hands over to a window process', async () => {
    const stage2 = fake(
      'stage2.js',
      `const fs=require('fs'),p=require('path');const d=p.dirname(process.argv[2]);
       fs.writeFileSync(p.join(d,'pid'),String(process.pid));
       setTimeout(()=>fs.writeFileSync(p.join(d,'ready'),'ready'),300);setInterval(()=>{},1000);`,
    );
    const stage1 = fake(
      'stage1.js',
      `const {spawn}=require('child_process');
       spawn(process.execPath,[${JSON.stringify(stage2)},process.argv[2]],{detached:true,stdio:'ignore'}).unref();
       process.exit(0);`,
    );
    const h = await launch(stage1);
    expect(h.ready).toBe(true);
    const pid = Number(readFileSync(path.join(h.dir, 'pid'), 'utf8'));
    expect(() => process.kill(pid, 0)).not.toThrow();
    h.kill();
    await new Promise((r) => setTimeout(r, 200));
    expect(() => process.kill(pid, 0)).toThrow();
    expect(existsSync(path.join(h.dir, 'cancel'))).toBe(true);
  });

  it('falls back at once when the window process reports `failed`', async () => {
    const script = fake(
      'failed.js',
      `const fs=require('fs'),p=require('path');const d=p.dirname(process.argv[2]);
       setTimeout(()=>fs.writeFileSync(p.join(d,'failed'),'xaml failed: boom'),100);setInterval(()=>{},1000);`,
    );
    const t0 = Date.now();
    const h = await launch(script);
    expect(h.ready).toBe(false);
    expect(h.reason).toBe('window failed: xaml failed: boom');
    expect(Date.now() - t0).toBeLessThan(1_500);
  });

  it('kills a script that never draws, at the timeout', async () => {
    const script = fake(
      'hang.js',
      `const fs=require('fs'),p=require('path');fs.writeFileSync(p.join(p.dirname(process.argv[2]),'pid'),String(process.pid));setInterval(()=>{},1000);`,
    );
    const t0 = Date.now();
    const h = await launch(script, { readyTimeoutMs: 600 });
    expect(h.ready).toBe(false);
    expect(h.reason).toContain('no first frame within 600 ms');
    expect(Date.now() - t0).toBeLessThan(2_500);
    const pid = Number(readFileSync(path.join(h.dir, 'pid'), 'utf8'));
    await new Promise((r) => setTimeout(r, 200));
    expect(() => process.kill(pid, 0)).toThrow();
    expect(existsSync(path.join(h.dir, 'cancel'))).toBe(true);
  });

  it('waits up to the cap for a window process that has loaded WPF', async () => {
    const script = fake(
      'slow.js',
      `const fs=require('fs'),p=require('path');const d=p.dirname(process.argv[2]);
       fs.writeFileSync(p.join(d,'loaded'),'loaded');
       setTimeout(()=>fs.writeFileSync(p.join(d,'ready'),'ready'),900);setInterval(()=>{},1000);`,
    );
    const h = await launch(script, { readyTimeoutMs: 400, readyCapMs: 2_000 });
    expect(h.ready).toBe(true);
  });

  it('gives up at the cap when a loaded window still never draws', async () => {
    const script = fake(
      'slowhang.js',
      `const fs=require('fs'),p=require('path');const d=p.dirname(process.argv[2]);
       fs.writeFileSync(p.join(d,'loaded'),'loaded');setInterval(()=>{},1000);`,
    );
    const t0 = Date.now();
    const h = await launch(script, { readyTimeoutMs: 300, readyCapMs: 900 });
    expect(h.ready).toBe(false);
    expect(h.reason).toBe('no first frame within 900 ms (WPF loaded)');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(850);
    expect(Date.now() - t0).toBeLessThan(2_500);
  });

  it('is not ready when the command cannot start', async () => {
    const h = await launch('x', { command: path.join(scripts, 'no-such-powershell') });
    expect(h.ready).toBe(false);
    expect(h.reason).toMatch(/spawn error|start failed/);
  });

  it('is not ready when the resources are missing, and never throws', async () => {
    const h = await launch('x', { resourcesDir: path.join(scripts, 'missing') });
    expect(h.ready).toBe(false);
    expect(h.reason).toContain('start failed');
    expect(() => h.kill()).not.toThrow();
  });
});

describe('sweepStaleHelperDirs', () => {
  it('removes only old helper folders', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'sei-upw-sweep-'));
    try {
      const old = path.join(root, 'sei-update-progress-old');
      const fresh = path.join(root, 'sei-update-progress-new');
      const other = path.join(root, 'something-else');
      for (const d of [old, fresh, other]) mkdirSync(d);
      const twoHoursAgo = (Date.now() - 2 * 3600_000) / 1000;
      utimesSync(old, twoHoursAgo, twoHoursAgo);
      utimesSync(other, twoHoursAgo, twoHoursAgo);
      sweepStaleHelperDirs(root);
      expect(existsSync(old)).toBe(false);
      expect(existsSync(fresh)).toBe(true);
      expect(existsSync(other)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    expect(() => sweepStaleHelperDirs(path.join(root, 'gone'))).not.toThrow();
  });
});
