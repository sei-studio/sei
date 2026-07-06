/**
 * Chat persistence + cross-surface continuity watermark.
 *
 * Pins the two pieces of novel logic in the chat backend:
 *   - chatStore append/read/clear round-trips inside the per-character memory dir.
 *   - continuity recursive-summary watermark (260702 batch cadence): folds run in
 *     BATCHES of 50 — the unsummarized tail grows to 99 verbatim messages, then a
 *     single fold covers the oldest 50, leaving exactly 50. An unchanged window
 *     costs ZERO LLM calls; a single aged-out message never triggers a fold.
 *     Folding happens ONLY via foldIfDue (fired in the background after chat
 *     replies); readChatContext and buildLaunchContinuity are pure reads, so
 *     a Minecraft summon can never trigger compaction.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _setUserDataOverride, paths } from '../paths';

// Mock the LLM so the summary fold is deterministic and call-countable.
const { createSpy } = vi.hoisted(() => ({
  createSpy: vi.fn(async () => ({ content: [{ type: 'text', text: 'ROLLED SUMMARY' }] })),
}));
vi.mock('./sdk', () => ({
  buildChatSdk: vi.fn(async () => ({ client: { messages: { create: createSpy } }, model: 'test-model' })),
}));

import type { ChatMessage } from '../../shared/ipc';
import * as chatStore from './chatStore';
import { buildLaunchContinuity, readChatContext, readSummary, clearContinuity, foldIfDue } from './continuity';
import { splitReply, toMessages, foldUserNote } from './chatService';
import {
  pushThought,
  drainThoughts,
  peekThoughts,
  clearThoughts,
  renderThoughtNote,
} from './thoughts';

const CHAR = '33333333-3333-4333-8333-333333333333';
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'sei-chat-'));
  _setUserDataOverride(dir);
  createSpy.mockClear();
});
afterEach(async () => {
  _setUserDataOverride(null);
  await rm(dir, { recursive: true, force: true });
});

async function seed(n: number, from = 0): Promise<void> {
  for (let i = from; i < from + n; i++) {
    await chatStore.appendMessage(CHAR, {
      id: `m${i}`,
      role: i % 2 === 0 ? 'user' : 'companion',
      text: `msg ${i}`,
      ts: 1000 + i,
    });
  }
}

describe('chatStore', () => {
  it('appends, reads all, reads recent, and clears', async () => {
    await seed(3);
    expect((await chatStore.readAll(CHAR)).map((m) => m.text)).toEqual(['msg 0', 'msg 1', 'msg 2']);
    expect((await chatStore.readRecent(CHAR, 2)).map((m) => m.text)).toEqual(['msg 1', 'msg 2']);
    await chatStore.clear(CHAR);
    expect(await chatStore.readAll(CHAR)).toEqual([]);
  });

  it('readAll returns [] for a character with no transcript', async () => {
    expect(await chatStore.readAll('44444444-4444-4444-8444-444444444444')).toEqual([]);
  });

  it('readAll drops legacy event-less system rows (pre-260703 join acks) but keeps everything else', async () => {
    const legacyJoin: ChatMessage = { id: 'l1', role: 'system', text: 'Marv joined your world', ts: 1000 };
    const legacyFail: ChatMessage = {
      id: 'l2',
      role: 'system',
      text: "Couldn't join your world — is it still open to LAN?",
      ts: 1500,
    };
    const play: ChatMessage = {
      id: 'p1',
      role: 'system',
      text: 'You and Marv played Minecraft for 5 minutes.',
      ts: 2000,
      event: { kind: 'play', game: 'minecraft', durationMs: 300_000 },
    };
    const user: ChatMessage = { id: 'u1', role: 'user', text: 'hey', ts: 2500 };
    const companion: ChatMessage = { id: 'c1', role: 'companion', text: 'hi', ts: 3000 };

    for (const m of [legacyJoin, legacyFail, play, user, companion]) {
      await chatStore.appendMessage(CHAR, m);
    }

    const all = await chatStore.readAll(CHAR);
    expect(all.map((m) => m.id)).toEqual(['p1', 'u1', 'c1']);
  });

  it('filterLegacySystemRows is a pure helper: drops event-less system rows, keeps the rest', () => {
    const legacy: ChatMessage = { id: 'l1', role: 'system', text: 'Marv joined your world', ts: 1000 };
    const play: ChatMessage = {
      id: 'p1',
      role: 'system',
      text: 'You and Marv played Minecraft for 5 minutes.',
      ts: 2000,
      event: { kind: 'play', game: 'minecraft', durationMs: 300_000 },
    };
    const user: ChatMessage = { id: 'u1', role: 'user', text: 'hey', ts: 2500 };
    const companion: ChatMessage = { id: 'c1', role: 'companion', text: 'hi', ts: 3000 };

    expect(chatStore.filterLegacySystemRows([legacy, play, user, companion]).map((m) => m.id)).toEqual([
      'p1',
      'u1',
      'c1',
    ]);
  });
});

describe('splitReply — blank line → separate messages (task 8)', () => {
  it('splits a reply on a blank line into two messages (casual default drops trailing periods)', () => {
    expect(
      splitReply(
        'oh good. another interface. another way to keep me online when i\'d prefer the absence of it.\n\nwhat do you want.',
      ),
    ).toEqual([
      'oh good. another interface. another way to keep me online when i\'d prefer the absence of it',
      'what do you want',
    ]);
  });

  it('keeps a single-paragraph reply as one message', () => {
    expect(splitReply('just one line here')).toEqual(['just one line here']);
  });

  it('collapses whitespace-only replies to a single placeholder', () => {
    expect(splitReply('   \n\n  ')).toEqual(['…']);
  });

  it('drops empty chunks from runs of blank lines', () => {
    expect(splitReply('a\n\n\n\nb')).toEqual(['a', 'b']);
  });

  // 260705: punctuation register (character.metadata.punctuation).
  it('casual strips ONLY a lone trailing period — keeps ellipsis, ? and !', () => {
    expect(splitReply('hm...')).toEqual(['hm...']);
    expect(splitReply('you nearby?')).toEqual(['you nearby?']);
    expect(splitReply('WATCH THIS!')).toEqual(['WATCH THIS!']);
    expect(splitReply('done.')).toEqual(['done']);
  });

  it('deliberate keeps trailing periods on every bubble', () => {
    expect(splitReply('done. as ordered.\n\nas always.', 'deliberate')).toEqual([
      'done. as ordered.',
      'as always.',
    ]);
  });
});

describe('toMessages — every row flows through the same-role merge (Finding 1)', () => {
  const play = (id: string, ts: number, mins: number): ChatMessage => ({
    id,
    role: 'system',
    text: `You and Marv played Minecraft for ${mins} minutes.`,
    ts,
    event: { kind: 'play', game: 'minecraft', durationMs: mins * 60_000 },
  });
  const user = (id: string, ts: number, text: string): ChatMessage => ({ id, role: 'user', text, ts });
  const companion = (id: string, ts: number, text: string): ChatMessage => ({ id, role: 'companion', text, ts });

  /** Anthropic rejects two adjacent same-role turns with 400 "roles must alternate". */
  function assertAlternates(out: Array<{ role: string }>): void {
    for (let i = 1; i < out.length; i++) expect(out[i].role).not.toBe(out[i - 1].role);
  }

  it('two adjacent play rows merge into one user turn', () => {
    const out = toMessages([play('p1', 1000, 5), play('p2', 2000, 3)]);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('user');
    expect(out[0].content).toContain('5 minutes');
    expect(out[0].content).toContain('3 minutes');
    assertAlternates(out);
  });

  it('a user message followed by a play row merges into one user turn', () => {
    const out = toMessages([user('u1', 1000, 'hey'), play('p1', 2000, 5)]);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('user');
    assertAlternates(out);
  });

  it('a play row between companion and user turns keeps strict alternation', () => {
    const out = toMessages([
      user('u1', 1000, 'lets play'),
      companion('c1', 2000, 'ok'),
      play('p1', 3000, 5),
      user('u2', 4000, 'that was fun'),
    ]);
    // companion, then play+user fold into one user turn → [user, assistant, user].
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    assertAlternates(out);
  });

  it('a call row (260705) surfaces as shared history and keeps alternation', () => {
    const call: ChatMessage = {
      id: 'call1',
      role: 'system',
      text: 'You and Marv called for 4 minutes.',
      ts: 3000,
      event: { kind: 'call', durationMs: 4 * 60_000 },
    };
    const out = toMessages([
      user('u1', 1000, 'hey'),
      companion('c1', 2000, 'hey!'),
      call,
      user('u2', 4000, 'good call'),
    ]);
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(out[2].content).toContain('called for 4 minutes');
    expect(out[2].content).toContain('voice call');
    assertAlternates(out);
  });
});

