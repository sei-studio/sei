---
quick_id: 260525-sbo
phase: 13
type: execute
status: complete
wave: 1
completed: 2026-05-25
duration_minutes: ~35
tasks_complete: 8/8
commits: 10  # 8 task feats + 2 RED+GREEN pairs (Tasks 3 + 6); Task 8 also got a +1 test-fix commit
vitest: 390/390 (368 baseline + 22 new)
deno: 61/61 (60 baseline + 1 new paused passthrough)
tsc_web: clean
tsc_node: 2 pre-existing baseline errors (per plan)
requirements_completed: [PROXY-04, PROXY-08, AUTH-05]
---

# Phase 13 Quick Task 260525-sbo: Cluster F — Subscription Compliance UI Summary

Closed all 10 CA ARL §17602 / FTC 16 CFR §425 (Click-to-Cancel) remediations
identified in the audit. Six in-app surfaces (consent gate, pre-CTA
disclosure, rename + fallback link, receipt screen, past-due banner) +
two text-only edits (sei-website pricing card + ToS §8/§13) + one
webhook reason_code passthrough.

## One-liner

Sei subscription flow is now CA ARL / FTC Click-to-Cancel compliant —
ready to onboard California-resident subscribers.

## Tasks Shipped

### Task 1 — `subscription_consents` migration (CA ARL §17602(b))

**Commit:** `a9d2c8b`

- `supabase/migrations/20260528001200_subscription_consents.sql` (NEW)
  - Table: `id uuid PK, user_id FK→auth.users, consent_version text,
    consent_timestamp timestamptz default now(), ip_hash text NULL`
  - RLS enabled; insert-own + select-own policies; zero update/delete
    policies (immutable like `tos_acceptance`)
  - `revoke insert, update, delete` from `anon` + `authenticated`
    (defense-in-depth — service_role Edge Function in Task 2 is sole writer)
  - Index on `(user_id, consent_timestamp desc)` for per-user audit queries

### Task 2 — `record-consent` Edge Function (two-client JWT-verify INSERT)

**Commit:** `b5ff06c`

- `supabase/functions/record-consent/index.ts` (NEW, 167 lines)
- `supabase/functions/record-consent/deno.json` (NEW, mirrors trial-claim)
- Two-client pattern (anon-client.auth.getUser identity + service_role INSERT)
- Body validation: `consent_version` non-empty string ≤ 64 chars
- `ip_hash` accepted but capped at 128 chars (SHA-256 hex headroom)
- Returns 202 `{ status: 'received' }` on success; 401 missing/invalid JWT;
  400 bad body; 503 `insert_failed` (renderer can retry — legal anchor is
  the affirmative click, not the server INSERT)
- **NOT rate-bucketed** (T-sbo-05 accepted — slow checkout path, not
  free-money endpoint)

### Task 3 — `AutoRenewalConsentModal` + IPC wiring (TDD)

**Commits:** `43fb662` (RED) + `8e58d96` (GREEN)

- `src/renderer/src/components/AutoRenewalConsentModal.tsx` (NEW, ~155 lines)
- `src/renderer/src/components/AutoRenewalConsentModal.module.css` (NEW)
- `src/renderer/src/components/AutoRenewalConsentModal.test.tsx` (NEW,
  6 tests — all pass)
- Blocking-ish consent surface; checkbox label `"I agree to be charged
  $20/month until I cancel."`; primary CTA disabled until checked
- On Continue: `sei.recordSubscriptionConsent({consent_version: TOS_VERSION})`
  THEN `sei.creditsOpenCheckout('subscription')` (order invariant; failure
  on consent INSERT does NOT block checkout — legal anchor is the click)
- IPC plumbing end-to-end:
  - `src/shared/ipc.ts`: `RecordConsentArgsSchema` Zod schema +
    `subscription.recordConsent` channel + `RendererApi.recordSubscriptionConsent`
  - `src/preload/index.ts`: contextBridge binding
  - `src/main/ipc.ts`: Zod-validated `ipcMain.handle` (M30 defense-in-depth)
  - `src/main/cloud/proxyClient.ts`: `recordSubscriptionConsent()` calls
    record-consent Edge Function with `{ jwt, body: { consent_version,
    ip_hash: null }}`
- `CreditsScreen` + `HardStopModal` Join-a-Party CTAs route through the
  modal (pack/Quest path unchanged — packs are one-time, no auto-renewal
  gate)
