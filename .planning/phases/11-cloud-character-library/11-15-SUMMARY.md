---
phase: 11-cloud-character-library
plan: 15
subsystem: ui
tags: [shared, toggle, character-page, signin-modal, upgrade-flow, pending-intent]

# Dependency graph
requires:
  - phase: 10-auth-foundation
    provides: SignInModal with framingLabel prop (D-10), useAuthStore.UpgradeFraming union (includes 'share this character' literal), subscribeAuthState push
  - phase: 11-cloud-character-library
    provides: sei.charsSetShared IPC (Plan 11-09), tosAccepted gate (Plan 11-13), shared boolean on CharacterSchema (Plan 11-01), defense-in-depth is_default rejection in chars:set-shared handler (Plan 11-14)
provides:
  - Public/private toggle UI on CharacterPage (two-state pill, StatusPill visual idiom)
  - Signed-out upgrade-to-share flow via locally-mounted SignInModal with framingLabel='share this character'
  - pendingShareIntent in useAuthStore + post-sign-in auto-consume via consumeShareIntent helper
  - is_default render-gate + handler-side belt-and-suspenders (defense-in-depth for T-11-15-01)
  - T-11-15-02 mitigation: pendingShareIntent cleared on signed_in → local transition (no cross-session leak)
affects: [phase-12-character-sharing-ui-moderation, browse-ui-visibility-toggle]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Locally-mounted SignInModal with framingLabel sourced from useAuthStore.upgradeFraming (mirrors AuthChoiceScreen pattern; avoids touching the global useUiStore.Modal union)"
    - "Pending-intent store slot consumed by auth-state subscriber after ToS gate resolves (D-17 + Plan 11-13 chaining)"

key-files:
  created: []
  modified:
    - src/renderer/src/screens/CharacterPage.tsx
    - src/renderer/src/lib/stores/useAuthStore.ts
    - src/renderer/src/screens/CharacterPage.module.css

key-decisions:
  - "Local SignInModal mount over global useUiStore.Modal routing — the Modal union does not include 'signin' and CharacterPage is the only signed-out entry point for the public/private upgrade flow today. Adding 'signin' to the global union would have required touching useUiStore.ts + App.tsx, which are outside files_modified. The AuthChoiceScreen-pattern local mount is contained, type-safe, and reuses SignInModal's existing onClose contract."
  - "framingLabel sourced from useAuthStore.upgradeFraming rather than a CharacterPage-local string literal — the literal 'share this character' lives in one place (the UpgradeFraming union) per D-10 architecture, so visual-copy edits remain a single-file change."
  - "consumeShareIntent chained off refreshTosStatus's accept branch (not directly off subscribeAuthState) — Plan 11-13's ToS modal mandates acceptance before any cloud write, so the share-intent must wait for that gate. The chain keeps the ordering invariant in one place (refreshTosStatus → if accepted → fire)."
  - "Render-time is_default gate (toggle button never renders for defaults) + handler-side early-return — T-11-15-01 defense-in-depth, matches the existing 'sui-undeletable' pattern of UI gates + main-side IPC handler rejection."
  - "Idempotency assumption documented inline (T-11-15-03): consumeShareIntent re-fires are safe because charsSetShared upserts; we clear pendingShareIntent unconditionally in the finally block so a transient crash mid-handler doesn't leave a stuck intent."

patterns-established:
  - "Renderer-side pending-intent store slot for upgrade-to-feature UX — pattern reusable for any signed-out feature that needs to fire-after-sign-in (e.g. future 'buy credits' or 'browse public library' flows)"
  - "Two-state pill toggle vocabulary using StatusPill's 8px square dot + uppercase label, with --green/--muted token colors — reusable for any low-friction boolean toggle that needs visual consistency with the existing status-pill family"

requirements-completed: [LIB-01, LIB-05]

# Metrics
duration: 5 min
completed: 2026-05-22
---

# Phase 11 Plan 15: Public/Private Toggle UI Summary

**Public/private toggle on CharacterPage with locally-mounted SignInModal upgrade flow + pendingShareIntent post-sign-in auto-consume.**

## Performance

- **Duration:** ~5 min (autonomous execution under `mode: yolo`)
- **Started:** 2026-05-22T05:34:31Z
- **Completed:** 2026-05-22T05:38:46Z
- **Tasks:** 1 of 2 executed; Task 2 (checkpoint:human-verify) auto-approved under yolo mode
- **Files modified:** 3 (one CSS module added alongside its TSX component — see Deviations)

## Accomplishments

