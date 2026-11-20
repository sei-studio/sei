/**
 * 261017 (issue #46): the ChatGPT-plan session state machine, end to end
 * against the mock auth server: sign-in (new + reauth), account switch,
 * single-flight refresh with rotation, terminal vs transient refresh
 * failures, sign-out with revocation, the usage-limit latch, models.
 */
import { describe, expect, it, vi } from 'vitest';
import { CHATGPT_DYNAMIC_CLIENT_ID, CHATGPT_SCOPES } from '../../shared/chatgptPlan';
import { REFRESH_MARGIN_MS, USAGE_LIMIT_PROBE_MS, createChatgptSession, parseVault, type AccessToken } from './session';
import { createMockAuthServer, memoryVault } from './__fixtures__/mockAuthServer';
import { answerChatgptTokenRequest, chatgptBotInitSection, pushChatgptTokens, ChatgptSummonError } from './botBridge';

const HOST = 'urn:uuid:11111111-2222-4333-8444-555555555555';

function setup(opts: { clock?: { t: number }; revokeBackoffMs?: number } = {}) {
  const srv = createMockAuthServer({ now: opts.clock ? () => opts.clock!.t : undefined });
  const mem = memoryVault();
  const logs: string[] = [];
  const session = createChatgptSession({
    vault: mem.vault,
    hostId: async () => HOST,
    fetchImpl: srv.fetchImpl,
    openExternal: srv.openExternal,
    startListener: srv.startListener,
    now: opts.clock ? () => opts.clock!.t : undefined,
    log: (l) => logs.push(l),
    revokeBackoffMs: opts.revokeBackoffMs ?? 1,
  });
  return { srv, mem, session, logs };
}

