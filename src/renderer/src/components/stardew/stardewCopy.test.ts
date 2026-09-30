import { describe, it, expect } from 'vitest';
import { progressLine, installErrorCopy } from './stardewCopy';
import { ERROR_COPY } from '../../lib/errors';

describe('stardew copy helpers', () => {
  it('maps every install stage to a line and a percent', () => {
    expect(progressLine(null)).toEqual({ key: 'Preparing...', pct: null });
    expect(progressLine({ stage: 'smapi-downloading', pct: 42 })).toEqual({ key: 'Downloading SMAPI... {pct}%', pct: 42 });
    expect(progressLine({ stage: 'mod-placing' }).key).toMatch(/companion mod/);
    expect(progressLine({ stage: 'done', state: {} as never }).pct).toBe(100);
    expect(progressLine({ stage: 'failed', error: 'SMAPI_INSTALL_FAILED', message: 'x' }).key).toBe('Setup failed');
  });

  it('turns an ErrorClass-prefixed install error into copy + detail', () => {
    expect(installErrorCopy(null)).toBeNull();
    expect(installErrorCopy('SMAPI_INSTALL_FAILED: could not download')).toEqual({ copy: ERROR_COPY.SMAPI_INSTALL_FAILED, detail: 'could not download' });
    expect(installErrorCopy('GAME_NOT_INSTALLED: looked in a, b')).toEqual({ copy: ERROR_COPY.GAME_NOT_INSTALLED, detail: 'looked in a, b' });
    expect(installErrorCopy('something odd')?.copy).toBe(ERROR_COPY.GAME_INSTALL_FAILED);
  });
});
