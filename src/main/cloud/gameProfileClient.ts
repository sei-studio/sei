/**
 * Per-game character profiles in the cloud (260925). MAIN PROCESS ONLY.
 *
 * Some games need per-character data an LLM derives once (first case: the
 * Stardew farmer appearance). It used to live in each user's local config, so
 * every user re-derived Sui, Lyra and Marv and each got a different look. The
 * row now lives in `public.character_game_profiles` (sei-proxy migration
 * 20260925120000), keyed (character_id, game, kind):
 *   - READ: supabase-js directly, under RLS (a profile is visible exactly when
 *     its character is: shared, or owned by the caller). Signed-out reads go
 *     through the anon key, so a shared character's row is readable offline
 *     from an account too.
 *   - WRITE: only through the proxy (POST /games/profile), which validates the
 *     data, authorizes the caller and applies FIRST WRITE WINS atomically. The
 *     response carries the row that is stored now, so a client that lost a
 *     race adopts the winner's data instead of its own.
 *
 * Both calls never throw. `ok: false` means "no answer" (signed out for a
 * write, offline, the table or route not deployed yet), and callers fall back
 * to the local cache: the feature degrades to the pre-cloud behavior rather
 * than breaking a summon.
 */
import { getClient } from '../auth/supabaseClient';

const PROXY_BASE = process.env.SEI_PROXY_URL ?? 'https://api.sei.gg';
const READ_TIMEOUT_MS = 5_000;
const WRITE_TIMEOUT_MS = 10_000;

export interface GameProfile {
  characterId: string;
  game: string;
  kind: string;
  data: unknown;
  source: 'auto' | 'user';
  version: number;
}

export type GameProfileRead = { ok: true; profile: GameProfile | null } | { ok: false; reason: string };
export type GameProfileWrite = { ok: true; won: boolean; profile: GameProfile } | { ok: false; reason: string };

function withTimeout<T>(p: PromiseLike<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    t.unref?.();
    Promise.resolve(p).then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

function toProfile(row: Record<string, unknown> | null | undefined): GameProfile | null {
  if (!row) return null;
  const characterId = row.character_id ?? row.characterId;
  const source = row.source === 'user' ? 'user' : row.source === 'auto' ? 'auto' : null;
  const version = typeof row.version === 'number' ? row.version : Number.NaN;
  if (typeof characterId !== 'string' || typeof row.game !== 'string' || typeof row.kind !== 'string') return null;
  if (!source || !Number.isInteger(version)) return null;
  return { characterId, game: row.game, kind: row.kind, data: row.data, source, version };
}

/** The stored profile, `profile: null` when there is none (or it is not visible to this caller). */
export async function readGameProfile(characterId: string, game: string, kind: string): Promise<GameProfileRead> {
  try {
    const query = getClient()
      .from('character_game_profiles')
      .select('character_id, game, kind, data, source, version')
      .eq('character_id', characterId)
      .eq('game', game)
      .eq('kind', kind)
      .maybeSingle();
    const { data, error } = await withTimeout(query, READ_TIMEOUT_MS, 'game profile read');
    if (error) return { ok: false, reason: error.message || String(error.code ?? 'error') };
    return { ok: true, profile: toProfile(data as Record<string, unknown> | null) };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

/**
 * Offer a profile. First write wins: `won: false` means another client's row
 * was kept, and `profile` is that row. Needs a signed-in session (any backend
 * mode); signed out is `ok: false` with reason 'no_session'.
 */
export async function writeGameProfile(args: {
  characterId: string;
  game: string;
  kind: string;
  version: number;
  source: 'auto' | 'user';
  data: unknown;
  replace?: boolean;
}): Promise<GameProfileWrite> {
  let jwt: string | null = null;
  try {
    const { data } = await getClient().auth.getSession();
    jwt = data.session?.access_token ?? null;
  } catch {
    jwt = null;
  }
  if (!jwt) return { ok: false, reason: 'no_session' };

  const controller = new AbortController();
  const handle = setTimeout(() => controller.abort(), WRITE_TIMEOUT_MS);
  handle.unref?.();
  try {
    const resp = await fetch(`${PROXY_BASE}/games/profile`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        characterId: args.characterId,
        game: args.game,
        kind: args.kind,
        version: args.version,
        source: args.source,
        data: args.data,
        ...(args.replace ? { replace: true } : {}),
      }),
      signal: controller.signal,
    });
    if (!resp.ok) return { ok: false, reason: `http_${resp.status}` };
    const body = (await resp.json()) as { ok?: boolean; won?: boolean; profile?: Record<string, unknown> };
    const profile = toProfile(body.profile);
    if (body.ok !== true || !profile) return { ok: false, reason: 'bad_response' };
    return { ok: true, won: body.won === true, profile };
  } catch (err) {
    return { ok: false, reason: (err as Error).name === 'AbortError' ? 'timeout' : (err as Error).message };
  } finally {
    clearTimeout(handle);
  }
}
