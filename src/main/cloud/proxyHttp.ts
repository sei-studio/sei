/**
 * Small JSON + download helpers for sei-proxy routes that answer plain JSON
 * on the user's Sei JWT (Anima, the avatar library). Main process only.
 */
import { getProxyJwt, ProxyAuthError } from '../auth/proxyJwtFetcher';

/** Proxy base URL (proxyClient.ts's rule). `SEI_PROXY_URL` overrides for dev. */
export const PROXY_BASE = process.env.SEI_PROXY_URL ?? 'https://api.sei.gg';
const API_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 180_000;
const UPLOAD_TIMEOUT_MS = 300_000;

/**
 * Call a proxy route with the user's Sei JWT. Throws `noSession()` when
 * signed out; a network error or timeout throws as is.
 */
export async function proxyJson(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  route: string,
  body: unknown,
  noSession: () => Error,
): Promise<{ status: number; body: unknown }> {
  let jwt: string;
  try {
    jwt = await getProxyJwt();
  } catch (err) {
    if (err instanceof ProxyAuthError && err.code === 'PROXY_NO_SESSION') throw noSession();
    throw err;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS);
  try {
    const res = await fetch(`${PROXY_BASE}${route}`, {
      method,
      headers: { authorization: `Bearer ${jwt}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, body: json };
  } finally {
    clearTimeout(timer);
  }
}

/** GET a (signed) URL, at most maxBytes. */
export async function downloadCapped(url: string, maxBytes: number): Promise<Uint8Array> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok || !res.body) throw new Error(`download ${res.status}`);
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > maxBytes) throw new Error('download too big');
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        ctrl.abort();
        throw new Error('download too big');
      }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.byteLength;
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}

/** PUT bytes to a Supabase Storage signed upload URL. */
export async function putSigned(url: string, bytes: Uint8Array, mime: string): Promise<void> {
  if (!/^https:\/\//i.test(url)) throw new Error('upload url');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': mime, 'x-upsert': 'false' },
      body: new Blob([new Uint8Array(bytes)], { type: mime }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`upload ${res.status}`);
  } finally {
    clearTimeout(timer);
  }
}
