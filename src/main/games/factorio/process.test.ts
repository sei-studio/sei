import { describe, expect, it } from 'vitest';
import { parseCimFactorio, parsePsFactorio } from './process';

describe('factorio process detection', () => {
  it('matches the binary name only', () => {
    expect(parsePsFactorio('/sbin/launchd\n/Users/you/Library/Application Support/Steam/steamapps/common/Factorio/factorio.app/Contents/MacOS/factorio\n')).toBe(true);
    expect(parsePsFactorio('/Applications/Sei.app/Contents/MacOS/Sei\nfactorio-helper\n')).toBe(false);
    expect(parseCimFactorio('factorio.exe\r\n')).toBe(true);
    expect(parseCimFactorio('')).toBe(false);
  });
});
