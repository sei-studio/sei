---
phase: 10
plan: 02
type: execute
wave: 1
depends_on: []
files_modified:
  - src/main/paths.ts
  - src/main/auth/sessionStore.ts
  - src/main/auth/sessionStore.test.ts
autonomous: true
requirements: [AUTH-03]
requirements_addressed: [AUTH-03]
tags: [safestorage, session, persistence]
must_haves:
  truths:
    - "A SupabaseClient configured with the safeStorage-backed adapter can persist a session JSON across process restart, decrypting to the original string on subsequent load (AUTH-03)"
    - "A corrupt session blob (decrypt throws) is auto-cleared and treated as 'no session' rather than crashing the app (RESEARCH Pitfall A3)"
    - "Linux 'basic_text' safeStorage backend is detectable via sessionBackendKind() so the Banner in plan 07 can surface the warning (Pitfall A2, AUTH-03 surface)"
    - "The session blob lives at <userData>/session.bin (paths.sessionPath()), mirroring api_key.bin convention exactly (CONTEXT Claude's discretion: single sealed blob)"
  artifacts:
    - path: "src/main/auth/sessionStore.ts"
      provides: "saveJson(key,value)/loadJson(key)/removeJson(key) implementing the Supabase StorageAdapter contract over a single sealed session.bin blob"
      exports: ["saveJson", "loadJson", "removeJson", "sessionBackendKind", "createSessionStorageAdapter"]
    - path: "src/main/paths.ts"
      provides: "sessionPath() returning <userData>/session.bin"
      contains: "sessionPath"
    - path: "src/main/auth/sessionStore.test.ts"
      provides: "Coverage for round-trip, corrupt-blob recovery, and ENOENT-as-null"
      contains: "describe"
  key_links:
    - from: "src/main/auth/sessionStore.ts"
      to: "src/main/paths.ts"
      via: "paths.sessionPath()"
      pattern: "paths\\.sessionPath"
    - from: "src/main/auth/sessionStore.ts"
      to: "electron.safeStorage"
      via: "encryptString / decryptString / getSelectedStorageBackend"
      pattern: "safeStorage\\."
    - from: "src/main/auth/sessionStore.ts"
      to: "src/main/auth/supabaseClient.ts (consumer in plan 03)"
      via: "createSessionStorageAdapter() returns the StorageAdapter passed to setStorageAdapter()"
      pattern: "createSessionStorageAdapter"
---

<objective>
Implement `src/main/auth/sessionStore.ts` as a near-verbatim clone of `src/main/apiKeyStore.ts`, plus the `createSessionStorageAdapter()` factory that wraps the single sealed `<userData>/session.bin` blob in the Supabase `StorageAdapter` shape defined by plan 01. Extend `src/main/paths.ts` with `sessionPath()`. Cover with three vitest cases (round-trip, corrupt-blob recovery, ENOENT).

Purpose: Make Supabase's session JSON persistable across launches using Electron's `safeStorage` — the AUTH-03 requirement. The single-blob-key-ignored design matches CONTEXT's Claude's-discretion note ("single sealed session.bin"; multi-account is v1.x).

Output:
  - `src/main/auth/sessionStore.ts` with the storage adapter factory and a `sessionBackendKind()` getter
  - One new line in `src/main/paths.ts`
  - `src/main/auth/sessionStore.test.ts` with 3 passing tests
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@.planning/REQUIREMENTS.md
@.planning/phases/10-auth-foundation/10-CONTEXT.md
@.planning/phases/10-auth-foundation/10-RESEARCH.md
@.planning/phases/10-auth-foundation/10-UI-SPEC.md
@.planning/research/PITFALLS.md
@CLAUDE.md
@src/main/apiKeyStore.ts
@src/main/paths.ts

<interfaces>
<!-- The exact apiKeyStore.ts shape this file mirrors. Plan 02 IS allowed to read apiKeyStore.ts at runtime; the patterns below are copied verbatim where indicated. -->

