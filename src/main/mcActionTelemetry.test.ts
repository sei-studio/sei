// 261011: Minecraft per-action outcome telemetry, main side.
import { describe, it, expect, vi } from 'vitest';
import {
  actionNameKey,
  createMcSessionReporter,
  mcSessionActionsProps,
  parseActionStats,
  sessionEndActionSummary,
  MAX_ACTIONS,
  MC_SESSION_ACTIONS_EVENT,
} from './mcActionTelemetry';

function snap(over: Record<string, unknown> = {}) {
  return {
    v: 1,
    session_ms: 600_000,
    meta: { mc_version: '1.21.4', provider_kind: 'cloud', llm_provider: 'anthropic', model_id: 'claude-haiku-5-5' },
    actions: {
      gather: { n: 10, ok: 6, fail: 4, ms: 90_000, reasons: { partial: 3, no_path: 1 } },
      goTo: { n: 5, ok: 2, fail: 3, ms: 40_000, reasons: { no_path: 2, timeout: 1 } },
      placeBlock: { n: 1, ok: 1, fail: 0, ms: 300, reasons: {} },
    },
    counters: {
      llm_turns: 40, silent_turns: 25, say_turns: 15, stuck: 2, deaths: 1,
      player_msgs: 8, voice_msgs: 0, unanswered: 3, replied: 5, reply_ms_total: 20_000, pending_chats: 0,
    },
    llm_errors: { '429': 2, timeout: 1 },
    ...over,
  };
}

const ctx = { characterId: 'char-1', durationMs: 600_000, hostClient: 'fabric', modded: false };

describe('actionNameKey', () => {
  it('snake_cases registry names and rejects anything else', () => {
    expect(actionNameKey('goTo')).toBe('go_to');
    expect(actionNameKey('placeBlock')).toBe('place_block');
    expect(actionNameKey('gather')).toBe('gather');
    expect(actionNameKey('takeSmelted')).toBe('take_smelted');
    expect(actionNameKey('hi Steve')).toBeNull();
    expect(actionNameKey('a'.repeat(41))).toBeNull();
    expect(actionNameKey('')).toBeNull();
  });
});

