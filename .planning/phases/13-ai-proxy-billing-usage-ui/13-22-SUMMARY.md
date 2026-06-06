---
phase: 13
plan: 22
subsystem: legal
tags: [legal, terms-of-service, refund-policy, accept-tos-modal, tos-version-bump, proxy-12]
requires: [11-02, 12-15]
provides: [PROXY-12]
affects: [AcceptToSModal, tosGate]
tech_stack:
  added: []
  patterns:
    - "Legal-version co-bump: terms.html + privacy.html Effective Date + TOS_VERSION + PRIVACY_VERSION all advance to the same date string in one cycle (single AcceptToSModal trigger)"
    - "Section renumber discipline: insert new section + monotonic shift of subsequent §N → §(N+1) + grep self-references for 'Section N' / '§N' updates"
key_files:
  created: []
  modified:
    - "../sei-website/terms.html — inserted §8 'Refunds and Cancellations' with id='refunds' anchor; renumbered §8 Third-Party → §9, §9 Termination → §10, §10 Disclaimers → §11, §11 Liability → §12, §12 Governing Law → §13, §13 Changes → §14, §14 Contact → §15; updated §4 internal cross-reference 'purged per Section 9' → 'purged per Section 10'; bumped Effective Date header + footer 2026-05-22 → 2026-05-23"
    - "../sei-website/privacy.html — bumped Effective Date header + footer 2026-05-22 → 2026-05-23 (co-bump pattern; policy text materially unchanged)"
    - "src/shared/legalVersions.ts — TOS_VERSION '2026-05-22' → '2026-05-23'; PRIVACY_VERSION '2026-05-22' → '2026-05-23'"
decisions:
  - "Refund policy framing per D-49: '14 days for unused proxied AI inference credits powered by Sei; consumed portions non-refundable' — explicitly avoids 'Anthropic API access' language so the LS dashboard product descriptions remain Lemon-Squeezy-ToS-safe (audit lives in 13-23 operator runbook)"
  - "Subscription cancellations end-of-period, NOT pro-rated — matches Lemon Squeezy's default behavior; explicit so user has no expectation gap"
  - "Refund-request inbox is dmca@sei.app (live Phase 12-15 mailbox), NOT a separate refunds@ mailbox — avoids second-mailbox provisioning cost; the dmca@sei.app domain expressly accepts compliance + refund correspondence"
  - "Section 8 is the insertion point (after §7 DMCA, before previous §8 Third-Party) rather than appending at the end — keeps commercial-terms clauses (8 Refunds, 9 Third-Party, 10 Termination, 11 Disclaimers, 12 Liability) grouped before procedural ones (13 Governing Law, 14 Changes, 15 Contact); matches reader expectation order"
metrics:
  duration: <1 hour
  completed_date: 2026-05-23
---

# Phase 13 Plan 22: Publish §8 Refunds + AcceptToSModal Re-Cycle Summary

PROXY-12 legal prerequisite landed: terms.html gains §8 Refunds and Cancellations with `id="refunds"` anchor, subsequent sections renumber §8-§14 → §9-§15, Effective Date + TOS_VERSION + PRIVACY_VERSION co-bump to 2026-05-23, triggering a single AcceptToSModal cycle for all signed-in users on next launch — clearing the legal block on the first live charge.

## What Shipped

### terms.html §8 Refunds and Cancellations (anchor `id="refunds"`)

Four-paragraph clause covering:

1. **Credit packs** — Unused proxied AI inference credits refundable within 14 days; consumed portions non-refundable. Per-D-49 framing: "proxied AI inference credits powered by Sei", NOT "Anthropic API access".
2. **Subscriptions** — Cancel any time via customer portal; access continues to end of period; no pro-rating.
3. **How to request a refund** — Email <a href="mailto:dmca@sei.app">dmca@sei.app</a>; Lemon Squeezy as Merchant of Record processes the refund.
4. **Failed transactions** — Receipt-required reconciliation path for credits-not-delivered-within-24h.

### Section renumber

| Old | New | Title |
|-----|-----|-------|
| §7 | §7 | DMCA Notices (unchanged anchor `id="dmca"`) |
| — | §8 | **Refunds and Cancellations** (new, anchor `id="refunds"`) |
| §8 | §9 | Third-Party Game Compatibility |
| §9 | §10 | Termination and Account Deletion |
| §10 | §11 | Disclaimers |
| §11 | §12 | Limitation of Liability |
| §12 | §13 | Governing Law |
| §13 | §14 | Changes to These Terms |
| §14 | §15 | Contact |

Internal cross-reference at §4 User-Generated Content (`purged per Section 9`) updated to `purged per Section 10` — the only intra-document Section/§ reference per grep. The `<code>TOS_VERSION</code>` mechanism callout at the renumbered §14 Changes still describes the modal trigger correctly (version-agnostic prose).

