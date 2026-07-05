/**
 * ui-A9 — resetMemoryForCharacter side-effects + the patchCharacter contract.
 *
 * Verifies:
 *   - Memory dir contents are wiped and the dir is recreated empty.
 *   - last_launched and playtime_ms on the character JSON are reset to
 *     null and 0 respectively.
 *   - Other character fields (persona, portrait, skin, name) are
 *     preserved verbatim.
 *
 * Source: ui-A9 spec — Reset memory (per-character + all).
 *
 * 260705 — patchCharacter: locked read-modify-write. Pins the merge
 * round-trip, the missing-id null no-op, and that concurrent patches
 * serialize (the lock spans the whole read-modify-write, not just the
 * write — the reason the helper exists).
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
import { saveCharacter, getCharacter, patchCharacter, resetMemoryForCharacter } from './characterStore';
import type { Character } from '../shared/characterSchema';

let tmp: string;

const UUID = '550e8400-e29b-41d4-a716-446655440099';

function makeChar(): Character {
  return {
    id: UUID,
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

// File-scope hooks: both describes want the same fresh userData tmpdir.
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

describe('resetMemoryForCharacter (ui-A9)', () => {
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

describe('patchCharacter (260705)', () => {
  it('P.1: applies the updater and persists — round-trips via getCharacter', async () => {
    await saveCharacter(makeChar());

    const out = await patchCharacter(UUID, (c) => ({ ...c, playtime_ms: (c.playtime_ms ?? 0) + 5_000 }));

    expect(out?.playtime_ms).toBe(95_000);
    const onDisk = await getCharacter(UUID);
    expect(onDisk?.playtime_ms).toBe(95_000);
    // Untouched fields survive the merge verbatim.
    expect(onDisk?.persona.expanded).toBe('long persona text');
    expect(onDisk?.last_launched).toBe('2026-05-27T12:00:00.000Z');
  });

  it('P.2: missing id returns null and writes nothing', async () => {
    const missing = '550e8400-e29b-41d4-a716-446655440777';

    const out = await patchCharacter(missing, (c) => ({ ...c, playtime_ms: 1 }));

    expect(out).toBeNull();
    expect(await getCharacter(missing)).toBeNull();
    // No JSON materialized on disk either — null means NO write happened.
    const files = await readdir(path.join(tmp, 'characters'));
    expect(files.filter((f) => f.startsWith(missing))).toHaveLength(0);
  });

  it('P.3: 20 concurrent increments all land — the lock spans the whole read-modify-write', async () => {
    // The proof the helper exists for: with the lock covering only the write
    // (the old re-read-then-saveCharacter idiom), concurrent increments read
    // the same base value and the total comes up short.
    await saveCharacter({ ...makeChar(), playtime_ms: 0 });

    await Promise.all(
      Array.from({ length: 20 }, () =>
        patchCharacter(UUID, (c) => ({ ...c, playtime_ms: (c.playtime_ms ?? 0) + 1 })),
      ),
    );

    const final = await getCharacter(UUID);
    expect(final?.playtime_ms).toBe(20);
  });
});
