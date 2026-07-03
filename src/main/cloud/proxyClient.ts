/**
 * Phase 13 — proxy client (main-process only).
 *
 * MAIN PROCESS ONLY — do not import from renderer (mirrors the Phase 10/11
 * invariant in `src/main/auth/supabaseClient.ts:1-11` and
 * `src/main/cloud/cloudCharacterClient.ts:1-11`). Renderer goes through the
 * IPC handlers in `src/main/ipc.ts` which lazy-import this module.
 *
 * Surface — five typed methods (Plan 13-13 must_haves):
 *   - trialClaim()                   → calls trial-claim Edge Function; the
 *                                       trial is bound to the account UUID.
 *   - creditsGet()                   → reads ledger_balance + subscription_status
 *                                       + ledger_grants + apiKeyStore in parallel,
 *                                       computes remaining_pct via BigInt math.
 *   - openCheckout(kind)             → asks the proxy to mint a Polar (Merchant
 *                                       of Record) checkout session URL, then
 *                                       RETURNS the allowlist-validated URL (the
 *                                       main IPC handler opens it in a hardened
 *                                       popup BrowserWindow — 260602-uv9).
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
 *     the externalUrlValidator allowlist before use — the checkout URL is
 *     handed to a hardened popup BrowserWindow (260602-uv9), the portal URL
 *     still goes to shell.openExternal.
 *   - BigInt math for balance % computation — no float drift.
 *
 * Source:
 *   - 13-13-PLAN must_haves + action block
 *   - 13-CONTEXT D-41 (X-Sei-Remaining-Pct rounding, REMAINING_PCT_STEP=5)
 *   - Polar migration (2026-06): checkout/portal sessions are proxy-minted
 *   - 13-CONTEXT D-50 (BigInt micro-dollars; trial cap 5_000_000 µ$ = $5/day)
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
  PROXY_ALREADY_CLAIMED,
  PROXY_DEVICE_CLAIMED,
  PROXY_NETWORK,
  PROXY_NO_PORTAL_URL,
  type ProxyErrorCode,
} from './proxyErrors';
import type { CreditsStatus, SubscriptionStatusInfo } from '../../shared/ipc';

/**
 * Blended micro-dollars per token (BigInt). Converts ledger_balance_micro into
 * an approximate `remaining_tokens` count for the renderer's playtime estimator
 * (quick/260523-t8d). UI estimation only — exact billing happens server-side.
 *
 * Derivation: PRICING['claude-haiku-4-5'] = { input: 1.0, output: 5.0 } µ$/tok;
 * a typical Sei Haiku turn ≈ 80% input / 20% output → 0.8×1.0 + 0.2×5.0 = 1.8,
 * rounded UP to 2 so the playtime pill never over-promises.
 *
 * SOURCE OF TRUTH: the proxy's `src/anthropic/pricing.ts` (MICRO_PER_TOKEN_BLENDED)
 * in the private sei-proxy repo. Kept inline here so the public client has no
 * dependency on the private backend tree; keep the two in sync if pricing moves.
 */
const MICRO_PER_TOKEN_BLENDED = 2n;

/**
 * D-41: X-Sei-Remaining-Pct is rounded to the nearest 5%. We mirror that step
 * client-side when computing the fallback % from ledger_balance + tier cap so
 * the UI shows the same granularity whether the value came from a server
 * response header or from a cold creditsGet() fetch.
 */
const REMAINING_PCT_STEP = 5;

/**
 * Tier daily caps in micro-dollars. Mirrors `proxy/src/ledger/balance.ts` (the
 * proxy-side source of truth — Wave 2 plan 13-08). The client uses these only
 * for the cold-load % fallback; subsequent updates flow via X-Sei-Remaining-Pct
 * response headers from the proxy (D-41).
 *
 * - Trial cap: 5_000_000 µ$ = $5/day  (D-51 trial-tier daily-dollar cap)
 * - Sub cap:   20_000_000 µ$ = $20/day (D-51 subscriber-tier daily-dollar cap)
 */