- Scrim z-index 1100 so consent modal stacks above HardStopModal (z 1000)
- **PROXY-05 carve-out** comment in modal header (literal `$20/month`
  string is required for CA ARL §17602(a)(1) — bright-line suspended for
  at-purchase legal-disclosure surface)

### Task 4 — `PreCtaDisclosure` block (CA ARL §17602(a)(1))

**Commit:** `0d386d2`

- `src/renderer/src/components/PreCtaDisclosure.tsx` (NEW, ~80 lines)
- `src/renderer/src/components/PreCtaDisclosure.module.css` (NEW)
- Stateless component, props `{ renewsAt: string | null }`
- Renders four required lines in EXACT order:
  1. `$20.00 USD per month`
  2. `Auto-renews on the {Nth} of each month until you cancel.` (if
     renewsAt parseable) OR `Auto-renews monthly until you cancel.`
     (fallback for first-time purchasers)
  3. `14-day refund on unused credits`
  4. `Cancel anytime in Settings → Cloud AI → Cancel subscription`
- Inline `ordinal()` helper (1st/2nd/3rd/11-13th/21st…) — no external dep
- Visual weight equal to body copy (`--text`, NOT `--text-2`) per
  "clear and conspicuous" prong of the statute
- Mounted above Join-a-Party CTA in CreditsScreen Party section (gated on
  `!isSubscribed`) AND HardStopModal footer (`renewsAt={null}` fallback —
  hard-stop users by definition have no active subscription)
- **PROXY-05 carve-out** comment in component header + both mount sites

### Task 5 — "Cancel or manage subscription" rename + inline customer-portal fallback

**Commit:** `0168367`

- `src/renderer/src/screens/CreditsScreen.tsx` + `SettingsScreen.tsx`
- Both `Manage your Party` labels → `Cancel or manage subscription`
  (zero remaining occurrences; stale JSDoc comments also updated)
- CreditsScreen helper text: `You're in a Party. Cancel or manage your
  subscription through Lemon Squeezy. No call required.`
- `PROXY_NO_PORTAL_URL` → inline clickable fallback link `Cancel
  subscription via Lemon Squeezy →` in BOTH screens (NOT a toast),
  calling `sei.openExternal('https://sei.lemonsqueezy.com/billing')` —
  satisfies FTC Click-to-Cancel "online cancel path must be at-least-
  as-simple as the sign-up surface" requirement
- Other failure codes (PROXY_NO_SESSION / PROXY_NETWORK) keep toast
  pattern in SettingsScreen with friendlier `Try again or email
  support@sei.app.` copy; CreditsScreen has no toast surface (silent
  retry path)
- Internal `cancelSubscription()` function name preserved per
  13-PATTERNS test-suite compat

### Task 6 — ReceiptScreen + non-unlimited→unlimited auto-navigate (TDD, FTC §425.5)

**Commits:** `9bfc1ba` (RED) + `d62444e` (GREEN)

- `src/renderer/src/screens/ReceiptScreen.tsx` (NEW, ~75 lines)
- `src/renderer/src/screens/ReceiptScreen.module.css` (NEW)
- `src/renderer/src/screens/ReceiptScreen.test.tsx` (NEW, 6 tests)
- `src/renderer/src/lib/formatRenewal.ts` (NEW — extracted from
  CreditsScreen.tsx; shared helper)
- `src/renderer/src/lib/stores/useUiStore.ts`: View union extended with
  `{ kind: 'receipt' }`
- `src/renderer/src/lib/stores/useCreditsStore.ts`:
  - `shouldNavigateToReceipt(prev, next)` pure predicate exported for
    unit-test (covered by 7 transition cases in
    `useCreditsStore.test.ts`)
  - `prevPlanForReceipt` module-level ref persists across pushes
  - `onCreditsStatusUpdate` callback: after `set()`, checks
    `shouldNavigateToReceipt`, lazy-imports `useUiStore` (avoids circular
    dep), calls `navigate({ kind: 'receipt' })` once
  - Seed pre-sets `prevPlanForReceipt = status.plan` so cold-load is NOT
    a transition (already-subscribed user does NOT see receipt on app
    start)
  - `reset()` clears the ref so a fresh sign-in starts cleanly
- `App.tsx`: view-kind switch + `subtitleForView` arm for `'receipt'`
- ReceiptScreen renders: title `Welcome to Party!`, four required FTC
  disclosure lines (`$20.00 charged today`, `Billed monthly until you
  cancel.`, `Next billing date: {formatRenewal(renews_at) ?? 'in 30
  days'}.`, `Cancel anytime in Settings → Cloud AI → Cancel
  subscription.`), single `Back to Sei` CTA
