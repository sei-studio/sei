/**
 * Tests for plan 10-05 — startGoogleOAuth loopback PKCE server.
 *
 * Stubs:
 *   - ./supabaseClient (signInWithOAuth + exchangeCodeForSession)
 *   - 'electron' (shell.openExternal — via _setOpenExternalForTests stub
 *      so the real electron module isn't loaded outside an Electron runtime)
 *
 * The tests spawn `startGoogleOAuth` against the OS-chosen ephemeral port,
 * intercept the `data.url` returned to openExternal (which surfaces the
 * `redirectTo` the loopback expects), and then issue a real HTTP GET to
 * `http://127.0.0.1:<port>/callback?…` to simulate the system browser
 * completing (or failing) the OAuth flow.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';

// Mocked Supabase auth methods.
const signInWithOAuthMock = vi.fn();
const exchangeCodeForSessionMock = vi.fn();

vi.mock('./supabaseClient', () => ({
  getClient: () => ({
    auth: {
      signInWithOAuth: (...args: unknown[]) => signInWithOAuthMock(...args),
      exchangeCodeForSession: (...args: unknown[]) => exchangeCodeForSessionMock(...args),
    },
  }),
}));

// Stub `electron` so importing loopbackPkce.ts doesn't require the real
// Electron runtime. `_setOpenExternalForTests` injects per-test behaviour.
vi.mock('electron', () => ({
  shell: { openExternal: vi.fn() },
}));

import { startGoogleOAuth, _setOpenExternalForTests } from './loopbackPkce';

/** Extract `redirectTo` from the signInWithOAuth invocation, parse out the port. */
function portFromSignInCall(): number {
  const call = signInWithOAuthMock.mock.calls[0];
  expect(call).toBeDefined();
  const opts = call[0] as { options: { redirectTo: string } };
  const url = new URL(opts.options.redirectTo);
  return Number(url.port);
}

/** Tiny localhost GET helper that resolves when the response body fully drains. */
function getLocalhost(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'GET' },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

beforeEach(() => {
  signInWithOAuthMock.mockReset();
  exchangeCodeForSessionMock.mockReset();
  _setOpenExternalForTests(null);
});

afterEach(() => {
  _setOpenExternalForTests(null);
  vi.restoreAllMocks();
});

describe('startGoogleOAuth', () => {
  it('happy path: receives ?code=, exchanges for session, returns {ok:true}', async () => {
    signInWithOAuthMock.mockResolvedValue({
      data: { url: 'https://accounts.google.com/o/oauth2/v2/auth?…' },
      error: null,
    });
    exchangeCodeForSessionMock.mockResolvedValue({ data: { session: { user: { id: 'u1' } } }, error: null });

    // Inject an openExternal stub that, when called, fires the simulated browser
    // callback against the just-bound loopback port.
    let resolvedPromise: Promise<{ status: number; body: string }> | null = null;
    _setOpenExternalForTests(async () => {
      const port = portFromSignInCall();
      resolvedPromise = getLocalhost(port, '/callback?code=abc123');
    });

    const ctrl = new AbortController();
    const result = await startGoogleOAuth({ timeoutMs: 5000, abortSignal: ctrl.signal });

    expect(result).toEqual({ ok: true });
    expect(exchangeCodeForSessionMock).toHaveBeenCalledWith('abc123');
    // Ensure the polite "you can close this tab" page reached the browser.
    const httpResp = await resolvedPromise!;
    expect(httpResp.status).toBe(200);
    expect(httpResp.body).toContain('You can close this tab.');
  });

  it('timeout: never receives callback, returns {ok:false, reason:"timeout"}', async () => {
    signInWithOAuthMock.mockResolvedValue({
      data: { url: 'https://accounts.google.com/o/oauth2/v2/auth?…' },
      error: null,
    });
    _setOpenExternalForTests(async () => {
      /* never trigger callback */
    });

    const ctrl = new AbortController();
    const result = await startGoogleOAuth({ timeoutMs: 200, abortSignal: ctrl.signal });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('timeout');
    expect(exchangeCodeForSessionMock).not.toHaveBeenCalled();
  });

  it('abort: signal aborted after start, returns {ok:false, reason:"user_cancelled"}', async () => {
    signInWithOAuthMock.mockResolvedValue({
      data: { url: 'https://accounts.google.com/o/oauth2/v2/auth?…' },
      error: null,
    });
    _setOpenExternalForTests(async () => {
      /* never trigger callback */
    });

    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 50);
    const result = await startGoogleOAuth({ timeoutMs: 10_000, abortSignal: ctrl.signal });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('user_cancelled');
    expect(exchangeCodeForSessionMock).not.toHaveBeenCalled();
  });

  it('google error param: receives ?error=access_denied, returns {ok:false, reason:"google_rejected"}', async () => {
    signInWithOAuthMock.mockResolvedValue({
      data: { url: 'https://accounts.google.com/o/oauth2/v2/auth?…' },
      error: null,
    });
    _setOpenExternalForTests(async () => {
      const port = portFromSignInCall();
      // Fire-and-forget — we don't need to await the HTTP response in this test.
      void getLocalhost(port, '/callback?error=access_denied');
    });

    const ctrl = new AbortController();
    const result = await startGoogleOAuth({ timeoutMs: 5000, abortSignal: ctrl.signal });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('google_rejected');
    expect(exchangeCodeForSessionMock).not.toHaveBeenCalled();
  });

  it('signInWithOAuth returns no url: returns {ok:false, reason:"google_rejected"} BEFORE openExternal is called', async () => {
    signInWithOAuthMock.mockResolvedValue({ data: null, error: { message: 'oauth_failed' } });
    const openExternalStub = vi.fn();
    _setOpenExternalForTests(openExternalStub);

    const ctrl = new AbortController();
    const result = await startGoogleOAuth({ timeoutMs: 5000, abortSignal: ctrl.signal });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('google_rejected');
      expect(result.message).toBe('oauth_failed');
    }
    expect(openExternalStub).not.toHaveBeenCalled();
    expect(exchangeCodeForSessionMock).not.toHaveBeenCalled();
  });
});
