/**
 * Loopback HTTP callback server for Supabase auth redirects.
 *
 * Started during bootstrap (after setStorageAdapter, before initAuthState).
 * Listens on a fixed dev port and handles the inbound `?code=…` query that
 * Supabase appends to email-verification links AND (in plan 10-05) to the
 * Google OAuth redirect.
 *
 * Flow:
 *   1. User clicks verification link in their email →
 *      browser opens http://localhost:54321/auth/callback?code=<pkce_code>
 *   2. This server receives the request, extracts `code`, calls
 *      supabase.auth.exchangeCodeForSession(code). On success Supabase
 *      issues a session, the storage adapter persists it, and the
 *      onAuthStateChange subscription in authState.ts fires SIGNED_IN —
 *      which broadcasts AuthState to every renderer.
 *   3. We write a small HTML "You can close this tab" response so the user
 *      isn't staring at a blank page. Then they switch back to the Sei
 *      window and the auth-state subscriber has already routed them home.
 *
 * Port choice: 54321 is unusual enough to avoid common dev-server ports
 * (3000, 5173, 8080) and matches the convention the skin server already
 * documents in its baseUrl format. The port is hardcoded because the
 * Supabase Site URL setting in the dashboard MUST point at the exact same
 * URL — letting the OS choose ephemeral would force the user to re-paste
 * the URL into the dashboard on every launch.
 *
 * Forward-compat (plan 10-05 — Google OAuth + PKCE):
 *   Plan 05 uses the same callback path. To avoid forcing 10-05 to
 *   re-implement this module, the dispatcher below routes on the inbound
 *   `state` query parameter (or absence thereof):
 *     - No `state` and a `code`  → email-verification (current plan 10-04)
 *     - With a `state` parameter → Google OAuth (plan 10-05 will wire its
 *                                  PKCE handler via addPkceFlow below)
 *   That keeps the server stable; only one HTTP listener for both auth
 *   flows, port-allocation owned in one place.
 *
 * Security:
 *   - Bound to 127.0.0.1 only (NEVER 0.0.0.0). Loopback codes are
 *     short-lived (10 min default for Supabase) but binding to all
 *     interfaces would let a same-LAN attacker intercept the OTP.
 *   - We do NOT log the inbound `code` — it's a one-shot OTP that grants
 *     a session to whoever exchanges it.
 *   - The response HTML is static; no user-controlled values are
 *     interpolated, so no XSS even though Electron's main process renders
 *     no DOM.
 *
 * Source: 260519 UAT fix #5 — verification-link OTP previously consumed
 * by localhost:3000 (Supabase's default Site URL) where nothing listens.
 */
import http from 'node:http';
import { URL } from 'node:url';
import type { BrowserWindow } from 'electron';
import { getClient } from './supabaseClient';
import { consumeRecoveryRequested } from './recoveryFlag';
import { IpcChannel } from '../../shared/ipc';

/** Fixed dev port the email-verification link redirects to. */
export const LOOPBACK_PORT = 54321;

/**
 * Full URL the verification email points at — mirrors authHandlers.ts.
 *
 * WR-04: must use the IPv4 literal `127.0.0.1`, NOT `localhost`. The server
 * binds 127.0.0.1 (T-10-05-05 forbids 0.0.0.0); on Linux + some macOS
 * configs `localhost` resolves to `::1` first, so a browser fetching
 * `http://localhost:54321/...` would hit `[::1]:54321` → ECONNREFUSED and
 * the verification flow appears broken with no diagnostic. The IP literal
 * sidesteps the IPv4/IPv6 dual-stack ambiguity at the cost of showing an
 * IP in the email body (acceptable — Supabase emails are functional, not
 * marketing). The Supabase dashboard Site URL / Additional Redirect URLs
 * must mirror this value; see deferred-items.md.
 */
export const LOOPBACK_CALLBACK_URL = `http://127.0.0.1:${LOOPBACK_PORT}/auth/callback`;

