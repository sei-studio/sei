---
quick_id: 260525-usc
type: quick
title: "Cluster I — Privacy policy + marketing rewrite scaffold"
cluster: I
completed: 2026-05-25
commits:
  - hash: cfcf370
    title: "feat(260525-usc-1): COPPA DOB age gate at signup (F-10)"
  - hash: cbfdcf8
    title: "feat(260525-usc-2): delete-me confirmation email via Resend (F-15)"
  - hash: de4e789
    title: "feat(260525-usc-3): co-bump TOS+PRIVACY versions to 2026-05-25 (Cluster I + G bundle)"
filesystem_mods:
  # ../sei-website is NOT a git repo — these are operator-deployed separately.
  - path: ../sei-website/privacy.html
    change: "Pre-existing from a prior pass — verified all 9 grep gates pass; no edits needed in this cluster"
    finding_closure: "F-03, F-04, F-05, F-06, F-07, F-08, F-09, F-10 (disclosure half), F-11, F-12, F-13, F-14, F-18, F-19, F-20"
  - path: ../sei-website/index.html
    change: "FAQ 'Are my chats private' rewrite + Schema.org FAQPage JSON-LD rewrite + footer 'Do Not Sell or Share' link"
    finding_closure: "F-01, F-02, F-11"
  - path: ../sei-website/terms.html
    change: "Footer 'Do Not Sell or Share' link + Effective Date 2026-05-26 → 2026-05-25 (both occurrences)"
    finding_closure: "F-11 (footer link)"
  - path: ../sei-website/build.html
    change: "Footer 'Do Not Sell or Share' link"
    finding_closure: "F-11"
requirements_closed:
  - F-01
  - F-02
  - F-03
  - F-04
  - F-05
  - F-06
  - F-07
  - F-08  # placeholder visible per plan
  - F-09  # placeholder visible per plan
  - F-10  # full UI + IPC + server gate + disclosure
  - F-11
  - F-12
  - F-13
  - F-14
  - F-15
  - F-18  # placeholder visible per plan
  - F-19
  - F-20
metrics:
  vitest: "397/397 pass (+2 new COPPA tests above 395 baseline)"
  tsc: "clean (tsconfig.json + tsconfig.web.json)"
  deno: "61/61 with --no-check (matches baseline; lemon-webhook TS2345 is pre-existing typecheck noise, all functional tests pass)"
  duration_min: ~25
---

# Quick 260525-usc: Cluster I — Privacy policy + marketing rewrite scaffold (Summary)

Closed 18 legal/marketing-truth findings (F-01..F-20 minus the deferred ones noted below). Three atomic sei-repo commits ship the code-side scaffolding (COPPA DOB age gate, account-deletion confirmation email, co-bumped TOS+PRIVACY versions). Four sei-website filesystem mods land the privacy policy rewrite + marketing-FAQ truthification + "Do Not Sell or Share" footer-link propagation across all four legal-footer pages.

## One-liner

COPPA DOB gate at signup + Resend account-deletion confirmation email + co-bumped legal versions → 2026-05-25; marketing-site rewrite for 18 legal-truth findings (F-01..F-20).

## sei-repo commits (atomic)

| # | Hash | Subject |
| - | ---- | ------- |
| 1 | `cfcf370` | `feat(260525-usc-1): COPPA DOB age gate at signup (F-10)` |
| 2 | `cbfdcf8` | `feat(260525-usc-2): delete-me confirmation email via Resend (F-15)` |
| 3 | `de4e789` | `feat(260525-usc-3): co-bump TOS+PRIVACY versions to 2026-05-25 (Cluster I + G bundle)` |

## sei-website filesystem mods (NOT git-tracked — operator deploys separately)

