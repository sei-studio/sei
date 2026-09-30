/** 260909: the DST process listing parsers (macOS ps, Windows CIM). */
import { describe, it, expect } from 'vitest';
import { parseCimList, parsePsList } from './process';

describe('parsePsList', () => {
  it('finds the mac bundle binary and reads its start time', () => {
    const out = [
      '  123 Tue Sep  8 09:00:00 2026     /sbin/launchd',
      "59038 Tue Sep  8 23:41:15 2026     /Users/me/Library/Application Support/Steam/steamapps/common/Don't Starve Together/dontstarve_steam.app/Contents/MacOS/dontstarve_steam",
      '',
    ].join('\n');
    const r = parsePsList(out);
    expect(r.running).toBe(true);
    expect(new Date(r.startedAt!).getFullYear()).toBe(2026);
    expect(new Date(r.startedAt!).getMinutes()).toBe(41);
  });
  it('ignores unrelated processes', () => {
    expect(parsePsList('  1 Tue Sep  8 09:00:00 2026 /sbin/launchd\n')).toEqual({ running: false, startedAt: null });
    expect(parsePsList('')).toEqual({ running: false, startedAt: null });
  });
});

describe('parseCimList', () => {
  it('matches either Windows executable and parses the ISO date', () => {
    expect(parseCimList('dontstarve_steam_x64.exe|2026-09-08T23:41:15.0000000+08:00\r\n')).toMatchObject({ running: true, startedAt: Date.parse('2026-09-08T23:41:15+08:00') });
    expect(parseCimList('Dontstarve_steam.exe|garbage')).toEqual({ running: true, startedAt: null });
    expect(parseCimList('explorer.exe|2026-09-08T23:41:15+08:00')).toEqual({ running: false, startedAt: null });
  });
});
