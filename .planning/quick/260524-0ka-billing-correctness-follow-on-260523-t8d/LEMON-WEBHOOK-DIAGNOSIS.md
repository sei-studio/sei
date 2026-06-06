# LEMON-WEBHOOK-DIAGNOSIS — `order_created` disambiguator for subscription-first-invoice vs one-time pack

**Quick:** 260524-0ka
**Item:** A (Lemon Squeezy webhook double-grants on subscription purchase)
**Owner:** quick-task executor
**Status:** analysis complete — Adopted check ready for Task 2

---

## 1. Observed evidence

Live UAT evidence (provided in the dispatch prompt's `<observed_evidence>` block;
cross-verified against the surgically-refunded ledger for `[operator account — redacted]`):

| Scenario | Events fired (within ~60s) | Grants inserted | Total credited | Charged | Over-credit |
|----------|----------------------------|-----------------|----------------|---------|-------------|
| 1× Quest one-time ($4.75) | `order_created` | 1 × `pack` ($4.75) | $4.75 | $4.75 | $0.00 (correct) |
| 1× Party subscription ($18.50) | `order_created` → `subscription_created` → `subscription_payment_success` | 3 grants: $4.75 `pack` + $18.50 `sub` + $18.50 `sub` | **$41.75** | $18.50 | **+$23.25 (2.26×)** |

Root cause is split across **TWO** wrong code paths:

1. **A1 (joint fallthrough):** `case 'subscription_created':` falls through into
   `case 'subscription_payment_success':` (`supabase/functions/lemon-webhook/index.ts:266-285`).
   Both events fire for a brand-new sub purchase, so the same $18.50 grant
   inserts twice (under distinct `lemon_event_id` values, so the 23505
   idempotency dedup does NOT save us). This produces the second $18.50.
2. **A3 (order_created always-grants):** `case 'order_created':`
   (`index.ts:254-265`) inserts a $4.75 `pack` grant **unconditionally** —
   including when the order is the first-invoice of a subscription. This
   produces the spurious $4.75.

A1 fix is structural (split the case body). A3 fix needs a payload-derived
predicate to distinguish "first-invoice of a sub" from "true one-time pack
order" — both arrive as `order_created`.

---

## 2. Lemon Squeezy payload reference

WebFetch'd `https://docs.lemonsqueezy.com/api/orders` (the canonical Order
object reference). The page is a Next.js SPA so most JSON fixtures don't
render through `curl`, but the field index renders fine. Confirmed-present
fields on the Order object's `data.attributes`:

| Field | Type | Reliability for disambiguator | Notes |
|-------|------|-------------------------------|-------|
| `first_order_item` | object | **HIGH** — official "first Order Item of this order" reference | Per LS docs: "An object representing the first [Order Item](https://docs.lemonsqueezy.com/api/order-items/the-order-item-object) belonging to this order." The Order Item object has a `subscription_id` attribute that is **non-null when the order line is part of a subscription**, and a `variant_id` we can match against `LEMON_VARIANT_SUBSCRIPTION`. |
| `first_subscription_item` | (not documented on Order) | — | Despite the plan hypothesis listing this name, the LS docs only mention `first_order_item` on the Order object. `first_subscription_item` appears on the **Subscription** object, not the Order object. We will not depend on it for `order_created` payloads. |
| `variant_ids` / `variant_id` on top-level | — | Not on the Order object root — only inside `first_order_item` | Same access path as above. |
| `subtotal_usd` (cents) | int | LOW — heuristic only | A user who buys a Quest pack ($4.75) and a Party sub ($18.50) on the same checkout would defeat any cents-based comparison. Reject this option for correctness reasons. |

### Cross-check against `lemon_subscription_id` on `subscription_created` / `_payment_success`

Both subscription events carry `data.id` = the LS subscription id. If the
`order_created` payload's `first_order_item.subscription_id` matches the
subscription that was just created, we have airtight disambiguation. In
practice we don't need cross-event correlation — the presence of
`first_order_item.subscription_id` ALONE is the signal.

---

## 3. Adopted check

