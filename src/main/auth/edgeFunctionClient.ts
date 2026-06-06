/**
 * Typed wrapper for Supabase Edge Function fetches.
 *
 * Phase 10 uses this for delete-me; Phase 11/12 reuse for additional admin
 * operations (per CONTEXT D-13 — Phase 10 sets the supabase/ convention).
 *
 * Contract:
 *   - Adds Authorization: Bearer <jwt> + content-type: application/json.
 *   - Wraps every call in a 15s default timeout via an abort signal.
 *   - Body is JSON-stringified when present.
 *   - Returns a discriminated union — never throws. Timeout → status:0,
 *     message:'timeout'. Network → status:0, message:<error.message>.
 *
 * Source: 10-RESEARCH §Pitfall A5 (CORS — not needed for main-process fetch
 * but template is future-proof), §Edge Function example (URL shape).
 */
import { getSupabaseUrl } from '../env';

export interface EdgeFunctionOptions {
  jwt: string;
  method?: 'POST' | 'GET';
  body?: unknown;
  timeoutMs?: number;
}

export type EdgeFunctionResponse =
  | { ok: true; status: number; json: unknown }
  | { ok: false; status: number; message: string; json?: unknown };

export async function callEdgeFunction(
  name: string,
  opts: EdgeFunctionOptions,
): Promise<EdgeFunctionResponse> {
  const url = `${getSupabaseUrl()}/functions/v1/${name}`;
  const method = opts.method ?? 'POST';
  const timeoutMs = opts.timeoutMs ?? 15_000;

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${opts.jwt}`,
        'content-type': 'application/json',
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });

    // 204 No Content carries no body. Other responses may also be empty if the
    // Edge Function returns plain text — guard the .json() call defensively.
    let json: unknown = undefined;
    if (res.status !== 204) {
      try {
        json = await res.json();
      } catch {
        json = undefined;
      }
    }

    if (res.ok) {
      return { ok: true, status: res.status, json };
    }
    const message =
      json &&
      typeof json === 'object' &&
      'error' in json &&
      typeof (json as { error: unknown }).error === 'string'
        ? (json as { error: string }).error
        : res.statusText || `HTTP ${res.status}`;
    return { ok: false, status: res.status, message, json };
  } catch (err) {
    const e = err as { name?: string; message?: string };
    const isAbort = e.name === 'AbortError';
    return { ok: false, status: 0, message: isAbort ? 'timeout' : e.message ?? 'network' };
  } finally {
    clearTimeout(timeoutHandle);
  }
}
