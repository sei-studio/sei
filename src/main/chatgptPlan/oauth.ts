/**
 * 261017 (issue #46): the OAuth half of "Continue with ChatGPT" (OpenAI SIWC,
 * open-source flow). Protocol only: PKCE, the authorize URL, callback
 * validation, code exchange, refresh, revocation, discovery and ID-token
 * verification. No Electron, no storage; session.ts drives it and the tests
 * run it against a mocked auth server through the injectable `fetchImpl`.
 *
 * Contract (SIWC docs, "Registration and sign-in" + "Accounts and sessions"):
 *   - first registration: client_id=dynamic_agent_client + agent_name_hint +
 *     ext_agent_host_id; the callback returns the ISSUED client_id, which is
 *     what the exchange uses and what is saved;
 *   - reauthorization: the saved issued client_id, no agent_name_hint, the
 *     retained id_token as id_token_hint (+ email as login_hint);
 *   - fresh state, nonce and S256 PKCE per attempt;
 *   - redirect_uri http://127.0.0.1:<port>/auth/callback, identical in the
 *     authorize request and the exchange;
 *   - exchange/refresh are form posts with no client secret and
 *     resource=https://api.openai.com/v1; refresh omits scope.
 *
 * Token values never appear in errors or logs: every thrown message here is
 * built from status codes and OAuth error codes only.
 */
import { createHash, createPublicKey, randomBytes, verify as cryptoVerify } from 'node:crypto';

/** A JWK from the JWKS document (only the fields read here are typed). */
export type JsonWebKey = { kty?: string; kid?: string; [k: string]: unknown };
import {
  CHATGPT_AGENT_NAME,
  CHATGPT_AUTHORIZE_URL,
  CHATGPT_CALLBACK_PATH,
  CHATGPT_DISCOVERY_URL,
  CHATGPT_DYNAMIC_CLIENT_ID,
  CHATGPT_ISSUER,
  CHATGPT_JWKS_URL,
  CHATGPT_RESOURCE,
  CHATGPT_SCOPES,
  CHATGPT_TOKEN_URL,
} from '../../shared/chatgptPlan';

export type FetchLike = typeof fetch;

// â”€â”€â”€ PKCE / random values â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomToken(bytes = 32): string {
  return base64url(randomBytes(bytes));
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/** RFC 7636 S256: verifier = 43+ base64url chars, challenge = b64url(sha256(verifier)), no padding. */
export function createPkce(): PkcePair {
  const verifier = randomToken(48);
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function callbackUri(port: number): string {
  return `http://127.0.0.1:${port}${CHATGPT_CALLBACK_PATH}`;
}

// â”€â”€â”€ Discovery â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface OidcEndpoints {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  revocation_endpoint: string | null;
}

export const FALLBACK_ENDPOINTS: OidcEndpoints = {
  issuer: CHATGPT_ISSUER,
  authorization_endpoint: CHATGPT_AUTHORIZE_URL,
  token_endpoint: CHATGPT_TOKEN_URL,
  jwks_uri: CHATGPT_JWKS_URL,
  revocation_endpoint: null,
};

const httpsUrl = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' ? v : null;
  } catch {
    return null;
  }
};

/**
 * Read the OIDC discovery document. Any failure (network, junk, an issuer
 * that is not OpenAI's) returns the documented constants; the revocation
 * endpoint then stays null and sign-out says revocation was not confirmed.
 */
export async function discoverEndpoints(fetchImpl: FetchLike, timeoutMs = 8000): Promise<OidcEndpoints> {
  try {
    const resp = await fetchImpl(CHATGPT_DISCOVERY_URL, { signal: AbortSignal.timeout(timeoutMs) });
    if (!resp.ok) return FALLBACK_ENDPOINTS;
    const d = (await resp.json()) as Record<string, unknown>;
    if (d.issuer !== CHATGPT_ISSUER) return FALLBACK_ENDPOINTS;
    return {
      issuer: CHATGPT_ISSUER,
      authorization_endpoint: httpsUrl(d.authorization_endpoint) ?? CHATGPT_AUTHORIZE_URL,
      token_endpoint: httpsUrl(d.token_endpoint) ?? CHATGPT_TOKEN_URL,
      jwks_uri: httpsUrl(d.jwks_uri) ?? CHATGPT_JWKS_URL,
      revocation_endpoint: httpsUrl(d.revocation_endpoint),
    };
  } catch {
    return FALLBACK_ENDPOINTS;
  }
}

// â”€â”€â”€ Authorize URL â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface AuthorizeParams {
  endpoint?: string;
  /** null = new registration (dynamic_agent_client + agent_name_hint). */
  issuedClientId: string | null;
  hostId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
  /** Reauthorization only: the retained ID token (may be expired). */
  idTokenHint?: string | null;
  /** Reauthorization only: the saved email. */
  loginHint?: string | null;
  /** Explicit "enable plan usage" after a decline: prompt=consent. */
  forceConsent?: boolean;
}

