/**
 * Round-trip + corrupt-blob recovery + ENOENT-as-null.
 * Source: 10-RESEARCH §Pitfall A3 + 10-02-PLAN Task 2 behavior.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// safeStorage is unavailable in node-test env. Stub it BEFORE importing the
// module under test. The stub round-trips via a Buffer wrap so we exercise
// the actual fs paths.
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from('ENC:' + s, 'utf8'),
    decryptString: (b: Buffer) => {
      const s = b.toString('utf8');
      if (!s.startsWith('ENC:')) throw new Error('decrypt failed');
      return s.slice(4);
    },
    getSelectedStorageBackend: () => 'gnome_libsecret',
  },
}));

import { paths, _setUserDataOverride } from '../paths';
import {
  saveJson,
  loadJson,
  removeJson,
  sessionBackendKind,
  assertSingleSession,
} from './sessionStore';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'sei-sess-'));
  _setUserDataOverride(tmp);
});

afterEach(async () => {
  _setUserDataOverride(null);
  await rm(tmp, { recursive: true, force: true });
});

describe('sessionStore', () => {
  it('round-trips a JSON string via save → load', async () => {
    const payload = JSON.stringify({ access_token: 'abc', refresh_token: 'xyz' });
    await saveJson('sb-session', payload);
    const got = await loadJson('sb-session');
    expect(got).toBe(payload);
  });

  it('keeps separate values for separate keys (PKCE verifier survives session write)', async () => {
    // Supabase PKCE flow writes the code-verifier under one key, then the
    // session under another. Previously the single-blob adapter overwrote
    // the verifier when the session was stored, breaking
    // exchangeCodeForSession from the email-verification callback.
    await saveJson('sb-x-auth-token-code-verifier', 'verifier-secret');
    await saveJson('sb-x-auth-token', JSON.stringify({ access_token: 'abc' }));
    expect(await loadJson('sb-x-auth-token-code-verifier')).toBe('verifier-secret');
    expect(await loadJson('sb-x-auth-token')).toBe(JSON.stringify({ access_token: 'abc' }));
  });

  it('removeJson removes only the targeted key', async () => {
    await saveJson('k1', 'v1');
    await saveJson('k2', 'v2');
    await removeJson('k1');
    expect(await loadJson('k1')).toBeNull();
    expect(await loadJson('k2')).toBe('v2');
  });

  it('returns null when the session file does not exist (ENOENT)', async () => {
    const got = await loadJson('any-key');
    expect(got).toBeNull();
  });

  it('clears the file and returns null when the blob is corrupt', async () => {
    // Write garbage that the decrypt stub will reject
    await writeFile(paths.sessionPath(), Buffer.from('not-encrypted-bytes'));
    const got = await loadJson('any-key');
    expect(got).toBeNull();
    // File MUST have been removed
    await expect(readFile(paths.sessionPath())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removeJson is a no-op when the file does not exist', async () => {
    await expect(removeJson('any-key')).resolves.toBeUndefined();
  });

  it('sessionBackendKind() returns the stubbed backend string', () => {
    expect(sessionBackendKind()).toBe('gnome_libsecret');
  });

  // ── Single-active-session invariant (anti-abuse Outcome 1) ──────────────
  describe('assertSingleSession', () => {
    it('counts 0 sessions for an empty / missing blob', async () => {
      expect(await assertSingleSession()).toBe(0);
    });

    it('counts 1 session (auth-token only) — the normal case', async () => {
      await saveJson('sb-projref-auth-token', JSON.stringify({ access_token: 'a' }));
      expect(await assertSingleSession()).toBe(1);
    });

    it('does NOT count the PKCE code-verifier as a session', async () => {
      await saveJson('sb-projref-auth-token', JSON.stringify({ access_token: 'a' }));
      await saveJson('sb-projref-auth-token-code-verifier', 'verifier');
      expect(await assertSingleSession()).toBe(1);
    });

    it('treats chunked auth-token variants as ONE session', async () => {
      await saveJson('sb-projref-auth-token.0', 'chunk0');
      await saveJson('sb-projref-auth-token.1', 'chunk1');
      expect(await assertSingleSession()).toBe(1);
    });

    it('detects 2 sessions (different project refs) and throws when asked', async () => {
      await saveJson('sb-projA-auth-token', JSON.stringify({ access_token: 'a' }));
      await saveJson('sb-projB-auth-token', JSON.stringify({ access_token: 'b' }));
      // Without throwOnViolation it returns the count.
      expect(await assertSingleSession(false)).toBe(2);
      // With throwOnViolation it fails loud.
      await expect(assertSingleSession(true)).rejects.toThrow('SINGLE_SESSION_INVARIANT_VIOLATED');
    });

    it('a fresh sign-in (overwriting the same auth-token key) stays at 1', async () => {
      await saveJson('sb-projref-auth-token', JSON.stringify({ access_token: 'A' }));
      // Sign into B overwrites the SAME key (last-write-wins) — never a 2nd key.
      await saveJson('sb-projref-auth-token', JSON.stringify({ access_token: 'B' }));
      expect(await assertSingleSession(true)).toBe(1);
    });
  });
});
