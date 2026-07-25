/**
 * Phase 13 — proxy client (main-process only).
 *
 * MAIN PROCESS ONLY — do not import from renderer (mirrors the Phase 10/11
 * invariant in `src/main/auth/supabaseClient.ts:1-11` and
 * `src/main/cloud/cloudCharacterClient.ts:1-11`). Renderer goes through the
 * IPC handlers in `src/main/ipc.ts` which lazy-import this module.
 *
 * Surface — typed methods:
 *   - creditsGet()                   → reads the `my_plan` view (plan, weekly
 *                                       usage_pct, over_limit, resets_at, the
 *                                       extra-credits bucket, billing dates)
 *                                       plus the local apiKeyStore backend kind.
 *   - openCheckout(kind)             → asks the proxy to mint a Polar (Merchant
 *                                       of Record) checkout session URL, then
 *                                       RETURNS the allowlist-validated URL (the
 *                                       main IPC handler opens it in the system
 *                                       browser).
 *   - changePlan(tier)               → 260724: upgrade/downgrade an EXISTING
 *                                       subscription via the proxy (Polar
 *                                       subscription update).
 *   - subscriptionStatus()           → reads subscription_status table via
 *                                       supabase-js (RLS scopes to user).
 *   - cancelSubscription()           → opens the Polar customer portal externally
 *                                       (open-question resolution #5).
 *
 * Invariants:
 *   - Every method returns the PROXY_NO_SESSION code on no session (never throws).
 *   - Edge Function calls go through `callEdgeFunction` (15s timeout + AbortController
 *     reused from Phase 10).
 *   - Checkout + portal URLs are minted SERVER-SIDE by the proxy (the
 *     write-scoped Polar token never reaches the client) and validated against
 *     the externalUrlValidator allowlist before use.
 *   - No pricing, allowance or grant constants live here. The weekly-allowance
 *     model (260724) keeps every tunable number in Postgres (`plan_config`,
 *     `topup_config`) and hands the client a fully derived snapshot via the
 *     `my_plan` view — so allowances can be retuned without a client release.
 *
 * Source:
 *   - .planning/quick/260724-sub-weekly-subscription-model/SPEC.md (§4 contract)
 *   - Polar migration (2026-06): checkout/portal sessions are proxy-minted
 *
 * Related: `src/main/auth/edgeFunctionClient.ts` (POST wrapper with timeout),
 *          `src/main/auth/supabaseClient.ts` (singleton SupabaseClient),
 *          `src/main/apiKeyStore.ts` (getAiBackendKind for credits gating),
 *          `src/main/cloud/proxyErrors.ts` (sentinel vocabulary).
 */

import { shell } from 'electron';
import { callEdgeFunction } from '../auth/edgeFunctionClient';
import { getClient, getAuthedClient } from '../auth/supabaseClient';
import {
  PROXY_NO_SESSION,
  PROXY_NETWORK,
  PROXY_NO_PORTAL_URL,
  PROXY_RATE_LIMITED,
  type ProxyErrorCode,
} from './proxyErrors';
import type { CreditsStatus, PlanTier, SubscriptionStatusInfo } from '../../shared/ipc';

/** Proxy base URL. `SEI_PROXY_URL` overrides for self-hosters / dev. */
const PROXY_BASE = process.env.SEI_PROXY_URL ?? 'https://api.sei.gg';

/**
 * Resolve the current Supabase session, or null if the user isn't signed in.
 * All five methods consult this first and short-circuit with PROXY_NO_SESSION
 * when null — never throws, never logs the JWT (T-13-13-03).
 */
async function getSessionOrNull(): Promise<{ jwt: string; userId: string } | null> {
  const supabase = getClient();
  const { data } = await supabase.auth.getSession();
  if (!data.session) return null;
  return { jwt: data.session.access_token, userId: data.session.user.id };
}

