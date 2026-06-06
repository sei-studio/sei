/**
 * Device-global device-id (anti-abuse / trial-claim hardening).
 *
 * MAIN PROCESS ONLY.
 *
 * A locally-generated random UUID v4 (`crypto.randomUUID()`) persisted at the
 * DEVICE-GLOBAL tier (`<userData>/device-id.json`, via `paths.deviceIdPath()`).
 * It is:
 *   - NOT hardware fingerprinting, NOT PII — just a random opaque token.
 *   - device-global: it lives directly under the userData root (NOT under any
 *     per-profile dir) so it SURVIVES account switches and sign-outs. This is
 *     what lets the trial-claim Edge Function enforce "one trial per device"
 *     independently of how many accounts are created on the machine.
 *
 * The id is sent to the `trial-claim` Edge Function as `body.device_id`; the
 * server hashes it (salted sha-256) and records the hash in
 * `trial_device_claims` (the device gate). See ABUSE-GUARD-PLAN.md §6.
 *
 * Atomic tmp+rename write mirrors `apiKeyStore.ts` / `sessionStore.ts`.
 *
 * NOTE (paths.ts partition refactor): `deviceIdPath()` MUST stay in the
 * DEVICE-GLOBAL tier when the in-progress global/profile partition merges —
 * never under `profiles/<scope>/`. See ABUSE-GUARD-PLAN.md §9.
 */
import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { paths } from '../paths';

/** RFC-4122 UUID shape (any version). The id is a random token, not a credential. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface DeviceIdFile {
  deviceId: string;
}

// In-process cache so repeated trial-claim attempts in one session don't re-read
// the file. The device id is immutable for the life of the install.
let cached: string | null = null;

async function readExisting(): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(paths.deviceIdPath(), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    // Any other read error (permissions, etc.) — treat as absent and regenerate.
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<DeviceIdFile>;
    if (typeof parsed?.deviceId === 'string' && UUID_RE.test(parsed.deviceId)) {
      return parsed.deviceId.toLowerCase();
    }
  } catch {
    // Corrupt JSON — fall through to regeneration.
  }
  return null;
}

async function writeAtomic(deviceId: string): Promise<void> {
  const target = paths.deviceIdPath();
  const tmp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.tmp.${process.pid}.${Date.now()}`,
  );
  await mkdir(path.dirname(target), { recursive: true });
  const payload: DeviceIdFile = { deviceId };
  try {
    await writeFile(tmp, JSON.stringify(payload), 'utf8');
    await rename(tmp, target);
  } catch (err) {
    try { await unlink(tmp); } catch {}
    throw err;
  }
}

/**
 * Read-or-create the device-global device id. Stable across calls (cached);
 * regenerates if the on-disk value is missing or corrupt. Never logs the id.
 *
 * If the write fails (e.g. read-only userData), the in-memory id is still
 * returned for THIS session so trial-claim can proceed — a non-persisted id
 * just means the device gate falls back to per-session uniqueness, which the
 * account gate backstops. (We do not throw — a device-id failure must never
 * block sign-in or trial-claim.)
 */
export async function getDeviceId(): Promise<string> {
  if (cached) return cached;
  const existing = await readExisting();
  if (existing) {
    cached = existing;
    return existing;
  }
  const fresh = randomUUID();
  try {
    await writeAtomic(fresh);
  } catch {
    // Best-effort persistence; still use the fresh id this session.
  }
  cached = fresh;
  return fresh;
}

/** TEST-ONLY: drop the in-process cache so the next call re-reads disk. */
export function _resetDeviceIdCacheForTests(): void {
  cached = null;
}
