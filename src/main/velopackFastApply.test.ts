import { describe, expect, it } from 'vitest';
import {
  APPLYING_MARKER_MAX_AGE_MS,
  applyArgs,
  applyInProgress,
  compareVersions,
  isUpdaterImage,
  tasklistImage,
  ETA_BUCKETS,
  MAX_LAUNCH_APPLY_ATTEMPTS,
  overlayFrameLooksRight,
  overlayFrames,
  overlaySpec,
  parseRolloutRule,
  parseStageResult,
  rolloutAllows,
  rolloutBucket,
  shouldApplyAtLaunch,
  stageArgs,
  updateScreenText,
  velopackPathsFor,
} from './velopackFastApply';

describe('velopackPathsFor', () => {
  it('derives the Velopack layout from current\\Sei.exe', () => {
    expect(velopackPathsFor('C:\\Users\\a\\AppData\\Local\\Sei\\current\\Sei.exe')).toEqual({
      root: 'C:\\Users\\a\\AppData\\Local\\Sei',
      packagesDir: 'C:\\Users\\a\\AppData\\Local\\Sei\\packages',
      updateExe: 'C:\\Users\\a\\AppData\\Local\\Sei\\Update.exe',
      stageDir: 'C:\\Users\\a\\AppData\\Local\\Sei\\packages\\SeiStaged',
      overlayDir: 'C:\\Users\\a\\AppData\\Local\\Sei\\packages\\SeiOverlay',
    });
  });

  it('is null for an NSIS install', () => {
    expect(velopackPathsFor('C:\\Users\\a\\AppData\\Local\\Programs\\sei\\Sei.exe')).toBeNull();
  });
});

describe('applyArgs / stageArgs', () => {
  const base = { packagePath: 'P\\Sei-0.7.1-full.nupkg', waitPid: 42, root: 'R', packagesDir: 'R\\packages' };

  it('restart with overlay', () => {
    expect(applyArgs({ ...base, restart: true, overlayDir: 'R\\packages\\SeiOverlay' })).toEqual([
      'apply', '--package', 'P\\Sei-0.7.1-full.nupkg', '--waitPid', '42', '--silent',
      '--root', 'R', '--packageDir', 'R\\packages', '--noHooks', '--seiOverlay', 'R\\packages\\SeiOverlay',
    ]);
  });

  it('on quit: no restart, no overlay', () => {
    const a = applyArgs({ ...base, restart: false });
    expect(a).toContain('--norestart');
    expect(a).toContain('--noHooks');
    expect(a).not.toContain('--seiOverlay');
  });

  it('stage', () => {
    expect(stageArgs('P\\x.nupkg', 'R', 'R\\packages')).toEqual([
      'stage', '--package', 'P\\x.nupkg', '--silent', '--root', 'R', '--packageDir', 'R\\packages',
    ]);
  });
});

describe('parseStageResult', () => {
  it('reads the outcome word', () => {
    expect(parseStageResult('ok 0.7.1 staged in 9000 ms').outcome).toBe('ok');
    expect(parseStageResult('skipped 0.7.1: low disk, 300 MB free').outcome).toBe('skipped');
    expect(parseStageResult('failed 0.7.1: extract: denied').outcome).toBe('failed');
    expect(parseStageResult('').outcome).toBe('unknown');
    expect(parseStageResult(null).outcome).toBe('unknown');
  });
});

describe('update screen text', () => {
  it('has every frame in both languages', () => {
    for (const lang of ['en', 'zh'] as const) {
      const f = overlayFrames(lang);
      expect(Object.keys(f).sort()).toEqual(
        ['updating', 'error', 'eta-long', ...ETA_BUCKETS.map((s) => `eta-${s}`)].sort(),
      );
      for (const v of Object.values(f)) expect(v.length).toBeGreaterThan(0);
    }
  });

  it('keeps "Updating…" in every estimate and words the buckets naturally', () => {
    const en = updateScreenText('en');
    expect(en.updating).toBe('Updating…');
    expect(en.eta['eta-20']).toBe('Updating… about 20 seconds left');
    expect(en.eta['eta-60']).toBe('Updating… about a minute left');
    expect(en.eta['eta-120']).toBe('Updating… about 2 minutes left');
    expect(en.eta['eta-long']).toBe('Updating… a few more minutes');
    expect(en.error).toBe("Couldn't update. Opening Sei…");
    const zh = updateScreenText('zh');
    expect(zh.updating).toBe('正在更新…');
    expect(zh.eta['eta-20']).toBe('正在更新…大约还需 20 秒');
    expect(zh.error).toBe('更新失败，正在打开 Sei…');
  });

  it('never uses an em dash', () => {
    for (const lang of ['en', 'zh'] as const) {
      for (const v of Object.values(overlayFrames(lang))) expect(v).not.toMatch(/\u2014/);
    }
  });
});

describe('overlaySpec', () => {
  it('lists the position and frames', () => {
    expect(overlaySpec(800.4, 455, ['updating', 'error'], 8000)).toBe(
      'x=800\ny=455\nslowAfterMs=8000\nframe.updating=updating.png\nframe.error=error.png\n',
    );
  });
});