/**
 * Snapshot the plan + weekly-usage state for the current user (260724).
 *
 * Reads two sources in parallel (Promise.all):
 *   1. `my_plan` (view, security_invoker, self-filtering by auth.uid()) → every
 *      section-4 field: plan, usage_pct, over_limit, resets_at,
 *      extra_credits_used / extra_credits_total, renews_at, ends_at,
 *      subscription_status_raw.
 *   2. `apiKeyStore.getAiBackendKind()` → local | cloud-proxy (UI gate, D-57).
 *
 * The client does NO arithmetic: allowances, the weekly window and the spend
 * order all live in Postgres so they can be retuned without a client release.
 * Unknown / missing values fall back to the free-tier placeholder below.
 *
 * No session → return the placeholder with the REAL persisted backend kind.
 * The renderer should not mount the plan surface anyway when
 * ai_backend_kind === 'local' (D-57).
 */
export async function creditsGet(): Promise<CreditsStatus> {
  // 260703: report the REAL persisted backend kind, not a hardcoded 'local'.
  // This snapshot is the renderer's sole source for the ACCOUNT MODE surface
  // (useCreditsStore.ai_backend_kind → SettingsScreen); a hardcoded placeholder
  // made a transient getSession() miss paint a cloud-proxy profile as BYOK,
  // while every actual LLM call kept reading config.json and spending cloud
  // credits. Best-effort: a config read failure falls back to the schema default.
  async function backendKind(): Promise<CreditsStatus['ai_backend_kind']> {
    try {
      const { getAiBackendKind } = await import('../apiKeyStore');
      return await getAiBackendKind();
    } catch {
      return 'local';
    }
  }

  const session = await getSessionOrNull();
  if (!session) {
    return {
      plan: 'free',
      usage_pct: 0,
      over_limit: false,
      resets_at: '',
      extra_credits_used: 0,
      extra_credits_total: 0,
      renews_at: null,
      ends_at: null,
      subscription_status_raw: null,
      ai_backend_kind: await backendKind(),
    };
  }

  // Authenticate the RLS-scoped read with the user's JWT (the ambient singleton
  // session is not reliably applied to PostgREST requests in the main process —
  // see getAuthedClient). Without this the read resolves against an anonymous
  // caller (auth.uid() = null) and returns no row, so the screen would paint a
  // signed-in account as a brand-new free one.
  const supabase = getAuthedClient(session.jwt);
  const [planRow, kind] = await Promise.all([
    supabase
      .from('my_plan')
      .select(
        'plan,usage_pct,over_limit,resets_at,extra_credits_used,extra_credits_total,renews_at,ends_at,subscription_status_raw',
      )
      .maybeSingle(),
    backendKind(),
  ]);

  const row = (planRow.data ?? {}) as Partial<CreditsStatus>;
  const tier: PlanTier =
    row.plan === 'quest' || row.plan === 'party' ? row.plan : 'free';

  return {
    plan: tier,
    // Clamp defensively: the view already clamps, but a bad row must never
    // paint a fill wider than the track.
    usage_pct: clampPct(row.usage_pct),
    over_limit: row.over_limit === true,
    resets_at: typeof row.resets_at === 'string' ? row.resets_at : '',
    extra_credits_used: toCount(row.extra_credits_used),
    extra_credits_total: toCount(row.extra_credits_total),
    renews_at: row.renews_at ?? null,
    ends_at: row.ends_at ?? null,
    subscription_status_raw: row.subscription_status_raw ?? null,
    ai_backend_kind: kind,
  };
}

/** 0..100, rounded. Non-numeric input reads as 0. */
function clampPct(n: unknown): number {
  const v = typeof n === 'string' ? Number(n) : n;
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, Math.round(v)));
}

/** Non-negative integer credit count. Postgres bigints can arrive as strings. */
function toCount(n: unknown): number {
  const v = typeof n === 'string' ? Number(n) : n;
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  return Math.max(0, Math.round(v));
}

