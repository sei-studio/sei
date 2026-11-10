/**
 * BYOK ElevenLabs API key persistence via Electron safeStorage (260725).
 *
 * Mirrors src/main/apiKeyStore.ts: the plaintext key is encrypted by the OS
 * keychain and written atomically to a profile-scoped binary blob
 * (`<profileRoot>/elevenlabs_key.bin`). Decrypt happens ONLY in main; the
 * renderer can set/clear the key and query presence over IPC, but the full
 * key value never crosses back to the renderer.
 *
 * Why this exists: voice TTS/STT routes either through a dev env key
 * (SEI_TTS_DEV_KEY) or the cloud proxy with a Supabase JWT. BYOK ('local'
 * backend) users have neither, so before this store they had no voice at
 * all. `resolveElevenLabsKey` / `resolveElevenLabsRoute` below are the
 * single routing decision both tts.ts and stt.ts consume.
 *
 * 261020 (T158): a CLOUD user may store a key too, for one purpose only:
 * speaking and listing voices from their own ElevenLabs account (a clone of
 * their voice, a designed voice). Those calls use `resolveTtsRoute({ own:
 * true })` / `resolveOwnVoiceKey`. Everything else on cloud (Sei's pool
 * voices, STT) keeps the proxy route, so a stored key never bills the user's
 * ElevenLabs credits for what their plan already includes.
 */
import { safeStorage } from 'electron';
import { readFile, writeFile, access, mkdir, unlink, rename } from 'node:fs/promises';
import path from 'node:path';
import { paths } from '../paths';
import { getAiBackendKind } from '../apiKeyStore';

/**
 * Persist (or clear) the user's ElevenLabs API key.
 *   - `key: string` → trimmed and stored encrypted. An empty/whitespace-only
 *     string is rejected (throws `ELEVEN_KEY_EMPTY`) — pass null to clear.
 *   - `key: null`   → deletes the stored blob (ENOENT-tolerant).
 *
 * Same raw tmp+rename atomic write as apiKeyStore.saveApiKey: the encrypted
 * blob is binary, so the utf8 atomicWrite helper does not apply.
 */
