# Deferred Items — 260525-pbn execution

Items found during execution that are OUT OF SCOPE per the SCOPE BOUNDARY rule
(pre-existing, not caused by this cluster's changes). Surfaced here for a
future cluster to triage.

## Pre-existing `deno check` errors in `lemon-webhook/index.test.ts`

`deno check supabase/functions/lemon-webhook/index.test.ts` reports 3
TS2345 errors at lines 728, 741, 754 — all on `isSubscriptionFirstInvoice`
call sites where the test payload is shaped as
`{ data: { attributes: { first_order_item: { subscription_id, variant_id } } } }`
but the `LemonWebhookPayload.data.attributes` type only declares
`{ status?, renews_at?, ends_at? }`.

Root cause: the 260524-0ka A3 cluster added `first_order_item` payload
narrowing inside the function body (via local cast) without widening the
shared `LemonWebhookPayload` interface. Tests now produce TS errors when
constructing payloads with the new shape.

Fix (out of scope for this cluster): widen `LemonWebhookPayload.data.attributes`
to optionally include `first_order_item?: { subscription_id?, variant_id? }`.

Verified pre-existing: `git stash && deno check ... && git stash pop` shows
the same 3 errors with this cluster's changes reverted.

Reported by: 260525-pbn-EXECUTOR
