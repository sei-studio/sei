/**
 * Loopback PKCE server for Google OAuth.
 *
 * MANDATORY pattern per Pitfall 4 (Google's `disallowed_useragent` blocks
 * Electron's embedded-window OAuth) and Pitfall A1 (Supabase deep-link 401
 * bug avoided by exchanging the code INSIDE the main process — no URL
 * crosses the IPC boundary, no setSession in renderer).
 *
 * Binds 127.0.0.1:0 (OS-chosen ephemeral port — mirrors skinServer.ts).
 * The literal '127.0.0.1' is asserted by an acceptance grep so a future
 * edit can't accidentally widen the bind to all interfaces.
 *
 * Why ephemeral port (and NOT the fixed 54321 used by loopbackCallback.ts):
 *   - Email-verification (10-04) uses a hardcoded port because the Supabase
 *     dashboard Site URL must literal-match the redirect.
 *   - Google OAuth (this file) registers `http://127.0.0.1` (no port) in the
 *     Google Cloud Console OAuth client config; per RFC 8252 §7.3 and
 *     Google's native-app guide, ANY port is then accepted. This lets us
 *     bind 0 and avoid port-collision retries.
 *
 * Sources:
 *   - 10-RESEARCH §Pattern 2 (FULL code template — copied verbatim with
 *     opts.abortSignal integration added).
 *   - 10-RESEARCH §Pitfall A1 (exchange-in-main avoids #17722/#27181).
 *   - .planning/research/PITFALLS.md §Pitfall 4 (embedded-window OAuth incompat).
 *   - Google native-app guide: https://developers.google.com/identity/protocols/oauth2/native-app
 *   - RFC 8252 §7.3 (loopback accepts any port).
 *   - src/main/skinServer.ts (127.0.0.1 + port-0 idiom — same shape).
 */
import { createServer, type Server } from 'node:http';
import { shell } from 'electron';
import { getClient } from './supabaseClient';
import type { OAuthResult } from '../../shared/ipc';

/**
 * Indirection for tests — production opens the URL via electron.shell.openExternal.
 * Tests inject a stub that fires a simulated browser callback against the bound
 * loopback port so the suite doesn't actually spawn a system browser.
 */
let _openExternal: (url: string) => Promise<void> = (url) => shell.openExternal(url);
export function _setOpenExternalForTests(fn: ((url: string) => Promise<void>) | null): void {
  _openExternal = fn ?? ((url) => shell.openExternal(url));
}

export interface StartGoogleOAuthOptions {
  timeoutMs: number;
  abortSignal: AbortSignal;
}

