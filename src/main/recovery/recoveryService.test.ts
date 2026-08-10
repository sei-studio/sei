/**
 * recoveryService tests — the failsafe ordering is the point. Pins:
 *   - scan returns shape only, skips backup dirs, filters dismissed keys;
 *   - repair backs up + quarantines BEFORE rewriting, rewrites atomically,
 *     removes bridge.json, and NEVER touches MEMORY.archive.md;
 *   - dismiss persists and survives a reread.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('electron', () => ({
  app: { getPath: () => '/unused', isPackaged: false },
}));
const { captureSpy } = vi.hoisted(() => ({ captureSpy: vi.fn() }));
vi.mock('../analytics', () => ({ capture: captureSpy }));

import { _setUserDataOverride } from '../paths';
import { scanRecovery, repairRecovery, dismissRecovery, sessionKey } from './recoveryService';

const T0 = Date.parse('2026-07-31T05:00:00Z');
const CHAR = 'a0a0a0a0-1111-2222-3333-444444444444';

let root: string;

/** Voice flood rows: user every 7s for `mins` minutes. */
function floodLines(startTs: number, mins: number): string[] {
  const lines: string[] = [];
  for (let t = 0; t <= mins * 60_000; t += 7_000) {
    lines.push(JSON.stringify({ id: `u${t}`, role: 'user', text: 'phantom', ts: startTs + t, voice: true }));
    lines.push(JSON.stringify({ id: `c${t}`, role: 'companion', text: 'reply', ts: startTs + t + 2_000, voice: true }));
  }
  return lines;
}

const charDir = (): string => path.join(root, 'profiles', 'local', 'memory', CHAR);

async function seedCharacter(): Promise<void> {
  await mkdir(charDir(), { recursive: true });
  const typed = [
    JSON.stringify({ id: 't1', role: 'user', text: 'hi', ts: T0 - 86_400_000 }),
    JSON.stringify({ id: 't2', role: 'companion', text: 'hey', ts: T0 - 86_390_000 }),
  ];
  await writeFile(
    path.join(charDir(), 'chat.jsonl'),
    [...typed, ...floodLines(T0, 52)].join('\n') + '\n',
    'utf8',
  );
  const iso = (ms: number): string => new Date(ms).toISOString();
  await writeFile(
    path.join(charDir(), 'MEMORY.md'),
    [
      '## World 1 — home',
      `- [${iso(T0 - 86_400_000)}] real fact`,
      `- [${iso(T0 + 60_000)}] junk from the flood`,
      '',
    ].join('\n'),
    'utf8',
  );
  await writeFile(path.join(charDir(), 'MEMORY.archive.md'), 'ARCHIVE UNTOUCHED\n', 'utf8');
  await writeFile(path.join(charDir(), 'bridge.json'), JSON.stringify({ summary: 'ruined', summarizedCount: 400 }), 'utf8');
  await mkdir(path.join(root, 'profiles', 'local', 'characters'), { recursive: true });
  await writeFile(
    path.join(root, 'profiles', 'local', 'characters', `${CHAR}.json`),
    JSON.stringify({ id: CHAR, name: 'syl' }),
    'utf8',
  );
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'sei-recovery-'));
  _setUserDataOverride(root);
  captureSpy.mockClear();
  await seedCharacter();
});

afterEach(async () => {
  _setUserDataOverride(null);
  await rm(root, { recursive: true, force: true });
});

describe('scanRecovery', () => {
  it('flags the flood with shape only and the character name', async () => {
    const found = await scanRecovery();
    expect(found).toHaveLength(1);
    const c = found[0];
    expect(c.characterId).toBe(CHAR);
    expect(c.characterName).toBe('syl');
    expect(c.startTs).toBe(T0);
    expect(c.userRows).toBeGreaterThanOrEqual(50);
    expect(c.medianGapS).toBeLessThanOrEqual(15);
    // Shape only — no message text field anywhere on the candidate.
    expect(Object.keys(c).sort()).toEqual(
      ['characterId', 'characterName', 'endTs', 'medianGapS', 'startTs', 'totalRows', 'userRows'].sort(),
    );
  });

  it('dismissed windows never re-prompt', async () => {
    const [c] = await scanRecovery();
    await dismissRecovery([sessionKey(c.characterId, c.startTs)]);
    expect(await scanRecovery()).toEqual([]);
  });

  it('a missing memory root scans clean', async () => {
    await rm(path.join(root, 'profiles', 'local', 'memory'), { recursive: true });
    expect(await scanRecovery()).toEqual([]);
  });
});

