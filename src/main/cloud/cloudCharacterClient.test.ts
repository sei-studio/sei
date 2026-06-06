/**
 * Tests for src/main/cloud/cloudCharacterClient — Phase 11 typed wrapper over
 * Supabase characters table + skins/portraits storage buckets.
 *
 * Covers the four invariants the client is the sole gate for:
 *   1. is_default rows NEVER upload (D-22)
 *   2. data: portrait_image rows NEVER upload (Pitfall 2 defense-in-depth)
 *   3. Storage uploads use the NESTED `<owner>/<uuid>.png` layout (Plan 11-01 RLS)
 *   4. Every call wrapped in 15s AbortController timeout → CLOUD_SYNC_TIMEOUT
 *
 * Mock strategy: vi.mock the supabaseClient singleton with a hand-rolled mock
 * whose `.from()` / `.storage.from()` returns method-chain stubs we can inspect
 * after the SUT runs. Lets us assert payload shape + storage path without
 * spinning up a real Supabase fixture.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Character } from '../../shared/characterSchema';

// ---- Mock supabase client ------------------------------------------------

interface CapturedUpsert {
  payload: Record<string, unknown> | null;
  signal: AbortSignal | null;
}
interface CapturedStorageUpload {
  bucket: string;
  path: string;
  contentType: string | undefined;
  upsert: boolean | undefined;
}
interface MockState {
  upsert: CapturedUpsert;
  selectRows: Record<string, unknown>[];
  selectError: { message: string } | null;
  upsertError: { message: string } | null;
  storageUploads: CapturedStorageUpload[];
  storageUploadError: { message: string } | null;
  storageRemoves: { bucket: string; names: string[] }[];
  /** Captured sign-character-asset-upload Edge Function calls. */
  edgeCalls: { name: string; body: unknown }[];
  /** When set, callEdgeFunction returns ok:false with this status/message. */
  edgeError: { status: number; message: string } | null;
  /** When true the upsert hang-and-honor-signal path is used for timeout tests. */
  hangUpsert: boolean;
}

const state: MockState = {
  upsert: { payload: null, signal: null },
  selectRows: [],
  selectError: null,
  upsertError: null,
  storageUploads: [],
  storageUploadError: null,
  storageRemoves: [],
  edgeCalls: [],
  edgeError: null,
  hangUpsert: false,
};

function resetState(): void {
  state.upsert = { payload: null, signal: null };
  state.selectRows = [];
  state.selectError = null;
  state.upsertError = null;
  state.storageUploads = [];
  state.storageUploadError = null;
  state.storageRemoves = [];
  state.edgeCalls = [];
  state.edgeError = null;
  state.hangUpsert = false;
}

function makeUpsertBuilder() {
  let signal: AbortSignal | null = null;
  const builder = {
    abortSignal(s: AbortSignal) {
      signal = s;
      state.upsert.signal = s;
      if (state.hangUpsert) {
        return new Promise((_resolve, reject) => {
          if (signal) {
            signal.addEventListener('abort', () => {
              const err = new Error('aborted');
              (err as Error & { name: string }).name = 'AbortError';
              reject(err);
            });
          }
        });
      }
      return Promise.resolve({ error: state.upsertError });
    },
  };
  return builder;
}

function makeFromBuilder() {
  return {
    upsert(payload: Record<string, unknown>) {
      state.upsert.payload = payload;
      return makeUpsertBuilder();
    },
    select() {
      return {
        eq() {
          return {
            limit() {
              return {
                abortSignal() {
                  return Promise.resolve({ data: state.selectRows, error: state.selectError });
                },
              };
            },
            abortSignal() {
              return Promise.resolve({ data: state.selectRows, error: state.selectError });
            },
          };
        },
      };
    },
    delete() {
      return {
        eq() {
          return {
            abortSignal() {
              return Promise.resolve({ error: state.upsertError });
            },
          };
        },
      };
    },
  };
}

