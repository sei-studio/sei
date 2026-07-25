# SPEC: weekly subscription model (v0.5)

Status: locked 2026-07-24. This document is the shared contract for four
parallel workstreams (client, proxy+SQL, Polar, website). Do not diverge from
the numbers or the contract below without updating this file first.

Replaces: pay-as-you-go credit packs + one-time trial + `$5/day` rate cap.

---

## 1. Plans

| Tier | id | Price | Weekly allowance | Credits/wk | Positioning |
|---|---|---|---|---|---|
| Free | `free` | $0 | $0.50 | 100 | default, no signup step beyond an account |
| Quest | `quest` | $8/mo | $4.00 | 800 | casual texting and calling |
| Party | `party` | $18/mo | $12.00 | 2,400 | heavier chatting and gaming |

Every account is on `free` unless an active subscription says otherwise.

### Credits

A credit is a display unit only. **1 credit = 5,000 µ$ = $0.005**, i.e. **200
credits per granted dollar**. The backend stores and meters micro-dollars
throughout; `credits` exists so the UI never shows money.

### Top ups (one-time, non-expiring)

| SKU | Price | Granted | Credits | Advertised as |
|---|---|---|---|---|
| `topup_small` | $5 | $4.00 | 800 | 800 credits |
| `topup_large` | $20 | $18.00 | 3,600 | 3,200 + 400 bonus |

Top up credits are a separate bucket from the weekly allowance. They do not
expire and do not reset.

### Tunability

Allowances and grants live in Postgres config tables (`plan_config`,
`topup_config`), not in code constants, so they can be retuned without a client
or proxy release.

---

## 2. Semantics

### Weekly window

Derived, not scheduled. No cron job.

```
period_start = account.created_at + floor((now - account.created_at) / 7 days) * 7 days
resets_at    = period_start + 7 days
```

Each account therefore has its own stable weekly boundary anchored to its
signup day, and the window advances on its own.

### Usage

```
effective_start = GREATEST(period_start, last_reset_at)
allowance_used  = SUM(consumption WHERE created_at >= effective_start
                                    AND source_bucket = 'allowance'
                                    AND reservation_state IN ('reserved','settled'))
usage_pct       = MIN(100, allowance_used * 100 / weekly_allowance)
```

### Resets

A "reset" stamps `last_reset_at = now()`. Because `resets_at` derives from
account creation, **a reset never moves the reset date**. That is the whole
mechanism.

| Event | Resets usage | Moves reset date |
|---|---|---|
| Weekly boundary passes | yes (implicitly) | yes, advances 7 days |
| Feedback submitted (once per account) | yes | no |
| Upgrade to a higher tier | yes | no |
| Downgrade | no | no |

**Anti-gaming:** an upgrade only resets when the new tier's rank exceeds
`max_tier_rank_this_period`. Downgrading and re-upgrading within one window
grants no second reset.

### Spend order

1. Weekly allowance, until `allowance_used >= allowance`.
2. Slight overage is permitted. A call that begins while any allowance remains
   is charged to the allowance in full, even if it crosses the line. There is
   no reserve held back and no minimum-balance refusal.
3. Extra credits, if any remain.
4. Otherwise 402, which surfaces as the hard stop.

Overage is absorbed at the weekly boundary. No deficit carries forward.

### Nothing stacks

Unused weekly allowance is lost at the boundary. Only top up credits persist.

---

## 3. Metering

| Route | Metered | Rate |
|---|---|---|
| `/v1/messages` | yes, reserve + settle on actual usage | Anthropic list price |
| `/tts/speech` | **no, 0 for now** | `TTS_MICRO_PER_CHAR`, env-overridable, default `0` |
| `/stt/transcribe` | **no, 0 for now** | `STT_MICRO_PER_SECOND`, env-overridable, default `0` |
| `/generate/*` | no | daily count cap only, unchanged this pass |

Voice is unmetered because ElevenLabs is currently covered by a startup grant.
The gates stay fully wired: when the rate is `0` the ledger reservation is
skipped and the request is marked unmetered, so restoring metering is a single
Fly secret (`TTS_MICRO_PER_CHAR=100`, `STT_MICRO_PER_SECOND=120`) with no code
change and no redeploy of client or SQL.

Known consequence: voice usage is now bounded only by the IP/rate gates, not by
credits. Accepted for now.

---

## 4. Contract

### `CreditsStatus` (src/shared/ipc.ts)

```ts
export type PlanTier = 'free' | 'quest' | 'party';

export interface CreditsStatus {
  plan: PlanTier;
  /** 0..100, weekly allowance only, clamped. 100 renders red. */
  usage_pct: number;
  /** Allowance exhausted AND no extra credits left. Drives the hard stop. */
  over_limit: boolean;
  /** ISO timestamp the weekly allowance rolls over. */
  resets_at: string;
  /** Top up bucket, in credits (not µ$). Both 0 when never topped up. */
  extra_credits_used: number;
  extra_credits_total: number;
  /** Billing, subscribers only. */
  renews_at: string | null;
  ends_at: string | null;
  subscription_status_raw: 'active' | 'cancelled' | 'expired' | 'past_due' | null;
  ai_backend_kind: 'local' | 'cloud-proxy';
}
```

**Removed:** `remaining_pct`, `remaining_tokens`, `trial_claimed`, `used_usd`,
`total_usd`, and the old `plan` values `trial | pack | unlimited | depleted`.
Callers that used `remaining_pct` derive `100 - usage_pct`; the hard stop's
auto-dismiss gates on `!over_limit`.

### Checkout

```ts
CreditsCheckoutArgsSchema = z.object({
  kind: z.enum(['quest', 'party', 'topup_small', 'topup_large']),
});
```

