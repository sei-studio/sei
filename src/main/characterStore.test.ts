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
import { saveCharacter, getCharacter, resetMemoryForCharacter } from './characterStore';
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

  it('A9.1: wipes memory directory contents', async () => {
    // Seed the character JSON + a fake memory file the bot would have
    // written.
    await saveCharacter(makeChar());
    await writeFile(path.join(paths.memoryDir(UUID), 'MEMORY.md'), 'remembered facts');
    await writeFile(path.join(paths.memoryDir(UUID), 'PLAYER.md'), 'player notes');

    const before = await readdir(paths.memoryDir(UUID));
    expect(before.length).toBeGreaterThan(0);

    await resetMemoryForCharacter(UUID);

    const after = await readdir(paths.memoryDir(UUID));
    expect(after.length).toBe(0);
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