From src/main/apiKeyStore.ts (the template):
```typescript
export async function saveApiKey(plaintext: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('KEYCHAIN_UNAVAILABLE');
  }
  const buf = safeStorage.encryptString(plaintext);
  const target = paths.apiKeyPath();
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.tmp.${process.pid}.${Date.now()}`);
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await writeFile(tmp, buf);
    await rename(tmp, target);
  } catch (err) {
    try { await unlink(tmp); } catch {}
    throw err;
  }
}
export function backendKind(): string {
  const fn = (safeStorage as { getSelectedStorageBackend?: () => string }).getSelectedStorageBackend;
  if (typeof fn !== 'function') return 'unknown';
  try { return fn.call(safeStorage); }
  catch { return 'unknown'; }
}
```

From src/main/paths.ts:
```typescript
apiKeyPath: () => path.join(userDataRoot(), 'api_key.bin'),
// MIRROR THIS for sessionPath
```

StorageAdapter contract (from plan 01's src/main/auth/supabaseClient.ts):
```typescript
export interface StorageAdapter {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}
```
</interfaces>
</context>

<read_first>
- `src/main/apiKeyStore.ts` — the template; copy its shape verbatim, change names/path/error classes only
- `src/main/paths.ts` — single canonical paths module; add ONE line (sessionPath)
- `.planning/phases/10-auth-foundation/10-RESEARCH.md` §Pattern 3 (sessionStore.ts shape) and §Pitfall A3 (corrupt blob recovery)
- `.planning/research/PITFALLS.md` §Pitfall 15 (safeStorage Linux fallback)
</read_first>

<tasks>

<task type="auto" tdd="false">
  <name>Task 1: Add sessionPath() to paths.ts</name>
  <files>src/main/paths.ts</files>
  <read_first>
    - src/main/paths.ts (locate the existing apiKeyPath line — sessionPath goes right after it)
  </read_first>
  <behavior>
    - paths.sessionPath() returns the absolute path `<userData>/session.bin` using userDataRoot() exactly like apiKeyPath() does.
    - When TEST sets _setUserDataOverride('/tmp/foo'), paths.sessionPath() returns '/tmp/foo/session.bin' (override hook works automatically — no extra plumbing).
  </behavior>
  <action>
Edit `src/main/paths.ts`. Inside the `export const paths = { ... }` object, immediately after the existing `apiKeyPath: () => path.join(userDataRoot(), 'api_key.bin'),` line (line 29), add:

```typescript
  sessionPath: () => path.join(userDataRoot(), 'session.bin'),
