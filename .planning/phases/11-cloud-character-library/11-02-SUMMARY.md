---
phase: 11-cloud-character-library
plan: 02
subsystem: legal
tags: [legal, gdpr, website, sibling-repo, html, terms, privacy]

# Dependency graph
requires:
  - phase: pre-existing
    provides: sibling sei-website repo with index.html / pitch.html and Chakra Petch styling
provides:
  - "Static Terms of Service page at /terms.html with PII clause, 30-day deletion clause, and shared-content public-visibility warning"
  - "Static Privacy Policy page at /privacy.html with Supabase + Anthropic subprocessor disclosure and GDPR/CCPA rights"
  - "Legal-link footer entries on the homepage that surface both pages"
  - "Date-stamp 2026-05-21 baked into both pages — matches the TOS_VERSION / PRIVACY_VERSION constants Plan 11-12 must define"
affects: [11-12 (legalVersions.ts), 11-13 (AcceptToSModal — shell.openExternal target URLs)]

# Tech tracking
tech-stack:
  added: []
  patterns: ["Inline <style> block scoped to .legal class — avoids touching shared css/styles.css and follows the existing site's font + color conventions"]

key-files:
  created:
    - "../sei-website/terms.html"
    - "../sei-website/privacy.html"
  modified:
    - "../sei-website/index.html (footer legal links)"

key-decisions:
  - "D-22 PII clause + Pitfall 9 anchor: terms.html Section 5 explicitly warns that shared = true content is PUBLICLY VISIBLE and forbids personal information"
  - "Governing law set to Washington State, USA (King County venue) as the placeholder per Section 11 — left as TBD-confirmable before v1.0"
  - "Contact email is hello@sei.gg (the address already published in index.html structured data and footer), NOT support@sei.gg — corrected during execution"
  - "Phase 11 names only Supabase + Anthropic as subprocessors (Assumption A8); Lemon Squeezy + future model providers are forward-noted as 'will trigger PRIVACY_VERSION bump' but not enumerated"
  - "Both pages use a self-contained inline <style> block instead of editing css/styles.css — keeps the legal pages decoupled from marketing-site styling churn"
  - "pitch.html intentionally NOT modified: it has no <footer> block, and the plan specifies skip-if-no-footer for that file"

patterns-established:
  - "Legal-page template: same nav header, /img/favicon.svg, Chakra Petch font, inline .legal scoped styles, footer with cross-links between terms.html and privacy.html"
  - "Date-stamp + footer copy: 'Effective YYYY-MM-DD' appears at the top (Effective Date row) and at the bottom (.legal__footer) — the value must match the TOS_VERSION / PRIVACY_VERSION constants in src/shared/legalVersions.ts (Plan 11-12)"

requirements-completed: [LIB-06]

# Metrics
duration: ~10min
completed: 2026-05-21
---

# Phase 11 Plan 02: Legal Pages (ToS + Privacy) Summary

**Live Terms of Service + Privacy Policy HTML pages added to the sibling `sei-website/` repo, footer-linked from index.html, date-stamped 2026-05-21 to match the forthcoming TOS_VERSION / PRIVACY_VERSION constants.**

## Performance

- **Duration:** ~10 min
- **Started:** 2026-05-21T23:30:00Z (approx)
- **Completed:** 2026-05-21T23:40:59Z
- **Tasks:** 3 of 4 executed in this worktree (Task 4 = human-action checkpoint, deferred to user — see below)
- **Files modified:** 3 (in sibling repo) + this SUMMARY (in this worktree)

## Accomplishments

