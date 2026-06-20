/**
 * configStore.addPlaytimeMs — profile-wide cumulative playtime accumulator.
 *
 * 260615: the UsageBar tooltip's "played Xh Ym" reads `total_playtime_ms` off
 * UserConfig. It's incremented at session-end (botSupervisor) so the total
 * survives a character being deleted. These tests pin the atomic
 * read-modify-write: accumulation, non-positive no-ops, and field preservation.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _setUserDataOverride, paths } from './paths';
import { addPlaytimeMs, backfillTotalPlaytimeOnce, loadConfig, saveConfig } from './configStore';
import { CharacterSchema } from '../shared/characterSchema';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

/**
 * Write a character JSON + index entry straight to disk (bypassing
 * characterStore.saveCharacter, whose fire-and-forget cloud-sync enqueue would
 * error after the tmpdir teardown). listCharacters reads index.json + each file.
 */
async function writeChar(id: string, playtime_ms: number): Promise<void> {
  await mkdir(paths.charactersDir(), { recursive: true });
  const char = CharacterSchema.parse({
    id,
    name: 'C',
    persona: { source: 'x', expanded: '' },
    created: '2026-01-01T00:00:00.000Z',
    playtime_ms,
  });
  await writeFile(paths.characterPath(id), JSON.stringify(char, null, 2));
}
async function writeIndex(order: string[]): Promise<void> {
  await mkdir(paths.charactersDir(), { recursive: true });
  await writeFile(paths.indexPath(), JSON.stringify({ version: 1, order }, null, 2));
}

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'sei-cfg-'));
  _setUserDataOverride(tmp);
});
afterEach(async () => {
  _setUserDataOverride(null);
  await rm(tmp, { recursive: true, force: true });
});

describe('addPlaytimeMs', () => {
  it('seeds from zero when no config file exists yet', async () => {
    await addPlaytimeMs(1000);
    expect((await loadConfig()).total_playtime_ms).toBe(1000);
  });

  it('accumulates across calls', async () => {
    await addPlaytimeMs(1000);
    await addPlaytimeMs(2500);
    expect((await loadConfig()).total_playtime_ms).toBe(3500);
  });

  it('ignores zero / negative / non-finite deltas', async () => {
    await addPlaytimeMs(0);
    await addPlaytimeMs(-50);
    await addPlaytimeMs(Number.NaN);
    expect((await loadConfig()).total_playtime_ms).toBe(0);
  });

  it('rounds fractional ms', async () => {
    await addPlaytimeMs(1000.7);
    expect((await loadConfig()).total_playtime_ms).toBe(1001);
  });

  it('preserves other config fields', async () => {
    await saveConfig({ ...(await loadConfig()), preferred_name: 'Ouen' });
    await addPlaytimeMs(1234);
    const cfg = await loadConfig();
    expect(cfg.preferred_name).toBe('Ouen');
    expect(cfg.total_playtime_ms).toBe(1234);
  });
});

describe('backfillTotalPlaytimeOnce', () => {
  it('seeds the total from the sum of existing characters, once', async () => {
    await writeChar(UUID_A, 1000);
    await writeChar(UUID_B, 2500);
    await writeIndex([UUID_A, UUID_B]);

    await backfillTotalPlaytimeOnce();
    let cfg = await loadConfig();
    expect(cfg.total_playtime_ms).toBe(3500);
    expect(cfg.total_playtime_backfilled).toBe(true);

    // Idempotent: a second run (even after more time accrues) does NOT re-sum.
    await addPlaytimeMs(500); // a later session → 4000
    await backfillTotalPlaytimeOnce();
    cfg = await loadConfig();
    expect(cfg.total_playtime_ms).toBe(4000);
  });

  it('never shrinks an already-advanced total', async () => {
    await writeChar(UUID_A, 1000);
    await writeIndex([UUID_A]);
    await addPlaytimeMs(9000); // total raced ahead before first backfill
    await backfillTotalPlaytimeOnce();
    expect((await loadConfig()).total_playtime_ms).toBe(9000); // max(9000, 1000)
  });
});