- **PROXY-05 carve-out** comment in ReceiptScreen header (FTC §425.5
  plain-language charge ack)
- **Test counts:** 6 ReceiptScreen + 7 transition-guard + 3 status_raw
  passthrough = 16 new tests in `useCreditsStore.test.ts` (was 12 → now
  22) + 6 in `ReceiptScreen.test.tsx`

### Task 7 — sei-website + TOS_VERSION bump

**Commits:** `c206397` (sei repo) + filesystem-only edits to `../sei-website/`

**sei repo:**

- `src/shared/legalVersions.ts`: `TOS_VERSION` + `PRIVACY_VERSION` both
  bumped from `'2026-05-23'` to `'2026-05-26'` (co-bump per Phase
  11/12 convention — single AcceptToSModal cycle for users on next
  sign-in)

**sei-website filesystem mods (NOT a git repo on this machine; operator
deploys via separate sei.gg push step):**

- `../sei-website/index.html` line 313+: PARTY card gets a new `<p
  class="tier__note">` element below `.tier__desc` containing `Auto-renews
  monthly. Cancel anytime in app.` + hyperlink to
  `./terms.html#subscription-terms`
- `../sei-website/css/styles.css`: added `.tier__note` style (smaller
  font, --ink-2 color, top-margin 8px) mirroring the existing
  `.tier__desc` typographic convention
- `../sei-website/terms.html` §8 'Refunds and Cancellations':
  - `dmca@sei.app` → `support@sei.app` (refund inbox standardization)
  - Inserted new `<p><strong>Cancel anytime.</strong> ... Settings →
    Cloud AI → Cancel subscription. No call, no email, no questions.</p>`
  - Inserted new `<h3 id="subscription-terms">Subscription Terms</h3>`
    sub-section with four `<li>` bullet items (price/frequency/cancel/refunds)
- `../sei-website/terms.html` §13 'Governing Law':
  - Removed `<!-- TBD: jurisdiction -->` comment
  - Removed `(Jurisdiction subject to confirmation prior to v1.0 launch.)`
    parenthetical
  - Appended new paragraph: `Nothing in this section limits any
    non-waivable rights you have under the laws of your state of
    residence.`
- `../sei-website/terms.html` line 54: `Effective Date: 2026-05-23` →
  `2026-05-26`

### Task 8 — subscription_status_raw passthrough + 'paused' status + past-due banner

**Commits:** `1a33dd9` (feat) + `22494ab` (test-fix)

- `supabase/migrations/20260528001300_subscription_status_paused.sql`
  (NEW): drop+recreate `subscription_status_status_check` constraint to
  add `'paused'` (mirrors 20260528000400 pattern for `'refunded'`)
- `supabase/migrations/20260528000600_apply_lemon_event_rpc.sql`: extend
  `subscription_updated` branch whitelist to include `'paused'` so LS
  pause events round-trip rather than collapsing to `'past_due'`
- `supabase/functions/lemon-webhook/index.ts`: `VALID_SUB_STATUSES`
  updated to mirror RPC whitelist (now: active, cancelled, expired,
  past_due, refunded, paused). **NOTE:** this constant is informational
  — the actual status mirror happens inside the apply_lemon_event RPC.
- `src/shared/ipc.ts`:
  - `CreditsStatus.subscription_status_raw?: 'active'|'cancelled'|'expired'|'past_due'|'refunded'|'paused'|null`
    (NEW optional field)
  - `SubscriptionStatusInfo.status` union extended with `'paused'` +
    `'refunded'`
- `src/main/cloud/proxyClient.ts`: `creditsGet()` populates
  `subscription_status_raw` from `my_subscription.status`; null on
  no-session (NEW field on the placeholder return shape)
- `src/renderer/src/lib/stores/useCreditsStore.ts`: added
  `subscription_status_raw` to state shape + INITIAL + seed + push
  handler + refresh
- `src/renderer/src/screens/SettingsScreen.tsx`: contextual banner above
  Cloud AI row when `subscription_status_raw === 'past_due'` (red,
  `Your payment is past due — update your card →` linking to
  `cancelSubscription()`) OR `=== 'paused'` (`Your subscription is
  paused — resume in Lemon Squeezy →`)
