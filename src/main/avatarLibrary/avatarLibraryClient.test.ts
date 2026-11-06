import { describe, expect, it } from 'vitest';
import type { AvatarManifest } from '../../shared/ipc';
import { isLastPublicLock, effectiveAvatar, parseAvatarList } from '../../shared/avatarLibrary';
import { AvatarLibraryClient, AvatarLibraryNoSession, errorOf, imageMime, sha256Hex, type AvatarLibraryDeps } from './avatarLibraryClient';

const CHAR = '0b9d3f9e-1111-4222-8333-444455556666';
const A_CARD = '11111111-1111-4111-8111-111111111111';
const A_MODEL = '22222222-2222-4222-8222-222222222222';
const A_ADULT = '33333333-3333-4333-8333-333333333333';
const NEW_ID = '44444444-4444-4444-8444-444444444444';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const ZIP = new Uint8Array([0x50, 0x4b, 3, 4, 9, 9, 9]);

function item(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    kind: 'portrait',
    source: 'upload',
    name: null,
    sha256: 'c'.repeat(64),
    bytes: 100,
    mime: 'image/png',
    is_public: true,
    is_default: false,
    sort_order: 0,
    moderation: 'clean',
    shareable: true,
    url: 'https://x.supabase.co/sign/a',
    ...over,
  };
}

function listBody(over: Record<string, unknown> = {}, avatars: unknown[] = []) {
  return { character_id: CHAR, is_owner: true, character_public: true, default_id: null, avatars, ...over };
}

function manifest(over: Partial<AvatarManifest> = {}): AvatarManifest {
  return { kind: 'live2d', name: 'Model', ...over } as unknown as AvatarManifest;
}

interface H {
  client: AvatarLibraryClient;
  calls: Array<{ method: string; path: string; body?: unknown }>;
  events: Array<{ event: string; props: Record<string, unknown> }>;
  puts: string[];
  /** Answers by "METHOD path" prefix; a function answers per call. */
  routes: Map<string, (body: unknown) => { status: number; body: unknown }>;
  local: { manifest: AvatarManifest | null; imported: Uint8Array | null; removed: number };
  pick: { v: string | null };
  card: { v: { bytes: Uint8Array; mime: string } | null };
  downloads: Map<string, Uint8Array>;
  effectiveChanges: string[];
  online: { v: boolean };
}

function harness(): H {
  const h = {
    calls: [],
    events: [],
    puts: [],
    routes: new Map(),
    local: { manifest: null, imported: null, removed: 0 },
    pick: { v: null },
    card: { v: null },
    downloads: new Map(),
    effectiveChanges: [],
    online: { v: true },
  } as unknown as H;
  const deps: AvatarLibraryDeps = {
    api: async (method, path, body) => {
      h.calls.push({ method, path, body });
      const key = [...h.routes.keys()].find((k) => `${method} ${path}`.startsWith(k));
      if (!key) throw new Error(`no route for ${method} ${path}`);
      return h.routes.get(key)!(body);
    },
    online: () => h.online.v,
    putSigned: async (url) => void h.puts.push(url),
    download: async (url) => {
      const b = h.downloads.get(url);
      if (!b) throw new Error('404');
      return b;
    },
    cardPortrait: async () => h.card.v,
    models: {
      manifest: async () => h.local.manifest,
      zip: async () => (h.local.manifest ? ZIP : null),
      import: async (_id, zip) => {
        h.local.imported = zip;
        h.local.manifest = manifest();
        return h.local.manifest;
      },
      link: async (_id, link) => {
        if (!h.local.manifest) return null;
        h.local.manifest = { ...h.local.manifest, ...(link ? { library: link } : {}) };
        if (!link) delete (h.local.manifest as { library?: unknown }).library;
        return h.local.manifest;
      },
      remove: async () => {
        h.local.manifest = null;
        h.local.removed++;
      },
    },
    getPick: async () => h.pick.v,
    setPick: async (_id, v) => void (h.pick.v = v),
    capture: (event, props) => h.events.push({ event, props }),
    onView: () => {},
    onModel: () => {},
    onEffectiveChanged: (id) => h.effectiveChanges.push(id),
    now: () => 1_000_000,
  };
  h.client = new AvatarLibraryClient(deps);
  return h;
}

