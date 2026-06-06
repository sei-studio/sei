---
quick_id: 260525-sbo
phase: 13
type: execute
wave: 1
depends_on: []
mode: quick-full
files_modified:
  # Task 1 — Migration: subscription_consents table
  - supabase/migrations/20260528001200_subscription_consents.sql
  # Task 2 — Edge Function: record-consent
  - supabase/functions/record-consent/index.ts
  - supabase/functions/record-consent/deno.json
  # Task 3 — AutoRenewalConsentModal (new) + wiring in CreditsScreen + HardStopModal
  - src/renderer/src/components/AutoRenewalConsentModal.tsx
  - src/renderer/src/components/AutoRenewalConsentModal.module.css
  - src/renderer/src/screens/CreditsScreen.tsx
  - src/renderer/src/components/HardStopModal.tsx
  - src/shared/ipc.ts
  - src/shared/preload-api.ts
  - src/main/ipc.ts
  - src/main/cloud/proxyClient.ts
  # Task 4 — Pre-CTA disclosure block (CA ARL §17602(a)(1))
  - src/renderer/src/components/PreCtaDisclosure.tsx
  - src/renderer/src/components/PreCtaDisclosure.module.css
  - src/renderer/src/screens/CreditsScreen.tsx
  - src/renderer/src/components/HardStopModal.tsx
  - src/renderer/src/screens/CreditsScreen.module.css
  - src/renderer/src/components/HardStopModal.module.css
  # Task 5 — Rename "Manage your Party" + helper copy + fallback link
  - src/renderer/src/screens/CreditsScreen.tsx
  - src/renderer/src/screens/SettingsScreen.tsx
  # Task 6 — ReceiptScreen (subscription activation welcome surface)
  - src/renderer/src/screens/ReceiptScreen.tsx
  - src/renderer/src/screens/ReceiptScreen.module.css
  - src/renderer/src/lib/stores/useUiStore.ts
  - src/renderer/src/lib/stores/useCreditsStore.ts
  - src/renderer/src/App.tsx
  # Task 7 — sei-website + TOS_VERSION bump
  - ../sei-website/index.html
  - ../sei-website/terms.html
  - src/shared/legalVersions.ts
  # Task 8 — subscription_updated reason_code in webhook + renderer surface
  - supabase/functions/lemon-webhook/index.ts
  - supabase/migrations/20260528000600_apply_lemon_event_rpc.sql
  - src/shared/ipc.ts
  - src/main/cloud/proxyClient.ts
  - src/renderer/src/lib/stores/useCreditsStore.ts
  - src/renderer/src/screens/SettingsScreen.tsx

autonomous: true

requirements: [PROXY-04, PROXY-08, AUTH-05]

must_haves:
  truths:
    - "Task 1: A new table public.subscription_consents (id uuid PK, user_id uuid FK→auth.users, consent_version text, consent_timestamp timestamptz, ip_hash text, created_at) exists in migration 20260528001200_subscription_consents.sql with RLS enabled, an insert/select-own-only policy set, and zero update/delete policies (immutable record like tos_acceptance)."
    - "Task 2: A new Edge Function supabase/functions/record-consent/index.ts exists, verifies the caller JWT via the two-client pattern (anon-client.auth.getUser for identity + service_role client for the INSERT), accepts {consent_version:string, ip_hash:string|null}, inserts (auth.user.id, consent_version, now(), ip_hash) into subscription_consents, and returns 202 {status:'received'} (mirrors trial-claim uniform envelope)."
    - "Task 3: A new component AutoRenewalConsentModal.tsx renders BEFORE proxyClient.openCheckout('subscription') is fired. The modal's primary CTA 'Continue to checkout' is disabled until a checkbox with label containing the literal token '$20/month' AND the literal token 'until I cancel' is checked. On checkbox-checked + CTA-click, the renderer calls a new IPC method recordSubscriptionConsent({consent_version:TOS_VERSION}) THEN calls openCheckout('subscription'). The 'Join a Party' buttons in CreditsScreen.tsx:154 and HardStopModal.tsx:128 invoke the modal (NOT openCheckout directly). The pack ('Get a Quest') button path is UNCHANGED — only the subscription path gates through the consent modal."
    - "Task 4: A PreCtaDisclosure component renders BEFORE every 'Join a Party' CTA in CreditsScreen.tsx (Party section ~line 144) AND HardStopModal.tsx (~line 128). The rendered block contains, in this exact order: (a) '$20.00 USD per month', (b) renewal day line ('Auto-renews on the [day] of each month until you cancel' when subscription_status.renews_at is present, else 'Auto-renews monthly until you cancel'), (c) '14-day refund on unused credits', (d) 'Cancel anytime in Settings → Cloud AI → Cancel subscription'. The block uses the SAME visual weight as the CTA (not footnote/muted styling) — verified via the component using the .tile body styles, NOT the .muted helper style. CARVE-OUT comment 'PROXY-05 carve-out: pre-purchase legal disclosure per CA ARL §17602(a)(1) — dollar amounts MUST appear in-renderer for compliance' present in both edit sites + the component header."
    - "Task 5: The label 'Manage your Party' is REPLACED with 'Cancel or manage subscription' in BOTH CreditsScreen.tsx:151 AND SettingsScreen.tsx:411. The CreditsScreen.tsx helper text at ~line 141 is replaced with 'Cancel or manage your subscription through Lemon Squeezy. No call required.'. When cancelSubscription() returns ok=false with code PROXY_NO_PORTAL_URL, BOTH screens render an INLINE fallback element (NOT a toast/error string) — a clickable link with text 'Cancel subscription via Lemon Squeezy →' that calls sei.openExternal('https://sei.lemonsqueezy.com/billing'). The fallback element is rendered in the same row container as the original button and the existing manageSubError toast text is REMOVED (Settings) or replaced (Credits)."
    - "Task 6: A new screen ReceiptScreen.tsx is registered as View kind 'receipt' in useUiStore.ts View union. useCreditsStore.ts gains an onStatusUpdate side-effect: when the previous plan was NOT 'unlimited' AND the new plan IS 'unlimited' (transition: trial|pack|depleted → unlimited), App.tsx (or a useEffect inside useCreditsStore subscriber) navigates to View kind 'receipt' EXACTLY ONCE per transition (guarded by a prevPlanRef so a re-render with the same status does NOT re-navigate). ReceiptScreen renders: title 'Welcome to Party!', body lines: amount '$20.00 charged today', frequency 'Billed monthly', next billing date from subscription_status.renews_at, cancellation steps 'Cancel anytime in Settings → Cloud AI → Cancel subscription'. Single CTA 'Back to Sei' that navigates({kind:'home'})."
    - "Task 7: ../sei-website/index.html PARTY card (~line 313) has a new <p class='tier__note'> element immediately below the .tier__desc line, containing literal text 'Auto-renews monthly. Cancel anytime in app.' AND a hyperlink to './terms.html#subscription-terms'. ../sei-website/terms.html: (a) §8 'Refunds and Cancellations' replaces 'dmca@sei.app' with 'support@sei.app' (lines 164-166); (b) §8 adds a new paragraph 'Cancel anytime online by going to Settings → Cloud AI → Cancel subscription in the Sei app. No call, no email, no questions.'; (c) §8 adds new <h3 id='subscription-terms'>Subscription Terms</h3> sub-section with four bullet items: price ($20/month USD), frequency (monthly auto-renew), renewal date ('on the same day each month'), cancellation method (in-app); (d) §13 'Governing Law' (lines 212-219): the inline comment '<!-- TBD: jurisdiction -->' is REMOVED, the parenthetical '(Jurisdiction subject to confirmation prior to v1.0 launch.)' is REMOVED, and a new paragraph is appended: 'Nothing in this section limits any non-waivable rights you have under the laws of your state of residence.'; (e) the 'Effective Date' line (~line 54) is updated to '2026-05-26'. src/shared/legalVersions.ts: BOTH TOS_VERSION AND PRIVACY_VERSION are bumped to '2026-05-26' (co-bump convention per Phase 11/12)."
    - "Task 8: supabase/functions/lemon-webhook/index.ts: the subscription_updated branch (in applyEvent or its downstream RPC payload) preserves the LS attributes.status value end-to-end such that the renderer can read a reason_code derived from it. The CreditsStatus interface in src/shared/ipc.ts gains an optional subscription_status_raw?: 'active'|'cancelled'|'expired'|'past_due'|'refunded'|null field. proxyClient.creditsGet() populates it from my_subscription.status. useCreditsStore exposes a reasonCode selector mapping 'past_due'→'past_due_payment_failed', 'paused'→'paused_by_user', etc. SettingsScreen renders a contextual one-line banner above the Cloud AI row when subscription_status_raw === 'past_due': 'Your payment is past due — update your card →' linking to cancelSubscription() (which opens the customer portal). The apply_lemon_event RPC's subscription_updated branch maps unknown statuses to 'past_due' (already correct per migration 20260528000600 line 125) — no migration change required for the mapping itself, but a forward-compat 'paused' value MUST be added to VALID_SUB_STATUSES and the CHECK constraint."

  artifacts:
    - path: "supabase/migrations/20260528001200_subscription_consents.sql"
      provides: "Immutable consent recordkeeping per CA ARL §17602(b)"
      contains: "subscription_consents"
    - path: "supabase/functions/record-consent/index.ts"
      provides: "Edge Function: verified-JWT INSERT into subscription_consents"
      min_lines: 80
    - path: "src/renderer/src/components/AutoRenewalConsentModal.tsx"
      provides: "Blocking modal: explicit auto-renewal consent before openCheckout('subscription')"
      min_lines: 80
    - path: "src/renderer/src/components/PreCtaDisclosure.tsx"
      provides: "CA ARL §17602(a)(1) clear-and-conspicuous pre-CTA disclosure block"
      min_lines: 40
    - path: "src/renderer/src/screens/ReceiptScreen.tsx"
      provides: "Post-checkout in-app receipt (amount, frequency, next-bill, cancel steps)"
      min_lines: 50
    - path: "../sei-website/terms.html"
      provides: "ToS §8 cancellation copy fix + §13 jurisdiction TBD removal + #subscription-terms anchor"

  key_links:
    - from: "src/renderer/src/screens/CreditsScreen.tsx (Join a Party button)"
      to: "src/renderer/src/components/AutoRenewalConsentModal.tsx"
      via: "onClick opens AutoRenewalConsentModal; modal's Continue calls recordSubscriptionConsent + openCheckout('subscription')"
      pattern: "AutoRenewalConsentModal"
    - from: "src/renderer/src/components/AutoRenewalConsentModal.tsx"
      to: "supabase/functions/record-consent/index.ts"
      via: "sei.recordSubscriptionConsent IPC → main/ipc.ts → proxyClient.recordSubscriptionConsent → callEdgeFunction('record-consent')"
      pattern: "record-consent"
    - from: "src/renderer/src/lib/stores/useCreditsStore.ts (onStatusUpdate)"
      to: "src/renderer/src/screens/ReceiptScreen.tsx"
      via: "plan transition non-unlimited → unlimited triggers navigate({kind:'receipt'}) exactly once"
      pattern: "kind: 'receipt'"
    - from: "src/shared/legalVersions.ts"
      to: "../sei-website/terms.html Effective Date"
      via: "TOS_VERSION constant must equal terms.html Effective Date string"
      pattern: "2026-05-26"
    - from: "supabase/functions/lemon-webhook/index.ts (subscription_updated)"
      to: "src/renderer/src/screens/SettingsScreen.tsx (past_due banner)"
      via: "my_subscription.status='past_due' → creditsGet returns subscription_status_raw='past_due' → SettingsScreen renders past-due banner"
      pattern: "past_due"