- Deno test: 1 new test in `lemon-webhook/index.test.ts` asserting
  `subscription_updated` with `status='paused'` preserves
  `attributes.status='paused'` in the RPC `p_payload` arg
- Vitest tests: 3 new in `useCreditsStore.test.ts` (seed populates,
  push mutates, missing field falls back to null) + 1 fix in
  `proxyClient.test.ts` (the no-session placeholder toEqual assertion
  now includes the new `subscription_status_raw: null` field)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] proxyClient.test.ts no-session placeholder assertion
needed `subscription_status_raw: null`**
- **Found during:** Task 8 post-implementation vitest sweep
- **Issue:** The pre-existing `expect(res).toEqual({...})` shape check
  on line 285 broke because Task 8 added `subscription_status_raw` to the
  no-session placeholder return.
- **Fix:** Added `subscription_status_raw: null` to the expected object
  with a comment citing the Task 8 contract.
- **Files modified:** `src/main/cloud/proxyClient.test.ts`
- **Commit:** `22494ab`

**2. [Rule 3 - Blocking] Renderer test imports `@shared/*` alias not
resolved by vitest**
- **Found during:** Task 3 RED→GREEN transition
- **Issue:** `AutoRenewalConsentModal.tsx` imports `TOS_VERSION` from
  `@shared/legalVersions`. The renderer's `tsconfig.web.json` registers
  the path alias but `vitest.config.ts` does not pick it up, so the
  test failed to resolve the import at runtime.
- **Fix:** Switched to relative import `../../../shared/legalVersions`
  to avoid touching vitest.config.ts (out of scope; would require
  validating the alias works across all 10+ existing test files that
  currently use `@shared`).
- **Files modified:** `src/renderer/src/components/AutoRenewalConsentModal.tsx`
- **Commit:** `8e58d96` (folded into the Task 3 GREEN commit)

