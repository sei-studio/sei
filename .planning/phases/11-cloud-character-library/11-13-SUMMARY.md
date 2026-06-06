---
phase: 11
plan: 13
subsystem: cloud-character-library
tags: [tos, modal, blocking, legacy-account, auth-store, app-gate]
requires:
  - 11-12 (sei.tosStatus, sei.tosAccept, sei.openExternal IPC) — landing in parallel
provides:
  - "AcceptToSModal blocking overlay for legacy / Google-OAuth / version-bump cases"
  - "useAuthStore.tosAccepted tristate + refreshTosStatus action"
  - "App.tsx mount gate keyed on signed_in && tosAccepted === false"
affects:
  - src/renderer/src/App.tsx
  - src/renderer/src/lib/stores/useAuthStore.ts
tech-stack:
  added: []
  patterns:
    - "Modal idiom mirrored from DeleteAccountModal (460px frame, 32px padding, scrim 0.45α)"
    - "TosBridge / TosStatusBridge inline type casts bridge to Plan 11-12 RendererApi extensions until merge"
    - "Auth-state subscriber triggers refreshTosStatus() on local → signed_in edge"
key-files:
  created:
    - src/renderer/src/components/AcceptToSModal.tsx
    - src/renderer/src/components/AcceptToSModal.module.css
  modified:
    - src/renderer/src/App.tsx
    - src/renderer/src/lib/stores/useAuthStore.ts
decisions:
  - "Render existing routes when tosAccepted === null (loading) per plan's simpler-path recommendation — modal mounts as soon as status resolves; brief flash acceptable"
  - "ESC suppression is unconditional (not only during submit like DeleteAccountModal) because no dismissal path exists for a legal-acceptance gate"
  - "tosStatus() failures fail-closed to tosAccepted=null (not false) so a transient network failure does not trap the user behind an empty-state modal — next sign-in retries"
  - "Use ghost-kind Buttons for terms/privacy links (Button.tsx has no 'secondary' kind — Rule 3 adaptation from plan snippet)"
  - "AcceptToSModal mounts as the LAST modal in the App.tsx tree so it overlays every other modal/toast at the same z-index (1000)"
metrics:
  duration_seconds: 98
  tasks_completed: 2_of_3
  files_created: 2
  files_modified: 2
  commits: 2
  completed_date: "2026-05-21"
---

# Phase 11 Plan 13: AcceptToSModal Summary

One-liner: Blocking ToS+Privacy acceptance overlay mounted by App.tsx when a signed-in user lacks a current-version `tos_acceptance` row, gated by `useAuthStore.tosAccepted` tristate.

## What was built

### Task 1 — AcceptToSModal component (commit 685dc26)

`src/renderer/src/components/AcceptToSModal.tsx` (115 lines) — blocking modal with:
- 460px scrim+frame structure mirroring DeleteAccountModal.module.css idiom
- Title "Review Sei's Terms" + body paragraph per plan copy
- Two `Button kind="ghost"` open-external buttons → `sei.openExternal('https://sei.gg/terms.html')` and `'.../privacy.html'`
- Required checkbox `I have read and agree to both` gates the primary action
- Primary `Button kind="accent"` "Accept and continue" / "Accepting…" calls `sei.tosAccept()`; `{ok:false, message}` displays as inline `role="alert"` error and lets the user retry
- ESC suppression unconditional (`e.preventDefault()`) — no dismissal path
- Click-outside suppressed (no `onClick` on scrim)
- `aria-modal="true"` + `aria-labelledby` for screen-reader semantics

`src/renderer/src/components/AcceptToSModal.module.css` reuses existing design tokens (`var(--window)`, `var(--text)`, `var(--text-2)`, `var(--accent)`, `var(--red)`, `var(--shadow-pop)`, `var(--ease-pop)`). No new tokens introduced. `prefers-reduced-motion` opts out of fade animations.

### Task 2 — useAuthStore + App.tsx wiring (commit 0ced339)