const SUCCESS_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Signed in - Sei</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; background: #fafafa; color: #111;
         display: flex; align-items: center; justify-content: center;
         min-height: 100vh; margin: 0; padding: 32px; box-sizing: border-box; text-align: center; }
  h1 { font-size: 28px; font-weight: 600; margin: 0 0 12px; letter-spacing: -0.4px; }
  p  { font-size: 16px; color: #555; margin: 0; line-height: 1.5; max-width: 420px; }
</style></head><body><div>
  <h1>You're signed in.</h1>
  <p>You can close this tab and return to Sei.</p>
</div></body></html>`;

const RECOVERY_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Reset your password - Sei</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; background: #fafafa; color: #111;
         display: flex; align-items: center; justify-content: center;
         min-height: 100vh; margin: 0; padding: 32px; box-sizing: border-box; text-align: center; }
  h1 { font-size: 28px; font-weight: 600; margin: 0 0 12px; letter-spacing: -0.4px; }
  p  { font-size: 16px; color: #555; margin: 0; line-height: 1.5; max-width: 420px; }
</style></head><body><div>
  <h1>Almost there.</h1>
  <p>Return to Sei to choose a new password.</p>
</div></body></html>`;

const ERROR_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Sign-in failed - Sei</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; background: #fafafa; color: #111;
         display: flex; align-items: center; justify-content: center;
         min-height: 100vh; margin: 0; padding: 32px; box-sizing: border-box; text-align: center; }
  h1 { font-size: 28px; font-weight: 600; margin: 0 0 12px; letter-spacing: -0.4px; }
  p  { font-size: 16px; color: #555; margin: 0; line-height: 1.5; max-width: 420px; }
</style></head><body><div>
  <h1>Sign-in failed.</h1>
  <p>The link may have expired. Please return to Sei and request a new sign-in.</p>
</div></body></html>`;

/**
 * Plan 10-05 extension hook. When 10-05 wires Google OAuth, it will call
 * this with a function that handles requests bearing a `state` query
 * parameter (the PKCE state token). For now it's null; callbacks without
 * a `state` go through the email-verification path below.
 */
export type PkceCallbackHandler = (req: http.IncomingMessage, query: URLSearchParams) => Promise<{ ok: boolean }>;

let pkceHandler: PkceCallbackHandler | null = null;

/** Plan 10-05 will call this from its bootstrap to hook in the Google flow. */
export function setPkceHandler(handler: PkceCallbackHandler | null): void {
  pkceHandler = handler;
}

export interface LoopbackCallbackServer {
  port: number;
  url: string;
  stop: () => Promise<void>;
}

/**
 * Start the loopback callback server. Returns a handle whose stop() the
 * before-quit hook should await so the TCP listener is freed promptly.
 *
 * Throws if the port is already taken — but per CLAUDE.md "every external
 * call has a timeout" we never block bootstrap on it; main/index.ts wraps
 * the start call in try/catch and continues with a warn-log if it fails.
 * The user can fall back to the Supabase Site URL = localhost:54321 dance
 * by themselves only after they free the port.
 */
export async function startLoopbackCallback(opts: {
  /** Logger from main/index.ts so failures surface in the same channel as other bootstrap warnings. */
  logger: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
  /** Live reference to the current window so we can focus it after a successful exchange. */
  getMainWindow: () => BrowserWindow | null;
}): Promise<LoopbackCallbackServer> {
  const { logger, getMainWindow } = opts;

  const server = http.createServer((req, res) => {
    void handleRequest(req, res, logger, getMainWindow).catch((err) => {
      logger.warn(`loopback callback handler crashed: ${(err as Error).message}`);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(ERROR_HTML);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // Bind to loopback only (127.0.0.1) — never 0.0.0.0.
    server.listen(LOOPBACK_PORT, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  logger.info(`auth loopback callback listening on ${LOOPBACK_CALLBACK_URL}`);

  return {
    port: LOOPBACK_PORT,
    url: LOOPBACK_CALLBACK_URL,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  logger: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void },
  getMainWindow: () => BrowserWindow | null,
): Promise<void> {
  // Parse the URL. Use a dummy base because http.IncomingMessage.url is a path-only string.
  const parsed = new URL(req.url ?? '/', LOOPBACK_CALLBACK_URL);

  if (parsed.pathname !== '/auth/callback') {
    res.statusCode = 404;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end('Not Found');
    return;
  }

  const query = parsed.searchParams;

  // Supabase puts errors in the query string for failures (e.g.
  // ?error=access_denied&error_code=otp_expired&error_description=…).
  const errCode = query.get('error_code') ?? query.get('error');
  if (errCode) {
    logger.warn(`loopback callback: supabase returned error=${errCode}`);
    res.statusCode = 400;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(ERROR_HTML);
    return;
  }

  // Plan 10-05 forward-compat: if a `state` param is present and a PKCE
  // handler is registered, defer to it. Otherwise treat the request as
  // email-verification (which has `code` but no `state`).
  //
  // WR-01: if `state` IS present but no PKCE handler is registered, we used
  // to fall through to the email-verification exchange — wrong path for an
  // OAuth callback, and silently so. Reject explicitly with a logged
  // warning instead. This protects future refactors (e.g. if plan 10-05's
  // ephemeral-port server is ever removed in favor of this fixed server)
  // from routing an OAuth code through the wrong exchange.
  const state = query.get('state');
  if (state) {
    if (!pkceHandler) {
      logger.warn(
        `loopback callback: state=${state.slice(0, 8)}… present but no PKCE handler registered; rejecting`,
      );
      res.statusCode = 400;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(ERROR_HTML);
      return;
    }
    const result = await pkceHandler(req, query);
    res.statusCode = result.ok ? 200 : 400;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(result.ok ? SUCCESS_HTML : ERROR_HTML);
    return;
  }

  const code = query.get('code');
  if (!code) {
    res.statusCode = 400;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(ERROR_HTML);
    return;
  }

  // Exchange the code for a session. The storage adapter wired during
  // bootstrap persists the session, and authState.ts's onAuthStateChange
  // listener fires SIGNED_IN which broadcasts the new AuthState to renderer.
  //
  // Phase 11 plan 12 (D-26) — Google OAuth defers ToS acceptance to the
  // next-launch blocking modal (Plan 11-13). The loopback callback page
  // (HTML served by THIS server) is not the right surface for a checkbox:
  // it would interrupt the browser-handoff UX awkwardly, and a renderer-side
  // pre-OAuth checkbox is also impractical because the OAuth flow yields the
  // browser before any consent UI we'd inject runs. Instead, Plan 11-13's
  // AcceptToSModal mounts on next bootstrap if isTosAccepted returns false
  // for the new user; the cloud-write gate (isCloudWriteAllowed in Plan
  // 11-14) blocks any cloud write between this OAuth success and the modal
  // confirmation, so there is no compliance gap. We deliberately do NOT
  // call tosGate.recordAcceptance here.
  try {
    const supabase = getClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      // Don't echo the error message into the HTML — Supabase error text
      // may contain incidental detail we'd rather not leak in the URL bar
      // log.
      logger.warn(`loopback callback: exchangeCodeForSession failed (${error.message})`);
      res.statusCode = 400;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(ERROR_HTML);
      return;
    }

    // Distinguish a password-recovery landing from an ordinary email
    // verification. Both arrive here with a bare `code` (no `state`) and both
    // exchange into a session; the ONLY signal is the recovery flag set by
    // authHandlers.sendPasswordReset just before it emailed the link. Consume
    // it once: a fresh reset request → recovery; anything else → verification.
    const isRecovery = consumeRecoveryRequested();
    res.statusCode = 200;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(isRecovery ? RECOVERY_HTML : SUCCESS_HTML);

    // Bring the Sei window to front so the user sees the signed-in UI
    // immediately when they switch back from the browser.
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.focus();
      // Recovery landing: prompt the renderer for a new password. The exchange
      // above already fired SIGNED_IN (recovery session), so the renderer is on
      // a signed-in route; SetNewPasswordModal overlays it. Sent AFTER focus so
      // the modal animates in on a foregrounded window.
      if (isRecovery) {
        win.webContents.send(IpcChannel.auth.passwordRecovery);
      }
    }
  } catch (err) {
    logger.warn(`loopback callback: exchangeCodeForSession threw (${(err as Error).message})`);
    res.statusCode = 500;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(ERROR_HTML);
  }
}