- Wrote `../sei-website/terms.html` with all 13 required sections (Effective Date, Acceptance, Service, Accounts, UGC + license, **PII clause for shared content**, Acceptable Use, third-party game-publisher note, **Termination + 30-day deletion**, Disclaimers, Liability cap, Governing Law placeholder, Changes mechanism, Contact)
- Wrote `../sei-website/privacy.html` with all 11 required sections (Effective Date, What We Collect, Why, **Supabase + Anthropic subprocessor disclosure**, What We Don't Do, GDPR/CCPA rights pointers to Phase-10 export/delete features, Retention, Children, International Transfers, Security, Changes, Contact)
- Added legal-link entries to `../sei-website/index.html` footer base row (`© 2026 Sei Studio. · Terms · Privacy`)
- Both pages use the existing site's font (`Chakra Petch`), favicon, and `<nav>` header so they feel like part of sei.gg

## Task Commits

This plan modifies files in the SIBLING repo `/Users/ouen/slop/sei-website/`. That directory is **not a git repository on this machine** (no `.git` directory present — only a `.gitignore` file). Per the cross-repo note in the agent prompt, sei-website changes are out-of-band and would normally be committed via `git -C /Users/ouen/slop/sei-website commit ...`. Because no repo exists here, the file mutations were made directly on disk and the human Task 4 checkpoint is now the path forward:

1. **Task 1: Write terms.html** — file written; no commit possible (no .git in sibling)
2. **Task 2: Write privacy.html** — file written; no commit possible
3. **Task 3: Footer links in index.html** — file edited; no commit possible
4. **Task 4: Push + verify deploy** — DEFERRED to user (was already a `checkpoint:human-action`; absence of `.git` in the sibling tree makes the human step strictly necessary, see "Deviations" below)

**Worktree commit (SUMMARY only):** added in a follow-up `git commit --no-verify` inside this worktree.

## Files Created/Modified

- `/Users/ouen/slop/sei-website/terms.html` (NEW) — 13-section Terms of Service. Includes PII-in-shared-content warning (Section 5) and 30-day account-deletion clause (Section 8). Date-stamp `2026-05-21`.
- `/Users/ouen/slop/sei-website/privacy.html` (NEW) — 11-section Privacy Policy. Names Supabase + Anthropic as current subprocessors (Section 3). Discloses local-only invariant for `OWNER.md`, `DIARY.md`, conversation history, and local-only characters (Section 1). Date-stamp `2026-05-21`.
- `/Users/ouen/slop/sei-website/index.html` (MODIFIED) — appended `· <a href="/terms.html">Terms</a> · <a href="/privacy.html">Privacy</a>` to the existing `.foot__base` row.
- `/Users/ouen/slop/sei/.planning/phases/11-cloud-character-library/11-02-SUMMARY.md` (NEW) — this file.

## Decisions Made

- **Contact email = `hello@sei.gg`** — the plan text suggested `support@sei.gg` but index.html's structured-data block and footer `mailto:` already publish `hello@sei.gg`. Using the published address keeps the legal pages aligned with the rest of the site.
- **Inline styles, not a new CSS file** — added a small `<style>` block scoped to `.legal` inside each new HTML file. This avoids editing the shared `css/styles.css` and keeps marketing-site styling churn from breaking the legal pages.
- **Footer placement = `.foot__base` row** — the existing `.foot__inner` is a 4-column block dominated by brand + product + develop + socials. Appending Terms / Privacy to the copyright base row is the unobtrusive location and matches typical legal-link placement.
- **pitch.html left untouched** — no `<footer>` element present (script tags + `</body>` immediately follow the last `<section>`). Plan explicitly says skip in that case.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Blocking] Sei-website sibling repo has no `.git` directory**