---

<objective>
Cluster F — Subscription compliance UI. Close all 10 CA ARL / FTC Click-to-Cancel
remediations from the audit (pre-CTA disclosure, separate auto-renewal consent,
in-app receipt, "Cancel" wording, website pricing-card disclosure, ToS §8 inbox
fix + §13 jurisdiction TBD removal, customer-portal fallback robustness, and
subscription_updated reason_code passthrough).

Purpose: Bring Sei's subscription flow into compliance with California's
Automatic Renewal Law (Bus & Prof Code §17602) and the FTC's Click-to-Cancel
Rule (16 CFR §425). Without these surfaces Sei cannot legally onboard
California-resident subscribers AND faces FTC exposure as soon as the
Click-to-Cancel rule's enforcement date hits.

Output: 8 atomic commits — 1 migration, 1 Edge Function, 4 renderer UI surfaces
(consent modal, pre-CTA disclosure, rename + fallback, receipt screen), 1
sei-website filesystem edit (committed via TOS_VERSION bump on the sei side),
and 1 webhook reason_code passthrough. Six in-app surfaces (consent, disclosure,
rename, receipt, fallback link, past-due banner) + two text-only edits
(sei-website + ToS).
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@CLAUDE.md
@.planning/STATE.md
@.planning/ROADMAP.md
@.planning/phases/13-ai-proxy-billing-usage-ui/13-CONTEXT.md
@.planning/phases/13-ai-proxy-billing-usage-ui/13-PATTERNS.md
@.planning/quick/260523-t8d-phase-13-polish-bug-sweep-billing-ux-que/260523-t8d-SUMMARY.md
@.planning/quick/260525-rfj-trial-auth-hardening-email-confirmed-at-/260525-rfj-SUMMARY.md
@src/shared/legalVersions.ts
@src/shared/ipc.ts
@src/main/ipc.ts
@src/main/cloud/proxyClient.ts
@src/renderer/src/lib/stores/useCreditsStore.ts
@src/renderer/src/lib/stores/useUiStore.ts
@src/renderer/src/screens/CreditsScreen.tsx
@src/renderer/src/screens/SettingsScreen.tsx
@src/renderer/src/components/HardStopModal.tsx
@src/renderer/src/components/SignInModal.tsx
@supabase/migrations/20260521000000_characters_tos.sql
@supabase/migrations/20260528001100_rate_buckets_reports_ip_customer_portal.sql
@supabase/migrations/20260528000600_apply_lemon_event_rpc.sql
@supabase/functions/lemon-webhook/index.ts
@supabase/functions/trial-claim/index.ts

<interfaces>
<!-- Pre-extracted types/exports the executor needs — no scavenger hunt required. -->

From src/shared/ipc.ts (CURRENT):
```typescript
export interface CreditsStatus {
  remaining_pct: number;
  plan: 'trial' | 'pack' | 'unlimited' | 'depleted';
  renews_at: string | null;
  trial_claimed: boolean;
  ai_backend_kind: 'local' | 'cloud-proxy';
  remaining_tokens?: number;
  tokens_per_min?: number;
  // Task 8 ADDS:
  // subscription_status_raw?: 'active'|'cancelled'|'expired'|'past_due'|'refunded'|'paused'|null;
}

export interface SubscriptionStatusInfo {
  active: boolean;
  status: 'active' | 'cancelled' | 'expired' | 'past_due' | 'none';
  // Task 8 ADDS 'paused' | 'refunded' to the union.
  renews_at: string | null;
  ends_at: string | null;
}

// IpcChannel namespace (extend with subscription.recordConsent — Task 3):
export const IpcChannel = {
  // ...existing
  subscription: {
    status: 'subscription:status',
    cancel: 'subscription:cancel',
    // Task 3 ADDS:
    // recordConsent: 'subscription:record-consent',
  },
};
```

From src/renderer/src/lib/stores/useUiStore.ts (CURRENT — Task 6 adds 'receipt'):
```typescript
export type View =
  | { kind: 'loading' } | { kind: 'auth-choice' } | { kind: 'onboarding'; isReonboard: boolean }
  | { kind: 'home' } | { kind: 'add-character' } | { kind: 'character'; id: string }
  | { kind: 'settings' } | { kind: 'credits' } | { kind: 'coming-soon' };
  // Task 6 ADDS:
  // | { kind: 'receipt' };
```

From src/renderer/src/screens/CreditsScreen.tsx (current button at line 154):
```tsx
<Button kind="primary" onClick={() => void openCheckout('subscription')}>
  Join a Party
</Button>
// Task 3 REPLACES the onClick to open the AutoRenewalConsentModal first.
// Task 4 INSERTS <PreCtaDisclosure renewsAt={renewsAt} /> BEFORE this Button.
```

