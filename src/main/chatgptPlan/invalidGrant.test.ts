/**
 * 261123 (T-A): "Continue with ChatGPT" failing with exchange_failed /
 * invalid_grant on every try, with no recovery (Windows, 0.7.0).
 *
 * Runs the real session against a FAKE OAuth server over real HTTP on
 * 127.0.0.1 (token endpoint + JWKS override) and the real loopback callback
 * listener; the "browser" is a fetch to the redirect URI. Nothing here may
 * reach OpenAI: the fetch guard throws on any other host.
 *
 * The fake token endpoint follows the SIWC rules (one-time codes, S256 PKCE,
 * exact redirect_uri, client_id bound to the code). `refuse` models the field
 * failure: a code minted for a NEW registration (client_id=
 * dynamic_agent_client) is answered invalid_grant, which the SIWC docs say to
 * recover from by "a fresh authorization with the issued client ID retained
 * for this attempt". Before the fix the issued client id was dropped and
 * every retry registered again, so the user could never get through.
 */
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { CHATGPT_DYNAMIC_CLIENT_ID, CHATGPT_ISSUER, CHATGPT_SCOPES } from '../../shared/chatgptPlan';
import { makeSigner, memoryVault } from './__fixtures__/mockAuthServer';
import { startCallbackListener, type CallbackListener } from './loopback';
import { createChatgptSession, signInFailureClass, signInFailureDetail } from './session';

const HOST = 'urn:uuid:11111111-2222-4333-8444-555555555555';
const b64url = (b: Buffer): string => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

interface Code {
  clientId: string;
  newRegistration: boolean;
  challenge: string;
  redirectUri: string;
  nonce: string;
}

