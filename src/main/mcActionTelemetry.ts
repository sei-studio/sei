/**
 * Minecraft per-action outcome telemetry, main side (261011).
 *
 * The bot keeps aggregate counters for its session (src/bot/brain/actionStats.js)
 * and posts cumulative `{type:'action-stats'}` snapshots up the port; the
 * supervisor hands them here via `onActionStats`. When the play session closes
 * (closePlaySession in index.ts, which runs exactly once per live session for
 * every end path: user stop, quit(), kick/error, crash exit, app quit, account
 * teardown) the latest snapshot is flattened into ONE `mc_session_actions`
 * event and a compact summary rides on `bot_session_ended`.
 *
 * Flattening is required, not cosmetic: analytics.sanitize() drops nested
 * objects and any key outside /^[a-z0-9_]+$/, so per-action numbers become
 * scalar keys like `a_gather_n` / `a_go_to_f_no_path`.
 *
 * Privacy: the snapshot is re-validated here (the bot is a separate process).
 * Only counts, durations and closed enums survive; action names must be
 * registry-style identifiers, MC version passes a strict charset, and a
 * model id is reported only when it is a public catalog name (else 'custom').
 * No chat text, names, coordinates or persona ever reach this module. The
 * analytics opt-out is enforced by capture() itself.
 */
import { z } from 'zod';
import { DEFAULT_MODELS } from '../shared/llmCatalog';

export const MC_SESSION_ACTIONS_EVENT = 'mc_session_actions';
/** Per-action keys are emitted for at most this many actions (most attempted first). */
export const MAX_ACTIONS = 25;

/** Mirrors FAIL_REASONS in src/bot/brain/actionStats.js. */
export const FAIL_REASONS = [
  'no_path',
  'timeout',
  'missing_materials',
  'target_not_found',
  'aborted_by_preempt',
  'partial',
  'refused',
  'bad_args',
  'error',
] as const;
/** Mirrors LLM_ERROR_CLASSES in src/bot/brain/actionStats.js. */
export const LLM_ERROR_CLASSES = ['429', '401', '402', '5xx', 'timeout', 'other'] as const;

const COUNTER_KEYS = [
  'llm_turns',
  'silent_turns',
  'say_turns',
  'stuck',
  'deaths',
  'player_msgs',
  'voice_msgs',
  'unanswered',
  'replied',
  'reply_ms_total',
  'pending_chats',
] as const;

const count = z.number().int().nonnegative().catch(0);

const ActionEntrySchema = z.object({
  n: count,
  ok: count,
  fail: count,
  ms: count,
  reasons: z.record(z.string(), count).catch({}),
});

const ActionStatsSchema = z.object({
  v: z.literal(1),
  session_ms: count.optional(),
  meta: z.record(z.string(), z.unknown()).catch({}),
  actions: z.record(z.string(), z.unknown()).catch({}),
  counters: z.record(z.string(), z.unknown()).catch({}),
  llm_errors: z.record(z.string(), z.unknown()).catch({}),
});

export type ActionStatsSnapshot = z.infer<typeof ActionStatsSchema>;

/** Validate a raw port payload; null when it is not a v1 snapshot. */
export function parseActionStats(raw: unknown): ActionStatsSnapshot | null {
  const r = ActionStatsSchema.safeParse(raw);
  return r.success ? r.data : null;
}

/** `goTo` → `go_to`, `placeBlock` → `place_block`; null for anything that is not an identifier. */
export function actionNameKey(name: string): string | null {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(name)) return null;
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0;
}

function cleanString(v: unknown, re: RegExp, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().slice(0, max);
  return re.test(s) ? s : null;
}

/**
 * A model id is reported only when it is a public catalog name. On the cloud
 * the proxy model is ours; a BYOK model comes from the user's own provider
 * list, which can hold names the user chose (Ollama tags they created, OpenAI
 * fine-tunes `ft:<base>:<org>:<suffix>:<id>`, HF paths with a username), so
 * anything other than an Anthropic id or the provider default becomes 'custom'.
 */
