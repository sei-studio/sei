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

import { createSessionMarker, readPreviousSession, uncleanExitProps } from './sessionMarker';

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

describe('quit states', () => {
  const init = { sessionId: 's1', version: '0.7.0', channel: 'stable', packaged: true, now: 1_000 };

  it('a quit that started and never finished reads quit_hang, with the wait so far', () => {
    const file = path.join(dir, 'session.json');
    const m = createSessionMarker(file, init);
    m.open();
    m.closing(5_000);
    // The teardown hangs; the heartbeat keeps running and must not reopen it.
    m.update({}, 65_000);
    const prev = readPreviousSession(file);
    expect(prev.prevExit).toBe('quit_hang');
    expect(prev.marker?.closing_at).toBe(5_000);
    expect(uncleanExitProps(prev.marker!)).toMatchObject({ prev_exit: 'quit_hang', prev_quit_wait_ms: 60_000 });
  });

  it('closing then the real exit is clean', () => {
    const file = path.join(dir, 'session.json');
    const m = createSessionMarker(file, init);
    m.open();
    m.closing(2_000);
    m.close('closed', 3_000);
    expect(readPreviousSession(file).prevExit).toBe('clean');
  });

  it('a failed start is start_failed and a later quit cannot overwrite it', () => {
    const file = path.join(dir, 'session.json');
    const m = createSessionMarker(file, init);
    m.open();
    m.close('start_failed', 2_000);
    m.close('closed', 3_000);
    m.closing(4_000);
    const prev = readPreviousSession(file);
    expect(prev.prevExit).toBe('start_failed');
    expect(uncleanExitProps(prev.marker!).prev_exit).toBe('start_failed');
  });
});