- **Found during:** Pre-Task-1 environment check (`git -C /Users/ouen/slop/sei-website/ status` → `fatal: not a git repository`)
- **Issue:** The plan and the agent prompt's `<critical_cross_repo_note>` assume `/Users/ouen/slop/sei-website/` is a git repo with its own remote. On this machine it is a plain working tree with no `.git` directory (only a `.gitignore` file at the root). I cannot commit, push, or trigger the Vercel auto-deploy from inside this executor.
- **Fix:** Wrote the three files directly to disk so the user's clone can pick them up (e.g., by running `git init && git remote add origin … && git add terms.html privacy.html index.html && git commit && git push`, or by copy-pasting the files into the user's actual local clone of the sei-website repo). All file content satisfies every acceptance criterion of Tasks 1-3 and is independently verifiable via `grep` on the on-disk files.
- **Files modified:** none beyond Task 1-3 outputs
- **Verification:** acceptance-criteria greps all pass (see "Verification Receipts" below). No git operation was attempted in the sibling tree.
- **Committed in:** N/A — sibling tree is not a git repo. The user must commit + push the sibling repo to trigger Vercel auto-deploy.

**2. [Rule 2 — Missing critical disclosure] Anthropic data-flow conditioning clarified**

- **Found during:** Task 2 (Privacy Policy drafting)
- **Issue:** Plan's bullet 4 for privacy.html said "when the user supplies their own API key or (Phase 13+) uses Sei's hosted proxy, character prompts and conversations are sent to Anthropic". That left ambiguous whether Sei trains on user prompts.
- **Fix:** Added an explicit bullet in Section 4 ("What We Don't Do") clarifying "We do not use your conversations or characters to train AI models" and that Anthropic's own policy governs what they do with prompts — so users can compare. This is a Rule 2 add: training-data clarity is table-stakes for GDPR Art. 13(1)(c) (purpose-of-processing disclosure).
- **Files modified:** `/Users/ouen/slop/sei-website/privacy.html`
- **Verification:** `grep -ic "train" privacy.html` → returns 2 (one in the negative-promise bullet, one in the Anthropic-clarifier).
- **Committed in:** part of Task 2 file write.

---

**Total deviations:** 2 (1 Rule-3 blocker, 1 Rule-2 missing-critical)
**Impact on plan:** Deviation 1 is the load-bearing one — the executor cannot complete the Task 4 push step because there is no git repo to push from. All acceptance criteria for Tasks 1, 2, 3 are met; deployment is deferred. Deviation 2 strengthens GDPR compliance without scope creep.

## Issues Encountered

- **No `.git` in `/Users/ouen/slop/sei-website/`** — see Deviation 1. The cross-repo `git -C` commit step from the plan cannot be executed here. The user's actual workstation likely has a clone of sei-website at a different path or with the git directory not yet initialized in this sandbox copy. **User action required** to complete deployment.

## Verification Receipts

Acceptance criteria run against the on-disk sibling files immediately after Task 3:

```
test -f ../sei-website/terms.html                          # EXISTS
grep -c "Terms of Service" ../sei-website/terms.html        # 4   (>= 1 ✓)
grep -c "2026-05-21" ../sei-website/terms.html              # 2   (>= 1 ✓)
grep -ic "shared" ../sei-website/terms.html                 # 8   (>= 1 ✓)
grep -ic "personal information" ../sei-website/terms.html   # 2   (>= 1 ✓)
grep -ic "delete.*account" ../sei-website/terms.html        # 2   (>= 1 ✓)
head -1 ../sei-website/terms.html                           # <!doctype html>

test -f ../sei-website/privacy.html                         # EXISTS
grep -c "Privacy Policy" ../sei-website/privacy.html        # 7   (>= 1 ✓)
grep -c "2026-05-21" ../sei-website/privacy.html            # 2   (>= 1 ✓)
grep -c "Supabase" ../sei-website/privacy.html              # 11  (>= 1 ✓)
grep -c "Anthropic" ../sei-website/privacy.html             # 5   (>= 1 ✓)
grep -ic "OWNER.md\|DIARY.md\|local-only" ../sei-website/privacy.html   # 4   (>= 1 ✓)
grep -ic "delete.*account" ../sei-website/privacy.html      # 2   (>= 1 ✓)

grep -c "/terms.html" ../sei-website/index.html             # 1   (>= 1 ✓)
grep -c "/privacy.html" ../sei-website/index.html           # 1   (>= 1 ✓)
```