describe('shared avatar library helpers', () => {
  it('parses lists, drops malformed rows, sorts and resolves the default', () => {
    const l = parseAvatarList(
      listBody({ default_id: A_MODEL }, [
        item(A_MODEL, { kind: 'live2d', sort_order: 2 }),
        item(A_CARD, { source: 'card', sort_order: 1 }),
        { id: 'nope', kind: 'portrait', sha256: 'x' },
        item(A_ADULT, { kind: 'weird' }),
      ]),
    )!;
    expect(l.avatars.map((a) => a.id)).toEqual([A_CARD, A_MODEL]);
    expect(effectiveAvatar(l, null)?.id).toBe(A_MODEL);
    expect(effectiveAvatar(l, A_CARD)?.id).toBe(A_CARD);
    // A pick that is gone falls back to the default.
    expect(effectiveAvatar(l, A_ADULT)?.id).toBe(A_MODEL);
  });

  it('locks the last public avatar of a public character only', () => {
    const one = parseAvatarList(listBody({}, [item(A_CARD), item(A_ADULT, { is_public: false })]))!;
    expect(isLastPublicLock(one, one.avatars[0])).toBe(true);
    expect(isLastPublicLock(one, one.avatars[1])).toBe(false);
    const two = parseAvatarList(listBody({}, [item(A_CARD), item(A_ADULT)]))!;
    expect(isLastPublicLock(two, two.avatars[0])).toBe(false);
    const priv = parseAvatarList(listBody({ character_public: false }, [item(A_CARD)]))!;
    expect(isLastPublicLock(priv, priv.avatars[0])).toBe(false);
  });

  it('maps proxy errors to the closed set and sniffs images', () => {
    expect(errorOf(409, { error: 'last_public' })).toBe('last_public');
    expect(errorOf(413, { error: 'quota' })).toBe('quota');
    expect(errorOf(401, null)).toBe('signed_out');
    expect(errorOf(503, { error: 'whatever' })).toBe('server');
    expect(imageMime(PNG)).toBe('image/png');
    expect(imageMime(new Uint8Array([0xff, 0xd8, 0xff, 0]))).toBe('image/jpeg');
    expect(imageMime(ZIP)).toBeNull();
  });
});