describe('overlayFrameLooksRight', () => {
  const frame = (w: number, h: number, alphaAt: (x: number, y: number) => number): Uint8Array => {
    const px = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        px[i] = px[i + 1] = px[i + 2] = 255;
        px[i + 3] = alphaAt(x, y);
      }
    return px;
  };
  it('accepts a transparent page with a logo', () => {
    expect(overlayFrameLooksRight(frame(320, 170, (x, y) => (x > 100 && x < 220 && y > 40 && y < 120 ? 255 : 0)))).toBe(true);
  });
  it('rejects the solid white first paint', () => {
    expect(overlayFrameLooksRight(frame(320, 170, () => 255))).toBe(false);
  });
  it('rejects a frame captured before the logo drew', () => {
    expect(overlayFrameLooksRight(frame(320, 170, () => 0))).toBe(false);
    expect(overlayFrameLooksRight(new Uint8Array(0))).toBe(false);
  });
});

describe('applyInProgress', () => {
  const alive = (): boolean => true;
  const dead = (): boolean => false;
  it('true for a fresh marker with a live pid', () => {
    expect(applyInProgress('1234\n', 1000, 2000, alive)).toBe(true);
  });
  it('false without a marker, for a dead pid, a stale or junk marker', () => {
    expect(applyInProgress(null, 0, 0, alive)).toBe(false);
    expect(applyInProgress('1234', 1000, 2000, dead)).toBe(false);
    expect(applyInProgress('1234', 0, APPLYING_MARKER_MAX_AGE_MS + 1, alive)).toBe(false);
    expect(applyInProgress('junk', 1000, 2000, alive)).toBe(false);
  });
});

describe('staged rollout', () => {
  it('parses and clamps the rule', () => {
    expect(parseRolloutRule({ version: '0.7.1', percent: 150 })).toEqual({ version: '0.7.1', percent: 100 });
    expect(parseRolloutRule({ version: '0.7.1' })).toBeNull();
    expect(parseRolloutRule(null)).toBeNull();
  });

  it('only gates the version it names', () => {
    expect(rolloutAllows({ version: '0.7.1', percent: 0 }, '0.7.2', 'id')).toBe(true);
    expect(rolloutAllows({ version: '0.7.1', percent: 0 }, '0.7.1', 'id')).toBe(false);
    expect(rolloutAllows({ version: '0.7.1', percent: 100 }, '0.7.1', 'id')).toBe(true);
    expect(rolloutAllows(null, '0.7.1', 'id')).toBe(true);
  });

  it('admits roughly the configured share, stably per install', () => {
    let admitted = 0;
    for (let i = 0; i < 2000; i++) {
      if (rolloutAllows({ version: '0.7.1', percent: 20 }, '0.7.1', `install-${i}`)) admitted++;
    }
    expect(admitted).toBeGreaterThan(300);
    expect(admitted).toBeLessThan(500);
    expect(rolloutBucket('abc', '0.7.1')).toBe(rolloutBucket('abc', '0.7.1'));
  });
});

describe('shouldApplyAtLaunch', () => {
  it('applies a staged newer version', () => {
    expect(shouldApplyAtLaunch('0.7.1', '0.7.0', true, false, null)).toBe(true);
  });
  it('waits for a stage, skips right after a restart and after repeated failures', () => {
    expect(shouldApplyAtLaunch('0.7.1', '0.7.0', false, false, null)).toBe(false);
    expect(shouldApplyAtLaunch('0.7.1', '0.7.0', true, true, null)).toBe(false);
    expect(
      shouldApplyAtLaunch('0.7.1', '0.7.0', true, false, { version: '0.7.1', attempts: MAX_LAUNCH_APPLY_ATTEMPTS }),
    ).toBe(false);
    expect(shouldApplyAtLaunch('0.7.1', '0.7.0', true, false, { version: '0.7.0', attempts: 5 })).toBe(true);
    expect(shouldApplyAtLaunch('0.7.0', '0.7.0', true, false, null)).toBe(false);
    expect(shouldApplyAtLaunch(null, '0.7.0', true, false, null)).toBe(false);
  });
});

describe('compareVersions', () => {
  it('orders releases and prereleases', () => {
    expect(compareVersions('0.7.0', '0.7.0-beta.3')).toBe(1);
    expect(compareVersions('0.7.0-beta.10', '0.7.0-beta.9')).toBe(1);
    expect(compareVersions('0.6.11', '0.7.0-beta.1')).toBe(-1);
    expect(compareVersions('0.7.1', '0.7.1')).toBe(0);
  });
});

describe('stale applying.pid guard', () => {
  it('reads the image name out of tasklist CSV output', () => {
    expect(tasklistImage('"Update.exe","4242","Console","1","12,345 K"\r\n')).toBe('Update.exe');
    expect(tasklistImage('"chrome.exe","4242","Console","1","99,000 K"')).toBe('chrome.exe');
    expect(tasklistImage('INFO: No tasks are running which match the specified criteria.')).toBeNull();
    expect(tasklistImage(null)).toBeNull();
  });

  it('only Update.exe (or its Squirrel.exe name) counts as an apply', () => {
    expect(isUpdaterImage('Update.exe')).toBe(true);
    expect(isUpdaterImage('UPDATE.EXE')).toBe(true);
    expect(isUpdaterImage('Squirrel.exe')).toBe(true);
    expect(isUpdaterImage('Sei.exe')).toBe(false);
    expect(isUpdaterImage('svchost.exe')).toBe(false);
  });
});