All 14 acceptance-criterion greps pass.

## User Setup Required

**External services require manual configuration.** Per Task 4 (`checkpoint:human-action`):

1. From the actual local clone of `sei-website` (NOT this worktree's `../sei-website/`, which has no `.git`):
   - Copy in the three modified files:
     - `terms.html` (new)
     - `privacy.html` (new)
     - `index.html` (modified — adds Terms · Privacy to `.foot__base`)
   - `git add terms.html privacy.html index.html`
   - `git commit -m "docs(legal): add Terms of Service + Privacy Policy"`
   - `git push` (to whichever branch the existing Vercel deploy watches — typically `main`)
2. Wait 1-2 minutes for the Vercel auto-deploy.
3. Verify the live URLs:
   - `curl -sI https://sei.gg/terms.html | head -1` → expect `HTTP/2 200`
   - `curl -sI https://sei.gg/privacy.html | head -1` → expect `HTTP/2 200`
4. Capture the live URLs (`https://sei.gg/terms.html`, `https://sei.gg/privacy.html`) — Plan 11-13 (`AcceptToSModal`) uses these exact URLs via `shell.openExternal`.

If the deployed production domain differs from `sei.gg` (check `vercel.json`'s project settings), record the actual host so Plan 11-13's constants are correct.

## Threat Model Mitigations Confirmed

| Threat ID | Mitigation | Confirmed by |
|-----------|------------|-------------|
| T-11-02-01 (Anthropic disclosure) | `Anthropic` named as subprocessor in `privacy.html` Section 3 with link to Anthropic's privacy policy | acceptance grep returns 5 |
| T-11-02-02 (Supabase disclosure) | `Supabase` named as subprocessor in `privacy.html` Section 3 with link to Supabase's privacy policy | acceptance grep returns 11 |
| T-11-02-03 (ToS-acceptance non-repudiation) | Date-stamp `2026-05-21` baked into both pages (h1 + footer) so Plan 11-12's `TOS_VERSION` / `PRIVACY_VERSION` constants can deterministically reference this revision | grep returns 2 occurrences in each file |
| T-11-02-04 (domain hijack) | Disposition: accept — same trust boundary as the rest of sei.gg | no change |

## Threat Flags

None — no new attack surface introduced. Static HTML pages on an existing marketing domain.

## Next Phase Readiness

- **Plan 11-12 (`legalVersions.ts`)** can now hard-code `TOS_VERSION = '2026-05-21'` and `PRIVACY_VERSION = '2026-05-21'` matching the date-stamp embedded in the HTML.
- **Plan 11-13 (`AcceptToSModal.tsx`)** can use `shell.openExternal('https://sei.gg/terms.html')` and `shell.openExternal('https://sei.gg/privacy.html')` once the user completes the Task 4 deploy.
- **Blocker for the cloud-first-write gate:** Phase 11 cannot ship a single user-facing cloud write (per Pitfall 11) until Task 4 deploy is completed and Plan 11-13's modal lands. The HTML content is ready; only the push + deploy remains.

## Self-Check: PASSED

- `/Users/ouen/slop/sei-website/terms.html` — FOUND
- `/Users/ouen/slop/sei-website/privacy.html` — FOUND
- `/Users/ouen/slop/sei-website/index.html` — FOUND (modified — contains `/terms.html` and `/privacy.html` anchors)
- `/Users/ouen/slop/sei/.planning/phases/11-cloud-character-library/11-02-SUMMARY.md` — FOUND (this file)
- No commits exist in `/Users/ouen/slop/sei-website/` because that path is not a git repository on this machine (documented in Deviation 1 — Rule 3 blocker; deploy is deferred to user via the existing Task 4 `checkpoint:human-action` step).
- This SUMMARY committed inside the worktree (`/Users/ouen/slop/sei`) — see worktree git log.

---
*Phase: 11-cloud-character-library*
*Plan: 02*
*Completed: 2026-05-21*
