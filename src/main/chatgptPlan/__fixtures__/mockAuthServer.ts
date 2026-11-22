/**
 * 261017 (issue #46): a mock OpenAI auth server for the "Continue with
 * ChatGPT" tests. Test-only (imported from *.test.ts, never from app code).
 *
 * It answers the documented endpoints through a fetch double: discovery,
 * JWKS (a real RSA key, so ID-token verification runs the real crypto),
 * the token endpoint (authorization_code with a real S256 PKCE check, and
 * refresh_token with ROTATION and reuse detection), revocation, and
 * /v1/models. A fake browser (`openExternal`) plays the user: it reads the
 * authorize URL and answers the fake loopback listener with a callback.
 */
import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import {
  CHATGPT_DISCOVERY_URL,
  CHATGPT_DYNAMIC_CLIENT_ID,
  CHATGPT_ISSUER,
  CHATGPT_JWKS_URL,
  CHATGPT_MODELS_URL,
  CHATGPT_PLAN_SCOPE,
  CHATGPT_SCOPES,
  CHATGPT_TOKEN_URL,
} from '../../../shared/chatgptPlan';
import type { CallbackListener } from '../loopback';
import type { ChatgptVault, VaultData } from '../session';
import { emptyVault } from '../session';

export const REVOKE_URL = 'https://auth.openai.com/oauth/revoke';

const b64url = (b: Buffer | string): string =>
  Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function makeSigner(kid = 'k1') {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid, alg: 'RS256', use: 'sig' };
  return {
    jwk,
    sign(claims: Record<string, unknown>, header: Record<string, unknown> = {}): string {
      const h = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid, ...header }));
      const p = b64url(JSON.stringify(claims));
      const sig = cryptoSign('sha256', Buffer.from(`${h}.${p}`), privateKey);
      return `${h}.${p}.${b64url(sig)}`;
    },
  };
}

export interface MockUser {
  sub: string;
  email: string;
  /** Scopes the user grants (default: everything Sei asks for). */
  grant?: string[];
}

interface CodeRecord {
  clientId: string;
  challenge: string;
  redirectUri: string;
  nonce: string;
  user: MockUser;
  scopes: string[];
}

export interface AuthorizeSeen {
  url: URL;
  params: Record<string, string>;
}