/**
 * Pre-flight summon gate: resolves `true` ONLY when a signed-in account is on
 * the cloud-proxy backend AND is OVER LIMIT (weekly allowance spent and no
 * extra credits left). The bot supervisor consults this before forking a cloud
 * bot and refuses to summon when it is `true`, so a user whose next call would
 * 402 never joins the world only to have the bot leave immediately.
 *
 * 260724: this is now the ONLY summon-time refusal. The old minimum-balance
 * heuristic is gone — the server decides, and a slight overage is allowed by
 * design (a call that starts with any allowance left is charged in full).
 *
 *   - No session (signed out)        → `false`. A signed-out user's cloud calls
 *     401, not 402; that path is owned by the JWT-null flow.
 *   - BYOK backend ('local')         → `false`. BYOK never spends the allowance.
 *   - Any read error                 → `false` (fail-OPEN). A transient Supabase
 *     blip must never wrongly block a paying user from summoning.
 */
export async function cloudOverLimit(): Promise<boolean> {
  try {
    const session = await getSessionOrNull();
    if (!session) return false;
    const { getAiBackendKind } = await import('../apiKeyStore');
    if ((await getAiBackendKind()) !== 'cloud-proxy') return false;
    const status = await creditsGet();
    return status.over_limit;
  } catch {
    return false;
  }
}

/**
 * Mint + validate the Polar hosted checkout URL, then RETURN it to the caller.
 *
 * The checkout session is minted SERVER-SIDE by the proxy's POST
 * /billing/checkout route: the proxy maps `kind` → Polar product id and stamps
 * the JWT-verified `user_id` into the session metadata (so the polar-webhook
 * can attribute the purchase). The write-scoped Polar token never reaches the
 * client. We then validate the returned URL against the externalUrlValidator
 * allowlist (T-uv9-01) — so a compromised proxy or MITM cannot redirect the
 * user to an arbitrary URL.
 *
 * This function does not open anything itself: it returns the allowlist-
 * validated URL and the main IPC handler (src/main/ipc.ts credits.openCheckout)
 * opens it in the user's SYSTEM BROWSER via shell.openExternal (260603 reverted
 * the brief 260602-uv9 in-app popup BrowserWindow back to the system browser).
 * The cancelSubscription / customer-portal flow also uses shell.openExternal.
 *
 * The renderer can only supply the `kind` enum (Zod-validated at the IPC
 * boundary, 13-02).
 *
 * Returns `{ ok: true, url }` on success; `{ ok: false, code }` on no session,
 * network failure, or a non-allowlisted URL.
 */
export async function openCheckout(
  kind: 'quest' | 'party' | 'topup_small' | 'topup_large',
): Promise<{ ok: true; url: string } | { ok: false; code: ProxyErrorCode }> {
  const session = await getSessionOrNull();
  if (!session) return { ok: false, code: PROXY_NO_SESSION };

  const controller = new AbortController();
  const handle = setTimeout(() => controller.abort(), 15_000);
  let resp: Response;
  try {
    resp = await fetch(`${PROXY_BASE}/billing/checkout`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.jwt}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ kind }),
      signal: controller.signal,
    });
  } catch {
    clearTimeout(handle);
    return { ok: false, code: PROXY_NETWORK };
  }
  clearTimeout(handle);
  if (!resp.ok) return { ok: false, code: PROXY_NETWORK };

  let body: { ok: boolean; url?: string };
  try {
    body = (await resp.json()) as { ok: boolean; url?: string };
  } catch {
    return { ok: false, code: PROXY_NETWORK };
  }
  const url = body.url;
  if (!url) return { ok: false, code: PROXY_NETWORK };

  // Validate the proxy-supplied checkout URL against the same allowlist the
  // portal flow uses (260525-s09 H5 / T-uv9-01) BEFORE returning it to the
  // popup opener. Allowlist is NOT relaxed.
  try {
    const { assertSafeExternalUrl } = await import('../lib/externalUrlValidator');
    assertSafeExternalUrl(url);
  } catch {
    return { ok: false, code: PROXY_NETWORK };
  }

  // Hand the validated URL back to the IPC handler, which opens it in the
  // system browser via shell.openExternal (260603). No window work here.
  return { ok: true, url };
}

