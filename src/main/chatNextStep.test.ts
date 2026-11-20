/**
 * 261107: the text-chat "next time" check (chatNextStep.ts). The check itself
 * (gates, prompt, save, events) is playerEndNextStep's and tested there; this
 * pins how a chat end routes, which rows are its lines, and that the end
 * never waits on the model.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../shared/ipc';
import type { PlayerEndInput, PlayerEndOutcome } from './playerEndNextStep';
import {
  CHAT_MIN_PLAYER_MESSAGES,
  chatCheckInput,
  chatDigestFromRows,
  chatEndRoute,
  chatSessionNextStep,
  type ChatNextStepDeps,
} from './chatNextStep';

const T0 = Date.parse('2026-11-07T10:00:00.000Z');
const MIN = 60_000;

function row(over: Partial<ChatMessage>): ChatMessage {
  return { id: Math.random().toString(36), role: 'user', text: 'hi', ts: T0, ...over } as ChatMessage;
}

const session = (over: Partial<{ startedAt: number; lastAt: number; messages: number }> = {}) => ({
  characterId: 'char-1',
  startedAt: T0,
  lastAt: T0 + 10 * MIN,
  messages: 6,
  ...over,
});

function deps(over: Partial<ChatNextStepDeps> = {}) {
  const started: PlayerEndInput[] = [];
  const persisted: unknown[] = [];
  const d: ChatNextStepDeps = {
    recentRows: async () => [row({ text: 'next time lets finish the iron armour', ts: T0 + MIN })],
    start: async (input) => {
      started.push(input);
      return 'saved';
    },
    persist: (r) => {
      persisted.push(r);
      return true;
    },
    ...over,
  };
  return { d, started, persisted };
}

describe('chatEndRoute', () => {
  it('idle checks now, quit defers, a switch is not covered, a short chat is trivial', () => {
    expect(chatEndRoute({ reason: 'idle', messages: CHAT_MIN_PLAYER_MESSAGES })).toBe('check');
    expect(chatEndRoute({ reason: 'quit', messages: 10 })).toBe('persist');
    expect(chatEndRoute({ reason: 'account_switch', messages: 10 })).toBe('not_covered');
    expect(chatEndRoute({ reason: 'idle', messages: CHAT_MIN_PLAYER_MESSAGES - 1 })).toBe('trivial');
    expect(chatEndRoute({ reason: 'quit', messages: 1 })).toBe('trivial');
  });
});

describe('chat lines', () => {
  it('typed player and companion rows inside the window, last 16', () => {
    const rows = [
      row({ text: 'old', ts: T0 - 10 * MIN }),
      row({ text: 'a', ts: T0 }),
      row({ role: 'companion', text: 'b', ts: T0 + MIN }),
      row({ voice: true, text: 'spoken', ts: T0 + 2 * MIN }),
      row({ role: 'system', text: 'You and Sui played Chess.', ts: T0 + 3 * MIN }),
      row({ text: 'c', ts: T0 + 4 * MIN }),
    ];
    expect(chatDigestFromRows(rows, T0)).toEqual({
      lines: [
        { who: 'player', text: 'a' },
        { who: 'you', text: 'b' },
        { who: 'player', text: 'c' },
      ],
      playerLines: 2,
    });
    const many = Array.from({ length: 30 }, (_, i) => row({ text: `m${i}`, ts: T0 + i }));
    expect(chatDigestFromRows(many, T0).lines).toHaveLength(16);
  });

  it('the check input carries the chat gates and includes the reply after the last message', () => {
    const rows = [row({ text: 'x', ts: T0 }), row({ role: 'companion', text: 'reply', ts: T0 + 10 * MIN + 4_000 })];
    const input = chatCheckInput({ ...session(), rows });
    expect(input).toMatchObject({
      characterId: 'char-1',
      surface: 'chat',
      activity: 'a text chat',
      durationMs: 10 * MIN,
      playerLines: 6,
      minPlayerLines: CHAT_MIN_PLAYER_MESSAGES,
      skipOnFreeCloud: true,
    });
    expect(input.lines.map((l) => l.text)).toEqual(['x', 'reply']);
    expect(input.source).toBeUndefined();
    expect(input.game).toBeUndefined();
  });
});

describe('chatSessionNextStep', () => {
  it('an idle end starts the check and does not wait for it', async () => {
    let finish: (o: PlayerEndOutcome) => void = () => {};
    const start = vi.fn(
      (_input: PlayerEndInput) =>
        new Promise<PlayerEndOutcome>((resolve) => {
          finish = resolve;
        }),
    );
    const capture = vi.fn();
    const { d } = deps({ start });
    await chatSessionNextStep(session(), 'idle', capture, d);
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(start.mock.calls[0][0]).toMatchObject({ surface: 'chat', playerLines: 6 });
    expect(capture).not.toHaveBeenCalled();
    finish('saved');
  });

  it('a quit keeps the window for the next launch and reports deferred', async () => {
    const capture = vi.fn();
    const { d, started, persisted } = deps();
    await chatSessionNextStep(session(), 'quit', capture, d);
    expect(persisted).toEqual([{ characterId: 'char-1', surface: 'chat', durationMs: 10 * MIN, endedAt: T0 + 10 * MIN }]);
    expect(started).toEqual([]);
    expect(capture).toHaveBeenCalledWith('next_step_checked', expect.objectContaining({ surface: 'chat', outcome: 'deferred', end_reason: 'quit' }));
  });

  it('a quit too short to keep reports trivial', async () => {
    const capture = vi.fn();
    const { d } = deps({ persist: () => false });
    await chatSessionNextStep(session({ lastAt: T0 + MIN }), 'quit', capture, d);
    expect(capture).toHaveBeenCalledWith('next_step_checked', expect.objectContaining({ outcome: 'trivial', reached_model: false }));
  });

  it('a short chat and an account switch run nothing and say why', async () => {
    const capture = vi.fn();
    const { d, started, persisted } = deps();
    await chatSessionNextStep(session({ messages: 2 }), 'idle', capture, d);
    await chatSessionNextStep(session(), 'account_switch', capture, d);
    expect(started).toEqual([]);
    expect(persisted).toEqual([]);
    expect(capture.mock.calls.map((c) => [c[1].outcome, c[1].end_reason])).toEqual([
      ['trivial', 'idle'],
      ['not_covered', 'account_switch'],
    ]);
  });

  it('never throws, whatever the deps do', async () => {
    const capture = vi.fn(() => {
      throw new Error('analytics down');
    });
    const { d } = deps({
      recentRows: async () => {
        throw new Error('no transcript');
      },
      start: async () => {
        throw new Error('boom');
      },
      persist: () => {
        throw new Error('disk');
      },
    });
    await expect(chatSessionNextStep(session(), 'idle', capture, d)).resolves.toBeUndefined();
    await expect(chatSessionNextStep(session(), 'quit', capture, d)).resolves.toBeUndefined();
    await expect(chatSessionNextStep(session({ messages: 1 }), 'idle', capture, d)).resolves.toBeUndefined();
  });
});