function makeStorageBucket(bucket: string) {
  return {
    upload(path: string, _bytes: Buffer, opts: { contentType?: string; upsert?: boolean }) {
      state.storageUploads.push({
        bucket,
        path,
        contentType: opts?.contentType,
        upsert: opts?.upsert,
      });
      return Promise.resolve({ error: state.storageUploadError });
    },
    uploadToSignedUrl(
      path: string,
      _token: string,
      _bytes: Buffer,
      opts: { contentType?: string; upsert?: boolean },
    ) {
      state.storageUploads.push({
        bucket,
        path,
        contentType: opts?.contentType,
        upsert: opts?.upsert,
      });
      return Promise.resolve({ error: state.storageUploadError });
    },
    remove(names: string[]) {
      state.storageRemoves.push({ bucket, names });
      return Promise.resolve({ error: null });
    },
    download() {
      return Promise.resolve({
        data: { arrayBuffer: () => Promise.resolve(new Uint8Array([1, 2, 3]).buffer) },
        error: null,
      });
    },
    getPublicUrl(p: string) {
      return { data: { publicUrl: `https://stub.example/${bucket}/${p}` } };
    },
  };
}

const mockClient = {
  from: vi.fn(() => makeFromBuilder()),
  storage: {
    from: vi.fn((bucket: string) => makeStorageBucket(bucket)),
  },
};

vi.mock('../auth/supabaseClient', () => ({
  getClient: () => mockClient,
}));

// uploadSkin/uploadPortrait now mint a signed URL via this Edge Function rather
// than uploading directly (asymmetric-JWT bridge). The factory derives the
// bucket from the request kind and returns a stub signed token.
vi.mock('../auth/edgeFunctionClient', () => ({
  callEdgeFunction: vi.fn(
    async (name: string, opts: { jwt: string; body?: { characterId: string; kind: 'portrait' | 'skin' } }) => {
      state.edgeCalls.push({ name, body: opts.body });
      if (state.edgeError) {
        return { ok: false, status: state.edgeError.status, message: state.edgeError.message };
      }
      const kind = opts.body?.kind;
      const bucket = kind === 'skin' ? 'skins' : 'portraits';
      return {
        ok: true,
        status: 200,
        json: { bucket, path: `signed-owner/${opts.body?.characterId}.png`, token: 'signed-token' },
      };
    },
  ),
}));

// ---- Helpers -------------------------------------------------------------

const OWNER = '00000000-0000-0000-0000-000000000001';
const CHAR_ID = '11111111-1111-4111-8111-111111111111';

function makeCharacter(overrides: Partial<Character> = {}): Character {
  return {
    id: CHAR_ID,
    name: 'Test',
    persona: { source: 'a friend', expanded: 'a friend who helps' },
    is_default: false,
    shared: true,
    slug: 'test',
    metadata: {},
    created: '2026-01-01T00:00:00.000Z',
    last_launched: null,
    playtime_ms: 0,
    portrait_image: null,
    skin: { source: 'none', mojang_username: null, png_sha256: null, applied_at: null },
    username: null,
    ...overrides,
  } as Character;
}

beforeEach(() => {
  resetState();
});

// ---- Tests ---------------------------------------------------------------

