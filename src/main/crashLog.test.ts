/** 261031 (T278): the local crash log: size cap + rotation, entry cap, scrub, frame helpers. */
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CRASH_ENTRY_MAX_CHARS,
  CRASH_LOG_FILE,
  CRASH_LOG_ROTATED,
  ERROR_TEXT_MAX_CHARS,
  appendCrashLog,
  cleanErrorName,
  errorParts,
  formatCrashEntry,
  setCrashRedactNames,
  topFrame,
} from './crashLog';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'sei-crashlog-'));
  setCrashRedactNames([]);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('appendCrashLog', () => {
  it('rotates at the cap and keeps at most two files', () => {
    const max = 4096;
    for (let i = 0; i < 60; i++) {
      appendCrashLog(dir, { kind: 'main_uncaught', process: 'main', version: '0.7.0', message: `boom ${i} ${'x'.repeat(200)}` }, max);
    }
    const cur = statSync(path.join(dir, CRASH_LOG_FILE)).size;
    const old = statSync(path.join(dir, CRASH_LOG_ROTATED)).size;
    // Each file stops one entry past the cap at most.
    expect(cur).toBeLessThan(max + 1024);
    expect(old).toBeLessThan(max + 1024);
    expect(readFileSync(path.join(dir, CRASH_LOG_FILE), 'utf8')).toContain('boom 59');
  });

  it('never throws on an unwritable directory', () => {
    appendCrashLog(dir, { kind: 'k', process: 'main', version: '1' });
    expect(() => appendCrashLog(path.join(dir, CRASH_LOG_FILE, 'nested'), { kind: 'k', process: 'main', version: '1' })).not.toThrow();
  });
});

describe('formatCrashEntry', () => {
  it('scrubs secrets, emails, the player names and caps the entry', () => {
    setCrashRedactNames(['Notch_42', 'Al']);
    const text = formatCrashEntry({
      kind: 'main_uncaught',
      process: 'main',
      version: '0.7.0',
      message: 'Notch_42 joined with key sk-ant-api03-ZZZZZZZZZZZZZZZZZZZZZZZZ and mail a@b.co; Al said hi',
      stack: 'y'.repeat(CRASH_ENTRY_MAX_CHARS * 2),
      at: 0,
    });
    expect(text).toContain('[player] joined');
    expect(text).not.toContain('Notch_42');
    expect(text).not.toContain('sk-ant-api03-ZZZZ');
    expect(text).not.toContain('a@b.co');
    // Names under 3 characters are not scrubbed (they would eat words).
    expect(text).toContain('Al said');
    expect(text).toContain('[truncated]');
    expect(text.length).toBeLessThan(CRASH_ENTRY_MAX_CHARS + 64);
  });
});

describe('error helpers', () => {
  it('errorParts handles errors, objects, strings and junk', () => {
    expect(errorParts(new RangeError('r')).name).toBe('RangeError');
    expect(errorParts({ message: 'm' })).toMatchObject({ name: 'NonError', message: 'm' });
    expect(errorParts('s')).toMatchObject({ name: 'StringError', message: 's' });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => errorParts(circular)).not.toThrow();
  });

  it('errorParts bounds huge messages and stacks before anything scrubs them', () => {
    const huge = 'x'.repeat(5_000_000);
    const e = new Error(huge);
    e.stack = `Error: ${huge}`;
    const parts = errorParts(e);
    expect(parts.message.length).toBe(ERROR_TEXT_MAX_CHARS);
    expect(parts.stack.length).toBe(ERROR_TEXT_MAX_CHARS);
    expect(errorParts(huge).message.length).toBe(ERROR_TEXT_MAX_CHARS);
    expect(errorParts({ blob: huge }).message.length).toBe(ERROR_TEXT_MAX_CHARS);
  });

  it('cleanErrorName only passes identifiers', () => {
    expect(cleanErrorName('TypeError')).toBe('TypeError');
    expect(cleanErrorName('Error: with spaces')).toBe('Error');
  });

  it('topFrame strips the directory from windows and posix frames', () => {
    expect(topFrame('Error: x\n    at f (C:\\Users\\bob\\Sei\\resources\\app.asar\\dist\\main\\index.js:10:5)')).toBe('index.js:10:5');
    expect(topFrame('Error: x\n    at /home/bob/sei/out/chunk-AB12.mjs:3:1')).toBe('chunk-AB12.mjs:3:1');
    expect(topFrame('Error: x\n    at new Promise (<anonymous>)')).toBeNull();
  });
});