/**
 * 260724 — change the tier of an EXISTING subscription.
 *
 * POST /billing/change-plan { tier }. The proxy maps the tier to its Polar
 * product id and issues a subscription UPDATE (proration is Polar's job), then
 * applies the section-2 reset rules: an upgrade resets weekly usage when the
 * new tier's rank exceeds `max_tier_rank_this_period`; a downgrade never does.
 *
 * This is NOT a checkout: nothing opens in the browser and no new subscription
 * is created. Callers with no active subscription must use `openCheckout`
 * instead, and a move to `free` is a cancellation (customer portal).
 *
 * Returns `{ ok: true }` once the proxy accepts the change. The new tier lands
 * in the UI through the next creditsGet / status push, not from this response,
 * so a webhook-delayed update is never presented as a failure.
 */
export async function changePlan(
  tier: PlanTier,
): Promise<{ ok: true } | { ok: false; code: ProxyErrorCode }> {
  const session = await getSessionOrNull();
  if (!session) return { ok: false, code: PROXY_NO_SESSION };

  const controller = new AbortController();
  const handle = setTimeout(() => controller.abort(), 15_000);
  let resp: Response;
  try {
    resp = await fetch(`${PROXY_BASE}/billing/change-plan`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.jwt}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ tier }),
      signal: controller.signal,
    });
  } catch {
    clearTimeout(handle);
    return { ok: false, code: PROXY_NETWORK };
  }
  clearTimeout(handle);
  if (resp.status === 429) return { ok: false, code: PROXY_RATE_LIMITED };
  if (!resp.ok) return { ok: false, code: PROXY_NETWORK };
  return { ok: true };
}

/**
 * 260706 — submit in-app feedback to the proxy (POST /feedback). Runs behind
 * the proxy's feedbackDailyGate (20/day per user). With `claimReward` the
 * proxy also attempts the once-per-account WEEKLY USAGE RESET (260724 — it
 * used to be a credit grant) and reports the outcome in the body. 429 surfaces
 * as PROXY_RATE_LIMITED so the renderer can show honest "daily limit" copy
 * instead of a generic network error.
 */
export async function feedbackSubmit(args: {
  body: string;
  email?: string;
  claimReward?: boolean;
}): Promise<
  | { ok: true; usage_reset: boolean; already_claimed: boolean }
  | { ok: false; code: ProxyErrorCode }
> {
  const session = await getSessionOrNull();
  if (!session) return { ok: false, code: PROXY_NO_SESSION };

  const controller = new AbortController();
  const handle = setTimeout(() => controller.abort(), 15_000);
  let resp: Response;
  try {
    resp = await fetch(`${PROXY_BASE}/feedback`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.jwt}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        body: args.body,
        email: args.email,
        claimReward: args.claimReward === true,
      }),
      signal: controller.signal,
    });
  } catch {
    clearTimeout(handle);
    return { ok: false, code: PROXY_NETWORK };
  }
  clearTimeout(handle);
  if (resp.status === 429) return { ok: false, code: PROXY_RATE_LIMITED };
  if (!resp.ok) return { ok: false, code: PROXY_NETWORK };

  try {
    const body = (await resp.json()) as {
      ok?: boolean;
      usage_reset?: boolean;
      already_claimed?: boolean;
    };
    if (body.ok !== true) return { ok: false, code: PROXY_NETWORK };
    return {
      ok: true,
      usage_reset: body.usage_reset === true,
      already_claimed: body.already_claimed === true,
    };
  } catch {
    return { ok: false, code: PROXY_NETWORK };
  }
}