async function fakeOpenAi(opts: { refuse: 'none' | 'new_registration' | 'all'; prefetch?: boolean }) {
  const signer = makeSigner();
  const codes = new Map<string, Code>();
  const redeemed = new Map<string, number>();
  const authorizes: Record<string, string>[] = [];
  const tokenPosts: Record<string, string>[] = [];
  const listeners: { state: string; listener: CallbackListener; closed: boolean }[] = [];
  let n = 0;

  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = (status: number, j: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(j));
      };
      if (req.method !== 'POST' || req.url !== '/oauth/token') return send(404, {});
      const f = Object.fromEntries(new URLSearchParams(body));
      tokenPosts.push(f);
      redeemed.set(f.code, (redeemed.get(f.code) ?? 0) + 1);
      const rec = codes.get(f.code);
      if (!rec) return send(400, { error: 'invalid_grant' });
      codes.delete(f.code); // one-time
      const pkceOk = b64url(createHash('sha256').update(f.code_verifier ?? '').digest()) === rec.challenge;
      if (!pkceOk || f.redirect_uri !== rec.redirectUri || f.client_id !== rec.clientId) return send(400, { error: 'invalid_grant' });
      if (opts.refuse === 'all' || (opts.refuse === 'new_registration' && rec.newRegistration)) {
        return send(400, { error: 'invalid_grant', error_description: 'refused' });
      }
      const now = Math.floor(Date.now() / 1000);
      send(200, {
        access_token: `at-${++n}`,
        refresh_token: `rt-${n}`,
        id_token: signer.sign({ iss: CHATGPT_ISSUER, sub: 'user-1', aud: [rec.clientId], exp: now + 3600, iat: now, email: 'p@example.com', nonce: rec.nonce }),
        token_type: 'Bearer',
        expires_in: 3600,
        scope: CHATGPT_SCOPES.join(' '),
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  /** Real fetch, loopback only. */
  const fetchImpl: typeof fetch = (input, init) => {
    const u = new URL(String(input instanceof Request ? input.url : input));
    if (u.hostname !== '127.0.0.1') throw new Error(`test must not leave loopback: ${u.host}`);
    return fetch(input, init);
  };

  let issued = 0;
  /** The browser + user: consent, then follow the redirect to the loopback listener. */
  const openExternal = async (raw: string): Promise<void> => {
    const p = Object.fromEntries(new URL(raw).searchParams);
    authorizes.push(p);
    const newRegistration = p.client_id === CHATGPT_DYNAMIC_CLIENT_ID;
    const clientId = newRegistration ? `oaiapp_issued_${++issued}` : p.client_id;
    const code = `ac_${++n}`;
    codes.set(code, { clientId, newRegistration, challenge: p.code_challenge, redirectUri: p.redirect_uri, nonce: p.nonce });
    const cb = new URL(p.redirect_uri);
    cb.searchParams.set('code', code);
    cb.searchParams.set('state', p.state);
    cb.searchParams.set('scope', CHATGPT_SCOPES.join(' '));
    if (newRegistration) cb.searchParams.set('client_id', clientId);
    // A browser prefetch / double navigation hits the callback twice at once.
    // A hit after the listener closed fails like it would in a real browser.
    const hit = (): Promise<unknown> => fetch(cb).then((r) => r.text(), () => null);
    setTimeout(() => void Promise.all(opts.prefetch ? [hit(), hit()] : [hit()]), 0);
  };

  const startListener = async (state: string): Promise<CallbackListener> => {
    // Port 0: never fight a real app for 1455 on a dev box.
    const listener = await startCallbackListener(state, 0);
    const entry = { state, listener, closed: false };
    listeners.push(entry);
    return {
      ...listener,
      wait: listener.wait.bind(listener),
      close: () => {
        entry.closed = true;
        listener.close();
      },
    };
  };

  return {
    signer,
    authorizes,
    tokenPosts,
    redeemed,
    listeners,
    fetchImpl,
    openExternal,
    startListener,
    endpoints: {
      issuer: CHATGPT_ISSUER,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/oauth/token`,
      jwks_uri: `${base}/jwks`,
      revocation_endpoint: null,
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

async function setup(opts: Parameters<typeof fakeOpenAi>[0]) {
  const fake = await fakeOpenAi(opts);
  cleanup = fake.close;
  const mem = memoryVault();
  const logs: string[] = [];
  const session = createChatgptSession({
    vault: mem.vault,
    hostId: async () => HOST,
    fetchImpl: fake.fetchImpl,
    openExternal: fake.openExternal,
    startListener: fake.startListener,
    discover: async () => fake.endpoints,
    jwks: { get: async () => [fake.signer.jwk] },
    log: (l) => logs.push(l),
    signInTimeoutMs: 10_000,
  });
  return { fake, mem, session, logs };
}

describe('ChatGPT sign-in vs a refused code (invalid_grant), real loopback + fake token endpoint', () => {
  it('a refused new-registration code is retried ONCE with the issued client id, and connects', async () => {
    const { fake, mem, session } = await setup({ refuse: 'new_registration' });
    const r = await session.signIn();
    expect(r).toMatchObject({ ok: true, planEnabled: true, retriedIssuedClient: true });

    // Round 1 registered; round 2 reauthorized with the client it was issued.
    expect(fake.authorizes).toHaveLength(2);
    expect(fake.authorizes[0].client_id).toBe(CHATGPT_DYNAMIC_CLIENT_ID);
    expect(fake.authorizes[1].client_id).toBe('oaiapp_issued_1');
    expect(fake.authorizes[1].agent_name_hint).toBeUndefined();
    expect(fake.authorizes[1].id_token_hint).toBeUndefined();
    // Fresh state and PKCE per round, same nonce (round 1 minted no ID token).
    expect(fake.authorizes[1].state).not.toBe(fake.authorizes[0].state);
    expect(fake.authorizes[1].code_challenge).not.toBe(fake.authorizes[0].code_challenge);
    expect(fake.authorizes[1].nonce).toBe(fake.authorizes[0].nonce);
    expect(fake.tokenPosts.map((p) => p.client_id)).toEqual(['oaiapp_issued_1', 'oaiapp_issued_1']);

    // The saved account is the issued client.
    expect(mem.read().accounts.map((a) => a.client_id)).toEqual(['oaiapp_issued_1']);
    // Round 1's listener was closed before round 2's opened; both closed now.
    expect(fake.listeners.map((l) => l.closed)).toEqual([true, true]);
  });

  it('before the fix every retry registered again: a second refusal ends with a clear failure, no third trip', async () => {
    const { fake, mem, session } = await setup({ refuse: 'all' });
    const r = await session.signIn();
    expect(r).toEqual({ ok: false, reason: 'exchange_failed', message: 'invalid_grant', retriedIssuedClient: true });
    expect(fake.authorizes.map((a) => a.client_id)).toEqual([CHATGPT_DYNAMIC_CLIENT_ID, 'oaiapp_issued_1']);
    expect(mem.saves).toHaveLength(0);
    expect(signInFailureClass('exchange_failed', signInFailureDetail(r.ok ? undefined : r.message))).toBe('code_refused');
  });

  it('a reauth whose code is refused is not retried (the saved client is already the issued one)', async () => {
    const { fake, mem, session } = await setup({ refuse: 'none' });
    expect((await session.signIn()).ok).toBe(true);
    const acc = mem.read().accounts[0];
    await session.signOut();
    const refusing = await setup({ refuse: 'all' });
    // Same vault contents, refusing server.
    const vault = memoryVault(mem.read());
    const s2 = createChatgptSession({
      vault: vault.vault,
      hostId: async () => HOST,
      fetchImpl: refusing.fake.fetchImpl,
      openExternal: refusing.fake.openExternal,
      startListener: refusing.fake.startListener,
      discover: async () => refusing.fake.endpoints,
      jwks: { get: async () => [refusing.fake.signer.jwk] },
      signInTimeoutMs: 10_000,
    });
    const r = await s2.signIn({ accountId: acc.id });
    expect(r).toEqual({ ok: false, reason: 'exchange_failed', message: 'invalid_grant' });
    expect(refusing.fake.authorizes).toHaveLength(1);
    await fake.close();
  });

  it('the account-login path (connectPlan) gets the same retry and reports it through adoption', async () => {
    const { fake, session } = await setup({ refuse: 'new_registration' });
    const r = await session.signInForLogin({ nonce: 'proxy-nonce' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pending.clientId).toBe('oaiapp_issued_1');
    expect(r.pending.retriedIssuedClient).toBe(true);
    expect(fake.authorizes.map((a) => a.nonce)).toEqual(['proxy-nonce', 'proxy-nonce']);
    expect(await session.adoptLoginAccount(r.pending)).toMatchObject({ ok: true, retriedIssuedClient: true });
  });

  it('cancelling during the retry round ends as cancelled and saves nothing', async () => {
    const { fake, mem, session } = await setup({ refuse: 'new_registration' });
    const realOpen = fake.openExternal;
    let opened = 0;
    const s = createChatgptSession({
      vault: mem.vault,
      hostId: async () => HOST,
      fetchImpl: fake.fetchImpl,
      // Round 2's browser never answers; the user cancels.
      openExternal: async (u) => (++opened === 1 ? realOpen(u) : undefined),
      startListener: fake.startListener,
      discover: async () => fake.endpoints,
      jwks: { get: async () => [fake.signer.jwk] },
      signInTimeoutMs: 10_000,
    });
    void session;
    const p = s.signIn();
    await expect.poll(() => opened).toBe(2);
    s.cancelSignIn();
    expect(await p).toEqual({ ok: false, reason: 'cancelled', retriedIssuedClient: true });
    expect(mem.saves).toHaveLength(0);
    expect(fake.listeners.every((l) => l.closed)).toBe(true);
  });

  it('ruled out: a double callback (prefetch) never redeems a code twice, and redirect_uri matches per round', async () => {
    const { fake, session } = await setup({ refuse: 'new_registration', prefetch: true });
    expect((await session.signIn()).ok).toBe(true);
    for (const count of fake.redeemed.values()) expect(count).toBe(1);
    expect(fake.tokenPosts.map((p) => p.redirect_uri)).toEqual(fake.authorizes.map((a) => a.redirect_uri));
    for (const a of fake.authorizes) expect(a.redirect_uri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
  });

  it("ruled out: a stale tab from round 1 hitting round 2's listener is refused and consumes nothing", async () => {
    const { fake, session } = await setup({ refuse: 'new_registration' });
    const p = session.signIn();
    await expect(p).resolves.toMatchObject({ ok: true });
    // Replay round 1's callback (old state) at round 2's port: 400, no exchange.
    const stale = new URL(fake.authorizes[1].redirect_uri);
    stale.searchParams.set('state', fake.authorizes[0].state);
    stale.searchParams.set('code', 'ac_stale');
    const l2 = await startCallbackListener(fake.authorizes[1].state, 0);
    try {
      const resp = await fetch(new URL(`${stale.pathname}${stale.search}`, l2.redirectUri));
      expect(resp.status).toBe(400);
    } finally {
      l2.close();
    }
    expect(fake.tokenPosts).toHaveLength(2);
  });
});
