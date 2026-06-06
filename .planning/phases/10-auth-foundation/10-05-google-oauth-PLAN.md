---
phase: 10
plan: 05
type: execute
wave: 3
depends_on: [10-03]
files_modified:
  - src/main/auth/loopbackPkce.ts
  - src/main/auth/loopbackPkce.test.ts
  - src/main/auth/authHandlers.ts
  - src/renderer/src/components/OAuthInterstitialModal.tsx
  - src/renderer/src/components/OAuthInterstitialModal.module.css
  - src/renderer/src/components/SignInModal.tsx
autonomous: false
requirements: [AUTH-02]
requirements_addressed: [AUTH-02]
tags: [oauth, google, pkce, loopback, ui]
user_setup:
  - service: google-cloud-console
    why: "Google OAuth client_id for desktop app; Google requires the loopback redirect URI registered explicitly."
    env_vars: []
    dashboard_config:
      - task: "Create a new Google Cloud project (or reuse one). Enable the OAuth consent screen (External; testing mode is fine for dev)."
        location: "https://console.cloud.google.com/apis/credentials/consent"
      - task: "Create OAuth client ID of type 'Desktop App' (NOT 'Web application'). Name it 'Sei Desktop'."
        location: "https://console.cloud.google.com/apis/credentials → Create credentials → OAuth client ID"
      - task: "Register authorized redirect URI: `http://127.0.0.1` (no port — RFC 8252 §7.3 says loopback accepts any port, but Google still wants the bare URI registered)."
        location: "Same OAuth client ID page → Authorized redirect URIs"
      - task: "Copy the resulting client_id + client_secret. Paste into your Supabase dashboard → Authentication → Providers → Google (Enabled = true)."
        location: "https://app.supabase.com/project/<your-project>/auth/providers"
must_haves:
  truths:
    - "Clicking 'Continue with Google' in SignInModal opens the user's system browser via shell.openExternal — NOT a BrowserWindow (Pitfall 4; AUTH-02 invariant)"
    - "A one-shot node:http loopback server binds 127.0.0.1:0 (OS-chosen ephemeral port), receives the callback ?code=... query, hands the code to supabase.auth.exchangeCodeForSession, then closes (RESEARCH §Pattern 2)"
    - "While the OAuth flow is in flight, SignInModal closes and OAuthInterstitialModal opens with a 60-second countdown (D-05, UI-SPEC)"
    - "OAuthInterstitialModal dismissal label is exactly 'Cancel sign-in' (UI-SPEC dismissal-label policy)"
    - "auth:cancel-google fires the in-flight AbortController; server.close() drains; modal returns to SignInModal (NOT AuthChoice — preserves the user's typed email)"
    - "On 60s timeout, modal swaps to the 'That took a little too long' error variant with Try again + Cancel sign-in (UI-SPEC OAuth error copy)"
    - "All 6 UI-SPEC OAuth failure modes are represented in the interstitial's error-body switch (user_cancelled/timeout/browser_closed/google_rejected/exchange_failed/port_collision/network)"
    - "Code path NEVER touches BrowserWindow for OAuth, never registers a custom URL scheme (Pitfall 4; RESEARCH Pitfall A1)"
  artifacts:
    - path: "src/main/auth/loopbackPkce.ts"
      provides: "startGoogleOAuth({timeoutMs, abortSignal}) → OAuthResult — full Pattern 2 implementation"
      exports: ["startGoogleOAuth", "_setOpenExternalForTests"]
    - path: "src/main/auth/loopbackPkce.test.ts"
      provides: "Tests for server binding, callback capture, timeout, abort, port-collision"
      contains: "describe"
    - path: "src/main/auth/authHandlers.ts"
      provides: "signInWithGoogle and cancelGoogle bodies (replaces plan 03 shells); module-level AbortController held while in flight"
      contains: "startGoogleOAuth"
    - path: "src/renderer/src/components/OAuthInterstitialModal.tsx"
      provides: "Centered 460px modal with countdown, error variants, Cancel sign-in / Try again controls"
      exports: ["OAuthInterstitialModal"]
    - path: "src/renderer/src/components/SignInModal.tsx"
      provides: "Updated onGoogleClick: closes SignInModal, mounts OAuthInterstitialModal; on cancel returns to SignInModal preserving email"
      contains: "OAuthInterstitialModal"
  key_links:
    - from: "src/main/auth/loopbackPkce.ts"
      to: "electron.shell.openExternal"
      via: "shell.openExternal(authUrl) opens system browser"
      pattern: "shell\\.openExternal"
    - from: "src/main/auth/loopbackPkce.ts"
      to: "src/main/auth/supabaseClient.ts"
      via: "supabase.auth.signInWithOAuth + supabase.auth.exchangeCodeForSession"
      pattern: "exchangeCodeForSession"
    - from: "src/main/auth/loopbackPkce.ts"
      to: "node:http (port 0 on 127.0.0.1)"
      via: "server.listen(0, '127.0.0.1') — OS-chosen ephemeral port (mirrors skinServer.ts pattern)"
      pattern: "listen\\(0, '127\\.0\\.0\\.1'"
    - from: "src/main/auth/authHandlers.ts"
      to: "src/main/auth/loopbackPkce.ts"
      via: "startGoogleOAuth({timeoutMs:60_000, abortSignal})"
      pattern: "startGoogleOAuth"
---

<objective>
Implement the full Google OAuth flow:
1. `src/main/auth/loopbackPkce.ts` — direct implementation of RESEARCH §Pattern 2 (the full 60-line code template). Mirrors `src/main/skinServer.ts` for the 127.0.0.1:0 ephemeral-port idiom.
2. `src/main/auth/authHandlers.ts` — fill `signInWithGoogle` and `cancelGoogle` bodies. Module-level AbortController held while flow is in flight.
3. `src/renderer/src/components/OAuthInterstitialModal.tsx` — centered modal per D-05 with 60s countdown, 6 error variants per UI-SPEC.
4. `src/renderer/src/components/SignInModal.tsx` — rewire `onGoogleClick` to mount the interstitial; on cancel, return to SignInModal (NOT AuthChoice — preserves typed email).

