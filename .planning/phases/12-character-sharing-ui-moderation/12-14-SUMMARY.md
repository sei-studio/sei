---
phase: 12-character-sharing-ui-moderation
plan: 14
subsystem: ui
tags: [renderer, settings, modal, legal, dmca, react, css-modules]

requires:
  - phase: 12-character-sharing-ui-moderation
    provides: "12-17 openExternal allowlist extension for dmca.copyright.gov + mailto: scheme (not yet executed at time of this plan — modal ships ahead, buttons inert until 12-17 lands)"
  - phase: 11-cloud-character-library
    provides: "sei.openExternal preload bridge + URL-allowlist pattern from Plan 11-12 (allowlist currently sei.gg only — 12-17 extends)"
  - phase: 10-auth-foundation
    provides: "SettingsScreen section/row idiom (ACCOUNT / PROFILE / APPEARANCE)"
provides:
  - "DmcaContactModal component — info modal rendering Designated Agent template (D-35a surface (a))"
  - "DmcaContactModal.module.css — matches AcceptToSModal / MigrateLocalCharsModal visual tokens (460px frame, 0.45 scrim, var(--window))"
  - "LEGAL panel in SettingsScreen — visible to both signed-in and signed-out users; 3 rows (DMCA modal trigger, Terms link, Privacy link)"
  - "Stable AGENT_NAME / AGENT_ADDRESS / AGENT_EMAIL / DIRECTORY_LISTING_URL constants ready for 12-18 swap"
affects: [12-15, 12-16, 12-17, 12-18]

tech-stack:
  added: []
  patterns:
    - "Info-modal CSS reuse: same scrim alpha + 460px frame + 32px padding + var(--window) tokens as AcceptToSModal/MigrateLocalCharsModal (no new design tokens)"
    - "Esc + scrim-click both close for INFORMATIONAL modals (cf. AcceptToSModal which suppresses both as legal-gate)"
    - "Placeholder template constants shipped first, then 12-18 mechanical search-and-replace post-registration"

key-files:
  created:
    - "src/renderer/src/components/DmcaContactModal.tsx (115 lines) — info modal with template agent data + 2 openExternal buttons + Close"
    - "src/renderer/src/components/DmcaContactModal.module.css (133 lines) — scrim/modal/title/details/footer styles"
  modified:
    - "src/renderer/src/screens/SettingsScreen.tsx (+46 lines) — DmcaContactModal import, dmcaModalOpen state, LEGAL section after APPEARANCE (outside signed-in conditional), conditional modal mount"

key-decisions:
  - "Ship modal with PLACEHOLDER agent constants ([Designated Agent — pending registration] / [Mailing address pending registration]) so 12-18 becomes a constants-only edit"
  - "LEGAL panel rendered AFTER APPEARANCE and OUTSIDE the authState.kind === 'signed_in' conditional — DMCA contact + ToS + Privacy are public-law surfaces visible to signed-out users (CONTEXT D-35a, 12-PATTERNS pitfall)"
  - "Esc + scrim click both close — info modal, not a legal-gate (cf. AcceptToSModal which suppresses both)"
  - "Constants AGENT_NAME / AGENT_ADDRESS / AGENT_EMAIL / DIRECTORY_LISTING_URL declared at module top with JSDoc earmarking the 12-18 swap location"
  - "Terms / Privacy rows reuse the existing sei.gg allowlist (Phase 11) — only the DMCA row depends on 12-17's allowlist extension"
  - "Three footer buttons use the project's <Button> component (ghost/ghost/accent) rather than raw <button> markup — visual consistency with every other modal in src/renderer/src/components/"

patterns-established:
  - "Info-modal vs legal-gate-modal distinction: this plan introduces the first cancellable (Esc + scrim) info-modal pattern in src/renderer/src/components/. Future legal/contact info surfaces follow this; legal-gate modals (AcceptToSModal) keep their ESC-suppressed idiom."
  - "Plan-pair pattern: 12-14 ships UI with placeholder strings now → 12-18 ships constants-only edit post-registration. Frontmatter-stable variable names + JSDoc earmarking keep the swap mechanical."

requirements-completed: [SHARE-09]

duration: 2min
completed: 2026-05-22
---

# Phase 12 Plan 14: DmcaContactModal + Settings Legal Panel Summary

**Info modal surfacing Designated Agent template (D-35a surface (a)) wired into a new SettingsScreen LEGAL panel visible to all users, with placeholder constants ready for 12-18's constants-only swap after Copyright Office registration.**

