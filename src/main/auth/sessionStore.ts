/**
 * Supabase session persistence via Electron safeStorage.
 *
 * Mirrors src/main/apiKeyStore.ts (single sealed blob; tmp+rename atomic write;
 * named error classes). The blob holds a JSON dict keyed by the StorageAdapter
 * key argument: Supabase JS writes BOTH the session and the PKCE code-verifier
 * via separate keys, and earlier "ignore key, single value" semantics caused
 * the verifier to be overwritten by the auth-token write — making
 * exchangeCodeForSession fail on every email-confirmation link.
 *
 *   - Path: <userData>/session.bin
 *   - Format: encrypted JSON object: { [key]: value, ... }
 *   - Decrypt OR JSON-parse failure: auto-clears the blob and returns null
 *     (RESEARCH Pitfall A3 — corrupt session must not crash the app)
 *   - Atomic writes via tmp+rename so concurrent writers can't tear the JSON
 *
 * SECURITY: Main-process only. Renderer and utilityProcess never import.
 *
 * Sources:
 *   - 10-RESEARCH §Pattern 3 (sessionStore.ts shape)
 *   - 10-RESEARCH §Pitfall A3 (corrupt blob recovery contract)
 *   - src/main/apiKeyStore.ts (template — copy atomicity recipe verbatim)
 */
import { safeStorage } from 'electron';
import { readFile, writeFile, mkdir, unlink, rename } from 'node:fs/promises';
import path from 'node:path';
import { paths } from '../paths';
import type { StorageAdapter } from './supabaseClient';

async function readDict(): Promise<Record<string, string>> {
  let buf: Buffer;
  try {
    buf = await readFile(paths.sessionPath());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  let raw: string;
  try {
    raw = safeStorage.decryptString(buf);
  } catch (decryptErr) {
    // WR-05: distinguish transient keychain unavailability from permanent
    // corruption. safeStorage.decryptString can throw when:
    //   - the blob is genuinely corrupt (Pitfall A3) — delete + recover
    //   - the OS keyring is temporarily locked / not yet awake on cold boot
    //     (Linux gnome-keyring before unlock, macOS keychain in a locked
    //     state). Deleting the session blob in that case silently logs the
    //     user out AND wipes any in-flight PKCE code-verifier, breaking
    //     verification links the user clicked moments before.
    // safeStorage.isEncryptionAvailable() is the documented way to ask
    // "can we use the keyring right now?" — false means transient, so we
    // leave the blob intact and surface as "no session" until the next
    // launch (after the user unlocks their keyring).
    if (!safeStorage.isEncryptionAvailable()) {
      console.warn(
        `[sei] sessionStore: keyring unavailable on decrypt; leaving session.bin intact (transient)`,
      );
      return {};
    }
    console.warn(
      `[sei] sessionStore: decrypt failed and keyring IS available; treating as corruption and clearing: ${(decryptErr as Error).message}`,
    );
    try { await unlink(paths.sessionPath()); } catch {}
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
    try { await unlink(paths.sessionPath()); } catch {}
    return {};
  } catch {
    try { await unlink(paths.sessionPath()); } catch {}
    return {};
  }
}

async function writeDict(dict: Record<string, string>): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('SESSION_UNAVAILABLE');
  }
  const buf = safeStorage.encryptString(JSON.stringify(dict));
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

export async function saveJson(key: string, value: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('SESSION_UNAVAILABLE');
  }
  const dict = await readDict();
  dict[key] = value;
  await writeDict(dict);
}

export async function loadJson(key: string): Promise<string | null> {
  const dict = await readDict();
  return Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : null;
}

export async function removeJson(key: string): Promise<void> {
  const dict = await readDict();
  if (!Object.prototype.hasOwnProperty.call(dict, key)) return;
  delete dict[key];
  if (Object.keys(dict).length === 0) {
    try { await unlink(paths.sessionPath()); } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    return;
  }
  await writeDict(dict);
}

/**
 * Identical to apiKeyStore.safeStorageBackendKind() but exposed here so consumers
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
 * Substring identifying a Supabase auth-token entry inside the session blob's
 * keyed dict. Supabase JS persists the session under a key shaped like
 * `sb-<project-ref>-auth-token` (and, for large sessions, chunked variants
 * `…-auth-token.0`, `…-auth-token.1`). The PKCE code-verifier uses a DIFFERENT
 * key (`…-auth-token-code-verifier`) and is explicitly NOT counted as a session.
 */
const AUTH_TOKEN_KEY_SUBSTR = '-auth-token';
const CODE_VERIFIER_KEY_SUBSTR = 'code-verifier';

/**
 * Count the distinct Supabase SESSIONS currently persisted in the blob. A
 * session is keyed by `…-auth-token` (chunked variants `…-auth-token.N` all
 * belong to the SAME session, so the base key — everything up to `-auth-token`
 * — is the dedup key). The PKCE code-verifier key is excluded.
 */
function countSessions(dict: Record<string, string>): number {
  const bases = new Set<string>();
  for (const key of Object.keys(dict)) {
    if (!key.includes(AUTH_TOKEN_KEY_SUBSTR)) continue;
    if (key.includes(CODE_VERIFIER_KEY_SUBSTR)) continue;
    // Normalize chunk suffix (`…-auth-token.3` → `…-auth-token`) so a chunked
    // single session isn't miscounted as several.
    const idx = key.indexOf(AUTH_TOKEN_KEY_SUBSTR);
    bases.add(key.slice(0, idx + AUTH_TOKEN_KEY_SUBSTR.length));
  }
  return bases.size;
}

/**
 * SINGLE-ACTIVE-SESSION invariant (anti-abuse Outcome 1).
 *
 * Asserts the device holds AT MOST ONE Supabase session at a time — signing
 * into B must fully replace A, with no dual tokens / leaked refresh token. The
 * guarantee already holds by construction (one client singleton + one storage
 * adapter writing the auth-token under a single key → last-write-wins; see
 * supabaseClient.ts + ABUSE-GUARD-PLAN.md §3). This is a DEFENSIVE assertion
 * that fails loud if a future refactor ever introduces per-account session
 * keying.
 *
 * Returns the session count. When `throwOnViolation` is true, throws on >1
 * (used by the invariant test). In production callers should pass false and
 * log — never crash the app over a session-store anomaly.
 *
 * Logs NO session material — only the count.
 */
export async function assertSingleSession(throwOnViolation = false): Promise<number> {
  const dict = await readDict();
  const n = countSessions(dict);
  if (n > 1) {
    console.warn(`[sei] sessionStore: SINGLE-SESSION INVARIANT VIOLATED — ${n} sessions in blob`);
    if (throwOnViolation) {
      throw new Error(`SINGLE_SESSION_INVARIANT_VIOLATED: ${n} sessions persisted`);
    }
  }
  return n;
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