Purpose: AUTH-02 ships. Pitfall 4 (Google blocks BrowserWindow OAuth) is sidestepped by the loopback pattern; Pitfall A1 (Supabase Electron deep-link 401 bug) is sidestepped because the code exchange runs inside the main process.

Output: One new main-process module + tests, two handler bodies, one new modal + CSS, edits to SignInModal.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@.planning/REQUIREMENTS.md
@.planning/phases/10-auth-foundation/10-CONTEXT.md
@.planning/phases/10-auth-foundation/10-RESEARCH.md
@.planning/phases/10-auth-foundation/10-UI-SPEC.md
@.planning/research/PITFALLS.md
@CLAUDE.md
@src/main/skinServer.ts
@src/main/auth/authHandlers.ts
@src/main/auth/supabaseClient.ts
@src/renderer/src/components/SignInModal.tsx
@src/renderer/src/components/DeleteConfirmModal.module.css
@.planning/phases/10-auth-foundation/10-03-SUMMARY.md
@.planning/phases/10-auth-foundation/10-04-SUMMARY.md

<interfaces>
<!-- Full code template from RESEARCH §Pattern 2 — copy verbatim, then add the 'opts.abortSignal' integration. -->

OAuthResult shape (already defined in src/shared/ipc.ts by plan 03):
```typescript
export type OAuthResult =
  | { ok: true }
  | { ok: false; reason: 'user_cancelled' | 'timeout' | 'browser_closed' | 'google_rejected' | 'exchange_failed' | 'port_collision' | 'network'; message: string };
```

skinServer.ts ephemeral-port pattern (mirror this):
```typescript
server.listen(args.port ?? 0, '127.0.0.1');
// after listen:
const addr = server.address();
if (!addr || typeof addr === 'string') throw new Error('SKIN_SERVER_PORT_TAKEN: ...');
const port = addr.port;
```

Supabase OAuth methods (from @supabase/supabase-js):
```typescript
supabase.auth.signInWithOAuth({
  provider: 'google',
  options: { redirectTo, skipBrowserRedirect: true, flowType: 'pkce' }
}): Promise<{ data: { url?: string }, error: AuthError | null }>;

supabase.auth.exchangeCodeForSession(code: string): Promise<{ data: ..., error: AuthError | null }>;
```
</interfaces>
</context>

<read_first>
- `src/main/skinServer.ts` (entire file — 140 lines; ephemeral-port + 127.0.0.1-only binding pattern to mirror exactly)
- `src/main/auth/supabaseClient.ts` (getClient)
- `src/main/auth/authHandlers.ts` (plan 03 shells; replace signInWithGoogle and cancelGoogle bodies)
- `src/renderer/src/components/SignInModal.tsx` (plan 04 — rewire onGoogleClick at the end of this plan)
- `src/renderer/src/components/DeleteConfirmModal.module.css` (scrim+modal scaffold reference)
- `src/renderer/src/components/Button.tsx` (ghost / quiet kinds for the modal CTAs)
- `.planning/phases/10-auth-foundation/10-RESEARCH.md` §Pattern 2 (FULL code template — copy verbatim) and §Pitfall A1 (why exchange-in-main is safe)
- `.planning/research/PITFALLS.md` §Pitfall 4 (Google + BrowserWindow incompat)
- `.planning/phases/10-auth-foundation/10-UI-SPEC.md` §Google OAuth interstitial modal, §OAuth error copy (6 variants — copy strings verbatim), §Interaction Contracts → OAuth flow (D-05)
- `.planning/phases/10-auth-foundation/10-CONTEXT.md` D-05
</read_first>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Implement loopbackPkce.ts (Pattern 2 verbatim) + tests</name>
  <files>src/main/auth/loopbackPkce.ts, src/main/auth/loopbackPkce.test.ts</files>
  <read_first>
    - src/main/skinServer.ts (ephemeral port pattern; 127.0.0.1-only literal that is grep-asserted; same here)
    - src/main/auth/supabaseClient.ts (getClient)
    - .planning/phases/10-auth-foundation/10-RESEARCH.md §Pattern 2 (full code template — this task copies it verbatim with the abortSignal wiring added)
    - .planning/research/PITFALLS.md §Pitfall 4 ("Why we don't use BrowserWindow")
  </read_first>
  <behavior>
    - startGoogleOAuth({timeoutMs, abortSignal}) returns OAuthResult.
    - Binds node:http server to 127.0.0.1:0; reads OS-chosen port from server.address().port. NEVER 0.0.0.0 — same as skinServer.ts (the literal '127.0.0.1' is grep-asserted).
    - redirectTo = `http://127.0.0.1:${port}/callback`.
    - Calls supabase.auth.signInWithOAuth({provider:'google', options:{redirectTo, skipBrowserRedirect:true, flowType:'pkce'}}); if no data.url, returns {ok:false, reason:'google_rejected'}.
    - Calls electron.shell.openExternal(data.url) — opens system browser (Pitfall 4; AUTH-02 invariant).
    - On first GET /callback request: parses url.searchParams.get('code') and 'error'; responds with a polite text/html "you can close this tab" page; calls supabase.auth.exchangeCodeForSession(code); returns {ok:true} on success or {ok:false, reason:'exchange_failed'} on failure.
    - On any path other than /callback: 404.
    - Race against opts.timeoutMs (60s typical) — timeout → {ok:false, reason:'timeout'}.
    - opts.abortSignal.addEventListener('abort', ...) — abort → {ok:false, reason:'user_cancelled'}.
    - finally: server.close() (drains in-flight).
    - Error param in callback URL → {ok:false, reason:'google_rejected'}.
    - Bind failure → {ok:false, reason:'port_collision'}.
    - Throws thrown by shell.openExternal or exchangeCodeForSession are caught and mapped (network → reason:'network').
    - _setOpenExternalForTests(fn) lets tests inject a stub for shell.openExternal.
    - Tests use node:http localhost client to simulate the browser callback: spawn the server via startGoogleOAuth (with a stubbed Supabase), then fetch the redirect URL.
  </behavior>
  <action>