describe('AvatarLibraryClient', () => {
  it('owner sync uploads a changed card image and migrates an unlinked local model', async () => {
    const h = harness();
    h.card.v = { bytes: PNG, mime: 'image/png' };
    h.local.manifest = manifest();
    let avatars: unknown[] = [item(A_CARD, { source: 'card', sha256: 'd'.repeat(64), is_default: true })];
    h.routes.set(`GET /avatars/v1/${CHAR}`, () => ({
      status: 200,
      body: listBody({ default_id: (avatars.findLast((a) => (a as { is_default: boolean }).is_default) as { id: string }).id }, avatars),
    }));
    h.routes.set(`POST /avatars/v1/${CHAR}/upload`, () => ({
      status: 200,
      body: { state: 'upload', upload: { url: 'https://x.supabase.co/upload/sign/s', path: 'staging/u/1', expires_in: 600 } },
    }));
    h.routes.set(`POST /avatars/v1/${CHAR}/commit`, (body) => {
      const b = body as { kind: string; sha256: string };
      if (b.kind === 'live2d') {
        avatars = [...avatars.map((a) => ({ ...(a as object), is_default: false })), item(NEW_ID, { kind: 'live2d', sha256: b.sha256, is_public: false, is_default: true })];
        return { status: 200, body: { avatar: { id: NEW_ID, moderation: 'pending' }, created: true } };
      }
      return { status: 200, body: { avatar: { id: A_CARD, moderation: 'clean' }, created: false } };
    });

    const view = await h.client.sync(CHAR);
    const commits = h.calls.filter((c) => c.path.endsWith('/commit')).map((c) => c.body as Record<string, unknown>);
    expect(commits.map((c) => [c.kind, c.source])).toEqual([
      ['portrait', 'card'],
      ['live2d', 'upload'],
    ]);
    expect(commits[0].sha256).toBe(sha256Hex(PNG));
    expect(commits[1]).toMatchObject({ make_default: true, staging_path: 'staging/u/1' });
    expect(h.puts).toHaveLength(2);
    expect(h.local.manifest?.library).toEqual({ avatarId: NEW_ID, sha256: sha256Hex(ZIP) });
    expect(view.effective_id).toBe(NEW_ID);
    const uploaded = h.events.filter((e) => e.event === 'avatar_uploaded').map((e) => e.props.source);
    expect(uploaded).toEqual(['card', 'migration']);
  });

  it('skips the PUT when the server already has the bytes (dedupe)', async () => {
    const h = harness();
    h.card.v = { bytes: PNG, mime: 'image/png' };
    h.routes.set(`GET /avatars/v1/${CHAR}`, () => ({ status: 200, body: listBody({}, []) }));
    h.routes.set(`POST /avatars/v1/${CHAR}/upload`, () => ({ status: 200, body: { state: 'exists' } }));
    h.routes.set(`POST /avatars/v1/${CHAR}/commit`, () => ({ status: 200, body: { avatar: { id: A_CARD } } }));
    await h.client.sync(CHAR);
    expect(h.puts).toEqual([]);
    const commit = h.calls.find((c) => c.path.endsWith('/commit'))!.body as Record<string, unknown>;
    expect(commit.staging_path).toBeUndefined();
    expect(h.events.find((e) => e.event === 'avatar_uploaded')?.props.dedupe).toBe(true);
  });

  it('another user downloads a public model once and never regenerates it', async () => {
    const h = harness();
    const url = 'https://x.supabase.co/sign/model.zip';
    h.downloads.set(url, ZIP);
    h.routes.set(`GET /avatars/v1/${CHAR}`, () => ({
      status: 200,
      body: listBody({ is_owner: false, default_id: A_MODEL }, [
        item(A_CARD, { source: 'card' }),
        item(A_MODEL, { kind: 'live2d', sha256: sha256Hex(ZIP), is_default: true, url }),
      ]),
    }));
    await h.client.ensure(CHAR);
    expect(h.local.imported).toEqual(ZIP);
    expect(h.local.manifest?.library?.avatarId).toBe(A_MODEL);
    expect(h.events.map((e) => e.event)).toEqual(['avatar_downloaded_shared']);
    // No uploads for a non-owner, and a second pass is a no-op.
    h.local.imported = null;
    await h.client.sync(CHAR);
    expect(h.local.imported).toBeNull();
    expect(h.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('rejects a download whose hash does not match', async () => {
    const h = harness();
    const url = 'https://x.supabase.co/sign/model.zip';
    h.downloads.set(url, new Uint8Array([1, 2, 3]));
    h.routes.set(`GET /avatars/v1/${CHAR}`, () => ({
      status: 200,
      body: listBody({ is_owner: false }, [item(A_MODEL, { kind: 'live2d', sha256: sha256Hex(ZIP), url })]),
    }));
    await h.client.ensure(CHAR);
    expect(h.local.imported).toBeNull();
    expect(h.events.at(-1)).toEqual({ event: 'avatar_library_failed', props: { op: 'download', reason: 'hash_mismatch' } });
  });

  it('a viewer pick of a portrait clears the downloaded model and re-asks Anima for that portrait', async () => {
    const h = harness();
    const url = 'https://x.supabase.co/sign/model.zip';
    h.downloads.set(url, ZIP);
    const body = listBody({ is_owner: false, default_id: A_MODEL }, [
      item(A_ADULT, { sha256: 'e'.repeat(64) }),
      item(A_MODEL, { kind: 'live2d', sha256: sha256Hex(ZIP), is_default: true, url }),
    ]);
    h.routes.set(`GET /avatars/v1/${CHAR}`, () => ({ status: 200, body }));
    await h.client.ensure(CHAR);
    expect(await h.client.animaAvatarFor(CHAR)).toBeNull();

    const res = await h.client.setPick(CHAR, A_ADULT);
    expect(res.ok).toBe(true);
    expect(h.local.manifest).toBeNull();
    expect(h.effectiveChanges).toEqual([CHAR]);
    expect(await h.client.animaAvatarFor(CHAR)).toEqual({ avatarId: A_ADULT, sha256: 'e'.repeat(64) });
    expect(h.events.find((e) => e.event === 'avatar_default_changed')?.props).toMatchObject({ by: 'viewer', kind: 'portrait', from_kind: 'live2d' });
  });

  it('surfaces the last-public refusal without logging it as a failure', async () => {
    const h = harness();
    h.routes.set(`GET /avatars/v1/${CHAR}`, () => ({ status: 200, body: listBody({}, [item(A_CARD, { source: 'card' })]) }));
    h.routes.set(`PATCH /avatars/v1/${CHAR}/${A_CARD}`, () => ({ status: 409, body: { error: 'last_public' } }));
    await h.client.view(CHAR);
    const res = await h.client.setFlags(CHAR, A_CARD, { is_public: false });
    expect(res).toEqual({ ok: false, error: 'last_public' });
    expect(h.events.filter((e) => e.event === 'avatar_library_failed')).toEqual([]);
  });

  it('records visibility and default changes on success', async () => {
    const h = harness();
    let avatars = [item(A_CARD, { source: 'card', is_default: true }), item(A_ADULT, { is_public: false })];
    h.routes.set(`GET /avatars/v1/${CHAR}`, () => ({ status: 200, body: listBody({ default_id: avatars.find((a) => a.is_default)!.id }, avatars) }));
    h.routes.set(`PATCH /avatars/v1/${CHAR}/${A_ADULT}`, (b) => {
      const f = b as { is_public?: boolean; is_default?: boolean };
      avatars = avatars.map((a) =>
        a.id === A_ADULT
          ? { ...a, ...(f.is_public !== undefined ? { is_public: f.is_public } : {}), ...(f.is_default ? { is_default: true } : {}) }
          : f.is_default
            ? { ...a, is_default: false }
            : a,
      );
      return { status: 200, body: { avatars } };
    });
    await h.client.view(CHAR);
    expect((await h.client.setFlags(CHAR, A_ADULT, { is_public: true })).ok).toBe(true);
    const r = await h.client.setFlags(CHAR, A_ADULT, { is_default: true });
    expect(r.ok && r.view.effective_id).toBe(A_ADULT);
    expect(h.events.map((e) => e.event)).toEqual(['avatar_visibility_changed', 'avatar_default_changed']);
    expect(h.events[0].props).toMatchObject({ to: 'public', public_count: 2, character_public: true });
    expect(h.events[1].props).toMatchObject({ by: 'owner', from_kind: 'portrait' });
  });

  it('treats a 404 (no row, or an old proxy) and signed-out as no library', async () => {
    const h = harness();
    h.routes.set(`GET /avatars/v1/${CHAR}`, () => ({ status: 404, body: { error: 'not_found' } }));
    expect((await h.client.sync(CHAR)).state).toBe('none');
    expect(await h.client.animaAvatarFor(CHAR)).toBeNull();

    const h2 = harness();
    h2.routes.set(`GET /avatars/v1/${CHAR}`, () => {
      throw new AvatarLibraryNoSession();
    });
    expect((await h2.client.view(CHAR)).state).toBe('none');
    expect(h2.events).toEqual([]);
  });

  it('never overwrites an owner local model that is not uploaded yet', async () => {
    const h = harness();
    h.local.manifest = manifest();
    const url = 'https://x.supabase.co/sign/other.zip';
    h.downloads.set(url, new Uint8Array([7, 7]));
    h.routes.set(`GET /avatars/v1/${CHAR}`, () => ({
      status: 200,
      body: listBody({}, [item(A_MODEL, { kind: 'live2d', sha256: sha256Hex(new Uint8Array([7, 7])), is_default: true, url })]),
    }));
    await h.client.ensure(CHAR);
    expect(h.local.imported).toBeNull();
    expect(h.local.manifest?.library).toBeUndefined();
  });

  it('removing a downloaded model locally: owner deletes it, a viewer picks a portrait', async () => {
    const h = harness();
    h.routes.set(`GET /avatars/v1/${CHAR}`, () => ({
      status: 200,
      body: listBody({ is_owner: false }, [item(A_CARD, { source: 'card' }), item(A_MODEL, { kind: 'live2d', is_default: true })]),
    }));
    const r = await h.client.modelRemovedLocally(CHAR, { avatarId: A_MODEL, sha256: 'c'.repeat(64) });
    expect(r.ok).toBe(true);
    expect(h.pick.v).toBe(A_CARD);
    expect(h.calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('writes offline answer offline without calling the proxy', async () => {
    const h = harness();
    h.online.v = false;
    expect(await h.client.setFlags(CHAR, A_CARD, { is_public: true })).toEqual({ ok: false, error: 'offline' });
    expect(await h.client.addPortrait(CHAR, ZIP, null)).toEqual({ ok: false, error: 'bad_content' });
    expect(h.calls).toEqual([]);
  });
});
