import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, readdir, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  RENAME_RETRY_DELAYS_MS,
  renameWithRetry,
  renameWithRetrySync,
  writeFileDurable,
  writeFileDurableSync,
} from './durableWrite';

function errno(code: string): NodeJS.ErrnoException {
  const e = new Error(code) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

let tmp: string;
beforeEach(async () => { tmp = await mkdtemp(path.join(tmpdir(), 'sei-durable-')); });
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('writeFileDurable(Sync)', () => {
  it('writes the data and leaves no temp file (async)', async () => {
    const f = path.join(tmp, 'a.json');
    await writeFileDurable(f, 'one');
    await writeFileDurable(f, 'two');
    expect(await readFile(f, 'utf8')).toBe('two');
    expect(await readdir(tmp)).toEqual(['a.json']);
  });

  it('writes the data and leaves no temp file (sync)', async () => {
    const f = path.join(tmp, 'b.json');
    writeFileDurableSync(f, 'one');
    writeFileDurableSync(f, new TextEncoder().encode('two'));
    expect(await readFile(f, 'utf8')).toBe('two');
    expect(await readdir(tmp)).toEqual(['b.json']);
  });

  it('a failed rename removes the temp file and keeps the old content', async () => {
    const f = path.join(tmp, 'c.json');
    writeFileDurableSync(f, 'old');
    // Renaming a file over a non-empty directory fails on every platform.
    const dir = path.join(tmp, 'd');
    await mkdir(path.join(dir, 'inner'), { recursive: true });
    expect(() => writeFileDurableSync(dir, 'x')).toThrow();
    await expect(writeFileDurable(dir, 'x')).rejects.toThrow();
    expect((await readdir(tmp)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    expect(await readFile(f, 'utf8')).toBe('old');
  });
});

describe('renameWithRetry', () => {
  it('retries a locked target on Windows, then succeeds', () => {
    let calls = 0;
    const sleeps: number[] = [];
    renameWithRetrySync('a', 'b', {
      platform: 'win32',
      sleep: (ms) => sleeps.push(ms),
      rename: () => {
        calls++;
        if (calls < 3) throw errno(calls === 1 ? 'EPERM' : 'EBUSY');
      },
    });
    expect(calls).toBe(3);
    expect(sleeps).toEqual(RENAME_RETRY_DELAYS_MS.slice(0, 2));
  });

  it('gives up after the last delay', () => {
    let calls = 0;
    expect(() =>
      renameWithRetrySync('a', 'b', {
        platform: 'win32',
        sleep: () => {},
        rename: () => {
          calls++;
          throw errno('EACCES');
        },
      }),
    ).toThrow('EACCES');
    expect(calls).toBe(RENAME_RETRY_DELAYS_MS.length + 1);
  });

  it('does not retry on other platforms or other errors', () => {
    let calls = 0;
    const rename = () => {
      calls++;
      throw errno('EPERM');
    };
    expect(() => renameWithRetrySync('a', 'b', { platform: 'darwin', sleep: () => {}, rename })).toThrow();
    expect(calls).toBe(1);
    calls = 0;
    expect(() =>
      renameWithRetrySync('a', 'b', {
        platform: 'win32',
        sleep: () => {},
        rename: () => {
          calls++;
          throw errno('ENOENT');
        },
      }),
    ).toThrow();
    expect(calls).toBe(1);
  });

  it('async variant retries the same way', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const p = renameWithRetry('a', 'b', {
        platform: 'win32',
        rename: async () => {
          calls++;
          if (calls < 2) throw errno('EBUSY');
        },
      });
      await vi.runAllTimersAsync();
      await p;
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