Create `src/main/auth/loopbackPkce.ts` — COPY the full code template from RESEARCH §Pattern 2 lines 286–370, then make these additions:

```typescript
/**
 * Loopback PKCE server for Google OAuth.
 *
 * MANDATORY pattern per Pitfall 4 (Google's `disallowed_useragent` blocks
 * BrowserWindow OAuth) and Pitfall A1 (Supabase deep-link 401 bug avoided
 * by exchanging the code INSIDE the main process — no URL crosses the
 * IPC boundary, no setSession in renderer).
 *
 * Binds 127.0.0.1:0 (OS-chosen ephemeral port — mirrors skinServer.ts).
 * The literal '127.0.0.1' is asserted by an acceptance grep so a future
 * edit can't accidentally widen the bind to 0.0.0.0.
 *
 * Sources:
 *   - 10-RESEARCH §Pattern 2 (FULL code template — copied verbatim)
 *   - 10-RESEARCH §Pitfall A1 (exchange-in-main avoids #17722/#27181)
 *   - PITFALLS.md §Pitfall 4 (BrowserWindow incompat)
 *   - Google native-app guide: https://developers.google.com/identity/protocols/oauth2/native-app
 *   - RFC 8252 §7.3 (loopback any port)
 *   - src/main/skinServer.ts (127.0.0.1 + port-0 idiom)
 */
import { createServer, type Server } from 'node:http';
import { shell } from 'electron';
import { getClient } from './supabaseClient';
import type { OAuthResult } from '../../shared/ipc';

// Indirection for tests — production uses electron.shell.openExternal directly.
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

  // 1. Bind 127.0.0.1:0 — OS-chosen ephemeral port. 127.0.0.1 LITERAL is
  //    asserted by acceptance grep; never widen to 0.0.0.0.
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
  let authUrl: string;
  try {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo, skipBrowserRedirect: true, flowType: 'pkce' },
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

  // 3. Set up the one-shot callback listener + timeout + abort race.
  const codePromise = new Promise<string>((resolve, reject) => {
    server!.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      if (url.pathname !== '/callback') {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('Not Found');
        return;
      }
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

  let timeoutHandle: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error('timeout')), opts.timeoutMs);
  });
  const abortPromise = new Promise<never>((_, reject) => {
    if (opts.abortSignal.aborted) reject(new Error('aborted'));
    else opts.abortSignal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });

  // 4. Open the user's system browser (Pitfall 4 — NEVER BrowserWindow).
  try {
    await _openExternal(authUrl);
  } catch (err) {
    server.close();
    if (timeoutHandle) clearTimeout(timeoutHandle);
    return { ok: false, reason: 'browser_closed', message: (err as Error).message };
  }

  // 5. Wait for callback / timeout / abort.
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
    if (msg.startsWith('google_error:')) return { ok: false, reason: 'google_rejected', message: msg.slice(13) };
    if (msg === 'no_code_in_callback') return { ok: false, reason: 'google_rejected', message: 'no code in callback' };
    return { ok: false, reason: 'browser_closed', message: msg };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    server.close();
  }
}
```

Then create `src/main/auth/loopbackPkce.test.ts`. Use vi.mock to stub `./supabaseClient` and `electron`. Key test cases (use a real `node:http` client to make a request to the bound port):

1. Successful flow: stub supabase returns `{data:{url:'http://stub.example/auth'}, error:null}` for signInWithOAuth and `{error:null}` for exchangeCodeForSession. Stub openExternal records the URL. Spawn startGoogleOAuth({timeoutMs:5000, abortSignal:new AbortController().signal}) in the background; once the openExternal call records the URL, fetch `http://127.0.0.1:${port}/callback?code=abc`. Expect resolved value `{ok:true}` and the response body contains "You can close this tab.".

2. Timeout: pass timeoutMs=200 and never fetch the callback URL. Expect `{ok:false, reason:'timeout'}`.

3. Abort: pass timeoutMs=10000, abort the controller after 50ms. Expect `{ok:false, reason:'user_cancelled'}`.

4. Google error param: fetch `http://127.0.0.1:${port}/callback?error=access_denied`. Expect `{ok:false, reason:'google_rejected'}`.