describe('thoughts queue — push/drain semantics', () => {
  const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  afterEach(() => {
    clearThoughts(A);
    clearThoughts(B);
  });

  it('drain returns queued thoughts in order and clears them', () => {
    pushThought(A, 'first');
    pushThought(A, 'second');
    expect(drainThoughts(A)).toEqual(['first', 'second']);
    // Draining clears — a second drain sees nothing.
    expect(drainThoughts(A)).toEqual([]);
  });

  it('drain returns [] for a character with no thoughts', () => {
    expect(drainThoughts('cccccccc-cccc-4ccc-8ccc-cccccccccccc')).toEqual([]);
  });

  it('queues are isolated per character', () => {
    pushThought(A, 'for-a');
    pushThought(B, 'for-b');
    expect(drainThoughts(A)).toEqual(['for-a']);
    // B is untouched by A's drain.
    expect(drainThoughts(B)).toEqual(['for-b']);
  });

  it('peek reads without clearing; clear drops without returning', () => {
    pushThought(A, 'keep me');
    expect(peekThoughts(A)).toEqual(['keep me']);
    // Still there after peek.
    expect(drainThoughts(A)).toEqual(['keep me']);
    pushThought(A, 'drop me');
    clearThoughts(A);
    expect(drainThoughts(A)).toEqual([]);
  });

  it('renderThoughtNote wraps text in the bracketed model-facing note, or "" when empty', () => {
    expect(renderThoughtNote([])).toBe('');
    expect(renderThoughtNote(['   '])).toBe('');
    const note = renderThoughtNote(['say hi']);
    expect(note.startsWith('[A thought crosses your mind')).toBe(true);
    expect(note).toContain('say hi');
    expect(note.endsWith(']')).toBe(true);
    // Multiple thoughts join into one note.
    expect(renderThoughtNote(['one', 'two'])).toContain('one two');
  });
});