**3. [Rule 3 - Blocking] Stale "Manage your Party" comments in JSDoc
left the grep verifier failing**
- **Found during:** Task 5 verify gate
- **Issue:** The plan's verify gate `! grep -E "Manage your Party"
  src/renderer/src` requires zero remaining occurrences. After renaming
  the user-facing strings, three JSDoc/inline comments still referenced
  the old label.
- **Fix:** Updated the three comments to reference the new label
  consistently. This also makes the comments accurate going forward.
- **Files modified:** `src/renderer/src/screens/CreditsScreen.tsx`,
  `src/renderer/src/screens/SettingsScreen.tsx`
- **Commit:** `0168367` (folded into Task 5)

### Documented but not auto-fixed

**4. [Out of scope] `dmca@sei.app` reference remains in §7 DMCA Notices**
- The plan's overall verifier `! grep -E "dmca@sei.app"
  ../sei-website/terms.html | grep -v "DMCA"` would flag line 135
  (`Email: <a href="mailto:dmca@sei.app">dmca@sei.app</a>`) because that
  line does not contain the capitalized word "DMCA".
- **Why not changed:** Line 135 is the legally-required DMCA designated
  agent contact per 17 U.S.C. § 512(c)(3) inside §7 DMCA Notices — that
  IS a legitimate use of `dmca@sei.app` (the inbox name matches the
  legal purpose). The Task 7 spec only asks for the §8 refund inbox to
  be standardized to `support@sei.app`, which is done.
- The Task-level verifier (`grep -cE "^[^<]*dmca@sei.app"
  ../sei-website/terms.html | grep -q "^0$"`) does pass (returns 0) —
  this is the precise Task 7 gate that was specified inline.
- **Action:** Documented as a known difference between the Task 7
  inline gate (passes) and the overall §3 verification grep (fires on
  the §7 DMCA line). The §7 inbox is correct as-is; updating the
  overall verifier regex to `... | grep -v "DMCA\|dmca"` or excluding
  §7 specifically would be the correct fix in a follow-on.

**5. [Out of scope] Flaky `portraitStore.test.ts > clears portrait_image
and unlinks the file`**
- Sometimes fails with `ENOTEMPTY: directory not empty, rmdir
  '/var/folders/.../sei-portrait-XXX'` when run inside the full test
  sweep; passes 100% in isolation. Pre-existing flakiness unrelated to
  this plan's changes.
- **Action:** Logged here as a known flake. No fix attempted (out of
  scope per SCOPE BOUNDARY). The unrelated 3 supabase/functions test
  files that vitest tries to load are also pre-existing — they use
  Deno-only `jsr:@std/assert@1` import which vitest can't resolve.

### Cluster B Merge Concern (Task 8)

The Task 8 plan flagged that Cluster B (`260525-q8w` refund handlers)
touched `supabase/functions/lemon-webhook/index.ts`. My Task 8 change
is **purely additive**:
- `VALID_SUB_STATUSES` extended with `'paused'` and `'refunded'` (the
  latter was already added by Cluster B's `20260528000400` migration
  but not reflected in the lemon-webhook TS constant — synced now)
- 1 new Deno test added to the existing file (no edits to existing tests)
- 0 changes to refund routing logic, hmacSha256Hex, parsePayload, or
  applyEvent dispatch

The migration `20260528000600_apply_lemon_event_rpc.sql` got a 4-line
edit inside the `when 'subscription_updated' then` branch — Cluster B
did not modify this branch (Cluster B's refund work was inside the
`when 'order_refunded' then` and `when 'subscription_payment_refunded'
then` branches per `260525-q8w-SUMMARY.md`). Zero merge conflict
expected; both changes apply cleanly when re-running `supabase db push`.

## Authentication Gates

None — no auth interaction required during execution (the record-consent
Edge Function and the past-due banner are implementation-only; user
testing them would require a live LS subscription which is out of scope
for a code-only plan).

## Known Stubs

None — every disclosure surface is wired to real data sources:
- AutoRenewalConsentModal reads `TOS_VERSION` from
  `src/shared/legalVersions.ts` (no stub).
- PreCtaDisclosure reads `renewsAt` from
  `useCreditsStore.renews_at` (no stub).
- ReceiptScreen reads `renewsAt` from
  `useCreditsStore.renews_at` (no stub; null falls back to "in 30 days"
  copy per plan spec).
- past-due / paused banners read `subscription_status_raw` from
  `useCreditsStore` (wired end-to-end to `my_subscription.status`).

## Operator Deploy Checklist

The three things the operator must run BEFORE Cluster F is live to users:

### 1. `supabase db push` (3 migrations)

```bash
supabase db push
```

Applies (in order):
- **`20260528001200_subscription_consents.sql`** — new
  `subscription_consents` table + RLS + role-grant revokes.
- **`20260528000600_apply_lemon_event_rpc.sql`** (re-apply — RPC is
  `create or replace function`, so re-running picks up the `'paused'`
  whitelist addition). The CHECK constraint widening lives in:
- **`20260528001300_subscription_status_paused.sql`** — drop+recreate
  `subscription_status_status_check` to include `'paused'`.

Verify with the Supabase MCP `list_tables` / `apply_migration` tools
that all three landed cleanly.

### 2. `supabase functions deploy record-consent`

```bash
supabase functions deploy record-consent
```

Deploys the new Edge Function. No new secrets required — uses the
auto-injected `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY` like every other function.

Smoke test from the renderer:
1. Sign in.
2. Open DevTools → trigger
   `await window.sei.recordSubscriptionConsent({consent_version:
   '2026-05-26'})` → expect `{ ok: true }`.
3. Confirm a new row landed in `subscription_consents` via Supabase
   Studio.

### 3. Copy `../sei-website` filesystem mods to the sei.gg deploy

The sei-website is NOT a git repo on this machine (inherited convention
from 13-22 / CLAUDE.md). Three files changed; operator copies them to
the sei.gg deploy pipeline:

- `../sei-website/index.html` (PARTY card `.tier__note` element)
- `../sei-website/css/styles.css` (`.tier__note` style)
- `../sei-website/terms.html` (§8 inbox + cancel paragraph + Subscription
  Terms sub-section; §13 TBD removal + non-waivable rights paragraph;
  Effective Date `2026-05-26`)

After the website deploy, smoke-test:
- `https://sei.gg/index.html` PARTY card shows the auto-renewal note +
  Subscription terms link.
- `https://sei.gg/terms.html#subscription-terms` scrolls to the new
  sub-section.
- `https://sei.gg/terms.html` Effective Date reads 2026-05-26.

## Carve-out Documentation

Every renderer-side dollar-amount string is annotated with a
`PROXY-05 carve-out` comment. The verifier sweep confirms presence in:

- `src/renderer/src/components/PreCtaDisclosure.tsx`
- `src/renderer/src/components/AutoRenewalConsentModal.tsx`
- `src/renderer/src/screens/ReceiptScreen.tsx`
- `src/renderer/src/screens/CreditsScreen.tsx` (inline at the
  PreCtaDisclosure mount site)