export function buildAuthorizeUrl(p: AuthorizeParams): string {
  const u = new URL(p.endpoint ?? CHATGPT_AUTHORIZE_URL);
  const isNew = !p.issuedClientId;
  const q = u.searchParams;
  q.set('client_id', isNew ? CHATGPT_DYNAMIC_CLIENT_ID : p.issuedClientId!);
  if (isNew) q.set('agent_name_hint', CHATGPT_AGENT_NAME);
  q.set('ext_agent_host_id', p.hostId);
  if (!isNew && p.idTokenHint) q.set('id_token_hint', p.idTokenHint);
  if (!isNew && p.loginHint) q.set('login_hint', p.loginHint);
  q.set('response_type', 'code');
  q.set('redirect_uri', p.redirectUri);
  q.set('scope', CHATGPT_SCOPES.join(' '));
  q.set('resource', CHATGPT_RESOURCE);
  q.set('state', p.state);
  q.set('nonce', p.nonce);
  q.set('code_challenge_method', 'S256');
  q.set('code_challenge', p.codeChallenge);
  if (p.forceConsent) q.set('prompt', 'consent');
  return u.toString();
}

/**
 * For logs: the authorize URL with every hint, one-time value and install
 * identifier masked. client_id is the per-install issued client and
 * ext_agent_host_id a stable host id; both tie a log to one install.
 */
export function redactAuthorizeUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const k of ['id_token_hint', 'login_hint', 'state', 'nonce', 'code_challenge', 'client_id', 'ext_agent_host_id']) {
      if (u.searchParams.has(k)) u.searchParams.set(k, '[redacted]');
    }
    return u.toString();
  } catch {
    return '[unparseable authorize url]';
  }
}

// â”€â”€â”€ Callback validation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface PendingAttempt {
  state: string;
  nonce: string;
  verifier: string;
  redirectUri: string;
  /** null = new registration. */
  issuedClientId: string | null;
}

export type CallbackOutcome =
  | { kind: 'code'; code: string; clientId: string }
  | { kind: 'denied'; error: string; description: string | null }
  | { kind: 'invalid'; reason: 'state_mismatch' | 'registration_incomplete' | 'client_mismatch' | 'no_code' };

/**
 * Validate a callback's query against the pending attempt. Order matters:
 * state first (a forged callback must not even report "denied"), then an
 * OAuth error, then the client id rules.
 */
export function validateCallback(params: URLSearchParams, pending: PendingAttempt): CallbackOutcome {
  if (params.get('state') !== pending.state) return { kind: 'invalid', reason: 'state_mismatch' };
  const err = params.get('error');
  if (err) return { kind: 'denied', error: err, description: params.get('error_description') };
  const code = params.get('code');
  if (!code) return { kind: 'invalid', reason: 'no_code' };
  const cbClient = params.get('client_id');
  if (!pending.issuedClientId) {
    // New registration: the callback MUST name the issued client, and it is
    // never the registration entry point itself.
    if (!cbClient || cbClient === CHATGPT_DYNAMIC_CLIENT_ID) return { kind: 'invalid', reason: 'registration_incomplete' };
    return { kind: 'code', code, clientId: cbClient };
  }
  // Reauthorization: the callback may omit client_id; a DIFFERENT one is rejected.
  if (cbClient && cbClient !== pending.issuedClientId) return { kind: 'invalid', reason: 'client_mismatch' };
  return { kind: 'code', code, clientId: pending.issuedClientId };
}

// â”€â”€â”€ Token endpoint â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface TokenResponse {
  access_token: string;
  refresh_token: string | null;
  id_token: string | null;
  token_type: string;
  expires_in: number;
  scopes: string[];
  earliest_refresh_at: number | null;
}

/** A failed token-endpoint call. `oauthError` is the machine-readable code. */
export class OAuthError extends Error {
  constructor(
    readonly oauthError: string | null,
    readonly httpStatus: number | null,
    readonly requestId: string | null,
    readonly network = false,
  ) {
    super(
      network
        ? 'CHATGPT_OAUTH_NETWORK: could not reach the ChatGPT sign-in server'
        : `CHATGPT_OAUTH_ERROR: ${oauthError ?? 'unknown_error'}${httpStatus ? ` (HTTP ${httpStatus})` : ''}${requestId ? `, request ${requestId}` : ''}`,
    );
    this.name = 'OAuthError';
  }
}

/** Refresh error codes that mean the token set is dead (docs, "Refresh errors"). */
export const TERMINAL_REFRESH_ERRORS = new Set([
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
]);