`src/renderer/src/lib/stores/useAuthStore.ts`:
- Added `tosAccepted: boolean | null` to the `AuthStore` interface and initial state (`null` = unknown)
- Added `refreshTosStatus: () => Promise<void>` action that calls `sei.tosStatus()` and sets `tosAccepted = s.accepted`; on error sets `tosAccepted = null` (fail-closed-but-non-blocking — see Decisions)
- `subscribeAuthState()` subscriber now tracks `prevKind` and calls `refreshTosStatus()` on every transition into `signed_in`, plus resets `tosAccepted` to `null` on transition into `local`

`src/renderer/src/App.tsx`:
- Imported `AcceptToSModal`
- Selected `tosAccepted` + `refreshTosStatus` from `useAuthStore`
- Mounted `<AcceptToSModal onAccepted={() => { void refreshTosStatus(); }} />` as the LAST modal in the root fragment, gated on `authState.kind === 'signed_in' && tosAccepted === false`

## Cross-plan dependency bridge

Plan 11-12 (`tos:status`, `tos:accept`, `app:open-external` IPC) is landing in parallel with this plan. To compile this worktree standalone, two small `TosBridge` / `TosStatusBridge` type casts in `AcceptToSModal.tsx` and `useAuthStore.ts` augment the imported `sei` value with the Plan 11-12 method signatures. These casts are **no-ops once 11-12's `RendererApi` extensions land** — the runtime call sites are identical to what 11-12 ships, and the cast collapses to the source type. A follow-up cleanup commit (or 11-12's merge) can remove the bridges.

## Verification status

`npx tsc --noEmit -p tsconfig.web.json` exits 0 — renderer-side typecheck passes standalone.
`npx tsc --noEmit -p tsconfig.node.json` reports two **pre-existing** errors unrelated to this plan (`src/main/auth/loopbackPkce.ts` flowType, `src/main/auth/supabaseClient.test.ts` spread) — out of scope per executor scope-boundary rule.

`npm run typecheck` is not defined in `package.json` scripts; equivalent `npx tsc --noEmit -p tsconfig.web.json` was used.

Tests not executed for this plan — no test changes were made and the plan's `npm test` acceptance criterion fires only after Plan 11-12 lands the IPC the modal depends on.

## CHECKPOINT REACHED — Task 3 (human-verify, blocking)

**Type:** human-verify
**Plan:** 11-13
**Progress:** 2/3 tasks complete

### Completed Tasks

| Task | Name                                       | Commit  | Files                                                                              |
| ---- | ------------------------------------------ | ------- | ---------------------------------------------------------------------------------- |
| 1    | Build AcceptToSModal component             | 685dc26 | AcceptToSModal.tsx, AcceptToSModal.module.css                                      |
| 2    | tosAccepted in useAuthStore + App.tsx gate | 0ced339 | useAuthStore.ts, App.tsx                                                           |

### Current Task

**Task 3:** Verify blocking modal UX
**Status:** Awaiting human verification
**Blocker:** Plan 11-12 (`sei.tosStatus`, `sei.tosAccept`, `sei.openExternal`) must merge first; verification then requires a live Supabase test account with no `tos_acceptance` row.

### What the user needs to do (lifted from Task 3 `how-to-verify`)

1. Wait for Plan 11-12 to merge (provides the IPC the modal depends on; the inline `TosBridge` casts become no-ops at that point)
2. Sign in with a test Supabase account that has NO `tos_acceptance` row
3. Verify `AcceptToSModal` renders as the only interactive UI on screen
4. Press ESC — verify nothing happens (no dismissal)
5. Click **Open Terms of Service** — verify the system browser opens `https://sei.gg/terms.html`
6. Click **Open Privacy Policy** — verify the system browser opens the privacy page
7. With the checkbox UNCHECKED, try **Accept and continue** — button must be disabled
8. Check the checkbox, click **Accept and continue** — modal should close after the IPC succeeds
9. Verify a `tos_acceptance` row was inserted:
   ```
   mcp__supabase__execute_sql "SELECT * FROM tos_acceptance WHERE user_id = '<your-uid>'"
   ```
   returns 1 row with `tos_version='2026-05-21'`
10. Sign out and sign in again — modal should NOT re-appear (acceptance persists)
11. Optionally test version bump: temporarily change `TOS_VERSION` in `src/shared/legalVersions.ts` to `'2026-05-22'`, restart, sign in — modal should re-appear