export function reportableModelId(
  kind: unknown,
  provider: string | null,
  model: string | null,
): string | null {
  if (model === null) return null;
  if (kind === 'cloud') return model;
  if (provider === 'anthropic' && /^claude-[a-z0-9.-]+$/.test(model)) return model;
  if (provider && (DEFAULT_MODELS as Record<string, string>)[provider] === model) return model;
  return 'custom';
}

export interface McSessionContext {
  characterId: string;
  durationMs: number;
  /** lanHost.client at first-online, null when unknown. */
  hostClient: string | null;
  /** lanHostWarning() said 'modded' or 'forge'. */
  modded: boolean;
}

/**
 * Flat scalar props for `mc_session_actions`. `stats` null (the bot never got
 * a snapshot out, e.g. it crashed in its first seconds) still yields an event
 * with `stats_missing: true` so coverage is measurable.
 */
export function mcSessionActionsProps(
  stats: ActionStatsSnapshot | null,
  ctx: McSessionContext,
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {
    character_id: ctx.characterId,
    game: 'minecraft',
    session_minutes: Math.round(Math.max(0, ctx.durationMs) / 6000) / 10,
    host_client: ctx.hostClient,
    modded: ctx.modded,
    stats_missing: stats === null,
  };
  if (!stats) return out;

  const meta = stats.meta;
  const kind = meta.provider_kind;
  out.provider_kind = kind === 'cloud' || kind === 'byok' || kind === 'ollama' ? kind : null;
  out.llm_provider = cleanString(meta.llm_provider, /^[a-z]{2,20}$/, 20);
  out.model_id = reportableModelId(
    out.provider_kind,
    out.llm_provider,
    cleanString(meta.model_id, /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/, 80),
  );
  out.mc_version = cleanString(meta.mc_version, /^\d+\.\d+(\.\d+)?([-.][A-Za-z0-9.]+)?$/, 20);

  // Per-action rows, validated; ranked by attempts so the cap keeps the busiest.
  const rows: Array<{ key: string; e: z.infer<typeof ActionEntrySchema> }> = [];
  const failTotals: Record<string, number> = {};
  let total = 0;
  let ok = 0;
  let failed = 0;
  let ms = 0;
  for (const [name, raw] of Object.entries(stats.actions)) {
    const key = actionNameKey(name);
    const parsed = ActionEntrySchema.safeParse(raw);
    if (!key || !parsed.success) continue;
    const e = parsed.data;
    rows.push({ key, e });
    total += e.n;
    ok += e.ok;
    failed += e.fail;
    ms += e.ms;
    for (const [reason, c] of Object.entries(e.reasons)) {
      if ((FAIL_REASONS as readonly string[]).includes(reason) && c > 0) {
        failTotals[reason] = (failTotals[reason] ?? 0) + c;
      }
    }
  }
  rows.sort((a, b) => b.e.n - a.e.n || a.key.localeCompare(b.key));
  out.actions_total = total;
  out.actions_ok = ok;
  out.actions_failed = failed;
  out.actions_ms = ms;
  out.actions_distinct = rows.length;
  out.actions_truncated = Math.max(0, rows.length - MAX_ACTIONS);
  for (const r of FAIL_REASONS) if (failTotals[r]) out[`fail_${r}`] = failTotals[r];
  for (const { key, e } of rows.slice(0, MAX_ACTIONS)) {
    out[`a_${key}_n`] = e.n;
    out[`a_${key}_ok`] = e.ok;
    out[`a_${key}_fail`] = e.fail;
    out[`a_${key}_ms`] = e.ms;
    for (const r of FAIL_REASONS) {
      const c = e.reasons[r];
      if (c && c > 0) out[`a_${key}_f_${r}`] = c;
    }
  }

  for (const k of COUNTER_KEYS) out[k] = num(stats.counters[k]);
  const replied = num(stats.counters.replied);
  out.reply_ms_avg = replied > 0 ? Math.round(num(stats.counters.reply_ms_total) / replied) : null;
  for (const c of LLM_ERROR_CLASSES) {
    const v = num(stats.llm_errors[c]);
    if (v > 0) out[`llm_err_${c}`] = v;
  }
  return out;
}