```ts
/**
 * 260524-0ka A3 disambiguator: returns true when an `order_created` payload
 * represents the first-invoice of a subscription (in which case the
 * subscription-tier grant is owned by the subsequent `subscription_payment_success`
 * event and this `order_created` must NOT insert a pack grant).
 *
 * Two-tiered check (in priority order):
 *
 *   1. Payload-native: `data.attributes.first_order_item.subscription_id` is
 *      non-null. LS docs (`/api/orders` Order object reference, fetched
 *      2026-05-24) describe `first_order_item` as the first Order Item of
 *      the order. The Order Item's `subscription_id` is populated ONLY for
 *      lines that belong to a subscription — non-subscription pack
 *      purchases leave it null.
 *
 *   2. Env-based fallback: `data.attributes.first_order_item.variant_id`
 *      matches `LEMON_VARIANT_SUBSCRIPTION` (set in the Edge Function env).
 *      Used when (1) is null/absent — e.g. for older webhook deliveries or
 *      payload-shape edge cases. Variant-id match is the defense-in-depth
 *      backstop.
 *
 * LS test mode + live mode webhooks share the same payload shape — no
 * test-vs-live caveat applies HERE (the LEMON_SQUEEZY_API_KEY's
 * test-vs-live mode caveat is documented separately in
 * `proxy/src/billing/customerPortal.ts`).
 *
 * Returns FALSE on parse error (defensive — a malformed payload should NOT
 * skip the pack grant, since a legitimate one-time pack buyer would then be
 * un-credited).
 */
export function isSubscriptionFirstInvoice(payload: LemonWebhookPayload): boolean {
  const item = (payload?.data?.attributes as unknown as {
    first_order_item?: { subscription_id?: string | number | null; variant_id?: string | number | null };
  } | undefined)?.first_order_item;
  if (!item) return false;
  // Tier 1: payload-native subscription_id presence on the first order item.
  if (item.subscription_id != null && String(item.subscription_id).length > 0) {
    return true;
  }
  // Tier 2: env-based variant match (defense-in-depth).
  const subVariantEnv = Deno.env.get('LEMON_VARIANT_SUBSCRIPTION');
  if (subVariantEnv && item.variant_id != null) {
    if (String(item.variant_id) === subVariantEnv) return true;
  }
  return false;
}
```

The helper is **exported** so Task 2's regression tests can drive it
directly without round-tripping through `applyEvent`.

The `LemonWebhookPayload` interface in `index.ts` types `data.attributes`
as `{ status?, renews_at?, ends_at? }` today — we don't widen that public
interface in Task 2 (would ripple through every test), we just narrow
inside the helper via `as unknown as { first_order_item?... }`. Acceptable
because the predicate is the only consumer.

---

## 4. Telemetry plan

When the gate fires (i.e. an `order_created` is correctly skipped because
it's a subscription first-invoice), the handler logs:

```ts
console.log('lemon-webhook skipped order_created (subscription first invoice)', {
  eventId, userId,
});
```

This lets us verify in production logs (Supabase Edge Function logs) that
the gate is working as intended. If we see `skipped order_created` log
lines accompanied by subsequent `subscription_payment_success` grants for
the same `userId`, the fix is functioning.

If we see `order_created` flows that DON'T log `skipped` and DO grant a
$4.75 pack, AND there is no later `subscription_payment_success` for the
same user — those are pure one-time pack purchases, the desired behavior.

If we see `order_created` flows that DON'T log `skipped` and DO grant a
$4.75 pack, AND ARE followed by a `subscription_payment_success` — the
gate failed (variant_id env not set, payload shape changed, etc.) and we
need to revisit the disambiguator.

---

## 5. Test-mode-vs-live considerations

`LEMON_VARIANT_SUBSCRIPTION` and `LEMON_VARIANT_PACK` may differ between
test mode and live mode (LS issues distinct variant IDs per mode). The
Edge Function reads `LEMON_VARIANT_SUBSCRIPTION` at request time via
`Deno.env.get` — operator must set the correct value for the deployed
mode. The Tier 1 payload-native check (`first_order_item.subscription_id`)
is mode-agnostic and works regardless of which variant IDs are set; the
Tier 2 fallback only matters if Tier 1 returns null for legitimate
subscription orders, which we don't currently expect from LS.

---

## 6. Disposition

- Predicate is concrete + ready to paste into `applyEvent`.
- Tier 1 (payload-native) is correctness-first; Tier 2 (env match) is
  defense-in-depth.
- A1 (split case body) and A3 (gate) are independent fixes — landing only
  A1 still leaves the spurious $4.75 from A3; landing only A3 still leaves
  the duplicate $18.50 from A1. Task 2 ships BOTH.
- A4 regression tests cover all four shapes (3-event Party sequence,
  one-time Quest, recurring renewal, `subscription_created` alone).
