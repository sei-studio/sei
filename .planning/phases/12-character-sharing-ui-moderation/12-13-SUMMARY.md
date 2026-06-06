---
phase: 12-character-sharing-ui-moderation
plan: 13
subsystem: renderer-components
tags: [renderer, modal, components, report-flow, share]

# Dependency graph
requires:
  - phase: 12-character-sharing-ui-moderation
    plan: 05
    provides: "submit-report Edge Function (5/reporter/hour 429 with FRIENDLY_RATE_LIMITED_MESSAGE), REASON_ENUM canonical 4-string allowlist"
  - phase: 12-character-sharing-ui-moderation
    plan: 08
    provides: "window.sei.browseReport IPC (isCloudWriteAllowed gate, Zod reason enum validation, SubmitReportResult tagged union routed back to renderer)"
  - phase: 12-character-sharing-ui-moderation
    plan: 11
    provides: "BrowseCard onReport handler + CharactersScreen.BrowseGrid reportTarget state — 12-13 lands the modal mount behind the existing conditional"
provides:
  - "ReportModal.tsx — SHARE-08 user-facing report submission modal with phased state machine (idle / submitting / success / rate_limited / error)"
  - "ReportModal.module.css — modal styling matching MigrateLocalCharsModal / DeleteAccountModal visual idiom (460px frame, 32px padding, --window/--accent tokens)"
  - "LABELS map (display strings for REPORT_REASONS canonical values — display-only, safe to retouch without DB/Edge/main coordination)"
affects: [12-14-defense-in-depth-ux-gate, 12-15-post-share-empty-states]

# Tech tracking
tech-stack:
  added: []  # Reuses React + Button + sei IPC client + REPORT_REASONS from @shared/ipc
  patterns:
    - "Phased modal state machine (idle / submitting / success / rate_limited / error) — discriminated union, exhaustive render branches, ergonomically lifted from MigrateLocalCharsModal but with cancellable scrim+Esc since reports are NOT legal gates."
    - "Cross-layer enum lockstep: REPORT_REASONS in @shared/ipc is the only canonical source — DB CHECK (12-01) + Edge REASON_ENUM (12-05) + Zod ReportReasonSchema (12-08) + this modal's LABELS keys all derive from the same 4 strings."
    - "Defense-in-depth on detail length: UI maxLength={500} (here) + Zod max(500) in main IPC (12-08) + Edge Function `.slice(0, 500)` (12-05) + DB CHECK length(detail) <= 500 (12-01). Browser truncates pastes before they hit React state, so the charCount widget remains accurate."
    - "Friendly 429 copy is owned by main (moderationEdgeClient.ts FRIENDLY_RATE_LIMITED) — modal renders the `message` field returned over IPC. Drift-resistant: one place to change copy."
    - "Submit-suppression of Esc/scrim-click during in-flight IPC mirrors SignOutConfirmModal — prevents orphaning the await by tearing down the component before resolution."

key-files:
  created:
    - src/renderer/src/components/ReportModal.tsx
    - src/renderer/src/components/ReportModal.module.css
  modified:
    - src/renderer/src/screens/CharactersScreen.tsx

key-decisions:
  - "Use Button kind='accent' for Submit/Close + Button kind='ghost' for Cancel/Try-again — matches every other modal in the codebase (SignOutConfirmModal, DeleteAccountModal, MigrateLocalCharsModal). Plan sketch used raw <button> + cancelBtn/submitBtn CSS classes; we picked Button to stay consistent. Result: zero new button styling, theme automatically follows light/dark."
  - "ReportReason 'other' chosen as initial radio default. The plan didn't specify a default; 'other' was picked because (a) it's the lowest-stakes option — won't bias users toward a more severe category they may not actually mean, (b) it's the most neutral starting position for a form that requires user thought to fill correctly. Users must still actively select before submitting feels right; required-radio enforcement isn't needed since 'other' is a valid reason in REASON_ENUM."
  - "Cancellable scrim + Esc per CONTEXT D-34 (NOT D-26/AcceptToSModal legal-gate idiom). Suppress both mid-submit to avoid orphaning the in-flight IPC. Matches SignOutConfirmModal's suppression pattern verbatim."
  - "Detail textarea is OPTIONAL — submit succeeds with an empty string (treated as undefined by `detail.trim().length > 0 ? trimmed : undefined`). The Edge Function in 12-05 already handles optional detail, so no server-side change required."
  - "Errors transitioning back to 'idle' via Try again — rate-limited path is one-shot Close because retry won't help inside the 1-hour window; error path may be transient (network blip, timeout), so Try again is the friendlier affordance."
  - "Removed the `void reportTarget` lint shim from CharactersScreen.tsx that 12-11 added — the setter pair is now genuinely consumed via the conditional mount."