New IPC `credits:change-plan` → `creditsChangePlan(tier: PlanTier)` for
upgrade and downgrade of an existing subscription (a Polar subscription update,
not a fresh checkout).

Removed IPC: `trial:claim` and `claimTrial` end to end.

### Feedback

`FeedbackSubmit` response field `reward_granted` → `usage_reset`.

---

## 5. Workstreams

### A. Proxy + SQL (`sei-proxy`)

- Migration: `plan_config`, `topup_config` seeded with section 1.
- Migration: `subscription_status.tier`, `usage_periods(user_id,
  last_reset_at, max_tier_rank, period_anchor)`.
- Migration: `ledger_consumption.source_bucket` (`allowance` | `extra`),
  defaulting existing rows to `allowance`.
- Rewrite `reserve_credits` for the section-2 spend order. Return the chosen
  bucket.
- New `my_plan` view (security_invoker, self-filtering) returning exactly the
  section-4 fields.
- `apply_polar_event`: map 4 products to tier changes and topup grants; drive
  grant amounts from `topup_config`, not literals.
- Upgrade reset + feedback reset RPCs, with the `max_tier_rank` guard.
- `claim_feedback_reward` becomes a usage reset, not a grant.
- `ttsGate` / `sttGate`: env-overridable rates defaulting to 0, skip the
  reservation when 0, mark the request unmetered so `forward.ts` does not log a
  missing-reservation error.
- Data migration: convert every existing `ledger_balance` remainder to a
  `kind='topup'` grant (extras) at face value, retire prior grant rows, cancel
  the operator's test subscription.
- Remove the `daily_dollar` rate bucket path.

### B. Client (`sei`, branch `feat/v05-subscriptions`)

- `src/shared/ipc.ts` to the section-4 contract.
- `proxyClient.creditsGet()` reads `my_plan`; delete `MICRO_PER_TOKEN_BLENDED`,
  `TRIAL_DAILY_CAP`, `SUB_DAILY_CAP`, `MIN_PLAYABLE_BALANCE_MICRO`.
- `CreditsScreen`: hero `{pct}% used` going red at 100 with a `Resets {date}`
  sub-line; extra credits row (bar, `x / y extra credits used`, Top up button);
  three plan cards Free/Quest/Party with the current plan highlighted and
  Upgrade/Downgrade actions.
- New `TopUpModal` with the two packages.
- `PercentBar`: over-limit red state, muted variant for the second bar.
- `HardStopModal`: single state, gated on `over_limit`, CTAs Upgrade and Top up.
- `FeedbackRewardCard` / `FeedbackModal`: reward copy becomes a usage reset.
- `PreCtaDisclosure`, `AutoRenewalConsentModal`, `ReceiptScreen`: tier-aware
  prices ($8.00 / $18.00). These keep dollar amounts, CA ARL and FTC require it.
- Delete `playtimeEstimate.ts` + test; strip both call sites (`IconRail`
  tooltip, `SettingsScreen`).
- `SettingsScreen`: remove the Playtime row and the "~Xh left" language.
- `OnboardingScreen`: remove the trial-claim path.
- `botSupervisor`: remove `daily_limited_until` and the minimum-balance summon
  gate; refuse only on `over_limit`.
- `characterSchema.ts`: drop `daily_limited_until`.
- Tests: update `SettingsScreen.test`, `UsageBar.test`, `useCreditsStore.test`,
  `proxyClient.test`; delete `playtimeEstimate.test`.

### C. Polar — DONE 2026-07-24

Four products created and verified live in the Sei Studio org. Seed
`plan_config` / `topup_config` with these ids:

| Product | Polar id | Type |
|---|---|---|
| Quest $8/mo | `2f175fc9-17e2-41b5-a44b-18f188613cb2` | subscription |
| Party $18/mo | `9177dcc1-4cb8-4653-ad5a-f1b06d590d97` | subscription |
| 800 Credits $5 | `f386dde6-84ad-41c5-9375-edf266e95f6c` | one-time |
| 3600 Credits $20 | `df4236ce-ab85-42a1-a426-338620ed6284` | one-time |

The two OLD products are still ACTIVE and must stay that way until release:
v0.4.7 is live in the wild and its checkout maps to them, so archiving now
breaks purchasing for existing users.

| Old product | Polar id | Retire at release |
|---|---|---|
| Party $20/mo | `86984287-4fe6-4709-8740-031f5f24ce0c` | archive |
| Quest $5 one-time | `3f15c623-4b58-4366-b8e2-1696d87b09e0` | archive |

`apply_polar_event` must therefore keep handling the two old product ids for as
long as old clients exist, mapping them to the closest new equivalent.

### D. Website (`/Users/ouen/slop/sei-website`)

Pricing section to the three tiers, no time estimates, no per-usage cost
language. `version.json` bumped on release, not before.

---

## 6. No user-facing copy uses an em dash

Project rule. Applies to every string in workstreams B and D.

## 7. Deployment is gated

All four workstreams produce committed changes only. Nothing is applied to the
production database, deployed to Fly, pushed to the website, or made live in
Polar until the whole set is reviewed together.

## 8. Accepted risks

- At full burn both paid tiers are loss-making (Quest −$10.28/mo, Party
  −$35.54/mo, Free −$2.17/mo). Breakeven utilization is 41% and 32%. Decided by
  the operator with the numbers in hand.
- Voice is off-ledger and unbounded while the startup grant lasts.
- Image, portrait and skin generation remain unmetered, bounded only by a daily
  count. Free tier carries this cost.
- The large top up nets $0.50 after Polar fees.