/**
 * 260706 — report a companion (proxy POST /report, reportDailyGate 20/day).
 * Reasons are allowlist keys; the proxy re-validates and rejects unknowns.
 */
export async function reportSubmit(args: {
  reasons: string[];
  comment?: string;
  characterPublicId?: string;
  characterName?: string;
}): Promise<{ ok: true } | { ok: false; code: ProxyErrorCode }> {
  const session = await getSessionOrNull();
  if (!session) return { ok: false, code: PROXY_NO_SESSION };

  const proxyBase = process.env.SEI_PROXY_URL ?? 'https://api.sei.gg';
  const controller = new AbortController();
  const handle = setTimeout(() => controller.abort(), 15_000);
  let resp: Response;
  try {
    resp = await fetch(`${proxyBase}/report`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.jwt}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(args),
      signal: controller.signal,
    });
  } catch {
    clearTimeout(handle);
    return { ok: false, code: PROXY_NETWORK };
  }
  clearTimeout(handle);
  if (resp.status === 429) return { ok: false, code: PROXY_RATE_LIMITED };
  if (!resp.ok) return { ok: false, code: PROXY_NETWORK };
  return { ok: true };
}

/**
 * Read the current subscription state from `subscription_status`. RLS scopes
 * the SELECT to the signed-in user; missing row → 'none' (the user has never
 * subscribed). No fan-out needed — this is a single-table read with a sub-ms
 * P99 against the Supabase index on `user_id`.
 *
 * The `active` predicate is a derived convenience for renderer code that only
 * cares about "show Manage / Cancel?" — full `status` is also exposed so the
 * Settings copy can disambiguate 'cancelled' vs 'expired' vs 'past_due'.
 */
export async function subscriptionStatus(): Promise<SubscriptionStatusInfo> {
  const session = await getSessionOrNull();
  if (!session) {
    return { active: false, status: 'none', renews_at: null, ends_at: null };
  }
  // JWT-authenticated read (see getAuthedClient / creditsGet rationale).
  const supabase = getAuthedClient(session.jwt);
  // 260525-pbn task 4 (H8): see creditsGet — same view substitution.
  const { data } = await supabase
    .from('my_subscription')
    .select('status,renews_at,ends_at')
    .maybeSingle();
  if (!data) {
    return { active: false, status: 'none', renews_at: null, ends_at: null };
  }
  return {
    active: data.status === 'active',
    status: data.status as SubscriptionStatusInfo['status'],
    renews_at: data.renews_at ?? null,
    ends_at: data.ends_at ?? null,
  };
}

/**
 * quick/260525-sbo Task 3 — record an immutable affirmative consent before
 * opening the Polar subscription checkout. Required by California
 * Bus & Prof Code §17602(b) recordkeeping ("operator shall maintain
 * consumer's affirmative consent until the consumer has discontinued use of
 * the service or for three years, whichever is shorter").
 *
 * POSTs to the `record-consent` Edge Function (two-client pattern: anon
 * client verifies the JWT, service_role client INSERTs into the immutable
 * subscription_consents table). The renderer-side AutoRenewalConsentModal
 * calls this BEFORE the checkout or the tier change, but treats failures as
 * non-blocking: the legal anchor is the user's affirmative checkbox click,
 * not the server INSERT. If the INSERT fails, main logs the error so the
 * operator can backfill from console logs if a dispute requires the audit
 * trail.
 *
 * Returns:
 *   - { ok: true }                          on 2xx
 *   - { ok: false, code: PROXY_NO_SESSION } when the user is signed-out
 *   - { ok: false, code: PROXY_NETWORK }    on any other failure (timeout,
 *                                            4xx/5xx — the renderer doesn't
 *                                            need to distinguish further)
 *
 * NOT rate-bucketed (T-sbo-05 accepted): consent INSERT fires at most once
 * per checkout attempt; checkout itself is intrinsically slow (LS hosted
 * page).
 */