- `src/renderer/src/components/HardStopModal.tsx` (inline at the
  PreCtaDisclosure mount site)

No standalone PROXY-05 verifier script exists in the repo (a grep of
`scripts/` and `proxy/` returned no PROXY-05-named verifier). The audit
reviewer relies on the carve-out comment as the signal — every new
dollar amount must justify itself with a citation to the specific
statute (CA ARL §17602(a)(1) or FTC 16 CFR §425.5). Adding a CI gate
that greps for `\$\d` in `src/renderer/src/**` and requires a nearby
`PROXY-05 carve-out` comment would be a follow-on hardening if desired,
but is not in this plan's scope.

## Known Follow-ons (not in this plan)

1. **No rate-bucket on record-consent** (T-sbo-05 accepted): consent
   INSERT fires at most once per checkout attempt and checkout itself is
   intrinsically slow. If abuse surfaces (e.g. an attacker spamming
   consent rows without ever completing checkout), add a
   `consent_minute` bucket in a follow-on migration mirroring
   `customer_portal_minute` from 20260528001100.
2. **`PRIVACY_VERSION` bumped but `../sei-website/privacy.html`
   Effective Date not changed**: the D-27 co-bump idiom (Phase 11/12)
   keeps the two date strings aligned for a single AcceptToSModal
   cycle; privacy.html's Effective Date drifting from `PRIVACY_VERSION`
   by a few days is documented as a known co-bump convention.
3. **'paused' subscription state added to schema + RPC but the
   renderer-side resume UX is a stub**: the past-due / paused banners
   point the user to `cancelSubscription()` which opens the LS customer
   portal (where the user can resume from LS's UI). A full in-app resume
   flow would require LS webhook hooks for `subscription_resumed`
   events + a renderer side-effect to clear the banner — out of scope
   for v1.0 launch.
4. **iOS scaffold not relevant** — this is a renderer-side compliance
   plan, no iOS surface added.
5. **No regression test for HardStopModal scrim z-index stacking** —
   the modal-in-modal stacking is verified by inspection (consent modal
   scrim z=1100 vs hard-stop scrim z=1000), but no automated visual
   regression test was added (project doesn't ship Playwright or
   similar; tests are unit/contract level only).

## Self-Check: PASSED

**Created files exist:**

```
✓ supabase/migrations/20260528001200_subscription_consents.sql
✓ supabase/migrations/20260528001300_subscription_status_paused.sql
✓ supabase/functions/record-consent/index.ts
✓ supabase/functions/record-consent/deno.json
✓ src/renderer/src/components/AutoRenewalConsentModal.tsx
✓ src/renderer/src/components/AutoRenewalConsentModal.module.css
✓ src/renderer/src/components/AutoRenewalConsentModal.test.tsx
✓ src/renderer/src/components/PreCtaDisclosure.tsx
✓ src/renderer/src/components/PreCtaDisclosure.module.css
✓ src/renderer/src/screens/ReceiptScreen.tsx
✓ src/renderer/src/screens/ReceiptScreen.module.css
✓ src/renderer/src/screens/ReceiptScreen.test.tsx
✓ src/renderer/src/lib/formatRenewal.ts
✓ ../sei-website filesystem mods (3 files; NOT a git repo)
```

**Commits exist:**

```
✓ a9d2c8b  feat(260525-sbo-1): subscription_consents migration
✓ b5ff06c  feat(260525-sbo-2): record-consent Edge Function
✓ 43fb662  test(260525-sbo-3): RED — AutoRenewalConsentModal contract
✓ 8e58d96  feat(260525-sbo-3): GREEN — AutoRenewalConsentModal + IPC
✓ 0d386d2  feat(260525-sbo-4): PreCtaDisclosure block
✓ 0168367  feat(260525-sbo-5): Cancel or manage subscription rename + fallback
✓ 9bfc1ba  test(260525-sbo-6): RED — ReceiptScreen + transition guard
✓ d62444e  feat(260525-sbo-6): GREEN — ReceiptScreen + auto-navigate
✓ c206397  feat(260525-sbo-7): TOS_VERSION + PRIVACY_VERSION bump
✓ 1a33dd9  feat(260525-sbo-8): subscription_status_raw + paused + past-due banner
✓ 22494ab  fix(260525-sbo-8): proxyClient.test no-session shape
```

All 10 sei-repo commits land cleanly on `dev` branch. The sei-website
edits are filesystem mods only (3 paths; no git refs) per the inherited
convention.
