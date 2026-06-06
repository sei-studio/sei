# Phase 10: Auth Foundation - Research

**Researched:** 2026-05-19
**Domain:** Electron desktop auth (Supabase Auth + loopback PKCE) + session persistence (safeStorage) + GDPR plumbing (Edge Function delete + JSON export) + first-class local-only path
**Confidence:** HIGH on stack and patterns (Supabase JS verified 2.106.0; Electron safeStorage backend detection verified; Google loopback flow CITED to RFC 8252 + Google docs); MEDIUM on Supabase-in-Electron PKCE edge cases (discussions #17722, #27181 surface real bugs — half-day spike planned); MEDIUM on 30-day Storage purge mechanics (multiple valid approaches, user decision in CONTEXT D-13 is "queued by Edge Function" but the queuing infra is Claude's discretion).

## Summary

Phase 10 grafts a complete identity layer onto the existing v0.1.1 three-process Electron app without disturbing the local-only experience. The stack is small and prescriptive: **`@supabase/supabase-js@^2.106.0`** in the main process, a **20-line `node:http` loopback callback server** for Google PKCE, and a **direct clone of `apiKeyStore.ts`** for `session.bin` persistence under `safeStorage`. The renderer never touches Supabase or sessions — main is the single Supabase client owner, with JWT delivery to utilityProcess limited to the existing MessagePortMain channel.

The two real risks are (1) the documented Supabase-in-Electron `getSession()`-returns-401-after-deep-link bug (discussions #17722 / #27181 — workaround: skip deep-link transport entirely, exchange the auth code inside the main process's loopback handler with `exchangeCodeForSession(code)` and only push the resulting JWT — never the full URL — onward) and (2) the 30-day Storage purge being asynchronous in a way that orphans the auth user if implemented naively. Both have clear mitigations baked into the recommended approach below.

**Primary recommendation:** Build a tiny main-process `auth/` module (`supabaseClient.ts`, `sessionStore.ts`, `loopbackPkce.ts`, `authState.ts`) that owns Supabase end-to-end. Renderer subscribes to `auth:state` over IPC for `{kind:'local'} | {kind:'signed_in', user, emailVerified}` transitions. utilityProcess receives only refreshed JWTs over MessagePortMain — never the refresh token, never the full session. Edge Function `supabase/functions/delete-me/` handles deletion + queues 30-day Storage purge via a `deletion_queue` Postgres table consumed by Supabase's `pg_cron` extension (or, in Phase 11+, an admin-only Edge Function on a CRON trigger).

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**First-launch flow & sign-in placement (D-01..D-05):**

- **D-01:** A new `AuthChoice` screen renders before today's `OnboardingScreen`. Two equal-weight tiles: **Sign In** and **Continue Locally**. There is no third "Create account" tile — the Sign In tile opens a unified sign-in/sign-up form (toggle inside the form).
- **D-02:** "Continue Locally" is privacy-first framing (not "guest", not "skip"). Choosing it routes into today's 5-step `OnboardingScreen` unchanged. BYO LLM (local Ollama or direct provider API key) remains required in this mode.
- **D-03:** Signed-in users skip the provider/API-key step of `OnboardingScreen` entirely. The bot defaults to cloud-proxy AI mode. Phase 10 ships a **"Cloud AI — coming soon"** placeholder that gracefully falls back to letting the user paste a BYO key. Phase 13 lands the actual `baseURL`-override proxy and replaces the placeholder.
- **D-04:** Email verification does **not** block sign-in. After signup, the user proceeds immediately into the app. A persistent "Verify your email" banner shows in-app; cloud-write attempts (Phase 11 publishing, Phase 13 purchasing) are blocked with a "verify first" modal.
- **D-05:** Google OAuth interstitial is a **centered modal**: "Continue in your browser to finish signing in" with a Cancel button and a 60s auto-dismiss timeout. The Google auth URL is opened via `shell.openExternal()`.

**Account state model + sign-out semantics (D-06..D-10):**

- **D-06:** Two-state user model: **`local`** and **`signed_in`**. There is no separate "signed_out" state.
- **D-07:** `local` mode is privacy-first: cloud-only surfaces show inline **"Sign In"** CTAs where they would otherwise be active.
- **D-08:** Signing in unlocks exactly two things: (1) cloud-proxied AI models and (2) cloud character library read/write. Nothing else changes.
- **D-09:** Sign-out while bot running: single confirmation → stop bot cleanly → clear session → drop into `local` mode with no screen transition. Local files, memory, and cached cloud character definitions untouched.
- **D-10:** `local` → `signed_in` upgrade happens via an inline modal overlay. On success, the user lands on the feature they originally clicked. Local files/keys/memory untouched.

**Account deletion (D-11..D-13) + data export (D-14):**

- **D-11:** A new **"Account" panel** in `SettingsScreen` (visible only when `signed_in`) groups: account email, **Sign Out**, **Export My Data**, **Delete Account** (red, bottom).
- **D-12:** Account deletion is a single **type-email-to-confirm** modal. Body states: (a) 30-day deletion window, (b) what gets deleted (cloud characters + Storage objects + credit ledger), (c) what stays (local characters + local memory + cached cloud definitions).
- **D-13:** Deletion is executed via a **Supabase Edge Function** at `supabase/functions/delete-me/`. Function verifies caller's JWT, calls `auth.admin.deleteUser(jwt.sub)`, queues a 30-day Storage purge job, returns 204. The desktop client never holds `service_role`. This is the project's first Edge Function.
- **D-14:** Data export is a single `sei-export-<YYYY-MM-DD>.json` file with a versioned schema locked in Phase 10:
  ```json
  {
    "schemaVersion": 1,
    "exportedAt": "<ISO timestamp>",
    "account": { "email": "...", "createdAt": "..." },
    "characters": [],
    "sharing": []
  }
  ```
  Phase 10 fills only `account`; Phase 11 fills `characters`; Phase 12 fills `sharing`.

### Claude's Discretion

- **Session storage shape** — single sealed `<userData>/session.bin` mirroring `src/main/apiKeyStore.ts` exactly (atomic tmp+rename, `safeStorage` encryption, `basic_text` Linux fallback warning). Supabase JS client auto-refresh stays enabled; refresh token + access token packed into the sealed blob.
- **utilityProcess JWT delivery** — JWT-only (not the full session) crosses to utilityProcess via the existing MessagePortMain channel. Main keeps the refresh token; pushes a fresh JWT before expiry.
- **AuthChoice tile copy, exact button placement, spacing, and Banner reuse** — visual polish per existing component style.
- **Linux `basic_text` warning placement** — likely a one-time dismissable `Banner` on first sign-in, following existing Banner pattern.
- **Inline upgrade modal styling** — reuse the existing modal pattern (likely `DeleteConfirmModal` as a structural template).
- **OAuth error copy** — clear, plain language for the various failure modes (browser closed, network failure, code expired, Google rejected).
- **Internal session refresh timing/retry policy** — standard Supabase auto-refresh + exponential backoff on network failure.

### Deferred Ideas (OUT OF SCOPE)

None — discussion stayed within Phase 10's scope. The Privacy Policy + Terms of Service gating of the first cloud write (LIB-06) is already owned by Phase 11 in REQUIREMENTS.md, not deferred from Phase 10.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| AUTH-01 | User can sign up / sign in with email + password via Supabase Auth | `supabase.auth.signInWithPassword()` + `signUp()` — covered §1 Supabase JS client; trivial in-process |
| AUTH-02 | Google sign-in via system browser + 127.0.0.1 loopback + PKCE | Covered §2 loopback PKCE; canonical pattern in CONTEXT canonical_refs; `shell.openExternal()` + `node:http` callback + `exchangeCodeForSession` |
| AUTH-03 | Session tokens persist via `safeStorage`; Linux `basic_text` warned once | `sessionStore.ts` direct clone of `apiKeyStore.ts` (§3); Banner one-time warning persisted via `sei.config.linuxBasicTextWarnDismissed` |
| AUTH-04 | "Continue without account" first-class on first launch | AuthChoiceScreen + routing decision in `src/main/index.ts` (§5); local mode = no Supabase client init, no cloud writes |
| AUTH-05 | Sign-out clears session but preserves local files / memory / cached cloud defs | `sessionStore.clear()` only — no characterStore / memoryDir mutation (§3) |
| AUTH-06 | Account deletion purges Supabase rows + Storage within 30 days | Edge Function `supabase/functions/delete-me/` (§6) — immediate `auth.admin.deleteUser`, queued 30-day Storage purge via `deletion_queue` table + pg_cron or scheduled Edge Function |
| AUTH-07 | JSON data export of cloud data | `auth:export-data` IPC handler builds the schemaVersion-1 envelope (§7), `dialog.showSaveDialog` writes to disk |
</phase_requirements>

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Supabase client (`createClient`) | Main process | — | Owns OS resources (safeStorage, loopback server); renderer never imports Supabase. Single source of truth per CONTEXT code_context. |
| Session persistence (sealed `session.bin`) | Main process | — | Requires `safeStorage` (main-only Electron API); already-established `apiKeyStore.ts` pattern. |
| Loopback PKCE callback server | Main process | — | `node:http` listener; requires `shell.openExternal` (main-only) + Supabase code exchange (main-owned client). |
| Email/password sign-in form UI | Renderer | Main (validates + executes via IPC) | Renderer collects credentials, `auth:signin-password` IPC channel sends to main which calls `supabase.auth.signInWithPassword`. |
| Auth state subscription (`local` / `signed_in`) | Main (source of truth) | Renderer (subscriber via `auth:state` push channel) | Main holds the Supabase `onAuthStateChange` subscription; broadcasts to renderer via `webContents.send`. |
| JWT delivery to utilityProcess | Main process | utilityProcess (consumer over MessagePortMain) | Main keeps refresh token; pushes fresh JWT-only before expiry. utilityProcess never sees refresh token. Per Claude's discretion in CONTEXT. |
| Account deletion (`auth.admin.deleteUser`) | Supabase Edge Function (`delete-me/`) | Main process (caller) | service_role required; never on client. Edge Function is the trust boundary. |
| Storage purge queue (30-day window) | Supabase backend (pg_cron + `deletion_queue` table) | Edge Function (admin worker) | Async by design; no client involvement after deletion request. |
| JSON export envelope construction | Main process | Renderer (triggers, presents save dialog result) | Main has Supabase session + can fetch account metadata; `dialog.showSaveDialog` is main-only. |
| Verify-email Banner | Renderer | Main (sources `emailVerified` from session) | Pure UI; reads `emailVerified` from `auth:state`. |
| Linux `basic_text` warning Banner | Renderer | Main (sources backend kind via existing `app:warnings` IPC, extended) | Reuses existing `apiKeyStore.backendKind()` plumbing pattern. |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@supabase/supabase-js` | `^2.106.0` | Supabase client (auth + future DB/Storage) | Official client. `2.106.0` is latest as of 2026-05-18 per `npm view`. [VERIFIED: `npm view @supabase/supabase-js version` → 2.106.0; publish 2026-05-18] |
| `node:http` (Node stdlib) | — | One-shot loopback callback server for Google PKCE | Already in Node 20+; Google's [native-app guide][google-native] explicitly endorses loopback over custom schemes. No third-party dep needed — 20–40 LOC. [CITED: https://developers.google.com/identity/protocols/oauth2/native-app] |
| `electron.safeStorage` (built-in) | Electron 42 | Sealed encryption of `session.bin` | Already used by `apiKeyStore.ts`. [VERIFIED: existing module] |
| `electron.shell.openExternal` (built-in) | Electron 42 | Opens Google auth URL in system browser | Mandatory per Pitfall 4 (Google blocks BrowserWindow OAuth). [VERIFIED: existing pattern in codebase via wizard install flow] |
| `electron.dialog.showSaveDialog` (built-in) | Electron 42 | OS save-as for `sei-export-<date>.json` | Native cross-platform save UX. No third-party dep needed. [CITED: https://www.electronjs.org/docs/latest/api/dialog] |
| `zod` | `^3.22.4` (existing) | IPC boundary validation for `auth:*` channels | Already in project; matches existing `src/main/ipc.ts` discipline. [VERIFIED: package.json] |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| Supabase CLI (`supabase`) | `^2.100.1` | Local Edge Function dev (`supabase functions serve`), deploy (`supabase functions deploy delete-me`) | Required for Edge Function dev workflow. Install via `brew install supabase/tap/supabase` or `npm i -g supabase`. [VERIFIED: `npm view supabase version` → 2.100.1; CITED: https://supabase.com/docs/guides/functions/quickstart] |
| Deno runtime | bundled with Supabase CLI | Edge Function runtime (Deno, not Node) | Edge Functions run on Deno. Code lives in `supabase/functions/delete-me/index.ts`. [CITED: https://supabase.com/docs/guides/functions] |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `@supabase/supabase-js` | `@supabase/ssr` (`^0.10.3`) | `@supabase/ssr` is for Next.js / server-rendered web with cookie storage. Electron main process is not a web server; cookie semantics add no value. Stick with `supabase-js` + custom `safeStorage` adapter. [VERIFIED: `npm view @supabase/ssr version`] |
| `node:http` loopback | `electron-oauth-helper` / `electron-oauth2` | Both bake in BrowserWindow — incompatible with Pitfall 4 (Google `disallowed_useragent`). Custom 20-line `node:http` server is simpler and safer. [ASSUMED: based on STACK §2 recommendation; no MEDIUM-LOW alternative survives the BrowserWindow exclusion] |
| Custom URL scheme (`sei://`) | `app.setAsDefaultProtocolClient('sei')` + deep-link | Per CONTEXT D-13 and STACK §2: custom schemes have Linux protocol-handler issues and require platform-specific Electron handlers. Loopback is cross-platform and Google-blessed. [CITED: STACK.md §2; https://developers.google.com/identity/protocols/oauth2/native-app] |
| Edge Function for delete | Direct `auth.admin.deleteUser` from main with `service_role` shipped to client | Would leak service_role to every install — instant security failure. Edge Function is the only viable boundary. [CITED: https://supabase.com/docs/guides/functions/auth] |
| pg_cron for purge | Cron-triggered Edge Function | Both work. pg_cron is simpler (no new function); cron-triggered Edge Function gives more flexibility for Phase 11+ admin ops. CONTEXT D-13 calls this "Phase 10 sets the supabase/functions/ convention" — recommend pg_cron in Phase 10 (one less function to deploy), revisit when Phase 11/12 admin work justifies a second function. [ASSUMED] |

**Installation:**
```bash
npm install @supabase/supabase-js
# Supabase CLI for Edge Function dev (one-time, machine-global):
brew install supabase/tap/supabase   # or: npm i -g supabase
```

**Version verification (run before pinning):**
```bash
npm view @supabase/supabase-js version   # expected: 2.106.0+ as of 2026-05-18
npm view supabase version                # expected: 2.100.1+
```
Training data versions are stale by months — re-run these before committing the package.json change.

## Architecture Patterns

### System Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│  Renderer (React)                                                   │
│    AuthChoiceScreen → SignInModal | OAuthInterstitialModal          │
│           │                  │                                       │
│           └──── auth:* ──────┘  (IPC: signin-password, signup-pwd,  │
│                                  signin-google, signout, delete-acct, │
│                                  export-data, resend-verification)   │
│    Subscribes:  onAuthState({kind:'local'|'signed_in', user, emailVerified}) │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ IPC (preload contextBridge)
┌──────────────────────────────▼──────────────────────────────────────┐
│  Main process                                                       │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ src/main/auth/                                               │   │
│  │   supabaseClient.ts  ──► createClient(SUPABASE_URL, ANON_KEY)│   │
│  │       └─► onAuthStateChange ──► broadcasts auth:state        │   │
│  │   sessionStore.ts    ──► save/load/clear sealed session.bin  │   │
│  │       (clone of apiKeyStore.ts — safeStorage + atomic        │   │
│  │        tmp+rename + backendKind() fallback warning)          │   │
│  │   loopbackPkce.ts    ──► startServer({onCode}) → port number │   │
│  │       └─► node:http listener; first GET /callback?code=...   │   │
│  │           closes server, returns 200 "You can close this tab"│   │
│  │   authState.ts       ──► state machine: local ↔ signed_in    │   │
│  │       (no signed_out — D-06)                                 │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                              │                                       │
│                              ├──► HTTPS ──► Supabase Auth            │
│                              │                                       │
│                              ├──► POST ───► Supabase Edge Function   │
│                              │              `delete-me/` (D-13)      │
│                              │                                       │
│                              └──► MessagePortMain ────────┐          │
│                                   (JWT only, refreshed     │          │
│                                    before expiry)          │          │
└────────────────────────────────────────────────────────────┼──────────┘
                                                             │
┌────────────────────────────────────────────────────────────▼──────────┐
│  utilityProcess (bot loop)                                            │
│  Consumes JWT from main; uses it as Bearer for proxy calls (Phase 13).│
│  In Phase 10: receives JWT but doesn't use it yet — wiring only.      │
└──────────────────────────────────────────────────────────────────────┘

External:
┌───────────────────────────────────────────────────────────────────────┐
│  System browser (via shell.openExternal)                              │
│    Google OAuth consent → 302 to http://127.0.0.1:<port>/callback?code=│
└───────────────────────────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────────────────────────┐
│  Supabase Backend                                                     │
│  - auth.users (managed by Supabase Auth)                              │
│  - storage.buckets (Phase 11+; Phase 10 nothing to delete yet)        │
│  - deletion_queue table + pg_cron job that purges Storage 30d after   │
│    deletion_requested_at                                              │
│  - Edge Function `delete-me/` (verify JWT → admin.deleteUser →        │
│    insert into deletion_queue)                                        │
└───────────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| File (new) | Purpose | Mirrors / Reuses |
|------------|---------|------------------|
| `src/main/auth/supabaseClient.ts` | Lazy-init Supabase client behind `app.whenReady`; expose `getClient()` | New |
| `src/main/auth/sessionStore.ts` | save/load/clear sealed session blob | Direct clone of `src/main/apiKeyStore.ts` (compare for parity) |
| `src/main/auth/loopbackPkce.ts` | `startCallbackServer({onCode, timeoutMs}) → {port, abort}` | New — `node:http` server (~30 LOC) |
| `src/main/auth/authState.ts` | State machine + broadcast `auth:state` | New |
| `src/main/auth/jwtBridge.ts` | Push fresh JWT to utilityProcess over MessagePortMain | Extends existing botSupervisor MessageChannel pattern |
| `src/main/auth/exportBuilder.ts` | Build schemaVersion-1 JSON envelope (Phase 10 fills only `account`) | New |
| `src/main/paths.ts` (edit) | Add `sessionPath() = path.join(userDataRoot(), 'session.bin')` | Mirrors `apiKeyPath()` |
| `src/main/ipc.ts` (edit) | Add `auth:*` handlers per channel list | Extends existing pattern |
| `src/main/index.ts` (edit) | Add auth bootstrap + route decision before existing migration | Extends `bootstrap()` |
| `supabase/functions/delete-me/index.ts` | Deno Edge Function — verify JWT → `auth.admin.deleteUser` → insert into `deletion_queue` | New (project's first Edge Function — sets convention) |
| `supabase/migrations/<ts>_deletion_queue.sql` | `deletion_queue` table + pg_cron job | New |
| `supabase/config.toml` (or similar) | Per-function config | New |
| `src/renderer/src/screens/AuthChoiceScreen.tsx` + `.module.css` | New first-launch screen | Composes existing `Button`, `SeiPixelMark` |
| `src/renderer/src/components/SignInModal.tsx` + `.module.css` | Unified sign-in/sign-up form | Composes `TextField`, `Button`; scrim+modal scaffold from `SetupWizardModal` |
| `src/renderer/src/components/OAuthInterstitialModal.tsx` + `.module.css` | Centered modal during Google OAuth | New |
| `src/renderer/src/components/DeleteAccountModal.tsx` + `.module.css` | Type-email-to-confirm | Clone of `DeleteConfirmModal.module.css` + a TextField row |
| `src/renderer/src/components/SignOutConfirmModal.tsx` + `.module.css` | Two-branch (bot running / not) confirm | Clone of `DeleteConfirmModal` shell |
| `src/renderer/src/screens/SettingsScreen.tsx` (edit) | Add `AccountPanel` section (visible only `signed_in`) | Extends existing screen |
| `src/renderer/src/screens/OnboardingScreen.tsx` (edit) | Accept `signedIn?: boolean` prop → 5 steps becomes 3 (skip provider/API-key) | Extends existing screen |
| `src/renderer/src/App.tsx` (edit) | Top gate: AuthChoice → (OnboardingScreen|MainApp) per `auth:state` | Extends existing routing |

### Pattern 1: Supabase client with `safeStorage`-backed custom storage

**What:** Provide a custom `storage` adapter to `createClient` so Supabase JS reads/writes session through our `sessionStore.ts` (sealed blob) instead of `localStorage` (which doesn't exist in main and shouldn't be used in renderer anyway).

**When to use:** This is the canonical Electron-with-Supabase pattern. Replaces the default `localStorage` adapter.

**Example:**
```typescript
// Source: CITED https://supabase.com/docs/reference/javascript/initializing
//         + adapter shape per @supabase/supabase-js types (Storage interface)
//         + sessionStore.ts mirrors apiKeyStore.ts (existing codebase)
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import * as sessionStore from './sessionStore';

// Custom storage adapter — Supabase calls these to persist its session
const safeStorageAdapter = {
  async getItem(key: string): Promise<string | null> {
    // key is always 'sb-<project-ref>-auth-token' for the session
    try {
      return await sessionStore.loadJson(key);
    } catch { return null; }
  },
  async setItem(key: string, value: string): Promise<void> {
    await sessionStore.saveJson(key, value);
  },
  async removeItem(key: string): Promise<void> {
    await sessionStore.removeJson(key);
  },
};

let client: SupabaseClient | null = null;

export function getClient(): SupabaseClient {
  if (client) return client;
  client = createClient(
    process.env.SUPABASE_URL!,        // compiled in via electron-vite define
    process.env.SUPABASE_ANON_KEY!,
    {
      auth: {
        storage: safeStorageAdapter,
        autoRefreshToken: true,           // claude-discretion: keep on
        persistSession: true,
        detectSessionInUrl: false,        // CRITICAL — main process isn't a browser
        flowType: 'pkce',                 // CITED: https://supabase.com/docs/guides/auth/sessions/pkce-flow
      },
    },
  );
  return client;
}
```

### Pattern 2: Loopback PKCE callback server (Google OAuth)

**What:** Open a short-lived `node:http` server on an OS-chosen ephemeral port, register the resulting URL as `redirectTo`, open Google's auth URL in the system browser, capture the `?code=` query, hand it to `supabase.auth.exchangeCodeForSession`.

**When to use:** Google OAuth in Electron desktop. Mandatory per Pitfall 4 and Google's deprecation of embedded webviews. Email/password does NOT need this.

**Port strategy:** OS-chosen ephemeral (bind port 0, read `.address().port`) per RFC 8252 §7.3 — Google's authorization server MUST accept any port for loopback redirect URIs. Registering `http://127.0.0.1` (no port) once in Google Cloud Console covers any port. [CITED: https://developers.google.com/identity/protocols/oauth2/native-app — "Loopback IP address flow"; CITED: https://www.oauth.com/oauth2-servers/oauth-native-apps/redirect-urls-for-native-apps/ — port arbitrary] This matches existing v0.1.1 skin server bind pattern (`createSkinServer` uses port 0).

**Example:**
```typescript
// Source: CITED https://developers.google.com/identity/protocols/oauth2/native-app
//         + Supabase signInWithOAuth + exchangeCodeForSession docs
//         + mirrors existing src/main/skinServer.ts ephemeral-port pattern
import { createServer, type Server } from 'node:http';
import { shell } from 'electron';
import { getClient } from './supabaseClient';

export interface OAuthResult { ok: true } // session lands via storage adapter
export interface OAuthError { ok: false; reason: 'user_cancelled' | 'timeout' | 'browser_closed' | 'google_rejected' | 'exchange_failed' | 'port_collision'; message: string }

export async function startGoogleOAuth(opts: { timeoutMs: number; abortSignal: AbortSignal }): Promise<OAuthResult | OAuthError> {
  const supabase = getClient();
  let server: Server | null = null;
  let port: number;

  try {
    // Bind port 0 → OS chooses an ephemeral free port (no port-collision retry needed)
    server = createServer();
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', () => resolve());
    });
    port = (server.address() as { port: number }).port;
  } catch (err) {
    return { ok: false, reason: 'port_collision', message: (err as Error).message };
  }

  const redirectTo = `http://127.0.0.1:${port}/callback`;

  // skipBrowserRedirect: true — we don't want Supabase to open the URL itself
  // (it can't in main process anyway); we open it via shell.openExternal.
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo, skipBrowserRedirect: true, flowType: 'pkce' },
  });
  if (error || !data?.url) {
    server.close();
    return { ok: false, reason: 'google_rejected', message: error?.message ?? 'no auth url' };
  }

  // Wait for callback OR timeout OR abort
  const codePromise = new Promise<string>((resolve, reject) => {
    server!.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get('code');
      const errParam = url.searchParams.get('error');
      // Send a polite page so the user's browser tab is helpful
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><body style="font-family:system-ui;padding:2em;text-align:center"><h2>You can close this tab.</h2><p>Returning to Sei…</p><script>window.close()</script></body></html>`);
      if (errParam) reject(new Error(errParam));
      else if (code) resolve(code);
      else reject(new Error('no code in callback'));
    });
  });

  const timeoutPromise = new Promise<never>((_, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), opts.timeoutMs);
    opts.abortSignal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); });
  });

  await shell.openExternal(data.url);

  try {
    const code = await Promise.race([codePromise, timeoutPromise]);
    const { error: exchErr } = await supabase.auth.exchangeCodeForSession(code);
    if (exchErr) return { ok: false, reason: 'exchange_failed', message: exchErr.message };
    return { ok: true };
  } catch (err) {
    const msg = (err as Error).message;
    if (msg === 'timeout') return { ok: false, reason: 'timeout', message: 'Code expired (60s)' };
    if (msg === 'aborted') return { ok: false, reason: 'user_cancelled', message: 'Cancelled' };
    return { ok: false, reason: 'browser_closed', message: msg };
  } finally {
    server.close();
  }
}
```

### Pattern 3: `sessionStore.ts` — direct clone of `apiKeyStore.ts`

**What:** Persist Supabase's session JSON as a sealed blob using `safeStorage`. Use the existing `apiKeyStore.ts` shape verbatim (atomic tmp+rename, `KEYCHAIN_UNAVAILABLE` error class, `backendKind()` for Linux fallback detection).

**When to use:** Whenever Supabase's auto-refresh wants to read/write the session — via the custom storage adapter from Pattern 1.

**Quoted template** (from `src/main/apiKeyStore.ts` — apply the same shape to `sessionStore.ts`):

```typescript
// EXISTING: src/main/apiKeyStore.ts (lines 23-38 — atomic write recipe)
export async function saveApiKey(plaintext: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('KEYCHAIN_UNAVAILABLE');
  }
  const buf = safeStorage.encryptString(plaintext);
  const target = paths.apiKeyPath();
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.tmp.${process.pid}.${Date.now()}`);
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await writeFile(tmp, buf);
    await rename(tmp, target);
  } catch (err) {
    try { await unlink(tmp); } catch {}
    throw err;
  }
}
```

For `sessionStore.ts`, the only differences are: function names (`saveSession` / `loadSession` / `clearSession`), error classes (`SESSION_UNAVAILABLE` / `SESSION_CORRUPT`), and the path (`paths.sessionPath()`). Decrypt-failure handling: if `safeStorage.decryptString` throws (corrupt blob, machine moved, keyring changed), treat as `SESSION_CORRUPT` — `clearSession()` and route the user to AuthChoice. Recovery is "user signs in again" — never crash on a corrupt session.

**Recommended shape** for the JSON-string adapter Supabase expects:

```typescript
// Supabase's storage interface speaks string-in/string-out. Wrap our binary
// sealed blob so callers don't see Buffer plumbing.
export async function saveJson(_key: string, value: string): Promise<void> {
  // We only ever store ONE session (Phase 10 = single signed-in user), so
  // we ignore the key — `safeStorage` writes to the single session.bin.
  if (!safeStorage.isEncryptionAvailable()) throw new Error('SESSION_UNAVAILABLE');
  const buf = safeStorage.encryptString(value);
  // atomic tmp+rename — see apiKeyStore.ts excerpt above
  // ...
}