export async function recordSubscriptionConsent(args: {
  consent_version: string;
}): Promise<{ ok: true } | { ok: false; code: ProxyErrorCode }> {
  const session = await getSessionOrNull();
  if (!session) return { ok: false, code: PROXY_NO_SESSION };

  const res = await callEdgeFunction('record-consent', {
    jwt: session.jwt,
    body: { consent_version: args.consent_version, ip_hash: null },
  });
  if (!res.ok) {
    console.warn('recordSubscriptionConsent: edge function returned non-2xx', {
      status: res.status,
      message: res.message,
    });
    return { ok: false, code: PROXY_NETWORK };
  }
  return { ok: true };
}

/**
 * Open the Polar customer portal where the user can update billing or cancel
 * the subscription themselves.
 *
 * **Open-question resolution #5:** Sei does NOT implement a cancel endpoint
 * server-side. The customer portal is the merchant-of-record's responsibility
 * (Polar handles the UX, the proration math, the cancellation confirmation
 * email, etc.) — duplicating that surface in Sei would create synchronization
 * bugs without adding user value.
 *
 * The proxy's /billing/customer-portal route auths via the user's Supabase JWT,
 * looks up their Polar customer id (captured by polar-webhook), mints a Polar
 * customer session server-side, and returns the signed `customer_portal_url`.
 * The renderer hands that URL to shell.openExternal (after the allowlist check
 * below). The write-scoped Polar token never reaches the client.
 *
 * Returns `{ ok: true, portalUrl }` on success so the renderer can show a
 * "Opened in your browser" toast that includes the URL for users who
 * alt-tabbed away from the browser launch.
 */
export async function cancelSubscription(): Promise<
  { ok: true; portalUrl: string } | { ok: false; code: ProxyErrorCode }
> {
  // WR-04 (Phase 13 REVIEW): mirror every other method in this module by
  // short-circuiting with PROXY_NO_SESSION when the user is signed out.
  const session = await getSessionOrNull();
  if (!session) return { ok: false, code: PROXY_NO_SESSION };

  const proxyBase = process.env.SEI_PROXY_URL ?? 'https://api.sei.gg';
  // Fetch the signed customer-portal URL from the proxy. 15s AbortController
  // timeout matches the cloudCharacterClient timeout convention.
  const controller = new AbortController();
  const handle = setTimeout(() => controller.abort(), 15_000);
  let resp: Response;
  try {
    resp = await fetch(`${proxyBase}/billing/customer-portal`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${session.jwt}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
  } catch {
    clearTimeout(handle);
    return { ok: false, code: PROXY_NETWORK };
  }
  clearTimeout(handle);
  if (!resp.ok) {
    return { ok: false, code: PROXY_NO_PORTAL_URL };
  }
  let body: { ok: boolean; portalUrl?: string };
  try {
    body = (await resp.json()) as { ok: boolean; portalUrl?: string };
  } catch {
    return { ok: false, code: PROXY_NO_PORTAL_URL };
  }
  const portalUrl = body.portalUrl;
  if (!portalUrl) return { ok: false, code: PROXY_NO_PORTAL_URL };

  // 260525-s09 H5: validate the proxy-supplied portalUrl against the same
  // allowlist the IPC handler uses. A compromised proxy or MITM cannot
  // redirect the user to an arbitrary URL via shell.openExternal. Reject
  // case maps to PROXY_NO_PORTAL_URL (semantically: "no usable portal URL")
  // rather than a new error code — keeps the renderer error map unchanged.
  try {
    const { assertSafeExternalUrl } = await import('../lib/externalUrlValidator');
    assertSafeExternalUrl(portalUrl);
  } catch {
    return { ok: false, code: PROXY_NO_PORTAL_URL };
  }

  try {
    await shell.openExternal(portalUrl);
    return { ok: true, portalUrl };
  } catch {
    return { ok: false, code: PROXY_NETWORK };
  }
}
