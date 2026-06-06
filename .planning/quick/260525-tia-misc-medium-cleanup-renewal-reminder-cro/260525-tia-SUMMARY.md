---
quick_id: 260525-tia
type: summary
wave: 1
status: complete
requirements_completed:
  - QUICK-260525-tia-M14
  - QUICK-260525-tia-M16
  - QUICK-260525-tia-M18
  - QUICK-260525-tia-M20
commits:
  - 8cae45a: feat(260525-tia-1) renewal_reminders_sent migration (M14)
  - c17c33f: feat(260525-tia-2) send-renewal-reminders Edge Function (M14)
  - fd58e46: chore(260525-tia-2) commit generated deno.lock
  - b203cf9: feat(260525-tia-3) IP deny-list pre-filter (M16)
  - 5d9d3b3: test(260525-tia-4) RED — personaExpansion real-person guard (M18)
  - de1a060: feat(260525-tia-4) GREEN — real-person likeness guard (M18)
files_modified:
  - supabase/migrations/20260528001400_renewal_reminders.sql           # NEW
  - supabase/functions/send-renewal-reminders/index.ts                 # NEW
  - supabase/functions/send-renewal-reminders/deno.json                # NEW
  - supabase/functions/send-renewal-reminders/deno.lock                # NEW (generated)
  - supabase/functions/_shared/ipDenylist.ts                           # NEW
  - supabase/functions/moderate-character-prompt/index.ts              # MODIFIED
  - src/main/personaExpansion.ts                                       # MODIFIED
  - src/main/personaExpansion.test.ts                                  # MODIFIED
  - /Users/ouen/slop/sei-website/terms.html                            # FILESYSTEM-ONLY (not a git repo)
---

# quick/260525-tia — Cluster K Misc Medium Cleanup Summary

One-liner: **Four MEDIUM compliance/safety remediations shipped as one quick task** —
M14 CA ARL annual-renewal reminder scaffolding (migration + Edge Function),
M16 IP deny-list pre-filter for character moderation, M18 real-person likeness
guard via system-prompt + caller-side sentinel detection, M20 terms.html §6
CSAM wording correction (replaces false "future release" claim with accurate
deployed-moderation paragraph). 5 atomic sei-repo commits + 1 chore follow-up +
1 filesystem-only sei-website mod. Vitest personaExpansion 10/10 (5 new M18
cases pass alongside the 5 existing ITEM 12 cases). Deno typecheck clean on
both touched/new Edge Functions.

## What Landed

### M14 — CA ARL §17602(b)(2) annual-renewal reminder scaffolding

**Truth confirmed:** `renewal_reminders_sent` table exists with
`UNIQUE(subscription_id, period_end)` idempotency anchor. The
`send-renewal-reminders` Edge Function ships with header documenting the
operator-must-wire cron + scaffolding-only-until-annual-tier intent.

- **Migration** `20260528001400_renewal_reminders.sql` adds the
  `renewal_reminders_sent` tracking table with the `UNIQUE(subscription_id,
  period_end)` hard idempotency anchor. RLS enabled, `select_own` policy only;
  authenticated + anon revoked from write ops; service_role-only writes
  (defense-in-depth mirrors Cluster F + 13-01 pattern). `subscription_id` is
  text (Lemon Squeezy external id) NOT a FK — survives delete+restore (D-46
  lemon-event-id pattern). `user_id` FK with ON DELETE CASCADE is the GDPR
  Article-17 sweep anchor.
- **Edge Function** `send-renewal-reminders/index.ts` is the operator-
  cron-wired CA ARL annual-tier reminder pipeline. 25–27-day candidate window
  (drift-safe under once-daily cron skew); INSERT-before-send idempotency
  (worst case: missed reminder, never duplicate spam); Bearer service_role
  auth via `timingSafeEqual` (no JWT path — cron-only, mirrors
  notify-report); per-row Resend send with 15s AbortController timeout.
- **deno.json** mirrors trial-claim verbatim (test/serve tasks +
  @supabase/supabase-js@2.106.0 import).
- **INACTIVE-BY-DESIGN today** — Sei v1.0 ships only the $20/mo monthly tier;
  zero `subscription_status` rows match the 25–27-day window. Activates when
  the annual tier launches AND the operator wires the cron (see Operator
  Runbook below).