/** Compact summary merged into `bot_session_ended` (Minecraft only). */
export function sessionEndActionSummary(
  stats: ActionStatsSnapshot | null,
): Record<string, number> {
  if (!stats) return {};
  let total = 0;
  let failed = 0;
  for (const raw of Object.values(stats.actions)) {
    const p = ActionEntrySchema.safeParse(raw);
    if (!p.success) continue;
    total += p.data.n;
    failed += p.data.fail;
  }
  let llmErrors = 0;
  for (const c of LLM_ERROR_CLASSES) llmErrors += num(stats.llm_errors[c]);
  return {
    actions_total: total,
    actions_failed: failed,
    llm_turns: num(stats.counters.llm_turns),
    llm_errors: llmErrors,
    unanswered: num(stats.counters.unanswered),
    deaths: num(stats.counters.deaths),
  };
}

/**
 * Latest snapshot per character, owned by main. `take` consumes it so a
 * session's numbers can never be read twice or leak into the next summon.
 */
export function createActionStatsStore() {
  const latest = new Map<string, ActionStatsSnapshot>();
  return {
    /** A bot posted a snapshot; invalid payloads are ignored. */
    put(characterId: string, raw: unknown): void {
      const s = parseActionStats(raw);
      if (s) latest.set(characterId, s);
    },
    take(characterId: string): ActionStatsSnapshot | null {
      const s = latest.get(characterId) ?? null;
      latest.delete(characterId);
      return s;
    },
    clear(characterId: string): void {
      latest.delete(characterId);
    },
  };
}

type CaptureFn = (event: string, props: Record<string, unknown>) => void;

/**
 * Per-character Minecraft session reporter. index.ts drives it from the same
 * places it already tracks play sessions:
 *   - `stats`   on every {type:'action-stats'} port message,
 *   - `online`  on the first 'online' status of a session,
 *   - `close`   from closePlaySession (once per live session, every end path),
 *   - `settled` after any terminal idle/error status.
 * `close` sends `mc_session_actions` at most once per `online` and returns
 * the compact summary for bot_session_ended.
 */
export function createMcSessionReporter(capture: CaptureFn, now: () => number = () => Date.now()) {
  const store = createActionStatsStore();
  const live = new Map<string, { at: number; hostClient: string | null; modded: boolean }>();
  return {
    stats(characterId: string, raw: unknown): void {
      // Snapshots are cumulative per bot process, so one that lands outside a
      // live session (a late flush after close, a pre-spawn post) carries
      // nothing a later in-session one will not, and storing it is the only
      // way a stale snapshot could be reported for the NEXT session.
      if (!live.has(characterId)) return;
      store.put(characterId, raw);
    },
    online(characterId: string, host: { hostClient: string | null; modded: boolean }): void {
      if (live.has(characterId)) return;
      live.set(characterId, { at: now(), ...host });
    },
    close(characterId: string, reason: string): Record<string, number> {
      const ctx = live.get(characterId);
      if (!ctx) return {};
      live.delete(characterId);
      const stats = store.take(characterId);
      capture(MC_SESSION_ACTIONS_EVENT, {
        ...mcSessionActionsProps(stats, {
          characterId,
          durationMs: now() - ctx.at,
          hostClient: ctx.hostClient,
          modded: ctx.modded,
        }),
        reason,
      });
      return sessionEndActionSummary(stats);
    },
    /** A terminal status landed: drop snapshots no live session will read. */
    settled(characterId: string): void {
      if (!live.has(characterId)) store.clear(characterId);
    },
  };
}