```

Do not change any other line. Do not reorder.
  </action>
  <verify>
    <automated>grep -c "sessionPath: () => path.join(userDataRoot(), 'session.bin')" src/main/paths.ts | grep -q "^1$" && npx tsc --noEmit</automated>
  </verify>
  <acceptance_criteria>
    - `grep -cF "sessionPath: () => path.join(userDataRoot(), 'session.bin')" src/main/paths.ts` equals 1
    - `grep -cF "apiKeyPath: () => path.join(userDataRoot(), 'api_key.bin')" src/main/paths.ts` equals 1 (existing line preserved)
    - `npx tsc --noEmit` exits 0
  </acceptance_criteria>
  <done>
    paths.sessionPath() resolves to <userData>/session.bin and the existing _setUserDataOverride hook covers it automatically.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Create sessionStore.ts (safeStorage-backed Supabase StorageAdapter) + tests</name>
  <files>src/main/auth/sessionStore.ts, src/main/auth/sessionStore.test.ts</files>
  <read_first>
    - src/main/apiKeyStore.ts (template — copy atomicity recipe verbatim)
    - src/main/paths.ts (updated with sessionPath in Task 1)
    - src/main/auth/supabaseClient.ts (plan 01 — StorageAdapter interface)
    - .planning/phases/10-auth-foundation/10-RESEARCH.md §Pattern 3 (full code snippet) and §Pitfall A3 (corrupt-blob recovery contract)
  </read_first>
  <behavior>
    - saveJson(key, value) — encrypts `value` via safeStorage.encryptString, writes to <userData>/session.bin atomically (tmp+rename). The `key` argument is IGNORED (single-session design per CONTEXT Claude's discretion).
    - saveJson throws Error('SESSION_UNAVAILABLE') when safeStorage.isEncryptionAvailable() is false.
    - loadJson(key) — reads <userData>/session.bin, returns safeStorage.decryptString(buf). Returns null on ENOENT. On decrypt failure (any other throw), DELETES the corrupt blob and returns null (corrupt-blob-recovery contract; Pitfall A3 — never throw a decrypt error to Supabase JS).
    - removeJson(key) — unlinks the session.bin file; swallows ENOENT.
    - sessionBackendKind() returns the same string as apiKeyStore.backendKind() — used by plan 03's app:warnings extension to detect Linux 'basic_text'.
    - createSessionStorageAdapter() returns a StorageAdapter object wired to the three functions above.
    - Tests: vitest with tmp directory via _setUserDataOverride. (a) round-trip save→load yields the original string; (b) load with no file returns null; (c) load with a corrupt blob (write random bytes) returns null AND removes the file.
  </behavior>
  <action>
Create `src/main/auth/sessionStore.ts`:

```typescript
/**
 * Supabase session persistence via Electron safeStorage.
 *
 * Mirrors src/main/apiKeyStore.ts (single sealed blob; tmp+rename atomic write;
 * named error classes). Differences from apiKeyStore:
 *   - Path: <userData>/session.bin (vs api_key.bin)
 *   - Error classes: SESSION_UNAVAILABLE (vs KEYCHAIN_UNAVAILABLE)
 *   - Decrypt failure: auto-clears the blob and returns null
 *     (RESEARCH Pitfall A3 — corrupt session must not crash the app; user
 *     re-signs in instead)
 *   - Single-session: the `key` argument from Supabase's StorageAdapter is
 *     IGNORED. Per CONTEXT Claude's discretion ("single sealed blob"); multi-
 *     account is v1.x.
 *
 * SECURITY: Main-process only. Renderer and utilityProcess never import.
 *
 * Sources:
 *   - 10-RESEARCH §Pattern 3 (sessionStore.ts shape — full template)
 *   - 10-RESEARCH §Pitfall A3 (corrupt blob recovery contract)
 *   - 10-CONTEXT D-13 + Claude's discretion (single sealed session.bin)
 *   - src/main/apiKeyStore.ts (template — copy atomicity recipe verbatim)
 */
import { safeStorage } from 'electron';
import { readFile, writeFile, mkdir, unlink, rename } from 'node:fs/promises';
import path from 'node:path';
import { paths } from '../paths';
import type { StorageAdapter } from './supabaseClient';

export async function saveJson(_key: string, value: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('SESSION_UNAVAILABLE');
  }
  const buf = safeStorage.encryptString(value);
  const target = paths.sessionPath();
  const tmp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.tmp.${process.pid}.${Date.now()}`,
  );
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await writeFile(tmp, buf);
    await rename(tmp, target);
  } catch (err) {
    try { await unlink(tmp); } catch {}
    throw err;
  }
}

export async function loadJson(_key: string): Promise<string | null> {
  let buf: Buffer;
  try {
    buf = await readFile(paths.sessionPath());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err; // EACCES, ENOSPC, etc. — re-throw; not our problem
  }
  try {
    return safeStorage.decryptString(buf);
  } catch {
    // Corrupt blob — machine moved, keyring changed, file tampered.
    // Per RESEARCH Pitfall A3: clear and return null. The user signs in again.
    // NEVER throw to Supabase JS — it would surface as a confusing error
    // instead of a clean "logged out" state.
    try { await unlink(paths.sessionPath()); } catch {}
    return null;
  }
}

export async function removeJson(_key: string): Promise<void> {
  try { await unlink(paths.sessionPath()); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
}

/**
 * Identical to apiKeyStore.backendKind() but exposed here so consumers
 * can ask "what's protecting the SESSION blob" without importing the
 * api-key module. Both blobs use the same safeStorage instance, so the
 * answer is always the same — but the call site clarity matters when
 * plan 07's Banner asks "is the session unsafe on Linux?"
 *
 * Possible values: 'kwallet' | 'kwallet5' | 'kwallet6' | 'gnome_libsecret' |
 *                  'basic_text' | 'unknown'
 */
export function sessionBackendKind(): string {
  const fn = (safeStorage as { getSelectedStorageBackend?: () => string }).getSelectedStorageBackend;
  if (typeof fn !== 'function') return 'unknown';
  try { return fn.call(safeStorage); }
  catch { return 'unknown'; }
}

/**
 * Factory that returns the StorageAdapter Supabase JS expects. Plan 03's
 * bootstrap calls this and passes the result to setStorageAdapter() BEFORE
 * the first getClient() call.
 */
export function createSessionStorageAdapter(): StorageAdapter {
  return {
    getItem: (key) => loadJson(key),
    setItem: (key, value) => saveJson(key, value),
    removeItem: (key) => removeJson(key),
  };
}
```

