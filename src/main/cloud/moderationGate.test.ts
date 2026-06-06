/**
 * Tests for src/main/cloud/moderationGate — Plan 12-07 pre-publish moderation
 * orchestrator (SHARE-05 / SHARE-06 / SHARE-07).
 *
 * RED phase: this file is committed BEFORE moderationGate.ts exists. Imports
 * resolve once the GREEN-phase implementation lands in the sibling file.
 *
 * Invariants under test:
 *   1. Orchestration order — image moderation Edge Function is called BEFORE
 *      prompt moderation Edge Function (Pitfall 12 inherits from 12-03: portrait
 *      bytes must already be in Storage, image scan is the first gate).
 *   2. portraitUrl is DERIVED server-side from `${SUPABASE_URL}/storage/v1/object/
 *      public/portraits/${ownerUuid}/${characterId}.png` — caller never supplies
 *      it (T-12-03-01 mitigation; per 12-03-SUMMARY caller invariant).
 *   3. SOFT_RETRY_CAP = 2 — 3rd consecutive regenerate verdict returns
 *      PROMPT_FLAGGED, never publishes (Pitfall 6 / T-12-07-02).
 *   4. Provider 502 / network error → CLOUD_MODERATION_PROVIDER_UNAVAILABLE.
 *      upsertCharacter NEVER called with shared=true (Pitfall 12 / T-12-07-04).
 *   5. On any flag, upsertCharacter is not called with shared=true; the call
 *      flow short-circuits before the publish write.
 *   6. Clean path writes shared=true + moderation_status='clean' atomically.
 *
 * Mock strategy: dependency-inject all external collaborators via the `deps`
 * argument to publishWithModeration. No vi.mock — each test wires its own
 * vi.fn() stubs and asserts call order / payload shape.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CLOUD_MODERATION_IMAGE_FLAGGED,
  CLOUD_MODERATION_PROMPT_FLAGGED,
  CLOUD_MODERATION_PROVIDER_UNAVAILABLE,
} from './cloudErrors';
import { publishWithModeration, type PublishDeps } from './moderationGate';

const SUPABASE_URL = 'https://example.supabase.co';
const OWNER_UUID = 'owner-uuid-aaaa';
const CHARACTER_ID = 'char-uuid-bbbb';

interface FakeCharacterRow {
  id: string;
  owner: string;
  name: string;
  persona_source: string;
  persona_expanded: string;
}

function makeCharacter(overrides: Partial<FakeCharacterRow> = {}): FakeCharacterRow {
  return {
    id: CHARACTER_ID,
    owner: OWNER_UUID,
    name: 'Friendly Bot',
    persona_source: 'A cheerful Minecraft companion who loves building.',
    persona_expanded: 'EXPANDED v1',
    ...overrides,
  };
}

/**
 * Build a fresh dependency bag for each test. Individual tests override
 * specific stubs (e.g. a flagged image response) by replacing the returned
 * object's fields before calling publishWithModeration.
 */
function makeDeps(overrides: Partial<PublishDeps> = {}): PublishDeps & {
  __callEdgeFunction: ReturnType<typeof vi.fn>;
  __upsertCharacter: ReturnType<typeof vi.fn>;
  __reExpandPersona: ReturnType<typeof vi.fn>;
  __getCharacter: ReturnType<typeof vi.fn>;
  __getJwt: ReturnType<typeof vi.fn>;
} {
  const callEdgeFunction = vi.fn();
  const upsertCharacter = vi.fn(async () => undefined);
  const reExpandPersona = vi.fn(async () => 'EXPANDED v2');
  const getCharacter = vi.fn(async () => makeCharacter());
  const getJwt = vi.fn(async () => 'JWT-AAA');

  return {
    callEdgeFunction,
    upsertCharacter,
    reExpandPersona,
    getCharacter,
    getJwt,
    supabaseUrl: SUPABASE_URL,
    __callEdgeFunction: callEdgeFunction,
    __upsertCharacter: upsertCharacter,
    __reExpandPersona: reExpandPersona,
    __getCharacter: getCharacter,
    __getJwt: getJwt,
    ...overrides,
  } as PublishDeps & {
    __callEdgeFunction: ReturnType<typeof vi.fn>;
    __upsertCharacter: ReturnType<typeof vi.fn>;
    __reExpandPersona: ReturnType<typeof vi.fn>;
    __getCharacter: ReturnType<typeof vi.fn>;
    __getJwt: ReturnType<typeof vi.fn>;
  };
}