**Resume signal:** Reply `tos-modal-approved` or describe any issue found.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Blocking issue] Button `kind="secondary"` does not exist**
- **Found during:** Task 1 build
- **Issue:** Plan snippet uses `<Button kind="secondary" ...>` for the two open-external links, but `src/renderer/src/components/Button.tsx` exposes `Kind = 'primary' | 'accent' | 'ghost' | 'quiet'` only — no `secondary`. TypeScript would have rejected the snippet as-written.
- **Fix:** Substituted `kind="ghost"` for both open-external buttons (matches the existing visual idiom for non-primary actions; SignInModal also uses `ghost` for "Continue with Google"). The primary CTA uses `kind="accent"` matching SignInModal's submit pattern.
- **Files modified:** `src/renderer/src/components/AcceptToSModal.tsx`
- **Commit:** 685dc26

**2. [Rule 3 — Blocking issue] Plan 11-12 IPC not yet merged into this worktree**
- **Found during:** Task 1 + Task 2 typecheck
- **Issue:** `sei.tosAccept`, `sei.tosStatus`, `sei.openExternal` are not on the `RendererApi` interface in this worktree's `src/shared/ipc.ts` — Plan 11-12 ships them in parallel. Without a bridge, both files fail typecheck.
- **Fix:** Added inline `TosBridge` / `TosStatusBridge` type casts at the top of each file that augment the imported `sei` with the Plan 11-12 signatures (`tosAccept` / `tosStatus` / `openExternal`). The casts are structurally compatible with what 11-12 ships, so they become no-ops once the real `RendererApi` extensions land.
- **Files modified:** `src/renderer/src/components/AcceptToSModal.tsx`, `src/renderer/src/lib/stores/useAuthStore.ts`
- **Commits:** 685dc26, 0ced339

### Rule-4 (Architectural) escalations

None.

## Threat Flags

None. The modal calls only the IPC surface declared in `<threat_model>` (T-11-13-02 mitigation: text+ToS_VERSION constant in `src/shared/legalVersions.ts` is already wired and unchanged here).

## Known Stubs

None. The modal is fully wired against the API contract Plan 11-12 will land; no placeholder data, no "coming soon" copy.

## Self-Check: PASSED

- `[FOUND]` `src/renderer/src/components/AcceptToSModal.tsx`
- `[FOUND]` `src/renderer/src/components/AcceptToSModal.module.css`
- `[FOUND]` modified `src/renderer/src/App.tsx`
- `[FOUND]` modified `src/renderer/src/lib/stores/useAuthStore.ts`
- `[FOUND]` commit `685dc26` (Task 1)
- `[FOUND]` commit `0ced339` (Task 2)
- `[FOUND]` `grep -c "sei.tosAccept" src/renderer/src/components/AcceptToSModal.tsx` → 4 ≥ 1
- `[FOUND]` `grep -c "sei.openExternal" src/renderer/src/components/AcceptToSModal.tsx` → 3 ≥ 2
- `[FOUND]` `grep -c "I have read and agree" src/renderer/src/components/AcceptToSModal.tsx` → 1 ≥ 1
- `[FOUND]` `grep -c "e.preventDefault" src/renderer/src/components/AcceptToSModal.tsx` → 1 ≥ 1
- `[FOUND]` `grep -c "AcceptToSModal" src/renderer/src/App.tsx` → 3 ≥ 2
- `[FOUND]` `grep -c "tosAccepted === false" src/renderer/src/App.tsx` → 1 ≥ 1
- `[FOUND]` `grep -c "tosAccepted" src/renderer/src/lib/stores/useAuthStore.ts` → 8 ≥ 2
- `[FOUND]` `grep -c "refreshTosStatus" src/renderer/src/lib/stores/useAuthStore.ts` → 5 ≥ 1
- `[FOUND]` `grep -c "sei.tosStatus" src/renderer/src/lib/stores/useAuthStore.ts` → 2 ≥ 1
- `[PASS]` `npx tsc --noEmit -p tsconfig.web.json` exits 0