Then create `src/main/auth/sessionStore.test.ts` with three vitest cases:

```typescript
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
import { saveJson, loadJson, removeJson, sessionBackendKind } from './sessionStore';

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
    await saveJson('ignored', payload);
    const got = await loadJson('ignored');
    expect(got).toBe(payload);
  });

  it('returns null when the session file does not exist (ENOENT)', async () => {
    const got = await loadJson('ignored');
    expect(got).toBeNull();
  });

  it('clears the file and returns null when the blob is corrupt', async () => {
    // Write garbage that the decrypt stub will reject
    await writeFile(paths.sessionPath(), Buffer.from('not-encrypted-bytes'));
    const got = await loadJson('ignored');
    expect(got).toBeNull();
    // File MUST have been removed
    await expect(readFile(paths.sessionPath())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removeJson is a no-op when the file does not exist', async () => {
    await expect(removeJson('ignored')).resolves.toBeUndefined();
  });

  it('sessionBackendKind() returns the stubbed backend string', () => {
    expect(sessionBackendKind()).toBe('gnome_libsecret');
  });
});
```
  </action>
  <verify>
    <automated>grep -c "export async function saveJson" src/main/auth/sessionStore.ts | grep -q "^1$" && grep -c "export async function loadJson" src/main/auth/sessionStore.ts | grep -q "^1$" && grep -c "export async function removeJson" src/main/auth/sessionStore.ts | grep -q "^1$" && grep -c "export function sessionBackendKind" src/main/auth/sessionStore.ts | grep -q "^1$" && grep -c "export function createSessionStorageAdapter" src/main/auth/sessionStore.ts | grep -q "^1$" && grep -c "SESSION_UNAVAILABLE" src/main/auth/sessionStore.ts | grep -q "^1$" && npx vitest run src/main/auth/sessionStore.test.ts 2>&1 | grep -E "✓.*sessionStore"</automated>
  </verify>
  <acceptance_criteria>
    - `grep -c 'export async function saveJson' src/main/auth/sessionStore.ts` equals 1
    - `grep -c 'export async function loadJson' src/main/auth/sessionStore.ts` equals 1
    - `grep -c 'export async function removeJson' src/main/auth/sessionStore.ts` equals 1
    - `grep -c 'export function sessionBackendKind' src/main/auth/sessionStore.ts` equals 1
    - `grep -c 'export function createSessionStorageAdapter' src/main/auth/sessionStore.ts` equals 1
    - `grep -c 'SESSION_UNAVAILABLE' src/main/auth/sessionStore.ts` equals 1
    - `grep -c 'paths.sessionPath' src/main/auth/sessionStore.ts` is at least 3 (save target + load + remove)
    - `grep -c 'safeStorage.encryptString' src/main/auth/sessionStore.ts` equals 1
    - `grep -c 'safeStorage.decryptString' src/main/auth/sessionStore.ts` equals 1
    - The corrupt-blob branch deletes the file: `grep -B1 -A3 'safeStorage.decryptString' src/main/auth/sessionStore.ts | grep -q 'unlink'`
    - `npx vitest run src/main/auth/sessionStore.test.ts` exits 0 with all 5 tests passing
    - `npx tsc --noEmit` exits 0
    - `grep -rn "from.*sessionStore" src/renderer src/preload src/utility 2>/dev/null | grep -v node_modules | wc -l` returns 0
  </acceptance_criteria>
  <done>
    sessionStore.ts implements the StorageAdapter contract over a single sealed <userData>/session.bin blob; corrupt blobs are auto-cleared; tests pass; renderer/preload/utility never import.
  </done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| Disk ↔ safeStorage | Session JSON (contains JWT + refresh token) is encrypted at rest via OS keychain. On Linux without kwallet/libsecret, the keychain is `basic_text` (effectively plaintext). |
