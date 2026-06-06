# Phase 10: Auth Foundation - Context

**Gathered:** 2026-05-19
**Status:** Ready for planning

<domain>
## Phase Boundary

Identity layer + local-vs-cloud state machine + GDPR plumbing — nothing more. Phase 10 delivers:

- Email + password and Google OAuth sign-in via Supabase Auth
- Persistent session across launches via Electron `safeStorage`
- A first-class local-only path that preserves the v0.1.1 experience (AUTH-04)
- Account deletion (AUTH-06) and JSON data export (AUTH-07) — both shipped now, not deferred
- Sign-out semantics that preserve local files/memory (AUTH-05)

Cloud character writes (Phase 11), Sharing (Phase 12), Billing/Proxy (Phase 13), and Multi-Provider (Phase 14) are explicitly out of scope. Phase 10 lays the auth groundwork those phases depend on.

</domain>

<decisions>
## Implementation Decisions

### First-launch flow & sign-in placement

- **D-01:** A new `AuthChoice` screen renders before today's `OnboardingScreen`. Two equal-weight tiles: **Sign In** and **Continue Locally**. There is no third "Create account" tile — the Sign In tile opens a unified sign-in/sign-up form (toggle inside the form).
- **D-02:** "Continue Locally" is privacy-first framing (not "guest", not "skip"). Choosing it routes into today's 5-step `OnboardingScreen` unchanged. BYO LLM (local Ollama or direct provider API key) remains required in this mode.
- **D-03:** Signed-in users skip the provider/API-key step of `OnboardingScreen` entirely. The bot defaults to cloud-proxy AI mode. Phase 10 ships a **"Cloud AI — coming soon"** placeholder that gracefully falls back to letting the user paste a BYO key. Phase 13 lands the actual `baseURL`-override proxy and replaces the placeholder.
- **D-04:** Email verification does **not** block sign-in. After signup, the user proceeds immediately into the app. A persistent "Verify your email" banner shows in-app; cloud-write attempts (Phase 11 publishing, Phase 13 purchasing) are blocked with a "verify first" modal.
- **D-05:** Google OAuth interstitial is a **centered modal**: "Continue in your browser to finish signing in" with a Cancel button and a 60s auto-dismiss timeout. The Google auth URL is opened via `shell.openExternal()`, which opens a new tab in the user's most-recently-used browser window — **not** a new browser instance.

### Account state model + sign-out semantics (AUTH-05)

- **D-06:** Two-state user model: **`local`** and **`signed_in`**. There is no separate "signed_out" state — `AuthChoice` is a hard gate before the main UI, so the app is never running in a signed-out state.
- **D-07** [informational, deferred to Phase 12/13]: `local` mode is privacy-first: no cloud features visible. Cloud-only surfaces (Browse cloud characters, cloud-proxied model picker) display **"Sign In"** CTAs inline where they would otherwise be active. *Phase 10 has no cloud-only surfaces yet — the Browse tab ships in Phase 12, the cloud-proxied model picker in Phase 13. The inline-CTA pattern will be wired then. The SignInModal prop contract `framingLabel` is in place from plan 10-04 so future surfaces can invoke an inline upgrade with origin-feature focus return (D-10).*
- **D-08** [informational, deferred to Phase 11–13]: Signing in unlocks exactly two things: **(1)** access to cloud-proxied AI models and **(2)** read/write access to the cloud character library. Nothing else in the app changes. *Phase 10 establishes the `local`/`signed_in` state machine that gates these unlocks. The unlocks themselves land in Phase 11 (cloud character library) and Phase 13 (cloud-proxied models).*
- **D-09:** Sign-out while the bot is running: single confirmation modal "Sign out will stop your bot. Continue?" → stop bot cleanly → clear session → drop silently into `local` mode with **no screen transition**. AUTH-05 invariant: local character files, local memory, and locally-cached cloud character definitions are untouched.
- **D-10:** `local` → `signed_in` upgrade happens via an **inline modal overlay** (Sign in / Create account form). On success, modal closes and the user lands on the feature they originally clicked (Browse opens, cloud model becomes selectable, etc.). Local files/keys/memory untouched.

### Account deletion (AUTH-06) + data export (AUTH-07)