describe('sign-in', () => {
  it('first sign-in registers through the dynamic client and saves the ISSUED client id', async () => {
    const { srv, mem, session } = setup();
    const r = await session.signIn();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.planEnabled).toBe(true);
    expect(srv.authorizeSeen[0].params.client_id).toBe(CHATGPT_DYNAMIC_CLIENT_ID);
    expect(srv.authorizeSeen[0].params.ext_agent_host_id).toBe(HOST);
    const saved = mem.read();
    expect(saved.accounts).toHaveLength(1);
    const acc = saved.accounts[0];
    expect(acc.client_id).toBe('client-issued-1');
    expect(acc.subject).toBe('user-1');
    expect(acc.email).toBe('player@example.com');
    expect(acc.ext_agent_host_id).toBe(HOST);
    expect(acc.refresh_token).toMatch(/^rt-/);
    expect(acc.scopes).toEqual(CHATGPT_SCOPES);
    expect(saved.activeId).toBe(acc.id);
    // The exchange used the issued client, not the entry point.
    expect(srv.tokenPosts[0].client_id).toBe('client-issued-1');
  });

  it('the status the renderer sees carries no token material', async () => {
    const { session } = setup();
    await session.signIn();
    const s = JSON.stringify(await session.status());
    expect(s).not.toMatch(/at-\d|rt-\d|eyJ/);
  });

  it('reauth uses the saved client id with id_token_hint + login_hint and keeps one record', async () => {
    const { srv, mem, session } = setup();
    await session.signIn();
    const acc = mem.read().accounts[0];
    await session.signOut();
    const r = await session.signIn({ accountId: acc.id });
    expect(r.ok).toBe(true);
    const p = srv.authorizeSeen[1].params;
    expect(p.client_id).toBe(acc.client_id);
    expect(p.agent_name_hint).toBeUndefined();
    expect(p.login_hint).toBe('player@example.com');
    expect(mem.read().accounts).toHaveLength(1);
  });

  it('a different ChatGPT account answering a reauth is refused and changes nothing', async () => {
    const { srv, mem, session } = setup();
    await session.signIn();
    const before = mem.read();
    srv.knobs.user = { sub: 'someone-else', email: 'x@example.com' };
    const r = await session.signIn({ accountId: before.accounts[0].id });
    expect(r).toEqual({ ok: false, reason: 'account_mismatch' });
    expect(mem.read()).toEqual(before);
  });

  it('binds the loopback listener to the state it sends in the authorize URL', async () => {
    const { srv, session } = setup();
    await session.signIn();
    expect(srv.listenerStates).toHaveLength(1);
    expect(srv.listenerStates[0]).toBe(srv.authorizeSeen[0].params.state);
  });

  it('a decline, a forged state and a missing issued client never write anything', async () => {
    for (const [mode, reason] of [['deny', 'denied'], ['forge_state', 'state_mismatch'], ['omit_client', 'registration_incomplete']] as const) {
      const { srv, mem, session } = setup();
      srv.knobs.browser = mode;
      const r = await session.signIn();
      expect(r).toMatchObject({ ok: false, reason });
      expect(mem.saves).toHaveLength(0);
    }
  });

  it('an ID token for the wrong nonce fails verification', async () => {
    const { srv, mem, session } = setup();
    srv.knobs.idTokenOverride = (claims) => srv.signer.sign({ ...claims, nonce: 'other' });
    const r = await session.signIn();
    expect(r).toMatchObject({ ok: false, reason: 'id_token_invalid', message: 'nonce' });
    expect(mem.saves).toHaveLength(0);
  });

  it('a sign-in without chatgpt.tokens.use.direct keeps the account but marks the plan disabled', async () => {
    const { srv, session } = setup();
    srv.knobs.user = { sub: 'user-1', email: 'p@example.com', grant: CHATGPT_SCOPES.filter((s) => s !== 'chatgpt.tokens.use.direct') };
    const r = await session.signIn();
    expect(r.ok && r.planEnabled).toBe(false);
    const s = await session.status();
    expect(s.accounts[0]).toMatchObject({ signedIn: true, planEnabled: false });
    await expect(session.getAccessToken()).rejects.toMatchObject({ code: 'CHATGPT_PLAN_DISABLED', terminal: true });
    // "Turn on ChatGPT plan" asks for consent again.
    srv.knobs.user = { sub: 'user-1', email: 'p@example.com' };
    const again = await session.signIn({ accountId: s.accounts[0].id, enablePlan: true });
    expect(srv.authorizeSeen[1].params.prompt).toBe('consent');
    expect(again.ok && again.planEnabled).toBe(true);
  });

  it('cancel aborts a pending sign-in', async () => {
    const { srv, session } = setup();
    srv.knobs.browser = 'ignore';
    const p = session.signIn();
    await vi.waitFor(() => expect(srv.authorizeSeen).toHaveLength(1));
    expect((await session.status()).signingIn).toBe(true);
    session.cancelSignIn();
    expect(await p).toEqual({ ok: false, reason: 'cancelled' });
    expect((await session.status()).signingIn).toBe(false);
  });

  it('a keychain failure surfaces as keychain_unavailable', async () => {
    const { mem, session } = setup();
    mem.vault.fail = true;
    expect(await session.signIn()).toMatchObject({ ok: false, reason: 'keychain_unavailable' });
  });
});

describe('accounts', () => {
  it('two accounts get distinct registrations; switch changes the active one and pushes its token', async () => {
    const { srv, session } = setup();
    await session.signIn();
    srv.knobs.user = { sub: 'user-2', email: 'second@example.com' };
    await session.signIn({ accountId: null });
    let s = await session.status();
    expect(s.accounts).toHaveLength(2);
    const [a, b] = s.accounts;
    expect(s.activeId).toBe(b.id);
    const pushed: (AccessToken | null)[] = [];
    session.onToken((t) => pushed.push(t));
    s = await session.switchAccount(a.id);
    expect(s.activeId).toBe(a.id);
    expect(pushed.at(-1)?.accountId).toBe(a.id);
  });
});

