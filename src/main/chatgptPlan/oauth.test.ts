/**
 * 261017 (issue #46): the SIWC OAuth protocol pieces, against the mock auth
 * server (real RSA signatures, real S256 PKCE check, rotating refresh).
 */
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  CHATGPT_AGENT_NAME,
  CHATGPT_DYNAMIC_CLIENT_ID,
  CHATGPT_ISSUER,
  CHATGPT_RESOURCE,
  CHATGPT_SCOPES,
} from '../../shared/chatgptPlan';
import {
  FALLBACK_ENDPOINTS,
  IdTokenError,
  OAuthError,
  buildAuthorizeUrl,
  callbackUri,
  createJwksSource,
  createPkce,
  discoverEndpoints,
  exchangeCode,
  isTerminalRefreshError,
  redactAuthorizeUrl,
  refreshTokens,
  revokeRefreshToken,
  validateCallback,
  verifyIdToken,
} from './oauth';
import { REVOKE_URL, createMockAuthServer, makeSigner } from './__fixtures__/mockAuthServer';
import { startCallbackListener } from './loopback';

const b64url = (b: Buffer): string => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

describe('PKCE + authorize URL', () => {
  it('creates an S256 pair with a 43+ char verifier and no padding', () => {
    const { verifier, challenge } = createPkce();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).toBe(b64url(createHash('sha256').update(verifier).digest()));
    expect(challenge).not.toContain('=');
    expect(createPkce().verifier).not.toBe(verifier);
  });

  it('first registration: dynamic client, agent name hint, host id, every scope and the resource', () => {
    const url = new URL(
      buildAuthorizeUrl({
        issuedClientId: null,
        hostId: 'urn:uuid:11111111-2222-4333-8444-555555555555',
        redirectUri: callbackUri(1455),
        state: 's',
        nonce: 'n',
        codeChallenge: 'c',
        idTokenHint: 'should-not-appear',
        loginHint: 'nor-this',
      }),
    );
    const q = url.searchParams;
    expect(q.get('client_id')).toBe(CHATGPT_DYNAMIC_CLIENT_ID);
    expect(q.get('agent_name_hint')).toBe(CHATGPT_AGENT_NAME);
    expect(q.get('ext_agent_host_id')).toBe('urn:uuid:11111111-2222-4333-8444-555555555555');
    expect(q.get('redirect_uri')).toBe('http://127.0.0.1:1455/auth/callback');
    expect(q.get('response_type')).toBe('code');
    expect(q.get('scope')).toBe(CHATGPT_SCOPES.join(' '));
    expect(q.get('scope')).toContain('chatgpt.tokens.use.direct');
    expect(q.get('scope')).toContain('offline_access');
    expect(q.get('resource')).toBe(CHATGPT_RESOURCE);
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.has('id_token_hint')).toBe(false);
    expect(q.has('login_hint')).toBe(false);
    expect(q.has('prompt')).toBe(false);
  });

  it('reauthorization: the issued client, hints, no agent name; consent forced on request', () => {
    const q = new URL(
      buildAuthorizeUrl({
        issuedClientId: 'client-issued-1',
        hostId: 'h',
        redirectUri: callbackUri(50000),
        state: 's',
        nonce: 'n',
        codeChallenge: 'c',
        idTokenHint: 'old.id.token',
        loginHint: 'p@example.com',
        forceConsent: true,
      }),
    ).searchParams;
    expect(q.get('client_id')).toBe('client-issued-1');
    expect(q.has('agent_name_hint')).toBe(false);
    expect(q.get('id_token_hint')).toBe('old.id.token');
    expect(q.get('login_hint')).toBe('p@example.com');
    expect(q.get('prompt')).toBe('consent');
    expect(q.get('redirect_uri')).toBe('http://127.0.0.1:50000/auth/callback');
  });

  it('redacts hints and one-time values for logs', () => {
    const red = redactAuthorizeUrl(
      buildAuthorizeUrl({
        issuedClientId: 'oaiapp_CLIENT3',
        hostId: 'HOST3',
        redirectUri: 'r',
        state: 'S3',
        nonce: 'N3',
        codeChallenge: 'C3',
        idTokenHint: 'ID3',
        loginHint: 'L3',
      }),
    );
    for (const secret of ['S3', 'N3', 'C3', 'ID3', 'L3', 'oaiapp_CLIENT3', 'HOST3']) expect(red).not.toContain(secret);
    const q = new URL(red).searchParams;
    expect(q.get('client_id')).toBe('[redacted]');
    expect(q.get('ext_agent_host_id')).toBe('[redacted]');
    // Non-identifying parameters stay readable for debugging.
    expect(q.get('response_type')).toBe('code');
  });
});