patterns-established:
  - "Phased-modal-with-cancellation pattern for v1.0+ user-cancellable submission flows (vs. AcceptToSModal's blocking legal-gate pattern). Anyone shipping a future modal that's NOT a legal gate should mirror ReportModal's Esc + scrim handlers (with mid-submit suppression) rather than disable them entirely."

requirements-addressed: [SHARE-08]
requirements-completed: [SHARE-08]

# Metrics
duration: ~3min
completed: 2026-05-22
---

# Phase 12 Plan 13: ReportModal Summary

**SHARE-08 user-facing report submission modal — phased state machine (idle → submitting → success | rate_limited | error) mirroring MigrateLocalCharsModal but cancellable per CONTEXT D-34 (reports aren't legal gates). Cross-layer REPORT_REASONS enum locked in step with DB CHECK / Edge REASON_ENUM / IPC Zod. Friendly 429 rate-limit pane renders the message field owned by main's moderationEdgeClient — one place to edit copy.**

## Performance

- **Duration:** ~3 min
- **Started:** 2026-05-22T09:36:28Z
- **Completed:** 2026-05-22T09:39:02Z
- **Tasks:** 2
- **Files created:** 2; modified: 1

## Component Contract

```ts
export interface ReportModalProps {
  /** UUID of the public character being reported. */
  characterId: string;
  /** Display name used in the modal title (e.g. `Report "Pixie"`). */
  characterName: string;
  /** Closes the modal. Caller controls mount/unmount via reportTarget state. */
  onClose: () => void;
}
```

Owner of the submit IPC: the modal itself. CharactersScreen only manages the
`reportTarget: BrowseEntry | null` state — handler sets it from BrowseCard's
`onReport`, modal clears it via `onClose`.

## State Machine

```
idle ──Submit──> submitting ──{ok:true}────────> success ──Close──> [unmount]
                            ──{code:'rate_limited'}──> rate_limited ──Close──> [unmount]
                            ──{code:'bad_request'|'network'|'unauthenticated'|throw}──> error
                                                                    ├──Try again──> idle
                                                                    └──Close──> [unmount]
```

Escape + scrim click close from `idle`, `success`, `rate_limited`, and `error`
phases. They are **suppressed during `submitting`** to avoid orphaning the
in-flight IPC.

## LABELS Map (display-only — values are canonical REPORT_REASONS)

```ts
const LABELS: Record<ReportReason, string> = {
  sexual_content_minors:  'Sexual content involving minors',
  hate_speech_harassment: 'Hate speech or harassment',
  copyright_infringement: 'Copyright infringement',
  other:                  'Other',
};
```

**Editing display strings:** safe — UI only. Touch this file, ship.
**Editing the keys / adding a reason:** unsafe — see Cross-Layer Invariant below.

## Cross-Layer Invariant — REPORT_REASONS

The 4-string canonical enum is replicated across four files. Drift between any
of them surfaces at INSERT time (DB CHECK rejects unknown reasons with a hard
400 from submit-report):

| Layer    | File                                                                             | Symbol                            |
| -------- | -------------------------------------------------------------------------------- | --------------------------------- |
| DB       | `supabase/migrations/20260523000000_moderation_and_reports.sql`                  | `reports.reason CHECK` clause     |
| Edge fn  | `supabase/functions/submit-report/index.ts`                                      | `REASON_ENUM`                     |
| Shared   | `src/shared/ipc.ts`                                                              | `REPORT_REASONS` (const + type)   |
| Renderer | `src/renderer/src/components/ReportModal.tsx`                                    | `LABELS` keys (driven by import)  |

Adding/removing a value requires editing **all four sites in the same PR**.
The renderer layer is the cheapest to update (LABELS keys auto-suggest from
the imported `ReportReason` type), so do it last.

## Friendly 429 Copy — Owned by Main

The "You've reported a lot in the last hour…" string lives in
`src/main/cloud/moderationEdgeClient.ts` (FRIENDLY_RATE_LIMITED const). When
the modal receives `{ ok: false, code: 'rate_limited', message }` it renders
the `message` field verbatim. **DO NOT duplicate the string in this modal.** If
the copy needs to change, change it in moderationEdgeClient.ts only.

## Defense in Depth — 500-char Detail Cap

| Layer            | Mechanism                                | Behavior on overflow                    |
| ---------------- | ---------------------------------------- | --------------------------------------- |
| Browser DOM      | `<textarea maxLength={500}>`             | Truncates paste before React sees it    |
| Renderer state   | (no explicit check — DOM is authoritative) | n/a                                   |
| Main Zod (12-08) | `z.string().max(500).optional()`         | 400 `bad_request`                       |
| Edge Function    | `detail.slice(0, 500)` (12-05)           | Silent truncation (last-resort defense) |
| DB CHECK         | `length(detail) <= 500` (12-01)          | Hard 400 on bypass                      |

The charCount widget (`{detail.length}/500`) stays accurate because the DOM
truncates before the onChange callback fires.

## Task Commits

| Task | Commit    | Description                                                  |
| ---- | --------- | ------------------------------------------------------------ |
| 1    | `279ea3e` | feat(12-13): add ReportModal component + CSS module          |
| 2    | `f24cd2f` | feat(12-13): mount ReportModal in CharactersScreen BrowseGrid |

## What Landed

### `src/renderer/src/components/ReportModal.tsx` (new, 217 lines)

- Phased state machine (5 phases) via discriminated union.
- 4-radio fieldset driven by `REPORT_REASONS.map(...)` — adding a reason via
  the canonical enum auto-renders the new radio (after a LABELS edit).
- Optional 500-char-capped textarea with live char counter.
- Esc/scrim-click closes with mid-submit suppression.
- Try-again on the error phase returns to idle without reloading reason/detail
  state — user doesn't have to re-pick + re-type if their first submit hit a
  transient network blip.

### `src/renderer/src/components/ReportModal.module.css` (new, 162 lines)

- 460px frame, 32px padding, --window background, --shadow-pop drop shadow —
  matches MigrateLocalCharsModal / DeleteAccountModal / AcceptToSModal visual
  idiom.
- `.detailField:focus-visible` lifts the 1.5px accent-color outline from
  UI-SPEC §D-28.
- `@media (prefers-reduced-motion: reduce)` zeroes the fade/fadeUp keyframes —
  parity with sibling modals.
- No new design tokens introduced.

### `src/renderer/src/screens/CharactersScreen.tsx` (modified, +6 / -16 lines)

- Imports `ReportModal` from `../components/ReportModal`.
- Removes the `void reportTarget` lint shim that 12-11 added (now genuinely
  consumed).
- Simplifies `handleReport` from the 12-11 stub (console.info intent + TODO)
  to just `setReportTarget(entry)`.
- Replaces the trailing JSX comment block with the real conditional mount.

## Decisions Made

1. **Use `Button` component, not raw `<button>`.** Plan sketch used CSS classes
   `.cancelBtn` / `.submitBtn`; the codebase ships a Button component with
   primary / accent / ghost / quiet kinds + sm/md/lg sizes, used by every
   other modal. Adopting Button keeps theme tokens (light/dark) consistent
   without duplicating button styling. The .cancelBtn / .submitBtn classes
   were dropped from the CSS module accordingly.
2. **Initial reason = `'other'`.** Lowest-stakes default; doesn't bias the
   user toward more severe categories. All 4 values are valid in REASON_ENUM
   so no required-radio enforcement needed.
3. **Cancellable Esc + scrim, suppressed mid-submit.** Matches CONTEXT D-34
   "reports are user-cancellable" + SignOutConfirmModal's suppression idiom
   for the in-flight branch.
4. **Friendly 429 message rendered from IPC, not hardcoded.** Single source
   of truth lives in moderationEdgeClient.ts so the copy can be updated in
   one place.
5. **Error pane offers Try again + Close.** Rate-limited gets Close only —
   retrying within the 1-hour window is futile. Generic error path may be
   transient (network blip, Edge function 5xx) so Try again is the right
   first affordance.
6. **detail.trim() before send.** Whitespace-only input collapses to
   `undefined` — matches the Edge Function's optional-detail contract and
   keeps the reports table from accruing rows of pure whitespace.

## Deviations from Plan

### Minor adaptations to existing codebase conventions — no behavior drift from plan intent.

#### 1. [Rule 1 — Codebase consistency] Use Button component instead of raw `<button>` + cancelBtn/submitBtn CSS classes

- **Found during:** Task 1
- **Issue:** Plan sketch defined `.cancelBtn` and `.submitBtn` CSS classes with custom padding/border/background. Every other modal in the codebase (SignOutConfirmModal, DeleteAccountModal, MigrateLocalCharsModal, AcceptToSModal) uses the shared `Button` component with `kind='accent' | 'ghost'` instead — and the design tokens (`--accent`, `--accent-fg`, hover/focus rings) already live in Button.module.css.
- **Fix:** Adopted `Button` for all four button slots (Submit / Cancel / Try again / Close). Dropped `.cancelBtn` / `.submitBtn` from ReportModal.module.css. Visual result is indistinguishable from the plan's mockup but theme-coherent with the rest of the modal corpus.
- **Files modified:** src/renderer/src/components/ReportModal.tsx, src/renderer/src/components/ReportModal.module.css
- **Commit:** 279ea3e

#### 2. [Rule 2 — Lint cleanup] Remove `void reportTarget` shim from CharactersScreen.tsx

- **Found during:** Task 2
- **Issue:** 12-11 added `void reportTarget;` to suppress an unused-state-variable lint warning ("the setter pair is wired but the getter isn't consumed yet"). After the conditional mount lands in this plan, `reportTarget` is genuinely consumed and the shim is dead code.
- **Fix:** Removed the shim line. ESLint now satisfies via real consumption.
- **Files modified:** src/renderer/src/screens/CharactersScreen.tsx
- **Commit:** f24cd2f

## Threat Compliance

Per 12-13 threat register:

| Threat ID   | Disposition | Status                                                                                                                                                                                                                |
| ----------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-12-13-01  | mitigate    | **MITIGATED** by 12-08 main-side Zod enum validation. Radio `value` strings here match `REPORT_REASONS`; even if a malicious DevTools user mutates the value, the main handler rejects with bad_request.            |
| T-12-13-02  | mitigate    | **MITIGATED** by 12-05 Edge Function rate-limit (5/reporter/hour) + this modal's friendly 429 pane that closes cleanly without re-arming the form (no lockout, no further client-side rate-limiting needed).         |
| T-12-13-03  | accept      | **ACCEPTED.** Modal renders `characterName` (already public via BrowseEntry) and the current user's chosen reason/detail. `reporter_id` is never displayed — it's derived from JWT in the Edge Function (12-05).      |
| T-12-13-04  | mitigate    | **MITIGATED** with 4 layers: `<textarea maxLength={500}>` (here), Zod `.max(500)` (12-08), Edge `.slice(0, 500)` (12-05), DB CHECK `length(detail) <= 500` (12-01). Defense in depth verified.                         |

No new threat surface introduced. Modal owns no IPC channel of its own — it
only calls the existing `window.sei.browseReport` from 12-08.

## Threat Flags

None — this plan adds a UI surface for an existing IPC channel (12-08
browse:report). No new network endpoints, auth paths, file access patterns,
or schema changes.

## Verification Status

- `npx tsc --noEmit -p tsconfig.web.json` — **CLEAN** (0 errors in renderer/shared)
- `npx vitest run src/renderer/ src/shared/` — **19/19 tests pass**
- `npm run build` — **CLEAN** (main + preload + renderer Vite builds all succeed)
- `grep -c "ReportModal\|REPORT_REASONS\|maxLength={500}\|browseReport" src/renderer/src/components/ReportModal.tsx` → **14** (plan threshold: ≥4) ✓
- `grep -c "ReportModal" src/renderer/src/screens/CharactersScreen.tsx` → **4** (plan threshold: ≥2) ✓

### Manual smoke-test plan (deferred to 12-17 rollout — no Browse-tab-visible builds locally yet)

Per plan `<verification>`:

1. Click Report on a BrowseCard → modal appears with title `Report "<name>"` + 4 radio options.
2. Submit with default reason → modal transitions to "Thanks — we'll review." pane.
3. Submit 6 times rapidly → 6th gets 429 → friendly rate-limit copy renders + Close button works.
4. Press Esc → modal closes (when not mid-submit).
5. Click scrim → modal closes (when not mid-submit).
6. Paste >500 chars into detail → field caps at 500 (verify charCount = 500/500).

## Known Stubs

None. The modal is fully wired end-to-end:
- BrowseCard `onReport` → CharactersScreen `handleReport` → setReportTarget
- Conditional render of `<ReportModal />` when reportTarget !== null
- Modal `handleSubmit` → `sei.browseReport` → main handler (12-08) → Edge Function (12-05) → DB INSERT + webhook fan-out (12-01)
- Result tagged union flows back: success / rate_limited / bad_request / network / unauthenticated all rendered.

## Self-Check

Verifying claimed artifacts and commits exist:

- `src/renderer/src/components/ReportModal.tsx` — **FOUND** (217 lines)
- `src/renderer/src/components/ReportModal.module.css` — **FOUND** (162 lines)
- `src/renderer/src/screens/CharactersScreen.tsx` — **MODIFIED** (verified by `grep -c ReportModal` → 4)
- Commit `279ea3e` (Task 1: ReportModal component + CSS module) — **FOUND** in git log
- Commit `f24cd2f` (Task 2: CharactersScreen mount) — **FOUND** in git log
- `npx tsc --noEmit -p tsconfig.web.json` — **CLEAN**
- `npx vitest run src/renderer/ src/shared/` — **19/19 tests pass**
- `npm run build` — **CLEAN**
- LABELS keys === REPORT_REASONS values — verified (both 4-string sets identical: sexual_content_minors / hate_speech_harassment / copyright_infringement / other)
- maxLength={500} present in ReportModal.tsx — verified
- Esc handler suppresses mid-submit — verified (`phase.kind !== 'submitting'` check at line ~75)

## Self-Check: PASSED

---
*Phase: 12-character-sharing-ui-moderation*
*Completed: 2026-05-22*
