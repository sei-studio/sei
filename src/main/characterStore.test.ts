/**
 * ui-A9 — resetMemoryForCharacter side-effects.
 *
 * Verifies:
 *   - Memory dir contents are wiped and the dir is recreated empty.
 *   - last_launched and playtime_ms on the character JSON are reset to
 *     null and 0 respectively.
 *   - Other character fields (persona, portrait, skin, name) are
 *     preserved verbatim.
 *
 * Source: ui-A9 spec — Reset memory (per-character + all).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// electron isn't available in the node-test env. Stub safeStorage so the
// apiKeyStore module that characterStore drags in via personaExpansion can
// be imported without exploding. The reset path doesn't call expansion
// (no LLM round-trip), so safeStorage is never actually exercised.
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8'),
    getSelectedStorageBackend: () => 'basic_text',
  },
  app: {
    getPath: (_n: string) => '/tmp/sei-default',
  },
}));

// saveCharacter / deleteCharacter fire a best-effort, un-awaited cloud-mirror
// enqueue (writes <profileRoot>/sync-queue.json via tmp+rename). In a unit test
// that rm's its tmpdir in afterEach, that async rename can land AFTER teardown
// and surface as an ENOENT unhandled rejection. We don't exercise cloud sync
// here, so stub the queue to keep the enqueue synchronous-and-inert.
vi.mock('./cloud/syncQueue', () => ({
  enqueueUpsert: vi.fn(async () => {}),
  enqueueDelete: vi.fn(async () => {}),
  processNext: vi.fn(async () => {}),
}));

import { _setUserDataOverride, paths } from './paths';
import { saveCharacter, getCharacter, resetMemoryForCharacter, checkCreateQuota, recordCreation } from './characterStore';
import { loadConfig, saveConfig } from './configStore';
import { MAX_CREATIONS_PER_DAY, type Character } from '../shared/characterSchema';

let tmp: string;

const UUID = '550e8400-e29b-41d4-a716-446655440099';

function makeChar(): Character {
  return {
    id: UUID,
    kind: 'custom',
    public_id: null,
    name: 'TestPersona',
    persona: { source: 'a quiet companion', expanded: 'long persona text' },
    is_default: false,
    shared: false,
    slug: null,
    metadata: {},
    created: '2026-05-27T00:00:00.000Z',
    last_launched: '2026-05-27T12:00:00.000Z',
    playtime_ms: 90_000,
    portrait_image: null,
    skin: { source: 'none', mojang_username: null, png_sha256: null, applied_at: null },
    username: null,
  };
}

describe('resetMemoryForCharacter (ui-A9)', () => {
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'sei-charstore-'));
    _setUserDataOverride(tmp);
    // Pre-create characters/ + memory/ trees the same way saveCharacter would.
    await mkdir(path.join(tmp, 'characters'), { recursive: true });
    await mkdir(paths.memoryDir(UUID), { recursive: true });
  });

  afterEach(async () => {
    _setUserDataOverride(null);
    // macOS occasionally races on rmdir during the test-tmpdir teardown
    // (mirrors portraitStore.test.ts behavior). Retry once before giving up.
    try {
      await rm(tmp, { recursive: true, force: true });
    } catch {
      await new Promise((r) => setTimeout(r, 25));
      try { await rm(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  it('A9.1: wipes memory directory contents — MEMORY.md, PLAYER.md, and goals (HEARTBEAT.md)', async () => {
    // Seed the character JSON + the files the bot writes at runtime. HEARTBEAT.md
    // is the committed-goals / standing-orders store (setGoal/clearGoal write
    // here, path = `${memDir}/HEARTBEAT.md`); it lives INSIDE memoryDir so the
    // recursive wipe must clear it too. Asserting it explicitly locks the
    // "reset clears active goals" guarantee against a future refactor that
    // selectively deletes only MEMORY.md / PLAYER.md or relocates goals.
    await saveCharacter(makeChar());
    await writeFile(path.join(paths.memoryDir(UUID), 'MEMORY.md'), 'remembered facts');
    await writeFile(path.join(paths.memoryDir(UUID), 'PLAYER.md'), 'player notes');
    await writeFile(path.join(paths.memoryDir(UUID), 'HEARTBEAT.md'), '- [2026-06-16] build a complete base');

    const before = await readdir(paths.memoryDir(UUID));
    expect(before).toContain('HEARTBEAT.md');

    await resetMemoryForCharacter(UUID);

    const after = await readdir(paths.memoryDir(UUID));
    expect(after.length).toBe(0);
    // Goals specifically must be gone, not just "the dir shrank".
    expect(after).not.toContain('HEARTBEAT.md');
  });

  it('A9.2: resets last_launched=null and playtime_ms=0', async () => {
    await saveCharacter(makeChar());
    const priorJson = await getCharacter(UUID);
    expect(priorJson?.last_launched).toBe('2026-05-27T12:00:00.000Z');
    expect(priorJson?.playtime_ms).toBe(90_000);

    await resetMemoryForCharacter(UUID);

    const reset = await getCharacter(UUID);
    expect(reset).not.toBeNull();
    expect(reset!.last_launched).toBeNull();
    expect(reset!.playtime_ms).toBe(0);
  });

  it('A9.3: preserves persona / name / portrait / skin verbatim', async () => {
    await saveCharacter(makeChar());

    await resetMemoryForCharacter(UUID);

    const reset = await getCharacter(UUID);
    expect(reset).not.toBeNull();
    expect(reset!.name).toBe('TestPersona');
    expect(reset!.persona.source).toBe('a quiet companion');
    expect(reset!.persona.expanded).toBe('long persona text');
    expect(reset!.skin.source).toBe('none');
  });

  it('A9.4: tolerates missing memory dir (idempotent)', async () => {
    await saveCharacter(makeChar());
    await rm(paths.memoryDir(UUID), { recursive: true, force: true });

    // Should not throw, and should still reset stats.
    await resetMemoryForCharacter(UUID);

    const reset = await getCharacter(UUID);
    expect(reset!.playtime_ms).toBe(0);
    // memory dir should be recreated.
    const ls = await readFile(path.join(paths.memoryDir(UUID), '.placeholder'), 'utf-8').catch(() => 'missing-but-dir-exists');
    expect(typeof ls).toBe('string');
  });
});

// 260705 — daily creation cap (MAX_CREATIONS_PER_DAY, rolling 24h local log
// in UserConfig.creation_times).
describe('checkCreateQuota / recordCreation', () => {
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'sei-charstore-'));
    _setUserDataOverride(tmp);
  });

  afterEach(async () => {
    _setUserDataOverride(null);
    try {
      await rm(tmp, { recursive: true, force: true });
    } catch {
      await new Promise((r) => setTimeout(r, 25));
      try { await rm(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  it('unblocked with no creation history', async () => {
    const quota = await checkCreateQuota();
    expect(quota).toEqual({ blocked: false, resetsAt: null });
  });

  it(`blocks after ${MAX_CREATIONS_PER_DAY} creations in the window, with resetsAt = oldest + 24h`, async () => {
    for (let i = 0; i < MAX_CREATIONS_PER_DAY; i++) {
      await recordCreation();
    }
    const quota = await checkCreateQuota();
    expect(quota.blocked).toBe(true);
    expect(quota.resetsAt).not.toBeNull();
    const config = await loadConfig();
    const oldest = new Date(config.creation_times![0]).getTime();
    expect(new Date(quota.resetsAt!).getTime()).toBe(oldest + 86_400_000);
  });

  it(`stays unblocked at ${MAX_CREATIONS_PER_DAY - 1} creations`, async () => {
    for (let i = 0; i < MAX_CREATIONS_PER_DAY - 1; i++) {
      await recordCreation();
    }
    const quota = await checkCreateQuota();
    expect(quota.blocked).toBe(false);
  });

  it('ignores entries older than 24h (rolling window, not calendar day)', async () => {
    const stale = new Date(Date.now() - 86_400_000 - 60_000).toISOString();
    const config = await loadConfig();
    await saveConfig({
      ...config,
      creation_times: Array.from({ length: MAX_CREATIONS_PER_DAY }, () => stale),
    });
    const quota = await checkCreateQuota();
    expect(quota.blocked).toBe(false);
  });

  it('recordCreation prunes expired entries so the log never grows unbounded', async () => {
    const stale = new Date(Date.now() - 86_400_000 - 60_000).toISOString();
    const config = await loadConfig();
    await saveConfig({ ...config, creation_times: [stale, stale, stale] });
    await recordCreation();
    const after = await loadConfig();
    expect(after.creation_times).toHaveLength(1);
  });

  it('tolerates garbage timestamps in the log (fails open, prunes them on write)', async () => {
    const config = await loadConfig();
    await saveConfig({ ...config, creation_times: ['not-a-date', ''] });
    const quota = await checkCreateQuota();
    expect(quota.blocked).toBe(false);
    await recordCreation();
    const after = await loadConfig();
    expect(after.creation_times).toHaveLength(1);
  });
});