export async function startGoogleOAuth(opts: StartGoogleOAuthOptions): Promise<OAuthResult> {
  const supabase = getClient();
  let server: Server | null = null;
  let port: number;

  // 1. Bind 127.0.0.1:0 — OS-chosen ephemeral port. The literal '127.0.0.1'
  //    is asserted by an acceptance grep; never widen to all interfaces
  //    (that would expose the callback to the LAN — T-10-05-05 mitigation).
  try {
    server = createServer();
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    if (!addr || typeof addr === 'string') {
      throw new Error('server.address() returned unexpected shape');
    }
    port = addr.port;
  } catch (err) {
    if (server) server.close();
    return { ok: false, reason: 'port_collision', message: (err as Error).message };
  }

  const redirectTo = `http://127.0.0.1:${port}/callback`;

  // 2. Ask Supabase for the Google auth URL (PKCE flow).
  //    skipBrowserRedirect:true tells Supabase NOT to open the URL itself
  //    (it can't in the main process anyway) — we open it via shell.openExternal.
  let authUrl: string;
  try {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      // PKCE is configured once at client creation (supabaseClient.ts:
      // auth.flowType='pkce'); it is a client-level setting, not a valid
      // per-call signInWithOAuth option in supabase-js.
      options: { redirectTo, skipBrowserRedirect: true },
    });
    if (error || !data?.url) {
      server.close();
      return { ok: false, reason: 'google_rejected', message: error?.message ?? 'no auth url' };
    }
    authUrl = data.url;
  } catch (err) {
    server.close();
    return { ok: false, reason: 'network', message: (err as Error).message };
  }

  // 3. Set up the one-shot callback listener.
  //    WR-07: the handler is attached via server.on('request', ...) (not
  //    `once`) so a misbehaving browser that hits /callback multiple times
  //    (prefetch on hover, back/forward navigation, etc.) would re-enter
  //    the resolve path with a now-consumed one-shot OAuth code. Track a
  //    `received` flag and short-circuit subsequent /callback hits so only
  //    the first code is ever exchanged.
  let received = false;
  const codePromise = new Promise<string>((resolve, reject) => {
    server!.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      if (url.pathname !== '/callback') {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('Not Found');
        return;
      }
      if (received) {
        // Subsequent hits after the first /callback (browser prefetch, back/
        // forward, etc.) — return a friendly 200 so the browser stops
        // retrying without re-firing resolve/reject (Promise semantics
        // already keep the first resolution; this just avoids the polite
        // HTML being written twice).
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Already handled.');
        return;
      }
      received = true;
      const code = url.searchParams.get('code');
      const errParam = url.searchParams.get('error');
      // Polite "you can close this tab" page so the user isn't staring at
      // a blank page in their browser after returning to Sei.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        `<!doctype html><html><body style="font-family:system-ui;padding:2em;text-align:center">` +
          `<h2>You can close this tab.</h2><p>Returning to Sei…</p>` +
          `<script>window.close()</script></body></html>`,
      );
      if (errParam) reject(new Error(`google_error:${errParam}`));
      else if (code) resolve(code);
      else reject(new Error('no_code_in_callback'));
    });
  });

  // 4. Race the callback against timeout + abort.
  //    WR-06: capture the abort-listener handle so we can remove it
  //    explicitly when the race resolves. Otherwise the listener stays
  //    attached to the AbortSignal until the controller is GC'd by the
  //    enclosing handler's finally block — bounded today, but a future
  //    refactor that keeps oauthController alive longer would turn this
  //    into a slow leak.
  let timeoutHandle: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error('timeout')), opts.timeoutMs);
  });
  let abortListener: (() => void) | null = null;
  const abortPromise = new Promise<never>((_, reject) => {
    if (opts.abortSignal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    abortListener = (): void => reject(new Error('aborted'));
    opts.abortSignal.addEventListener('abort', abortListener, { once: true });
  });

  // 5. Open the user's system browser via shell.openExternal (Pitfall 4
  //    — never use Electron's embedded-window APIs for the OAuth flow).
  try {
    await _openExternal(authUrl);
  } catch (err) {
    server.close();
    if (timeoutHandle) clearTimeout(timeoutHandle);
    return { ok: false, reason: 'browser_closed', message: (err as Error).message };
  }

  // 6. Wait for callback / timeout / abort.
  try {
    const code = await Promise.race([codePromise, timeoutPromise, abortPromise]);
    try {
      const { error: exchErr } = await supabase.auth.exchangeCodeForSession(code);
      if (exchErr) return { ok: false, reason: 'exchange_failed', message: exchErr.message };
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: 'exchange_failed', message: (err as Error).message };
    }
  } catch (err) {
    const msg = (err as Error).message;
    if (msg === 'timeout') return { ok: false, reason: 'timeout', message: 'Code expired (60s)' };
    if (msg === 'aborted') return { ok: false, reason: 'user_cancelled', message: 'Cancelled' };
    if (msg.startsWith('google_error:'))
      return { ok: false, reason: 'google_rejected', message: msg.slice('google_error:'.length) };
    if (msg === 'no_code_in_callback')
      return { ok: false, reason: 'google_rejected', message: 'no code in callback' };
    return { ok: false, reason: 'browser_closed', message: msg };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    // WR-06: remove the abort listener if we ever registered one so a
    // happy-path resolve doesn't leave a dangling subscriber on the
    // AbortSignal. The `{ once: true }` option only fires-and-removes on
    // abort; if abort never happens, the listener stays attached.
    if (abortListener !== null) {
      opts.abortSignal.removeEventListener('abort', abortListener);
    }
    // T-10-05-06 — always drain in-flight requests, no port leak.
    server.close();
  }
}