export function createMockAuthServer(opts: { now?: () => number } = {}) {
  const now = opts.now ?? (() => Date.now());
  const signer = makeSigner();
  const codes = new Map<string, CodeRecord>();
  /** refresh token -> family state. A used token stays here, marked used. */
  const refreshTokens = new Map<string, { family: string; clientId: string; user: MockUser; scopes: string[]; used: boolean }>();
  const revoked: string[] = [];
  const authorizeSeen: AuthorizeSeen[] = [];
  const tokenPosts: Record<string, string>[] = [];
  let counter = 0;
  let issuedClientCounter = 0;

  /** Knobs a test turns. */
  const knobs = {
    user: { sub: 'user-1', email: 'player@example.com' } as MockUser,
    /** What the fake browser does with the next authorize. */
    browser: 'consent' as 'consent' | 'deny' | 'ignore' | 'forge_state' | 'omit_client',
    /** Answer the next refresh with this error (consumed). */
    nextRefreshError: null as null | { status: number; error: string } | 'network',
    /** Delay refresh answers (ms), to make concurrency observable. */
    refreshDelayMs: 0,
    revokeStatus: 200 as number | 'network',
    expiresIn: 3600,
    earliestRefreshAt: null as number | null,
    discoveryRevocation: true,
    // The SIWC catalog shape (docs, "Models"): `models[]` with slug + visibility.
    models: {
      models: [
        { slug: 'gpt-6', display_name: 'GPT-6', visibility: 'list', supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'high' }], input_modalities: ['text', 'image'] },
        { slug: 'gpt-6-luna', display_name: 'GPT-6 Luna', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }], input_modalities: ['text', 'image'] },
        { slug: 'internal-eval', visibility: 'hide' },
      ],
    } as unknown,
    idTokenOverride: null as null | ((claims: Record<string, unknown>) => string),
  };

  let listenerResolve: ((q: URLSearchParams) => void) | null = null;
  let listenerReject: ((e: Error) => void) | null = null;

  const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

  function issueTokens(clientId: string, user: MockUser, scopes: string[], nonce: string | null, family?: string) {
    counter += 1;
    const refresh = `rt-${counter}`;
    refreshTokens.set(refresh, { family: family ?? `fam-${counter}`, clientId, user, scopes, used: false });
    const claims = {
      iss: CHATGPT_ISSUER,
      sub: user.sub,
      aud: [clientId],
      exp: Math.floor(now() / 1000) + 3600,
      iat: Math.floor(now() / 1000),
      email: user.email,
      ...(nonce ? { nonce } : {}),
    };
    return {
      access_token: `at-${counter}`,
      refresh_token: refresh,
      id_token: knobs.idTokenOverride ? knobs.idTokenOverride(claims) : signer.sign(claims),
      token_type: 'Bearer',
      expires_in: knobs.expiresIn,
      scope: scopes.join(' '),
      ...(knobs.earliestRefreshAt !== null ? { earliest_refresh_at: knobs.earliestRefreshAt } : {}),
    };
  }

  const fetchImpl = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    if (url === CHATGPT_DISCOVERY_URL) {
      return json(200, {
        issuer: CHATGPT_ISSUER,
        authorization_endpoint: 'https://auth.openai.com/api/accounts/authorize',
        token_endpoint: CHATGPT_TOKEN_URL,
        jwks_uri: CHATGPT_JWKS_URL,
        ...(knobs.discoveryRevocation ? { revocation_endpoint: REVOKE_URL } : {}),
      });
    }
    if (url === CHATGPT_JWKS_URL) return json(200, { keys: [signer.jwk] });
    if (url === CHATGPT_TOKEN_URL) {
      const form = Object.fromEntries(new URLSearchParams(String(init.body ?? '')));
      tokenPosts.push(form);
      if (form.grant_type === 'authorization_code') {
        const rec = codes.get(form.code);
        if (!rec) return json(400, { error: 'invalid_grant' });
        codes.delete(form.code); // one-time
        const challenge = b64url(createHash('sha256').update(form.code_verifier ?? '').digest());
        if (challenge !== rec.challenge || form.redirect_uri !== rec.redirectUri || form.client_id !== rec.clientId) {
          return json(400, { error: 'invalid_grant' });
        }
        return json(200, issueTokens(rec.clientId, rec.user, rec.scopes, rec.nonce));
      }
      if (form.grant_type === 'refresh_token') {
        if (knobs.refreshDelayMs) await new Promise((r) => setTimeout(r, knobs.refreshDelayMs));
        const fail = knobs.nextRefreshError;
        if (fail) {
          knobs.nextRefreshError = null;
          if (fail === 'network') throw new TypeError('fetch failed');
          return json(fail.status, { error: fail.error });
        }
        const rec = refreshTokens.get(form.refresh_token);
        if (!rec || rec.clientId !== form.client_id) return json(400, { error: 'invalid_grant' });
        if (rec.used) return json(400, { error: 'refresh_token_reused' });
        rec.used = true; // rotation: this refresh token is now spent
        return json(200, issueTokens(rec.clientId, rec.user, rec.scopes, null, rec.family));
      }
      return json(400, { error: 'unsupported_grant_type' });
    }
    if (url === REVOKE_URL) {
      const form = Object.fromEntries(new URLSearchParams(String(init.body ?? '')));
      if (knobs.revokeStatus === 'network') throw new TypeError('fetch failed');
      revoked.push(form.token);
      return new Response('', { status: knobs.revokeStatus });
    }
    if (url === CHATGPT_MODELS_URL) {
      const auth = new Headers(init.headers).get('authorization') ?? '';
      if (!auth.startsWith('Bearer at-')) return json(401, { error: { code: 'invalid_token' } });
      return json(200, knobs.models);
    }
    return json(404, { error: 'not_found' });
  };

  /**
   * The fake loopback listener (no socket). It records the state it was
   * bound to but stays permissive, so validateCallback's own state check is
   * still exercised by the forge_state mode; the real listener's filter is
   * tested against a real socket in oauth.test.ts.
   */
  const listenerStates: string[] = [];
  const startListener = async (expectedState: string): Promise<CallbackListener> => {
    listenerStates.push(expectedState);
    return {
      port: 1455,
      redirectUri: 'http://127.0.0.1:1455/auth/callback',
      wait(_timeoutMs, signal) {
        return new Promise((resolve, reject) => {
          listenerResolve = resolve;
          listenerReject = reject;
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      },
      close() {
        listenerResolve = null;
        listenerReject = null;
      },
    };
  };

  /** The fake browser + user. */
  const openExternal = async (raw: string): Promise<void> => {
    const url = new URL(raw);
    const params = Object.fromEntries(url.searchParams);
    authorizeSeen.push({ url, params });
    const mode = knobs.browser;
    if (mode === 'ignore') return;
    // Answer on a later tick, like a real browser redirect.
    setTimeout(() => {
      const q = new URLSearchParams();
      q.set('state', mode === 'forge_state' ? 'forged' : params.state);
      if (mode === 'deny') {
        q.set('error', 'access_denied');
        listenerResolve?.(q);
        return;
      }
      const isNew = params.client_id === CHATGPT_DYNAMIC_CLIENT_ID;
      const clientId = isNew ? `client-issued-${++issuedClientCounter}` : params.client_id;
      const code = `code-${++counter}`;
      const asked = (params.scope ?? '').split(' ');
      const granted: readonly string[] = knobs.user.grant ?? CHATGPT_SCOPES;
      codes.set(code, {
        clientId,
        challenge: params.code_challenge,
        redirectUri: params.redirect_uri,
        nonce: params.nonce,
        user: knobs.user,
        scopes: asked.filter((s) => granted.includes(s)),
      });
      q.set('code', code);
      if (mode !== 'omit_client') q.set('client_id', clientId);
      listenerResolve?.(q);
    }, 0);
  };

  return {
    knobs,
    fetchImpl: fetchImpl as typeof fetch,
    startListener,
    listenerStates,
    openExternal,
    signer,
    authorizeSeen,
    tokenPosts,
    revoked,
    refreshTokens,
    rejectListener: (e: Error) => listenerReject?.(e),
    planScope: CHATGPT_PLAN_SCOPE,
  };
}

/** An in-memory vault (the safeStorage one is Electron-only). */
export function memoryVault(initial?: VaultData) {
  let stored: VaultData = initial ? structuredClone(initial) : emptyVault();
  let key = 'profile-a';
  const saves: VaultData[] = [];
  const vault: ChatgptVault & { fail: boolean } = {
    fail: false,
    key: () => key,
    async load() {
      return structuredClone(stored);
    },
    async save(d) {
      if (vault.fail) throw new Error('KEYCHAIN_UNAVAILABLE');
      stored = structuredClone(d);
      saves.push(structuredClone(d));
    },
  };
  return {
    vault,
    saves,
    read: () => structuredClone(stored),
    switchProfile(next: string, data?: VaultData) {
      key = next;
      stored = data ? structuredClone(data) : emptyVault();
    },
  };
}