From src/renderer/src/components/HardStopModal.tsx (current button at line 128):
```tsx
<Button kind="primary" onClick={() => void openCheckout('subscription')}>
  Join a Party
</Button>
// Task 3 + Task 4 same patches as above. HardStopModal must mount the
// AutoRenewalConsentModal as a SIBLING (z-index above the hard-stop scrim)
// or handle the modal-in-modal stacking explicitly.
```

From src/main/cloud/proxyClient.ts (existing pattern at line 451):
```typescript
export async function openCheckout(kind: 'pack' | 'subscription'): Promise<...>;
// Task 3 ADDS:
// export async function recordSubscriptionConsent(
//   args: { consent_version: string }
// ): Promise<{ ok: true } | { ok: false; code: ProxyErrorCode }>;
// Implementation: callEdgeFunction('record-consent', { jwt, body: { consent_version, ip_hash: null } })
```

From supabase/migrations/20260521000000_characters_tos.sql (RLS pattern for immutable records):
```sql
create table public.tos_acceptance (
  user_id uuid not null references auth.users(id) on delete cascade,
  tos_version text not null,
  privacy_version text not null,
  accepted_at timestamptz not null default now(),
  primary key (user_id, tos_version, privacy_version)
);
alter table public.tos_acceptance enable row level security;
create policy "tos_select_own" on public.tos_acceptance for select using (user_id = auth.uid());
create policy "tos_insert_own" on public.tos_acceptance for insert with check (user_id = auth.uid());
-- No update/delete policies — acceptance is immutable.
-- Task 1 MIRRORS this exact shape for subscription_consents but uses a uuid PK
-- (id) instead of composite PK so the same user can record multiple consents
-- across re-subscribes / TOS bumps. The (user_id, consent_version) tuple is
-- NOT unique — a user may re-consent after a cancel-and-resubscribe cycle.
```

From supabase/functions/trial-claim/index.ts (two-client JWT-verify pattern for Task 2):
```typescript
// 1. anon client with caller's Bearer token → auth.getUser() returns verified user
// 2. service_role client for the privileged INSERT (bypasses RLS)
// 3. Return 202 { status: 'received' } uniform envelope (mirrors trial-claim)
```

From supabase/migrations/20260528000600_apply_lemon_event_rpc.sql (Task 8 — subscription_updated branch already maps unknown→'past_due'):
```sql
when 'subscription_updated' then
  v_status_raw := coalesce(p_payload->'data'->'attributes'->>'status', 'active');
  v_status := case
    when v_status_raw in ('active','cancelled','expired','past_due','refunded')
      then v_status_raw
    else 'past_due'    -- forward-compat fallback already in place
  end;
-- Task 8: ADD 'paused' to this whitelist so LS pause-subscription events
-- round-trip as 'paused' rather than collapsing to 'past_due'. Migration
-- patch is additive — drop+recreate the CHECK constraint on subscription_status.status
-- to include 'paused'.
```
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: subscription_consents migration (CA ARL §17602(b) recordkeeping)</name>
  <files>supabase/migrations/20260528001200_subscription_consents.sql</files>
  <action>
Create a new migration following the 20260521000000_characters_tos.sql shape exactly
for the immutable-record pattern. Schema:

```sql
create table public.subscription_consents (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  consent_version   text not null,
  consent_timestamp timestamptz not null default now(),
  ip_hash           text          -- optional SHA-256 hex; null when caller cannot supply
);

alter table public.subscription_consents enable row level security;

create policy "subscription_consents_select_own"
  on public.subscription_consents
  for select using (user_id = auth.uid());

create policy "subscription_consents_insert_own"
  on public.subscription_consents
  for insert with check (user_id = auth.uid());
-- No update/delete policies — consent records are IMMUTABLE per CA ARL §17602(b)
-- (operator must retain the original consent record for audit purposes).

create index subscription_consents_user_id_idx
  on public.subscription_consents(user_id, consent_timestamp desc);

-- Explicit revokes (defense-in-depth — mirrors 260525-pbn M8 pattern).
revoke insert, update, delete on public.subscription_consents from anon;
revoke insert, update, delete on public.subscription_consents from authenticated;
-- Authenticated users INSERT through the record-consent Edge Function which
-- uses service_role; the select-own policy is the only renderer-side access.
grant select on public.subscription_consents to authenticated;
```

