/**
 * Tests for per-profile path partitioning (260603).
 *
 * Verifies the two path tiers:
 *   - DEVICE-GLOBAL helpers resolve directly under the userData root and do
 *     NOT move when the active scope changes (session, wizard, logs, the
 *     legacy migration marker, the partition marker).
 *   - PROFILE-SCOPED helpers resolve under `<userData>/profiles/<scope>/…` and
 *     re-point when setActiveScope() changes the scope.
 *
 * Plus setActiveScope() validation (UUID or 'local' only — anything else would
 * be path-joined into profiles/<scope> and could escape the root).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: (_k: string) => '/fake/userData' },
}));

import {
  paths,
  _setUserDataOverride,
  setActiveScope,
  getActiveScope,
  profileRootFor,
  SCOPE_LOCAL,
} from './paths';

const ROOT = '/fake/userData';
const UUID_A = 'bbf5b66f-2f0f-4918-a953-a2cf66d5a586';
const UUID_B = 'e4511df2-fd20-470b-9131-f8f9968e1c01';

afterEach(() => {
  _setUserDataOverride(null);
  setActiveScope('local');
});

describe('setActiveScope validation', () => {
  it('defaults to local and accepts null/local', () => {
    setActiveScope('local');
    expect(getActiveScope()).toBe(SCOPE_LOCAL);
    setActiveScope(null);
    expect(getActiveScope()).toBe(SCOPE_LOCAL);
  });

  it('accepts a UUID and lowercases it', () => {
    setActiveScope(UUID_A.toUpperCase());
    expect(getActiveScope()).toBe(UUID_A);
  });

  it('rejects path-traversal / non-UUID scope ids', () => {
    expect(() => setActiveScope('../evil')).toThrow();
    expect(() => setActiveScope('a/b')).toThrow();
    expect(() => setActiveScope('not-a-uuid')).toThrow();
    // unchanged after a rejected set
    expect(getActiveScope()).toBe(SCOPE_LOCAL);
  });
});

describe('device-global paths are scope-independent', () => {
  it('session, wizard, logs, migration + partition markers stay at the root', () => {
    setActiveScope(UUID_A);
    expect(paths.sessionPath()).toBe(`${ROOT}/session.bin`);
    expect(paths.wizardStatePath()).toBe(`${ROOT}/skin-setup-state.json`);
    expect(paths.logsDir()).toBe(`${ROOT}/logs`);
    expect(paths.migrationManifestPath()).toBe(`${ROOT}/migration-uuid-rename.json`);
    expect(paths.partitionMarkerPath()).toBe(`${ROOT}/profiles-partitioned.json`);
    expect(paths.profilesDir()).toBe(`${ROOT}/profiles`);

    // Switching scope must not move any of them.
    setActiveScope(UUID_B);
    expect(paths.sessionPath()).toBe(`${ROOT}/session.bin`);
    expect(paths.partitionMarkerPath()).toBe(`${ROOT}/profiles-partitioned.json`);
  });
});

describe('profile-scoped paths follow the active scope', () => {
  it('resolves under profiles/local by default', () => {
    expect(paths.profileRoot()).toBe(`${ROOT}/profiles/local`);
    expect(paths.configPath()).toBe(`${ROOT}/profiles/local/config.json`);
    expect(paths.charactersDir()).toBe(`${ROOT}/profiles/local/characters`);
    expect(paths.characterPath(UUID_A)).toBe(`${ROOT}/profiles/local/characters/${UUID_A}.json`);
    expect(paths.indexPath()).toBe(`${ROOT}/profiles/local/characters/index.json`);
    expect(paths.apiKeyPath()).toBe(`${ROOT}/profiles/local/api_key.bin`);
    expect(paths.memoryDir(UUID_A)).toBe(`${ROOT}/profiles/local/memory/${UUID_A}`);
    expect(paths.skinPngPath(UUID_A)).toBe(`${ROOT}/profiles/local/skins/${UUID_A}.png`);
    expect(paths.portraitPath(UUID_A)).toBe(`${ROOT}/profiles/local/portraits/${UUID_A}.png`);
    expect(paths.syncQueuePath()).toBe(`${ROOT}/profiles/local/sync-queue.json`);
    expect(paths.defaultsSeededPath()).toBe(`${ROOT}/profiles/local/defaults-seeded.json`);
    expect(paths.migrationModalShownPath()).toBe(`${ROOT}/profiles/local/migration-modal-shown.json`);
  });

  it('re-points to the account profile when the scope changes', () => {
    setActiveScope(UUID_A);
    expect(paths.profileRoot()).toBe(`${ROOT}/profiles/${UUID_A}`);
    expect(paths.memoryDir('x')).toBe(`${ROOT}/profiles/${UUID_A}/memory/x`);

    setActiveScope(UUID_B);
    expect(paths.configPath()).toBe(`${ROOT}/profiles/${UUID_B}/config.json`);
  });

  it('two scopes never share a memory directory (isolation)', () => {
    setActiveScope(UUID_A);
    const aMem = paths.memoryDir('char');
    setActiveScope(UUID_B);
    const bMem = paths.memoryDir('char');
    expect(aMem).not.toBe(bMem);
  });
});

describe('profileRootFor', () => {
  it('computes a scope-independent profile root', () => {
    expect(profileRootFor('local')).toBe(`${ROOT}/profiles/local`);
    expect(profileRootFor(UUID_A)).toBe(`${ROOT}/profiles/${UUID_A}`);
    expect(() => profileRootFor('../evil')).toThrow();
  });
});
