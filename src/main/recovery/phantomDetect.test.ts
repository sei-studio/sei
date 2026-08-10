/**
 * phantomDetect tests — pins the ported heal-phantom-call.mjs semantics.
 *
 * The three fixture shapes mirror the incident data the thresholds were tuned
 * on: a typed chat must never flag (no voice rows at all), a real human call
 * must never flag (user utterances tens of seconds apart), and the 52-minute
 * 7s-cadence flood must flag. The memory split must preserve everything that
 * is not an in-window entry line byte-identically, `## World N` headers
 * included.
 */
import { describe, it, expect } from 'vitest';
import {
  findVoiceSessions,
  splitMemory,
  parseChatJsonl,
  SESSION_GAP_MS,
  MEMORY_PAD_MS,
} from './phantomDetect';

const T0 = Date.parse('2026-08-09T05:00:00Z');

interface FixtureRow {
  role: 'user' | 'companion' | 'system';
  ts: number;
  voice?: boolean;
  text?: string;
}

const wrap = (rows: FixtureRow[]): Array<{ msg: FixtureRow }> => rows.map((msg) => ({ msg }));

/** A voice call: alternating user/companion rows, user rows every `userGapMs`. */
function voiceCall(startTs: number, durationMs: number, userGapMs: number): FixtureRow[] {
  const rows: FixtureRow[] = [];
  for (let t = 0; t <= durationMs; t += userGapMs) {
    rows.push({ role: 'user', ts: startTs + t, voice: true });
    rows.push({ role: 'companion', ts: startTs + t + Math.min(2000, userGapMs / 2), voice: true });
  }
  return rows;
}

describe('findVoiceSessions', () => {
  it('normal typed chat produces no sessions at all', () => {
    const rows: FixtureRow[] = [];
    for (let i = 0; i < 200; i++) {
      rows.push({ role: i % 2 ? 'companion' : 'user', ts: T0 + i * 30_000, text: 'x' });
    }
    expect(findVoiceSessions(wrap(rows))).toEqual([]);
  });

  it('a 10-minute human call with 45s user gaps does not flag', () => {
    const sessions = findVoiceSessions(wrap(voiceCall(T0, 10 * 60_000, 45_000)));
    expect(sessions).toHaveLength(1);
    expect(sessions[0].flagged).toBe(false);
    // Fails all three arms: span < 15min, user rows < 50, median gap > 15s.
    expect(sessions[0].spanMs).toBeLessThan(15 * 60_000);
    expect(sessions[0].medianUserGapS).toBeGreaterThan(15);
  });

  it('a long human call with sparse user rows does not flag (backseat shape)', () => {
    // 52 minutes, but the player speaks every ~4 minutes: span passes, cadence
    // and count both fail. This is the autonomous-session shape that MUST stay
    // clean — the signature is user-row frequency, never session length.
    const sessions = findVoiceSessions(wrap(voiceCall(T0, 52 * 60_000, 4 * 60_000)));
    expect(sessions).toHaveLength(1);
    expect(sessions[0].flagged).toBe(false);
  });

  it('the 7s-cadence 52-minute flood flags', () => {
    const sessions = findVoiceSessions(wrap(voiceCall(T0, 52 * 60_000, 7_000)));
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.flagged).toBe(true);
    expect(s.userTs.length).toBeGreaterThanOrEqual(50);
    expect(s.medianUserGapS).toBeLessThanOrEqual(15);
    expect(s.spanMs).toBeGreaterThanOrEqual(15 * 60_000);
  });

  it('a >5min gap splits two sessions; each is measured independently', () => {
    const a = voiceCall(T0, 20 * 60_000, 7_000); // flood
    const bStart = T0 + 20 * 60_000 + SESSION_GAP_MS + 60_000;
    const b = voiceCall(bStart, 8 * 60_000, 40_000); // short human call
    const sessions = findVoiceSessions(wrap([...a, ...b]));
    expect(sessions).toHaveLength(2);
    expect(sessions[0].flagged).toBe(true);
    expect(sessions[1].flagged).toBe(false);
  });

  it('a non-voice row ends the run (conservative: quarantine gets narrower)', () => {
    const a = voiceCall(T0, 16 * 60_000, 7_000);
    const sys: FixtureRow = { role: 'system', ts: T0 + 16 * 60_000 + 1000, text: 'play row' };
    const b = voiceCall(T0 + 16 * 60_000 + 2000, 16 * 60_000, 7_000);
    const sessions = findVoiceSessions(wrap([...a, sys, ...b]));
    expect(sessions).toHaveLength(2);
    // The system row's index belongs to NEITHER session.
    const sysIdx = a.length;
    expect(sessions[0].idx).not.toContain(sysIdx);
    expect(sessions[1].idx).not.toContain(sysIdx);
  });

  it('rows without a numeric ts or without voice:true are ignored', () => {
    const rows = [
      { msg: { role: 'user', voice: true } }, // no ts
      { msg: { role: 'user', ts: T0, voice: 'yes' } }, // voice not === true
      { msg: null }, // unparseable line
    ];
    expect(findVoiceSessions(rows as never)).toEqual([]);
  });
});

describe('splitMemory', () => {
  const iso = (ms: number): string => new Date(ms).toISOString();

  it('removes only in-window entry lines and keeps everything else byte-identically', () => {
    const win = { start: T0, end: T0 + 60 * 60_000 };
    const before = T0 - MEMORY_PAD_MS - 60_000;
    const inside = T0 + 10 * 60_000;
    const padded = win.end + MEMORY_PAD_MS - 1_000; // inside the pad → removed
    const after = win.end + MEMORY_PAD_MS + 60_000;
    const md = [
      '# Memory',
      '',
      '## World 1 — plains cottage',
      `- [${iso(before)}] real memory before the call`,
      `- [${iso(inside)}] phantom junk from the call`,
      `- [${iso(padded)}] phantom junk written just after`,
      'free-form prose line with no stamp',
      '## World 2 — cave base',
      `- [${iso(after)}] real memory after`,
      '',
    ].join('\n');
    const { kept, removed } = splitMemory(md, [win]);
    expect(removed).toEqual([
      `- [${iso(inside)}] phantom junk from the call`,
      `- [${iso(padded)}] phantom junk written just after`,
    ]);
    expect(kept).toBe(
      [
        '# Memory',
        '',
        '## World 1 — plains cottage',
        `- [${iso(before)}] real memory before the call`,
        'free-form prose line with no stamp',
        '## World 2 — cave base',
        `- [${iso(after)}] real memory after`,
        '',
      ].join('\n'),
    );
  });

  it('no windows means nothing is removed and the text is unchanged', () => {
    const md = `- [${iso(T0)}] anything\n## World 3 — x\n`;
    const { kept, removed } = splitMemory(md, []);
    expect(removed).toEqual([]);
    expect(kept).toBe(md);
  });
});

describe('parseChatJsonl', () => {
  it('keeps raw lines, parses valid JSON, nulls invalid, skips blanks', () => {
    const raw = '{"role":"user","ts":1}\n\nnot json\n{"role":"companion","ts":2}\n';
    const rows = parseChatJsonl(raw);
    expect(rows).toHaveLength(3);
    expect(rows[0].msg).toEqual({ role: 'user', ts: 1 });
    expect(rows[1].line).toBe('not json');
    expect(rows[1].msg).toBeNull();
    expect(rows[2].line).toBe('{"role":"companion","ts":2}');
  });
});
