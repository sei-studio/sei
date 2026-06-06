/**
 * Tests for the one-shot global→profile partition migration (260603).
 *
 * Surface:
 *   1. Moves global per-account data into profiles/local (default scope)
 *   2. Moves into profiles/<uuid> when signed in at boot
 *   3. Leaves device-global files (session.bin, wizard state) in place
 *   4. Idempotent: a present marker short-circuits the whole pass
 *   5. Never clobbers an existing target in the profile
 *   6. Fresh install: nothing to move, marker still written
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: (_k: string) => tmpdir() },
}));

import { paths, _setUserDataOverride, setActiveScope } from '../paths';
import { migrateGlobalToProfile } from './partitionMigration';

const UUID_A = 'bbf5b66f-2f0f-4918-a953-a2cf66d5a586';

let tmp: string;

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

/** Lay down a representative pre-partition global layout under the root. */
async function seedGlobalLayout(): Promise<void> {
  await writeFile(path.join(tmp, 'config.json'), '{"mc_username":"Steve"}\n', 'utf8');
  await writeFile(path.join(tmp, 'api_key.bin'), Buffer.from([1, 2, 3]));
  await mkdir(path.join(tmp, 'characters'), { recursive: true });
  await writeFile(path.join(tmp, 'characters', 'index.json'), '{"version":1,"order":["x"]}\n', 'utf8');
  await mkdir(path.join(tmp, 'memory', 'x'), { recursive: true });
  await writeFile(path.join(tmp, 'memory', 'x', 'MEMORY.md'), '# Memory\n', 'utf8');
  await writeFile(path.join(tmp, 'defaults-seeded.json'), '{"version":1,"ids":["x"]}\n', 'utf8');
  // Device-global — must NOT move:
  await writeFile(path.join(tmp, 'session.bin'), Buffer.from([9, 9]));
  await writeFile(path.join(tmp, 'skin-setup-state.json'), '{"version":1}\n', 'utf8');
}

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'sei-partition-test-'));
  _setUserDataOverride(tmp);
  setActiveScope('local');
});

afterEach(async () => {
  _setUserDataOverride(null);
  setActiveScope('local');
  if (tmp) { try { await rm(tmp, { recursive: true, force: true }); } catch { /* swallow */ } }
});

describe('migrateGlobalToProfile', () => {
  it('moves global per-account data into profiles/local and writes the marker', async () => {
    await seedGlobalLayout();

    await migrateGlobalToProfile();

    // Per-account stores relocated under profiles/local.
    expect(await exists(paths.configPath())).toBe(true);
    expect(await exists(paths.apiKeyPath())).toBe(true);
    expect(await exists(paths.indexPath())).toBe(true);
    expect(await exists(path.join(paths.memoryDir('x'), 'MEMORY.md'))).toBe(true);
    expect(await exists(paths.defaultsSeededPath())).toBe(true);

    // Sources gone from the device root.
    expect(await exists(path.join(tmp, 'config.json'))).toBe(false);
    expect(await exists(path.join(tmp, 'characters'))).toBe(false);
    expect(await exists(path.join(tmp, 'memory'))).toBe(false);

    // Device-global files stayed put.
    expect(await exists(paths.sessionPath())).toBe(true);
    expect(await exists(paths.wizardStatePath())).toBe(true);

    // Marker written.
    expect(await exists(paths.partitionMarkerPath())).toBe(true);
    const marker = JSON.parse(await readFile(paths.partitionMarkerPath(), 'utf8'));
    expect(marker.movedCount).toBeGreaterThan(0);

    // Content preserved.
    expect(await readFile(paths.configPath(), 'utf8')).toContain('Steve');
  });

  it('moves into the account profile when signed in at boot', async () => {
    await seedGlobalLayout();
    setActiveScope(UUID_A);

    await migrateGlobalToProfile();

    expect(paths.configPath()).toContain(path.join('profiles', UUID_A));
    expect(await exists(paths.configPath())).toBe(true);
    // 'local' profile must be untouched (empty).
    setActiveScope('local');
    expect(await exists(paths.configPath())).toBe(false);
  });

  it('is idempotent: a present marker short-circuits the pass', async () => {
    await writeFile(paths.partitionMarkerPath(), '{"version":1}\n', 'utf8');
    await seedGlobalLayout(); // global data present AFTER the marker

    await migrateGlobalToProfile();

    // Nothing moved — global config still at the device root.
    expect(await exists(path.join(tmp, 'config.json'))).toBe(true);
    expect(await exists(paths.configPath())).toBe(false);
  });

  it('never clobbers an existing target in the profile', async () => {
    await seedGlobalLayout();
    // Pre-existing profile config (e.g. a partial prior run / fresh seed).
    await mkdir(paths.profileRoot(), { recursive: true });
    await writeFile(paths.configPath(), '{"mc_username":"KeepMe"}\n', 'utf8');

    await migrateGlobalToProfile();

    // Target preserved; global source left in place for inspection.
    expect(await readFile(paths.configPath(), 'utf8')).toContain('KeepMe');
    expect(await exists(path.join(tmp, 'config.json'))).toBe(true);
  });

  it('fresh install: nothing to move, marker still written', async () => {
    expect(await exists(paths.partitionMarkerPath())).toBe(false);

    await migrateGlobalToProfile();

    expect(await exists(paths.partitionMarkerPath())).toBe(true);
    const marker = JSON.parse(await readFile(paths.partitionMarkerPath(), 'utf8'));
    expect(marker.movedCount).toBe(0);
  });
});