### Version triple co-bump

| Surface | Before | After |
|---------|--------|-------|
| `../sei-website/terms.html` Effective Date (header + footer) | 2026-05-22 | 2026-05-23 |
| `../sei-website/privacy.html` Effective Date (header + footer) | 2026-05-22 | 2026-05-23 |
| `src/shared/legalVersions.ts` `TOS_VERSION` | '2026-05-22' | '2026-05-23' |
| `src/shared/legalVersions.ts` `PRIVACY_VERSION` | '2026-05-22' | '2026-05-23' |

Per Phase 11/12 co-bump convention, TOS + PRIVACY versions advance together so signed-in users see exactly one AcceptToSModal cycle, not two consecutive prompts.

## Commits

- `a5678d8` — feat(13-22): bump TOS_VERSION + PRIVACY_VERSION to 2026-05-23 — `src/shared/legalVersions.ts`

Task 1 (terms.html) and Task 2 (privacy.html) modified files under `/Users/ouen/slop/sei-website/`, which is **not a git repository** on this machine (Phase 12-15 deviation precedent — sei-website is Vercel-managed without local git history). Those edits are persistent filesystem modifications that the operator deploys via the sei-website push step in the checkpoint. The sei-repo commit only covers `legalVersions.ts`.

## Tasks Completed

1. **Task 1: Insert §8 Refunds + renumber subsequent sections in terms.html** — sei-website filesystem edit (no sei-repo commit). 16 lines of new content + 7 `<h2>` renumbers + 1 cross-reference update + 2 Effective Date updates.
2. **Task 2: Update privacy.html Effective Date (co-bump)** — sei-website filesystem edit (no sei-repo commit). Header + footer date strings advanced; no policy-text changes.
3. **Task 3: Bump TOS_VERSION + PRIVACY_VERSION in legalVersions.ts** — committed `a5678d8`. TypeScript clean.
4. **Task 4: Checkpoint (human-verify)** — surfaced to operator (see "Human Verification Required" below). NOT auto-performed by executor per orchestrator directive.

## Verification

All plan verification gates pass:

- `grep -c 'id="refunds"' ../sei-website/terms.html` → **1** (exactly 1, passes plan threshold `== 1`)
- `grep -c "2026-05-23" ../sei-website/terms.html` → **2** (header + footer, passes plan threshold `≥ 1`)
- `grep -c "2026-05-23" ../sei-website/privacy.html` → **2** (header + footer, passes plan threshold `≥ 1`)
- `grep -E "TOS_VERSION = '2026-05-23'|PRIVACY_VERSION = '2026-05-23'" src/shared/legalVersions.ts | wc -l` → **2** (both constants, passes plan threshold `== 2`)
- `grep -c "2026-05-22" ../sei-website/terms.html` → **0** (no leftover stale date)
- `grep -c "2026-05-22" ../sei-website/privacy.html` → **0** (no leftover stale date)
- Section monotonic spot-check: §1, §2, §3, §4, §5, §6, §7 (DMCA), §8 (Refunds, new), §9, §10, §11, §12, §13, §14, §15 — strictly increasing, no gaps.
- TypeScript: `npx tsc --noEmit` clean (no output).

## Deviations from Plan

### Deviation 1 — sei-website is not a git repository on this machine (inherited from 12-15)

- **Found during:** Task 1 (about to commit terms.html edit).
- **Issue:** `/Users/ouen/slop/sei-website/` has no `.git` directory; the project is Vercel-managed without local git history. Same situation as 12-15.
- **Resolution:** Applied the edits directly to the sei-website files. The sei-repo commit covers `legalVersions.ts` alone. The two sei-website edits are documented above and inspectable via filesystem diff. The operator's checkpoint step 1 ("Push the sei-website repo changes to GitHub") handles deployment in the sei-website repo (presumably remote-tracked elsewhere or pushed via Vercel CLI).
- **Rule classification:** Workflow-level only (not Rule 1/2/3 — no code-correctness implication). Plan logic executed exactly as specified.

No code-correctness deviations. No auto-fixes. No new threats discovered.

## Human Verification Required

The plan's Task 4 is a `checkpoint:human-verify` gate. Per orchestrator directive (executor instructed to surface the checkpoint contents rather than perform the verification), the operator must run these 9 smoke steps before the BROWSE_ENABLED-style production flip:

1. **Push the sei-website repo changes to GitHub.** Operator may need to deploy to GitHub Pages / Vercel / wherever sei-website is hosted. Files modified: `/Users/ouen/slop/sei-website/terms.html`, `/Users/ouen/slop/sei-website/privacy.html`.
2. **Visit `https://sei.gg/terms.html`** and confirm §8 Refunds is visible at the §8 position with the correct text (four paragraphs: Credit packs, Subscriptions, How to request a refund, Failed transactions).
3. **Visit `https://sei.gg/terms.html#refunds`** and confirm the anchor jumps to the new section.
4. **Visit `https://sei.gg/privacy.html`** and confirm Effective Date is 2026-05-23 (both header line and footer line).
5. **Build Sei with the new legalVersions.ts** (`npm run build`) and launch a signed-in dev account.
6. **Confirm AcceptToSModal appears on launch** (the version bump from '2026-05-22' to '2026-05-23' should trigger isTosAccepted() → false → modal mounts).
7. **Confirm the modal links open the updated terms.html / privacy.html via shell.openExternal** — clicking the "Terms of Service" / "Privacy Policy" links inside the modal should open the browser to the live URLs (not local file paths or stale cached pages).
8. **Accept the new ToS in the modal; confirm it does NOT reappear on next launch.** The tos_acceptance table row for the dev user should now record tos_version='2026-05-23' and privacy_version='2026-05-23'.
9. **Sign-out + sign-in as a fresh test user; confirm onboarding flow accepts ToS at sign-up.** First-time users should see the same modal as part of the sign-up onboarding gate.

**Resume signal:** Operator types "approved" once all 9 steps pass.

**If any step fails:** Likely failure modes are (a) sei-website not deployed yet — re-push and wait for CDN cache; (b) AcceptToSModal not appearing — verify `tos_acceptance` row's stored versions don't already equal '2026-05-23' (e.g., manual seed); (c) anchor jump fails — re-verify `id="refunds"` attribute survived the deploy without HTML-escaping.

## Decisions Made

1. **D-49-compliant refund-policy language.** Wording explicitly says "proxied AI inference credits powered by Sei" — never "Anthropic API access". Aligns with the Lemon Squeezy product-description language verified manually in 13-23 operator runbook. Phase 13's CONTEXT.md D-49 makes this a hard branding/legal-language constraint to keep the LS Merchant-of-Record relationship clean.
2. **dmca@sei.app shared mailbox for refund correspondence.** Avoids second-inbox provisioning. The dmca@sei.app domain (Phase 12-15) is the operator's compliance + customer-correspondence catch-all.
3. **End-of-period subscription cancel, not pro-rated.** Matches Lemon Squeezy default behavior; documented explicitly to prevent customer expectation gap.
4. **Section 8 = Refunds insertion point.** Keeps commercial-terms group (Refunds → Third-Party → Termination → Disclaimers → Liability) before procedural-clauses group (Governing Law → Changes → Contact).
5. **Co-bump three values to the same date string.** Single AcceptToSModal cycle for users rather than two consecutive prompts (privacy bump + terms bump). Inherited from Phase 11/12 convention.

## Threat Model Disposition Status

| Threat ID | Disposition | Status |
|-----------|-------------|--------|
| T-13-22-01 (Repudiation — user denies seeing refund policy) | mitigate | Satisfied: AcceptToSModal cycle re-acceptance is the proof-of-notice gate. Recorded in `tos_acceptance` table per Phase 11. |
| T-13-22-02 (Tampering — section renumber misses internal xref) | mitigate | Satisfied: grep for `Section [0-9]+\|§[0-9]+` ran post-insert; only one internal cross-reference found (§4 → "Section 9" → "Section 10") and updated. |
| T-13-22-03 (Disclosure — dmca@sei.app inbox public) | accept | Same posture as Phase 12-15 — intentional public contact channel. |
| T-13-22-04 (Tampering — version mismatch between legalVersions.ts and Effective Date) | mitigate | Satisfied: all three surfaces (TOS_VERSION, PRIVACY_VERSION, terms.html ED, privacy.html ED) co-bumped to identical string '2026-05-23' in one execution cycle. |
| T-13-22-05 (Repudiation — refund text legally ambiguous) | accept | v1.0 risk; legal-counsel review deferred per CONTEXT §deferred. |

## Open Questions / Follow-ups

- None blocking. Plan 13-23 (operator runbook) is the deployment vehicle. Once the operator types "approved" on the 9-step smoke test, BROWSE_ENABLED-style production flip is unblocked from the legal side.

## Self-Check: PASSED

- `src/shared/legalVersions.ts` modified — FOUND.
- `../sei-website/terms.html` modified — FOUND (file persisted; not git-tracked).
- `../sei-website/privacy.html` modified — FOUND (file persisted; not git-tracked).
- Commit `a5678d8` exists — `git log --oneline --all | grep a5678d8` → FOUND.
- All five verification greps pass thresholds.