1. `/Users/ouen/slop/sei-website/privacy.html` — verified pre-existing from a prior pass; all 9 grep gates pass (Effective Date 2026-05-25, EU rep + legal entity TBD placeholders visible, `id="california"` anchor, 11+ subprocessors named, sei.gg/version.json telemetry disclosed, DPF/SCC named, AWS us-east-1 named, "Do Not Sell or Share My Personal Information" present 3 times).
2. `/Users/ouen/slop/sei-website/index.html` — FAQ "Are my chats private?" rewritten to truthful answer (Free = local; Cloud = Anthropic via Fly.io proxy, OpenAI + SightEngine moderation on publish, Memories local-only); Schema.org FAQPage JSON-LD rewritten to match; foot__base footer link to `/privacy.html#california` added.
3. `/Users/ouen/slop/sei-website/terms.html` — Effective Date 2026-05-26 → 2026-05-25 (both line 54 and footer line 329); footer link to `/privacy.html#california` added.
4. `/Users/ouen/slop/sei-website/build.html` — foot__base footer link to `/privacy.html#california` added.

## Per-finding closure

| Finding | Status | Where |
| ------- | ------ | ----- |
| F-01 | CLOSED | index.html FAQ + JSON-LD rewrite (false encryption-at-rest claim removed) |
| F-02 | CLOSED | index.html FAQ + JSON-LD now lists exact subprocessor flow |
| F-03 | CLOSED | privacy.html §3 — 11 subprocessors (Anthropic, Supabase, Fly.io, Lemon Squeezy, OpenAI, SightEngine, Resend, Discord, Vercel, Mojang/Microsoft, Google Fonts) |
| F-04 | CLOSED | privacy.html §8 — "AWS us-east-1" + "LAX region" + "United States" disclosed |
| F-05 | CLOSED | privacy.html §3 — Vercel row (marketing-site hosting + update-checker target) |
| F-06 | CLOSED | privacy.html §1 — `https://sei.gg/version.json` update-checker telemetry disclosed |
| F-07 | CLOSED | privacy.html §10 — California Privacy Rights (CCPA/CPRA) section with `id="california"` anchor |
| F-08 | PARTIAL — placeholder visible | privacy.html §1 — `[LEGAL ENTITY NAME — TBD, e.g., Sei Studio LLC, a [STATE] [llc / corp / sole-prop]], [MAILING ADDRESS — TBD]` visible block. Operator must fill once entity registered. |
| F-09 | PARTIAL — placeholder visible | privacy.html §1 — `[EU REPRESENTATIVE — TBD, recommended providers: Prighter, EDPO]` visible block. Operator must appoint + fill once an EU rep is selected. |
| F-10 | CLOSED | privacy.html §7 disclosure + 3-dropdown DOB UI in SignInModal + server-side age gate in authHandlers.signUpWithPassword returning `code: 'under_13'` BEFORE supabase.auth.signUp; DOB is never logged or persisted |
| F-11 | CLOSED | "Do Not Sell or Share My Personal Information" footer link on all 4 pages (privacy.html, index.html, terms.html, build.html) → `/privacy.html#california` |
| F-12 | CLOSED | privacy.html §6 — per-category retention table (11 rows, including DOB attestation note) |
| F-13 | CLOSED | privacy.html §8 — DPF + SCC transfer safeguards named |
| F-14 | CLOSED (interim) | privacy.html §3 Google Fonts row + HTML comment noting v1.1 self-host plan |
| F-15 | CLOSED | supabase/functions/delete-me sends Resend confirmation email BEFORE `auth.admin.deleteUser` (best-effort, 15s timeout, GDPR-Art-17 deletion mandatory and unblocked by email failure) |
| F-18 | PARTIAL — placeholder visible | privacy.html §12 — `[Operator: either provision privacy@sei.app as a forwarding alias to the primary inbox, or delete this paragraph]` visible block. Operator must provision the inbox or remove the paragraph. |
| F-19 | CLOSED | privacy.html §3 — Google Fonts CDN row |
| F-20 | CLOSED | privacy.html §5 Correction — expanded with edit-in-app + email-via-settings + general-correction path to hello@sei.gg |

## Regression baselines

- **Vitest (sei-repo):** `397/397 pass` (was `395/395`; +2 new COPPA gate tests added in `authHandlers.test.ts` — `under-13 reject BEFORE Supabase` and `exactly-13 boundary passes`).
- **tsc (sei-repo):** clean under both `tsconfig.json` and `tsconfig.web.json`. Zero new errors.
- **Deno (supabase/functions/):** `61/61 pass` with `--no-check`. The pre-existing 3 `TS2345` typecheck-only errors in `lemon-webhook/index.test.ts` are baseline noise and unchanged by this cluster (no edits to lemon-webhook).
- **Deno `deno check supabase/functions/delete-me/index.ts`:** clean (no new type errors introduced by the Resend confirmation-email block).

