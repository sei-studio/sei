/**
 * 261113: Factorio session counters for `bot_session_ended`. The bot posts
 * `{type:'factorio-stats', stats}` about every 30 s and once at the end
 * (src/bot/adapter/factorio/stats.js createFactorioStats().snapshot()); main
 * keeps the newest per character and folds it into the end event once, as
 * FLAT props, because analytics.sanitize drops nested objects and keeps only
 * keys matching /^[a-z0-9_]+$/. Same pattern as the DST lives reporter
 * (games/dontstarve/sessionLives.ts).
 *
 * Shape only: verb names (the companion's own tool names, a closed set),
 * counts and closed failure / reflex enums. No item names, coordinates or
 * chat ever reach this, and anything that is not that shape is dropped.
 *
 *   fct_verbs_n, fct_verbs_ok          all verbs together
 *   fct_fail_<class>                   failures by class (every class, 0 included)
 *   fct_reflex_<kind>                  mod reflex events (every kind, 0 included)
 *   fct_link_timeouts, fct_app_respawns
 *   fct_v_<verb>_n, fct_v_<verb>_ok    per verb, lowercased (goTo -> goto)
 */
import { z } from 'zod';
import { FAIL_CLASSES, REFLEX_KINDS } from '../bot/adapter/factorio/stats.js';

/** Per-verb props are capped so a runaway tool list cannot flood the event. */
export const MAX_VERBS = 40;

const Count = z.number().int().min(0).max(1_000_000);

const VerbSchema = z.object({
  n: Count,
  ok: Count,
  fail: z.record(z.string(), Count).default({}),
});

export const FactorioStatsMessageSchema = z.object({
  type: z.literal('factorio-stats'),
  stats: z.object({
    verbs: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/), VerbSchema).default({}),
    reflex: z.record(z.string(), Count).default({}),
    link_timeouts: Count.default(0),
    app_respawns: Count.default(0),
  }),
});
export type FactorioStatsMessage = z.infer<typeof FactorioStatsMessageSchema>;

export type FactorioStatsProps = Record<string, number>;

/** Flatten one validated snapshot into bot_session_ended props. */
export function flattenFactorioStats(stats: FactorioStatsMessage['stats']): FactorioStatsProps {
  const out: FactorioStatsProps = {};
  let n = 0;
  let ok = 0;
  const fails: Record<string, number> = Object.fromEntries(FAIL_CLASSES.map((c: string) => [c, 0]));
  const verbs = Object.entries(stats.verbs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  let kept = 0;
  for (const [name, v] of verbs) {
    n += v.n;
    ok += v.ok;
    for (const [cls, k] of Object.entries(v.fail)) if (cls in fails) fails[cls] += k;
    const key = name.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    if (kept >= MAX_VERBS || out[`fct_v_${key}_n`] !== undefined) continue;
    out[`fct_v_${key}_n`] = v.n;
    out[`fct_v_${key}_ok`] = v.ok;
    kept++;
  }
  out.fct_verbs_n = n;
  out.fct_verbs_ok = ok;
  for (const c of FAIL_CLASSES as readonly string[]) out[`fct_fail_${c}`] = fails[c];
  for (const k of REFLEX_KINDS as readonly string[]) out[`fct_reflex_${k}`] = stats.reflex[k] ?? 0;
  out.fct_link_timeouts = stats.link_timeouts;
  out.fct_app_respawns = stats.app_respawns;
  return out;
}

export interface FactorioStatsReporter {
  /** A raw port message; invalid ones are ignored. */
  note(characterId: string, raw: unknown): void;
  /** The session's flat props ({} when nothing valid arrived), then forget it. */
  take(characterId: string): FactorioStatsProps;
}

export function createFactorioStatsReporter(): FactorioStatsReporter {
  const latest = new Map<string, FactorioStatsMessage['stats']>();
  return {
    note(characterId, raw) {
      const parsed = FactorioStatsMessageSchema.safeParse(raw);
      if (!parsed.success) return;
      latest.set(characterId, parsed.data.stats);
    },
    take(characterId) {
      const s = latest.get(characterId);
      latest.delete(characterId);
      return s ? flattenFactorioStats(s) : {};
    },
  };
}