5. signInWithOAuth returns no URL: stub returns `{data:null, error:{message:'oauth_failed'}}`. Expect `{ok:false, reason:'google_rejected'}` BEFORE openExternal is called.
  </action>
  <verify>
    <automated>grep -c "127.0.0.1" src/main/auth/loopbackPkce.ts | grep -qE "^[3-9]" && ! grep -q "0.0.0.0" src/main/auth/loopbackPkce.ts && ! grep -q "BrowserWindow" src/main/auth/loopbackPkce.ts && grep -c "shell.openExternal\|_openExternal" src/main/auth/loopbackPkce.ts | grep -qE "^[2-9]" && grep -c "skipBrowserRedirect: true" src/main/auth/loopbackPkce.ts | grep -q "^1$" && grep -c "exchangeCodeForSession" src/main/auth/loopbackPkce.ts | grep -q "^1$" && grep -c "flowType: 'pkce'" src/main/auth/loopbackPkce.ts | grep -q "^1$" && grep -c "abortSignal" src/main/auth/loopbackPkce.ts | grep -qE "^[2-9]" && grep -c "user_cancelled\|timeout\|browser_closed\|google_rejected\|exchange_failed\|port_collision" src/main/auth/loopbackPkce.ts | grep -qE "^[6-9]" && npx vitest run src/main/auth/loopbackPkce.test.ts && npx tsc --noEmit</automated>
  </verify>
  <acceptance_criteria>
    - `grep -cF "127.0.0.1" src/main/auth/loopbackPkce.ts` >= 3 (bind + redirectTo template + URL parse)
    - `grep -cF "0.0.0.0" src/main/auth/loopbackPkce.ts` equals 0 (must NEVER widen the bind)
    - `grep -cF "BrowserWindow" src/main/auth/loopbackPkce.ts` equals 0 (Pitfall 4 invariant)
    - `grep -c "shell.openExternal" src/main/auth/loopbackPkce.ts` >= 1 OR `grep -c "_openExternal" src/main/auth/loopbackPkce.ts` >= 2 (via the indirection)
    - `grep -cF "skipBrowserRedirect: true" src/main/auth/loopbackPkce.ts` equals 1
    - `grep -cF "exchangeCodeForSession" src/main/auth/loopbackPkce.ts` equals 1
    - `grep -cF "flowType: 'pkce'" src/main/auth/loopbackPkce.ts` equals 1
    - `grep -c "abortSignal" src/main/auth/loopbackPkce.ts` >= 2
    - All 6 reason values present: `for r in user_cancelled timeout browser_closed google_rejected exchange_failed port_collision; do grep -c "$r" src/main/auth/loopbackPkce.ts; done` — each >= 1
    - `grep -cF "export async function startGoogleOAuth" src/main/auth/loopbackPkce.ts` equals 1
    - `grep -cF "export function _setOpenExternalForTests" src/main/auth/loopbackPkce.ts` equals 1
    - The literal binding line is present: `grep -cE "server.*\.listen\(0, '127\\.0\\.0\\.1'" src/main/auth/loopbackPkce.ts` equals 1
    - `npx vitest run src/main/auth/loopbackPkce.test.ts` exits 0 with all 5 tests passing
    - `npx tsc --noEmit` exits 0
  </acceptance_criteria>
  <done>
    loopbackPkce.ts is the Pattern 2 template verbatim with full abort/timeout integration; 127.0.0.1 binding is asserted; no BrowserWindow / 0.0.0.0 references; 5 vitest cases cover happy path + 4 failure modes.
  </done>
</task>