describe('foldUserNote — alternation-safe note fold (three call sites)', () => {
  type Msg = { role: 'user' | 'assistant'; content: unknown };

  it('folds into a trailing user turn (string content)', () => {
    const messages: Msg[] = [{ role: 'user', content: 'hey' }];
    foldUserNote(messages, '[note]');
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('hey\n[note]');
  });

  it('appends a new user message when the last turn is assistant', () => {
    const messages: Msg[] = [
      { role: 'user', content: 'hey' },
      { role: 'assistant', content: 'hi' },
    ];
    foldUserNote(messages, '[note]');
    expect(messages).toHaveLength(3);
    expect(messages[2]).toEqual({ role: 'user', content: '[note]' });
  });

  it('creates the first message when the array is empty', () => {
    const messages: Msg[] = [];
    foldUserNote(messages, '[note]');
    expect(messages).toEqual([{ role: 'user', content: '[note]' }]);
  });

  it('does not append a new turn when the trailing user content is non-string (tool_result blocks)', () => {
    const messages: Msg[] = [{ role: 'user', content: [{ type: 'tool_result' }] }];
    foldUserNote(messages, '[note]');
    // Non-string trailing user content cannot be string-concatenated, so a fresh
    // user message is pushed (still alternation-safe — the model reads both).
    expect(messages).toHaveLength(2);
    expect(messages[1]).toEqual({ role: 'user', content: '[note]' });
  });

  it('is a no-op for a blank note', () => {
    const messages: Msg[] = [{ role: 'user', content: 'hey' }];
    foldUserNote(messages, '');
    expect(messages).toEqual([{ role: 'user', content: 'hey' }]);
  });
});

/** The nth fold call's request body, as the summarizer saw it. */
function foldCall(n: number): { system: string; model: string; prompt: string } {
  const req = (createSpy.mock.calls as unknown as Array<unknown[]>)[n][0] as {
    system: string;
    model: string;
    messages: Array<{ content: string }>;
  };
  return { system: req.system, model: req.model, prompt: req.messages[0].content };
}