export function isTerminalRefreshError(err: unknown): boolean {
  return err instanceof OAuthError && !!err.oauthError && TERMINAL_REFRESH_ERRORS.has(err.oauthError);
}

function requestIdOf(resp: Response): string | null {
  return resp.headers.get('openai-request-id') ?? resp.headers.get('x-request-id');
}

/** `earliest_refresh_at` may be epoch seconds, epoch ms or an ISO string. */
function parseEarliestRefresh(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n;
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

async function postForm(
  fetchImpl: FetchLike,
  url: string,
  form: Record<string, string>,
  timeoutMs: number,
): Promise<{ resp: Response; json: Record<string, unknown> | null }> {
  let resp: Response;
  try {
    resp = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new OAuthError(null, null, null, true);
  }
  let json: Record<string, unknown> | null = null;
  try {
    const text = await resp.text();
    json = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    json = null;
  }
  return { resp, json };
}

function tokenResponseOf(json: Record<string, unknown> | null, resp: Response): TokenResponse {
  const access = json?.access_token;
  if (typeof access !== 'string' || !access) throw new OAuthError('invalid_token_response', resp.status, requestIdOf(resp));
  const scope = typeof json?.scope === 'string' ? json.scope : '';
  const expiresIn = Number(json?.expires_in);
  return {
    access_token: access,
    refresh_token: typeof json?.refresh_token === 'string' && json.refresh_token ? json.refresh_token : null,
    id_token: typeof json?.id_token === 'string' && json.id_token ? json.id_token : null,
    token_type: typeof json?.token_type === 'string' ? json.token_type : 'Bearer',
    expires_in: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600,
    scopes: scope.split(/\s+/).filter(Boolean),
    earliest_refresh_at: parseEarliestRefresh(json?.earliest_refresh_at),
  };
}

function throwTokenError(resp: Response, json: Record<string, unknown> | null): never {
  const code = typeof json?.error === 'string' ? json.error : typeof (json?.error as { code?: unknown })?.code === 'string' ? ((json!.error as { code: string }).code) : null;
  throw new OAuthError(code, resp.status, requestIdOf(resp), false);
}

export async function exchangeCode(
  fetchImpl: FetchLike,
  p: { tokenEndpoint?: string; clientId: string; code: string; verifier: string; redirectUri: string; timeoutMs?: number },
): Promise<TokenResponse> {
  const { resp, json } = await postForm(
    fetchImpl,
    p.tokenEndpoint ?? CHATGPT_TOKEN_URL,
    {
      grant_type: 'authorization_code',
      client_id: p.clientId,
      code: p.code,
      code_verifier: p.verifier,
      redirect_uri: p.redirectUri,
      resource: CHATGPT_RESOURCE,
    },
    p.timeoutMs ?? 15_000,
  );
  if (!resp.ok) throwTokenError(resp, json);
  return tokenResponseOf(json, resp);
}

export async function refreshTokens(
  fetchImpl: FetchLike,
  p: { tokenEndpoint?: string; clientId: string; refreshToken: string; timeoutMs?: number },
): Promise<TokenResponse> {
  const { resp, json } = await postForm(
    fetchImpl,
    p.tokenEndpoint ?? CHATGPT_TOKEN_URL,
    {
      grant_type: 'refresh_token',
      client_id: p.clientId,
      refresh_token: p.refreshToken,
      resource: CHATGPT_RESOURCE,
    },
    p.timeoutMs ?? 15_000,
  );
  if (!resp.ok) throwTokenError(resp, json);
  return tokenResponseOf(json, resp);
}

/**
 * Revoke the refresh token. Resolves true on HTTP 200 (the docs: an empty 200
 * is success, also for an already-invalid token). Retries network errors and
 * 5xx with backoff; any other answer, or running out of tries, is false
 * (revocation not confirmed).
 */
export async function revokeRefreshToken(
  fetchImpl: FetchLike,
  p: {
    revocationEndpoint: string | null;
    clientId: string;
    refreshToken: string;
    attempts?: number;
    backoffMs?: number;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<boolean> {
  if (!p.revocationEndpoint) return false;
  const attempts = p.attempts ?? 3;
  const sleep = p.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 0; i < attempts; i++) {
    let status: number | null = null;
    try {
      const resp = await fetchImpl(p.revocationEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          token: p.refreshToken,
          token_type_hint: 'refresh_token',
          client_id: p.clientId,
        }).toString(),
        signal: AbortSignal.timeout(10_000),
      });
      status = resp.status;
      try { await resp.text(); } catch { /* drain */ }
    } catch {
      status = null; // network
    }
    if (status === 200) return true;
    if (status !== null && status < 500) return false; // a definite refusal: not retried
    if (i < attempts - 1) await sleep((p.backoffMs ?? 500) * 2 ** i);
  }
  return false;
}