Include a header comment block citing CA Bus & Prof Code §17602(b) ("operator
shall maintain consumer's affirmative consent until the consumer has
discontinued use of the service or for three years, whichever is shorter") and
note that ip_hash is OPTIONAL (we don't have a renderer-side IP hashing helper
yet; the Edge Function passes null when the caller doesn't supply it).
  </action>
  <verify>
    <automated>grep -c "create table public.subscription_consents" supabase/migrations/20260528001200_subscription_consents.sql | grep -q "^1$" && grep -c "enable row level security" supabase/migrations/20260528001200_subscription_consents.sql | grep -q "^1$" && grep -E "for (update|delete)" supabase/migrations/20260528001200_subscription_consents.sql | grep -v '^#' && [ $? -ne 0 ]; echo "OK migration shape verified"</automated>
  </verify>
  <done>Migration file exists. Table has id PK + user_id FK + consent_version + consent_timestamp + ip_hash. RLS enabled. Exactly two policies (select_own + insert_own). Zero update/delete policies. Explicit revoke of insert/update/delete from anon AND authenticated. Index on (user_id, consent_timestamp desc).</done>
</task>

<task type="auto">
  <name>Task 2: record-consent Edge Function (two-client JWT-verify INSERT)</name>
  <files>supabase/functions/record-consent/index.ts, supabase/functions/record-consent/deno.json</files>
  <action>
Create supabase/functions/record-consent/ mirroring trial-claim's two-client
pattern (JWT-verified user via anon client + service_role for privileged INSERT).

Flow:
1. CORS preflight → corsHeaders.
2. Method !== POST → 405 {error:'method_not_allowed'}.
3. Missing Authorization Bearer → 401 {error:'missing_jwt'}.
4. Create anon client bound to caller's Bearer token; auth.getUser() to verify.
   Invalid JWT → 401 {error:'invalid_jwt'}.
5. Parse JSON body: {consent_version: string, ip_hash?: string|null}.
   Bad JSON → 400 {error:'bad_request'}. Missing consent_version → 400.
   Validate consent_version is a non-empty string ≤ 64 chars (defensive shape gate;
   the value should equal TOS_VERSION from the renderer).
6. Create admin client (service_role); INSERT { user_id: user.id, consent_version,
   consent_timestamp: now (DB default), ip_hash: body.ip_hash ?? null }. On insert
   error log + return 503 {error:'insert_failed'} so the renderer can retry (rare —
   we don't gate checkout on this since the legal exposure is heavier than the UX
   cost of a redundant insert).
7. Return 202 { status: 'received' } (uniform envelope per trial-claim convention).

deno.json: copy the trial-claim/deno.json verbatim (same supabase-js import,
same lint config).

Header comment must cite CA ARL §17602(b) recordkeeping requirement and the
trial-claim two-client pattern as the structural template.

IMPORTANT — do NOT add this function to any rate_buckets bucket_kind in this
plan. Checkout is intrinsically slow (Lemon hosted page), the consent INSERT
fires at most once per checkout attempt, and unlike trial-claim it's not a
free-money endpoint. If abuse surfaces later, add a consent_minute bucket in
a follow-on migration.
  </action>
  <verify>
    <automated>test -f supabase/functions/record-consent/index.ts && test -f supabase/functions/record-consent/deno.json && grep -c "subscription_consents" supabase/functions/record-consent/index.ts | grep -q "^[1-9]" && grep -c "auth.getUser\|getUser()" supabase/functions/record-consent/index.ts | grep -q "^[1-9]" && echo "OK record-consent Edge Function shape verified"</automated>
  </verify>
  <done>index.ts exists with two-client pattern (anon for JWT verify + service_role for INSERT). Validates consent_version is non-empty string. Returns 202 {status:'received'} on success. Returns 401 on missing/invalid JWT. Returns 503 on DB insert error. deno.json mirrors trial-claim/deno.json.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 3: AutoRenewalConsentModal — explicit consent gate before openCheckout('subscription')</name>
  <files>src/renderer/src/components/AutoRenewalConsentModal.tsx, src/renderer/src/components/AutoRenewalConsentModal.module.css, src/renderer/src/screens/CreditsScreen.tsx, src/renderer/src/components/HardStopModal.tsx, src/shared/ipc.ts, src/main/ipc.ts, src/main/cloud/proxyClient.ts</files>
  <behavior>
    - Modal renders with: title "Confirm your subscription", a checkbox with label including the LITERAL substring "$20/month" AND "until I cancel", a primary "Continue to checkout" CTA, a "Back" CTA.
    - Primary CTA is `disabled={!checked || submitting}`.
    - On primary click: (1) call `sei.recordSubscriptionConsent({consent_version: TOS_VERSION})` from shared/legalVersions.ts; (2) regardless of consent INSERT result (best-effort — log warning on failure but proceed; the LEGAL anchor is the user's affirmative checkbox click which the renderer can't lose), call `sei.creditsOpenCheckout('subscription')`; (3) close the modal.
    - ESC closes the modal (mirrors SignInModal:75-81 pattern; non-blocking — the user CAN dismiss without consenting, in which case no checkout is opened).
    - The 'Join a Party' button onClicks in CreditsScreen.tsx:154 + HardStopModal.tsx:128 set local state `showConsentModal=true` instead of calling openCheckout directly.
    - The pack ('Get a Quest') button path is UNCHANGED — packs are one-time purchases, not auto-renewing subscriptions, so they don't need an auto-renewal consent gate.
  </behavior>
  <action>
1. Add IPC channel + Zod schema + RendererApi method:
   - src/shared/ipc.ts: extend IpcChannel.subscription with `recordConsent: 'subscription:record-consent'`. Add `RecordConsentArgsSchema = z.object({ consent_version: z.string().min(1).max(64) })`. Extend RendererApi with `recordSubscriptionConsent: (args: { consent_version: string }) => Promise<{ ok: true } | { ok: false; code: string }>`.
   - src/main/ipc.ts: register `ipcMain.handle(IpcChannel.subscription.recordConsent, ...)` that Zod-parses args, lazy-imports proxyClient, calls `recordSubscriptionConsent`.
   - src/main/cloud/proxyClient.ts: add `recordSubscriptionConsent` that calls `callEdgeFunction('record-consent', { jwt: session.jwt, body: { consent_version: args.consent_version, ip_hash: null } })`. Returns `{ ok: true }` on 2xx, `{ ok: false, code: PROXY_NETWORK }` otherwise. Short-circuits with PROXY_NO_SESSION on no session.
   - Preload (src/shared/preload-api.ts — check actual path; if not present grep for `contextBridge.exposeInMainWorld`): bind `recordSubscriptionConsent` to `(args) => ipcRenderer.invoke(IpcChannel.subscription.recordConsent, args)`.

2. AutoRenewalConsentModal.tsx: blocking-ish modal (scrim + .modal), TOS_VERSION read via `import { TOS_VERSION } from '@shared/legalVersions'`. Use AcceptToSModal/SignInModal as the structural template (scrim + role="dialog" + aria-modal + useId for titleId). Checkbox label MUST contain literal text `I agree to be charged $20/month until I cancel.` (the verifier greps for both `$20/month` AND `until I cancel`). Use `<Button kind="quiet">` for the Back CTA per UI-SPEC dismissal-label policy.

3. CreditsScreen.tsx Party section: replace the Join-a-Party button's `onClick={() => void openCheckout('subscription')}` with `onClick={() => setShowConsentModal(true)}`. Add `const [showConsentModal, setShowConsentModal] = useState(false);` and render `{showConsentModal ? <AutoRenewalConsentModal onClose={() => setShowConsentModal(false)} /> : null}` at the end of the component.

4. HardStopModal.tsx: same wiring as #3. Modal-in-modal stacking — the AutoRenewalConsentModal uses z-index ≥ scrim 1000; mirror the OAuthInterstitialModal pattern (SignInModal.tsx:285-306) which renders as a sibling with z-index 1100. Adjust the AutoRenewalConsentModal.module.css scrim z-index to 1100 so it stacks above HardStopModal's scrim cleanly.

5. CSS: AutoRenewalConsentModal.module.css mirrors SignInModal.module.css structure (scrim, modal, title, footer). Checkbox row reuses the .tosCheckbox class pattern from SignInModal.module.css.

Carve-out comment in AutoRenewalConsentModal.tsx header: "PROXY-05 carve-out:
this modal MUST render the literal '$20/month' string for CA ARL §17602(a)(1)
clear-and-conspicuous compliance. The PROXY-05 invariant ('no dollar amounts
in renderer') is suspended for the at-purchase legal-disclosure surface."

Test scaffold (vitest): `src/renderer/src/components/AutoRenewalConsentModal.test.tsx` with at minimum:
- Renders with disabled primary CTA when checkbox unchecked.
- Primary CTA becomes enabled when checkbox checked.
- Clicking primary CTA calls sei.recordSubscriptionConsent AND sei.creditsOpenCheckout('subscription') in that order.
- ESC fires onClose.
  </action>
  <verify>
    <automated>npx vitest run src/renderer/src/components/AutoRenewalConsentModal.test.tsx 2>&1 | grep -E "passed|fail" | tail -5 && grep -c "\\\$20/month" src/renderer/src/components/AutoRenewalConsentModal.tsx | grep -q "^[1-9]" && grep -c "until I cancel" src/renderer/src/components/AutoRenewalConsentModal.tsx | grep -q "^[1-9]" && grep -c "AutoRenewalConsentModal" src/renderer/src/screens/CreditsScreen.tsx | grep -q "^[1-9]" && grep -c "AutoRenewalConsentModal" src/renderer/src/components/HardStopModal.tsx | grep -q "^[1-9]" && grep -c "recordSubscriptionConsent" src/main/cloud/proxyClient.ts | grep -q "^[1-9]" && echo "OK Task 3 wiring verified"</automated>
  </verify>
  <done>AutoRenewalConsentModal.tsx exists, contains literal "$20/month" and "until I cancel" in the checkbox label, calls recordSubscriptionConsent then openCheckout in sequence. CreditsScreen + HardStopModal Join-a-Party buttons route through the modal. IPC channel + Zod schema + main handler + proxyClient function + preload binding all wired. Vitest suite passes including the 4 new AutoRenewalConsentModal tests. No regression in existing 368 vitest baseline.</done>
</task>

<task type="auto">
  <name>Task 4: PreCtaDisclosure block — CA ARL §17602(a)(1) clear-and-conspicuous</name>
  <files>src/renderer/src/components/PreCtaDisclosure.tsx, src/renderer/src/components/PreCtaDisclosure.module.css, src/renderer/src/screens/CreditsScreen.tsx, src/renderer/src/components/HardStopModal.tsx, src/renderer/src/screens/CreditsScreen.module.css, src/renderer/src/components/HardStopModal.module.css</files>
  <action>
Create a stateless PreCtaDisclosure component that renders the four required
disclosure lines per CA ARL §17602(a)(1). Props: `{ renewsAt: string | null }`.

Render (in exact order, each line a separate <p> or <div>):
1. "$20.00 USD per month" — visual weight EQUAL to surrounding body copy (NOT
   muted/footnote). Use the .tile body class, NOT the .muted helper class.
2. Renewal day line. If renewsAt is non-null and parseable, render
   "Auto-renews on the {Nth} of each month until you cancel" where {Nth} is
   the day-of-month derived via `new Date(renewsAt).getDate()` formatted as
   ordinal (1st, 2nd, ..., 31st). If renewsAt is null/unparseable (first-time
   purchaser path), render "Auto-renews monthly until you cancel" — DO NOT
   show a day-of-month for users who haven't subscribed yet.
3. "14-day refund on unused credits"
4. "Cancel anytime in Settings → Cloud AI → Cancel subscription"

Component header MUST contain the carve-out comment:
"PROXY-05 carve-out: this disclosure block renders dollar amounts in the
renderer per CA ARL §17602(a)(1) clear-and-conspicuous + visual-proximity
requirement. The PROXY-05 bright-line ('no dollar amounts in renderer') is
suspended for the at-purchase legal-disclosure surface only — all other UI
surfaces (Playtime pill, plan labels, hard-stop copy) remain dollar-free."

Insert the component:
- CreditsScreen.tsx PARTY section: render `<PreCtaDisclosure renewsAt={renewsAt} />`
  immediately above the Join-a-Party Button (inside `.tileActions` parent
  container OR just above it — pick whichever keeps the visual block adjacent
  to the CTA per "visual proximity" requirement). Render ONLY when
  `!isSubscribed` — existing subscribers don't need a re-purchase disclosure.
- HardStopModal.tsx: render `<PreCtaDisclosure renewsAt={null} />` immediately
  above the "Join a Party" button in the footer. The HardStopModal renderer
  doesn't have access to subscription_status.renews_at (the modal user is
  by definition out of credits — either depleted or rate-limited), so always
  pass null which triggers the "Auto-renews monthly" fallback.

CSS: PreCtaDisclosure.module.css with a .block container (border-radius
matches .tile, padding ~12px, background uses --card-bg or similar to
visually separate from the tile body), .line for each of the four <p>
elements (font-size matches body, font-weight regular, color uses --ink-1
NOT --ink-muted). Mirror the visual weight rule from CreditsScreen.module.css
.tileBody.

Both edit sites — CreditsScreen.tsx + HardStopModal.tsx — get the carve-out
comment inline above the `<PreCtaDisclosure>` mount: "PROXY-05 carve-out
(quick/260525-sbo): pre-purchase legal disclosure per CA ARL §17602(a)(1)."

Ordinal helper: inline a small `function ordinal(n: number): string` inside
PreCtaDisclosure.tsx (n=1→"1st", n=2→"2nd", n=3→"3rd", n=21→"21st", etc.).
No external lib — 10 lines of switch logic on n % 10 with n % 100 11/12/13
exception.
  </action>
  <verify>
    <automated>grep -c "PROXY-05 carve-out" src/renderer/src/components/PreCtaDisclosure.tsx | grep -q "^[1-9]" && grep -cE "20.00 USD per month" src/renderer/src/components/PreCtaDisclosure.tsx | grep -q "^[1-9]" && grep -c "14-day refund" src/renderer/src/components/PreCtaDisclosure.tsx | grep -q "^[1-9]" && grep -c "Cancel anytime in Settings" src/renderer/src/components/PreCtaDisclosure.tsx | grep -q "^[1-9]" && grep -c "PreCtaDisclosure" src/renderer/src/screens/CreditsScreen.tsx | grep -q "^[1-9]" && grep -c "PreCtaDisclosure" src/renderer/src/components/HardStopModal.tsx | grep -q "^[1-9]" && grep -c "PROXY-05 carve-out" src/renderer/src/screens/CreditsScreen.tsx | grep -q "^[1-9]" && grep -c "PROXY-05 carve-out" src/renderer/src/components/HardStopModal.tsx | grep -q "^[1-9]" && echo "OK PreCtaDisclosure presence + carve-out comments verified"</automated>
  </verify>
  <done>PreCtaDisclosure.tsx exists with all four required disclosure lines including the renewal-day branch. Mounted above the Join-a-Party CTA in BOTH CreditsScreen (Party section, gated on !isSubscribed) AND HardStopModal (footer, renewsAt=null). Carve-out comment present in component header + both mount sites. CSS uses non-muted styling (visual weight equal to body, not footnote).</done>
</task>

<task type="auto">
  <name>Task 5: "Cancel or manage subscription" rename + customer-portal inline fallback link</name>
  <files>src/renderer/src/screens/CreditsScreen.tsx, src/renderer/src/screens/SettingsScreen.tsx</files>
  <action>
Three coordinated copy/UX edits.

(a) Rename the CreditsScreen.tsx button label at line 151:
    Old: `Manage your Party`
    New: `Cancel or manage subscription`

(b) Rename the SettingsScreen.tsx button label at line 411:
    Old: `Manage your Party`
    New: `Cancel or manage subscription`

(c) Update CreditsScreen.tsx helper text at ~line 141 (the .tileBody for the
    Party tile when isSubscribed):
    Old: `You're in a Party. Manage your billing through our payment partner.`
    New: `You're in a Party. Cancel or manage your subscription through Lemon Squeezy. No call required.`

(d) Inline fallback link on PROXY_NO_PORTAL_URL:
    SettingsScreen.tsx currently sets `manageSubError` state on failure and
    renders a toast text "Couldn't open the billing portal. Email support@sei.app."
    (line 405). REPLACE this branch:
    - Add state: `const [showPortalFallback, setShowPortalFallback] = useState(false);`
    - On cancelSubscription returning `{ ok: false, code: 'PROXY_NO_PORTAL_URL' }`,
      set `setShowPortalFallback(true)` INSTEAD of setting the error string.
    - On other error codes (PROXY_NO_SESSION, PROXY_NETWORK), keep the existing
      toast pattern but change the copy to "Couldn't open the billing portal.
      Try again or email support@sei.app."
    - When showPortalFallback is true, render BELOW the Cancel-or-manage button
      (in the same .row container, as a <p className={styles.rowHelper}> with
      role="status"): a clickable text "Cancel subscription via Lemon Squeezy →"
      that onClick calls `void sei.openExternal('https://sei.lemonsqueezy.com/billing')`.

    CreditsScreen.tsx Party section: add the same fallback wiring. Currently
    cancelSubscription is called inline without error handling (line 150 button
    onClick). Refactor to a `handleManage` async function that awaits the result;
    on PROXY_NO_PORTAL_URL set local `showPortalFallback` state; on success do
    nothing (the portal opens in the system browser). Render the same fallback
    link below the .tileActions when showPortalFallback is true.

NOTE: do NOT change the internal cancelSubscription() function name in
proxyClient.ts — preserved for test-suite compatibility per the ITEM 3
(quick/260523-t8d) convention.

NOTE: keep support@sei.app (NOT refunds@sei.app) — Task 7 audits ToS §8 for the
SAME inbox change; we standardize on support@sei.app as the single inbox.
  </action>
  <verify>
    <automated>grep -c "Cancel or manage subscription" src/renderer/src/screens/CreditsScreen.tsx | grep -q "^[1-9]" && grep -c "Cancel or manage subscription" src/renderer/src/screens/SettingsScreen.tsx | grep -q "^[1-9]" && grep -cE "Manage your Party" src/renderer/src/screens/CreditsScreen.tsx src/renderer/src/screens/SettingsScreen.tsx | grep -q "^[0-9]:0$\|^0$" && grep -c "Cancel or manage your subscription through Lemon Squeezy" src/renderer/src/screens/CreditsScreen.tsx | grep -q "^[1-9]" && grep -c "sei.lemonsqueezy.com/billing" src/renderer/src/screens/SettingsScreen.tsx | grep -q "^[1-9]" && grep -c "sei.lemonsqueezy.com/billing" src/renderer/src/screens/CreditsScreen.tsx | grep -q "^[1-9]" && echo "OK rename + fallback link verified"</automated>
  </verify>
  <done>Both CreditsScreen + SettingsScreen render "Cancel or manage subscription" (zero remaining occurrences of "Manage your Party"). CreditsScreen helper text updated. PROXY_NO_PORTAL_URL branch renders an inline fallback link to https://sei.lemonsqueezy.com/billing in BOTH screens (not a toast).</done>
</task>

<task type="auto" tdd="true">
  <name>Task 6: ReceiptScreen — auto-navigate on subscription activation (FTC Click-to-Cancel)</name>
  <files>src/renderer/src/screens/ReceiptScreen.tsx, src/renderer/src/screens/ReceiptScreen.module.css, src/renderer/src/lib/stores/useUiStore.ts, src/renderer/src/lib/stores/useCreditsStore.ts, src/renderer/src/App.tsx</files>
  <behavior>
    - When useCreditsStore.plan transitions from any non-'unlimited' value to 'unlimited', the app auto-navigates to View kind 'receipt' EXACTLY ONCE per transition.
    - Re-renders with plan still 'unlimited' do NOT re-navigate.
    - ReceiptScreen renders the four required disclosure items: amount ($20.00 charged today), frequency (Billed monthly), next billing date (from renews_at), cancellation steps (Settings → Cloud AI → Cancel subscription).
    - Single CTA "Back to Sei" returns to home.
  </behavior>
  <action>
1. Add `| { kind: 'receipt' }` to the View union in useUiStore.ts.

2. Create ReceiptScreen.tsx + module.css. Subscribe to useCreditsStore renews_at
   via selector. Render:
   - <h1>Welcome to Party!</h1>
   - <p>$20.00 USD charged today.</p>      (PROXY-05 carve-out comment inline)
   - <p>Billed monthly until you cancel.</p>
   - <p>Next billing date: {formatRenewal(renews_at) ?? 'in 30 days'}.</p>
     (formatRenewal helper already exists in CreditsScreen.tsx:62 — copy or
     extract to a shared lib file `src/renderer/src/lib/formatRenewal.ts`
     and import from both places.)
   - <p>Cancel anytime in Settings → Cloud AI → Cancel subscription.</p>
   - <Button kind="primary" onClick={() => navigate({ kind: 'home' })}>Back to Sei</Button>

3. Auto-navigate plumbing. Add the transition guard inside useCreditsStore's
   onStatusUpdate callback (the existing subscription at lines 138-150). Use
   a module-level `let prevPlan: CreditsStatus['plan'] | null = null;` outside
   the store factory. Inside the onStatusUpdate callback, AFTER the set() call:
   ```
   const wasUnlimited = prevPlan === 'unlimited';
   const isUnlimitedNow = status.plan === 'unlimited';
   if (!wasUnlimited && isUnlimitedNow) {
     // Lazy import to avoid a circular dep on useUiStore.
     import('./useUiStore').then(({ useUiStore }) => {
       useUiStore.getState().navigate({ kind: 'receipt' });
     });
   }
   prevPlan = status.plan;
   ```
   ALSO seed prevPlan from the initial creditsGet() seed inside init() — line
   ~177 — so the first push isn't treated as a transition from null.

4. App.tsx: add the `case 'receipt': return <ReceiptScreen />;` arm to the
   view-kind switch (locate by searching for `case 'credits'` and adding the
   parallel arm).

5. CSS: ReceiptScreen.module.css mirrors CreditsScreen.module.css layout
   (BackRow + h1 + section). Reuse the .section + .tile + .tileBody classes
   pattern by importing CreditsScreen styles OR by duplicating the relevant
   rules — pick whichever pattern Phase 13 plans already established for new
   screens (default to duplicate so styles are self-contained).

Test scaffold (vitest): `src/renderer/src/screens/ReceiptScreen.test.tsx` with:
- Renders all four disclosure items.
- "Back to Sei" CTA calls useUiStore.navigate({kind:'home'}).
- Renews_at null falls back to "in 30 days" copy.

Test scaffold: `src/renderer/src/lib/stores/useCreditsStore.test.ts` (extend if
exists; create if not): transition plan='trial' → plan='unlimited' triggers
navigate({kind:'receipt'}) exactly once. Same transition repeated does NOT
re-navigate. Transition plan='unlimited' → plan='unlimited' (no change) does
NOT navigate.

ReceiptScreen.tsx header carve-out comment: "PROXY-05 carve-out: this screen
renders the literal '$20.00' amount in the renderer per FTC 16 CFR §425.5
(plain-language acknowledgement of charges at point of subscription)."
  </action>
  <verify>
    <automated>npx vitest run src/renderer/src/screens/ReceiptScreen.test.tsx src/renderer/src/lib/stores/useCreditsStore.test.ts 2>&1 | tail -10 && grep -c "kind: 'receipt'" src/renderer/src/lib/stores/useUiStore.ts | grep -q "^[1-9]" && grep -c "ReceiptScreen" src/renderer/src/App.tsx | grep -q "^[1-9]" && grep -c "PROXY-05 carve-out" src/renderer/src/screens/ReceiptScreen.tsx | grep -q "^[1-9]" && echo "OK ReceiptScreen wiring + transition guard verified"</automated>
  </verify>
  <done>ReceiptScreen.tsx renders all four required disclosure items. View union extended. Plan transition non-unlimited → unlimited navigates exactly once. Repeat transitions do not re-fire. App.tsx switch handles the new view kind. Tests pass; no regression in existing baseline.</done>
</task>

<task type="auto">
  <name>Task 7: sei-website disclosure + ToS §8 + §13 jurisdiction + TOS_VERSION bump</name>
  <files>../sei-website/index.html, ../sei-website/terms.html, src/shared/legalVersions.ts</files>
  <action>
NOTE: ../sei-website is NOT a git repo (per CLAUDE.md project convention).
Edit those files as filesystem mods; the sei-repo commit covers ONLY
legalVersions.ts. The sei-website commit (if separate repo) is out of scope
for this plan — mirror the 13-22 pattern.

(A) ../sei-website/index.html PARTY pricing card:
    Locate line 313 (the existing `<p class="tier__desc">...~10 hours...</p>`).
    Immediately AFTER that <p>, insert a new line:
    ```html
    <p class="tier__note">Auto-renews monthly. Cancel anytime in app. <a href="./terms.html#subscription-terms">Subscription terms</a></p>
    ```
    Add a `.tier__note` style entry in ../sei-website/css/styles.css (if not
    already present): smaller font (0.85rem), .ink-muted color, top-margin 8px.
    (Inspect the existing .tier__desc class for color/family conventions first.)

(B) ../sei-website/terms.html §8 (Refunds and Cancellations, lines 152-167):
    - Line 165: change `dmca@sei.app` to `support@sei.app` (BOTH the href AND
      the visible text — currently `<a href="mailto:dmca@sei.app">dmca@sei.app</a>`).
    - After the existing "Subscriptions." paragraph (line 159-162), insert a
      NEW paragraph:
      ```html
      <p>
        <strong>Cancel anytime.</strong> Cancel your subscription online by
        opening the Sei app and going to Settings → Cloud AI → Cancel
        subscription. No call, no email, no questions.
      </p>
      ```
    - At the END of §8 (after the "Failed transactions" paragraph, line 172),
      insert a new sub-section:
      ```html
      <h3 id="subscription-terms">Subscription Terms</h3>
      <ul>
        <li><strong>Price:</strong> $20.00 USD per month.</li>
        <li><strong>Billing frequency:</strong> Monthly auto-renewal on the same day each month.</li>
        <li><strong>Cancellation:</strong> Cancel anytime in the Sei app at Settings → Cloud AI → Cancel subscription.</li>
        <li><strong>Refunds:</strong> Unused credits refundable within 14 days; consumed credits non-refundable.</li>
      </ul>
      ```
      (The h3#subscription-terms anchor is the target of the
      index.html `<a href="./terms.html#subscription-terms">` link.)

(C) ../sei-website/terms.html §13 (Governing Law, lines 212-219):
    - Remove the line `<!-- TBD: jurisdiction -->` (line 214).
    - Remove the parenthetical `(Jurisdiction subject to confirmation prior to v1.0 launch.)` from line 218.
    - Append a NEW paragraph immediately after the existing §13 paragraph:
      ```html
      <p>
        Nothing in this section limits any non-waivable rights you have under the
        laws of your state of residence.
      </p>
      ```

(D) ../sei-website/terms.html Effective Date (line 54):
    Change `Effective Date:</strong> 2026-05-23` to `Effective Date:</strong> 2026-05-26`.

(E) src/shared/legalVersions.ts:
    ```
    export const TOS_VERSION = '2026-05-26';
    export const PRIVACY_VERSION = '2026-05-26';
    ```
    Co-bump both per the Phase 11/12 convention (privacy hasn't changed but
    keeping the dates aligned is the established pattern — single
    AcceptToSModal cycle for the user).

    Note: ../sei-website/privacy.html Effective Date does NOT need to change
    in THIS plan (no privacy text changed). The PRIVACY_VERSION bump alone
    forces the renderer re-accept modal, which is the user-facing behavior
    we want; the privacy.html Effective Date line drifting from PRIVACY_VERSION
    by a few days is documented as a known co-bump idiom in 11-CONTEXT D-27.

The commit message for the sei repo MUST mention "(sei-website edits: index.html
PARTY card disclosure, terms.html §8 + §13 + #subscription-terms anchor, Effective
Date 2026-05-26; manually copy to sei.gg deploy)" so the operator knows to deploy
the website separately.
  </action>
  <verify>
    <automated>test -f ../sei-website/index.html && test -f ../sei-website/terms.html && grep -c "tier__note" ../sei-website/index.html | grep -q "^[1-9]" && grep -c "subscription-terms" ../sei-website/index.html | grep -q "^[1-9]" && grep -c "subscription-terms" ../sei-website/terms.html | grep -q "^[1-9]" && grep -c "support@sei.app" ../sei-website/terms.html | grep -q "^[1-9]" && grep -cE "^[^<]*dmca@sei.app" ../sei-website/terms.html | grep -q "^0$" && grep -cE "TBD: jurisdiction" ../sei-website/terms.html | grep -q "^0$" && grep -cE "Jurisdiction subject to confirmation" ../sei-website/terms.html | grep -q "^0$" && grep -c "non-waivable rights" ../sei-website/terms.html | grep -q "^[1-9]" && grep -c "Effective Date:</strong> 2026-05-26" ../sei-website/terms.html | grep -q "^1$" && grep -c "TOS_VERSION = '2026-05-26'" src/shared/legalVersions.ts | grep -q "^1$" && grep -c "PRIVACY_VERSION = '2026-05-26'" src/shared/legalVersions.ts | grep -q "^1$" && echo "OK website + ToS + version bumps verified"</automated>
  </verify>
  <done>../sei-website/index.html PARTY card has the auto-renewal note + link to #subscription-terms anchor. ../sei-website/terms.html §8 uses support@sei.app (zero dmca@sei.app remaining in §8), has new cancellation-method paragraph + #subscription-terms sub-section. §13 has TBD comment + parenthetical removed and the non-waivable-rights paragraph appended. Effective Date is 2026-05-26. TOS_VERSION + PRIVACY_VERSION both bumped to 2026-05-26.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 8: subscription_updated reason_code passthrough + past-due banner</name>
  <files>supabase/functions/lemon-webhook/index.ts, supabase/migrations/20260528000600_apply_lemon_event_rpc.sql, src/shared/ipc.ts, src/main/cloud/proxyClient.ts, src/renderer/src/lib/stores/useCreditsStore.ts, src/renderer/src/screens/SettingsScreen.tsx</files>
  <behavior>
    - When LS sends subscription_updated with attributes.status='past_due', subscription_status.status='past_due' in the DB, my_subscription returns 'past_due', creditsGet returns subscription_status_raw='past_due', useCreditsStore exposes it, SettingsScreen renders a contextual banner above the Cloud AI row.
    - When LS sends subscription_updated with attributes.status='paused', the RPC maps it to 'paused' (NEW — currently collapses to 'past_due'); the renderer surfaces a distinct "Subscription paused" copy.
    - All other status values pass through unchanged (active / cancelled / expired / refunded).
  </behavior>
  <action>
1. Migration: this plan does NOT create a new migration file. Instead, since
   migration 20260528000600 has not been re-applied or amended after its
   initial deployment, and STATE.md notes "Migrations NOT applied to live",
   we EDIT the existing 20260528000600_apply_lemon_event_rpc.sql to:
   (a) Add 'paused' to the v_status whitelist on line 123:
       `when v_status_raw in ('active','cancelled','expired','past_due','refunded','paused')`
   AND create a NEW small migration file `20260528001300_subscription_status_paused.sql`
   that ALTERs the subscription_status table's CHECK constraint to include 'paused'
   (the original CHECK was set in 20260524000000_phase_13_ledger.sql; locate the
   exact constraint name via grep, drop+recreate with 'paused' added to the list).

   RATIONALE for the edit-existing-RPC choice: the apply_lemon_event RPC is
   defined with `create or replace function`, so editing the file content +
   re-running `supabase db push` re-applies the latest definition. The
   subscription_status CHECK constraint, however, is a one-time CREATE — so we
   need the separate migration to alter it. See 20260528001100 for the precedent
   pattern (ALTER TABLE … DROP/ADD CONSTRAINT for an enum-expansion).

2. src/shared/ipc.ts: extend CreditsStatus with
   `subscription_status_raw?: 'active'|'cancelled'|'expired'|'past_due'|'refunded'|'paused'|null;`.
   Extend SubscriptionStatusInfo.status union with `'paused'` and `'refunded'`.

3. src/main/cloud/proxyClient.ts creditsGet(): after the existing my_subscription
   read at line 301-304, populate the new field:
   `subscription_status_raw: (subRow.data?.status as CreditsStatus['subscription_status_raw']) ?? null,`
   Add the field to the returned object at line ~423.

4. src/renderer/src/lib/stores/useCreditsStore.ts: add `subscription_status_raw`
   to the CreditsState interface and to the INITIAL object. Wire through the
   onStatusUpdate callback at line 138 + the seed at line 169 + the refresh
   action at line 195.

5. src/renderer/src/screens/SettingsScreen.tsx: above the existing
   `<span className={styles.rowLabel}>Cloud AI</span>` row (line 384), render a
   conditional contextual banner:
   ```
   const subStatusRaw = useCreditsStore((s) => s.subscription_status_raw);
   const reasonBanner = subStatusRaw === 'past_due'
     ? { text: 'Your payment is past due — update your card', cta: 'Update billing' }
     : subStatusRaw === 'paused'
       ? { text: 'Your subscription is paused', cta: 'Resume in Lemon Squeezy' }
       : null;
   {reasonBanner && (
     <p className={styles.rowHelper} role="alert" style={{color: 'var(--red)'}}>
       {reasonBanner.text} —{' '}
       <button type="button" onClick={() => void cancelSubscription()}>
         {reasonBanner.cta} →
       </button>
     </p>
   )}
   ```
   (cancelSubscription opens the LS customer portal — the same path used for
   the manage button, since the user needs to land in the LS UI either way.)

Tests (vitest):
- src/renderer/src/lib/stores/useCreditsStore.test.ts (extend): subRow with
  status='past_due' → store.subscription_status_raw === 'past_due'.
- src/renderer/src/screens/SettingsScreen.test.tsx (extend OR create): banner
  renders when subscription_status_raw='past_due', does NOT render when 'active'.

Tests (Deno — lemon-webhook): the existing 60/60 test suite already covers
subscription_updated routing; we add ONE new test asserting that 'paused' status
in the payload survives the RPC round-trip (which we mock to capture the args).
File: supabase/functions/lemon-webhook/index.test.ts — add a single Deno.test
that calls applyEvent with a stub admin client and asserts the rpc('apply_lemon_event')
call's p_payload contains attributes.status='paused'.
  </action>
  <verify>
    <automated>npx vitest run src/renderer/src/lib/stores/useCreditsStore.test.ts 2>&1 | tail -5 && cd supabase/functions && deno test --allow-all lemon-webhook/index.test.ts 2>&1 | tail -5 && cd ../../ && grep -c "subscription_status_raw" src/shared/ipc.ts | grep -q "^[1-9]" && grep -c "subscription_status_raw" src/main/cloud/proxyClient.ts | grep -q "^[1-9]" && grep -c "subscription_status_raw" src/renderer/src/lib/stores/useCreditsStore.ts | grep -q "^[1-9]" && grep -c "past due\|past_due" src/renderer/src/screens/SettingsScreen.tsx | grep -q "^[1-9]" && grep -c "paused" supabase/migrations/20260528000600_apply_lemon_event_rpc.sql | grep -q "^[1-9]" && test -f supabase/migrations/20260528001300_subscription_status_paused.sql && echo "OK reason_code passthrough verified"</automated>
  </verify>
  <done>CreditsStatus.subscription_status_raw field wired end-to-end (Edge Function source → my_subscription view → proxyClient → useCreditsStore → SettingsScreen). 'paused' added to RPC whitelist + subscription_status CHECK constraint via new migration. SettingsScreen renders past_due banner with link to cancelSubscription. Tests pass (vitest 368+ baseline preserved; deno baseline 60 + 1 new = 61/61).</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| renderer → main (IPC) | Untrusted args cross via subscription:record-consent |
| renderer → Edge Function | record-consent body carries consent_version (caller-controlled string) |
| LS webhook → Edge Function | subscription_updated payload (already authenticated via HMAC at the existing trust boundary; reason_code is downstream consumption) |
| renderer → shell.openExternal | Customer-portal fallback URL is a hardcoded constant; no caller input |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-sbo-01 | Spoofing | record-consent Edge Function | mitigate | sei_user_id derived from auth.getUser() on the anon-client JWT verification, NEVER from request body (mirrors trial-claim T-13-12-01) |
| T-sbo-02 | Tampering | subscription_consents table | mitigate | Insert-only RLS (zero update/delete policies). Authenticated users INSERT via service_role Edge Function; renderer-direct INSERT path closed by `revoke insert from authenticated` |
| T-sbo-03 | Repudiation | Consent record | mitigate | consent_timestamp default now() server-side (clock-skew-immune); consent_version is the renderer-supplied TOS_VERSION but cross-validated by the renderer being unable to spoof a future version (TOS_VERSION ships in the renderer bundle) |
| T-sbo-04 | Information Disclosure | subscription_consents.ip_hash | accept | ip_hash is OPTIONAL (null when caller doesn't supply); when supplied it's a SHA-256 hash so no raw IP retention. RLS select-own limits exposure to the consenting user |
| T-sbo-05 | Denial of Service | record-consent Edge Function abuse | accept | No rate-bucket on this endpoint (intrinsically slow checkout path; consent INSERT fires at most once per checkout attempt). If abuse surfaces, add a consent_minute bucket in a follow-on migration (precedent: customer_portal_minute in 20260528001100) |
| T-sbo-06 | Elevation of Privilege | service_role JWT leak from record-consent | accept | Service_role JWT is server-side only (Deno.env.get); the Edge Function is the trust boundary mirror of trial-claim and submit-report. Same threat surface; same mitigation |
| T-sbo-07 | Tampering | subscription_status enum expansion ('paused') | mitigate | CHECK constraint added explicitly in 20260528001300_subscription_status_paused.sql; RPC whitelist updated in lockstep |
| T-sbo-08 | Spoofing | shell.openExternal('https://sei.lemonsqueezy.com/billing') fallback | mitigate | URL is a hardcoded constant in the renderer (no caller input). Routes through the existing assertSafeExternalUrl allowlist (260525-s09 H5) which already permits sei.lemonsqueezy.com |
| T-sbo-09 | Information Disclosure | Pre-CTA disclosure dollar amount | accept | Carve-out per CA ARL §17602(a)(1); the dollar amount is published on sei.gg ALREADY, so renderer surface is not a fresh disclosure |
| T-sbo-10 | Repudiation | Auto-navigate to ReceiptScreen race vs. webhook delivery delay | accept | The transition trigger is the client's own credits:status:update push, which already lands within ~2s of the webhook firing per Phase 13 instrumentation. Worst case: a user finishes checkout, the webhook is delayed, plan stays 'trial' for 30s, then flips → ReceiptScreen appears with a slight delay. UX-degraded but functionally correct |
</threat_model>

<verification>

After all 8 tasks complete, run the unified verification sweep:

1. Tests:
   ```
   npx vitest run 2>&1 | tail -10
   # Expect: 368 + ~6 new (AutoRenewalConsentModal 4, ReceiptScreen 3, useCreditsStore transition + subscription_status_raw 2) = ~377/377 pass.

   cd supabase/functions && deno test --allow-all 2>&1 | tail -10
   # Expect: 60 + 1 new (paused passthrough) = 61/61 pass.
   ```

2. TypeScript:
   ```
   npx tsc -p tsconfig.web.json --noEmit
   npx tsc -p tsconfig.node.json --noEmit
   # Expect: clean (apart from the two pre-existing main-side baseline errors
   # noted in 13-02 SUMMARY).
   ```

3. Source-text grep audit (CA ARL §17602(a)(1) compliance):
   ```
   # Pre-CTA disclosure present at both purchase surfaces:
   grep -c "PreCtaDisclosure" src/renderer/src/screens/CreditsScreen.tsx       # expect ≥ 1
   grep -c "PreCtaDisclosure" src/renderer/src/components/HardStopModal.tsx    # expect ≥ 1

   # Consent gate present at both purchase surfaces:
   grep -c "AutoRenewalConsentModal" src/renderer/src/screens/CreditsScreen.tsx       # expect ≥ 1
   grep -c "AutoRenewalConsentModal" src/renderer/src/components/HardStopModal.tsx    # expect ≥ 1

   # "Cancel" appears user-facing:
   grep -c "Cancel or manage subscription" src/renderer/src/screens/CreditsScreen.tsx
   grep -c "Cancel or manage subscription" src/renderer/src/screens/SettingsScreen.tsx
   # Both ≥ 1; legacy "Manage your Party" fully replaced:
   ! grep -E "Manage your Party" src/renderer/src

   # Carve-out comments at every renderer-side dollar-amount site:
   grep -rE "PROXY-05 carve-out" src/renderer/src/components/PreCtaDisclosure.tsx src/renderer/src/components/AutoRenewalConsentModal.tsx src/renderer/src/screens/ReceiptScreen.tsx
   # expect 3 file hits

   # ToS §8 inbox standardized:
   grep -c "support@sei.app" ../sei-website/terms.html      # ≥ 1
   ! grep -E "dmca@sei.app" ../sei-website/terms.html | grep -v "DMCA"

   # ToS §13 TBD removed:
   ! grep -E "TBD: jurisdiction|Jurisdiction subject to confirmation" ../sei-website/terms.html

   # TOS_VERSION + PRIVACY_VERSION + terms.html Effective Date aligned:
   grep -c "2026-05-26" src/shared/legalVersions.ts            # ≥ 2
   grep -c "Effective Date:</strong> 2026-05-26" ../sei-website/terms.html  # = 1
   ```

4. Manual smoke (not gating):
   - Launch a dev build, sign in, click "Join a Party" in CreditsScreen.
   - Verify the PreCtaDisclosure block renders ABOVE the button with the four required lines.
   - Verify clicking the button opens the AutoRenewalConsentModal (NOT the LS checkout directly).
   - Verify checking the box enables "Continue to checkout" which then opens the LS browser page.
   - Verify after the LS webhook fires (or mock by manually updating subscription_status.status='active' via MCP), the app auto-navigates to ReceiptScreen.

</verification>

<success_criteria>
- All 8 tasks committed as atomic commits.
- 368/368 vitest baseline preserved + 6 new tests added = ≥374/374 pass.
- 60/60 deno baseline + 1 new test = 61/61 pass.
- Zero TypeScript regressions (baseline = 2 pre-existing main-side errors).
- Source-grep audit (verification §3 above) returns expected counts.
- ../sei-website/index.html + terms.html edited (filesystem; separate deploy).
- TOS_VERSION + PRIVACY_VERSION bumped to 2026-05-26 in legalVersions.ts.
- New migration 20260528001200_subscription_consents.sql committed (NOT applied to live — operator runs `supabase db push`).
- New migration 20260528001300_subscription_status_paused.sql committed (NOT applied to live).
- New Edge Function supabase/functions/record-consent/ committed (NOT deployed — operator runs `supabase functions deploy record-consent`).
- Apply_lemon_event RPC source updated to include 'paused' in the whitelist (NOT re-applied to live — folded into the same operator deploy step).
</success_criteria>

<output>
After completion, create `.planning/quick/260525-sbo-subscription-compliance-ui-pre-cta-price/260525-sbo-SUMMARY.md` covering:
- All 8 tasks: what shipped, exact file paths, commit hashes.
- The operator deploy checklist (3 things): `supabase db push` (migrations 1200 + 1300 + amended 0600 RPC), `supabase functions deploy record-consent`, copy ../sei-website edits to the sei.gg deploy.
- Carve-out documentation: every renderer-side dollar-amount string is annotated; PROXY-05 verifier (if it exists) MUST be updated to whitelist these sites OR the carve-out comment must be sufficient signal for the audit reviewer. Document which one.
- Known follow-ons not in this plan:
  - No rate-bucket on record-consent (T-sbo-05 accepted; revisit if abuse).
  - PRIVACY_VERSION bumped but ../sei-website/privacy.html Effective Date not changed (D-27 idiom; document explicitly).
  - 'paused' subscription state added to schema + RPC but the renderer-side resume UX is a stub (banner only — full resume flow requires LS webhook hooks that aren't in scope).
</output>