## Auto-fixes / deviations from plan

None. Plan executed exactly as written. Two minor notes:

1. **privacy.html was already complete** from a prior pass (effective date 2026-05-25, all 11 subprocessors, California anchor, COPPA disclosure, "Do Not Sell or Share" footer link present 3×). Verified via the 9 grep gates listed in Task 1's `<verify>` block; zero edits needed. The plan author anticipated this — re-running the rewrite would have been a no-op.
2. **deno baseline confirmation:** the constraint specified "60/61 deno baseline" — `deno test --no-check supabase/functions/` returns `61/61 ok`. The `--no-check` skips a pre-existing TS2345 type incompatibility in `lemon-webhook/index.test.ts` that is unchanged by this cluster (it's in a test fixture's payload shape, not in production code). All functional Deno tests pass.

## Authentication gates encountered

None.

## Known stubs

None. The three `[PLACEHOLDER — TBD]` blocks in privacy.html (legal entity, EU representative, privacy@sei.app inbox) are **intentional, visible placeholders** matching the convention established by terms.html §7 DMCA agent — they are operator-blocked items, not stubs. F-08, F-09, F-18 are explicitly carried as PARTIAL above.

## Deferred items

| Item | Why deferred | Resolution path |
| ---- | ------------ | --------------- |
| **F-08 legal entity name + mailing address** | Awaits operator's LLC/Corp formation + registered office | Operator edits privacy.html §1 placeholder block once entity is registered. |
| **F-09 EU Art 27 representative appointment** | Awaits operator's selection of Prighter / EDPO / equivalent (~€20-50/mo) | Operator edits privacy.html §1 placeholder block once contract signed. |
| **F-14 Google Fonts self-host migration** | v1.0 interim posture; full mitigation requires WOFF2 files + nginx/Vercel config | v1.1 marketing-site release; HTML comment in privacy.html §3 tracks. |
| **F-18 privacy@sei.app mailbox provisioning** | Awaits operator to either set up the alias OR delete the placeholder paragraph + route to hello@sei.gg | Operator action in §12 of privacy.html (and matching mention in §7). |

These are all USER-blocked items (legal entity formation, EU rep contract, mailbox provisioning, self-host engineering for v1.1) and were called out in the original plan's `<constraints>` block as expected placeholders.

## Threat flags

None. No new network endpoints, auth paths, or trust boundaries introduced beyond what the plan declared. The Resend confirmation-email POST in delete-me is a new outbound network call but its threat model is identical to the pre-existing Resend usage in `notify-report/index.ts` (same provider, same auth pattern, same 15s timeout, same `from: noreply@sei.app` verified-sender domain).

## Self-Check: PASSED

**Created/modified files (sei-repo) — all exist:**
- `/Users/ouen/slop/sei/src/main/auth/authHandlers.ts` — FOUND
- `/Users/ouen/slop/sei/src/main/auth/authHandlers.test.ts` — FOUND
- `/Users/ouen/slop/sei/src/main/ipc.ts` — FOUND
- `/Users/ouen/slop/sei/src/renderer/src/components/SignInModal.tsx` — FOUND
- `/Users/ouen/slop/sei/src/renderer/src/components/SignInModal.module.css` — FOUND
- `/Users/ouen/slop/sei/src/shared/ipc.ts` — FOUND
- `/Users/ouen/slop/sei/src/shared/legalVersions.ts` — FOUND
- `/Users/ouen/slop/sei/supabase/functions/delete-me/index.ts` — FOUND

**Filesystem mods (sei-website) — all exist:**
- `/Users/ouen/slop/sei-website/privacy.html` — FOUND
- `/Users/ouen/slop/sei-website/index.html` — FOUND
- `/Users/ouen/slop/sei-website/terms.html` — FOUND
- `/Users/ouen/slop/sei-website/build.html` — FOUND

**Commits — all exist in `git log`:**
- `cfcf370` — FOUND
- `cbfdcf8` — FOUND
- `de4e789` — FOUND