## Performance

- **Duration:** ~2 min
- **Started:** 2026-05-22T09:42:38Z
- **Completed:** 2026-05-22T09:44:39Z
- **Tasks:** 2
- **Files created:** 2
- **Files modified:** 1

## Accomplishments

- `DmcaContactModal.tsx` ships with full Designated Agent template — name placeholder, mailing-address placeholder, `dmca@sei.app` (live email), `https://dmca.copyright.gov/list` Directory listing URL.
- LEGAL panel rendered in `SettingsScreen.tsx` AFTER APPEARANCE and OUTSIDE the signed-in conditional — DMCA + Terms + Privacy rows now visible to signed-out users (per CONTEXT D-35a public-law surface requirement).
- Visual idiom matches `AcceptToSModal` / `MigrateLocalCharsModal` exactly (460px frame, 0.45 scrim alpha, `var(--window)` body, 32px padding, `fadeUp` entry animation, `prefers-reduced-motion` honoured).
- Esc closes + scrim-click closes — first cancellable info-modal in the project (every prior modal is a legal-gate that suppresses both).
- 12-18 swap surface fully ready: four constants at the top of `DmcaContactModal.tsx` are the only edit points for the post-registration swap.

## Task Commits

Each task was committed atomically:

1. **Task 1: Implement DmcaContactModal + CSS** — `cd91baa` (feat)
2. **Task 2: Add LEGAL panel to SettingsScreen** — `8cc0764` (feat)

_Plan metadata commit (this SUMMARY + STATE.md + ROADMAP.md updates) follows below._

## Files Created/Modified

- `src/renderer/src/components/DmcaContactModal.tsx` — Info modal: Esc handler, scrim+modal layout, `<dl>` agent details, 2 helper buttons (`sei.openExternal` for Directory + mailto), Close.
- `src/renderer/src/components/DmcaContactModal.module.css` — Matches `MigrateLocalCharsModal.module.css` aesthetic; adds `.details` grid + `.address` `white-space: pre-line` so the 12-18 multi-line mailing address renders cleanly.
- `src/renderer/src/screens/SettingsScreen.tsx` — `DmcaContactModal` import, `dmcaModalOpen` state, `<section>` LEGAL with 3 rows, conditional modal mount alongside `MigrateLocalCharsModal`.

## 12-18 Swap Surface (constants ready for replacement)

When the dmca.copyright.gov registration completes and the receipt URL is captured, 12-18 edits exactly four lines at the top of `src/renderer/src/components/DmcaContactModal.tsx`:

```tsx
const AGENT_NAME = '[Designated Agent — pending registration]';   // → real legal name
const AGENT_ADDRESS = '[Mailing address pending registration]';   // → real mailing address (may be multi-line)
const AGENT_EMAIL = 'dmca@sei.app';                                // unchanged unless mailbox migrates
const DIRECTORY_LISTING_URL = 'https://dmca.copyright.gov/list';   // → specific receipt URL captured from eForm
```

Recommended 12-18 task: replace the four constants + `git diff` to confirm no other surface drift, then add a backlink to this SUMMARY in 12-18-SUMMARY.

## Decisions Made

- **Modal renders placeholder template now, 12-18 swaps constants later.** Avoids waiting on registration (4–8 weeks for some legal flows) before any UI ships. Placeholder copy `[Designated Agent — pending registration]` is explicit about the pending state so beta testers don't think the placeholder is the real listing (T-12-14-02 mitigation).
- **LEGAL panel placement = end of screen, outside signed-in conditional.** Signed-out users access settings to review legal copy; placing LEGAL inside `authState.kind === 'signed_in'` would hide DMCA contact behind a sign-in wall, which contradicts the public-law nature of the surface. End-of-screen position because LEGAL is less-frequently-used than ACCOUNT/PROFILE/APPEARANCE (12-PATTERNS guidance).
- **Esc + scrim click close.** Info modal is not a legal-gate — there's no acceptance to record. Locking the user inside would invite confused "what is this modal doing" reports.
- **Terms / Privacy rows reuse existing sei.gg allowlist (no new allowlist work).** Only the DMCA row hits `dmca.copyright.gov` + `mailto:` which 12-17 unlocks. Terms/Privacy buttons therefore work TODAY without 12-17 — graceful degradation: 2/3 LEGAL rows fully functional pre-12-17.

## Deviations from Plan

None — plan executed exactly as written. Two minor refinements made within the plan's "Claude's Discretion" / "Pitfalls" guidance scope:

- Used the project's `<Button>` component (with `kind="ghost"` / `kind="accent"`) instead of raw `<button>` elements with custom `.linkBtn` / `.closeBtn` CSS classes the plan sketched. Visual consistency with every other modal in `src/renderer/src/components/` — the plan's `.linkBtn` / `.closeBtn` rules are unnecessary because `<Button>` already renders the same primitives. CSS module drops three rules but is otherwise identical to the plan sketch.
- CSS `.details dt` styled as uppercase 11px monospace label (matching `SettingsScreen.module.css:30 .sectionTitle` idiom) rather than the plan sketch's 0.85rem secondary text. Stronger visual hierarchy between agent-field labels and agent-field values; consistent with how SettingsScreen labels other key/value rows.

Both refinements fall under "match the existing project visual vocabulary" — no behavior change.

## Threat Surface Scan

- T-12-14-01 (URL allowlist bypass via openExternal): mitigated by main-process URL-allowlist at `src/main/ipc.ts:947`. Plan 12-17 extends the allowlist with `dmca.copyright.gov` (https) + `mailto:` scheme. Until then, the two modal helper buttons throw at runtime — confirmed inert, not bypassed. No new threat surface introduced.
- T-12-14-02 (Misleading placeholder text): mitigated by explicit `[Designated Agent — pending registration]` copy — never says "Sei LLC" or similar concrete-but-wrong label that could fool a tester into mailing a real DMCA notice to nowhere.
- T-12-14-03 (Renderer tampering of `AGENT_EMAIL`): accept disposition holds — constants are static, renderer tamper doesn't change main-process `shell.openExternal` behaviour; mailto: opens the user's MUA pre-filled with whatever string the renderer passed, but main's allowlist (post-12-17) only accepts `mailto:` scheme — the user still sees the To: address in their own MUA before sending.

No new threat surface flagged for the verifier.

## Issues Encountered

- Vitest run picks up the Deno-only `supabase/functions/submit-report/index.test.ts` and fails on `jsr:@std/assert@1` import — pre-existing failure dating back to plan 12-05; documented in STATE.md as out-of-scope per SCOPE BOUNDARY. 19/19 JS/TS test suites pass (155 tests). `npx tsc --noEmit -p tsconfig.web.json` clean.

## Dependency Note for Operator

Plan 12-14 carries `depends_on: [12-17]` but 12-17 has NOT yet been executed at the time of this plan's completion (planning order put 12-17 first in Wave 4, but the user invoked 12-14 directly). This is operationally safe:

- **Compile/type-check time:** the modal compiles cleanly. No code-level dependency on 12-17's allowlist edit.
- **Runtime — Terms / Privacy rows:** fully functional (sei.gg already allowlisted from Phase 11).
- **Runtime — DMCA row "Open" button → modal opens fine.** The modal then renders the placeholder template; clicking "Open Directory listing" or "Email DMCA agent" throws inside `app:open-external` because `dmca.copyright.gov` and `mailto:` aren't in the allowlist yet. Renderer treats throws as silent no-ops per the existing pattern at `src/main/ipc.ts:947-955` comment.

**Recommended next plan to execute: 12-17** (one-line allowlist edit in `src/main/ipc.ts`) — unblocks the two modal helper buttons.

## Next Phase Readiness

- DMCA contact surface (a) live and ready for registration data swap.
- Surfaces (b) — `../sei-website/terms.html` §7 DMCA Notices — pending (separate website repo plan).
- Surfaces (c) — `../sei-website/privacy.html` cross-ref to Terms §7 — pending (separate website repo plan).
- 12-17 allowlist extension is the immediate next plan recommended; 12-18 (constants swap) gates on actual dmca.copyright.gov registration completion.

## Self-Check: PASSED

- `src/renderer/src/components/DmcaContactModal.tsx`: FOUND
- `src/renderer/src/components/DmcaContactModal.module.css`: FOUND
- `src/renderer/src/screens/SettingsScreen.tsx`: FOUND (modified)
- Commit cd91baa: FOUND
- Commit 8cc0764: FOUND
- `npx tsc --noEmit -p tsconfig.web.json`: clean
- Task 1 grep verify: 11 matches (threshold ≥ 3): PASS
- Task 2 grep verify: 9 matches (threshold ≥ 3): PASS

---
*Phase: 12-character-sharing-ui-moderation*
*Plan: 14*
*Completed: 2026-05-22*