/**
 * Helper: program callEdgeFunction with a per-name script. Each call to a
 * given name shifts and returns the next element from its queue (or a
 * provider-error throw if the queue runs out).
 */
function programEdge(
  fn: ReturnType<typeof vi.fn>,
  scripts: { 'moderate-character-images'?: unknown[]; 'moderate-character-prompt'?: unknown[] },
): void {
  const queues: Record<string, unknown[]> = {
    'moderate-character-images': [...(scripts['moderate-character-images'] ?? [])],
    'moderate-character-prompt': [...(scripts['moderate-character-prompt'] ?? [])],
  };
  fn.mockImplementation(async (name: string) => {
    const q = queues[name];
    if (!q || q.length === 0) {
      throw new Error(`no programmed response for ${name}`);
    }
    const next = q.shift();
    if (next instanceof Error) throw next;
    return next;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('publishWithModeration — happy path', () => {
  it('Test 1: image clean + prompt clean → ok:true; upsertCharacter called with shared=true + moderation_status=clean', async () => {
    const deps = makeDeps();
    programEdge(deps.__callEdgeFunction, {
      'moderate-character-images': [{ status: 'clean', provider: 'sightengine-v2.1' }],
      'moderate-character-prompt': [{ verdict: 'clean' }],
    });

    const result = await publishWithModeration(CHARACTER_ID, deps);

    expect(result.ok).toBe(true);
    expect(deps.__upsertCharacter).toHaveBeenCalledTimes(1);
    const [character, ownerUuid] = deps.__upsertCharacter.mock.calls[0];
    expect(ownerUuid).toBe(OWNER_UUID);
    expect(character.shared).toBe(true);
    expect(character.moderation_status).toBe('clean');
    expect(typeof character.moderation_checked_at).toBe('string');
    expect(character.moderation_provider).toBe('sightengine-v2.1');
  });
});

describe('publishWithModeration — image moderation gate', () => {
  it('Test 2: image flagged → ok:false code=IMAGE_FLAGGED; upsertCharacter NEVER called with shared=true', async () => {
    const deps = makeDeps();
    programEdge(deps.__callEdgeFunction, {
      'moderate-character-images': [{ status: 'flagged', provider: 'sightengine-v2.1', category: 'minor_or_sexual' }],
      'moderate-character-prompt': [{ verdict: 'clean' }], // should never be consumed
    });

    const result = await publishWithModeration(CHARACTER_ID, deps);

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.code).toBe(CLOUD_MODERATION_IMAGE_FLAGGED);
      expect(typeof result.friendlyMessage).toBe('string');
      expect(result.friendlyMessage.length).toBeGreaterThan(0);
    }
    // No publish write whatsoever — and certainly none with shared=true.
    for (const call of deps.__upsertCharacter.mock.calls) {
      expect(call[0]?.shared).not.toBe(true);
    }
    // Prompt moderation must NOT be invoked when image is already flagged.
    const promptCalls = deps.__callEdgeFunction.mock.calls.filter(
      ([name]) => name === 'moderate-character-prompt',
    );
    expect(promptCalls.length).toBe(0);
  });
});

describe('publishWithModeration — prompt moderation hard tier', () => {
  it('Test 3: image clean + hard-prompt block → ok:false code=PROMPT_FLAGGED; upsertCharacter NEVER called with shared=true', async () => {
    const deps = makeDeps();
    programEdge(deps.__callEdgeFunction, {
      'moderate-character-images': [{ status: 'clean', provider: 'sightengine-v2.1' }],
      'moderate-character-prompt': [{ verdict: 'block', tier: 'hard' }],
    });

    const result = await publishWithModeration(CHARACTER_ID, deps);

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.code).toBe(CLOUD_MODERATION_PROMPT_FLAGGED);
    }
    for (const call of deps.__upsertCharacter.mock.calls) {
      expect(call[0]?.shared).not.toBe(true);
    }
  });
});