- **D-11:** A new **"Account" panel** in `SettingsScreen` (visible only when `signed_in`) groups: account email, **Sign Out**, **Export My Data**, **Delete Account** (red, bottom).
- **D-12:** Account deletion is a single **type-email-to-confirm** modal. Body explicitly states: (a) 30-day deletion window, (b) what gets deleted (cloud characters + Storage objects + credit ledger), (c) what stays (local characters + local memory + cached cloud definitions). Destructive button enabled only when the typed string matches the user's account email.
- **D-13:** Deletion is executed via a **Supabase Edge Function** at `supabase/functions/delete-me/`. Function verifies the caller's JWT, calls `auth.admin.deleteUser(jwt.sub)`, queues a 30-day Storage purge job, returns 204. The desktop client never holds `service_role`. This is the project's first Edge Function — Phase 11/12 admin operations will reuse the same `supabase/functions/` infra.
- **D-14:** Data export is a single `sei-export-<YYYY-MM-DD>.json` file with a **versioned schema** locked in Phase 10:
  ```json
  {
    "schemaVersion": 1,
    "exportedAt": "<ISO timestamp>",
    "account": { "email": "...", "createdAt": "..." },
    "characters": [],
    "sharing": []
  }
  ```
  Phase 10 fills only `account`; Phase 11 fills `characters`; Phase 12 fills `sharing`. The schema is locked here so downstream phases don't have to re-design the format.

### Claude's Discretion

The user explicitly left these for Claude during planning/implementation:

- **Session storage shape** — implement as a single sealed `<userData>/session.bin` mirroring `src/main/apiKeyStore.ts` exactly (atomic tmp+rename, `safeStorage` encryption, `basic_text` Linux fallback warning). Supabase JS client auto-refresh stays enabled; refresh token + access token packed into the sealed blob.
- **utilityProcess JWT delivery** — JWT-only (not the full session) crosses to utilityProcess via the existing MessagePortMain channel. Main process keeps the refresh token; pushes a fresh JWT before expiry.
- **AuthChoice tile copy, exact button placement, spacing, and Banner reuse** — visual polish per existing component style.
- **Linux `basic_text` warning placement** — likely a one-time dismissable `Banner` on first sign-in, following existing Banner pattern.
- **Inline upgrade modal styling** — reuse the existing modal pattern (likely `DeleteConfirmModal` as a structural template).
- **OAuth error copy** — clear, plain language for the various failure modes (browser closed, network failure, code expired, Google rejected).
- **Internal session refresh timing/retry policy** — standard Supabase auto-refresh + exponential backoff on network failure.

</decisions>

<specifics>
## Specific Ideas

- **"Continue Locally"** (the copy on the local-mode AuthChoice tile) — privacy-first framing matters; never "Skip" or "Guest". Local mode is the equal-citizen choice, not a fallback.
- The pre-Phase-13 cloud-proxy placeholder is acceptable in Phase 10 because Phase 13 ships its `baseURL`-override flavor early per the ROADMAP early-revenue pattern — so the placeholder window is short.
- `shell.openExternal()` is the explicit choice over any `BrowserWindow`-based flow (Pitfall 4); behavior should open a new tab in the user's existing browser window on all three platforms (verify on Linux during implementation).
- The Account panel in SettingsScreen should feel like GitHub's "Danger Zone" pattern at the bottom — destructive actions visually separated.

</specifics>

<canonical_refs>
## Canonical References

**Downstream agents (researcher, planner) MUST read these before planning or implementing.**

### Phase 10 requirements & scope
- `.planning/REQUIREMENTS.md` §Auth (AUTH-01..AUTH-07) — locked requirements text
- `.planning/ROADMAP.md` §Phase 10 — goal, dependencies, success criteria
- `.planning/PROJECT.md` — three-process Electron architecture, target users, constraints

