/**
 * chat:clear vs the background summary fold (260705).
 *
 * Pins the two halves of the clear-race fix in continuity.ts:
 *   - Clear-epoch guard: foldIntoSummary spends up to 20s in the summarizer; a
 *     chat:clear landing in that gap deletes bridge.json, and an unguarded
 *     writeBridge afterwards would RESURRECT a summary of the wiped
 *     conversation (with a watermark above the now-empty transcript).
 *   - Stale-watermark degrade: a bridge whose summarizedCount outran the live
 *     transcript is treated as RESET (no summary, watermark 0) — a shrunken
 *     transcript must degrade to "no summary", never "no history" (the old
 *     min() clamp yielded ZERO history → every send 400s until the fresh
 *     conversation outgrew the stale count).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _setUserDataOverride } from '../paths';

// Mock the LLM so the summary fold is deterministic and call-countable.
const { createSpy } = vi.hoisted(() => ({
  createSpy: vi.fn(async () => ({ content: [{ type: 'text', text: 'ROLLED SUMMARY' }] })),
}));
vi.mock('./sdk', () => ({
  buildChatSdk: vi.fn(async () => ({ client: { messages: { create: createSpy } }, model: 'test-model' })),
}));

import * as chatStore from './chatStore';
import { readChatContext, readSummary, clearContinuity, foldIfDue } from './continuity';

const CHAR = '66666666-6666-4666-8666-666666666666';
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'sei-chat-clear-'));
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

describe('chat:clear racing an in-flight fold (260705)', () => {
  it('a clear during the fold LLM call does not resurrect the deleted bridge', async () => {
    await seed(100); // window(50) + batch(50) → a fold is due
    // Block the summarizer on a deferred so the clear can land mid-fold.
    let release!: (v: { content: Array<{ type: string; text: string }> }) => void;
    createSpy.mockImplementationOnce(
      () => new Promise((resolve) => { release = resolve; }),
    );
    const fold = foldIfDue(CHAR);
    await vi.waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));

    // The player hits "Clear chat" (chat:clear = chatStore.clear + clearContinuity).
    await Promise.all([chatStore.clear(CHAR), clearContinuity(CHAR)]);
    release({ content: [{ type: 'text', text: 'ROLLED SUMMARY' }] });
    await fold;

    // The epoch guard dropped the write: no ghost bridge.json.
    expect(await readSummary(CHAR)).toBe('');

    // A fresh conversation reads full history, not a stale-watermark blackout.
    await seed(3);
    const ctx = await readChatContext(CHAR);
    expect(ctx.summary).toBe('');
    expect(ctx.history.map((m) => m.text)).toEqual(['msg 0', 'msg 1', 'msg 2']);
  });

  it('a bridge watermark above the transcript degrades to no-summary, never no-history', async () => {
    await seed(100);
    await foldIfDue(CHAR); // real fold → bridge.json { summary, summarizedCount: 50 }
    expect(await readSummary(CHAR)).toBe('ROLLED SUMMARY');
    createSpy.mockClear();

    // Wipe ONLY the transcript (not clearContinuity) — the bridge is now stale.
    await chatStore.clear(CHAR);
    await seed(3);

    const ctx = await readChatContext(CHAR);
    expect(ctx.summary).toBe('');
    expect(ctx.history.map((m) => m.text)).toEqual(['msg 0', 'msg 1', 'msg 2']);
    expect(createSpy).not.toHaveBeenCalled(); // reads stay pure
  });
});