describe('publishWithModeration — prompt moderation soft tier retry cap', () => {
  it('Test 4: image clean + 3 consecutive regenerate verdicts → ok:false PROMPT_FLAGGED (Pitfall 6 cap=2)', async () => {
    const deps = makeDeps();
    // Initial + SOFT_RETRY_CAP retries = 3 prompt-mod calls; all return regenerate.
    programEdge(deps.__callEdgeFunction, {
      'moderate-character-images': [{ status: 'clean', provider: 'sightengine-v2.1' }],
      'moderate-character-prompt': [
        { verdict: 'regenerate', tier: 'soft' },
        { verdict: 'regenerate', tier: 'soft' },
        { verdict: 'regenerate', tier: 'soft' },
      ],
    });

    const result = await publishWithModeration(CHARACTER_ID, deps);

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.code).toBe(CLOUD_MODERATION_PROMPT_FLAGGED);
    }
    // Exactly 3 prompt-mod calls (1 initial + 2 retries).
    const promptCalls = deps.__callEdgeFunction.mock.calls.filter(
      ([name]) => name === 'moderate-character-prompt',
    );
    expect(promptCalls.length).toBe(3);
    // reExpandPersona invoked exactly 2 times (once per retry, NOT after the
    // final failure since we give up).
    expect(deps.__reExpandPersona).toHaveBeenCalledTimes(2);
    // Never publishes.
    for (const call of deps.__upsertCharacter.mock.calls) {
      expect(call[0]?.shared).not.toBe(true);
    }
  });

  it('Test 5: image clean + first retry yields clean → ok:true (single retry success path)', async () => {
    const deps = makeDeps();
    programEdge(deps.__callEdgeFunction, {
      'moderate-character-images': [{ status: 'clean', provider: 'sightengine-v2.1' }],
      'moderate-character-prompt': [
        { verdict: 'regenerate', tier: 'soft' }, // initial attempt
        { verdict: 'clean' },                    // 1st retry passes
      ],
    });

    const result = await publishWithModeration(CHARACTER_ID, deps);

    expect(result.ok).toBe(true);
    expect(deps.__reExpandPersona).toHaveBeenCalledTimes(1);
    expect(deps.__upsertCharacter).toHaveBeenCalledTimes(1);
    const [character] = deps.__upsertCharacter.mock.calls[0];
    expect(character.shared).toBe(true);
    // The retry expansion must propagate into the persisted row.
    expect(character.persona_expanded).toBe('EXPANDED v2');
  });
});

describe('publishWithModeration — provider error hard-fail (Pitfall 12)', () => {
  it('Test 6: image Edge Function rejects → ok:false PROVIDER_UNAVAILABLE; upsertCharacter NEVER called', async () => {
    const deps = makeDeps();
    programEdge(deps.__callEdgeFunction, {
      'moderate-character-images': [new Error('HTTP 502 provider_error')],
    });

    const result = await publishWithModeration(CHARACTER_ID, deps);

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.code).toBe(CLOUD_MODERATION_PROVIDER_UNAVAILABLE);
    }
    expect(deps.__upsertCharacter).not.toHaveBeenCalled();
  });
});

describe('publishWithModeration — invariants', () => {
  it('Test 7: orchestration order — moderate-character-images is called before moderate-character-prompt', async () => {
    const deps = makeDeps();
    programEdge(deps.__callEdgeFunction, {
      'moderate-character-images': [{ status: 'clean', provider: 'sightengine-v2.1' }],
      'moderate-character-prompt': [{ verdict: 'clean' }],
    });

    await publishWithModeration(CHARACTER_ID, deps);

    const callNames = deps.__callEdgeFunction.mock.calls.map(([name]) => name);
    const imageIdx = callNames.indexOf('moderate-character-images');
    const promptIdx = callNames.indexOf('moderate-character-prompt');
    expect(imageIdx).toBeGreaterThanOrEqual(0);
    expect(promptIdx).toBeGreaterThanOrEqual(0);
    expect(imageIdx).toBeLessThan(promptIdx);
  });

  it('Test 8: portraitUrl is derived server-side from owner + characterId — NOT accepted from caller', async () => {
    const deps = makeDeps();
    programEdge(deps.__callEdgeFunction, {
      'moderate-character-images': [{ status: 'clean', provider: 'sightengine-v2.1' }],
      'moderate-character-prompt': [{ verdict: 'clean' }],
    });

    await publishWithModeration(CHARACTER_ID, deps);

    const imageCall = deps.__callEdgeFunction.mock.calls.find(
      ([name]) => name === 'moderate-character-images',
    );
    expect(imageCall).toBeDefined();
    const [, opts] = imageCall!;
    const body = opts.body as { characterId: string; portraitUrl: string };
    expect(body.characterId).toBe(CHARACTER_ID);
    // The derived URL must match the documented Storage layout exactly.
    expect(body.portraitUrl).toBe(
      `${SUPABASE_URL}/storage/v1/object/public/portraits/${OWNER_UUID}/${CHARACTER_ID}.png`,
    );
  });
});
