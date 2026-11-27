/**
 * runWithAttempts (261127): the retry policy of a board-game character turn.
 * A turn is retried a few times, then stops in a clear failed state; there is
 * never a made-up move. The services' own tests cover the runner end to end.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../characterStore', () => ({ getCharacter: vi.fn() }));
vi.mock('../configStore', () => ({ loadConfig: vi.fn(async () => ({})) }));

import {
  runWithAttempts,
  attemptBudgetMs,
  alreadyMovedResult,
  BoardTurnTimeout,
  MOVE_ATTEMPTS,
  RETRY_BACKOFF_MS,
  buildGameThread,
  unansweredNote,
  chatReplyRule,
  LONGER_HELP_REPLIES,
  type BoardTurnResult,
} from './boardTurn';
import type { ChatMessage } from '../../shared/ipc';

const noMove = (over: Partial<BoardTurnResult> = {}): BoardTurnResult => ({
  moved: false,
  spoken: [],
  hops: 1,
  illegal: 0,
  noToolHops: 1,
  lastRejection: null,
  ...over,
});

function harness(attempt: (i: number, note: string | null) => Promise<BoardTurnResult>, live = () => true) {
  const sleeps: number[] = [];
  const notes: Array<string | null> = [];
  return {
    sleeps,
    notes,
    run: () =>
      runWithAttempts({
        attempt: (i, note) => {
          notes.push(note);
          return attempt(i, note);
        },
        isLive: live,
        onUsageLimit: async () => null,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      }),
  };
}

describe('runWithAttempts', () => {
  it('a move on the second attempt is a move, with the reason folded into that attempt', async () => {
    const h = harness(async (i) => (i === 0 ? noMove() : alreadyMovedResult()));
    const out = await h.run();
    expect(out).toMatchObject({ kind: 'moved', attempts: 2 });
    expect(h.notes[0]).toBeNull();
    expect(h.notes[1]).toMatch(/did not make a move/);
    expect(h.sleeps).toEqual([]); // no backoff after a model answer, only after errors
  });

  it('illegal moves on every attempt fail as illegal_move and count each rejection', async () => {
    const h = harness(async () => noMove({ illegal: 1, lastRejection: 'Column 4 is full.' }));
    const out = await h.run();
    expect(out).toEqual({
      kind: 'failed',
      failure: { reason: 'illegal_move', attempts: MOVE_ATTEMPTS },
      errorClass: null,
      illegal: MOVE_ATTEMPTS,
    });
    expect(h.notes[1]).toContain('Column 4 is full.');
  });

  it('timeouts back off and end as timeout', async () => {
    const h = harness(async () => {
      throw new BoardTurnTimeout(90_000);
    });
    const out = await h.run();
    expect(out).toMatchObject({ kind: 'failed', failure: { reason: 'timeout', attempts: MOVE_ATTEMPTS } });
    expect(h.sleeps).toEqual([...RETRY_BACKOFF_MS]);
  });

  it('a config class error stops at once', async () => {
    const h = harness(async () => {
      throw new Error('ollama_model_missing: qwen3');
    });
    const out = await h.run();
    expect(out).toMatchObject({ kind: 'failed', failure: { reason: 'provider_error', attempts: 1 }, errorClass: 'model_not_found' });
  });

  it('a usage limit stops with the wall the popup reported', async () => {
    const out = await runWithAttempts({
      attempt: async () => {
        throw Object.assign(new Error('429 rate limited'), { status: 429 });
      },
      isLive: () => true,
      onUsageLimit: async () => 'rate_limited',
      sleep: async () => {},
    });
    expect(out).toMatchObject({ kind: 'failed', failure: { reason: 'rate_limited', attempts: 1 } });
  });

  it('a turn that stops mattering is aborted, not failed', async () => {
    let live = true;
    const h = harness(async () => {
      live = false;
      throw new Error('500 server error');
    }, () => live);
    expect(await h.run()).toEqual({ kind: 'aborted' });
  });
});

describe('attemptBudgetMs', () => {
  it('is 90s for hosted providers and twice the cold-load floor for Ollama', () => {
    expect(attemptBudgetMs({ kind: 'anthropic' })).toBe(90_000);
    expect(attemptBudgetMs({ kind: 'ollama' })).toBeGreaterThanOrEqual(240_000);
  });
});

describe('replayableContent', () => {
  it('turns an empty reply into a placeholder the API accepts', async () => {
    const { replayableContent } = await import('./boardTurn');
    expect(replayableContent([])).toEqual([{ type: 'text', text: '(no reply)' }]);
    expect(replayableContent([{ type: 'text', text: '  \n ', citations: null } as never])).toEqual([
      { type: 'text', text: '(no reply)' },
    ]);
  });

  it('drops blank text blocks and keeps the rest', async () => {
    const { replayableContent } = await import('./boardTurn');
    const tool = { type: 'tool_use', id: 't1', name: 'drop', input: { column: 3 } };
    expect(replayableContent([{ type: 'text', text: ' ' } as never, tool as never])).toEqual([tool]);
    const said = { type: 'text', text: 'hmm' };
    expect(replayableContent([said as never])).toEqual([said]);
  });
});

describe('chat-reply thread and quoting (261128 eval: chat sent during her move read as answered)', () => {
  const player: ChatMessage = { id: 'p1', role: 'user', text: 'can you teach me?', ts: 100 };
  const said: ChatMessage = { id: 'c1', role: 'companion', text: 'center or nothing', ts: 300 };
  const log = [{ ts: 200, text: '(game) Move 1: you dropped a red piece in column 4.' }];

  it('keeps time order without unanswered ids', () => {
    expect(buildGameThread([player, said], log).map((m) => m.text)).toEqual([
      'can you teach me?',
      log[0].text,
      'center or nothing',
    ]);
    expect(buildGameThread([player], []).map((m) => m.id)).toEqual(['p1']);
  });

  it('moves the unanswered player lines after the move log and her own move line', () => {
    const later: ChatMessage = { id: 'p2', role: 'user', text: 'hello?', ts: 150 };
    const thread = buildGameThread([player, later, said], log, ['p1', 'p2']);
    expect(thread.map((m) => m.id)).toEqual(['game-200-0', 'c1', 'p1', 'p2']);
  });

  it('quotes the unanswered line(s) and asks to talk to them, not about them', () => {
    const one = unansweredNote(['  can you   teach me?  ']);
    expect(one).toMatch(/^They just said to you: "can you teach me\?"\. You have not answered this yet\./);
    expect(one).toContain('Talk to them as "you", not about them.');
    const many = unansweredNote(['a', 'b', 'c', 'd']);
    expect(many).toContain('"b", then "c", then "d"');
    expect(many).not.toContain('"a"');
    expect(many).toContain('answered these yet');
    expect(unansweredNote(['x'.repeat(400)])).toContain(`"${'x'.repeat(280)}..."`);
    expect(unansweredNote([])).toBe('They just said something.');
  });

  it('the longer help replies stay off by default; the flip adds one sentence', () => {
    expect(LONGER_HELP_REPLIES).toBe(false);
    expect(chatReplyRule()).toBe(chatReplyRule(false));
    expect(chatReplyRule(false)).toMatch(/One short line, or nothing\.$/);
    expect(chatReplyRule(true)).toMatch(/^When they talk to you.*One short line, or nothing\. When they ask how to play, or ask for help or the rules, you can use two or three short lines to explain\.$/);
  });
});
