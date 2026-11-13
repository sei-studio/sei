import { describe, expect, it } from 'vitest';
import { createFactorioStats } from '../bot/adapter/factorio/stats.js';
import { FAIL_CLASSES, REFLEX_KINDS } from '../bot/adapter/factorio/stats.js';
import { MAX_VERBS, createFactorioStatsReporter, flattenFactorioStats } from './factorioSessionStats';

describe('factorio session stats', () => {
  it('flattens a snapshot into flat fct_* props that survive analytics sanitize', () => {
    const props = flattenFactorioStats({
      verbs: {
        goTo: { n: 3, ok: 2, fail: { no_path: 1 } },
        craft: { n: 2, ok: 0, fail: { missing_materials: 2, made_up: 5 } },
      },
      reflex: { fight: 1, bogus: 9 },
      link_timeouts: 4,
      app_respawns: 1,
    });
    expect(props.fct_verbs_n).toBe(5);
    expect(props.fct_verbs_ok).toBe(2);
    expect(props.fct_v_goto_n).toBe(3);
    expect(props.fct_v_goto_ok).toBe(2);
    expect(props.fct_v_craft_n).toBe(2);
    expect(props.fct_fail_no_path).toBe(1);
    expect(props.fct_fail_missing_materials).toBe(2);
    expect(props.fct_fail_made_up).toBeUndefined();
    expect(props.fct_reflex_fight).toBe(1);
    expect(props.fct_reflex_bogus).toBeUndefined();
    expect(props.fct_link_timeouts).toBe(4);
    expect(props.fct_app_respawns).toBe(1);
    for (const c of FAIL_CLASSES) expect(props[`fct_fail_${c}`]).toBeTypeOf('number');
    for (const k of REFLEX_KINDS) expect(props[`fct_reflex_${k}`]).toBeTypeOf('number');
    for (const [k, v] of Object.entries(props)) {
      expect(k).toMatch(/^[a-z0-9_]+$/);
      expect(typeof v).toBe('number');
    }
  });

  it('caps per-verb props', () => {
    const verbs = Object.fromEntries(Array.from({ length: MAX_VERBS + 10 }, (_, i) => [`v${String(i).padStart(3, '0')}`, { n: 1, ok: 1, fail: {} }]));
    const props = flattenFactorioStats({ verbs, reflex: {}, link_timeouts: 0, app_respawns: 0 });
    expect(Object.keys(props).filter((k) => k.startsWith('fct_v_') && k.endsWith('_n'))).toHaveLength(MAX_VERBS);
    expect(props.fct_verbs_n).toBe(MAX_VERBS + 10);
  });

  it('accepts the bot snapshot shape, keeps the newest per character, and takes once', () => {
    const r = createFactorioStatsReporter();
    const stats = createFactorioStats();
    r.note('a', { type: 'factorio-stats', stats: stats.snapshot() });
    r.note('a', { type: 'factorio-stats', stats: { verbs: { mine: { n: 7, ok: 7, fail: {} } }, reflex: {}, link_timeouts: 0, app_respawns: 0 } });
    r.note('a', { type: 'factorio-stats', stats: { verbs: 'nope' } });
    r.note('a', { type: 'dst-lives' });
    const props = r.take('a');
    expect(props.fct_v_mine_n).toBe(7);
    expect(r.take('a')).toEqual({});
    expect(r.take('b')).toEqual({});
  });
});