describe('cloudCharacterClient.upsertCharacter', () => {
  it('refuses is_default=true rows BEFORE any network call', async () => {
    const { upsertCharacter } = await import('./cloudCharacterClient');
    const defaultChar = makeCharacter({ is_default: true });
    await expect(upsertCharacter(defaultChar, OWNER)).rejects.toThrow(/CLOUD_SYNC_REFUSED_DEFAULT/);
    // Guard happens before the .from() call — no payload captured.
    expect(state.upsert.payload).toBeNull();
  });

  it('refuses portrait_image starting with data: BEFORE any network call', async () => {
    const { upsertCharacter } = await import('./cloudCharacterClient');
    const dataUrlChar = makeCharacter({ portrait_image: 'data:image/png;base64,iVBOR...' });
    await expect(upsertCharacter(dataUrlChar, OWNER)).rejects.toThrow(/CLOUD_SYNC_REFUSED_DATA_URL/);
    expect(state.upsert.payload).toBeNull();
  });

  it('sends a payload with is_default forced to false even if input slipped through', async () => {
    // Note: we can't actually pass is_default:true (the guard catches it). But we
    // CAN assert the literal `false` lives in the upsert payload — defense-in-depth.
    const { upsertCharacter } = await import('./cloudCharacterClient');
    await upsertCharacter(makeCharacter(), OWNER);
    expect(state.upsert.payload).not.toBeNull();
    expect(state.upsert.payload!.is_default).toBe(false);
    expect(state.upsert.payload!.owner).toBe(OWNER);
    expect(state.upsert.payload!.id).toBe(CHAR_ID);
    expect(state.upsert.payload!.persona_source).toBe('a friend');
    expect(state.upsert.payload!.persona_expanded).toBe('a friend who helps');
  });

  it('wraps the call in an AbortController — payload signal is the same instance', async () => {
    const { upsertCharacter } = await import('./cloudCharacterClient');
    await upsertCharacter(makeCharacter(), OWNER);
    expect(state.upsert.signal).toBeInstanceOf(AbortSignal);
  });

  it('maps a hung call (>15s) to CLOUD_SYNC_TIMEOUT via AbortSignal', async () => {
    vi.useFakeTimers();
    state.hangUpsert = true;
    const { upsertCharacter } = await import('./cloudCharacterClient');
    const promise = upsertCharacter(makeCharacter(), OWNER);
    // Attach a no-op catch so Node doesn't briefly observe the inner rejection
    // as "unhandled" before withTimeout's try/catch grabs it. The expect.rejects
    // below is the real assertion — this is purely a Node bookkeeping hint.
    promise.catch(() => {});
    // Advance past TIMEOUT_MS (15_000) so the setTimeout fires.
    await vi.advanceTimersByTimeAsync(15_001);
    await expect(promise).rejects.toThrow(/CLOUD_SYNC_TIMEOUT/);
    vi.useRealTimers();
  });
});

describe('cloudCharacterClient.uploadSkin / uploadPortrait (signed-URL via Edge Function)', () => {
  it('uploadSkin requests a skin signed URL then PUTs the bytes to it', async () => {
    const { uploadSkin } = await import('./cloudCharacterClient');
    await uploadSkin(CHAR_ID, Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'jwt-token');
    // Owner/path are server-derived now — the client only sends id + kind.
    expect(state.edgeCalls).toEqual([
      { name: 'sign-character-asset-upload', body: { characterId: CHAR_ID, kind: 'skin' } },
    ]);
    expect(state.storageUploads).toHaveLength(1);
    expect(state.storageUploads[0].bucket).toBe('skins');
    expect(state.storageUploads[0].path).toBe(`signed-owner/${CHAR_ID}.png`);
    expect(state.storageUploads[0].contentType).toBe('image/png');
  });

  it('uploadPortrait jpeg → kind=portrait, image/jpeg content-type', async () => {
    const { uploadPortrait } = await import('./cloudCharacterClient');
    await uploadPortrait(CHAR_ID, Buffer.from([0xff, 0xd8]), 'jpeg', 'jwt-token');
    expect(state.edgeCalls[0]).toEqual({
      name: 'sign-character-asset-upload',
      body: { characterId: CHAR_ID, kind: 'portrait' },
    });
    expect(state.storageUploads[0].bucket).toBe('portraits');
    expect(state.storageUploads[0].contentType).toBe('image/jpeg');
  });

  it('uploadPortrait webp → image/webp content-type', async () => {
    const { uploadPortrait } = await import('./cloudCharacterClient');
    await uploadPortrait(CHAR_ID, Buffer.from([0]), 'webp', 'jwt-token');
    expect(state.storageUploads[0].contentType).toBe('image/webp');
  });

  it('throws CLOUD_STORAGE_UPLOAD_FAILED when the Edge sign call fails', async () => {
    state.edgeError = { status: 403, message: 'forbidden' };
    const { uploadSkin } = await import('./cloudCharacterClient');
    await expect(uploadSkin(CHAR_ID, Buffer.from([0]), 'jwt-token')).rejects.toThrow(
      /CLOUD_STORAGE_UPLOAD_FAILED.*forbidden/,
    );
    // never reached the storage PUT
    expect(state.storageUploads).toHaveLength(0);
  });

  it('wraps the signed-URL PUT error in CLOUD_STORAGE_UPLOAD_FAILED', async () => {
    state.storageUploadError = { message: 'bad token' };
    const { uploadPortrait } = await import('./cloudCharacterClient');
    await expect(uploadPortrait(CHAR_ID, Buffer.from([0]), 'png', 'jwt-token')).rejects.toThrow(
      /CLOUD_STORAGE_UPLOAD_FAILED.*bad token/,
    );
  });
});

