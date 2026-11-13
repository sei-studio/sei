/**
 * 261113: Terraria session counters for `bot_session_ended`. The bot posts
 * `{type:'terraria-stats', stats}` about every 30 s while they change and once
 * at the end (src/bot/adapter/terraria/stats.js); main keeps the newest per
 * character and folds it into the end event once, as FLAT props, because
 * analytics.sanitize drops nested objects and keeps only keys matching
 * /^[a-z0-9_]+$/. Same pattern as the DST lives reporter.
 *
 * Shape only: verb names (the companion's own tool names, a closed set),
 * counts and closed failure / reflex / alert enums. Anything else is dropped.
 *
 *   trr_verbs_n, trr_verbs_ok          all verbs together
 *   trr_fail_<class>                   failures by class (every class, 0 included)
 *   trr_reflex_<kind>                  fights, heals, retreats, low health, knock-outs
 *   trr_alert_<kind>                   boss / invasion / blood moon / player death alerts
 *   trr_v_<verb>_n, trr_v_<verb>_ok    per verb, lowercased (goTo -> goto)
 */
import { z } from 'zod';
import { FAIL_CLASSES, REFLEX_KINDS, ALERT_KINDS } from '../../../bot/adapter/terraria/stats.js';

export const MAX_VERBS = 30;

const Count = z.number().int().min(0).max(1_000_000);

export const TerrariaStatsMessageSchema = z.object({
  type: z.literal('terraria-stats'),
  stats: z.object({
    verbs: z
      .record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/), z.object({ n: Count, ok: Count, fail: z.record(z.string(), Count).default({}) }))
      .default({}),
    reflex: z.record(z.string(), Count).default({}),
    alerts: z.record(z.string(), Count).default({}),
  }),
});
export type TerrariaStatsMessage = z.infer<typeof TerrariaStatsMessageSchema>;

export function flattenTerrariaStats(stats: TerrariaStatsMessage['stats']): Record<string, number> {
  const out: Record<string, number> = {};
  let n = 0;
  let ok = 0;
  const fails: Record<string, number> = Object.fromEntries((FAIL_CLASSES as readonly string[]).map((c) => [c, 0]));
  let kept = 0;
  for (const [name, v] of Object.entries(stats.verbs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    n += v.n;
    ok += v.ok;
    for (const [cls, k] of Object.entries(v.fail)) if (cls in fails) fails[cls] += k;
    const key = name.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    if (kept >= MAX_VERBS || out[`trr_v_${key}_n`] !== undefined) continue;
    out[`trr_v_${key}_n`] = v.n;
    out[`trr_v_${key}_ok`] = v.ok;
    kept++;
  }
  out.trr_verbs_n = n;
  out.trr_verbs_ok = ok;
  for (const c of FAIL_CLASSES as readonly string[]) out[`trr_fail_${c}`] = fails[c];
  for (const k of REFLEX_KINDS as readonly string[]) out[`trr_reflex_${k}`] = stats.reflex[k] ?? 0;
  for (const k of ALERT_KINDS as readonly string[]) out[`trr_alert_${k}`] = stats.alerts[k] ?? 0;
  return out;
}

export interface TerrariaStatsReporter {
  note(characterId: string, raw: unknown): void;
  /** The session's flat props ({} when nothing valid arrived), then forget it. */
  take(characterId: string): Record<string, number>;
}

export function createTerrariaStatsReporter(): TerrariaStatsReporter {
  const latest = new Map<string, TerrariaStatsMessage['stats']>();
  return {
    note(characterId, raw) {
      const parsed = TerrariaStatsMessageSchema.safeParse(raw);
      if (parsed.success) latest.set(characterId, parsed.data.stats);
    },
    take(characterId) {
      const s = latest.get(characterId);
      latest.delete(characterId);
      return s ? flattenTerrariaStats(s) : {};
    },
  };
}