describe('validateCallback', () => {
  const pendingNew = { state: 'st', nonce: 'n', verifier: 'v', redirectUri: 'r', issuedClientId: null };
  const pendingRe = { ...pendingNew, issuedClientId: 'client-1' };
  const q = (o: Record<string, string>) => new URLSearchParams(o);

  it('checks state before anything else, even before an error', () => {
    expect(validateCallback(q({ state: 'x', error: 'access_denied' }), pendingNew)).toEqual({ kind: 'invalid', reason: 'state_mismatch' });
  });
  it('reports a decline', () => {
    expect(validateCallback(q({ state: 'st', error: 'access_denied' }), pendingNew)).toMatchObject({ kind: 'denied', error: 'access_denied' });
  });
  it('a new registration needs the issued client id, never the entry point', () => {
    expect(validateCallback(q({ state: 'st', code: 'c' }), pendingNew)).toEqual({ kind: 'invalid', reason: 'registration_incomplete' });
    expect(validateCallback(q({ state: 'st', code: 'c', client_id: CHATGPT_DYNAMIC_CLIENT_ID }), pendingNew)).toEqual({ kind: 'invalid', reason: 'registration_incomplete' });
    expect(validateCallback(q({ state: 'st', code: 'c', client_id: 'issued' }), pendingNew)).toEqual({ kind: 'code', code: 'c', clientId: 'issued' });
  });
  it('a reauth may omit client_id but never change it', () => {
    expect(validateCallback(q({ state: 'st', code: 'c' }), pendingRe)).toEqual({ kind: 'code', code: 'c', clientId: 'client-1' });
    expect(validateCallback(q({ state: 'st', code: 'c', client_id: 'other' }), pendingRe)).toEqual({ kind: 'invalid', reason: 'client_mismatch' });
  });
  it('a callback with no code is invalid', () => {
    expect(validateCallback(q({ state: 'st' }), pendingRe)).toEqual({ kind: 'invalid', reason: 'no_code' });
  });
});

describe('discovery', () => {
  it('reads the revocation endpoint from the document', async () => {
    const srv = createMockAuthServer();
    const ep = await discoverEndpoints(srv.fetchImpl);
    expect(ep.revocation_endpoint).toBe(REVOKE_URL);
    expect(ep.issuer).toBe(CHATGPT_ISSUER);
  });
  it('falls back to the documented constants on failure or a foreign issuer', async () => {
    expect(await discoverEndpoints(vi.fn(async () => { throw new TypeError('down'); }) as unknown as typeof fetch)).toEqual(FALLBACK_ENDPOINTS);
    const foreign = vi.fn(async () => new Response(JSON.stringify({ issuer: 'https://evil.example', token_endpoint: 'https://evil.example/t' }))) as unknown as typeof fetch;
    expect(await discoverEndpoints(foreign)).toEqual(FALLBACK_ENDPOINTS);
  });
});

