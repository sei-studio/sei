# Phase 10: Auth Foundation - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in `10-CONTEXT.md` — this log preserves the alternatives considered.

**Date:** 2026-05-19
**Phase:** 10-auth-foundation
**Areas discussed:** First-launch flow & sign-in placement, Account state model + sign-out semantics, Account deletion (AUTH-06) + data export (AUTH-07)

**Areas presented but not selected:** Session storage shape & process boundaries (deferred to Claude's discretion — pattern from `apiKeyStore.ts` is the obvious template).

---

## First-launch flow & sign-in placement

### Q1: Where does auth land relative to today's OnboardingScreen?

| Option | Description | Selected |
|--------|-------------|----------|
| New AuthChoice screen BEFORE Onboarding | First-launch lands on a new screen with three equal tiles: Sign in / Create account / Continue without account. Sign-in routes through a thin auth flow then into existing OnboardingScreen. | ✓ |
| Insert auth as Step 0 inside OnboardingScreen | Add a sixth step at the front of the existing wizard, with a skip link. | |
| Auth lives in Settings, not first-launch | First-launch unchanged; sign-in discovered in Settings only. | |

**Selected:** New AuthChoice screen BEFORE Onboarding (Recommended)

### Q2: When a user signs in/up successfully, what does the API-key step look like?

| Option | Description | Selected |
|--------|-------------|----------|
| Skip the provider/key step entirely — signed-in implies cloud-proxy AI | Hide provider/key step; bot defaults to cloud-proxy. Phase 10 ships a "Cloud AI — coming soon" placeholder; Phase 13 lands the real proxy. | ✓ |
| Still ask for an API key, mark cloud-proxy as "coming soon" | Signed-in users still get provider/key step. Cloud-proxy listed as future. | |
| Show a fourth "Cloud AI (free trial credits)" tile in ProviderTiles | Add a 4th tile, introduces Phase 13 UI in Phase 10. | |

**Selected:** Skip the provider/key step entirely (Recommended)

### Q3: How should email verification work?

| Option | Description | Selected |
|--------|-------------|----------|
| Require verification before any cloud write, but let user sign in immediately | Persistent banner; cloud-write attempts blocked with "verify first" modal. | ✓ |
| Block sign-in until email is verified | User sees "Check your email" gate until verification clicked. | |
| No email verification at all in Phase 10 | Defer to a later phase. | |

**Selected:** Require verification before any cloud write, but let user sign in immediately (Recommended)

### Q4: Google OAuth interstitial UX?

| Option | Description | Selected |
|--------|-------------|----------|
| Interstitial modal with progress text + Cancel + 60s timeout | Centered modal "Continue in your browser to finish signing in" with Cancel + timeout. | ✓ |
| Inline replacement of the auth screen (no modal) | Whole AuthChoice screen swaps to a "Waiting for Google…" state. | |
| Toast + leave the auth screen interactive | Small toast "Check your browser"; user can retry by clicking Google button again. | |

**Selected:** Interstitial modal with Cancel + 60s timeout — **with refinement:** open the Google auth URL in a new tab in the user's existing browser window (do NOT spawn a new browser instance). Use `shell.openExternal()`, which is the platform-default behavior on all three OSes when a browser is already open.

---

## Account state model + sign-out semantics (AUTH-05)

### Q1: What's the user-state machine?

| Option | Description | Selected |
|--------|-------------|----------|
| 3 states: signed_out \| local_only \| signed_in | Distinguishes "never made a choice" from "chose local on purpose". | |
| 2 states: anonymous \| signed_in | Collapse signed_out and local_only into a single state. | ✓ |
| 4 states: + signed_in_unverified / verified | Promote email verification to top-level state. | |

**Selected (free text):** Two states — `guest | signed_in`. Reasoning: pre-AuthChoice locks the user out of the main UI; AuthChoice is a hard gate, so the app is never running in a signed-out state. Anything in the app is either guest or signed_in.

**Later refined (Q3 below):** `guest` renamed to **`local`** to emphasize privacy-first positioning.

### Q2: Sign-out while bot is running — what happens?

| Option | Description | Selected |
|--------|-------------|----------|
| Confirm modal: "Sign out will stop your bot. Continue?" — then stop bot + sign out | Single confirmation; bot stopped cleanly. | ✓ |
| Sign out instantly; bot keeps running as guest until current session ends | No confirmation; bot continues with no session. | |
| Block sign-out entirely while bot is running | Sign Out button disabled with tooltip. | |

**Selected:** Confirm modal: stop bot + sign out (Recommended)

### Q3: Where does the user land after sign-out (AUTH-05 preserves local files/memory)?

| Option | Description | Selected |
|--------|-------------|----------|
| Back to AuthChoice screen, must re-decide | Full reset to first-launch-style gate. | |
| Auto-drop into guest mode, app continues with local characters | Sign-out happens silently in place. | ✓ |
| Show AuthChoice as a modal overlay, dismissable to guest | Hybrid modal overlay on main app. | |

**Selected (free text):** Auto-drop into `local` mode (renamed from "guest"). AuthChoice copy: "Sign In" vs "Continue Locally". Local mode is **privacy-first**: skips our cloud; users can use their local model or go direct to an LLM API. The cloud model and cloud character library are locked behind "Sign In" buttons inline. The **only** two changes signing in unlocks: (1) access to cloud models, (2) read/write cloud characters.

### Q4: local → signed_in upgrade path when a user clicks "Sign In" on a cloud feature?

| Option | Description | Selected |
|--------|-------------|----------|
| Inline modal: Sign in / Create account, then return to the feature they clicked | Modal overlay; on success, modal closes and user is on the target feature. | ✓ |
| Full-screen AuthChoice, then return to feature | Same destination but full-screen takeover. | |
| Side panel slide-in for auth | New UI pattern not used elsewhere. | |

**Selected:** Inline modal (Recommended)

---

## Account deletion (AUTH-06) + data export (AUTH-07)

### Q1: Where do "Delete account" and "Export my data" live in the UI?

| Option | Description | Selected |
|--------|-------------|----------|
| New "Account" panel in SettingsScreen — sign out, export, delete grouped together | Account section appears only when signed in. Email + Sign Out + Export + Delete (red, bottom). | ✓ |
| Dedicated "Account" screen reachable from a profile icon | Full new screen for account management. | |
| Delete in Settings, but export only via a CLI/help command | Strict separation; power-user export. | |

**Selected:** New "Account" panel in SettingsScreen (Recommended)

### Q2: Account deletion confirmation strength?

| Option | Description | Selected |
|--------|-------------|----------|
| Type-to-confirm modal: user types their email, then "Delete forever" | GitHub-style single-modal pattern. | ✓ |
| Two-step modal: "Are you sure?" → "Really sure? Type DELETE" | Maximum friction. | |
| Single confirmation modal with countdown button (5s before enabled) | Timed delay pattern. | |

**Selected:** Type-to-confirm modal (Recommended)

### Q3: Server-side execution mechanism for deletion?

| Option | Description | Selected |
|--------|-------------|----------|
| Supabase Edge Function `delete-me`, called with the user's JWT | Verifies JWT, calls `auth.admin.deleteUser(jwt.sub)`, queues Storage purge. | ✓ |
| Reuse the Phase 13 Fly.io Hono proxy as a generic admin endpoint | Couples Phase 10 to Phase 13 hosting. | |
| `deletion_requests` table + manual operator script | Cheapest, slowest, violates 30-day spirit. | |

**Selected:** Supabase Edge Function `delete-me` (Recommended). This is the project's first Edge Function; sets `supabase/functions/` conventions for Phase 11/12 reuse.

### Q4: Data export shape on day one (Phase 11 cloud library doesn't exist yet)?

| Option | Description | Selected |
|--------|-------------|----------|
| Single `sei-export-<date>.json` with versioned schema; Phase 10 fills only account section | Schema `{ schemaVersion: 1, exportedAt, account, characters: [], sharing: [] }` locked now. | ✓ |
| Stub the button as "Coming soon" in Phase 10; build the real export in Phase 11 | Violates AUTH-07's Phase 10 lock. | |
| ZIP bundle with `account.json` + per-character folders | Future-proofs for binary attachments but overkill for empty cloud library. | |

**Selected:** Single versioned JSON file with schema locked in Phase 10 (Recommended)

---

## Claude's Discretion

Areas the user explicitly delegated to Claude during planning/implementation:

- **Session storage shape & process boundaries** — not selected as a discussion area. Default decision: single sealed `<userData>/session.bin` mirroring `src/main/apiKeyStore.ts` exactly (atomic tmp+rename, `safeStorage` encryption, `basic_text` Linux fallback warning). Supabase JS client auto-refresh stays enabled. utilityProcess receives JWT-only via existing MessagePortMain channel.
- **AuthChoice tile copy, exact button placement, spacing** — visual polish per existing component style.
- **Linux `basic_text` warning placement** — likely one-time dismissable Banner on first sign-in.
- **Inline upgrade modal styling** — reuse existing modal pattern (likely `DeleteConfirmModal` as structural template).
- **OAuth error copy** — plain language for browser-closed, network-failure, code-expired, Google-rejected.
- **Internal session refresh timing/retry policy** — Supabase auto-refresh + exponential backoff on network failure.

## Deferred Ideas

None — discussion stayed within Phase 10 scope. LIB-06 (Privacy Policy + ToS gating of first cloud write) is owned by Phase 11 per REQUIREMENTS.md, not deferred from Phase 10.