export async function loadJson(_key: string): Promise<string | null> {
  try {
    const buf = await readFile(paths.sessionPath());
    return safeStorage.decryptString(buf);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    // SESSION_CORRUPT — clear and return null so Supabase treats it as logged out
    try { await unlink(paths.sessionPath()); } catch {}
    return null;
  }
}

export async function removeJson(_key: string): Promise<void> {
  try { await unlink(paths.sessionPath()); } catch {}
}
```

### Pattern 4: `paths.ts` extension

**What:** Add `sessionPath()` to the existing path module.

**Quoted template** (from `src/main/paths.ts`, line 29):

```typescript
// EXISTING (line 29):
apiKeyPath: () => path.join(userDataRoot(), 'api_key.bin'),

// ADD:
sessionPath: () => path.join(userDataRoot(), 'session.bin'),
```

This is the only edit to `paths.ts`. The `_setUserDataOverride` test hook already exists and covers `sessionPath()` automatically.

### Pattern 5: IPC channel extension

**What:** Add `auth:*` channels to `src/shared/ipc.ts` and handlers to `src/main/ipc.ts`.

**Channels to add:**

| Channel | Direction | Args (Zod) | Returns |
|---------|-----------|------------|---------|
| `auth:state` | main → renderer push | — | `{kind:'local'} \| {kind:'signed_in', email:string, emailVerified:boolean, userId:string, createdAt:string}` |
| `auth:signin-password` | renderer → main | `{email:string, password:string}` | `{ok:true} \| {ok:false, code:'invalid_credentials'\|'network'\|'rate_limited', message:string}` |
| `auth:signup-password` | renderer → main | `{email:string, password:string}` | `{ok:true, requiresVerification:boolean} \| {ok:false, code:'email_in_use'\|'weak_password'\|'invalid_email'\|'network', message:string}` |
| `auth:signin-google` | renderer → main | — | `{ok:true} \| {ok:false, reason:'user_cancelled'\|'timeout'\|'browser_closed'\|'google_rejected'\|'exchange_failed'\|'port_collision'\|'network', message:string}` |
| `auth:cancel-google` | renderer → main | — | `void` (fires AbortController inside main) |
| `auth:signout` | renderer → main | — | `void` |
| `auth:delete-account` | renderer → main | — | `{ok:true} \| {ok:false, code:'network'\|'edge_function_error', message:string}` |
| `auth:export-data` | renderer → main | — | `{ok:true, savedPath:string} \| {ok:false, code:'cancelled'\|'network'\|'write_failed', message:string}` |
| `auth:resend-verification` | renderer → main | — | `{ok:true} \| {ok:false, code:'rate_limited'\|'network', message:string}` |

**Handler skeleton** (mirrors existing `src/main/ipc.ts` discipline — Zod gate at boundary, lazy-import handler module):

```typescript
// Source: extends existing src/main/ipc.ts pattern (lines 79-281)
const SigninPasswordSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

