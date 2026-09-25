/**
 * The rolling-summary fold across an account switch (260926).
 *
 *   1. While the switch is ending the old account's sessions
 *      (isAccountTeardownActive), foldIfDue does nothing: authState has
 *      already applied the NEW session, so a summarizer call there would bill
 *      the incoming account. The fold is deferred, not lost: the watermark
 *      stays, and the next fold in that account folds the same rows.
 *   2. A fold whose summarizer is still running when the scope moves is
 *      dropped rather than written into the next account's bridge (bridge.json
 *      resolves against the active scope, and bundled defaults share ids).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _setUserDataOverride, setActiveScope, profileRootFor } from '../paths';

const { createSpy } = vi.hoisted(() => ({
  createSpy: vi.fn(async () => ({ content: [{ type: 'text', text: 'ROLLED SUMMARY' }] })),
}));
vi.mock('./sdk', () => ({
  buildChatSdk: vi.fn(async () => ({ client: { messages: { create: createSpy } }, model: 'test-model' })),
}));

import * as chatStore from './chatStore';
import { foldIfDue } from './continuity';
import { withAccountTeardown, _resetScopeBarrierForTests } from '../profile/scopeBarrier';

const CHAR = 'bbf5b66f-2f0f-4918-a953-a2cf66d5a586';
const UUID_A = 'a1111111-1111-4111-8111-111111111111';
const UUID_B = 'b2222222-2222-4222-8222-222222222222';
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'sei-fold-switch-'));
  _setUserDataOverride(dir);
  _resetScopeBarrierForTests();
  setActiveScope(UUID_A);
  createSpy.mockClear();
});
afterEach(async () => {
  setActiveScope('local');
  _setUserDataOverride(null);
  await rm(dir, { recursive: true, force: true });
});

async function seed(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await chatStore.appendMessage(CHAR, {
      id: `m${i}`,
      role: i % 2 === 0 ? 'user' : 'companion',
      text: `msg ${i}`,
      ts: 1000 + i,
    });
  }
}

async function bridgeIn(scope: string): Promise<{ summary: string; summarizedCount: number } | null> {
  try {
    return JSON.parse(await readFile(path.join(profileRootFor(scope), 'memory', CHAR, 'bridge.json'), 'utf8'));
  } catch {
    return null;
  }
}

describe('fold across an account switch (260926)', () => {
  it('is deferred during the account teardown and runs on the next fold', async () => {
    await seed(100); // window(50) + batch(50): a fold is due
    await withAccountTeardown(async () => {
      await foldIfDue(CHAR);
    });
    expect(createSpy).not.toHaveBeenCalled();
    expect(await bridgeIn(UUID_A)).toBeNull();

    // Deferred, not dropped: the same rows fold later in this account.
    await foldIfDue(CHAR);
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(await bridgeIn(UUID_A)).toMatchObject({ summary: 'ROLLED SUMMARY', summarizedCount: 50 });
  });

  it('a fold still summarizing when the scope moves writes nowhere', async () => {
    await seed(100);
    createSpy.mockImplementationOnce(async () => {
      // The account switch lands while the summarizer is out.
      setActiveScope(UUID_B);
      return { content: [{ type: 'text', text: 'A SUMMARY' }] };
    });
    await foldIfDue(CHAR);
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(await bridgeIn(UUID_B)).toBeNull();
    expect(await bridgeIn(UUID_A)).toBeNull();

    // Back in A, the batch is still there to fold.
    setActiveScope(UUID_A);
    await foldIfDue(CHAR);
    expect(await bridgeIn(UUID_A)).toMatchObject({ summary: 'ROLLED SUMMARY', summarizedCount: 50 });
  });
});