describe('refresh', () => {
  it('concurrent callers near expiry share ONE refresh (the token rotates)', async () => {
    const clock = { t: 1_000_000_000_000 };
    const { srv, session } = setup({ clock });
    await session.signIn();
    srv.knobs.refreshDelayMs = 20;
    clock.t += 3600_000 - REFRESH_MARGIN_MS + 1_000; // inside the margin
    const results = await Promise.all([session.getAccessToken(), session.getAccessToken(), session.getAccessToken({ force: true })]);
    const refreshes = srv.tokenPosts.filter((p) => p.grant_type === 'refresh_token');
    expect(refreshes).toHaveLength(1);
    expect(new Set(results.map((r) => r.token)).size).toBe(1);
    // The rotated refresh token is what is stored now; the old one is spent.
    const again = await session.getAccessToken({ force: true });
    expect(again.token).not.toBe(results[0].token);
    expect(srv.tokenPosts.filter((p) => p.grant_type === 'refresh_token')).toHaveLength(2);
  });

  it('a valid token is returned without a refresh', async () => {
    const { srv, session } = setup();
    await session.signIn();
    await session.getAccessToken();
    expect(srv.tokenPosts.filter((p) => p.grant_type === 'refresh_token')).toHaveLength(0);
  });

  it('honors earliest_refresh_at for a forced refresh while the token is valid', async () => {
    const clock = { t: 1_000_000_000_000 };
    const { srv, session } = setup({ clock });
    srv.knobs.earliestRefreshAt = clock.t + 600_000;
    await session.signIn();
    await session.getAccessToken({ force: true });
    expect(srv.tokenPosts.filter((p) => p.grant_type === 'refresh_token')).toHaveLength(0);
  });

  it('a transient failure keeps credentials and serves the unexpired token', async () => {
    const clock = { t: 1_000_000_000_000 };
    const { srv, mem, session } = setup({ clock });
    await session.signIn();
    const before = await session.getAccessToken();
    clock.t += 3600_000 - REFRESH_MARGIN_MS + 1_000;
    srv.knobs.nextRefreshError = 'network';
    const t = await session.getAccessToken();
    expect(t.token).toBe(before.token);
    expect(mem.read().accounts[0].refresh_token).toBeTruthy();
    // Expired and still failing: a retryable, non-terminal error.
    clock.t += REFRESH_MARGIN_MS;
    srv.knobs.nextRefreshError = { status: 500, error: 'server_error' };
    await expect(session.getAccessToken()).rejects.toMatchObject({ code: 'CHATGPT_UNAVAILABLE', terminal: false });
    expect(mem.read().accounts[0].refresh_token).toBeTruthy();
  });

  it('a terminal refresh error clears the token set (keeps id_token for the reauth hint) and pushes a null', async () => {
    const clock = { t: 1_000_000_000_000 };
    const { srv, mem, session } = setup({ clock });
    await session.signIn();
    const pushed: (AccessToken | null)[] = [];
    session.onToken((t) => pushed.push(t));
    clock.t += 3600_000 + 1;
    srv.knobs.nextRefreshError = { status: 400, error: 'refresh_token_expired' };
    await expect(session.getAccessToken()).rejects.toMatchObject({ code: 'CHATGPT_SIGNED_OUT', terminal: true });
    const acc = mem.read().accounts[0];
    expect(acc.access_token).toBeNull();
    expect(acc.refresh_token).toBeNull();
    expect(acc.id_token).toBeTruthy();
    expect(acc.client_id).toBe('client-issued-1');
    expect(pushed).toEqual([null]);
    expect((await session.status()).accounts[0].signedIn).toBe(false);
  });
});