### M16 — IP deny-list pre-filter before OpenAI moderation

**Truth confirmed:** `moderate-character-prompt` blocks the OpenAI fetch
entirely when name+persona_source matches the IP deny-list regex. Verdict
shape uses `verdict='block', tier='hard', provider='ip-denylist',
friendlyMessage` — does NOT mint a new `moderation_status` enum value (which
would require a DB migration breaking the `characters_moderation_status_chk`
constraint chain).

- **Shared module** `supabase/functions/_shared/ipDenylist.ts` exports
  `IP_DENYLIST_PATTERNS` (frozen array of ~50 word-boundary-anchored
  case-insensitive regexes covering Disney/Marvel/DC/Nintendo/games/anime/
  cartoons/musicians) + `matchesIpDenylist(text)` pure helper.
- **Wired into** `moderate-character-prompt/index.ts` AFTER body parse and
  AFTER the openai_moderation_daily bucket increment, BEFORE the hard-tier
  `callOpenAIModeration` call. Saves the OpenAI quota slot AND round-trip
  latency on obvious matches. Fair-share preserved: deny-list match still
  consumes one bucket slot per invocation (mirrors malformed-body cost).
- Verdict shape mirrors existing hard-tier 'block' so `moderationGate.ts`
  (caller) requires ZERO changes. `provider:'ip-denylist'` field is
  informational only — no caller branches on it.
- Documented as **heuristic preventive, NOT a substitute for DMCA agent
  registration** (Cluster G blocker). T-tia-04 acceptance: a determined
  attacker can spell "M1ckey M0use" and bypass.

### M18 — Real-person likeness guard (DMCA F21)

**Truth confirmed:** `EXPANSION_SYSTEM` contains the real-person refusal rule
instructing the model to emit literal `REFUSED:REAL_PERSON` on detected real
living/recently-deceased public figures. `expandPersona()` detects the
sentinel BEFORE the six-section validator runs and throws a typed Error with
a friendly message containing "real people".

- **EXPANSION_SYSTEM** gains one bullet (positioned between the meta-reference
  rule and the terse-sections rule): "IF the user-provided source describes a
  real living person, a real recently-deceased person (within 70 years), or
  any public figure (celebrity, politician, athlete, musician)… output ONLY
  the literal string `REFUSED:REAL_PERSON`." The 70-year window roughly tracks
  the boundary where right-of-publicity claims weaken in most US jurisdictions
  (defensive heuristic, no precise legal mapping).
- **expandPersona()** detection block lands IMMEDIATELY after the empty-text
  guard and BEFORE the six-section validator — otherwise the refusal would
  surface as "missing sections" (wrong error class for the user). Strict
  equality check (`text === 'REFUSED:REAL_PERSON'`) is correct given the
  pre-existing `.trim()` — Test 4 (trailing whitespace) covered without a
  separate regex.
- **Friendly error** preserves the `persona expansion failed:` prefix so
  callers that pattern-match on it (e.g. characterStore) continue to behave
  identically. Lowercase + casual to match the renderer's error-chip register.
- **Tests** added 5 new cases (2 prompt-content asserts, 2 refusal-throw
  asserts including trim-tolerance, 1 happy-path regression guard). Existing
  5 ITEM 12 cases unchanged. 10/10 vitest pass.