const TRIAL_DAILY_CAP = 5_000_000n;
const SUB_DAILY_CAP = 20_000_000n;

/**
 * Minimum balance (micro-dollars) at/below which a cloud account is treated as
 * OUT OF PLAYTIME: `plan = 'depleted'`, which trips the pre-flight summon gate
 * (`cloudCreditsDepleted`) and the out-of-playtime popup.
 *
 * MATCHES THE IN-GAME CUTOFF — this is ONE Sei turn's worst-case reservation:
 * the same `balance < reservation` test the proxy applies on every call before
 * it 402s (forward.ts → preDeduct → reserve_credits). Below it the bot's next
 * brain call can't be reserved at all, so summoning would only join the world
 * and leave immediately. NOT a round "feels safe" number — gating much above a
 * turn would refuse summons the proxy itself would have allowed.
 *
 * Derived from the proxy's estimateReservationMicro (pricing.ts) at the bot's
 * defaults — estInput × inputRate × 1.25 + maxOutput × outputRate:
 *   estInput  ≈ 14_000 tok  (~8K static persona+tools prefix sent on EVERY call
 *                            — see proxy tokenize.ts — plus live memory/chat for
 *                            a developed session)
 *   maxOutput = 1_024 tok   (bot main-loop max_tokens; thinking_budget 0)
 *   haiku      = 1.0 µ$/tok in, 5.0 µ$/tok out
 *   = 14_000 × 1.0 × 1.25 + 1_024 × 5.0 = 17_500 + 5_120 ≈ 22_600 µ$
 * Rounded to 25_000 µ$ ($0.025) for a little headroom. Matches the observed
 * 260616 depletion: that account 402'd in-game at a 22_606 µ$ balance, so this
 * also blocks it from re-summoning. Recalibrate if haiku pricing, the static
 * prefix size, or the bot's default max_tokens change.
 *
 * COUPLING — must stay STRICTLY BELOW 2.5% of TRIAL_DAILY_CAP (125_000 µ$): at
 * or above, a depleted balance rounds `remaining_pct` up to 5% and the popup's
 * auto-dismiss (gated on `remaining_pct > 0`) would close it the instant it
 * opens. At $0.025 a depleted balance always rounds to 0%.
 */
const MIN_PLAYABLE_BALANCE_MICRO = 25_000n;

/**
 * Round `n` to the nearest `step`, clamping to [0, 100]. Used for the cold-load
 * % fallback so the UI shows the same 5% granularity that server-driven updates
 * use (D-41).
 */