export async function setElevenLabsKey(key: string | null): Promise<void> {
  if (key === null) {
    try {
      await unlink(paths.elevenLabsKeyPath());
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    return;
  }
  const trimmed = key.trim();
  if (!trimmed) throw new Error('ELEVEN_KEY_EMPTY');
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('KEYCHAIN_UNAVAILABLE');
  }
  const buf = safeStorage.encryptString(trimmed);
  const target = paths.elevenLabsKeyPath();
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

/** Whether an ElevenLabs key blob exists on disk for the active profile. */
export async function hasElevenLabsKey(): Promise<boolean> {
  try { await access(paths.elevenLabsKeyPath()); return true; }
  catch { return false; }
}

/**
 * Decrypt and return the stored ElevenLabs key, or null when none is stored.
 * Throws on a decrypt failure (e.g. keychain locked) — callers that only
 * need best-effort routing use resolveElevenLabsKey, which maps any failure
 * to null.
 */
export async function getElevenLabsKey(): Promise<string | null> {
  let buf: Buffer;
  try {
    buf = await readFile(paths.elevenLabsKeyPath());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  return safeStorage.decryptString(buf);
}

/**
 * The single ElevenLabs key resolution both tts.ts and stt.ts use.
 * Precedence:
 *   1. SEI_TTS_DEV_KEY env (dev shells) — always wins.
 *   2. The stored BYOK key, but ONLY when the AI backend is 'local'. A
 *      cloud-proxy user's voice traffic must keep flowing through the proxy
 *      (metered, key server-side), even if a key blob lingers from an
 *      earlier BYOK stint.
 *   3. null — route through the proxy (cloud) or fail as unconfigured (BYOK).
 * Best-effort: any read/decrypt error resolves to null, never throws.
 */
export async function resolveElevenLabsKey(): Promise<string | null> {
  const envKey = process.env.SEI_TTS_DEV_KEY;
  if (envKey) return envKey;
  try {
    if ((await getAiBackendKind()) !== 'local') return null;
    return await getElevenLabsKey();
  } catch {
    return null;
  }
}

/**
 * Routing decision derived from resolveElevenLabsKey + the backend kind:
 *   - direct       → talk to ElevenLabs with `key` (dev env or stored BYOK).
 *   - proxy        → cloud backend: route through the Sei proxy with the JWT.
 *   - unconfigured → BYOK ('local') with no key resolved: there is nothing
 *                    to call. TTS throws VOICE_NOT_CONFIGURED; STT returns
 *                    { unavailable, reason: 'no-credentials' }. BYOK must
 *                    never fall through to the proxy — the user may have no
 *                    session, and their choice was to not be metered.
 */
export type ElevenLabsRoute =
  | { kind: 'direct'; key: string }
  /** `seiVoices`: the ChatGPT-plan "Sei voices" choice (261110), see
   * resolveSpeakRoute. Its 402 is not Sei's credit wall: the line falls
   * back to an on-device voice instead (voice/tts.ts). */
  | { kind: 'proxy'; seiVoices?: boolean }
  | { kind: 'unconfigured' };

/** The proxy route of the "Sei voices" choice (see resolveSpeakRoute). */
export const SEI_VOICES_ROUTE: ElevenLabsRoute = { kind: 'proxy', seiVoices: true };

/**
 * 261110: the ChatGPT-plan user picked "Sei voices" on Playtime > ChatGPT >
 * Voice (seiVoicesActive). Best-effort: an unreadable config is false.
 */
export async function seiVoicesSelected(): Promise<boolean> {
  try {
    const { loadConfig } = await import('../configStore');
    const { seiVoicesActive, SEI_VOICES_FOR_CHATGPT_ENABLED } = await import('../../shared/ttsEngine');
    // Off until the proxy meters voice: never even read the config.
    if (!SEI_VOICES_FOR_CHATGPT_ENABLED) return false;
    return seiVoicesActive(await loadConfig());
  } catch {
    return false;
  }
}

/**
 * The SPEECH route (TTS only; STT keeps resolveElevenLabsRoute): "Sei
 * voices" goes through the proxy with the account's JWT, like a cloud call,
 * even on the local (ChatGPT plan) backend; everything else is
 * resolveElevenLabsRoute.
 */
export async function resolveSpeakRoute(): Promise<ElevenLabsRoute> {
  if (await seiVoicesSelected()) return SEI_VOICES_ROUTE;
  return resolveElevenLabsRoute();
}

export async function resolveElevenLabsRoute(): Promise<ElevenLabsRoute> {
  const key = await resolveElevenLabsKey();
  if (key) return { kind: 'direct', key };
  let backend: 'local' | 'cloud-proxy' = 'local';
  try {
    backend = await getAiBackendKind();
  } catch {
    /* unreadable config → the safe default, matching getAiBackendKind's own */
  }
  return backend === 'local' ? { kind: 'unconfigured' } : { kind: 'proxy' };
}


/**
 * The key that can list and speak the user's OWN ElevenLabs voices (261020):
 * the SEI_TTS_DEV_KEY env in dev shells, else the stored key on ANY backend.
 * Under 'local' this is the same key resolveElevenLabsKey returns; under
 * cloud it is the optional "your own ElevenLabs voices" key, which only ever
 * reaches ElevenLabs for an own voice (see resolveTtsRoute). Best-effort:
 * any read/decrypt failure resolves null.
 */
export async function resolveOwnVoiceKey(): Promise<string | null> {
  const envKey = process.env.SEI_TTS_DEV_KEY;
  if (envKey) return envKey;
  try {
    return await getElevenLabsKey();
  } catch {
    return null;
  }
}

/**
 * TTS route for ONE voice (261020, T158). `own` = the voice is from the
 * user's own ElevenLabs account (metadata.voiceOwn, see voiceAssign
 * ownVoicePickOf), never a Sei pool voice.
 *
 *   backend | voice | key stored | route
 *   --------+-------+------------+--------------------------------------
 *   local   | any   | yes        | direct (unchanged)
 *   local   | any   | no         | unconfigured (unchanged)
 *   cloud   | pool  | any        | proxy (plan pays; never the user's key)
 *   cloud   | own   | yes        | direct, ownKeyOnCloud: true
 *   cloud   | own   | no         | proxy (tts.ts swaps in the stand-in pool voice)
 *
 * `ownKeyOnCloud` marks the one case where the base route was the proxy and
 * the key was used only because the voice is the user's own: tts.ts may fall
 * back to the proxy (with a pool stand-in) when that key fails, which a BYOK
 * user's route must never do. The SEI_TTS_DEV_KEY env still wins everywhere.
 */
export async function resolveTtsRoute(opts: { own: boolean }): Promise<{
  route: ElevenLabsRoute;
  ownKeyOnCloud: boolean;
}> {
  const base = await resolveSpeakRoute();
  if (!opts.own || base.kind !== 'proxy') return { route: base, ownKeyOnCloud: false };
  const key = await resolveOwnVoiceKey();
  return key ? { route: { kind: 'direct', key }, ownKeyOnCloud: true } : { route: base, ownKeyOnCloud: false };
}