describe('cloudCharacterClient.listMyCharacters', () => {
  it('maps rows to Character objects with all D-24 fields', async () => {
    state.selectRows = [
      {
        id: CHAR_ID,
        owner: OWNER,
        slug: 'lyra',
        name: 'Lyra',
        persona_source: 'a knight',
        persona_expanded: 'a knight on a quest',
        is_default: false,
        shared: true,
        skin_source: 'username',
        mojang_username: 'lyrabot',
        skin_png_sha256: 'sha',
        skin_applied_at: '2026-01-02T00:00:00.000Z',
        username: 'lyrabot',
        last_launched: null,
        playtime_ms: 1234,
        portrait_image: 'lyra.png',
        metadata: { foo: 'bar' },
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ];
    const { listMyCharacters } = await import('./cloudCharacterClient');
    const chars = await listMyCharacters(OWNER);
    expect(chars).toHaveLength(1);
    expect(chars[0].id).toBe(CHAR_ID);
    expect(chars[0].name).toBe('Lyra');
    expect(chars[0].slug).toBe('lyra');
    expect(chars[0].persona.source).toBe('a knight');
    expect(chars[0].persona.expanded).toBe('a knight on a quest');
    expect(chars[0].is_default).toBe(false); // cloud never carries defaults
    expect(chars[0].shared).toBe(true);
    expect(chars[0].skin.source).toBe('username');
    expect(chars[0].skin.mojang_username).toBe('lyrabot');
    expect(chars[0].playtime_ms).toBe(1234);
    expect(chars[0].portrait_image).toBe('lyra.png');
    expect(chars[0].metadata).toEqual({ foo: 'bar' });
    expect(chars[0].created).toBe('2026-01-01T00:00:00.000Z');
  });

  it('wraps select error in CLOUD_LIST_FAILED', async () => {
    state.selectError = { message: 'rls denied' };
    const { listMyCharacters } = await import('./cloudCharacterClient');
    await expect(listMyCharacters(OWNER)).rejects.toThrow(/CLOUD_LIST_FAILED.*rls denied/);
  });
});

describe('cloudCharacterClient.deleteStorageObjects', () => {
  it('groups objects per bucket and calls remove() once per bucket', async () => {
    const { deleteStorageObjects } = await import('./cloudCharacterClient');
    await deleteStorageObjects([
      { bucket: 'skins', name: `${OWNER}/${CHAR_ID}.png` },
      { bucket: 'portraits', name: `${OWNER}/${CHAR_ID}.png` },
    ]);
    expect(state.storageRemoves).toHaveLength(2);
    const skinsRemove = state.storageRemoves.find(r => r.bucket === 'skins');
    const portraitsRemove = state.storageRemoves.find(r => r.bucket === 'portraits');
    expect(skinsRemove?.names).toEqual([`${OWNER}/${CHAR_ID}.png`]);
    expect(portraitsRemove?.names).toEqual([`${OWNER}/${CHAR_ID}.png`]);
  });

  it('no-ops on empty input', async () => {
    const { deleteStorageObjects } = await import('./cloudCharacterClient');
    await deleteStorageObjects([]);
    expect(state.storageRemoves).toHaveLength(0);
  });
});

describe('cloudCharacterClient.getStoragePublicUrl', () => {
  it('returns the bucket public URL for <owner>/<uuid>.png', async () => {
    const { getStoragePublicUrl } = await import('./cloudCharacterClient');
    const url = getStoragePublicUrl('portraits', OWNER, CHAR_ID);
    expect(url).toBe(`https://stub.example/portraits/${OWNER}/${CHAR_ID}.png`);
  });
});