<task type="auto" tdd="false">
  <name>Task 2: Fill signInWithGoogle + cancelGoogle handlers + build OAuthInterstitialModal + rewire SignInModal</name>
  <files>src/main/auth/authHandlers.ts, src/renderer/src/components/OAuthInterstitialModal.tsx, src/renderer/src/components/OAuthInterstitialModal.module.css, src/renderer/src/components/SignInModal.tsx</files>
  <read_first>
    - src/main/auth/authHandlers.ts (replace bodies of signInWithGoogle + cancelGoogle)
    - src/main/auth/loopbackPkce.ts (just created — startGoogleOAuth signature)
    - src/renderer/src/components/SignInModal.tsx (plan 04 — rewire onGoogleClick)
    - src/renderer/src/components/DeleteConfirmModal.module.css (scrim+modal scaffold)
    - .planning/phases/10-auth-foundation/10-UI-SPEC.md §Google OAuth interstitial + §OAuth error copy (6 verbatim copy strings)
    - .planning/phases/10-auth-foundation/10-CONTEXT.md D-05
  </read_first>
  <behavior>
    - authHandlers.signInWithGoogle: creates a module-level AbortController, calls startGoogleOAuth({timeoutMs:60_000, abortSignal:controller.signal}), returns its OAuthResult.
    - authHandlers.cancelGoogle: if an AbortController exists, calls .abort() on it; sets it to null.
    - If a second signInWithGoogle is invoked while one is in flight: abort the old one first, then start the new one.
    - OAuthInterstitialModal props: { onCancel: () => void, onResult: (r: OAuthResult) => void }. On mount, the modal renders the "we've opened a browser tab" body with a 60s countdown caption. Internally it does NOT call sei.signInGoogle — the parent SignInModal owns that. The modal merely displays the in-flight UI.
      - REVISED for cleaner ownership: OAuthInterstitialModal IS the orchestrator: on mount it calls `sei.signInGoogle()` once; while the promise is pending it shows the countdown; on resolve it calls `onResult(res)`. On Cancel button it calls `sei.cancelGoogle()` then onCancel().
    - On result.ok=true: shows the 200ms 'Signed in. One moment…' state before calling onResult (so the user sees confirmation before the modal closes).
    - On result.ok=false: maps reason to the 6 UI-SPEC error variants — each variant has a heading + body + 'Try again' (ghost) + 'Cancel sign-in' (quiet) Button. 'Try again' resets state and re-invokes sei.signInGoogle.
    - Click-outside does NOT close the modal (UI-SPEC §Layout rule 5). ESC does NOT close while waiting for the loopback exchange (~1s window — UI-SPEC rule 4b).
    - Modal width 460px, scrim 0.45 alpha (UI-SPEC).
    - SignInModal.onGoogleClick rewrite: instead of awaiting sei.signInGoogle, it just sets `showInterstitial=true` and closes itself, passing the typed email through to a `pendingEmail` ref so on cancel the email field is restored.
    - Per UI-SPEC §Interaction Contracts → OAuth flow §5: cancel returns to SignInModal NOT AuthChoice. Implementation: AuthChoiceScreen holds the showSignIn state; SignInModal's parent is AuthChoiceScreen (or the inline-upgrade host). When SignInModal closes for OAuth, it sets a "resuming" flag on the parent; on cancel from interstitial, the parent re-opens SignInModal with the saved email. Implementation strategy: lift OAuthInterstitial state to the AuthChoiceScreen level so SignInModal stays mounted (hidden via CSS or display:none) during OAuth; on cancel, SignInModal becomes visible again with the same `email` state.

    Simpler implementation (RECOMMENDED): keep SignInModal mounted throughout OAuth; when the user clicks Continue with Google, SignInModal sets internal `oauthInFlight=true` which renders OAuthInterstitialModal AS A SIBLING (both modals' scrims overlap, the interstitial wins z-index). On interstitial cancel, SignInModal sets oauthInFlight=false → SignInModal is visible again with email preserved. On success, SignInModal calls onClose (its existing close path).
  </behavior>
  <action>
1. Edit `src/main/auth/authHandlers.ts` — replace signInWithGoogle and cancelGoogle bodies:

```typescript
// Add to imports at top:
import { startGoogleOAuth } from './loopbackPkce';

// Module-level state for the in-flight OAuth attempt.
let oauthController: AbortController | null = null;

export async function signInWithGoogle(): Promise<OAuthResult> {
  // If a previous attempt is still in flight (user clicked twice), abort it
  // before starting a new one. Otherwise we'd race two loopback servers.
  if (oauthController) {
    oauthController.abort();
    oauthController = null;
  }
  const controller = new AbortController();
  oauthController = controller;
  try {
    return await startGoogleOAuth({ timeoutMs: 60_000, abortSignal: controller.signal });
  } finally {
    if (oauthController === controller) oauthController = null;
  }
}

export async function cancelGoogle(): Promise<void> {
  if (oauthController) {
    oauthController.abort();
    oauthController = null;
  }
}
```

Delete the two `// IMPLEMENTED IN PLAN 10-05` comments since the implementations are now real.

2. Create `src/renderer/src/components/OAuthInterstitialModal.module.css` (460px modal, same scrim/animation as SignInModal — copy from SignInModal.module.css and adapt):

```css
.scrim {
  position: fixed; inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex; align-items: center; justify-content: center;
  z-index: 1100;
  animation: fade 220ms ease;
}
.modal {
  width: 460px;
  background: var(--window);
  padding: var(--space-xl);
  border: 1px solid var(--border-strong);
  font-family: var(--sans);
  animation: fadeUp 280ms var(--ease-pop);
  display: flex; flex-direction: column; gap: var(--space-md-plus);
}
.title {
  font-size: 22px; font-weight: 600; line-height: 1.2; letter-spacing: -0.2px;
  color: var(--text); margin: 0;
}
.body {
  font-size: 15px; line-height: 1.5; color: var(--text-2); margin: 0;
}
.countdown {
  font-size: 14px; color: var(--muted); margin: 0;
}
.success {
  font-size: 15px; color: var(--text); margin: 0;
}
.footer {
  display: flex; justify-content: flex-end; gap: var(--space-md);
  margin-top: var(--space-md-plus);
}
@keyframes fade { from {opacity:0} to {opacity:1} }
@keyframes fadeUp { from {opacity:0; transform:translateY(8px)} to {opacity:1; transform:none} }
@media (prefers-reduced-motion: reduce) {
  .scrim, .modal { animation: none; }
}
```

3. Create `src/renderer/src/components/OAuthInterstitialModal.tsx`:

```tsx
/**
 * OAuthInterstitialModal — centered modal shown while Google OAuth runs in
 * the system browser (D-05).
 *
 * Owns the sei.signInGoogle() invocation lifecycle:
 *   - On mount: invoke once; show countdown body.
 *   - On result.ok: brief 'Signed in. One moment…' then onResult.
 *   - On result.!ok: swap to one of 6 UI-SPEC error variants with Try again /
 *     Cancel sign-in.
 *   - On Cancel: sei.cancelGoogle() then onCancel().
 *
 * Dismissal label is exactly 'Cancel sign-in' (UI-SPEC dismissal-label policy).
 * ESC and click-outside are SUPPRESSED (UI-SPEC §Layout rules 4b, 5b).
 *
 * Source: 10-UI-SPEC §Google OAuth interstitial + §OAuth error copy (all 6 variants).
 */
import React, { useEffect, useRef, useState } from 'react';
import { sei } from '../lib/ipcClient';
import { Button } from './Button';
import type { OAuthResult } from '@shared/ipc';
import styles from './OAuthInterstitialModal.module.css';

export interface OAuthInterstitialModalProps {
  onResult: (r: OAuthResult) => void;
  onCancel: () => void;
}

type Phase =
  | { kind: 'waiting'; secondsLeft: number }
  | { kind: 'finalizing' }  // post-success 200ms window
  | { kind: 'success' }     // 'Signed in. One moment…'
  | { kind: 'error'; reason: Extract<OAuthResult, { ok: false }>['reason']; message: string };

const ERROR_COPY: Record<Extract<OAuthResult, { ok: false }>['reason'], { heading: string; body: string }> = {
  browser_closed: {
    heading: "Sign-in didn't finish",
    body: 'Looks like the browser tab was closed. Try again, and finish the Google flow in the tab that opens.',
  },
  network: {
    heading: "Couldn't reach Google",
    body: "Sei couldn't connect to Google's sign-in. Check your internet and try again.",
  },
  timeout: {
    heading: 'That took a little too long',
    body: 'The sign-in link expired. Try again — it stays valid for about a minute.',
  },
  google_rejected: {
    heading: 'Google declined the sign-in',
    body: "Google didn't approve the sign-in. You can try again or use email and password instead.",
  },
  port_collision: {
    heading: "Couldn't open the sign-in helper",
    body: 'Something else on your machine is using the port Sei needs. Close it and try again, or use email and password.',
  },
  exchange_failed: {
    heading: 'Sign-in hit a snag',
    body: "Sei completed the Google step but couldn't finish setting up your session. Try again — this usually resolves on the second attempt.",
  },
  user_cancelled: {
    // User-cancelled means they hit Cancel — modal closes via onCancel, not via this map.
    heading: 'Cancelled',
    body: 'Sign-in cancelled.',
  },
};

export function OAuthInterstitialModal({ onResult, onCancel }: OAuthInterstitialModalProps): React.ReactElement {
  const [phase, setPhase] = useState<Phase>({ kind: 'waiting', secondsLeft: 60 });
  const cancelBtnRef = useRef<HTMLButtonElement>(null);
  const inFlightRef = useRef(false);

  const start = (): void => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setPhase({ kind: 'waiting', secondsLeft: 60 });
    sei.signInGoogle().then((res) => {
      inFlightRef.current = false;
      if (res.ok) {
        setPhase({ kind: 'success' });
        setTimeout(() => {
          setPhase({ kind: 'finalizing' });
          onResult(res);
        }, 200);
      } else if (res.reason === 'user_cancelled') {
        // Cancel button already routes through onCancel; if we received this
        // reason without explicit cancel, treat as cancel.
        onCancel();
      } else {
        setPhase({ kind: 'error', reason: res.reason, message: res.message });
      }
    });
  };

  // Kick off once on mount; restart on Try again.
  useEffect(() => {
    start();
    cancelBtnRef.current?.focus();
    // ESC suppressed per UI-SPEC §Layout rule 4b — no listener.
    // No click-outside listener — UI-SPEC §Layout rule 5b.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Countdown tick — only while waiting.
  useEffect(() => {
    if (phase.kind !== 'waiting') return;
    if (phase.secondsLeft <= 0) return;
    const t = setTimeout(() => {
      setPhase((p) => (p.kind === 'waiting' ? { kind: 'waiting', secondsLeft: p.secondsLeft - 1 } : p));
    }, 1000);
    return () => clearTimeout(t);
  }, [phase]);

  const onCancelClick = async (): Promise<void> => {
    await sei.cancelGoogle();
    onCancel();
  };

  const onTryAgain = (): void => {
    start();
  };

  const titleId = 'oauth-interstitial-title';

  return (
    <div className={styles.scrim} role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className={styles.modal}>
        {phase.kind === 'waiting' ? (
          <>
            <h2 id={titleId} className={styles.title}>Continue in your browser</h2>
            <p className={styles.body}>
              We&apos;ve opened a browser tab to finish signing in with Google. Come back here when you&apos;re done — this window will update automatically.
            </p>
            <p className={styles.countdown} aria-live="polite">
              This will close on its own in {phase.secondsLeft}s.
            </p>
            <div className={styles.footer}>
              <Button kind="ghost" size="md" onClick={onCancelClick} ref={cancelBtnRef}>
                Cancel sign-in
              </Button>
            </div>
          </>
        ) : null}

        {phase.kind === 'success' || phase.kind === 'finalizing' ? (
          <>
            <h2 id={titleId} className={styles.title}>Continue in your browser</h2>
            <p className={styles.success}>Signed in. One moment…</p>
          </>
        ) : null}

        {phase.kind === 'error' ? (
          <>
            <h2 id={titleId} className={styles.title}>{ERROR_COPY[phase.reason].heading}</h2>
            <p className={styles.body}>{ERROR_COPY[phase.reason].body}</p>
            <div className={styles.footer}>
              <Button kind="quiet" size="md" onClick={onCancelClick}>Cancel sign-in</Button>
              <Button kind="ghost" size="md" onClick={onTryAgain}>Try again</Button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
```

NOTE: Verify `Button` accepts a `ref` prop. If it does not (the existing component probably does not), use a useRef-and-focus-on-mount pattern via `document.querySelector` after the modal mounts, OR add ref forwarding to Button as a small follow-up. Pragmatic fallback: omit cancelBtnRef and let the browser handle the default focus order — note this in the SUMMARY.

4. Edit `src/renderer/src/components/SignInModal.tsx`:

   (a) Add state: `const [oauthInFlight, setOauthInFlight] = useState(false);`.
   (b) Import OAuthInterstitialModal: `import { OAuthInterstitialModal } from './OAuthInterstitialModal';`.
   (c) Replace the body of `onGoogleClick`:

   ```typescript
   const onGoogleClick = (): void => {
     setError(null);
     setOauthInFlight(true);
   };
   ```

   (d) At the end of SignInModal's JSX (after the closing `</div>` of styles.scrim's wrapper but BEFORE the outermost return closes), conditionally render:

   ```tsx
   {oauthInFlight ? (
     <OAuthInterstitialModal
       onResult={(res) => {
         setOauthInFlight(false);
         if (res.ok) {
           onClose();
         } else if (!res.ok) {
           // user_cancelled is handled by the interstitial's onCancel path;
           // other reasons surface as error variants inside the interstitial
           // which lets the user Try again. If we got here it's because the
           // interstitial decided to bubble the result up — keep email and stay
           // on SignInModal.
         }
       }}
       onCancel={() => {
         setOauthInFlight(false);
         // SignInModal stays mounted; email value preserved in `email` state.
       }}
     />
   ) : null}
   ```
  </action>
  <verify>
    <automated>! grep -q "// IMPLEMENTED IN PLAN 10-05" src/main/auth/authHandlers.ts && grep -c "startGoogleOAuth" src/main/auth/authHandlers.ts | grep -q "^1$" && grep -c "AbortController" src/main/auth/authHandlers.ts | grep -q "^1$" && grep -c "timeoutMs: 60_000\|timeoutMs: 60000" src/main/auth/authHandlers.ts | grep -q "^1$" && grep -cF "Continue in your browser" src/renderer/src/components/OAuthInterstitialModal.tsx | grep -q "^1$" && grep -cF "Cancel sign-in" src/renderer/src/components/OAuthInterstitialModal.tsx | grep -qE "^[2-9]" && grep -cF "Try again" src/renderer/src/components/OAuthInterstitialModal.tsx | grep -q "^1$" && grep -cF "Signed in. One moment" src/renderer/src/components/OAuthInterstitialModal.tsx | grep -q "^1$" && grep -cF "Sign-in didn" src/renderer/src/components/OAuthInterstitialModal.tsx | grep -q "^1$" && grep -cF "That took a little too long" src/renderer/src/components/OAuthInterstitialModal.tsx | grep -q "^1$" && grep -cF "Google declined" src/renderer/src/components/OAuthInterstitialModal.tsx | grep -q "^1$" && grep -cF "Couldn't open the sign-in helper" src/renderer/src/components/OAuthInterstitialModal.tsx | grep -q "^1$" && grep -cF "Sign-in hit a snag" src/renderer/src/components/OAuthInterstitialModal.tsx | grep -q "^1$" && grep -cF "Couldn't reach Google" src/renderer/src/components/OAuthInterstitialModal.tsx | grep -q "^1$" && grep -cF "OAuthInterstitialModal" src/renderer/src/components/SignInModal.tsx | grep -qE "^[2-9]" && grep -cE "sei\\.cancelGoogle" src/renderer/src/components/OAuthInterstitialModal.tsx | grep -q "^1$" && grep -cE "sei\\.signInGoogle" src/renderer/src/components/OAuthInterstitialModal.tsx | grep -q "^1$" && npx tsc --noEmit</automated>
  </verify>
  <acceptance_criteria>
    - `grep -c "// IMPLEMENTED IN PLAN 10-05" src/main/auth/authHandlers.ts` equals 0 (both shells replaced)
    - `grep -c "startGoogleOAuth" src/main/auth/authHandlers.ts` equals 1
    - `grep -c "AbortController" src/main/auth/authHandlers.ts` equals 1
    - `grep -cE "timeoutMs: (60_000|60000)" src/main/auth/authHandlers.ts` equals 1
    - `grep -c "oauthController" src/main/auth/authHandlers.ts` >= 3
    - All 6 UI-SPEC OAuth error heading strings present in OAuthInterstitialModal.tsx:
      - `grep -cF "Sign-in didn't finish" src/renderer/src/components/OAuthInterstitialModal.tsx` >= 1
      - `grep -cF "Couldn't reach Google" src/renderer/src/components/OAuthInterstitialModal.tsx` >= 1
      - `grep -cF "That took a little too long" src/renderer/src/components/OAuthInterstitialModal.tsx` >= 1
      - `grep -cF "Google declined the sign-in" src/renderer/src/components/OAuthInterstitialModal.tsx` >= 1
      - `grep -cF "Couldn't open the sign-in helper" src/renderer/src/components/OAuthInterstitialModal.tsx` >= 1
      - `grep -cF "Sign-in hit a snag" src/renderer/src/components/OAuthInterstitialModal.tsx` >= 1
    - `grep -cF "Continue in your browser" src/renderer/src/components/OAuthInterstitialModal.tsx` equals 1
    - `grep -cF "Cancel sign-in" src/renderer/src/components/OAuthInterstitialModal.tsx` >= 2 (waiting state + error states)
    - `grep -cF "Try again" src/renderer/src/components/OAuthInterstitialModal.tsx` >= 1
    - `grep -cF "Signed in. One moment" src/renderer/src/components/OAuthInterstitialModal.tsx` >= 1
    - `grep -cE "width: 460px" src/renderer/src/components/OAuthInterstitialModal.module.css` equals 1
    - `grep -cE "rgba\\(0, 0, 0, 0\\.45\\)" src/renderer/src/components/OAuthInterstitialModal.module.css` equals 1
    - `grep -cE "sei\\.signInGoogle" src/renderer/src/components/OAuthInterstitialModal.tsx` equals 1
    - `grep -cE "sei\\.cancelGoogle" src/renderer/src/components/OAuthInterstitialModal.tsx` equals 1
    - `grep -cF "OAuthInterstitialModal" src/renderer/src/components/SignInModal.tsx` >= 2 (import + JSX usage)
    - `npx tsc --noEmit` exits 0
  </acceptance_criteria>
  <done>
    signInWithGoogle / cancelGoogle wired to loopbackPkce; OAuthInterstitialModal renders all 6 UI-SPEC error variants with verbatim copy; SignInModal preserves email across cancelled OAuth attempts; tsc clean.
  </done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <name>Task 3 (checkpoint): End-to-end Google OAuth against real Google Cloud Console + Supabase project</name>
  <files>none — human verification of prior code-producing tasks</files>
  <action>Perform the verification steps listed under <how-to-verify> below. The executor must NOT skip; this checkpoint gates the wave.</action>
  <verify>
    <automated>echo "human checkpoint — see how-to-verify below"; true</automated>
  </verify>
  <done>User has replied "approved" to the resume signal below.</done>
  <what-built>
    Full Google OAuth flow: SignInModal → 'Continue with Google' → OAuthInterstitialModal (60s countdown) → system browser → 127.0.0.1 loopback → Supabase code exchange → MainApp. Cancellation returns to SignInModal preserving the email. All 6 error variants reachable.
  </what-built>
  <how-to-verify>
    Pre-flight: complete the Google Cloud Console + Supabase Auth Google provider setup listed in user_setup.

    1. Delete `<userData>/Sei Launcher Dev/session.bin`. Launch `npm run dev`. From AuthChoice → Sign In tile → SignInModal opens.
    2. Type your email into the Email field (DON'T submit). Click 'Continue with Google'. SignInModal stays mounted but the interstitial scrim appears with title `Continue in your browser`, body about the browser tab, and a `This will close on its own in 60s.` caption that decrements. The system browser opens to Google's sign-in page (NOT a BrowserWindow inside Electron — verify the browser is your default browser).
    3. Sign in with a real Google account that's been added as a test user to your Google Cloud project. Google redirects to `http://127.0.0.1:<port>/callback?code=...`. The browser tab shows `You can close this tab.` page and attempts to window.close itself. Sei's interstitial flips to `Signed in. One moment…` for ~200ms, then closes. The app routes to MainApp (or the 2-step signed-in OnboardingScreen for first-time accounts).
    4. Verify session.bin exists: `ls -la <userData>/Sei\ Launcher\ Dev/session.bin`. Quit. Relaunch. App goes straight to home — session restored.
    5. Sign out (manually delete session.bin). Relaunch. Sign In tile → SignInModal → type an email like `cancel-test@example.com` → Continue with Google → interstitial opens. Click `Cancel sign-in`. Interstitial closes. SignInModal is still visible AND the email field still contains `cancel-test@example.com` (AUTH-02 cancellation contract).
    6. Trigger timeout: click Continue with Google → wait 60 full seconds without doing anything in the browser. Interstitial flips to `That took a little too long` heading + the timeout body + `Try again` + `Cancel sign-in` buttons. Click `Try again` → new browser tab opens (new loopback port, new Google auth URL). Click `Cancel sign-in` → return to SignInModal.
    7. Trigger google_rejected: in your Google Cloud Console, remove your test account from OAuth consent → in Sei, click Continue with Google → sign in with that account → Google blocks it. Interstitial flips to `Google declined the sign-in` variant.
    8. Verify no BrowserWindow ever opens during the flow: open Sei's DevTools, run `BrowserWindow.getAllWindows().length` — expect 1 (just the main app window). Verify `grep -c BrowserWindow src/main/auth/loopbackPkce.ts` returns 0.
    9. Verify `window.sei.onAuthState((s) => console.log(s))` after a successful Google sign-in logs `{kind:'signed_in', user:{email:<your-google-email>, ...}}`.
  </how-to-verify>
  <resume-signal>
    Reply `approved` if all 9 steps pass. If step 3 fails to redirect, check Supabase Auth → Providers → Google has the right client_id/secret AND the Redirect URLs include `https://<your-project>.supabase.co/auth/v1/callback` (Supabase's own callback) — that is configured by Supabase automatically, but the Google Cloud OAuth client must register `http://127.0.0.1` as a redirect URI for the loopback step.
  </resume-signal>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| Sei main process ↔ system browser | shell.openExternal hands a URL to the browser; everything else (Google consent, PKCE) lives in the browser. |
| Loopback 127.0.0.1:<port> ↔ browser | Bind is LITERALLY 127.0.0.1 (asserted by grep). LAN cannot reach the port; firewall prompts not triggered. |
| Code exchange ↔ Supabase | Code value travels from loopback handler to main's Supabase client; never leaves the main process. |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-10-05-01 | Spoofing | Attacker binds 127.0.0.1:<port> BEFORE Sei does, intercepts callback | mitigate | Per RFC 8252 §7.3, OS-chosen ephemeral port (bind port 0) is unpredictable; PKCE code_verifier (managed by Supabase JS) prevents code-substitution attacks. Server.listen with port:0 returns the actually-bound port — no race for a fixed port. |
| T-10-05-02 | Tampering | A malicious page on the user's browser scripts a window.opener.postMessage attack on the polite "you can close this tab" HTML | accept | The "you can close this tab" page is served by Sei's loopback server; the page's window has no opener relationship to Sei (Sei is not a browser parent). Content is static; only window.close() runs. |
| T-10-05-03 | Information Disclosure | shell.openExternal opens a URL with the auth code in query string (logged to browser history) | accept | The CODE is in the redirect URL FROM Google → 127.0.0.1, not in the URL Sei opens (Sei opens Google's auth URL). Auth codes are single-use and short-lived; browser-history exposure is the standard OAuth desktop-app risk. RFC 8252 acknowledges. |
| T-10-05-04 | Elevation of Privilege | BrowserWindow OAuth introduced by future contributor → Google blocks → bypass attempt with custom URL scheme | mitigate | Grep gate: `grep -c BrowserWindow src/main/auth/loopbackPkce.ts` MUST equal 0. Code comment cites Pitfall 4 + RFC 8252. |
| T-10-05-05 | Spoofing | Loopback widens to 0.0.0.0 → LAN can hit the callback | mitigate | Grep gate: `grep -c 0.0.0.0 src/main/auth/loopbackPkce.ts` MUST equal 0. Literal '127.0.0.1' grep-asserted (mirror of skinServer.ts). |
| T-10-05-06 | Denial of Service | Loopback server left listening after timeout/abort → port leak | mitigate | finally { server.close() } in startGoogleOAuth. server.close() drains in-flight requests. Acceptance criterion: code path always reaches the finally branch. |
| T-10-05-07 | Tampering | Renderer fakes an auth:cancel-google to disrupt the in-flight flow | accept | Cancel is user-initiated; if a malicious renderer fakes it, the user just hits Cancel — the cost is one re-auth. No data leak. |
| T-10-05-08 | Information Disclosure | Browser tab's `window.close()` is blocked by browser → user sees a stale "Returning to Sei…" page indefinitely | accept | Modern browsers block window.close on pages they didn't open. Body copy explicitly says "You can close this tab." — user closes manually. No security implication. |
| T-10-05-09 | Tampering | Plan 04's SignInModal Google button bypasses the interstitial flow | mitigate | Code grep: `grep -cF "OAuthInterstitialModal" src/renderer/src/components/SignInModal.tsx` >= 2 ensures the modal is wired. |
</threat_model>

<verification>
1. `npx tsc --noEmit` exits 0.
2. `npx vitest run src/main/auth/loopbackPkce.test.ts` — 5 tests pass.
3. Human checkpoint (Task 3) — all 9 steps pass against real Google + Supabase.
4. `grep -c BrowserWindow src/main/auth/loopbackPkce.ts` equals 0.
5. `grep -c 0.0.0.0 src/main/auth/loopbackPkce.ts` equals 0.
</verification>

<success_criteria>
- loopbackPkce.ts mirrors RESEARCH Pattern 2 verbatim with full abortSignal/timeout integration
- 127.0.0.1 literal grep-asserted; BrowserWindow / 0.0.0.0 absent
- signInWithGoogle owns a module-level AbortController; cancelGoogle aborts it
- OAuthInterstitialModal renders all 6 UI-SPEC error variants with verbatim copy
- SignInModal preserves typed email across cancelled OAuth attempts
- 5 vitest cases pass; tsc clean
- Human-verified end-to-end against real Google + Supabase
</success_criteria>

<output>
After completion, create `.planning/phases/10-auth-foundation/10-05-SUMMARY.md` covering: the loopback contract (port:0, 127.0.0.1-only, one-shot), the interstitial → SignInModal cancellation flow (email preserved), and the 6 reason → UI-SPEC variant mapping (so plan 06+ knows the OAuth result shape is stable).
</output>
