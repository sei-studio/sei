import { describe, it, expect } from 'vitest';
import { createSts2StatsReporter } from './sts2SessionStats';
import { createSts2Stats } from '../bot/adapter/sts2/stats.js';

describe('sts2 session stats', () => {
  it('folds the bot snapshot into flat, shape-only props', () => {
    const st = createSts2Stats();
    st.act('play_card', true);
    st.act('end_turn', true);
    st.act('shop_buy', false, 'failed: Not enough gold');
    st.state({ run: { act: 1, floor: 4 } });
    st.event('combat_won');
    st.event('run_lost');
    const r = createSts2StatsReporter();
    r.note('c1', { type: 'sts2-stats', stats: st.snapshot() });
    const props = r.take('c1');
    expect(props).toMatchObject({
      sts2_acts: 3,
      sts2_acts_ok: 2,
      sts2_f_play_card: 1,
      sts2_f_shop: 1,
      sts2_f_map: 0,
      sts2_fail_rejected: 1,
      sts2_max_floor: 4,
      sts2_combats_won: 1,
      sts2_run_end: 'lost',
      sts2_structured_state: true,
    });
    for (const [k, v] of Object.entries(props)) {
      expect(k).toMatch(/^[a-z0-9_]+$/);
      expect(['number', 'boolean', 'string']).toContain(typeof v);
      if (typeof v === 'string') expect(['won', 'lost', 'abandoned', 'none']).toContain(v);
    }
    expect(r.take('c1')).toEqual({});
  });

  it('ignores junk', () => {
    const r = createSts2StatsReporter();
    r.note('c1', { type: 'sts2-stats', stats: { acts: -1 } });
    r.note('c1', { type: 'other' });
    expect(r.take('c1')).toEqual({});
  });
});
