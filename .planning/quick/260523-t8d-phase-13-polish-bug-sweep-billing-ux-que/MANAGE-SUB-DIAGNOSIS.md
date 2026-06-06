# ITEM 8 — Manage Subscription Diagnosis

## Reproduction

1. Sign into a Sei account that has an ACTIVE (test-mode) Lemon Squeezy
   subscription — `subscription_status.status === 'active'` in Supabase.
2. Open the renderer → Settings (or Credits screen).
3. Click "Manage your Party" (renamed from "Manage subscription" in ITEM 3 of
   this quick task; underlying handler is still `cancelSubscription()`).
4. Observe: the system browser opens `https://sei.lemonsqueezy.com/billing`.
5. Lemon Squeezy renders a generic storefront / login page — NOT a per-user
   customer-portal view. The user has no way to manage their specific
   subscription from here.
6. In live mode the same URL would land on the live-storefront billing root
   (also generic) — but the test-mode subscription is invisible at the live
   URL anyway, so for the user's reported case "still on test mode" the
   problem compounds: the URL is BOTH wrong-mode AND non-personalized.

## Root Cause: LS-test-vs-live

`src/main/cloud/proxyClient.ts:404` hardcodes a single LS URL —
`https://sei.lemonsqueezy.com/billing`. This URL is:

1. **Live-mode only.** Lemon Squeezy test-mode subscriptions live under a
   separate `?test=1`-flagged surface; the live-mode `/billing` root has no
   visibility into test-mode subscription rows. The user's test-mode
   subscription is invisible at this URL even after they sign in.
2. **Not a customer portal.** Lemon Squeezy's actual per-customer portal URL
   is a signed token returned by the LS API as
   `subscription.attributes.urls.customer_portal` (and similar `update_payment_method`
   on the same response). Hitting the generic storefront `/billing` page only
   shows the user a sign-in form — no subscription management surface.

The compound nature of these two failures is why the user perceived the
button as "doesn't work, possibly because still on test mode": the test/live
mismatch is the most-visible symptom, but the underlying wiring bug
(hardcoded non-portal URL) would have failed the same way even in live
mode.

Other hypotheses ruled out:
- **customer-portal** (LS dashboard toggle): Sei's billing module already
  receives `subscription_created` webhooks (lemon-webhook/index.ts handles
  them), so the customer-portal feature on the LS dashboard is implicitly
  enabled — the per-subscription portal token IS being generated, we're
  just not fetching it.
- **wiring-bug** (IPC handler throws): the renderer call flow is intact —
  `subscriptionCancel` IPC → `proxyClient.cancelSubscription()` → returns
  `{ok: true, portalUrl}`, and the renderer's openExternal IS firing (the
  browser opens). The failure is in WHAT URL gets passed, not the wiring.
- **missing-customer-id** (race): irrelevant given the URL is hardcoded —
  we never reference any customer_id in the cancelSubscription flow today.
  This becomes relevant for the FIX (Step B): the proper portal-URL
  fetcher needs the LS subscription id, which the webhook DOES populate on
  the `subscription_status` row.

## Fix

Two-part fix:

1. **proxy/src/billing/customerPortal.ts (NEW)** — helper that, given a
   Supabase JWT, fetches the user's active LS subscription id from
   `subscription_status`, calls the LS API
   `GET /v1/subscriptions/{id}` with the proxy's
   `LEMON_SQUEEZY_API_KEY` server-side, and extracts
   `attributes.urls.customer_portal`. Returns the signed portal URL the
   browser can hit directly.

   The LS API call MUST run server-side (on the proxy) because
   `LEMON_SQUEEZY_API_KEY` is a write-scoped secret — we never ship it to
   the renderer or main process. We add a thin `/billing/customer-portal`
   route on the Fly.io proxy that authenticates via the user's Supabase
   JWT, looks up their subscription id, calls the LS API, and returns the
   portal URL.

2. **src/main/cloud/proxyClient.ts:cancelSubscription()** — replace the
   hardcoded `https://sei.lemonsqueezy.com/billing` with a call to the
   new proxy `/billing/customer-portal` route. If the proxy returns no
   portal URL (subscription id missing, LS API error, test-mode + LS
   creds mismatched), surface a `PROXY_NO_PORTAL_URL` error code so the
   renderer shows a "Couldn't open the billing portal. Email
   support@sei.app." toast.

3. **src/renderer/src/screens/SettingsScreen.tsx** — handle the new
   `PROXY_NO_PORTAL_URL` code with the support-email toast.

## Gating Condition

LS test mode is a known limitation: the customer-portal flow only works
end-to-end in LIVE mode because LS test-mode subscriptions return portal
URLs of the form `https://app.lemonsqueezy.com/billing/test/<token>`
which 404 without an active TEST-mode session cookie in the user's
browser. The proxy environment variable that gates this is `LEMON_MODE`
(`test` | `live`) — production deployments point at `live` and use the
live LS API key.

For test-mode dev environments, the workaround is documented: open the
Lemon Squeezy dashboard manually with a test-mode session, find your
subscription, click "Customer portal" in the LS UI. This is acceptable
since test-mode users are exclusively developers + QA, not real
customers.

## Implementation Notes (for the Step B commit)

- The new proxy route reuses the existing JWT verification middleware
  (`proxy/src/middleware/auth.ts` or similar — wherever
  `/v1/messages` validates the Supabase JWT).
- The LS API key (`LEMON_SQUEEZY_API_KEY`) is already configured on the
  proxy for the webhook signature verification path; we don't need a
  new secret.
- Conservative: if the user has no `subscription_status` row OR
  `subscription_status.status !== 'active'`, the proxy returns 404 →
  renderer maps to `PROXY_NO_PORTAL_URL` toast. The renderer already
  hides the "Manage your Party" button unless `plan === 'unlimited'`
  (which derives from `subscription_status.status === 'active'`), so
  this branch is defense-in-depth only.