describe('mcSessionActionsProps', () => {
  it('flattens to snake_case scalar keys that survive analytics.sanitize()', () => {
    const props = mcSessionActionsProps(parseActionStats(snap()), ctx);
    expect(props).toMatchObject({
      character_id: 'char-1',
      game: 'minecraft',
      session_minutes: 10,
      host_client: 'fabric',
      modded: false,
      stats_missing: false,
      provider_kind: 'cloud',
      llm_provider: 'anthropic',
      model_id: 'claude-haiku-5-5',
      mc_version: '1.21.4',
      actions_total: 16,
      actions_ok: 9,
      actions_failed: 7,
      actions_distinct: 3,
      actions_truncated: 0,
      fail_no_path: 3,
      fail_partial: 3,
      fail_timeout: 1,
      a_gather_n: 10,
      a_gather_ok: 6,
      a_gather_fail: 4,
      a_gather_ms: 90_000,
      a_gather_f_partial: 3,
      a_gather_f_no_path: 1,
      a_go_to_n: 5,
      a_go_to_f_no_path: 2,
      a_place_block_n: 1,
      llm_turns: 40,
      silent_turns: 25,
      unanswered: 3,
      reply_ms_avg: 4000,
      llm_err_429: 2,
      llm_err_timeout: 1,
    });
    for (const [k, v] of Object.entries(props)) {
      expect(k).toMatch(/^[a-z0-9_]+$/);
      expect(v === null || ['string', 'number', 'boolean'].includes(typeof v)).toBe(true);
    }
    expect(props).not.toHaveProperty('a_place_block_f_error');
  });

  it('caps per-action keys at the most-attempted MAX_ACTIONS', () => {
    const actions: Record<string, unknown> = {};
    for (let i = 0; i < 40; i++) actions[`act${String.fromCharCode(97 + (i % 26))}${i}`] = { n: i + 1, ok: i + 1, fail: 0, ms: 1, reasons: {} };
    const props = mcSessionActionsProps(parseActionStats(snap({ actions })), ctx);
    const perActionNames = new Set(Object.keys(props).filter((k) => k.startsWith('a_') && k.endsWith('_n')));
    expect(perActionNames.size).toBe(MAX_ACTIONS);
    expect(props.actions_distinct).toBe(40);
    expect(props.actions_truncated).toBe(15);
    // Totals still count every action, not only the emitted 25.
    expect(props.actions_total).toBe((40 * 41) / 2);
    // The busiest (n=40) is kept, the quietest (n=1) is not.
    expect(props).toHaveProperty('a_actn39_n', 40);
    expect(props).not.toHaveProperty('a_acta0_n');
    // The whole payload stays small.
    expect(Object.keys(props).length).toBeLessThan(200);
  });

  it('drops anything that is not a count, enum or identifier', () => {
    const props = mcSessionActionsProps(
      parseActionStats(
        snap({
          meta: { mc_version: 'Steve at 10,64,-3', provider_kind: 'mine', llm_provider: 'Hello World', model_id: 'qwen3:4b' },
          actions: {
            'say hi Steve': { n: 1, ok: 1, fail: 0, ms: 1, reasons: {} },
            dig: { n: 2, ok: 0, fail: 2, ms: 10, reasons: { 'chat text here': 1, timeout: 1 } },
            build: 'garbage',
          },
          counters: { llm_turns: -4, unanswered: 'lots', chat: 'hello' },
        }),
      ),
      ctx,
    );
    expect(props.mc_version).toBeNull();
    expect(props.provider_kind).toBeNull();
    expect(props.llm_provider).toBeNull();
    expect(props.model_id).toBe('qwen3:4b');
    expect(props.llm_turns).toBe(0);
    expect(props.unanswered).toBe(0);
    expect(props).not.toHaveProperty('chat');
    expect(props.a_dig_f_timeout).toBe(1);
    expect(Object.keys(props).some((k) => k.includes('chat_text') || k.includes('steve'))).toBe(false);
    expect(props.actions_distinct).toBe(1);
  });

  it('missing stats still yields a coverage event', () => {
    const props = mcSessionActionsProps(null, ctx);
    expect(props).toEqual({
      character_id: 'char-1', game: 'minecraft', session_minutes: 10, host_client: 'fabric', modded: false, stats_missing: true,
    });
  });

  it('rejects payloads that are not v1 snapshots', () => {
    expect(parseActionStats(null)).toBeNull();
    expect(parseActionStats({ v: 2 })).toBeNull();
    expect(parseActionStats('x')).toBeNull();
  });
});

describe('sessionEndActionSummary', () => {
  it('is compact', () => {
    expect(sessionEndActionSummary(parseActionStats(snap()))).toEqual({
      actions_total: 16, actions_failed: 7, llm_turns: 40, llm_errors: 3, unanswered: 3, deaths: 1,
    });
    expect(sessionEndActionSummary(null)).toEqual({});
  });
});

/**
 * End-path sequences, mirroring what index.ts does with the supervisor's
 * messages: action-stats → reporter.stats; first 'online' → reporter.online;
 * every terminal idle/error → closePlaySession (→ reporter.close, guarded by
 * playStartedAt) then reporter.settled. A tiny harness reproduces exactly that
 * wiring so each path can be replayed.
 */
function harness() {
  const capture = vi.fn();
  let t = 0;
  const reporter = createMcSessionReporter(capture, () => t);
  const live = new Set<string>(); // = playStartedAt
  const sessionEnded: Array<Record<string, unknown>> = [];
  const closePlaySession = (id: string, reason: string) => {
    if (!live.has(id)) return;
    live.delete(id);
    sessionEnded.push({ reason, ...reporter.close(id, reason) });
  };
  return {
    capture,
    sessionEnded,
    tick: (ms: number) => { t += ms; },
    stats: (id: string, s: unknown) => reporter.stats(id, s),
    online: (id: string) => {
      if (live.has(id)) return;
      live.add(id);
      reporter.online(id, { hostClient: 'vanilla', modded: false });
    },
    terminal: (id: string, reason: string) => {
      closePlaySession(id, reason);
      reporter.settled(id);
    },
    quitAll: () => { for (const id of [...live]) closePlaySession(id, 'app_quit'); },
    events: () => capture.mock.calls.filter(([e]) => e === MC_SESSION_ACTIONS_EVENT).map(([, p]) => p),
  };
}