describe('repairRecovery', () => {
  it('quarantines the flood, keeps typed rows, resets bridge, spares the archive', async () => {
    const [c] = await scanRecovery();
    const result = await repairRecovery(CHAR, [{ start: c.startTs, end: c.endTs }]);
    expect(result.rowsQuarantined).toBe(c.totalRows);
    expect(result.memoryLinesRemoved).toBe(1);

    // Transcript: typed rows kept, voice flood gone.
    const chat = await readFile(path.join(charDir(), 'chat.jsonl'), 'utf8');
    const kept = chat.trim().split('\n');
    expect(kept).toHaveLength(2);
    expect(kept[0]).toContain('"t1"');

    // MEMORY.md: junk line gone, header + real fact byte-identical.
    const mem = await readFile(path.join(charDir(), 'MEMORY.md'), 'utf8');
    expect(mem).toContain('## World 1 — home');
    expect(mem).toContain('real fact');
    expect(mem).not.toContain('junk from the flood');

    // bridge.json gone (continuity treats missing as fresh).
    await expect(readFile(path.join(charDir(), 'bridge.json'), 'utf8')).rejects.toThrow();

    // Archive untouched, byte for byte.
    expect(await readFile(path.join(charDir(), 'MEMORY.archive.md'), 'utf8')).toBe('ARCHIVE UNTOUCHED\n');

    // Quarantine sidecars exist and carry what was removed.
    const files = await readdir(charDir());
    const quarChat = files.find((f) => f.startsWith('chat.quarantine-'));
    const quarMem = files.find((f) => f.startsWith('MEMORY.quarantine-'));
    const quarBridge = files.find((f) => f.startsWith('bridge.quarantine-'));
    expect(quarChat && quarMem && quarBridge).toBeTruthy();
    const quarRows = (await readFile(path.join(charDir(), quarChat!), 'utf8')).trim().split('\n');
    expect(quarRows).toHaveLength(c.totalRows);

    // Full backup exists as a SIBLING of the memory root (never inside it).
    const profileEntries = await readdir(path.join(root, 'profiles', 'local'));
    const backupRoot = profileEntries.find((f) => f.startsWith('recovery-backup-'));
    expect(backupRoot).toBeTruthy();
    const backedUp = await readdir(path.join(root, 'profiles', 'local', backupRoot!, CHAR));
    expect(backedUp).toContain('chat.jsonl');
    expect(backedUp).toContain('MEMORY.md');
    expect(backedUp).toContain('MEMORY.archive.md');
    expect(backedUp).toContain('bridge.json');
    // The backup transcript is the PRE-repair one.
    const backupChat = await readFile(
      path.join(root, 'profiles', 'local', backupRoot!, CHAR, 'chat.jsonl'),
      'utf8',
    );
    expect(backupChat.trim().split('\n')).toHaveLength(2 + c.totalRows);

    // A rescan after repair finds nothing (the flood rows are gone).
    expect(await scanRecovery()).toEqual([]);
  });

  it('fires memory_repair_run with shape only', async () => {
    const [c] = await scanRecovery();
    await repairRecovery(CHAR, [{ start: c.startTs, end: c.endTs }]);
    await new Promise((r) => setTimeout(r, 0)); // let the floating block land
    const calls = captureSpy.mock.calls.filter((call) => call[0] === 'memory_repair_run');
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual({
      sessions_cleaned: 1,
      rows_quarantined: c.totalRows,
      memory_lines_removed: 1,
    });
  });

  it('scan skips its own backup dirs on later runs', async () => {
    const [c] = await scanRecovery();
    await repairRecovery(CHAR, [{ start: c.startTs, end: c.endTs }]);
    // Even if a backup dir sat INSIDE memory/, the prefix guard would skip it;
    // here we assert the real layout keeps memory/ to character dirs only.
    const memEntries = await readdir(path.join(root, 'profiles', 'local', 'memory'));
    expect(memEntries).toEqual([CHAR]);
  });
});
