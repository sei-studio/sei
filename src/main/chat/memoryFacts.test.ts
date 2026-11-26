/**
 * memoryFacts (261113, v0.7 consistency D2): the fold's and the session
 * end's durable facts, saved once each.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FOLD_MEMORY_BYTES, freshFacts, memoryEntryKeys, memoryForFold, saveFacts } from './memoryFacts';
import { APP_SECTION_HEADER } from '../../bot/brain/memory/memoryLog.js';

const BODY =
  '# Memory\n\n## World 1 — Home (Minecraft)\n' +
  '- [2026-10-05T20:11:00.000Z] Alex has a cat named Mochi.\n' +
  '- [2026-10-07T21:14:00.000Z] we picked the river spot for the cabin\n';

describe('freshFacts', () => {
  it('drops facts any entry already has, at any age, and repeats within the list', () => {
    expect(memoryEntryKeys(BODY).has('alex has a cat named mochi')).toBe(true);
    const r = freshFacts(BODY, ['alex has a cat named Mochi', 'Alex works at the library', 'Alex works at the library!', '  ']);
    expect(r).toEqual({ fresh: ['Alex works at the library'], dupes: 2 });
  });
});

describe('memoryForFold', () => {
  it('is the chat tail with local stamps', () => {
    expect(memoryForFold(BODY)).not.toContain('2026-10-05T20:11:00.000Z');
    expect(memoryForFold(BODY)).toContain('Alex has a cat named Mochi.');
    expect(memoryForFold('x'.repeat(FOLD_MEMORY_BYTES + 10))).toHaveLength(FOLD_MEMORY_BYTES);
  });
});

describe('saveFacts', () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'sei-facts-'));
    file = path.join(dir, 'MEMORY.md');
  });
  afterEach(async () => rm(dir, { recursive: true, force: true }));

  it('appends the new facts under the app section with the given stamp, and counts dupes', async () => {
    await writeFile(file, BODY);
    const when = Date.parse('2026-11-10T09:00:00.000Z');
    const r = await saveFacts(file, ['Alex has a cat named Mochi', 'Alex now works at the library, not the bakery'], { section: 'app', when });
    expect(r).toEqual({ returned: 2, saved: 1, dupes: 1 });
    const body = await readFile(file, 'utf8');
    expect(body).toContain(`${APP_SECTION_HEADER}\n- [2026-11-10T09:00:00.000Z] Alex now works at the library, not the bakery`);
    expect(body.match(/Mochi/g)).toHaveLength(1);
  });

  it('files in-game facts in the last section, and starts a missing file', async () => {
    expect(await saveFacts(file, [])).toEqual({ returned: 0, saved: 0, dupes: 0 });
    const r = await saveFacts(file, ['Alex named the village cat Noodle']);
    expect(r.saved).toBe(1);
    expect(await readFile(file, 'utf8')).toMatch(/^# Memory[\s\S]*\] Alex named the village cat Noodle\n?$/);
  });
});