ipcMain.handle(IpcChannel.auth.signinPassword, async (_event, argsRaw: unknown) => {
  const args = SigninPasswordSchema.parse(argsRaw);
  const { signInWithPassword } = await import('./auth/authHandlers');
  return await signInWithPassword(args);
});
```

### Anti-Patterns to Avoid

- **Importing Supabase into the renderer:** the renderer never imports `@supabase/supabase-js`. All Supabase access is mediated by `auth:*` IPC channels. Per CONTEXT code_context: "main owns OS resources (safeStorage, session, OAuth loopback server, Supabase client); renderer owns UI."
- **Importing Supabase into utilityProcess:** utilityProcess receives JWT-only over MessagePortMain. Per Claude's discretion in CONTEXT: "JWT-only (not the full session) crosses to utilityProcess."
- **Using BrowserWindow for Google OAuth:** Per Pitfall 4, `disallowed_useragent`. Always `shell.openExternal()` + loopback.
- **Shipping `SUPABASE_SERVICE_ROLE_KEY` to the client:** It must only live in Edge Function env vars. The client uses only the anon key.
- **Setting `detectSessionInUrl: true`:** Main process is not a browser; this option reads from `window.location`, which doesn't exist. Set explicitly to `false`.
- **Trusting `safeStorage.isEncryptionAvailable()` alone on Linux:** It returns `true` even when the backend is `basic_text`. Always also check `getSelectedStorageBackend()` and warn the user. [CITED: https://github.com/electron/electron/blob/main/docs/api/safe-storage.md]
- **Storing the refresh token in the renderer / utilityProcess:** Only the access token (JWT) crosses out of main. Refresh stays with the Supabase client in main.
- **Embedding the loopback callback in a permanent server:** Each OAuth attempt creates a one-shot server that closes after first callback or timeout. Long-lived loopback listeners are a security smell.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| OAuth PKCE state machine | Custom PKCE verifier/challenge generation, code exchange | Supabase JS client (`signInWithOAuth` + `exchangeCodeForSession`) | Supabase handles PKCE internally; rolling your own is the #1 way to silently disable PKCE protections. [CITED: https://supabase.com/docs/guides/auth/sessions/pkce-flow] |
| Session refresh / token rotation | Timer + `refreshToken` call + race condition handling | Supabase JS `autoRefreshToken: true` | Refresh has race conditions (parallel refresh requests can invalidate each other); battle-tested in `supabase-js`. |
| OS keychain integration | `keytar` / direct keyring binding | Electron `safeStorage` | Per Pitfall 15: keytar is deprecated; safeStorage is the modern path. Already in v0.1.1. |
| Atomic file writes | Naive `writeFile(target, data)` | tmp+rename pattern from `apiKeyStore.ts` | Power-loss mid-write corrupts the session file; tmp+rename is atomic on POSIX and Windows ReFS/NTFS. Already established. |
| User deletion + cascade purge | Iterating tables and Storage buckets from the client | Supabase Edge Function with `service_role` | Client cannot hold service_role; cascade purge of Storage is async by design; queue + worker is the only safe shape. [CITED: https://supabase.com/docs/guides/functions/auth] |
| 30-day delayed purge | `setTimeout(..., 30*86400*1000)` in a long-lived process | `deletion_queue` table + Supabase `pg_cron` daily worker | Process lifetime ≠ 30 days; database-backed queue is the only durable approach. [CITED: https://supabase.com/docs/guides/database/extensions/pg_cron] |
| CORS for Edge Function | Manual header juggling per request | Standard `corsHeaders` constant + OPTIONS handler | Supabase docs include a copy-paste template. [CITED: https://supabase.com/docs/guides/functions/cors] |
| Save-file dialog | Custom file picker | `electron.dialog.showSaveDialog` | Native OS dialog; cross-platform; no third-party dep. |
| Email validation regex | `^[^@]+@[^@]+\.[^@]+$` | `z.string().email()` | Zod is already in the project and uses RFC 5322-ish validation. |

**Key insight:** Auth in 2026 has converged on a small set of correct patterns. Every hand-rolled deviation introduces a security or correctness bug. Phase 10 is library-glue work, not greenfield protocol design.

## Runtime State Inventory

> Phase 10 is greenfield for cloud state (no existing Supabase data, no existing sessions). However, the phase does have to migrate v0.1.1 users gracefully from "no AuthChoice" to "AuthChoice exists." Audit applied per Step 2.5:

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | None — Phase 10 is the first phase to write to Supabase | None |
| Live service config | None — Supabase project must be created (one-time admin task: create project, configure Google OAuth provider, register redirect URI `http://127.0.0.1` in Google Cloud Console) | Document in plan: "Wave 0 — Supabase project setup + Google OAuth Cloud Console config" |
| OS-registered state | None — no Task Scheduler, launchd, systemd, or pm2 registrations | None |
| Secrets/env vars | New: `SUPABASE_URL`, `SUPABASE_ANON_KEY` compiled into the app via electron-vite `define`. `SUPABASE_SERVICE_ROLE_KEY` only ever in Edge Function env. `GOOGLE_OAUTH_CLIENT_ID` registered in Supabase dashboard (not in app — Supabase mediates Google) | Document: how/where these env vars are set in dev vs packaged builds; plan must include a `.env.example` |
| Build artifacts | None — no native modules added, no pre-existing artifacts to invalidate | None |
| **v0.1.1 user migration** | v0.1.1 users with an existing `api_key.bin` upgrade to v1.0. AuthChoice exists. Per AUTH-04: they must be able to choose "Continue Locally" and reach today's bot summon with NO sign-in attempted | Plan: `runFirstLaunchMigration()` must NOT erase `api_key.bin`. AuthChoice routing in `src/main/index.ts` MUST detect "v0.1.1 user with existing apiKey AND no session.bin" and either (a) show AuthChoice on first v1.0 launch or (b) auto-route them to local mode. Recommendation: always show AuthChoice on first launch where `session.bin` does not exist, EVEN for v0.1.1 users — preserves the equal-citizen framing of D-02 and lets them choose. |

