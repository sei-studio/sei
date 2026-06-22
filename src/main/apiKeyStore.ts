/**
 * API key persistence via Electron safeStorage.
 *
 * Sources:
 *   - PATTERNS §src/main/apiKeyStore.ts
 *   - RESEARCH §Pattern 4 + Pitfall 3 (Linux basic_text fallback)
 *   - CONTEXT D-13
 *
 * SECURITY: This module is main-process only. The renderer NEVER imports
 * from here. Plaintext crosses to utilityProcess via MessagePortMain only.
 */
import { safeStorage } from 'electron';
import { readFile, writeFile, access, mkdir, unlink, rename } from 'node:fs/promises';
import path from 'node:path';
import { paths } from './paths';
import { loadConfig, saveConfig } from './configStore';

/**
 * Persist plaintext API key encrypted by OS keychain.
 * Note: We use raw fs.writeFile (with a tmp+rename to keep it atomic) instead
 * of the brain's atomicWrite helper because that helper writes utf8 strings —
 * the encrypted blob is binary and must be written as Buffer.
 */
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

export async function hasApiKey(): Promise<boolean> {
  try { await access(paths.apiKeyPath()); return true; }
  catch { return false; }
}

/**
 * Decrypt and return the plaintext API key. Throws if the file is missing
 * or decrypt fails (e.g., user is locked out of Keychain). Caller maps to
 * the `KEYCHAIN_LOCKED` ErrorClass.
 */
export async function loadApiKey(): Promise<string> {
  const buf = await readFile(paths.apiKeyPath());
  return safeStorage.decryptString(buf);
}

/**
 * Returns the safeStorage backend name. On Linux without a desktop secret
 * store this returns `'basic_text'`, signalling that encryption is using a
 * hardcoded key (effectively plaintext) — surfaced to the user as the
 * KEYCHAIN_FALLBACK_PLAINTEXT warning per RESEARCH Pitfall 3.
 *
 * Possible values: 'kwallet' | 'kwallet5' | 'kwallet6' | 'gnome_libsecret' |
 *                  'basic_text' | 'unknown' (older Electron without API)
 *
 * Phase 13 13-02 (D-57 / PATTERNS Option A): renamed from `backendKind()` to
 * `safeStorageBackendKind()` to make room for the AI-backend concept exposed
 * via `getAiBackendKind()` below. The two values answer different questions:
 *   - `safeStorageBackendKind()` → which OS keychain implementation is
 *     encrypting the on-disk secret blobs (api-key.bin / session.bin).
 *   - `getAiBackendKind()` → whether the bot routes Anthropic traffic through
 *     the user's local API key (BYOK) or through Sei's cloud proxy.
 */
export function safeStorageBackendKind(): string {
  const fn = (safeStorage as { getSelectedStorageBackend?: () => string }).getSelectedStorageBackend;
  if (typeof fn !== 'function') return 'unknown';
  try { return fn.call(safeStorage); }
  catch { return 'unknown'; }
}

/* -------------------------------------------------------------------------- */
/*  AI backend kind (Phase 13 — PROXY-11)                                     */
/* -------------------------------------------------------------------------- */

/**
 * Which AI backend is active for the current user.
 *   - 'local'       → BYOK; bot uses the on-disk `api-key.bin` to talk to
 *                      Anthropic directly. NO credits UI surfaces in the
 *                      renderer (D-57).
 *   - 'cloud-proxy' → Sei's Fly.io-hosted proxy gates Anthropic calls. The
 *                      renderer shows the pricing icon, credits screen, and
 *                      hard-stop modal off this value.
 *
 * Persisted at `<userData>/config.json` under `ai_backend_kind`. Default is
 * `'local'` so existing users (and dev/CI) see no behavior change.
 */
export type AiBackendKind = 'local' | 'cloud-proxy';

/**
 * Read the persisted AI backend kind. Defaults to `'local'` when the
 * `ai_backend_kind` field is absent from config.json (existing users + first
 * launch).
 *
 * D-57: this is the SINGLE source of truth for credits-UI visibility — every
 * gate (PricingIcon, CreditsScreen, HardStopModal) reads from a store that
 * shadows this value, never via duplicated logic.
 */
export async function getAiBackendKind(): Promise<AiBackendKind> {
  const cfg = await loadConfig();
  return cfg.ai_backend_kind ?? 'local';
}

/**
 * Persist the AI backend kind. Round-trips through configStore.saveConfig so
 * the Zod schema + atomic write + file-lock semantics are inherited.
 */
export async function setAiBackendKind(kind: AiBackendKind): Promise<void> {
  const cfg = await loadConfig();
  await saveConfig({ ...cfg, ai_backend_kind: kind });
}

/**
 * Boot-time self-heal: ensure a signed-in profile that never received the
 * cloud default lands on cloud-proxy.
 *
 * Signed-in users default to cloud. That default is written on the signed-out→
 * signed-in TRANSITION (profileScope.switchScopeForAuth → setAiBackendKind), but
 * NOT on a session-restore launch: boot pre-points the scope from the persisted
 * session, so the INITIAL_SESSION auth event finds the scope already correct and
 * `switchScopeForAuth` early-returns. A profile whose last real transition
 * happened on a build that predates the cloud default — or whose one-time write
 * failed — therefore stays on the schema default `'local'` on every later
 * launch, showing the BYOK UI the user never asked for.
 *
 * Correct it here, at boot, after the scope + config are settled: when the
 * active profile is signed in, on `'local'`, and has NO stored API key, switch
 * it to `'cloud-proxy'`. A genuine BYOK user always has a key on disk, so a
 * deliberate local choice is never overridden; a key-less signed-in `'local'`
 * is a non-functional state that can only come from the missing default.
 *
 * No-op when signed out, already cloud-proxy, or an API key is present.
 */
export async function ensureCloudDefaultForSignedIn(): Promise<void> {
  const { getActiveScope, SCOPE_LOCAL } = await import('./paths');
  if (getActiveScope() === SCOPE_LOCAL) return; // signed out → keep local
  const cfg = await loadConfig();
  if ((cfg.ai_backend_kind ?? 'local') !== 'local') return; // already cloud-proxy
  if (await hasApiKey()) return; // a real BYOK choice — never override it
  await saveConfig({ ...cfg, ai_backend_kind: 'cloud-proxy' });
}