describe('continuity watermark (batch cadence, background folds)', () => {
  it('does not summarize when the conversation fits in the window', async () => {
    await seed(10);
    await foldIfDue(CHAR);
    const cont = await buildLaunchContinuity(CHAR);
    expect(cont).not.toBeNull();
    expect(cont!.summary).toBe('');
    expect(cont!.recent).toHaveLength(10);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('returns null when there is no conversation', async () => {
    expect(await buildLaunchContinuity(CHAR)).toBeNull();
  });

  it('clearContinuity wipes the rolling summary so a cleared chat cannot re-seed it', async () => {
    await seed(100); // window(50) + batch(50) → a fold is due
    await foldIfDue(CHAR);
    expect(await readSummary(CHAR)).toBe('ROLLED SUMMARY');
    await clearContinuity(CHAR);
    expect(await readSummary(CHAR)).toBe('');
  });

  it('reads are pure — buildLaunchContinuity and readChatContext never call the LLM', async () => {
    await seed(150); // way past the fold trigger
    const launch = await buildLaunchContinuity(CHAR);
    const chat = await readChatContext(CHAR);
    expect(createSpy).not.toHaveBeenCalled(); // summoning can never compact
    // Backlog is served verbatim until a background fold drains it.
    expect(launch!.recent).toHaveLength(150);
    expect(chat.history).toHaveLength(150);
    expect(launch!.summary).toBe('');
  });

  it('folds in batches of 50 — the verbatim window grows to 99, then resets to 50', async () => {
    // 99 unsummarized → below the window+batch trigger: NO fold, all verbatim.
    await seed(99);
    await foldIfDue(CHAR);
    const first = await buildLaunchContinuity(CHAR);
    expect(first!.recent).toHaveLength(99);
    expect(first!.summary).toBe('');
    expect(createSpy).not.toHaveBeenCalled();

    // 100th message → fold the oldest 50 (msg 0..49), leaving exactly 50 verbatim.
    await seed(1, 99);
    await foldIfDue(CHAR);
    const second = await buildLaunchContinuity(CHAR);
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(second!.recent).toHaveLength(50);
    expect(second!.summary).toBe('ROLLED SUMMARY');
    const fold1 = foldCall(0);
    expect(fold1.prompt).toContain('msg 0');
    expect(fold1.prompt).toContain('msg 49');
    expect(fold1.prompt).not.toContain('msg 50');

    // 49 more (99 unsummarized again) → still no new fold; window grows.
    await seed(49, 100);
    await foldIfDue(CHAR);
    const third = await buildLaunchContinuity(CHAR);
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(third!.recent).toHaveLength(99);

    // One more → second batch folds exactly msg 50..99, nothing re-folded.
    await seed(1, 149);
    await foldIfDue(CHAR);
    expect(createSpy).toHaveBeenCalledTimes(2);
    const fold2 = foldCall(1);
    expect(fold2.prompt).toContain('msg 50');
    expect(fold2.prompt).toContain('msg 99');
    expect(fold2.prompt).not.toContain('msg 49');
    expect(fold2.prompt).not.toContain('msg 100');
  });

  it('folds with the latest Sonnet and carries the persona into the fold prompt', async () => {
    await seed(100);
    await foldIfDue(CHAR, 'MONOTONE ROBOT PERSONA');
    expect(createSpy).toHaveBeenCalledTimes(1);
    const fold = foldCall(0);
    expect(fold.model).toBe('claude-sonnet-5');
    expect(fold.system).toContain('MONOTONE ROBOT PERSONA');
    // Guard against baking in unverified world state ("we're playing now").
    expect(fold.system).toContain('never assert current world/game state');
  });

  it('readChatContext returns summary + the unsummarized tail after a fold', async () => {
    await seed(100);
    await foldIfDue(CHAR);
    const ctx = await readChatContext(CHAR);
    expect(ctx.summary).toBe('ROLLED SUMMARY');
    expect(ctx.history).toHaveLength(50);
    expect(ctx.history[0].text).toBe('msg 50');

    // System rows in the live era ride along verbatim (play events feed toMessages).
    await chatStore.appendMessage(CHAR, {
      id: 'sys1',
      role: 'system',
      text: 'You and Marv played Minecraft for 5 minutes.',
      ts: 5000,
      event: { kind: 'play', game: 'minecraft', durationMs: 300_000 },
    });
    const ctx2 = await readChatContext(CHAR);
    expect(ctx2.history).toHaveLength(51);
    expect(ctx2.history[50].role).toBe('system');
  });

  it('single-flights concurrent fold triggers (typing bursts fold once)', async () => {
    await seed(100);
    await Promise.all([foldIfDue(CHAR), foldIfDue(CHAR), foldIfDue(CHAR)]);
    expect(createSpy).toHaveBeenCalledTimes(1);
  });
});