- Surfaced D-16's `shared` boolean as a user-facing toggle on the character page (LIB-05 — CRUD reflects in UI).
- D-17 upgrade-to-sign-in flow wired end-to-end: signed-out toggle → SignInModal with framingLabel 'share this character' → post-sign-in pendingShareIntent fires charsSetShared({shared:true}) automatically.
- T-11-15-02 cross-session leak mitigation: pendingShareIntent is cleared on every signed_in → local transition.
- D-22 invariant preserved: toggle is hidden for `is_default` characters (sui/lyra/clawd) — defaults remain read-only at the user level.
- Visual consistency with existing UI vocabulary: 8px square dot + uppercase label matching StatusPill, --green/--muted token colors only, no destructive styling, low-friction reversible interaction per CONTEXT §specifics.

## Task Commits

Each task was committed atomically:

1. **Task 1: Add shared toggle UI + signed-out upgrade flow + pending intent** — `c887158` (feat)
2. **Task 2: Verify toggle UX** — auto-approved under `mode: yolo` (no commit; visual-verify gate)

## Files Created/Modified

- `src/renderer/src/screens/CharacterPage.tsx` — Added useAuthStore subscriptions (authState, setUpgradeFraming, setPendingShareIntent, upgradeFraming), `onToggleShared` handler, `showSignIn`/`shareError`/`sharePending` local state, the toggle pill JSX (gated on `!is_default`), and a locally-mounted SignInModal at the end of the JSX tree. Imports: useAuthStore, SignInModal.
- `src/renderer/src/lib/stores/useAuthStore.ts` — Added `PendingShareIntent` type export, `pendingShareIntent` state + `setPendingShareIntent` setter on the store, `consumeShareIntent` helper (gated on signed_in + tosAccepted, fires charsSetShared idempotently, clears the intent in finally). `refreshTosStatus` chains into `consumeShareIntent` on accept. `subscribeAuthState` clears `pendingShareIntent` on signed_in → local for T-11-15-02.
- `src/renderer/src/screens/CharacterPage.module.css` — Added `.sharedToggleRow`, `.sharedToggle`, `.sharedToggleOn`, `.sharedToggleOff`, `.sharedDot`, `.sharedDotOn`, `.sharedDotOff`, `.sharedLabel`, `.sharedError` selectors using token-only colors (--surface, --border, --green, --muted, --text-2, --red), matching the StatusPill visual idiom.

## Verification

- `grep -c "charsSetShared" src/renderer/src/screens/CharacterPage.tsx` → 3 (≥ 1 required)
- `grep -c "is_default" src/renderer/src/screens/CharacterPage.tsx` → 5 (≥ 1 required)
- `grep -c "share this character" src/renderer/src/screens/CharacterPage.tsx` → 5 (≥ 1 required)
- `grep -c "pendingShareIntent" src/renderer/src/lib/stores/useAuthStore.ts` → 9 (≥ 2 required)
- `grep -c "setUpgradeFraming" src/renderer/src/screens/CharacterPage.tsx` → 3 (≥ 1 required)
- `./node_modules/.bin/tsc --noEmit` → exit 0 (project has no `typecheck` npm script; established Plan 11-14 precedent of running tsc directly)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Blocking] Used local SignInModal mount instead of `openModal({ kind: 'signin' })`**

- **Found during:** Task 1 (CharacterPage.tsx implementation)
- **Issue:** The plan's pseudocode called `openModal({ kind: 'signin' })`, but the `Modal` union in `src/renderer/src/lib/stores/useUiStore.ts` does NOT include a `'signin'` variant. It only supports `'lan'` and `'delete-confirm'`. Using the plan's literal code would have produced a typecheck error AND the modal would never render (App.tsx has no `modal?.kind === 'signin'` branch).
- **Fix:** Mounted SignInModal as a local child of CharacterPage with `useState<boolean>` driving its presence — exactly the pattern AuthChoiceScreen uses (the only other entry point to SignInModal today). framingLabel is sourced from `useAuthStore.upgradeFraming` so the 'share this character' literal still lives in one place. This kept the change contained to the plan's `files_modified` list (would have otherwise required modifying useUiStore.ts + App.tsx, both out of scope per the orchestrator's sequential-mode constraint).
- **Files modified:** `src/renderer/src/screens/CharacterPage.tsx`
- **Commit:** `c887158`

**2. [Rule 3 — Blocking] CSS module additions to CharacterPage.module.css**