| Disk ↔ untrusted modification | A corrupt session.bin (machine move, keyring reset, tampering) must not crash the app — Pitfall A3 contract. |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-10-02-01 | Information Disclosure | Linux `basic_text` backend reveals JWT + refresh token to any local process | mitigate | `sessionBackendKind()` returns 'basic_text' on detection. Plan 03 surfaces via `app:warnings` IPC; plan 07 shows the Banner with copy from UI-SPEC §LinuxKeyringBanner. User can install gnome-keyring/kwallet to fix. ASVS L1: warning-only acceptable for desktop apps. |
| T-10-02-02 | Tampering | A user (or malware) edits session.bin to inject a different JWT | mitigate | safeStorage's authenticated encryption catches it as a decrypt failure → corrupt-blob branch wipes the file and forces re-signin. Verified by test "clears the file and returns null when the blob is corrupt". |
| T-10-02-03 | Denial of Service | Process-crash mid-write leaves a partial session.bin | mitigate | tmp+rename atomic write (POSIX `rename(2)` atomic; same on NTFS / ReFS via Windows ReplaceFile). Cloned verbatim from apiKeyStore.ts which has shipped without partial-write reports since v0.1.0. |
| T-10-02-04 | Tampering | Renderer or utilityProcess imports sessionStore.ts | mitigate | Acceptance criterion grep-counts imports from non-main dirs == 0. |
| T-10-02-05 | Information Disclosure | Decrypt error log leaks the encrypted blob bytes to logs | accept | Decrypt catch block is silent — only the unlink is attempted; no logger call. (If logging is added in plan 03, it must log "corrupt session cleared" without the buffer contents.) |
</threat_model>

<verification>
1. `npx vitest run src/main/auth/sessionStore.test.ts` — all 5 tests pass.
2. `npx tsc --noEmit` exits 0.
3. `grep -c 'sessionPath' src/main/paths.ts` equals 1.
4. `grep -rn "from.*auth/sessionStore" src/renderer src/preload src/utility 2>/dev/null | grep -v node_modules | wc -l` returns 0.
</verification>

<success_criteria>
- sessionStore.ts mirrors apiKeyStore.ts shape exactly (tmp+rename atomic; safeStorage encrypt/decrypt; named error class)
- Corrupt-blob recovery wipes file + returns null (never throws decrypt error to Supabase JS)
- createSessionStorageAdapter() returns a Supabase-shaped StorageAdapter
- sessionBackendKind() exists for plan 03/07 to detect Linux 'basic_text'
- 5 vitest cases pass
- No renderer / preload / utility import
- tsc clean
</success_criteria>

<output>
After completion, create `.planning/phases/10-auth-foundation/10-02-SUMMARY.md` covering: the StorageAdapter implementation contract (single sealed blob, key argument ignored), the corrupt-blob recovery semantics (so plan 03 doesn't accidentally try to catch the decrypt error a second time), and the `sessionBackendKind()` surface plan 03 will wire into `app:warnings`.
</output>
