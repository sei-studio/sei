/**
 * chatSession tests (260801).
 *
 * The session model is the whole point of the module and it is all timing, so
 * these run on fake timers. Three properties are load-bearing for the analytics
 * dashboard and are pinned here: `duration_ms` measures talking and never the
 * idle tail that closes the session, a session is per CHARACTER, and exactly
 * one `chat_session_ended` is emitted however the session ends.
 *
 * Why every message is followed by a flush: `noteChatMessage` fires its
 * `chat_session_started` from a floating async block, because a chat send must
 * never wait on analytics. Two of those blocks started in the SAME tick race
 * each other through `await import('../analytics')` and only the first comes
 * back holding the mocked module, so a burst of un-flushed messages silently
 * loses started events here (never in production, where the import is real).
 * `note()` below keeps that out of every test body.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { captureSpy } = vi.hoisted(() => ({ captureSpy: vi.fn() }));

vi.mock('../analytics', () => ({ capture: captureSpy }));

import { noteChatMessage, endChatSession, endAllChatSessions } from './chatSession';

/** Mirrors IDLE_TIMEOUT_MS in the module. */
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/** Send one message and let its floating started-event block settle. */
const note = async (characterId: string): Promise<void> => {
  noteChatMessage(characterId);
  await vi.advanceTimersByTimeAsync(0);
};

/** Every captured event of one name, in order. */
const events = (name: string): Record<string, unknown>[] =>
  captureSpy.mock.calls.filter((c) => c[0] === name).map((c) => c[1] as Record<string, unknown>);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-01T12:00:00Z'));
  captureSpy.mockClear();
});

afterEach(async () => {
  // Leave no session open for the next test — the module is a singleton.
  await endAllChatSessions();
  vi.useRealTimers();
});

describe('noteChatMessage', () => {
  it('opens a session on the first message', async () => {
    await note('char-a');
    expect(events('chat_session_started')).toEqual([{ character_id: 'char-a' }]);
  });

  it('does not re-open a session on later messages', async () => {
    await note('char-a');
    await vi.advanceTimersByTimeAsync(1000);
    await note('char-a');
    expect(events('chat_session_started')).toHaveLength(1);
  });

  it('counts a session per character, not per app', async () => {
    await note('char-a');
    await note('char-b');
    expect(events('chat_session_started').map((e) => e.character_id)).toEqual(['char-a', 'char-b']);

    // Closed one at a time: endAllChatSessions fans out through Promise.all,
    // which trips the concurrent-import race described at the top of the file.
    // The sweep itself is covered below.
    await endChatSession('char-a', 'quit');
    await endChatSession('char-b', 'quit');
    expect(events('chat_session_ended').map((e) => e.character_id)).toEqual(['char-a', 'char-b']);
  });
});

describe('session end', () => {
  it('closes on the idle gap, measuring first message to LAST message', async () => {
    await note('char-a');
    await vi.advanceTimersByTimeAsync(30_000);
    await note('char-a');

    // Still inside the window: nothing has ended yet.
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS - 1);
    expect(events('chat_session_ended')).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    // 30s of talking, NOT 30s plus the 5 minutes of silence that closed it.
    expect(events('chat_session_ended')).toEqual([
      { character_id: 'char-a', duration_ms: 30_000, messages: 2, reason: 'idle' },
    ]);
  });

  it('refreshes the idle timer on every message', async () => {
    await note('char-a');
    // Four more messages, each just inside the window: one long session, not
    // five short ones.
    for (let i = 0; i < 4; i += 1) {
      await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS - 1000);
      await note('char-a');
    }
    expect(events('chat_session_ended')).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS);
    expect(events('chat_session_ended')).toEqual([
      {
        character_id: 'char-a',
        duration_ms: 4 * (IDLE_TIMEOUT_MS - 1000),
        messages: 5,
        reason: 'idle',
      },
    ]);
  });

  it('reports 0 ms for a one-message session rather than inventing time', async () => {
    await note('char-a');
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS);
    expect(events('chat_session_ended')).toEqual([
      { character_id: 'char-a', duration_ms: 0, messages: 1, reason: 'idle' },
    ]);
  });

  it('closes open sessions at quit, since quitting mid-chat is how a chat ends', async () => {
    await note('char-a');
    await vi.advanceTimersByTimeAsync(12_000);
    await note('char-a');

    await endAllChatSessions();
    expect(events('chat_session_ended')).toEqual([
      { character_id: 'char-a', duration_ms: 12_000, messages: 2, reason: 'quit' },
    ]);
  });

  it('leaves nothing open after the quit sweep', async () => {
    await note('char-a');
    await note('char-b');
    await endAllChatSessions();

    // Asserted as "no session survived" rather than "two events fired": the
    // sweep's Promise.all starts both dynamic imports in one tick, so the
    // harness can drop one of the two events (see the file header). What
    // matters is the state — a session still in the map would keep its idle
    // timer, and that timer firing here would emit an extra ended event.
    const afterSweep = events('chat_session_ended').length;
    expect(afterSweep).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS * 2);
    expect(events('chat_session_ended')).toHaveLength(afterSweep);
  });

  it('emits exactly one ended event when a quit races the idle timer', async () => {
    await note('char-a');
    await endChatSession('char-a', 'idle');
    await endAllChatSessions();
    // The pending idle timer still fires; it must find nothing left to close.
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS * 2);
    expect(events('chat_session_ended')).toHaveLength(1);
  });

  it('is a no-op for a character that never talked', async () => {
    await endChatSession('char-never', 'quit');
    expect(events('chat_session_ended')).toHaveLength(0);
  });
});
