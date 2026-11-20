/**
 * 261107: the Velopack uninstall hook removes the open-at-login Run value
 * only when it starts THIS install (loginItemUninstall.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const exec = vi.hoisted(() => ({ calls: [] as string[][], query: '' as string | null }));
vi.mock('node:child_process', () => ({
  execFileSync: (cmd: string, args: string[]) => {
    exec.calls.push([cmd, ...args]);
    if (args[0] === 'query') {
      if (exec.query === null) throw new Error('ERROR: The system was unable to find the specified registry key or value.');
      return exec.query;
    }
    return '';
  },
}));

import { removeLoginValueForUninstall, runValueBelongsTo, runValueFromRegQuery } from './loginItemUninstall';

const ROOT = 'C:\\Users\\robin\\AppData\\Local\\Sei';
const query = (data: string) =>
  `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\r\n    SeiWorldLink    REG_SZ    ${data}\r\n\r\n`;

beforeEach(() => {
  exec.calls = [];
  exec.query = null;
});

describe('Run value parsing', () => {
  it('reads Sei\'s value out of reg query output', () => {
    expect(runValueFromRegQuery(query(`"${ROOT}\\current\\Sei.exe" --seilink-login`))).toBe(
      `"${ROOT}\\current\\Sei.exe" --seilink-login`,
    );
    expect(runValueFromRegQuery('    com.sei.app    REG_SZ    "C:\\x\\Sei.exe" --hidden')).toBeNull();
    expect(runValueFromRegQuery('')).toBeNull();
  });

  it('matches only an exe inside this install root', () => {
    expect(runValueBelongsTo(`"${ROOT}\\current\\Sei.exe" --seilink-login`, ROOT)).toBe(true);
    expect(runValueBelongsTo(`"${ROOT.toUpperCase()}\\CURRENT\\SEI.EXE" --seilink-login`, `${ROOT}\\`)).toBe(true);
    // An NSIS install elsewhere, and a sibling folder that only shares the prefix.
    expect(runValueBelongsTo('"C:\\Users\\robin\\AppData\\Local\\Programs\\sei\\Sei.exe" --seilink-login', ROOT)).toBe(false);
    expect(runValueBelongsTo(`"${ROOT}Beta\\current\\Sei.exe" --seilink-login`, ROOT)).toBe(false);
    expect(runValueBelongsTo('', ROOT)).toBe(false);
  });
});

describe('removeLoginValueForUninstall', () => {
  it('deletes the value from Run and StartupApproved when it starts this install', () => {
    exec.query = query(`"${ROOT}\\current\\Sei.exe" --seilink-login`);
    const log = vi.fn();
    removeLoginValueForUninstall(ROOT, log);
    const deletes = exec.calls.filter((c) => c[1] === 'delete');
    expect(deletes).toHaveLength(2);
    expect(deletes[0]).toEqual(['reg.exe', 'delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'SeiWorldLink', '/f']);
    expect(deletes[1][2]).toContain('StartupApproved\\Run');
    expect(log).toHaveBeenCalledWith('uninstall: removed the open-at-login item');
  });

  it('leaves another install\'s value, and does nothing when there is none', () => {
    exec.query = query('"D:\\Other\\Sei.exe" --seilink-login');
    removeLoginValueForUninstall(ROOT, () => {});
    expect(exec.calls.filter((c) => c[1] === 'delete')).toEqual([]);
    exec.query = null;
    expect(() => removeLoginValueForUninstall(ROOT, () => {})).not.toThrow();
    expect(exec.calls.filter((c) => c[1] === 'delete')).toEqual([]);
  });
});
