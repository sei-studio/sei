/**
 * continuityCore (261113, v0.7 consistency D1): game sessions (play rows)
 * now fold with the conversation around them and ride in the launch handoff.
 */
import { describe, it, expect } from 'vitest';
import type { ChatMessage } from '../../shared/ipc';
import {
  bridgeAfterFold,
  chatContextFrom,
  FOLD_BATCH,
  FOLD_MAX_PLAY_ROWS,
  MAX_SESSION_ROWS,
  PLAY_FOLD_TRIGGER,
  launchContinuityFrom,
  MAX_UNSUMMARIZED,
  RECENT_WINDOW,
  runFold,
  selectFold,
  SUMMARY_MAX_TOKENS,
  type FoldLlm,
} from './continuityCore';

const T0 = 1_700_000_000_000;
function rows(n: number, from = 0): ChatMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${from + i}`,
    role: (from + i) % 2 === 0 ? 'user' : 'companion',
    text: `row ${from + i}`,
    ts: T0 + (from + i) * 1000,
  })) as ChatMessage[];
}
const play = (id: string, extra: Record<string, unknown> = {}): ChatMessage =>
  ({ id, role: 'system', text: 'You and Sui played Minecraft for 30 minutes.', ts: T0, event: { kind: 'play', game: 'minecraft', durationMs: 1_800_000, ...extra } }) as unknown as ChatMessage;
const call = (id: string): ChatMessage => ({ id, role: 'system', text: 'call', ts: T0, event: { kind: 'call' } }) as unknown as ChatMessage;
const empty = { summary: '', summarizedCount: 0 };

describe('selectFold', () => {
  it('is not due below the window plus a batch', () => {
    expect(selectFold(rows(RECENT_WINDOW + FOLD_BATCH - 1), empty)).toBeNull();
  });

  it('folds play rows inside the batch, never counts them, and skips other system rows', () => {
    const raw = [...rows(10), play('p1', { recap: 'we built a cabin' }), call('c'), ...rows(90, 10), play('p2')];
    const sel = selectFold(raw, empty)!;
    expect(sel.counted).toBe(100 - RECENT_WINDOW);
    expect(sel.msgs.filter((m) => m.role !== 'session')).toHaveLength(sel.counted);
    const sessions = sel.msgs.filter((m) => m.role === 'session');
    expect(sessions).toHaveLength(1);
    expect(sessions[0].text).toBe('You and Sui played Minecraft for 30 minutes. Your own recap of it afterwards: we built a cabin');
    expect(sel.msgs[10].role).toBe('session');
  });

  it('a play row after the batch stays for the next fold, and is folded exactly once', () => {
    const raw = [...rows(60), play('p'), ...rows(60, 60)];
    const first = selectFold(raw, empty)!;
    expect(first.counted).toBe(70);
    expect(first.msgs.some((m) => m.role === 'session')).toBe(true);
    const second = selectFold([...raw, ...rows(100, 120)], { summary: 's', summarizedCount: first.counted });
    expect(second?.msgs.some((m) => m.role === 'session')).toBe(false);

    const late = [...rows(80), play('q'), ...rows(20, 80)];
    expect(selectFold(late, empty)!.msgs.some((m) => m.role === 'session')).toBe(false);
    expect(selectFold([...late, ...rows(80, 100)], { summary: 's', summarizedCount: 50 })!.msgs.some((m) => m.role === 'session')).toBe(true);
  });
});

describe('chatContextFrom and launchContinuityFrom', () => {
  it('chat context keeps system rows from the watermark on', () => {
    const raw = [...rows(4), play('old'), ...rows(4, 4), play('new'), ...rows(2, 8)];
    const ctx = chatContextFrom(raw, { summary: 'sum', summarizedCount: 4 });
    expect(ctx.summary).toBe('sum');
    expect(ctx.base).toBe(4);
    expect(ctx.history.map((m) => m.id)).toEqual(['old', 'm4', 'm5', 'm6', 'm7', 'new', 'm8', 'm9']);
  });

  it('the launch handoff carries play rows as sessions with their story', () => {
    const raw = [...rows(2), play('p', { lines: [{ who: 'player', text: 'night' }] }), call('c'), ...rows(1, 2)];
    const lc = launchContinuityFrom(raw, empty)!;
    expect(lc.recent.map((r) => r.role)).toEqual(['user', 'companion', 'session', 'user']);
    expect(lc.recent[2].text).toContain('The last things said in the game: Player: "night"');
  });

  it('is null only when there is nothing to hand over', () => {
    expect(launchContinuityFrom([], empty)).toBeNull();
    expect(launchContinuityFrom([call('c')], empty)).toBeNull();
    expect(launchContinuityFrom([play('p')], empty)?.recent).toHaveLength(1);
    // A stale bridge over a cleared transcript is ignored.
    expect(launchContinuityFrom(rows(2), { summary: 'gone', summarizedCount: 5 })).toEqual({ summary: '', recent: expect.any(Array) });
  });

  it('reads are clamped to MAX_UNSUMMARIZED when folds keep failing', () => {
    const raw = rows(MAX_UNSUMMARIZED + 20);
    expect(chatContextFrom(raw, empty).history).toHaveLength(MAX_UNSUMMARIZED);
  });
});

describe('runFold', () => {
  const llm = (reply: string | Error, stop: string | null = 'end_turn') => {
    const calls: Array<Record<string, unknown>> = [];
    const l: FoldLlm & { calls: typeof calls } = {
      calls,
      async call(p) {
        calls.push(p as unknown as Record<string, unknown>);
        if (reply instanceof Error && calls.length === 1) throw reply;
        return { content: [{ type: 'text', text: reply instanceof Error ? '<summary>after fallback</summary>' : reply } as { type: string }], stopReason: stop };
      },
    };
    return l;
  };
  const msgs = [{ role: 'session' as const, text: 'You and Sui played Minecraft. Your own recap of it afterwards: we fished', ts: T0 }];

  it('returns the summary tag', async () => {
    const l = llm('<summary>we fished</summary>');
    expect(await runFold({ llm: l, summary: '', msgs, model: 'm' })).toEqual({ status: 'ok', summary: 'we fished', facts: [], raw: '<summary>we fished</summary>' });
    expect(l.calls[0].maxTokens).toBe(SUMMARY_MAX_TOKENS);
    expect(String((l.calls[0].messages as Array<{ content: string }>)[0].content)).toContain('Game session');
  });

  it('returns the <remember> facts and shows the fold the memory notes (261113 D2)', async () => {
    const l = llm('<summary>we fished</summary>\n<remember>\n- Alex has a cat named Mochi\n\n2. Alex now works at the library, not the bakery\n</remember>');
    const r = await runFold({ llm: l, summary: 'old', msgs, memory: '- [5 Oct 2026, 20:11] alex plays on weekends', model: 'm' });
    expect(r).toMatchObject({ status: 'ok', summary: 'we fished', facts: ['Alex has a cat named Mochi', 'Alex now works at the library, not the bakery'] });
    const user = String((l.calls[0].messages as Array<{ content: string }>)[0].content);
    expect(user.indexOf('Your memory notes, already saved:\n- [5 Oct 2026, 20:11] alex plays on weekends')).toBe(0);
    expect(String(l.calls[0].system)).toContain('<remember>');
    expect(String(l.calls[0].system)).not.toMatch(/[\u2014\u2013]/);
    expect((await runFold({ llm: llm('<summary>s</summary><remember></remember>'), summary: '', msgs, model: 'm' })).status === 'ok').toBe(true);
  });

  it('reports max_tokens and empty replies; an untagged reply is the summary', async () => {
    expect((await runFold({ llm: llm('<summary>cut', 'max_tokens'), summary: '', msgs, model: 'm' })).status).toBe('max_tokens');
    expect((await runFold({ llm: llm('  '), summary: '', msgs, model: 'm' })).status).toBe('empty');
    expect(await runFold({ llm: llm('no tag'), summary: '', msgs, model: 'm' })).toMatchObject({ status: 'ok', summary: 'no tag' });
    // An untagged summary never stores the remember block as summary text.
    expect(await runFold({ llm: llm('we fished\n<remember>\nAlex likes trout\n</remember>'), summary: '', msgs, model: 'm' })).toMatchObject({ summary: 'we fished', facts: ['Alex likes trout'] });
  });

  it('retries a rejected model once on the fallback, without extras', async () => {
    const l = llm(new Error('model not allowed'));
    const seen: string[] = [];
    const r = await runFold({ llm: l, summary: '', msgs, model: 'big', extra: { thinking: {} }, fallbackModel: () => 'small', isRejection: (m) => m.includes('not allowed'), onFallback: (m) => seen.push(m) });
    expect(r.status).toBe('ok');
    expect(l.calls.map((c) => c.model)).toEqual(['big', 'small']);
    expect(l.calls[1].anthropicExtra).toBeUndefined();
    expect(seen).toEqual(['model not allowed']);
    await expect(runFold({ llm: llm(new Error('500')), summary: '', msgs, model: 'big', fallbackModel: () => 'small', isRejection: () => false })).rejects.toThrow('500');
  });
});

// 261123 (review): play rows never move the watermark, so a player who only
// plays used to carry every session in every turn. Reads cap them, and the
// play trigger folds them with no chat at all.
describe('session rows are bounded', () => {
  const plays = (n: number, t0 = T0 + 10_000_000) =>
    Array.from({ length: n }, (_, i) => ({ ...play(`p${i}`, { recap: `session ${i} recap` }), ts: t0 + i * 60_000 }) as ChatMessage);
  const sessions = (h: ChatMessage[]) => h.filter((m) => m.event?.kind === 'play');

  it('chat context and the launch handoff show only the newest MAX_SESSION_ROWS', () => {
    const raw = [...rows(20), ...plays(60)];
    const ctx = chatContextFrom(raw, empty);
    expect(sessions(ctx.history).map((m) => m.id)).toEqual(['p56', 'p57', 'p58', 'p59'].slice(-MAX_SESSION_ROWS));
    expect(ctx.history.filter((m) => m.role !== 'system')).toHaveLength(20);
    const launch = launchContinuityFrom(raw, empty)!;
    expect(launch.recent.filter((r) => r.role === 'session')).toHaveLength(MAX_SESSION_ROWS);
    expect(launch.recent.at(-1)!.text).toContain('session 59 recap');
    expect(launch.recent.filter((r) => r.role !== 'session')).toHaveLength(20);
  });

  it('30 sessions and no chat: a read does not grow with more sessions', () => {
    const read = (n: number) => chatContextFrom([...rows(4), ...plays(n)], empty).history;
    expect(sessions(read(30))).toHaveLength(MAX_SESSION_ROWS);
    // Same digit count in the newest ids and recaps, so the same bytes.
    expect(JSON.stringify(read(60)).length).toBe(JSON.stringify(read(30)).length);
  });

  it('the play trigger folds all but the newest sessions with no chat, without moving the watermark', () => {
    expect(selectFold([...rows(10), ...plays(PLAY_FOLD_TRIGGER - 1)], empty)).toBeNull();
    const raw = [...rows(10), ...plays(PLAY_FOLD_TRIGGER)];
    const sel = selectFold(raw, empty)!;
    expect(sel.counted).toBe(0);
    expect(sel.msgs.map((m) => m.role)).toEqual(Array(PLAY_FOLD_TRIGGER - MAX_SESSION_ROWS).fill('session'));
    const next = bridgeAfterFold(sel, 'S');
    expect(next).toEqual({ summary: 'S', summarizedCount: 0, playFoldedTs: raw[10 + PLAY_FOLD_TRIGGER - MAX_SESSION_ROWS - 1].ts });
    // Folded once: the next selection is not due, and reads drop the folded rows.
    expect(selectFold(raw, next)).toBeNull();
    expect(sessions(chatContextFrom(raw, next).history)).toHaveLength(MAX_SESSION_ROWS);
    // Four more sessions make it due again, and only the new open rows are taken.
    const more = [...raw, ...plays(MAX_SESSION_ROWS, T0 + 99_000_000)];
    const again = selectFold(more, next)!;
    expect(again.msgs).toHaveLength(MAX_SESSION_ROWS);
    expect(again.msgs[0].text).toContain(`session ${PLAY_FOLD_TRIGGER - MAX_SESSION_ROWS} recap`);
  });

  it('one fold takes at most FOLD_MAX_PLAY_ROWS, and its chat rows stop before the first one it leaves', () => {
    // 200 chat rows with a session after every 4th: 37 sessions inside the 150-row batch range.
    const raw: ChatMessage[] = [];
    let t = T0;
    for (let i = 0; i < 200; i++) {
      raw.push({ ...rows(1, i)[0], ts: (t += 1000) });
      if (i % 4 === 3) raw.push({ ...play(`s${i}`), ts: (t += 1000) } as ChatMessage);
    }
    const sel = selectFold(raw, empty)!;
    const taken = sel.msgs.filter((m) => m.role === 'session');
    expect(taken).toHaveLength(FOLD_MAX_PLAY_ROWS);
    // The 13th session sits after chat row 52 (4 * 13): the batch ends there.
    expect(sel.counted).toBe(4 * (FOLD_MAX_PLAY_ROWS + 1));
    const next = bridgeAfterFold(sel, 'S');
    // Nothing is passed by the watermark unfolded: the next fold starts at that session.
    const ctx = chatContextFrom(raw, next);
    expect(sessions(ctx.history)[0].ts).toBeGreaterThan(next.playFoldedTs!);
    const second = selectFold(raw, next)!;
    expect(second.msgs[0].role).toBe('session');
  });

  it('the bridge keeps the newest playFoldedTs across a chat-only fold', () => {
    const before = { summary: 's', summarizedCount: 10, playFoldedTs: 5 };
    expect(bridgeAfterFold({ bridge: before, counted: 50 }, 'n')).toEqual({ summary: 'n', summarizedCount: 60, playFoldedTs: 5 });
    expect(bridgeAfterFold({ bridge: empty, counted: 50 }, 'n')).toEqual({ summary: 'n', summarizedCount: 50 });
  });
});
