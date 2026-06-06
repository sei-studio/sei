---
phase: 12-character-sharing-ui-moderation
plan: 15
subsystem: legal
tags: [dmca, terms-of-service, privacy-policy, tos-version, accept-tos-modal, legal-compliance]

# Dependency graph
requires:
  - phase: 11-auth
    provides: AcceptToSModal + tosGate version-comparison machinery + legalVersions.ts constants
  - phase: 12-character-sharing-ui-moderation
    provides: D-35a DMCA disposition (publish contact + receipt URL pre-launch)
provides:
  - terms.html §7 DMCA Notices section with id="dmca" anchor + named placeholder spans (dmca-name, dmca-address, dmca-receipt) for 12-18 to swap in real contact post-registration
  - privacy.html §11 Contact cross-reference to terms.html#dmca
  - TOS_VERSION + PRIVACY_VERSION bumped 2026-05-21 → 2026-05-22 so signed-in users see a single AcceptToSModal cycle
affects: [12-18 (DMCA registration + BROWSE_ENABLED flip), 12-16 (Browse tab launch)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Named placeholder spans (id='dmca-name' / 'dmca-address' / 'dmca-receipt') as explicit swap targets for the post-registration update — keeps 12-18 a surgical edit rather than re-flowing prose"
    - "Co-bump TOS_VERSION + PRIVACY_VERSION together so existing users absorb both legal updates in one AcceptToSModal cycle (not two consecutive prompts)"

key-files:
  created: []
  modified:
    - "src/shared/legalVersions.ts — TOS_VERSION + PRIVACY_VERSION bumped to 2026-05-22"
    - "../sei-website/terms.html — new §7 DMCA Notices, subsequent sections renumbered §7→§8 through §13→§14, effective date 2026-05-22, internal Section 8 cross-ref updated to Section 9"
    - "../sei-website/privacy.html — DMCA cross-reference appended to §11 Contact, effective date 2026-05-22"

key-decisions:
  - "Bumped BOTH TOS_VERSION and PRIVACY_VERSION to the same 2026-05-22 string even though only the Terms text changed materially — AcceptToSModal's contract uses both versions and the privacy.html Effective Date also moved, so co-bumping is honest and minimises re-prompt friction (one modal cycle, not two)"
    - "Used named placeholder spans (dmca-name / dmca-address / dmca-receipt) for the agent contact rather than inline TODO comments so 12-18 can swap real values via a precise Edit call without re-reading the surrounding paragraph"
  - "Used 'Designated Agent — pending registration' as the live placeholder text — explicit pending state vs. silent blank or fake placeholder name. Per threat T-12-15-01, the placeholder must self-identify so visitors don't mistake it for a real contact"

patterns-established:
  - "Pattern: legal-version co-bump — when ToS or Privacy materially changes, bump BOTH constants to today's date so AcceptToSModal handles both in a single re-acceptance cycle"
  - "Pattern: section renumber discipline — when inserting a numbered section, search the file for self-references (e.g., 'Section N', '§N', 'per Section X') and update them before commit"

requirements-completed: [SHARE-09]

# Metrics
duration: 3min
completed: 2026-05-22
---

# Phase 12 Plan 15: DMCA Contact Publication + Legal Version Bump Summary

**Published DMCA designated-agent placeholder at terms.html §7 with id='dmca' anchor + privacy.html cross-ref, and co-bumped TOS_VERSION + PRIVACY_VERSION to 2026-05-22 to trigger a single AcceptToSModal re-acceptance cycle for all signed-in users.**

## Performance

- **Duration:** ~3 min (131s wall-clock)
- **Started:** 2026-05-22 (UTC start ts in /tmp/plan-12-15-epoch.txt)
- **Completed:** 2026-05-22
- **Tasks:** 4 (3 auto + 1 checkpoint:human-verify auto-approved per yolo mode)
- **Files modified:** 3 (1 in sei, 2 in sei-website sibling)

## Accomplishments
- New §7 DMCA Notices section published on terms.html with named placeholder spans for 12-18 to swap in real designated-agent contact post-registration
- privacy.html §11 Contact now hash-links to terms.html#dmca, satisfying D-35a surface (b)+(c) requirement
- Both TOS_VERSION and PRIVACY_VERSION bumped to 2026-05-22 — Phase 11's tosGate.isTosAccepted will fail-closed on every signed-in user's next session, mounting AcceptToSModal exactly once for the new DMCA terms (pattern-mapper note: coordinate release with 12-18 BROWSE_ENABLED flip so users see "review new terms" + "Browse is now available" in the same session)

## Section Renumbering Map (terms.html)

| Old §N | Title                              | New §N |
|--------|------------------------------------|--------|
| —      | DMCA Notices (NEW)                 | §7     |
| §7     | Third-Party Game Compatibility     | §8     |
| §8     | Termination and Account Deletion   | §9     |
| §9     | Disclaimers                        | §10    |
| §10    | Limitation of Liability            | §11    |
| §11    | Governing Law                      | §12    |
| §12    | Changes to These Terms             | §13    |
| §13    | Contact                            | §14    |

Internal cross-reference updated: "purged per Section 8" → "purged per Section 9" (the Termination section).

## Placeholder Anchors for 12-18 Swap

When 12-18 captures the DMCA registration receipt from dmca.copyright.gov, swap these three spans in terms.html:

| Anchor                  | Placeholder text                              | 12-18 replacement                                  |
|-------------------------|------------------------------------------------|---------------------------------------------------|
| `<span id="dmca-name">`    | `[Designated Agent — pending registration]`   | Real legal name of designated agent               |
| `<span id="dmca-address">` | `[Mailing address pending registration]`      | Real mailing address                              |
| `<a id="dmca-receipt">`    | `https://dmca.copyright.gov/list`             | Specific receipt URL from registration confirmation |

Section anchor `id="dmca"` on the `<h2>` is permanent — privacy.html hashes against it.

## Task Commits

Only Task 3 produced a commit in the sei repo. Tasks 1 and 2 modified files in `/Users/ouen/slop/sei-website/`, which is NOT a git repository on this machine — those edits are tracked outside git (the user manages sei-website deploys via Vercel).

1. **Task 1: Insert §7 DMCA + renumber terms.html** — sei-website file edit (no sei-repo commit; sei-website is not git-tracked here). See "Deviations" below.
2. **Task 2: Cross-reference Terms §7 from privacy.html** — sei-website file edit (no sei-repo commit; same reason).
3. **Task 3: Bump TOS_VERSION + PRIVACY_VERSION** — `4e45a0d` (chore)
4. **Task 4: Human-verify ToS re-acceptance cycle** — auto-approved per yolo mode (no commit; checkpoint document only).

## Files Created/Modified

- **`src/shared/legalVersions.ts`** (sei) — TOS_VERSION + PRIVACY_VERSION bumped 2026-05-21 → 2026-05-22.
- **`../sei-website/terms.html`** (sei-website) — Inserted new §7 DMCA Notices with `id="dmca"` anchor and named placeholder spans (`dmca-name`, `dmca-address`, `dmca-receipt`); renumbered §7-§13 → §8-§14; updated internal cross-reference "Section 8" → "Section 9"; bumped Effective Date 2026-05-21 → 2026-05-22 (both header and footer).
- **`../sei-website/privacy.html`** (sei-website) — Appended DMCA cross-ref sentence to §11 Contact pointing to `/terms.html#dmca`; bumped Effective Date 2026-05-21 → 2026-05-22.

## Decisions Made

- **Single section-7 insertion, not a standalone §12 Copyright in privacy.html.** The plan offered both options. Chose the lighter cross-ref in §11 because privacy.html doesn't need a new top-level section for what is effectively a "see Terms" pointer — keeps privacy.html structurally stable while still satisfying D-35a surface (c). The header-effective-date bump alone signals to readers that material changed.
- **Co-bumped both legal version constants.** Even though only ToS text changed materially, bumping PRIVACY_VERSION alongside is honest (privacy.html Effective Date also moved as part of this change) AND keeps the AcceptToSModal cycle to a single user-facing prompt.
- **Placeholder agent text uses self-identifying pending markers, not blank fields.** Per threat T-12-15-01, leaving the agent name blank or filling with a real-looking value would mislead users — explicit `[Designated Agent — pending registration]` is the only acceptable placeholder until 12-18 swaps it.

## Deviations from Plan

### Deviation 1 — sei-website is not a git repository on this machine

- **Found during:** Task 1 (about to commit terms.html edit).
- **Issue:** The plan's success criteria says "the sei-website edits land as separate commits in the sibling repo," and `/Users/ouen/slop/sei` runs with `sub_repos: []` per init context — meaning `commit-to-subrepo` routing isn't configured. Inspection of `/Users/ouen/slop/sei-website/` confirmed there is no `.git/` directory; the project is Vercel-managed without local git history.
- **Resolution:** Applied the edits directly to the sei-website files (they're real, persistent file modifications visible to Vercel on next deploy). Did not attempt to `git init` the sibling repo — that's a user-level decision out of scope. The sei-repo commit covers `legalVersions.ts` alone. The two sei-website edits are documented in this SUMMARY and in the diff against the file contents the user can inspect at any time.
- **Rule:** Rule 3 (blocking issue resolution) — proceeded by applying the file edits and documenting the absence of a sibling git history rather than blocking on a repo-init request.

### Deviation 2 — Task 4 checkpoint auto-approved per yolo mode

- **Found during:** Task 4 (checkpoint:human-verify).
- **Standard executor behavior:** Stop and return a checkpoint message for the user to verify the re-acceptance cycle on a local dev build.
- **Override:** The plan-execution prompt explicitly directs: "For human-verify checkpoint: auto-approve per `mode: yolo` and document what live verification would entail in the SUMMARY."
- **What live verification would look like (deferred to user when they next launch a dev build):**
  1. Sign in to Sei on a local dev build (or use an account that previously accepted the 2026-05-21 ToS).
  2. Launch the app — `tosGate.isTosAccepted()` should fail-closed because `tos_acceptance.tos_version` ('2026-05-21') no longer matches the constant ('2026-05-22'). AcceptToSModal should mount.
  3. Click "I accept" — the modal calls `recordAcceptance(userId)`, which inserts a new row with the bumped versions; modal closes.
  4. Restart the app — AcceptToSModal should NOT reappear; acceptance is recorded against 2026-05-22.
  5. Open Settings → Legal → Terms of Service → confirm §7 DMCA Notices renders and §8-§14 numbering is sequential.
  6. Open privacy.html in a browser → §11 Contact has the DMCA cross-reference link, which when clicked jumps to the DMCA `<h2>` (via `#dmca` anchor).

**Total deviations:** 2 (1 environmental — sibling repo not git-tracked; 1 explicit user override — yolo mode auto-approval).
**Impact on plan:** No code-correctness deviations. Both deviations are workflow-level (where commits land + checkpoint approval mechanism). Plan logic executed exactly as specified.

## Issues Encountered

- `portraitStore.test.ts > removePortrait` failed with `ENOTEMPTY` during the post-edit test run, then passed on rerun. This is a pre-existing flaky-tmp-dir race entirely unrelated to legal-version changes (the test doesn't reference `TOS_VERSION` or `PRIVACY_VERSION`). Logged here for traceability; no fix attempted per scope boundary.
- `tosGate.test.ts` line 103 uses `tos_version: '2026-05-21'` as fixture row data. Inspected the mock — the `.eq()` chain captures filters but doesn't filter `selectRows`, so the test asserts "isTosAccepted returns true when supabase returns any row," which remains true regardless of the constant value. Verified test passes after the bump.

## Verification

- `grep -c 'id="dmca"\|DMCA Notices\|dmca@sei.app' ../sei-website/terms.html` → `2` (passes plan threshold `>= 2`)
- `grep -c 'terms.html#dmca\|DMCA copyright' ../sei-website/privacy.html` → `1` (passes plan threshold `>= 1`)
- `grep -c "TOS_VERSION = '2026-05-22'\|PRIVACY_VERSION = '2026-05-22'" src/shared/legalVersions.ts` → `2` (passes plan threshold `>= 2`)
- `npx tsc --noEmit` → 0 errors
- `npx vitest run` on the five tests touching `2026-05-21` strings → 47/47 unrelated assertions pass; 1 flaky-tmpdir failure unrelated to this plan, passes on rerun
- terms.html section sequence inspection — §1 through §14 contiguous and in order (verified via `grep '<h2'`)

## User Setup Required

The `user_setup` block in the plan frontmatter notes that DMCA agent registration at dmca.copyright.gov is required BEFORE 12-18 ships. That registration is the gating dependency for 12-18 (which swaps the three placeholder spans `dmca-name`/`dmca-address`/`dmca-receipt`). This plan ships the placeholders in their pending-registration form. The user is responsible for:

1. Completing the DMCA designated-agent registration eForm at https://dmca.copyright.gov before 12-18 executes.
2. Capturing the resulting receipt URL from the user account on dmca.copyright.gov.
3. Providing the receipt URL + real agent name + mailing address as inputs to 12-18, which will perform the three-span swap.

## Threat Flags

No new threat surface introduced beyond what the plan's `<threat_model>` already enumerates. The placeholder text is per-design pending-state messaging (mitigation for T-12-15-01).

## Next Phase Readiness

- 12-15 unblocks 12-18 (defense-in-depth UX gate / BROWSE_ENABLED rollout) — coordinate the release of both as a single user-facing event so signed-in users go through one AcceptToSModal cycle and emerge to find Browse newly available.
- The `id="dmca"` anchor is now permanent — 12-18 must NOT change that anchor or privacy.html's hash link breaks.
- Future ToS updates should keep the section-renumber discipline in mind: searching for `Section N` / `§N` / `per Section X` patterns BEFORE commit, not after.

## Self-Check: PASSED

- terms.html §7 DMCA section present with `id="dmca"` anchor → FOUND (`grep '<h2 id="dmca"' /Users/ouen/slop/sei-website/terms.html`)
- privacy.html cross-reference to `/terms.html#dmca` → FOUND
- src/shared/legalVersions.ts contains TOS_VERSION = '2026-05-22' and PRIVACY_VERSION = '2026-05-22' → FOUND
- Commit `4e45a0d` in `git log` → FOUND (verified below)
- Section renumbering complete and contiguous §1-§14 → FOUND

---
*Phase: 12-character-sharing-ui-moderation*
*Completed: 2026-05-22*
