/** 261031 (T278): the session marker survives a refused rename (Windows AV / indexer). */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ failRename: false }));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    renameSync: (from: string, to: string) => {
      if (h.failRename) {
        const err = new Error('EPERM: operation not permitted, rename') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      }
      return real.renameSync(from, to);
    },
  };
});

import { createSessionMarker, readPreviousSession } from './sessionMarker';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'sei-marker-'));
  h.failRename = false;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('writeMarker', () => {
  it('a clean quit still lands when the rename is refused', () => {
    const file = path.join(dir, 'session.json');
    const m = createSessionMarker(file, { sessionId: 's1', version: '0.7.0', channel: 'stable', packaged: true, now: 1 });
    m.open();
    h.failRename = true;
    m.close('closed', 2);
    expect(readPreviousSession(file).prevExit).toBe('clean');
    expect(readFileSync(file, 'utf8')).toContain('"closed"');
    // No temp file left behind.
    expect(readdirSync(dir)).toEqual(['session.json']);
  });
});