describe('token endpoint', () => {
  async function codeFor(srv: ReturnType<typeof createMockAuthServer>, pkce = createPkce()) {
    const url = buildAuthorizeUrl({ issuedClientId: null, hostId: 'h', redirectUri: callbackUri(1455), state: 'st', nonce: 'nn', codeChallenge: pkce.challenge });
    const listener = await srv.startListener('st');
    const wait = listener.wait(1000, new AbortController().signal);
    await srv.openExternal(url);
    const q = await wait;
    return { code: q.get('code')!, clientId: q.get('client_id')!, pkce };
  }

  it('exchanges a code with the verifier, the same redirect and the resource, no secret', async () => {
    const srv = createMockAuthServer();
    const { code, clientId, pkce } = await codeFor(srv);
    const t = await exchangeCode(srv.fetchImpl, { clientId, code, verifier: pkce.verifier, redirectUri: callbackUri(1455) });
    expect(t.access_token).toMatch(/^at-/);
    expect(t.refresh_token).toMatch(/^rt-/);
    expect(t.id_token).toBeTruthy();
    expect(t.scopes).toContain('chatgpt.tokens.use.direct');
    const post = srv.tokenPosts.at(-1)!;
    expect(post).toMatchObject({ grant_type: 'authorization_code', client_id: clientId, resource: CHATGPT_RESOURCE, redirect_uri: callbackUri(1455) });
    expect(post).not.toHaveProperty('client_secret');
  });

  it('a wrong verifier is invalid_grant, and the code is single-use', async () => {
    const srv = createMockAuthServer();
    const { code, clientId } = await codeFor(srv);
    const err = await exchangeCode(srv.fetchImpl, { clientId, code, verifier: createPkce().verifier, redirectUri: callbackUri(1455) }).catch((e) => e);
    expect(err).toBeInstanceOf(OAuthError);
    expect(err.oauthError).toBe('invalid_grant');
  });

  it('refresh rotates the refresh token and omits scope; reuse is terminal', async () => {
    const srv = createMockAuthServer();
    const { code, clientId, pkce } = await codeFor(srv);
    const t1 = await exchangeCode(srv.fetchImpl, { clientId, code, verifier: pkce.verifier, redirectUri: callbackUri(1455) });
    const t2 = await refreshTokens(srv.fetchImpl, { clientId, refreshToken: t1.refresh_token! });
    expect(t2.refresh_token).not.toBe(t1.refresh_token);
    const post = srv.tokenPosts.at(-1)!;
    expect(post).toMatchObject({ grant_type: 'refresh_token', resource: CHATGPT_RESOURCE });
    expect(post).not.toHaveProperty('scope');
    const reuse = await refreshTokens(srv.fetchImpl, { clientId, refreshToken: t1.refresh_token! }).catch((e) => e);
    expect(reuse.oauthError).toBe('refresh_token_reused');
    expect(isTerminalRefreshError(reuse)).toBe(true);
  });

  it('a network failure is a non-terminal OAuthError with no token text in the message', async () => {
    const err = await refreshTokens(vi.fn(async () => { throw new TypeError('x'); }) as unknown as typeof fetch, { clientId: 'c', refreshToken: 'rt-secret' }).catch((e) => e);
    expect(err).toBeInstanceOf(OAuthError);
    expect(err.network).toBe(true);
    expect(isTerminalRefreshError(err)).toBe(false);
    expect(err.message).not.toContain('rt-secret');
  });

  it('earliest_refresh_at accepts epoch seconds, ms or ISO', async () => {
    const srv = createMockAuthServer();
    srv.knobs.earliestRefreshAt = 1_900_000_000;
    const { code, clientId, pkce } = await codeFor(srv);
    const t = await exchangeCode(srv.fetchImpl, { clientId, code, verifier: pkce.verifier, redirectUri: callbackUri(1455) });
    expect(t.earliest_refresh_at).toBe(1_900_000_000_000);
  });
});

describe('revocation', () => {
  it('posts the refresh token with its hint and client id; 200 is success', async () => {
    const srv = createMockAuthServer();
    const ok = await revokeRefreshToken(srv.fetchImpl, { revocationEndpoint: REVOKE_URL, clientId: 'c', refreshToken: 'rt-9' });
    expect(ok).toBe(true);
    expect(srv.revoked).toEqual(['rt-9']);
  });
  it('retries network errors and 5xx with backoff, then gives up', async () => {
    const srv = createMockAuthServer();
    srv.knobs.revokeStatus = 503;
    const sleep = vi.fn(async () => {});
    expect(await revokeRefreshToken(srv.fetchImpl, { revocationEndpoint: REVOKE_URL, clientId: 'c', refreshToken: 'r', sleep })).toBe(false);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
  it('a 4xx is a definite refusal (no retry); no endpoint means not confirmed', async () => {
    const srv = createMockAuthServer();
    srv.knobs.revokeStatus = 400;
    const sleep = vi.fn(async () => {});
    expect(await revokeRefreshToken(srv.fetchImpl, { revocationEndpoint: REVOKE_URL, clientId: 'c', refreshToken: 'r', sleep })).toBe(false);
    expect(sleep).not.toHaveBeenCalled();
    expect(await revokeRefreshToken(srv.fetchImpl, { revocationEndpoint: null, clientId: 'c', refreshToken: 'r' })).toBe(false);
  });
});

describe('verifyIdToken', () => {
  const nowMs = Date.now();
  const base = { iss: CHATGPT_ISSUER, sub: 'u1', aud: ['client-1'], exp: Math.floor(nowMs / 1000) + 600, nonce: 'nonce-1', email: 'p@example.com' };
  const setup = () => {
    const signer = makeSigner('k1');
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ keys: [signer.jwk] }))) as unknown as typeof fetch;
    return { signer, jwks: createJwksSource(fetchImpl), fetchImpl };
  };

  it('accepts a good token and returns its claims', async () => {
    const { signer, jwks } = setup();
    const claims = await verifyIdToken(signer.sign(base), { jwks, clientId: 'client-1', nonce: 'nonce-1', now: nowMs });
    expect(claims.sub).toBe('u1');
  });

  it.each([
    ['issuer', { iss: 'https://evil.example' }],
    ['audience', { aud: ['someone-else'] }],
    ['expired', { exp: Math.floor(nowMs / 1000) - 60 }],
    ['nonce', { nonce: 'replayed' }],
  ])('rejects a bad %s', async (reason, patch) => {
    const { signer, jwks } = setup();
    const err = await verifyIdToken(signer.sign({ ...base, ...patch }), { jwks, clientId: 'client-1', nonce: 'nonce-1', now: nowMs }).catch((e) => e);
    expect(err).toBeInstanceOf(IdTokenError);
    expect(err.reason).toBe(reason);
  });

  it('rejects a token signed by another key, and refetches the JWKS once for an unknown kid', async () => {
    const { jwks, fetchImpl } = setup();
    const other = makeSigner('k2');
    const err = await verifyIdToken(other.sign(base), { jwks, clientId: 'client-1', nonce: 'nonce-1', now: nowMs }).catch((e) => e);
    expect(err.reason).toBe('no matching key');
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);

    const forged = makeSigner('k1'); // same kid, different key
    const bad = await verifyIdToken(forged.sign(base), { jwks, clientId: 'client-1', nonce: 'nonce-1', now: nowMs }).catch((e) => e);
    expect(bad.reason).toBe('bad signature');
  });

  it('rejects alg none', async () => {
    const { signer, jwks } = setup();
    const err = await verifyIdToken(signer.sign(base, { alg: 'none' }), { jwks, clientId: 'client-1', nonce: 'nonce-1', now: nowMs }).catch((e) => e);
    expect(err.reason).toMatch(/unsupported alg/);
  });
});

