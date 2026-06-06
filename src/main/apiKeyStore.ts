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
