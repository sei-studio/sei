import { describe, expect, it } from 'vitest';
import { powerShellEnv } from './winPowerShell';

describe('powerShellEnv', () => {
  it('drops an inherited PSModulePath, whatever its case, and keeps the rest', () => {
    const env = powerShellEnv(
      { PSModulePath: 'C:\\Program Files\\PowerShell\\7\\Modules', psmodulepath: 'x', PATH: 'C:\\W', TEMP: 'C:\\T' },
      { SEI_SIG_FILES: 'a.exe' },
    );
    expect(Object.keys(env).filter((k) => k.toLowerCase() === 'psmodulepath')).toEqual([]);
    expect(env).toMatchObject({ PATH: 'C:\\W', TEMP: 'C:\\T', SEI_SIG_FILES: 'a.exe' });
  });

  it('lets the inputs override the inherited environment, and never takes a PSModulePath from them', () => {
    expect(powerShellEnv({ TEMP: 'C:\\T' }, { TEMP: 'C:\\X', PSModulePath: 'y' })).toEqual({ TEMP: 'C:\\X' });
  });

  it('does not change the environment it was given', () => {
    const base = { PSModulePath: 'p' };
    powerShellEnv(base);
    expect(base).toEqual({ PSModulePath: 'p' });
  });
});