// â”€â”€â”€ ID token â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface IdTokenClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat?: number;
  nonce?: string;
  email?: string;
  [k: string]: unknown;
}

export class IdTokenError extends Error {
  constructor(readonly reason: string) {
    super(`CHATGPT_ID_TOKEN_INVALID: ${reason}`);
    this.name = 'IdTokenError';
  }
}

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** Decode WITHOUT verifying (only for reading claims of an already-verified token). */
export function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(b64urlDecode(parts[1]).toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const ALGS: Record<string, { hash: string; kty: 'RSA' | 'EC'; pss?: boolean; dsaEncoding?: 'ieee-p1363' }> = {
  RS256: { hash: 'sha256', kty: 'RSA' },
  RS384: { hash: 'sha384', kty: 'RSA' },
  RS512: { hash: 'sha512', kty: 'RSA' },
  PS256: { hash: 'sha256', kty: 'RSA', pss: true },
  ES256: { hash: 'sha256', kty: 'EC', dsaEncoding: 'ieee-p1363' },
  ES384: { hash: 'sha384', kty: 'EC', dsaEncoding: 'ieee-p1363' },
};

export interface JwksSource {
  /** Returns the key set; `force` bypasses a cache (key rotation). */
  get(force?: boolean): Promise<JsonWebKey[]>;
}

/** JWKS fetcher with a 10-minute cache and one forced refetch on an unknown kid. */
export function createJwksSource(fetchImpl: FetchLike, url: string = CHATGPT_JWKS_URL): JwksSource {
  let cache: { at: number; keys: JsonWebKey[] } | null = null;
  return {
    async get(force = false) {
      if (!force && cache && Date.now() - cache.at < 10 * 60_000) return cache.keys;
      const resp = await fetchImpl(url, { signal: AbortSignal.timeout(8000) });
      if (!resp.ok) throw new IdTokenError(`jwks HTTP ${resp.status}`);
      const body = (await resp.json()) as { keys?: unknown };
      const keys = Array.isArray(body.keys) ? (body.keys as JsonWebKey[]) : [];
      cache = { at: Date.now(), keys };
      return keys;
    },
  };
}

/**
 * Verify an ID token: signature against the JWKS, iss exactly
 * https://auth.openai.com, aud contains the issued client id, exp (5 s skew),
 * and the nonce saved for this attempt. Returns the verified claims.
 */
export async function verifyIdToken(
  idToken: string,
  p: { jwks: JwksSource; clientId: string; nonce: string; now?: number; skewSec?: number },
): Promise<IdTokenClaims> {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new IdTokenError('malformed');
  let header: { alg?: string; kid?: string };
  try {
    header = JSON.parse(b64urlDecode(parts[0]).toString('utf8'));
  } catch {
    throw new IdTokenError('malformed header');
  }
  const alg = header.alg ? ALGS[header.alg] : undefined;
  if (!alg) throw new IdTokenError(`unsupported alg ${String(header.alg)}`);

  const pick = (keys: JsonWebKey[]): JsonWebKey | undefined =>
    keys.find((k) => (header.kid ? k.kid === header.kid : true) && k.kty === alg.kty);
  let jwk = pick(await p.jwks.get());
  if (!jwk && header.kid) jwk = pick(await p.jwks.get(true));
  if (!jwk) throw new IdTokenError('no matching key');

  const data = Buffer.from(`${parts[0]}.${parts[1]}`);
  const sig = b64urlDecode(parts[2]);
  let ok = false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const key = createPublicKey({ key: jwk as any, format: 'jwk' });
    ok = cryptoVerify(
      alg.hash,
      data,
      alg.pss
        ? { key, padding: 6 /* RSA_PKCS1_PSS_PADDING */, saltLength: 32 }
        : alg.dsaEncoding
          ? { key, dsaEncoding: alg.dsaEncoding }
          : key,
      sig,
    );
  } catch {
    ok = false;
  }
  if (!ok) throw new IdTokenError('bad signature');

  const claims = decodeJwtClaims(idToken) as IdTokenClaims | null;
  if (!claims) throw new IdTokenError('malformed claims');
  if (claims.iss !== CHATGPT_ISSUER) throw new IdTokenError('issuer');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(p.clientId)) throw new IdTokenError('audience');
  const now = Math.floor((p.now ?? Date.now()) / 1000);
  const skew = p.skewSec ?? 5;
  if (typeof claims.exp !== 'number' || claims.exp + skew < now) throw new IdTokenError('expired');
  if (claims.nonce !== p.nonce) throw new IdTokenError('nonce');
  if (typeof claims.sub !== 'string' || !claims.sub) throw new IdTokenError('subject');
  return claims;
}