## Common Pitfalls

### Pitfall A1: `getSession()` returns 401 after deep-link OAuth in Electron (Supabase discussions #17722 / #27181)

**What goes wrong:** The naive Electron Supabase OAuth pattern routes Google → Supabase → custom-scheme deep-link (e.g., `sei://auth?...`) → Electron protocol handler → `setSession(tokens)` in renderer → `getSession()` returns 401.

**Why it happens:** The deep-linked tokens are valid, but the Supabase client instance that calls `getSession()` doesn't have its internal state synchronized — it loaded an older empty session at startup and the deep-linked `setSession` doesn't always propagate cleanly across the renderer/main boundary. Per [discussion #27181](https://github.com/orgs/supabase/discussions/27181): "refreshSession() still uses the same JWT, so when the user logs out, it invalidates the web app's JWT."

**How to avoid:** **Skip deep-link transport entirely.** Phase 10's loopback PKCE pattern (Pattern 2) keeps the auth code exchange INSIDE the main process: code arrives at the loopback handler, `exchangeCodeForSession(code)` runs on the main-process Supabase client, the session lands in `session.bin` via our custom storage adapter, `onAuthStateChange` fires, main broadcasts `auth:state` to renderer. **No URL ever crosses out of main.** The renderer never calls `setSession` or `getSession`. This sidesteps the entire class of bugs in #17722 / #27181.

**Warning signs:** First implementation accidentally uses `BrowserWindow.loadURL(authUrl)` (Pitfall 4) or adds `app.setAsDefaultProtocolClient('sei')` (custom-scheme pattern). Either of these is a red flag — return to the loopback pattern.

### Pitfall A2: `safeStorage` returns `basic_text` on Linux without keyring → effectively plaintext

**What goes wrong:** Per Pitfall 15 of project research: on Ubuntu/Arch/Docker without `gnome-keyring` or `kwallet`, `safeStorage.isEncryptionAvailable()` returns `true` but `safeStorage.encryptString` uses a hardcoded password. The session blob is readable by any local process.

**Why it happens:** `safeStorage.getSelectedStorageBackend()` returns the string `'basic_text'` in this case but is rarely checked. [CITED: https://github.com/electron/electron/blob/main/docs/api/safe-storage.md — "Not all Linux setups have an available secret store, and if no secret store is available, items stored using the safeStorage API will be unprotected"]

**How to avoid:** The existing `apiKeyStore.backendKind()` function already detects this. Phase 10 extends the existing `app:warnings` IPC (see `src/main/ipc.ts` line 275) to also signal session-context Linux fallback. UI surfaces a one-time `Banner kind="warn"` per CONTEXT discretion + UI-SPEC §LinuxKeyringBanner. Persistence is via `sei.config.linuxBasicTextWarnDismissed: boolean` (extend `UserConfigSchema`).

**Warning signs:** Linux user reports "I had to sign in again after every restart" (session may not actually be unreadable, but related cipher/keyring confusion can corrupt the blob).

### Pitfall A3: Session blob corrupts on machine move / keyring reset → infinite sign-in loop

**What goes wrong:** User backs up `userData/`, restores on a new machine, launches Sei. `safeStorage.decryptString(buf)` throws because the OS keychain on the new machine doesn't have the original encryption key.

**How to avoid:** `sessionStore.loadSession()` MUST catch decrypt errors, delete the corrupt `session.bin`, and return null (= "no session"). The user then sees AuthChoice and re-signs in. **Never throw out of `loadSession` for decrypt errors** — only re-throw for unexpected ENOSPC / EACCES / permission errors.

**Warning signs:** Crash on launch after machine move; recurring `SESSION_CORRUPT` in logs.

### Pitfall A4: utilityProcess uses a stale JWT after refresh in main

**What goes wrong:** Main's Supabase client auto-refreshes JWT every 50 minutes. utilityProcess has the old JWT cached and uses it for the next 10 minutes until token expiry → 401 from proxy → bot hard-stops mid-action.

**How to avoid:** Main's `onAuthStateChange` callback fires on `TOKEN_REFRESHED` events. The `jwtBridge.ts` module subscribes to this and pushes the new JWT to utilityProcess over the existing MessagePortMain channel. Phase 10 wires this, even though Phase 13 is the consumer. **Recommended:** push fresh JWT immediately on `TOKEN_REFRESHED`; utilityProcess overwrites its cached value. **Failure path:** if refresh fails (network), main broadcasts `auth:state` with a `tokenStale: true` flag; renderer surfaces a transient toast; utilityProcess keeps using the stale JWT until it expires, then the bot hard-stops with a "session expired, please sign in again" error. This is Claude's discretion per CONTEXT.

**Warning signs:** Bot stops mid-task with 401; no `TOKEN_REFRESHED` log line within the past hour.

### Pitfall A5: Edge Function called from desktop client fails CORS preflight

**What goes wrong:** Edge Function called from `fetch()` in main (Node fetch) succeeds; called from a renderer-side `fetch` would fail CORS preflight without `corsHeaders` configured. In Phase 10 all Edge Function calls go through main, so renderer CORS doesn't apply. But Supabase's [discussion #38832](https://github.com/orgs/supabase/discussions/38832) flags persistent preflight failures even for valid OPTIONS handlers.

**How to avoid:** Phase 10 calls the Edge Function ONLY from main process via `fetch(EDGE_FUNCTION_URL, {method:'POST', headers:{Authorization: 'Bearer '+jwt}})`. No browser fetch involved. The Edge Function's CORS template (standard Supabase pattern below) is still recommended for future-proofing:

```typescript
// Source: CITED https://supabase.com/docs/guides/functions/cors
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  // ... actual handler
});
```

**Warning signs:** "preflight failed" in dev console (only if Phase 11+ ever calls from renderer — flag for future).

### Pitfall A6: Email verification flow appears to "do nothing"

**What goes wrong:** User signs up. Supabase sends verification email (templated per Supabase project dashboard). User clicks link → opens browser → Supabase page says "Email verified" → but the running Sei app doesn't know. App still shows "Verify your email" Banner forever.

**Why it happens:** Email verification is server-side. The client only knows the verified state changed on next auth event.

**How to avoid:** `supabase.auth.onAuthStateChange` fires `USER_UPDATED` when `email_confirmed_at` changes server-side. Main subscribes; on `USER_UPDATED`, re-derives `emailVerified` from `session.user.email_confirmed_at`, broadcasts new `auth:state`. **However:** Supabase's client only polls for this when it next calls the API. To force a check, call `supabase.auth.refreshSession()` periodically (e.g., when the Verify Email Banner is rendered, refresh on window focus). Document this in the plan.

**Warning signs:** Banner stays visible after user clicked the email link; `email_confirmed_at` in `auth.users` is non-null but `auth:state` says `emailVerified: false`.

### Pitfall A7: 30-day Storage purge leaves orphaned auth user OR purges too early

**What goes wrong (orphan):** `auth.admin.deleteUser(jwt.sub)` runs immediately, but the Storage purge job is queued for 30 days later. If the queue table has a foreign key to `auth.users`, the row is gone → purge worker can't find the user → silent failure. User's character images stay in Storage forever.

**What goes wrong (too early):** Storage purge fires before the 30-day grace period — user can't recover their data via support ticket if they reconsider.

**How to avoid:**

1. The `deletion_queue` table stores `user_id` as a plain UUID (no foreign key to `auth.users`) plus `deletion_requested_at` and the list of Storage paths to delete.
2. Edge Function (in order): (a) verify JWT → extract `sub`; (b) `INSERT INTO deletion_queue (user_id, deletion_requested_at, storage_paths) VALUES (...)`; (c) `auth.admin.deleteUser(sub)`; (d) return 204.
3. pg_cron job runs daily: `DELETE FROM deletion_queue WHERE deletion_requested_at < NOW() - INTERVAL '30 days' RETURNING ...` and for each row, calls a small helper Edge Function (or uses Postgres's `http` extension) to delete the Storage paths.

The order matters: if (b) fails, the user isn't deleted. If (c) fails after (b), a manual cleanup job removes the orphaned `deletion_queue` row. The 30-day SLA is honored.

**Phase 10 specifics:** Phase 10 has no Storage objects to purge (no characters uploaded yet). The Edge Function still inserts into `deletion_queue` with an empty `storage_paths` array — this validates the convention for Phase 11/12. pg_cron is enabled but the worker has nothing to do until Phase 11.

**Warning signs:** Auth user gone, Storage objects remain after 30 days. (Phase 10 won't surface this; flag for Phase 11 verification.)

### Pitfall A8: First-launch race between AuthChoice routing and `runFirstLaunchMigration()`

**What goes wrong:** `src/main/index.ts` calls `runFirstLaunchMigration()` then `seedDefaultCharacters()` then opens the window. AuthChoice now needs to render BEFORE these run? Or after?

**How to avoid:** Per CONTEXT code_context: "AuthChoice routing happens before today's `runFirstLaunchMigration()` + `seedDefaultCharacters()`." But these migrations don't actually depend on auth — they touch local files only. **Recommended:** run migrations first (preserves v0.1.1 invariants), then decide routing based on `sessionStore.loadSession()` result + `hasApiKey()` result:

| `session.bin` exists | `api_key.bin` exists | Show |
|---|---|---|
| Yes | Either | Main app, `signed_in` mode (sessionStore loaded successfully) |
| No (or corrupt) | Yes | AuthChoice. If user picks Continue Locally → existing OnboardingScreen is bypassed (they're already onboarded, route to home). |
| No | No | AuthChoice. If user picks Continue Locally → existing 5-step OnboardingScreen. |

This preserves AUTH-04 ("v0.1.1 user upgrading to v1.0 can choose 'Continue without an account' and reach the existing bot summon flow with no cloud writes attempted").

## Code Examples

### Loopback PKCE end-to-end

See Pattern 2 above (full code) — sourced from official Google [native-app guide][google-native] + Supabase [PKCE flow docs][supabase-pkce] + project's existing `src/main/skinServer.ts` ephemeral-port idiom.

### Supabase client with safeStorage adapter

See Pattern 1 above (full code) — sourced from Supabase [initializing docs][supabase-init] + project's `apiKeyStore.ts`.

### Edge Function — `supabase/functions/delete-me/index.ts`

```typescript
// Source: CITED https://supabase.com/docs/guides/functions/auth
//         + https://supabase.com/docs/reference/javascript/auth-admin-deleteuser
// Convention-setting: this is the project's first Edge Function. Phase 11/12
// admin operations follow this pattern.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.106.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders });

  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ error: 'missing_jwt' }), { status: 401, headers: corsHeaders });
  }

  // Two clients:
  //   - userClient: scoped to caller's JWT, used to identify them
  //   - adminClient: service_role, used for auth.admin.deleteUser + queue insert
  const userClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const adminClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData.user) {
    return new Response(JSON.stringify({ error: 'invalid_jwt' }), { status: 401, headers: corsHeaders });
  }
  const userId = userData.user.id;

  // 1. Queue 30-day purge job (no FK to auth.users — survives user deletion)
  const { error: queueErr } = await adminClient
    .from('deletion_queue')
    .insert({
      user_id: userId,
      deletion_requested_at: new Date().toISOString(),
      storage_paths: [], // Phase 10: nothing in Storage yet; Phase 11/12 fills this
    });
  if (queueErr) {
    return new Response(JSON.stringify({ error: 'queue_failed', detail: queueErr.message }), { status: 500, headers: corsHeaders });
  }

  // 2. Delete the auth user (Supabase cascades to RLS-owned rows where ON DELETE CASCADE is set)
  const { error: delErr } = await adminClient.auth.admin.deleteUser(userId);
  if (delErr) {
    // Compensating action: remove the queue row we just inserted
    await adminClient.from('deletion_queue').delete().eq('user_id', userId);
    return new Response(JSON.stringify({ error: 'delete_failed', detail: delErr.message }), { status: 500, headers: corsHeaders });
  }

  return new Response(null, { status: 204, headers: corsHeaders });
});
```

### Supabase migration — `deletion_queue` + pg_cron

```sql
-- Source: CITED https://supabase.com/docs/guides/database/extensions/pg_cron
--         + Pitfall A7 mitigation

create extension if not exists pg_cron;

create table public.deletion_queue (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,                       -- NO FK — survives auth.users deletion
  deletion_requested_at timestamptz not null default now(),
  storage_paths jsonb not null default '[]'::jsonb,
  purged_at timestamptz                        -- null = pending; non-null = done
);
create index on public.deletion_queue (deletion_requested_at) where purged_at is null;

-- Daily worker: process rows older than 30 days
-- Phase 10 has empty storage_paths; Phase 11+ adds Storage purge logic here
select cron.schedule(
  'purge-deletion-queue',
  '0 3 * * *',  -- 03:00 UTC daily
  $$
    update public.deletion_queue
    set purged_at = now()
    where deletion_requested_at < now() - interval '30 days'
      and purged_at is null
  $$
);
```

(In Phase 11/12, the cron job will additionally call Storage delete for each path.)

### Export envelope builder (Phase 10 fills only `account`)

```typescript
// Source: CONTEXT D-14 (schemaVersion=1 contract)
//         + Pattern: Phase 11 fills characters[]; Phase 12 fills sharing[]
//         + Downstream phases append to keys without breaking consumers

export interface SeiExportV1 {
  schemaVersion: 1;
  exportedAt: string;
  account: { email: string; createdAt: string };
  characters: unknown[];   // Phase 10: empty []; Phase 11: filled
  sharing: unknown[];      // Phase 10: empty []; Phase 12: filled
}

export async function buildExport(session: Session): Promise<SeiExportV1> {
  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    account: {
      email: session.user.email ?? '',
      createdAt: session.user.created_at,
    },
    characters: [],   // EMPTY-BUT-PRESENT contract: keys must exist in v1
    sharing: [],
  };
}
```

The empty-but-present contract is load-bearing — Phase 11/12 must not introduce a v2 schema just because they add data. Document this in the Edge Function commit message and in a comment on the type.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `keytar` for OS keychain | Electron `safeStorage` | Atom sunset, ~2023 | Already migrated in v0.1.1 (`apiKeyStore.ts`). Continue. |
| BrowserWindow OAuth | `shell.openExternal` + loopback + PKCE | Google 2021 deprecation enforcement | Mandatory; Pitfall 4. |
| Implicit OAuth flow | PKCE for all public clients | OAuth 2.1 / RFC 8252 | Use `flowType: 'pkce'` in Supabase client + `signInWithOAuth`. |
| Custom URL schemes (`sei://`) | Loopback 127.0.0.1 | Linux protocol-handler reliability + Google native-app guide | Loopback every time for desktop. |
| Email verification BEFORE app access | Verification AFTER, non-blocking | Modern UX; reduces churn | CONTEXT D-04 makes this explicit for Sei. |
| Soft-delete with manual SQL cleanup | Edge Function + pg_cron queue | GDPR + audit-trail requirements | Phase 10 ships this. |

**Deprecated/outdated:**
- `keytar` — superseded by `safeStorage`. Do not add to package.json.
- `electron-oauth2`, `electron-oauth-helper` — both use BrowserWindow internally; incompatible with Google.
- `supabase.auth.signIn()` (legacy v1 API) — replaced by `signInWithPassword`, `signUp`, `signInWithOAuth`. Use the v2 methods only.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | pg_cron is the right 30-day purge mechanism (vs. cron-triggered Edge Function) | Pitfall A7 + SQL migration | Low — if pg_cron is unavailable on Supabase free tier (verify), fall back to a daily cron-triggered Edge Function. Verify with `select cron.schedule(...)` in a test project; Supabase docs claim pg_cron is available on all tiers but free-tier limits unclear. |
| A2 | Single `session.bin` is fine (no need to multi-account in v1.0) | Pattern 3 | Low — multi-account is not in scope; if added in v1.x, schema becomes `{accountId → sealed blob}` map. |
| A3 | Supabase free tier supports Edge Functions | §6 | Low — verified at high level (Supabase advertises Edge Functions on free tier); confirm function invocations/month free-tier limit during Wave 0 spike. |
| A4 | `electron-vite` `define` is sufficient to inject `SUPABASE_URL` / `SUPABASE_ANON_KEY` at compile time | Runtime State Inventory | Low — standard `vite` pattern; if `define` doesn't reach main bundle, fall back to a generated `src/main/constants.ts`. |
| A5 | Refresh-on-window-focus is sufficient for picking up `email_confirmed_at` updates | Pitfall A6 | Medium — if users frequently leave Sei unfocused, verification banner may stay visible for hours. Recommended planner action: also add a manual "I verified — check now" button next to the Banner copy in a future iteration if telemetry shows this. |
| A6 | `electron-vite` build pipeline writes the preload .cjs and main .js such that loading Supabase JS works without ESM/CJS friction | Stack | Low — Supabase JS ships dual builds; `import { createClient } from '@supabase/supabase-js'` works in both contexts. Verify by `import` + `console.log(createClient)` in a smoke test. |
| A7 | Existing `app:warnings` IPC pattern can be extended for the Linux basic_text "session" context without breaking Phase 04 callers | Pitfall A2 | Low — the existing channel returns `{keychainFallbackPlaintext: boolean}`. Extending to also drive the post-sign-in Banner is the same signal; renderer adds a second display site, no API change. |
| A8 | Google Cloud Console accepts `http://127.0.0.1` (no port) as a registered redirect URI and treats port as variable | Pattern 2 | Low — per [RFC 8252][rfc8252] and [Google native-app docs][google-native], this is required. Verify by registering once and testing with bound port 0. |
| A9 | The `deletion_queue` row should be inserted BEFORE `auth.admin.deleteUser` (vs. after) | Pitfall A7 + Edge Function code | Low — insert-before is the safer order because the user record is still there to satisfy any debug query; the compensating-delete-on-failure path covers the inverse. |
| A10 | utilityProcess in Phase 10 receives JWT but doesn't consume it (Phase 13 is the consumer) | Pattern 1 + Architectural map | None — explicit per CONTEXT Claude's discretion. |

**Five Medium+ assumptions for user confirmation before planning:** A5 (verification-banner UX), A1 (pg_cron vs. cron Edge Function for purge worker), A3 (free-tier Edge Function limits — verify in Wave 0).

## Open Questions

1. **Should v0.1.1 users see AuthChoice on first v1.0 launch, even though they already have an API key?**
   - What we know: AUTH-04 requires they reach existing bot summon flow without cloud writes. CONTEXT D-01..D-02 frame Continue Locally as the equal-citizen choice.
   - What's unclear: Do we (a) show AuthChoice always-on-first-launch even for v0.1.1 users (gives them the framing benefit), or (b) auto-route v0.1.1 users with existing `api_key.bin` directly to home (less friction)?
   - Recommendation: Show AuthChoice for v0.1.1 users on their first v1.0 launch. Reasoning: Continue Locally is the equal-citizen choice per D-02; auto-routing them past it implicitly downgrades the message. AuthChoice is a single click — acceptable friction for the messaging win.

2. **Where does `SUPABASE_URL` / `SUPABASE_ANON_KEY` come from in CI builds?**
   - What we know: anon key is safe to compile into the binary (it's anon; RLS protects data).
   - What's unclear: Do we use `electron-vite` `define`, environment variables read at build time, or a generated `src/main/constants.ts`?
   - Recommendation: Wave 0 task — pick `define` (standard vite) and document `.env.example` with the two keys. The actual values are committed to git only for the dev project; production keys go via CI secrets.

3. **Does pg_cron exist on Supabase free tier?**
   - What we know: Supabase advertises pg_cron as an extension; not clear if free-tier has scheduling quotas.
   - What's unclear: Verify by running `create extension if not exists pg_cron; select cron.schedule(...)` against a free-tier project. If unavailable, fall back to a daily cron-triggered Edge Function.
   - Recommendation: Wave 0 spike (30 min).

4. **Where does the Linux basic_text warning surface for Phase 10 specifically?**
   - What we know: CONTEXT Claude's discretion says "likely a one-time dismissable Banner on first sign-in." UI-SPEC §LinuxKeyringBanner specifies dismissal persisted via `sei.config.linuxBasicTextWarnDismissed = true`.
   - What's unclear: Does it show on first successful sign-in only (per UI-SPEC), or also on first AuthChoice display (so user is warned BEFORE entering their password)?
   - Recommendation: Follow UI-SPEC — first successful sign-in only. The local-only path already exists and is being warned via the existing `apiKeyStore` warning at `src/renderer/src/App.tsx` line 216. Adding a second warning at sign-in keeps the channels separate (auth vs apiKey).

5. **Does the Edge Function need rate-limiting?**
   - What we know: Phase 10's delete-me Edge Function is invoked once per user lifetime. Resend-verification (also new in Phase 10) is invoked per-button-click.
   - What's unclear: Should the Edge Function itself rate-limit, or rely on Supabase Auth's built-in `auth.resend()` rate limits?
   - Recommendation: Rely on Supabase Auth's built-in rate limit for `auth.resend()` (verified 60s default; CITED: https://supabase.com/docs/guides/auth/auth-rate-limits). Edge Function delete-me doesn't need extra rate-limiting because it's one-shot.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | All main-process code | ✓ | Node 20+ (Electron 42 bundles Node 20.x) | — |
| Supabase JS client | Main-process auth | Not yet installed | — | `npm install @supabase/supabase-js` |
| Supabase CLI | Edge Function dev | Not in repo (machine-local) | check `supabase --version` | `brew install supabase/tap/supabase` or `npm i -g supabase` |
| Deno runtime | Edge Function (managed by Supabase CLI) | Bundled with Supabase CLI | — | — |
| Supabase project (hosted) | All auth + future cloud | Must be created (admin task) | — | None — blocking. Wave 0 task. |
| Google Cloud Console project | OAuth client_id + redirect URI registration | Must be created (admin task) | — | None — blocking. Wave 0 task. |
| `electron-vite` `define` plumbing for `SUPABASE_URL`/`SUPABASE_ANON_KEY` | Compile-time injection | Existing build pipeline; needs config | electron-vite 5.0.0 | Generated `src/main/constants.ts` |

**Missing dependencies with no fallback:**
- Supabase project must be created in Wave 0 (free tier; ~5 min admin task).
- Google Cloud Console OAuth client must be created in Wave 0 (~10 min admin task: create project → OAuth consent screen → OAuth client ID for Desktop App → register `http://127.0.0.1` as authorized redirect URI; pass the resulting client_id to Supabase dashboard's Google provider config).

**Missing dependencies with fallback:**
- Supabase CLI (machine-local) — fallback is to develop the Edge Function inline in the Supabase dashboard's web editor, which is acceptable for Phase 10's single tiny function. Recommend installing the CLI early for Phase 11/12 reuse.

## Project Constraints (from CLAUDE.md)

- **Three-process Electron**: main ↔ renderer (contextIsolation) ↔ utilityProcess. Mineflayer in utilityProcess only. **Phase 10 application:** Supabase client in MAIN only. Renderer accesses via IPC. utilityProcess receives JWT-only via MessagePortMain. Never import `@supabase/supabase-js` from renderer or utilityProcess.
- **Closed action registry**: LLM calls Zod-typed actions directly. **Phase 10 application:** N/A — auth doesn't introduce LLM-callable actions.
- **Event-sourced FSM + iteration_cap**: **Phase 10 application:** sign-out while bot running (D-09) hooks into existing botSupervisor stop path; do not introduce a parallel stop mechanism.
- **Every external call has a timeout**: pathfinder, Anthropic. **Phase 10 application:** loopback PKCE server has 60s timeout per D-05; Supabase client calls (signIn, signUp, refresh) inherit Supabase's default fetch timeout — wrap with `Promise.race` against 15s timeout to surface network failures cleanly.
- **Native ABI mismatch → `@electron/rebuild` in postinstall**: **Phase 10 application:** `@supabase/supabase-js` is pure JS — no native deps. No rebuild needed. Safe to add.

## Sources

### Primary (HIGH confidence)

- **[Google OAuth 2.0 for iOS & Desktop Apps][google-native]** — canonical loopback PKCE flow for desktop installed apps; verified port-arbitrary requirement
- **[RFC 8252 — OAuth 2.0 for Native Apps][rfc8252]** — §7.3 loopback IP redirect URIs MUST accept any port
- **[Supabase PKCE flow docs][supabase-pkce]** — `flowType: 'pkce'` configuration + `exchangeCodeForSession`
- **[Supabase initializing client docs][supabase-init]** — `createClient` + custom storage adapter shape
- **[Supabase Auth Admin — deleteUser][supabase-admin-delete]** — service_role-only API; immediate
- **[Supabase Edge Functions auth][supabase-fn-auth]** — JWT verification + service_role pattern
- **[Supabase Edge Functions CORS][supabase-fn-cors]** — copy-paste corsHeaders template
- **[Supabase Edge Functions quickstart][supabase-fn-quickstart]** — `supabase functions serve` + `deploy`
- **[Supabase pg_cron extension][supabase-pgcron]** — daily worker scheduling
- **[Electron safeStorage docs][electron-safestorage]** — `getSelectedStorageBackend()` returns `basic_text` on Linux without keyring
- **[Electron dialog.showSaveDialog][electron-dialog]** — native save dialog
- **Existing code (HIGH-VERIFIED in this codebase):** `src/main/apiKeyStore.ts`, `src/main/paths.ts`, `src/main/ipc.ts`, `src/main/index.ts`, `src/shared/ipc.ts`, `src/renderer/src/App.tsx`, `src/renderer/src/components/Banner.tsx`, `src/renderer/src/components/DeleteConfirmModal.tsx`

### Secondary (MEDIUM confidence)

- **[Supabase discussion #17722 — Google OAuth in Electron][disc17722]** — documents the deep-link → `getSession()` 401 bug; sidestepped by Phase 10's loopback-only architecture
- **[Supabase discussion #27181 — Generating session for Electron deep link][disc27181]** — confirms refresh-token JWT invalidation issue with deep-link transport; reinforces Phase 10's "exchange in main, never deep-link" approach
- **[OAuth.com loopback redirect URIs][oauth-com-loopback]** — confirms port-arbitrary rule independent of Google docs
- **[Google blog — making OAuth interactions safer][google-safer]** — endorses loopback flows over custom schemes
- **STACK.md §2** — project's own prior research on this exact pattern (HIGH-confidence by project's standards)
- **PITFALLS.md §4, §11, §13, §15** — project's catalogued pitfalls

### Tertiary (LOW confidence)

- **[Supabase discussion #38832 — Edge Function CORS preflight][disc38832]** — flags persistent preflight failures; not relevant to Phase 10 (main-process calls only) but recorded for Phase 11+

[google-native]: https://developers.google.com/identity/protocols/oauth2/native-app
[rfc8252]: https://datatracker.ietf.org/doc/html/rfc8252
[supabase-pkce]: https://supabase.com/docs/guides/auth/sessions/pkce-flow
[supabase-init]: https://supabase.com/docs/reference/javascript/initializing
[supabase-admin-delete]: https://supabase.com/docs/reference/javascript/auth-admin-deleteuser
[supabase-fn-auth]: https://supabase.com/docs/guides/functions/auth
[supabase-fn-cors]: https://supabase.com/docs/guides/functions/cors
[supabase-fn-quickstart]: https://supabase.com/docs/guides/functions/quickstart
[supabase-pgcron]: https://supabase.com/docs/guides/database/extensions/pg_cron
[electron-safestorage]: https://www.electronjs.org/docs/latest/api/safe-storage
[electron-dialog]: https://www.electronjs.org/docs/latest/api/dialog
[disc17722]: https://github.com/orgs/supabase/discussions/17722
[disc27181]: https://github.com/orgs/supabase/discussions/27181
[disc38832]: https://github.com/orgs/supabase/discussions/38832
[oauth-com-loopback]: https://www.oauth.com/oauth2-servers/oauth-native-apps/redirect-urls-for-native-apps/
[google-safer]: https://developers.googleblog.com/making-google-oauth-interactions-safer-by-using-more-secure-oauth-flows/

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — `@supabase/supabase-js@^2.106.0` verified via `npm view`; all dependencies pure-JS; no version drift risk.
- Architecture: HIGH — main-owns-everything pattern follows existing codebase invariants; mirrors `apiKeyStore.ts` structure exactly.
- Loopback PKCE pattern: HIGH — Google/RFC 8252 explicit; project's existing `skinServer.ts` provides the ephemeral-port idiom.
- Supabase-in-Electron edge cases: MEDIUM — discussions #17722/#27181 surface real bugs; sidestepped by keeping all auth state in main (no deep-link transport). Plan a half-day spike to validate before extensive UI work.
- Edge Function pattern: MEDIUM — first Edge Function in the project; convention being set here. Deno+Supabase docs are clear but local-dev workflow needs Wave 0 verification.
- 30-day Storage purge: MEDIUM — pg_cron pattern is standard but Phase 10 has nothing to actually purge (validates the convention only); Phase 11/12 will exercise it.
- JWT-to-utilityProcess delivery: MEDIUM — extends existing MessagePortMain pattern; Phase 13 is the consumer so Phase 10 verification is limited to "did the new JWT arrive."

**Research date:** 2026-05-19
**Valid until:** 2026-06-19 (Supabase JS minor versions move ~biweekly; re-verify before merge if planning is delayed >30 days)