function roundToStep(n: number, step: number): number {
  return Math.max(0, Math.min(100, Math.round(n / step) * step));
}

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
 * Claim the one-time free trial credits for the signed-in ACCOUNT (the
 * auth.users UUID derived from the session JWT). The trial is no longer bound
 * to the Minecraft username — migration 20260603000000 dropped the
 * mc_username-keyed `trial_claims` table, so the sole one-trial-per-account
 * gate is the `ledger_grants_trial_per_user_uidx` partial UNIQUE index.
 *
 * Wire-level: POST /functions/v1/trial-claim with an empty body `{}` (identity
 * comes entirely from the bearer JWT). The Edge Function returns:
 *   - 202 { status: 'received' } on BOTH claim-disposition branches (fresh
 *     grant, or this account already claimed). The uniform envelope is M10's
 *     mitigation for the enumeration oracle that a 200-vs-409 split leaked.
 *   - 403 { code: 'email_not_confirmed' } when email_confirmed_at is null
 *     (H2 — Gmail-plus-aliasing trial-grant loop closer).
 *   - 403 { code: 'aliased_email' } when the email contains a `+` alias
 *     before `@` (H2).
 *   - 500 { code: 'grant_failed' } on infrastructure errors — caller treats
 *     as PROXY_NETWORK and retries.
 *
 * Since the server no longer tells us whether a credit landed, we read
 * ledger_balance BEFORE the call and AGAIN AFTER:
 *   - delta > 0 → fresh trial grant succeeded.
 *   - delta == 0 → this account already claimed. Maps to
 *     PROXY_ALREADY_CLAIMED (the renderer's "already claimed" copy).
 *
 * T-rfj-07 (accepted): if a network failure splits the pre and post reads,
 * the user-visible classification can disagree with reality — the server-side
 * ledger_grants partial UNIQUE index is the authoritative idempotency
 * guarantee, so worst case is a one-time "already claimed" toast when the
 * credit actually landed. The credits ARE in the ledger; the UI shows them on
 * next refresh.
 *
 * 403 paths surface as PROXY_NETWORK (rather than a dedicated
 * PROXY_EMAIL_NOT_CONFIRMED sentinel) because the renderer doesn't yet have
 * copy for "verify your email." A follow-up quick task can add the sentinel
 * once copy exists; tracked in 260525-rfj SUMMARY.
 */
export async function trialClaim(): Promise<
  { ok: true; credits_micro: number } | { ok: false; code: ProxyErrorCode }
> {
  const session = await getSessionOrNull();
  if (!session) return { ok: false, code: PROXY_NO_SESSION };

  // Authenticate the balance reads with the user's JWT so RLS returns THEIR
  // rows (the ambient singleton session is not reliably applied here — see
  // getAuthedClient). Without this the post-claim balance reads as 0 and a
  // real grant is misreported as "already claimed".
  const supabase = getAuthedClient(session.jwt);

  // Read balance BEFORE the claim attempt so we can detect a delta after the
  // uniform 202 envelope (M10 — server no longer tells us whether the claim
  // landed; the ledger is the source of truth).
  const { data: pre } = await supabase
    .from('ledger_balance')
    .select('balance_micro')
    .eq('user_id', session.userId)
    .maybeSingle();
  const preBalance = BigInt((pre?.balance_micro ?? 0) as number | string);

  // 260603 anti-abuse: include the device-global device id so the server can
  // enforce "one trial per DEVICE" (in addition to per-account). The id is a
  // random local UUID (no PII / no fingerprinting); the server hashes it. A
  // device-id read failure must NEVER block the claim — fall back to no id (the
  // server then uses the account-only gate).
  let deviceId: string | undefined;
  try {
    const { getDeviceId } = await import('../auth/deviceId');
    deviceId = await getDeviceId();
  } catch {
    deviceId = undefined;
  }

  const res = await callEdgeFunction('trial-claim', {
    jwt: session.jwt,
    // Identity is the bearer JWT; device_id is the per-device trial gate only.
    body: deviceId ? { device_id: deviceId } : {},
  });

  // Non-2xx covers: status===0 network/abort, 4xx (incl. new 403 H2 gates),
  // 5xx. We surface all of these as PROXY_NETWORK for now — the renderer
  // doesn't have copy distinguishing them, and a future PROXY_EMAIL_NOT_CONFIRMED
  // sentinel can split the 403 branch once renderer copy lands.
  if (!res.ok) {
    return { ok: false, code: PROXY_NETWORK };
  }

  // Edge Function returned 2xx (uniform 202 envelope is the only success
  // shape post-Cluster-D). Decide success vs already-claimed by re-reading
  // ledger_balance and comparing against the pre-call snapshot.
  const { data: post } = await supabase
    .from('ledger_balance')
    .select('balance_micro')
    .eq('user_id', session.userId)
    .maybeSingle();
  const postBalance = BigInt((post?.balance_micro ?? 0) as number | string);

  const delta = postBalance - preBalance;
  if (delta > 0n) {
    // Credit landed — first-time claim, regardless of which server branch
    // (fresh-grant) produced it.
    return { ok: true, credits_micro: Number(delta) };
  }

  // No delta — the grant did NOT land. The Edge Function returns the SAME
  // uniform 202 for "account already claimed" AND "DEVICE already claimed"
  // (this machine spent its one trial under a different account). Disambiguate
  // by reading whether THIS account actually holds a kind='trial' grant:
  //   - present → the account itself already claimed → PROXY_ALREADY_CLAIMED.
  //   - absent  → the grant was blocked by the per-device gate (the only 2xx
  //               no-grant path; the per-IP gate returns 429 and grant_failed
  //               returns 500, both caught by !res.ok above) →
  //               PROXY_DEVICE_CLAIMED, so the renderer can say "this device
  //               already used its free trial" instead of falsely blaming the
  //               account and leaving the button a re-clickable dead-end.
  // (A read-after-write race that hides a just-landed grant is harmless: the
  // store treats `trial_claimed` from its post-claim refresh as authoritative
  // and reports success regardless of the code returned here.)
  // Read the same curated `my_grants` view creditsGet() uses (RLS-scoped to
  // auth.uid()). A kind='trial' row means THIS account already claimed.
  const { data: grants } = await supabase
    .from('my_grants')
    .select('kind')
    .eq('kind', 'trial');
  const accountHasTrial =
    Array.isArray(grants) && grants.some((g) => (g as { kind?: string }).kind === 'trial');
  if (accountHasTrial) {
    return { ok: false, code: PROXY_ALREADY_CLAIMED };
  }
  return { ok: false, code: PROXY_DEVICE_CLAIMED };
}

/**
 * Snapshot the credits + plan state for the current user.
 *
 * Reads three sources in parallel (Promise.all) — two Supabase queries (RLS
 * scopes each to the current user) and one local apiKeyStore fetch:
 *   1. `ledger_balance` view  → balance_micro (BigInt math against tier cap)
 *   2. `my_subscription` view → status + renews_at (drives plan label)
 *   3. `my_grants` (view)    → SUM(credits_micro) for usage_pct AND presence
 *                               of a kind='trial' row (the trial_claimed flag —
 *                               the trial is account-bound now that
 *                               trial_claims was dropped, 20260603000000)
 *   4. `apiKeyStore.getAiBackendKind()` → local | cloud-proxy (UI gate, D-57)
 *
 * The remaining_pct is computed via BigInt division — `balance × 100 / cap` —
 * rounded to nearest 5% to match the server-driven X-Sei-Remaining-Pct header
 * granularity (D-41). BigInt avoids float drift on micro-dollar amounts.
 *
 * Plan label derivation:
 *   - active subscription          → 'unlimited'
 *   - balance < playable minimum   → 'depleted'  (triggers the out-of-playtime
 *                                                  popup; see
 *                                                  MIN_PLAYABLE_BALANCE_MICRO —
 *                                                  NOT just balance == 0, so a
 *                                                  near-empty account can't
 *                                                  summon a bot that instantly
 *                                                  402s and leaves)
 *   - kind='trial' grant exists    → 'trial'     (used the trial; not yet bought)
 *   - otherwise                    → 'pack'      (purchased a one-time pack)
 *
 * No session → return the depleted/local placeholder. The renderer should not
 * mount the credits surface anyway when ai_backend_kind === 'local' (D-57).
 */
export async function creditsGet(): Promise<CreditsStatus> {
  const session = await getSessionOrNull();
  if (!session) {
    // 260703: report the REAL persisted backend kind, not a hardcoded 'local'.
    // This snapshot is the renderer's sole source for the ACCOUNT MODE surface
    // (useCreditsStore.ai_backend_kind → SettingsScreen); the old placeholder
    // made a transient getSession() miss (e.g. an expired token mid-refresh at
    // boot) paint a cloud-proxy profile as BYOK — while every actual LLM call
    // kept reading config.json directly and spending cloud credits. The UI
    // must never claim a mode the calls don't use. Best-effort: a config read
    // failure falls back to the schema default.
    let backendKind: CreditsStatus['ai_backend_kind'] = 'local';
    try {
      const { getAiBackendKind } = await import('../apiKeyStore');
      backendKind = await getAiBackendKind();
    } catch { /* keep the schema default */ }
    return {
      remaining_pct: 0,
      plan: 'depleted',
      renews_at: null,
      ends_at: null,
      trial_claimed: false,
      ai_backend_kind: backendKind,
      // quick/260525-sbo Task 8: explicit null on no-session (never
      // subscribed from this client's POV; no banner should render).
      subscription_status_raw: null,
    };
  }

  // Authenticate the RLS-scoped reads with the user's JWT (the ambient
  // singleton session is not reliably applied to PostgREST requests in the main
  // process — see getAuthedClient). Without this every read below resolves
  // against an anonymous caller (auth.uid() = null) and returns the user's rows
  // as empty: balance 0, no grants → the screen shows "0min left" /
  // plan=depleted and the trial button never flips to "Claimed".
  const supabase = getAuthedClient(session.jwt);
  // Parallel fan-out: RLS-scoped table reads + the local apiKeyStore lookup.
  // All reads are independent — Promise.all keeps cold-load latency at
  // max(query), not sum(query).
  //
  // 260602-hbr: the rolling-24h `ledger_consumption` read (ITEM 4 / 260524-0ka)
  // is GONE — its only consumer was the personalized tokens/min derivation,
  // which is replaced by a flat `DEFAULT_TOKENS_PER_MIN` multiplier in the
  // renderer. In its place we read `ledger_grants` to total AVAILABLE credits
  // for the usage-percent bar.
  //
  // 260524-0ka C2 contract (verified via LEDGER-BALANCE-DIAGNOSIS.md):
  // ledger_balance is a VIEW
  // (`supabase/migrations/20260525000000_ledger_balance_restrict.sql`). It
  // returns NULL (zero rows from `.maybeSingle()`) in two cases:
  //   (i)  the calling user has no ledger_grants row yet (new user) — the
  //        view emits a row with balance_micro = 0 via the inner coalesce,
  //        so this case is actually NOT NULL — it's a single 0-row.
  //   (ii) the calling user has no auth.users row visible to the calling
  //        role (hard-deleted account, OR a service-role read where
  //        auth.role() ≠ 'service_role' — only happens through raw psql/MCP
  //        sessions, not through supabase-js). In that case `.maybeSingle()`
  //        returns NULL — we coalesce to 0n on the `balanceRaw ?? 0` line
  //        below, treating "unknown user" as "depleted plan".
  // If you see NULL in tests/logs for an EXISTING auth.users row queried
  // via the renderer-side JWT path, check whether the supabase-js client
  // session was bound under a non-service-role JWT (see diagnosis doc §3
  // "Root cause hypothesis"). The MCP-side `set local role service_role;`
  // workaround is documented in the audit SQL.
  const [balanceRow, subRow, grantsRow, backendKind] = await Promise.all([
    supabase
      .from('ledger_balance')
      .select('balance_micro')
      .eq('user_id', session.userId)
      .maybeSingle(),
    // 260525-pbn task 4 (H8): read via my_subscription view (security_invoker)
    // — the base-table SELECT policy was dropped in 20260528000200 so that
    // the provider subscription id can no longer reach the renderer-
    // side JWT. The view already filters by auth.uid(), so .eq(user_id,…)
    // is unnecessary; .maybeSingle() returns at most one row for the caller.
    supabase
      .from('my_subscription')
      .select('status,renews_at,ends_at')
      .maybeSingle(),
    // 260602-hbr: sum of the caller's grant rows = total AVAILABLE credits
    // (net of refund rows, which are negative). `used = available − balance`,
    // so `usage_pct = used / available`. Additive across a subscription grant
    // plus any number of Quest-pack grants — a top-up just grows `available`.
    //
    // Read via the curated `my_grants` security_invoker view (20260528000200
    // design) — it exposes only {id, kind, credits_micro, granted_at,
    // expires_at} and self-filters by auth.uid(), so the renderer never sees
    // the provider event id and no .eq(user_id) is needed. The view depends on
    // the `ledger_grants_select_own` RLS policy restored in 20260603010000.
    //
    // `kind` drives `trial_claimed` (presence of a kind='trial' grant) — the
    // trial is account-bound now that the mc_username-keyed `trial_claims`
    // table is gone (20260603000000).
    supabase
      .from('my_grants')
      .select('credits_micro,kind'),
    import('../apiKeyStore').then((m) => m.getAiBackendKind()),
  ]);

  // Balance is stored as bigint in Postgres; supabase-js returns it as either a
  // number (small values) or a string (>= 2^53). BigInt() handles both.
  const balanceRaw = balanceRow.data?.balance_micro ?? 0;
  const balance = BigInt(balanceRaw as number | string);

  // A cancel-scheduled subscription ("to be cancelled") keeps status='cancelled'
  // but stays fully usable until ends_at (apply_polar_event / Polar's
  // subscription.canceled). Treat it as a subscriber until that date passes so
  // the UI keeps the active interface and the SUB daily cap; the renderer reads
  // subscription_status_raw + ends_at to show "Subscription will end …" + Resume.
  const subStatus = subRow.data?.status as CreditsStatus['subscription_status_raw'];
  const subEndsAt = (subRow.data?.ends_at as string | null) ?? null;
  const cancelPendingActive =
    subStatus === 'cancelled' && subEndsAt !== null && Date.parse(subEndsAt) > Date.now();
  const isSubscriber = subStatus === 'active' || cancelPendingActive;
  const dailyCap = isSubscriber ? SUB_DAILY_CAP : TRIAL_DAILY_CAP;

  // `balance × 100n / cap` in BigInt — no float drift. Clamped to 100 when
  // balance exceeds the daily cap (e.g. fresh pack grant > $5/day trial cap).
  // Number() is safe here because the result is bounded to [0, 100].
  //
  // remaining_pct = balance vs the DAILY cap (how much of today's allowance is
  // left). This is DISTINCT from usage_pct (lifetime used/available) computed
  // below. Kept for HardStopModal's auto-dismiss gate (`remainingPct > 0`) and
  // the IconRail PricingIcon arc fill.
  const pctRaw =
    balance >= dailyCap ? 100 : Number((balance * 100n) / dailyCap);
  const pct = roundToStep(pctRaw, REMAINING_PCT_STEP);

  // ITEM 4: derive remaining_tokens from balance via the blended µ$/tok
  // constant. BigInt division floors automatically — slight under-estimate
  // so the playtime estimate never overpromises. 260602-hbr: the renderer
  // turns this into "~Xh left" via a flat DEFAULT_TOKENS_PER_MIN multiplier
  // (the per-user rolling-24h tokens/min derivation was removed).
  const remainingTokens = Number(balance / MICRO_PER_TOKEN_BLENDED);

  // 260602-hbr — usage-percent for the progress bar.
  //   available = SUM(ledger_grants.credits_micro)   (refund rows are negative)
  //   used      = available − balance                (clamped ≥ 0)
  //   usage_pct = used / available × 100             (0% on a fresh grant)
  // Additive across a subscription grant + any number of Quest-pack grants:
  // a top-up grows `available`, so the bar moves LEFT. Rounded to the same
  // REMAINING_PCT_STEP as remaining_pct to avoid sub-step re-render jitter.
  let granted = 0n;
  let hasTrialGrant = false;
  for (const g of (grantsRow.data ?? []) as Array<{
    credits_micro: number | string;
    kind: string;
  }>) {
    granted += BigInt(g.credits_micro);
    if (g.kind === 'trial') hasTrialGrant = true;
  }
  const usedMicro = granted - balance > 0n ? granted - balance : 0n;
  const usagePct =
    granted > 0n
      ? roundToStep(
          Math.min(100, Math.max(0, Number((usedMicro * 100n) / granted))),
          REMAINING_PCT_STEP,
        )
      : 0;

  // Dollar form of usage for the UsageBar tooltip. The ledger micros are
  // micro-dollars (see MICRO_PER_TOKEN_BLENDED docblock), so ÷ 1e6 = USD. Owner
  // opted past the PROXY-05 percent-only line; these stay undefined when there
  // are no grants so the renderer shows "$—".
  const MICRO_PER_DOLLAR = 1_000_000;
  const usedUsd = granted > 0n ? Number(usedMicro) / MICRO_PER_DOLLAR : undefined;
  const totalUsd = granted > 0n ? Number(granted) / MICRO_PER_DOLLAR : undefined;

  // Plan label derivation — order matters: subscriber wins over depleted (a
  // subscriber whose monthly grant hasn't landed yet still sees 'unlimited').
  const plan: CreditsStatus['plan'] = isSubscriber
    ? 'unlimited'
    : balance < MIN_PLAYABLE_BALANCE_MICRO
      ? 'depleted'
      : hasTrialGrant
        ? 'trial'
        : 'pack';

  return {
    remaining_pct: pct,
    usage_pct: usagePct,
    plan,
    renews_at: subRow.data?.renews_at ?? null,
    ends_at: subEndsAt,
    trial_claimed: hasTrialGrant,
    ai_backend_kind: backendKind,
    remaining_tokens: remainingTokens,
    used_usd: usedUsd,
    total_usd: totalUsd,
    // quick/260525-sbo Task 8: raw LS status passthrough so SettingsScreen
    // can render contextual banners (past-due, paused) without a separate
    // round-trip. null when subRow returned no data (never-subscribed user).
    subscription_status_raw: subStatus ?? null,
  };
}

/**
 * Pre-flight summon gate (quick/260605): resolves `true` ONLY when a signed-in
 * account is on the cloud-proxy backend AND its balance has fallen below the
 * playable minimum (`creditsGet().plan === 'depleted'` — see
 * MIN_PLAYABLE_BALANCE_MICRO; NOT just balance 0). The bot supervisor consults
 * this before forking a cloud bot and refuses to summon when it is `true`, so a
 * user who can't sustain even one turn never joins the world only to have the
 * bot 402 on its first brain call and leave immediately.
 *
 * Precise by design — NOT just `creditsGet().plan === 'depleted'`, which also
 * reads 'depleted' for the no-session placeholder:
 *   - No session (signed out)        → `false`. A signed-out user's cloud calls
 *     401, not 402; that path is owned by the JWT-null flow, not the
 *     out-of-playtime modal. We don't block the summon on their behalf here.
 *   - BYOK backend ('local')         → `false`. BYOK never spends ledger credits.
 *   - Any read error                 → `false` (fail-OPEN). A transient Supabase
 *     blip must never wrongly block a paying user from summoning.
 */
export async function cloudCreditsDepleted(): Promise<boolean> {
  try {
    const session = await getSessionOrNull();
    if (!session) return false;
    const { getAiBackendKind } = await import('../apiKeyStore');
    if ((await getAiBackendKind()) !== 'cloud-proxy') return false;
    const status = await creditsGet();
    return status.plan === 'depleted';
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
  kind: 'pack' | 'subscription',
): Promise<{ ok: true; url: string } | { ok: false; code: ProxyErrorCode }> {
  const session = await getSessionOrNull();
  if (!session) return { ok: false, code: PROXY_NO_SESSION };

  const proxyBase = process.env.SEI_PROXY_URL ?? 'https://api.sei.gg';
  const controller = new AbortController();
  const handle = setTimeout(() => controller.abort(), 15_000);
  let resp: Response;
  try {
    resp = await fetch(`${proxyBase}/billing/checkout`, {
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
 * calls this BEFORE openCheckout('subscription'), but treats failures as
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