describe('mc_session_actions flushes exactly once on every end path', () => {
  it('normal stop: final snapshot before summon-stopped, then the exit idle', () => {
    const h = harness();
    h.online('a');
    h.stats('a', snap({ counters: { llm_turns: 1 } }));
    h.tick(60_000);
    h.stats('a', snap()); // forced flush before summon-stopped
    h.terminal('a', 'user_stop'); // summon-stopped → idle
    h.terminal('a', 'user_stop'); // process exit → idle again
    expect(h.events()).toHaveLength(1);
    expect(h.events()[0]).toMatchObject({ reason: 'user_stop', llm_turns: 40, session_minutes: 1, stats_missing: false });
    expect(h.sessionEnded).toEqual([{ reason: 'user_stop', actions_total: 16, actions_failed: 7, llm_turns: 40, llm_errors: 3, unanswered: 3, deaths: 1 }]);
  });

  it('kick: error first (closes), then the bot drains and posts again, then idle', () => {
    const h = harness();
    h.online('a');
    h.stats('a', snap());
    h.terminal('a', 'kicked'); // error lifecycle, flushed just before
    h.stats('a', snap({ counters: { llm_turns: 99 } })); // gracefulShutdown summon-stopped flush
    h.terminal('a', 'kicked'); // idle
    expect(h.events()).toHaveLength(1);
    expect(h.events()[0]).toMatchObject({ reason: 'kicked', llm_turns: 40 });
    // The late snapshot was dropped and cannot leak into the next session.
    h.online('a');
    h.terminal('a', 'user_stop');
    expect(h.events()).toHaveLength(2);
    expect(h.events()[1]).toMatchObject({ stats_missing: true });
  });

  it('crash: no final snapshot, the last periodic one is used', () => {
    const h = harness();
    h.online('a');
    h.stats('a', snap({ counters: { llm_turns: 12 } }));
    h.terminal('a', 'crash');
    expect(h.events()).toHaveLength(1);
    expect(h.events()[0]).toMatchObject({ reason: 'crash', llm_turns: 12 });
  });

  it('crash before any snapshot: still exactly one event, stats_missing', () => {
    const h = harness();
    h.online('a');
    h.terminal('a', 'crash');
    expect(h.events()).toEqual([expect.objectContaining({ stats_missing: true, reason: 'crash' })]);
  });

  it('user quits the app: closed in before-quit, the drain statuses after it add nothing', () => {
    const h = harness();
    h.online('a');
    h.online('b');
    h.stats('a', snap());
    h.stats('b', snap({ counters: { deaths: 4 } }));
    h.quitAll();
    h.stats('a', snap()); // drain flush arrives after
    h.terminal('a', 'user_stop');
    h.terminal('b', 'user_stop');
    expect(h.events()).toHaveLength(2);
    expect(h.events().map((p) => p.reason)).toEqual(['app_quit', 'app_quit']);
    expect(h.events()[1]).toMatchObject({ character_id: 'b', deaths: 4 });
  });

  it('a summon that never went live sends nothing and leaves nothing behind', () => {
    const h = harness();
    h.stats('a', snap());
    h.terminal('a', 'error');
    expect(h.events()).toHaveLength(0);
    h.online('a');
    h.terminal('a', 'user_stop');
    expect(h.events()[0]).toMatchObject({ stats_missing: true });
  });

  it('a second online status mid-session does not reset the session', () => {
    const h = harness();
    h.online('a');
    h.tick(120_000);
    h.online('a');
    h.stats('a', snap());
    h.terminal('a', 'user_stop');
    expect(h.events()).toHaveLength(1);
    expect(h.events()[0]).toMatchObject({ session_minutes: 2 });
  });
});