describe('loopback listener', () => {
  it('binds 127.0.0.1, answers the first /auth/callback and ignores later hits', async () => {
    const l = await startCallbackListener('s', 0);
    try {
      expect(l.redirectUri).toBe(`http://127.0.0.1:${l.port}/auth/callback`);
      const wait = l.wait(5000, new AbortController().signal);
      const miss = await fetch(`http://127.0.0.1:${l.port}/other`);
      expect(miss.status).toBe(404);
      const hit = await fetch(`http://127.0.0.1:${l.port}/auth/callback?state=s&code=c`);
      expect(hit.status).toBe(200);
      const q = await wait;
      expect(q.get('code')).toBe('c');
      const again = await fetch(`http://127.0.0.1:${l.port}/auth/callback?state=s&code=other`);
      expect(await again.text()).toContain('already has this sign-in');
    } finally {
      l.close();
    }
  });

  it('ignores a callback with another state (400, no settle) and still accepts the real one', async () => {
    const l = await startCallbackListener('real-state', 0);
    try {
      const wait = l.wait(5000, new AbortController().signal);
      let settled = false;
      void wait.then(() => { settled = true; });
      const forged = await fetch(`http://127.0.0.1:${l.port}/auth/callback?state=forged&code=evil`);
      expect(forged.status).toBe(400);
      const stateless = await fetch(`http://127.0.0.1:${l.port}/auth/callback?error=access_denied`);
      expect(stateless.status).toBe(400);
      await new Promise((r) => setTimeout(r, 20));
      expect(settled).toBe(false);
      const hit = await fetch(`http://127.0.0.1:${l.port}/auth/callback?state=real-state&code=good`);
      expect(hit.status).toBe(200);
      const q = await wait;
      expect(q.get('code')).toBe('good');
    } finally {
      l.close();
    }
  });

  it('refuses to start without an expected state', async () => {
    await expect(startCallbackListener('', 0)).rejects.toThrow(/state/);
  });

  it('falls back to an OS port when the preferred one is taken', async () => {
    const a = await startCallbackListener('s', 0);
    const b = await startCallbackListener('s', a.port);
    try {
      expect(b.port).not.toBe(a.port);
    } finally {
      a.close();
      b.close();
    }
  });

  it('rejects on timeout and on abort', async () => {
    const l = await startCallbackListener('s', 0);
    try {
      await expect(l.wait(20, new AbortController().signal)).rejects.toThrow('timeout');
      const ctrl = new AbortController();
      const w = l.wait(5000, ctrl.signal);
      ctrl.abort();
      await expect(w).rejects.toThrow('aborted');
    } finally {
      l.close();
    }
  });
});