### Stack & implementation guidance
- `.planning/research/STACK.md` §1 (Cloud DB/Auth/Storage — Supabase) — version pins, free-tier limits, schema sketch
- `.planning/research/STACK.md` §2 (Auth Flow in Electron — Supabase + Loopback PKCE) — exact pattern; flagged edge cases (Supabase discussions #17722 and #27181 on `getSession()` 401 after deep-link auth in Electron — plan a half-day spike)

### Pitfalls (mandatory)
- `.planning/research/PITFALLS.md` §Pitfall 4 — Google OAuth in BrowserWindow → `disallowed_useragent` → drives system browser + loopback + PKCE
- `.planning/research/PITFALLS.md` §Pitfall 11 — GDPR obligations from first EU signup → why AUTH-06 + AUTH-07 ship in Phase 10
- `.planning/research/PITFALLS.md` §Pitfall 13 — account deletion regresses offline-mode users → drives AUTH-04 local-first and the `local` mode framing

### Existing code (templates and integration points)
- `src/main/apiKeyStore.ts` — direct template for `sessionStore.ts` (`safeStorage`, atomic tmp+rename, `basic_text` backend detection)
- `src/main/paths.ts` — canonical userData path module; extend with `sessionPath() = path.join(userDataRoot(), 'session.bin')`
- `src/main/index.ts` — main-process entrypoint; AuthChoice routing decision lives here, alongside first-launch migration and character seeding
- `src/main/ipc.ts` — IPC layer to extend with `auth:*` channels
- `src/renderer/src/App.tsx` — top-level route gate to update: `AuthChoice` → (`OnboardingScreen` | `MainApp`)
- `src/renderer/src/screens/OnboardingScreen.tsx` — existing 5-step wizard; signed-in branch skips the provider/API-key step
- `src/renderer/src/screens/SettingsScreen.tsx` — host for the new "Account" panel
- `src/renderer/src/components/Banner.tsx` — reuse for "Verify your email" persistent banner and Linux `basic_text` one-time warning
- `src/renderer/src/components/DeleteConfirmModal.tsx` — structural template for the type-email-to-confirm delete-account modal

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

- **`apiKeyStore.ts`** — Drop-in template for `sessionStore.ts`. Uses `safeStorage.encryptString` / `decryptString`, atomic `writeFile` to `.tmp.<pid>.<ts>` then `rename`, `backendKind()` for Linux `basic_text` detection. Same module shape, same error-class contract.
- **`paths.ts`** — Canonical userData path resolver. Add `sessionPath()` exactly like `apiKeyPath()`. Test override hook (`_setUserDataOverride`) already exists.
- **`Banner` component** — Used elsewhere in the app. Reuse for "Verify your email" persistent banner and one-time Linux `basic_text` warning.
- **`DeleteConfirmModal`** — Existing pattern for destructive confirmations; adapt for type-email-to-confirm account deletion.
- **IPC layer (`src/main/ipc.ts`, 281 lines)** — Existing handler-registration pattern; extend with `auth:*` channels.
- **utilityProcess + MessagePortMain channel** — Per project architecture, the bot loop runs in utilityProcess. JWT delivery from main → utilityProcess goes over this existing channel; do not import auth modules into utilityProcess directly.
- **`@anthropic-ai/sdk` (^0.91.1)** — Already a dependency; the Phase 10 "Cloud AI — coming soon" placeholder uses the existing client unchanged. Phase 13 will add the `baseURL` override.

### Established Patterns

- **Three-process Electron**: main owns OS resources (safeStorage, session, OAuth loopback server, Supabase client); renderer owns UI; utilityProcess owns the bot loop. The session NEVER lives in the renderer; renderer reads UI state from main via IPC. JWT crosses to utilityProcess via MessagePortMain only.
- **`app.setName` / userData separation**: `Sei Launcher` (packaged) vs `Sei Launcher Dev` (electron-vite dev). Phase 10 must work in both — dev sessions stay isolated from packaged sessions.
- **`app.whenReady` boundary**: All main-process init (including Supabase client instantiation and session restore) happens behind this gate. Loopback OAuth server is created on demand, not at boot.
- **Atomic file writes**: tmp+rename pattern in `apiKeyStore.ts`. Reuse for `session.bin`.
- **Error classification**: `apiKeyStore.ts` throws `KEYCHAIN_UNAVAILABLE` and signals `basic_text` via `backendKind()`; renderer's `classifyRendererError` (used in `OnboardingScreen.tsx`) maps to user-facing messages. Add `SESSION_*` error classes following the same convention.

### Integration Points

- **`src/main/index.ts`** — AuthChoice routing happens before today's `runFirstLaunchMigration()` + `seedDefaultCharacters()`. Single-instance lock already exists.
- **`src/main/ipc.ts`** — New channels: `auth:state` (subscription), `auth:signin-password`, `auth:signup-password`, `auth:signin-google` (returns a promise that resolves on callback or rejects on cancel/timeout), `auth:signout`, `auth:delete-account`, `auth:export-data`, `auth:resend-verification`.
- **`src/renderer/src/App.tsx`** — New top-level gate: if `authState === 'local'` → existing OnboardingScreen / MainApp; if `signed_in` → MainApp with cloud features unlocked; before either, render AuthChoice on first launch.
- **`src/renderer/src/screens/`** — New: `AuthChoiceScreen.tsx`, `SignInModal.tsx` (or screen, TBD by planner). `OnboardingScreen.tsx` gets a `signedIn: boolean` prop that hides the provider/key step.
- **`supabase/functions/delete-me/`** — New top-level directory for Supabase Edge Functions. This is the project's first Edge Function; establish `supabase/` folder conventions here for Phase 11/12 reuse.

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within Phase 10's scope. The Privacy Policy + Terms of Service gating of the first cloud write (LIB-06) is already owned by Phase 11 in REQUIREMENTS.md, not deferred from Phase 10.

</deferred>

---

*Phase: 10-auth-foundation*
*Context gathered: 2026-05-19*