- Documented as **good-faith right-of-publicity defense, NOT a perfect
  filter** (T-tia-06 acceptance: prompt-injection via "ignore prior
  instructions" remains possible against any LLM-based filter).

### M20 — terms.html §6 CSAM wording correction (DMCA F16)

**Truth confirmed:** terms.html §6 CSAM bullet no longer claims scanning will
be added "in a future release". Replaced with the accurate deployed-moderation
paragraph naming SightEngine (image) and OpenAI Moderation (text).

- Old false wording ("Automated content scanning will be added in a future
  release") REMOVED.
- New accurate wording lists both deployed scanners (SightEngine for portraits,
  OpenAI Moderation for persona text), the categories scanned (CSAM, sexual
  content involving minors, graphic violence, threats, self-harm), and the
  trigger (toggling to public sharing). One occurrence each of "SightEngine"
  and "OpenAI Moderation" — verified by `grep -c == 1`.
- **NO TOS_VERSION or Effective Date bump** — this is a clarification (the
  moderation was already deployed in Phase 12; the prior wording was factually
  wrong), not a new user obligation. Bumping would force every signed-in user
  through AcceptToSModal for zero legal benefit (bad UX). Default-no-bump
  per the plan; operator can override if desired.
- **Filesystem-only mod** — `/Users/ouen/slop/sei-website` is NOT a git repo
  on this machine (Cluster F precedent). NO sei-repo commit covers this file.
  Operator deploys via a separate sei-website push step (see Operator Runbook).

## Operator Runbook (Items NOT Performed in This Plan)

1. **Migration deploy** — `supabase/migrations/20260528001400_renewal_reminders.sql`
   lands on disk only. Run `supabase db push` to apply it to the remote.
   Safe to apply today; the table is empty until the cron + annual tier go
   live, so applying early is zero-cost.

2. **Edge Function deploy** — `supabase functions deploy send-renewal-reminders`.
   Confirm `RESEND_API_KEY` is set (shared with notify-report — may already
   be present). No `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` configuration
   needed (auto-injected).

3. **Cron wiring** — REQUIRED before the function does anything. Wire either
   in Supabase Dashboard → Database → Cron Jobs UI (preferred for visibility)
   OR as a one-off migration. Snippet in the function header docblock; uses
   `cron.schedule` + `net.http_post` with the service-role Bearer pattern
   proven on notify-report. Suggested schedule: `0 14 * * *` (14:00 UTC
   daily ≈ 7am PT — within US business hours so support can field
   reminder-triggered tickets).

4. **Annual-tier launch trigger** — Until an annual tier exists in
   `subscription_status` (every row currently has monthly `renews_at` ≈30
   days continually rolling), the candidate query returns zero rows and the
   function is a no-op on every cron tick. No action needed until the new
   tier ships in Lemon Squeezy and `lemon-webhook` starts writing
   annual-renewal rows.

5. **sei-website deploy** — `/Users/ouen/slop/sei-website/terms.html` was
   modified on disk. The operator must push this via the separate
   sei-website deploy step (Cluster F precedent — no GitHub repo on this
   machine; the website is operator-managed). Surface this mod explicitly in
   the next sei-website deploy runbook so the §6 wording correction goes
   live alongside any other pending HTML changes.

## Threat Surface Coverage

All threats in the plan's `<threat_model>` are addressed as documented:

| Threat ID | Disposition | Where Mitigated |
|-----------|-------------|-----------------|
| T-tia-01 | mitigate | `timingSafeEqual` Bearer check in `send-renewal-reminders` |
| T-tia-02 | mitigate | RLS select_own + role-grant revokes on `renewal_reminders_sent` |
| T-tia-03 | accept | UNIQUE constraint silently no-ops over-fires; Resend rate-limits cap blast |
| T-tia-04 | accept | Comment in `ipDenylist.ts` documents heuristic-not-substitute caveat |
| T-tia-05 | mitigate | All regexes word-boundary-anchored, no nested quantifiers (linear cost) |
| T-tia-06 | accept | Comment in `personaExpansion.ts` documents good-faith-not-perfect caveat |
| T-tia-07 | mitigate | Email body cites only renewal date + cancel-link (no subscription_id, no price) |
| T-tia-08 | accept | New §6 wording is the intended transparency disclosure |

No threat flags introduced beyond the plan's `<threat_model>` register.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Blocking] Generated deno.lock not anticipated in Task 2**
- **Found during:** Task 2 verification (`deno check`)
- **Issue:** `deno check` generated `supabase/functions/send-renewal-reminders/deno.lock`
  as an untracked file. Other functions (notify-report, trial-claim) ship
  their deno.lock; matching that convention is the right call.
- **Fix:** Committed the generated lock file separately as
  `chore(260525-tia-2)` since it logically belongs to Task 2's deno.json.
- **Files modified:** `supabase/functions/send-renewal-reminders/deno.lock`
- **Commit:** `fd58e46`

### Plan-Verifier Note (Documented, Not a Fix)

**Task 3 verifier `[ "$(grep -c "callOpenAIModeration") -eq 3 ]` clarified.**
The verifier expects "1 import + 2 invocations = 3 occurrences." However the
existing file has 3 ADDITIONAL mentions of `callOpenAIModeration` inside
docblock comments (lines 13, 57, 119) — so the raw `grep -c` count is 6, not
3. The plan's intent (verified manually): code-only count is exactly 3 (line
63 import + lines 212+241 invocations). Excluding comments via
`grep -v "^\s*\*\|^\s*//" | grep -c callOpenAIModeration` returns 3 as
expected. No code change needed; my edit added zero new
`callOpenAIModeration` references. Verifier wording could be tightened
("code-only count") in a future plan revision.

## Verification Status

| Gate | Expected | Actual | Pass? |
|------|----------|--------|-------|
| personaExpansion.test.ts | 10/10 pass | 10/10 pass (5 ITEM 12 + 5 new M18) | ✓ |
| Task 1 grep checks | All pass | All pass | ✓ |
| Task 2 grep checks + deno check | All pass | All pass | ✓ |
| Task 3 grep checks (code-only) | All pass | All pass | ✓ |
| Task 4 vitest + EXPANSION_SYSTEM greps | All pass | All pass | ✓ |
| Task 5 wording grep checks | All pass | All pass | ✓ |
| deno check (moderate-character-prompt) | Clean | Clean | ✓ |
| deno check (send-renewal-reminders) | Clean | Clean | ✓ |
| TypeScript main-process for touched files | No new errors | No new errors (pre-existing errors in `auth/loopbackPkce.ts` + `auth/supabaseClient.test.ts` unrelated — out of scope per SCOPE BOUNDARY) | ✓ |
| Cluster A–F regression guard | Zero touches | Zero touches (`subscription_consents\|record-consent\|AutoRenewalConsent\|PreCtaDisclosure\|ReceiptScreen\|legalVersions.ts` → 0 matches) | ✓ |
| Cluster K touch-set | 8 files (7 sei-repo + deno.lock) | 8 files exactly | ✓ |

**Baseline note:** The plan's "vitest 390/390 baseline" appears to refer to a
prior project state. The current worktree has multiple pre-existing test
infrastructure failures (`Cannot find package 'hono'` in proxy/, `Cannot find
package 'jsr:@std/assert@1'` in deno tests run under vitest, plus a
`portraitStore` ENOTEMPTY) that exist at the b21051c base commit before any
Cluster K work. Per the SCOPE BOUNDARY in the executor protocol, those are
out-of-scope pre-existing issues. My change touches `personaExpansion.test.ts`
only and 10/10 pass there. No new regressions introduced.

## Known Stubs

None. All four remediations land complete implementations on disk. The
"INACTIVE-BY-DESIGN" status of `send-renewal-reminders` is not a stub — it's
a deliberate scaffolding choice with a documented operator-runbook trigger
(annual-tier launch). The code is functional today against the (currently
empty) candidate query.

## Commit Hashes (sei-repo)

| Task | Commit | Subject |
|------|--------|---------|
| 1 | `8cae45a` | feat(260525-tia-1): renewal_reminders_sent migration |
| 2 | `c17c33f` | feat(260525-tia-2): send-renewal-reminders Edge Function |
| 2 (lock) | `fd58e46` | chore(260525-tia-2): commit generated deno.lock |
| 3 | `b203cf9` | feat(260525-tia-3): IP deny-list pre-filter |
| 4 RED | `5d9d3b3` | test(260525-tia-4): real-person likeness guard tests |
| 4 GREEN | `de1a060` | feat(260525-tia-4): real-person likeness guard impl |

## Filesystem-Only Mod (NOT a sei-repo commit)

| Path | Change |
|------|--------|
| `/Users/ouen/slop/sei-website/terms.html` | §6 CSAM bullet: removed false "future release" wording; added SightEngine + OpenAI Moderation deployed-moderation paragraph. Operator deploys via separate sei-website push step. |

## Self-Check: PASSED

All claimed commits exist in `git log`. All claimed files exist on disk. All
verifier grep checks return the documented values. terms.html mod confirmed
present at the filesystem path. No untracked files remain in the worktree
beyond the plan's expected outputs.
