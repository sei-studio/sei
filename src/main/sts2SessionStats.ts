/**
 * 261115: Slay the Spire 2 session counters for `bot_session_ended`. The bot
 * posts `{type:'sts2-stats', stats}` about every 30 s and once at the end
 * (src/bot/adapter/sts2/stats.js createSts2Stats().snapshot()); main keeps
 * the newest per character and folds it into the end event once, as FLAT
 * `sts2_*` props (analytics.sanitize drops nested objects). Same pattern as
 * the Factorio and DST reporters.
 *
 * Shape only: counts, closed family / failure enums, booleans and the run's
 * outcome enum. No card names, chat or state text ever reach this.
 *
 *   sts2_acts, sts2_acts_ok          moves sent / accepted by the game
 *   sts2_f_<family>                  moves per action family (every family, 0 included)
 *   sts2_fail_<class>                refused moves per failure class (every class)
 *   sts2_forces, sts2_wakes, sts2_nudges, sts2_batch_max, sts2_says
 *   sts2_first_act_ms                time from brain start to the first accepted move
 *   sts2_combats_won, sts2_max_floor, sts2_max_act, sts2_run_end
 *   sts2_seat_drops, sts2_host_seen, sts2_structured_state, sts2_coop
 */
import { z } from 'zod';
import { ACTION_FAMILIES, FAIL_CLASSES } from '../bot/adapter/sts2/stats.js';

const Count = z.number().int().min(0).max(1_000_000);

export const Sts2StatsMessageSchema = z.object({
  type: z.literal('sts2-stats'),
  stats: z.object({
    acts: Count.default(0),
    acts_ok: Count.default(0),
    by_family: z.record(z.string(), Count).default({}),
    failures: z.record(z.string(), Count).default({}),
    forces: Count.default(0),
    wakes: Count.default(0),
    nudges: Count.default(0),
    batch_max: Count.default(0),
    first_act_ms: z.number().int().min(0).max(86_400_000).nullable().default(null),
    combats_won: Count.default(0),
    max_floor: z.number().int().min(0).max(1000).default(0),
    max_act: z.number().int().min(0).max(100).default(0),
    run_end: z.enum(['won', 'lost', 'abandoned']).nullable().default(null),
    seat_drops: Count.default(0),
    host_seen: z.boolean().default(false),
    structured_state: z.boolean().default(false),
    coop: z.boolean().default(false),
    says: Count.default(0),
  }),
});
export type Sts2StatsMessage = z.infer<typeof Sts2StatsMessageSchema>;
export type Sts2StatsProps = Record<string, number | string | boolean>;

export function flattenSts2Stats(s: Sts2StatsMessage['stats']): Sts2StatsProps {
  const out: Sts2StatsProps = {
    sts2_acts: s.acts,
    sts2_acts_ok: s.acts_ok,
    sts2_forces: s.forces,
    sts2_wakes: s.wakes,
    sts2_nudges: s.nudges,
    sts2_batch_max: s.batch_max,
    sts2_says: s.says,
    sts2_combats_won: s.combats_won,
    sts2_max_floor: s.max_floor,
    sts2_max_act: s.max_act,
    sts2_run_end: s.run_end ?? 'none',
    sts2_seat_drops: s.seat_drops,
    sts2_host_seen: s.host_seen,
    sts2_structured_state: s.structured_state,
    sts2_coop: s.coop,
  };
  if (s.first_act_ms != null) out.sts2_first_act_ms = s.first_act_ms;
  for (const f of ACTION_FAMILIES as readonly string[]) out[`sts2_f_${f}`] = s.by_family[f] ?? 0;
  for (const c of FAIL_CLASSES as readonly string[]) out[`sts2_fail_${c}`] = s.failures[c] ?? 0;
  return out;
}

export interface Sts2StatsReporter {
  note(characterId: string, raw: unknown): void;
  take(characterId: string): Sts2StatsProps;
}

export function createSts2StatsReporter(): Sts2StatsReporter {
  const latest = new Map<string, Sts2StatsMessage['stats']>();
  return {
    note(characterId, raw) {
      const parsed = Sts2StatsMessageSchema.safeParse(raw);
      if (parsed.success) latest.set(characterId, parsed.data.stats);
    },
    take(characterId) {
      const s = latest.get(characterId);
      latest.delete(characterId);
      return s ? flattenSts2Stats(s) : {};
    },
  };
}