describe('sign-out', () => {
  it('drops tokens first, revokes the refresh token, keeps the registration', async () => {
    const { srv, mem, session } = setup();
    await session.signIn();
    const rt = mem.read().accounts[0].refresh_token;
    const pushed: (AccessToken | null)[] = [];
    session.onToken((t) => pushed.push(t));
    const r = await session.signOut();
    expect(r.revoked).toBe(true);
    expect(srv.revoked).toEqual([rt]);
    expect(pushed).toEqual([null]);
    const acc = mem.read().accounts[0];
    expect(acc.access_token).toBeNull();
    expect(acc.refresh_token).toBeNull();
    expect(acc.id_token).toBeNull();
    expect(acc.client_id).toBe('client-issued-1');
    expect(acc.email).toBe('player@example.com');
    await expect(session.getAccessToken()).rejects.toMatchObject({ code: 'CHATGPT_SIGNED_OUT' });
  });

  it('reports unconfirmed revocation but still signs out locally', async () => {
    const { srv, mem, session } = setup();
    await session.signIn();
    srv.knobs.revokeStatus = 'network';
    const r = await session.signOut();
    expect(r.revoked).toBe(false);
    expect(mem.read().accounts[0].refresh_token).toBeNull();
  });
});

describe('sign-out during a refresh (race)', () => {
  it('a refresh on the wire during sign-out never writes tokens back or pushes them; both tokens are revoked', async () => {
    const clock = { t: 1_000_000_000_000 };
    const { srv, mem, session } = setup({ clock });
    await session.signIn();
    const used = mem.read().accounts[0].refresh_token;
    const pushed: (AccessToken | null)[] = [];
    session.onToken((t) => pushed.push(t));
    srv.knobs.refreshDelayMs = 30;
    clock.t += 3600_000 + 1; // expired: the next call refreshes
    const inflight = session.getAccessToken().then((t) => t, (e) => e);
    await new Promise((r) => setTimeout(r, 5)); // the refresh is now on the wire
    const out = await session.signOut();
    expect(out.ok).toBe(true);
    const refreshResult = await inflight;
    expect(refreshResult).toMatchObject({ code: 'CHATGPT_SIGNED_OUT' });
    const acc = mem.read().accounts[0];
    expect(acc.access_token).toBeNull();
    expect(acc.refresh_token).toBeNull();
    // No token was pushed to the bots after (or instead of) the sign-out null.
    expect(pushed).toEqual([null]);
    // The token signOut cleared AND the rotation the server handed the stale
    // refresh are both revoked, so no live refresh token outlives sign-out.
    const rotated = [...srv.refreshTokens.entries()].find(([k, v]) => k !== used && !v.used)?.[0];
    expect(rotated).toBeTruthy();
    // The discarded rotation is revoked in the background.
    await vi.waitFor(() => expect(srv.revoked).toEqual(expect.arrayContaining([used, rotated])));
    await expect(session.getAccessToken()).rejects.toMatchObject({ code: 'CHATGPT_SIGNED_OUT' });
  });

  it('a refresh that commits just before sign-out: sign-out revokes the NEWEST refresh token', async () => {
    const clock = { t: 1_000_000_000_000 };
    const { srv, mem, session } = setup({ clock });
    await session.signIn();
    clock.t += 3600_000 + 1;
    await session.getAccessToken();
    const newest = mem.read().accounts[0].refresh_token;
    await session.signOut();
    expect(srv.revoked).toEqual([newest]);
  });

  it('a stale terminal refresh error does not clear a token set a re-sign-in stored meanwhile', async () => {
    const clock = { t: 1_000_000_000_000 };
    const { srv, mem, session } = setup({ clock });
    await session.signIn();
    clock.t += 3600_000 + 1;
    srv.knobs.refreshDelayMs = 30;
    srv.knobs.nextRefreshError = { status: 400, error: 'refresh_token_expired' };
    const inflight = session.getAccessToken().catch((e) => e);
    await new Promise((r) => setTimeout(r, 5));
    srv.knobs.refreshDelayMs = 0;
    const id = (await session.status()).activeId;
    expect(await session.signIn({ accountId: id })).toMatchObject({ ok: true });
    const got = await inflight;
    expect(mem.read().accounts[0].refresh_token).toBeTruthy();
    expect((await session.status()).accounts[0].signedIn).toBe(true);
    // The caller gets the re-sign-in's token, not CHATGPT_SIGNED_OUT.
    expect(got).toMatchObject({ token: mem.read().accounts[0].access_token });
  });

  it('a refresh discarded because of a re-sign-in returns the new token and revokes NOTHING', async () => {
    const clock = { t: 1_000_000_000_000 };
    const { srv, mem, session } = setup({ clock });
    await session.signIn();
    clock.t += 3600_000 + 1;
    srv.knobs.refreshDelayMs = 30;
    const inflight = session.getAccessToken();
    await new Promise((r) => setTimeout(r, 5));
    srv.knobs.refreshDelayMs = 0;
    const id = (await session.status()).activeId;
    expect(await session.signIn({ accountId: id })).toMatchObject({ ok: true });
    const got = await inflight;
    const acc = mem.read().accounts[0];
    expect(got.token).toBe(acc.access_token);
    await new Promise((r) => setTimeout(r, 20));
    // Per-grant revocation could end the new sign-in, so the discarded
    // rotation is left to expire.
    expect(srv.revoked).toEqual([]);
    expect(acc.refresh_token).toBeTruthy();
  });

  it('a token waiter is not held by the background revoke of a discarded rotation', async () => {
    const clock = { t: 1_000_000_000_000 };
    const { srv, session } = setup({ clock, revokeBackoffMs: 5_000 });
    await session.signIn();
    clock.t += 3600_000 + 1;
    srv.knobs.refreshDelayMs = 30;
    const t0 = Date.now();
    const inflight = session.getAccessToken().catch((e) => e);
    await new Promise((r) => setTimeout(r, 5));
    srv.knobs.revokeStatus = 'network'; // every revoke retries with a 5s backoff
    void session.signOut(); // its OWN revoke is awaited (the UI reports it)
    expect(await inflight).toMatchObject({ code: 'CHATGPT_SIGNED_OUT' });
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
});

describe('vault writes are copy-on-write', () => {
  it('a failed save leaves the in-memory session exactly as on disk (still signed in after a failed sign-out write)', async () => {
    const { mem, session } = setup();
    await session.signIn();
    mem.vault.fail = true;
    await expect(session.signOut()).rejects.toThrow('KEYCHAIN_UNAVAILABLE');
    mem.vault.fail = false;
    // Memory did not move ahead of the disk: both still hold the sign-in.
    expect(mem.read().accounts[0].refresh_token).toBeTruthy();
    expect((await session.status()).accounts[0].signedIn).toBe(true);
  });

  it('a failed welcome dismissal does not mark it seen in memory', async () => {
    const { mem, session } = setup();
    await session.signIn();
    mem.vault.fail = true;
    await expect(session.dismissWelcome()).rejects.toThrow();
    expect((await session.status()).welcomeSeen).toBe(false);
  });
});

describe('auth / request rejections latch', () => {
  for (const code of ['CHATGPT_AUTH_REJECTED', 'CHATGPT_REQUEST_REJECTED']) {
    it(`${code} latches, fails fast, and clears on sign-in or clearBlock`, async () => {
      const { session } = setup();
      await session.signIn();
      session.reportError({ code });
      expect((await session.status()).blockedCode).toBe(code);
      expect(() => session.assertUsable()).toThrow(code);
      await session.clearBlock();
      expect(() => session.assertUsable()).not.toThrow();
      session.reportError({ code });
      const id = (await session.status()).activeId;
      await session.signIn({ accountId: id });
      expect((await session.status()).blockedCode).toBeNull();
    });
  }

  it('AUTH_REJECTED tells the player to sign in again', async () => {
    const { session } = setup();
    await session.signIn();
    session.reportError({ code: 'CHATGPT_AUTH_REJECTED' });
    expect(() => session.assertUsable()).toThrow(/Sign in with ChatGPT again/);
  });
});

describe('usage limit + blocks', () => {
  it('latches on a usage limit, fails fast, and lets one probe through after the pause', async () => {
    const clock = { t: 1_000_000_000_000 };
    const { session } = setup({ clock });
    await session.signIn();
    const statuses: boolean[] = [];
    session.onStatus((s) => statuses.push(s.usageLimited));
    session.reportError({ code: 'CHATGPT_USAGE_LIMIT' });
    expect(() => session.assertUsable()).toThrow(/CHATGPT_USAGE_LIMIT/);
    expect((await session.status()).usageLimited).toBe(true);
    // A second report does not re-push or extend.
    session.reportError({ code: 'CHATGPT_USAGE_LIMIT' });
    await vi.waitFor(() => expect(statuses.filter(Boolean)).toHaveLength(1));
    clock.t += USAGE_LIMIT_PROBE_MS + 1;
    expect(() => session.assertUsable()).not.toThrow();
  });

  it('Try again (clearBlock) lifts the latch at once; a switch clears it too', async () => {
    const { session } = setup();
    await session.signIn();
    session.reportError({ code: 'CHATGPT_USAGE_LIMIT' });
    await session.clearBlock();
    expect(() => session.assertUsable()).not.toThrow();
    session.reportError({ code: 'CHATGPT_NOT_ELIGIBLE' });
    expect(() => session.assertUsable()).toThrow(/CHATGPT_NOT_ELIGIBLE/);
    expect((await session.status()).blockedCode).toBe('CHATGPT_NOT_ELIGIBLE');
    const s = await session.status();
    await session.switchAccount(s.activeId!);
    expect(() => session.assertUsable()).not.toThrow();
  });

  it('a profile switch drops the old profile latches and reads the new vault', async () => {
    const { mem, session } = setup();
    await session.signIn();
    session.reportError({ code: 'CHATGPT_USAGE_LIMIT' });
    mem.switchProfile('profile-b');
    const s = await session.status();
    expect(s.accounts).toHaveLength(0);
    expect(s.usageLimited).toBe(false);
    expect(await session.hasActiveSession()).toBe(false);
  });
});

describe('models', () => {
  it('lists /v1/models with the access token and caches per account', async () => {
    const { session } = setup();
    await session.signIn();
    const list = await session.listModels();
    expect(list.map((m) => m.slug)).toEqual(['gpt-6', 'gpt-6-luna']);
    expect(list[1]).toMatchObject({ reasoning_levels: ['low', 'medium'], accepts_images: true });
    expect(session.cachedModels()).toEqual(list);
    expect((await session.status()).models).toEqual(list);
  });
});

describe('welcome', () => {
  it('is shown once: dismiss persists welcomeSeen', async () => {
    const { mem, session } = setup();
    await session.signIn();
    expect((await session.status()).welcomeSeen).toBe(false);
    await session.dismissWelcome();
    expect(mem.read().welcomeSeen).toBe(true);
  });
});

describe('parseVault', () => {
  it('drops junk records and a dangling activeId', () => {
    const v = parseVault({ accounts: [{ subject: 's' }, { subject: 's', client_id: 'c', scopes: ['a', 3] }], activeId: 'nope' });
    expect(v.accounts).toHaveLength(1);
    expect(v.accounts[0].id).toBe('c:s');
    expect(v.accounts[0].scopes).toEqual(['a']);
    expect(v.activeId).toBeNull();
  });
});

describe('bot bridge', () => {
  const model = async () => ({ model: 'gpt-6-luna', reasoningEffort: 'low', vision: true });

  it('init section carries the access token, never the refresh token', async () => {
    const { mem, session } = setup();
    await session.signIn();
    const sec = await chatgptBotInitSection(session, model);
    const text = JSON.stringify(sec);
    expect(text).toContain(mem.read().accounts[0].access_token!);
    expect(text).not.toContain(mem.read().accounts[0].refresh_token!);
  });

  it('a paused plan refuses the summon with the usage-limit code and no network', async () => {
    const { srv, session } = setup();
    await session.signIn();
    session.reportError({ code: 'CHATGPT_USAGE_LIMIT' });
    const posts = srv.tokenPosts.length;
    const err = await chatgptBotInitSection(session, model).catch((e) => e);
    expect(err).toBeInstanceOf(ChatgptSummonError);
    expect(err.code).toBe('CHATGPT_USAGE_LIMIT');
    expect(srv.tokenPosts.length).toBe(posts);
  });

  it('signed out refuses with CHATGPT_SIGNED_OUT', async () => {
    const { session } = setup();
    const err = await chatgptBotInitSection(session, model).catch((e) => e);
    expect(err.code).toBe('CHATGPT_SIGNED_OUT');
  });

  it('answers token requests, with a code on failure', async () => {
    const { session } = setup();
    const posted: unknown[] = [];
    await answerChatgptTokenRequest(session, (m) => posted.push(m), false);
    expect(posted[0]).toMatchObject({ type: 'chatgpt-token', token: null, code: 'CHATGPT_SIGNED_OUT' });
    await session.signIn();
    await answerChatgptTokenRequest(session, (m) => posted.push(m), false);
    expect(posted[1]).toMatchObject({ type: 'chatgpt-token', token: expect.stringMatching(/^at-/) });
  });

  it('pushes rotations and a sign-out null to the bot', async () => {
    const { session } = setup();
    await session.signIn();
    const posted: Array<{ token: string | null; code?: string }> = [];
    const off = pushChatgptTokens(session, (m) => posted.push(m));
    await session.getAccessToken({ force: true });
    await session.signOut();
    off();
    expect(posted[0].token).toMatch(/^at-/);
    expect(posted.at(-1)).toMatchObject({ token: null, code: 'CHATGPT_SIGNED_OUT' });
  });
});

describe('account login (261023)', () => {
  it('uses the given nonce, verifies the ID token against it, and saves nothing', async () => {
    const { srv, mem, session, logs } = setup();
    const r = await session.signInForLogin({ nonce: 'proxy-nonce-1' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(srv.authorizeSeen[0].params.nonce).toBe('proxy-nonce-1');
    expect(srv.authorizeSeen[0].params.client_id).toBe(CHATGPT_DYNAMIC_CLIENT_ID);
    expect(r.pending).toMatchObject({ clientId: 'client-issued-1', subject: 'user-1', email: 'player@example.com', planEnabled: true });
    expect(r.pending.idToken.split('.')).toHaveLength(3);
    expect(mem.saves).toHaveLength(0);
    // Diagnostics name the claims and the email_verified value, never token values.
    const line = logs.find((l) => l.includes('account login id_token claims'))!;
    expect(line).toMatch(/email_verified=absent/);
    expect(line).not.toContain(r.pending.idToken);
    expect(logs.join('\n')).not.toMatch(/eyJ|rt-\d|at-\d/);
  });

  it('logs email_verified when the token carries it', async () => {
    const { srv, session, logs } = setup();
    srv.knobs.idTokenOverride = (claims) => srv.signer.sign({ ...claims, email_verified: true });
    await session.signInForLogin({ nonce: 'n' });
    expect(logs.some((l) => l.includes('email_verified=true'))).toBe(true);
  });

  it('refuses an ID token that does not carry the proxy nonce', async () => {
    const { srv, session } = setup();
    srv.knobs.idTokenOverride = (claims) => srv.signer.sign({ ...claims, nonce: 'other' });
    expect(await session.signInForLogin({ nonce: 'proxy-nonce-1' })).toMatchObject({ ok: false, reason: 'id_token_invalid' });
  });

  it('a reauth target reuses the issued client id, and another ChatGPT account answering is allowed', async () => {
    const { srv, session } = setup();
    srv.knobs.user = { sub: 'someone-else', email: 'x@example.com' };
    const r = await session.signInForLogin({
      nonce: 'n2',
      target: { client_id: 'client-issued-1', id_token: null, email: 'player@example.com' },
    });
    expect(r.ok).toBe(true);
    expect(srv.authorizeSeen[0].params.client_id).toBe('client-issued-1');
    expect(srv.authorizeSeen[0].params.login_hint).toBe('player@example.com');
    if (r.ok) expect(r.pending.subject).toBe('someone-else');
  });

  it('adoptLoginAccount stores the registration in the current vault and activates it', async () => {
    const clock = { t: 1_000_000 };
    const { mem, session } = setup({ clock });
    const r = await session.signInForLogin({ nonce: 'n' });
    if (!r.ok) throw new Error('sign-in failed');
    clock.t += 120_000; // the email-code step took two minutes
    const tokens: AccessToken[] = [];
    session.onToken((t) => t && tokens.push(t));
    const a = await session.adoptLoginAccount(r.pending);
    expect(a.ok && a.planEnabled).toBe(true);
    const saved = mem.read();
    expect(saved.accounts).toHaveLength(1);
    expect(saved.activeId).toBe(saved.accounts[0].id);
    // Expiry counts from when the tokens ARRIVED, not from the adoption.
    expect(saved.accounts[0].expires_at).toBe(r.pending.receivedAt + r.pending.tokens.expires_in * 1000);
    expect(tokens).toHaveLength(1);
    expect(await session.getAccessToken()).toMatchObject({ accountId: saved.accounts[0].id });
  });

  it('forceConsent asks OpenAI for the consent screen again; the default does not', async () => {
    const { srv, session } = setup();
    await session.signInForLogin({ nonce: 'n1' });
    await session.signInForLogin({ nonce: 'n2', forceConsent: true });
    expect(srv.authorizeSeen[0].params.prompt).not.toBe('consent');
    expect(srv.authorizeSeen[1].params.prompt).toBe('consent');
  });

  it('loginTargetFor returns a saved account\'s client, hint and subject (null when unknown)', async () => {
    const { session } = setup();
    const r = await session.signIn();
    if (!r.ok) throw new Error('sign-in failed');
    const acc = r.status.accounts[0]!;
    const t = await session.loginTargetFor(acc.id);
    expect(t).toMatchObject({ client_id: 'client-issued-1', email: 'player@example.com', subject: 'user-1' });
    expect(typeof t!.id_token).toBe('string');
    expect(await session.loginTargetFor('nope')).toBeNull();
  });

  it('discardLoginAccount revokes the unused refresh token', async () => {
    const { srv, session } = setup();
    const r = await session.signInForLogin({ nonce: 'n' });
    if (!r.ok) throw new Error('sign-in failed');
    await session.discardLoginAccount(r.pending);
    expect(srv.revoked).toEqual([r.pending.tokens.refresh_token]);
  });
});

describe('signInFailureDetail (T363 failure log + event)', () => {
  it('keeps short machine codes and drops free text', async () => {
    const { signInFailureDetail } = await import('./session');
    expect(signInFailureDetail(undefined)).toBeNull();
    expect(signInFailureDetail('invalid_grant')).toBe('invalid_grant');
    expect(signInFailureDetail('http_403')).toBe('http_403');
    expect(signInFailureDetail('no refresh_token')).toBe('no_refresh_token');
    expect(signInFailureDetail('jwks HTTP 503')).toBe('jwks_HTTP_503');
    expect(signInFailureDetail("EPERM: operation not permitted, rename 'C:\\Users\\x\\a.tmp'")).toBe('other');
  });
});
