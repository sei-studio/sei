/**
 * pricingCatalog — server-driven plan + top up pricing copy (260725).
 *
 * Reads the proxy's `plan_config` / `topup_config` tables — the SAME rows
 * /billing/checkout mints Polar sessions against — and maps them to the
 * renderer-facing PricingCatalog. Both tables are world-readable by design
 * (pricing is public marketing copy; writes are service_role only), so this
 * uses the plain anon client and works signed-out.
 *
 * Why: v0.4 shipped its prices as hardcoded renderer copy, so a pricing
 * retune stranded every shipped client on stale numbers. From v0.5 the
 * server rows are the source of truth: a price/name/blurb UPDATE (or a whole
 * new topup_config row) repaints every up-to-date client on its next catalog
 * read, no release needed. The renderer keeps the launch catalog bundled
 * (`planCatalog.ts`) as the offline fallback.
 *
 * Caching: one in-memory copy per app run, refreshed after CATALOG_TTL_MS.
 * A failed refresh serves the last good copy (pricing changes are rare and
 * never need to win over "the plan screen paints"); null only when no read
 * has ever succeeded — the renderer then keeps its bundled copy.
 */

import type { CatalogPlan, CatalogTopUp, PlanTier, PricingCatalog } from '../../shared/ipc';
import { getClient } from '../auth/supabaseClient';

/** µ$ per display credit — mirrors the server's micro_per_credit() (5,000). */
const MICRO_PER_CREDIT = 5000;

const CATALOG_TTL_MS = 5 * 60_000;

let cached: PricingCatalog | null = null;
let cachedAt = 0;
/** Single-flight guard so a poll burst can't stack concurrent reads. */
let inFlight: Promise<PricingCatalog | null> | null = null;

const PLAN_TIERS: readonly PlanTier[] = ['free', 'quest', 'party'];

function isPlanTier(id: string): id is PlanTier {
  return (PLAN_TIERS as readonly string[]).includes(id);
}

/**
 * Defensive row mappers. `select('*')` + per-field checks (rather than a
 * column list) so the read keeps working across schema drift in either
 * direction — most importantly a client running BEFORE the `blurb` column
 * migration has been applied. A row that fails the required-field checks is
 * dropped, never thrown on.
 */
function mapPlanRow(row: Record<string, unknown>): CatalogPlan | null {
  const id = typeof row.id === 'string' ? row.id : null;
  if (!id || !isPlanTier(id)) return null; // unknown future tier: ignore
  if (typeof row.display_name !== 'string') return null;
  if (typeof row.price_cents !== 'number' || row.price_cents < 0) return null;
  const micro = typeof row.weekly_allowance_micro === 'number' ? row.weekly_allowance_micro : null;
  if (micro === null || micro < 0) return null;
  return {
    tier: id,
    name: row.display_name,
    price_cents: row.price_cents,
    weekly_credits: Math.floor(micro / MICRO_PER_CREDIT),
    blurb: typeof row.blurb === 'string' && row.blurb.length > 0 ? row.blurb : null,
  };
}

function mapTopUpRow(row: Record<string, unknown>): CatalogTopUp | null {
  const id = typeof row.id === 'string' ? row.id : null;
  if (!id) return null;
  if (typeof row.display_name !== 'string') return null;
  if (typeof row.price_cents !== 'number' || row.price_cents <= 0) return null;
  const micro = typeof row.grant_micro === 'number' ? row.grant_micro : null;
  if (micro === null || micro <= 0) return null;
  return {
    kind: id,
    name: row.display_name,
    price_cents: row.price_cents,
    credits: Math.floor(micro / MICRO_PER_CREDIT),
    blurb: typeof row.blurb === 'string' && row.blurb.length > 0 ? row.blurb : null,
  };
}

async function fetchCatalog(): Promise<PricingCatalog | null> {
  try {
    const client = getClient();
    const [plansRes, topupsRes] = await Promise.all([
      client.from('plan_config').select('*').order('rank', { ascending: true }),
      client.from('topup_config').select('*').order('price_cents', { ascending: true }),
    ]);
    if (plansRes.error || topupsRes.error) return null;
    const plans = (plansRes.data ?? [])
      .map((r) => mapPlanRow(r as Record<string, unknown>))
      .filter((p): p is CatalogPlan => p !== null);
    const topups = (topupsRes.data ?? [])
      .map((r) => mapTopUpRow(r as Record<string, unknown>))
      .filter((t): t is CatalogTopUp => t !== null);
    // A catalog missing any of the three plan tiers is a broken read (the
    // renderer would drop plan cards) — treat it like a failure and let the
    // cache / bundled fallback stand.
    if (plans.length < PLAN_TIERS.length || topups.length === 0) return null;
    return { plans, topups };
  } catch {
    return null;
  }
}

/**
 * The IPC entry point (credits:catalog). Serves the cache inside the TTL,
 * refreshes past it, and falls back to the last good copy (or null before
 * the first success) on failure.
 */
export async function pricingCatalogGet(): Promise<PricingCatalog | null> {
  const fresh = cached !== null && Date.now() - cachedAt < CATALOG_TTL_MS;
  if (fresh) return cached;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const result = await fetchCatalog();
    if (result) {
      cached = result;
      cachedAt = Date.now();
    }
    inFlight = null;
    return cached;
  })();
  return inFlight;
}

/** Test-only cache reset. */
export function _resetPricingCatalogForTests(): void {
  cached = null;
  cachedAt = 0;
  inFlight = null;
}