- **Found during:** Task 1 (toggle styling)
- **Issue:** The plan instructs "Add styling for `.sharedToggleRow` / `.sharedToggle` / `.sharedToggleOn` / `.sharedLabel` to the matching CSS module," but `CharacterPage.module.css` is not in the plan's `files_modified` list. Without these styles the toggle would render as an unstyled `<button>` with no visual distinction between Public and Private states.
- **Fix:** Treated the CSS module as part of the same component pair as `CharacterPage.tsx` (component + styles co-located by convention throughout the codebase — see SignInModal.tsx/SignInModal.module.css, StatusPill.tsx/StatusPill.module.css). Added the new selectors using token-only colors. No other files were touched.
- **Files modified:** `src/renderer/src/screens/CharacterPage.module.css`
- **Commit:** `c887158`

### Auto-approvals (yolo mode)

**3. [Auto-mode] Task 2 (checkpoint:human-verify) auto-approved**

- **Found during:** Post-Task-1 gate evaluation
- **Reason:** `mode: "yolo"` in `.planning/config.json` indicates autonomous execution per the GSD planning-config reference (`yolo` runs without prompts). Per the executor's checkpoint protocol, the visual-verify gate was auto-approved with the log: `⚡ Auto-approved: Public/private toggle on character page with signed-out upgrade flow (yolo mode)`. The manual verification steps in Task 2 (signed-out toggle → SignInModal flow, signed-in flip persistence, default-character toggle absence, visual fidelity) remain documented in the plan for any future manual UAT pass.

## Decisions Made

- **Local SignInModal mount over global modal routing.** Detailed in Deviation #1. Net effect: Plan 11-15 stays within its files_modified contract; no global UI state surface is added for a single-call-site upgrade flow.
- **Toggle is disabled (not hidden) when signed-out + already-private.** D-17 says "defaulted to 'private' and DISABLED; attempting to toggle to public opens SignInModal." Signed-out chars are always private (D-15: only signed-in users get cloud-backed shared=true defaults), so the disabled-while-private path is the only practical state. I rendered the disabled visual treatment (opacity 0.5, cursor not-allowed) so the user sees the affordance exists but can't fire it without signing in.
- **Refresh-after-flip via `refreshCharacter(id)`** rather than relying on a push from main. The current useDataStore doesn't subscribe to cloud row-changed events for sharing flips (no `chars:row-changed` push channel exists for `shared`-only updates). Calling `refreshCharacter` after a successful `charsSetShared` is the minimal, reliable surface; if main later adds a push, this becomes redundant but not broken.

## Threat Coverage

| Threat ID    | Disposition | Mitigation Implemented                                                                                                                                                                                                                                                                                                                                                              |
| ------------ | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-11-15-01   | mitigate    | Toggle button is never rendered for `is_default` characters (render-time gate). `onToggleShared` handler also early-returns on `is_default` (handler-side belt-and-suspenders). Plan 11-09's chars:set-shared main-side handler rejects is_default — three layers of defense.                                                                                                       |
| T-11-15-02   | mitigate    | `subscribeAuthState` sets `pendingShareIntent: null` (along with `tosAccepted: null`) on every signed_in → local transition. Signing out then signing in as a different account cannot fire a stale intent against the previous user's character id.                                                                                                                                |
| T-11-15-03   | accept      | `consumeShareIntent` is safe to re-fire: `charsSetShared` upserts in Postgres, so re-firing with the same `shared` value is a no-op. The intent is cleared in `finally` so transient crashes don't leave it stuck. Documented inline in the helper's JSDoc.                                                                                                                          |

## Known Stubs

None. The toggle renders real data (`character.shared` from the local store) and fires the real IPC (`sei.charsSetShared` from Plan 11-09). The signed-out path wires through to the real SignInModal which on success fires the real auth-state push which triggers the real `consumeShareIntent` against the real cloud row.

## Self-Check

- `[FOUND]` `src/renderer/src/screens/CharacterPage.tsx` (modified, contains `charsSetShared`, `is_default`, `share this character`, `setUpgradeFraming`, `setPendingShareIntent`, `<SignInModal`)
- `[FOUND]` `src/renderer/src/lib/stores/useAuthStore.ts` (modified, contains `pendingShareIntent` ×9, `setPendingShareIntent`, `consumeShareIntent`, T-11-15-02 mitigation comment)
- `[FOUND]` `src/renderer/src/screens/CharacterPage.module.css` (modified, contains `.sharedToggleRow`, `.sharedToggle`, `.sharedDot`, etc.)
- `[FOUND]` commit `c887158` (Task 1, `feat(11-15): add public/private toggle with signed-out upgrade flow`) — `git log --oneline | grep c887158` matches
- `[PASS]` `./node_modules/.bin/tsc --noEmit` → exit 0
- `[PASS]` Plan acceptance grep gates all satisfied (see Verification section)

## Self-Check: PASSED
