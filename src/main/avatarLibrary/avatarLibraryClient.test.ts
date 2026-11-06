import { describe, expect, it } from 'vitest';
import type { AvatarManifest } from '../../shared/ipc';
import { isLastPublicDeleteBlocked, isLastPublicLock, effectiveAvatar, parseAvatarList, publicCount } from '../../shared/avatarLibrary';
import {
  AvatarLibraryClient,
  AvatarLibraryNoSession,
  COMMIT_BUSY_RETRY_MS,
  COMMIT_POLL_MS,
  COMMIT_POLLS,
  errorOf,
  imageMime,
  refusedUploadKey,
  sha256Hex,
  type AvatarLibraryDeps,
} from './avatarLibraryClient';

const CHAR = '0b9d3f9e-1111-4222-8333-444455556666';
const A_CARD = '11111111-1111-4111-8111-111111111111';
const A_MODEL = '22222222-2222-4222-8222-222222222222';
const A_ADULT = '33333333-3333-4333-8333-333333333333';
const NEW_ID = '44444444-4444-4444-8444-444444444444';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

/** Header-only PNG (w x h), optionally an APNG: what the client's image rules read. */
function pngHeader(w: number, h: number, apng = false): Uint8Array {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      ...(apng ? [chunk('acTL', Buffer.from([0, 0, 0, 2, 0, 0, 0, 0]))] : []),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}
const ZIP = new Uint8Array([0x50, 0x4b, 3, 4, 9, 9, 9]);

function item(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    kind: 'portrait',
    source: 'upload',
    name: null,
    sha256: 'c'.repeat(64),
    rev: `${id.replace(/-/g, '').slice(0, 8)}${'0'.repeat(24)}`,
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
  skip: Map<string, string>;
  sleeps: number[];
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
    skip: new Map(),
    sleeps: [],
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
    skip: {
      has: async (id, rev) => h.skip.get(id) === rev,
      add: async (id, rev) => void h.skip.set(id, rev),
      clear: async (id) => void h.skip.delete(id),
    },
    getPick: async () => h.pick.v,
    setPick: async (_id, v) => void (h.pick.v = v),
    capture: (event, props) => h.events.push({ event, props }),
    onView: () => {},
    onModel: () => {},
    onEffectiveChanged: (id) => h.effectiveChanges.push(id),
    now: () => 1_000_000,
    sleep: async (ms) => void h.sleeps.push(ms),
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

  it('sha256 is optional (owner only) but rev is required; a malformed hash drops the row', () => {
    const l = parseAvatarList(
      listBody({}, [
        item(A_CARD, { sha256: null }),
        item(A_MODEL, { sha256: 'xyz' }),
        item(A_ADULT, { sha256: null, rev: undefined }),
      ]),
    )!;
    expect(l.avatars.map((a) => [a.id, a.sha256])).toEqual([[A_CARD, null]]);
    // An older proxy without rev: the hash stands in.
    const old = parseAvatarList(listBody({}, [item(A_CARD, { rev: undefined })]))!;
    expect(old.avatars[0].rev).toBe('c'.repeat(64));
  });

  it('publicCount matches the SQL: flagged rows never count, pending public rows do', () => {
    const l = parseAvatarList(
      listBody({}, [
        item(A_CARD, { moderation: 'pending' }),
        item(A_MODEL, { moderation: 'flagged' }),
        item(A_ADULT, { is_public: false }),
      ]),
    )!;
    expect(publicCount(l)).toBe(1);
    // The flagged public row's lock is never held; the pending one holds the rule.
    expect(isLastPublicLock(l, l.avatars.find((a) => a.id === A_MODEL)!)).toBe(false);
    expect(isLastPublicLock(l, l.avatars.find((a) => a.id === A_CARD)!)).toBe(true);
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

  it('blocks deleting the last public avatar only while another non-flagged one would remain (the SQL rule)', () => {
    // Only avatar: deleting it is allowed (her card image shows the old way); the lock still holds.
    const only = parseAvatarList(listBody({}, [item(A_MODEL, { kind: 'live2d' })]))!;
    expect(isLastPublicLock(only, only.avatars[0])).toBe(true);
    expect(isLastPublicDeleteBlocked(only, only.avatars[0])).toBe(false);
    // Only flagged rows would remain: allowed too.
    const flaggedLeft = parseAvatarList(listBody({}, [item(A_MODEL), item(A_ADULT, { is_public: false, moderation: 'flagged' })]))!;
    expect(isLastPublicDeleteBlocked(flaggedLeft, flaggedLeft.avatars[0])).toBe(false);
    // A private non-flagged row would remain: blocked.
    const privLeft = parseAvatarList(listBody({}, [item(A_MODEL), item(A_ADULT, { is_public: false })]))!;
    expect(isLastPublicDeleteBlocked(privLeft, privLeft.avatars[0])).toBe(true);
    expect(isLastPublicDeleteBlocked(privLeft, privLeft.avatars[1])).toBe(false);
    // Two public rows, or a private character: never blocked.
    const two = parseAvatarList(listBody({}, [item(A_MODEL), item(A_ADULT)]))!;
    expect(isLastPublicDeleteBlocked(two, two.avatars[0])).toBe(false);
    const priv = parseAvatarList(listBody({ character_public: false }, [item(A_MODEL), item(A_ADULT, { is_public: false })]))!;
    expect(isLastPublicDeleteBlocked(priv, priv.avatars[0])).toBe(false);
  });

  it('maps proxy errors to the closed set and sniffs images', () => {
    expect(errorOf(503, { error: 'busy' })).toBe('busy');
    expect(errorOf(400, { error: 'missing_upload' })).toBe('upload_required');
    expect(errorOf(409, { error: 'last_public' })).toBe('last_public');
    expect(errorOf(413, { error: 'quota' })).toBe('quota');
    expect(errorOf(401, null)).toBe('signed_out');
    expect(errorOf(503, { error: 'whatever' })).toBe('server');
    expect(imageMime(PNG)).toBe('image/png');
    expect(imageMime(new Uint8Array([0xff, 0xd8, 0xff, 0]))).toBe('image/jpeg');
    expect(imageMime(ZIP)).toBeNull();
    // the full 8-byte signature: a PNG start with a broken tail is not an image
    expect(imageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x0a, 0x00, 0, 0]))).toBeNull();
  });

  it('the default follows the proxy rule when the reply has no default_id: is_default, else card, else earliest clean', () => {
    const at = (h: number) => `2026-11-06T${String(h).padStart(2, '0')}:00:00.000Z`;
    const def = (rows: unknown[]) => parseAvatarList(listBody({ default_id: null }, rows))!;
    // the marked row wins
    expect(def([item(A_CARD, { source: 'card' }), item(A_MODEL, { is_default: true, created_at: at(3) })]).default_id).toBe(A_MODEL);
    // else the card row, even when uploads are older
    expect(def([item(A_MODEL, { created_at: at(1) }), item(A_CARD, { source: 'card', created_at: at(5) })]).default_id).toBe(A_CARD);
    // else the earliest-created clean row, not the first in sort order; a pending older row does not count
    const l = def([
      item(A_MODEL, { sort_order: 0, created_at: at(4) }),
      item(A_ADULT, { sort_order: 1, created_at: at(2) }),
      item(NEW_ID, { sort_order: 2, created_at: at(1), moderation: 'pending' }),
    ]);
    expect(l.avatars.map((a) => a.id)).toEqual([A_MODEL, A_ADULT, NEW_ID]);
    expect(l.default_id).toBe(A_ADULT);
    expect(effectiveAvatar(l, null)?.id).toBe(A_ADULT);
    // nothing clean and no card: no default, and nothing plays (no first-row fallback)
    const none = def([item(A_MODEL, { moderation: 'pending' }), item(A_ADULT, { moderation: 'needs_review' })]);
    expect(none.default_id).toBeNull();
    expect(effectiveAvatar(none, null)).toBeNull();
    expect(effectiveAvatar(none, A_ADULT)?.id).toBe(A_ADULT);
    // a default_id the reply sends but the list does not hold falls back to the rule
    expect(parseAvatarList(listBody({ default_id: A_CARD }, [item(A_MODEL, { created_at: at(1) })]))!.default_id).toBe(A_MODEL);
  });
});

describe('AvatarLibraryClient', () => {
  it('owner sync asks the proxy to rebuild a changed card row and migrates a local model private, not default', async () => {
    const h = harness();
    h.card.v = { bytes: PNG, mime: 'image/png' };
    h.local.manifest = manifest();
    const NEW_REV = 'ab'.repeat(16);
    let avatars: unknown[] = [item(A_CARD, { source: 'card', sha256: 'd'.repeat(64), is_default: true })];
    h.routes.set(`GET /avatars/v1/${CHAR}`, () => ({
      status: 200,
      body: listBody({ default_id: (avatars as Array<{ id: string; is_default: boolean }>).filter((a) => a.is_default).at(-1)!.id }, avatars),
    }));
    h.routes.set(`POST /avatars/v1/${CHAR}/upload`, () => ({
      status: 200,
      body: { state: 'upload', upload: { url: 'https://x.supabase.co/upload/sign/s', path: 'staging/u/1', expires_in: 600 } },
    }));
    h.routes.set(`POST /avatars/v1/${CHAR}/commit`, (body) => {
      const b = body as { kind: string; sha256: string; make_default?: boolean };
      if (b.kind === 'live2d') {
        avatars = [...avatars, item(NEW_ID, { kind: 'live2d', sha256: b.sha256, rev: NEW_REV, is_public: false, is_default: b.make_default === true })];
        return { status: 200, body: { avatar: { id: NEW_ID, rev: NEW_REV, moderation: 'pending' }, created: true } };
      }
      return { status: 200, body: { avatar: { id: A_CARD, moderation: 'clean' }, created: false } };
    });

    const view = await h.client.sync(CHAR);
    const commits = h.calls.filter((c) => c.path.endsWith('/commit')).map((c) => c.body as Record<string, unknown>);
    expect(commits.map((c) => [c.kind, c.source])).toEqual([
      ['portrait', 'card'],
      ['live2d', 'upload'],
    ]);
    // The card row: only the hash this device expects, never bytes or a staging path.
    expect(commits[0]).toEqual({ kind: 'portrait', source: 'card', sha256: sha256Hex(PNG) });
    expect(h.calls.filter((c) => c.path.endsWith('/upload')).map((c) => (c.body as { kind: string }).kind)).toEqual(['live2d']);
    expect(commits[1]).toMatchObject({ staging_path: 'staging/u/1' });
    expect(commits[1].make_default).toBeUndefined();
    expect(h.calls.some((c) => c.method === 'PATCH')).toBe(false);
    expect(h.puts).toHaveLength(1);
    expect(h.local.manifest?.library).toEqual({ avatarId: NEW_ID, rev: NEW_REV });
    // It still plays here: this device picks it for the owner.
    expect(h.pick.v).toBe(NEW_ID);
    expect(view.effective_id).toBe(NEW_ID);
    expect(view.list?.default_id).toBe(A_CARD);
    const uploaded = h.events.filter((e) => e.event === 'avatar_uploaded').map((e) => e.props.source);
    expect(uploaded).toEqual(['card', 'migration']);
  });

  it('an unchanged card asks nothing; a card the cloud does not have yet is retried quietly', async () => {
    const h = harness();
    h.card.v = { bytes: PNG, mime: 'image/png' };
    h.routes.set(`GET /avatars/v1/${CHAR}`, () => ({ status: 200, body: listBody({}, [item(A_CARD, { source: 'card', sha256: sha256Hex(PNG) })]) }));
    await h.client.sync(CHAR);
    expect(h.calls.some((c) => c.method === 'POST')).toBe(false);

    for (const error of ['card_changed', 'no_card', 'card_conflict']) {
      const h2 = harness();
      h2.card.v = { bytes: PNG, mime: 'image/png' };
      h2.routes.set(`GET /avatars/v1/${CHAR}`, () => ({ status: 200, body: listBody({}, []) }));
      h2.routes.set(`POST /avatars/v1/${CHAR}/commit`, () => ({ status: 409, body: { error } }));
      const v = await h2.client.sync(CHAR);
      expect(v.state).toBe('ready');
      expect(h2.events.filter((e) => e.event === 'avatar_library_failed')).toEqual([]);
    }
  });

  it('an explicit model add becomes the default (still private)', async () => {
    const h = harness();
    h.local.manifest = manifest();
    h.routes.set(`GET /avatars/v1/${CHAR}`, () => ({ status: 200, body: listBody({}, [item(A_CARD, { source: 'card', is_default: true })]) }));
    h.routes.set(`POST /avatars/v1/${CHAR}/upload`, () => ({ status: 200, body: { state: 'exists' } }));
    h.routes.set(`POST /avatars/v1/${CHAR}/commit`, () => ({ status: 200, body: { avatar: { id: NEW_ID, rev: 'cd'.repeat(16) } } }));
    await h.client.addLocalModel(CHAR);
    const commit = h.calls.find((c) => c.path.endsWith('/commit'))!.body as Record<string, unknown>;
    expect(commit).toMatchObject({ kind: 'live2d', source: 'upload', make_default: true });
    expect(commit.is_public).toBeUndefined();
  });

  it('skips the PUT when the server already has the bytes (dedupe)', async () => {
    const h = harness();
    h.local.manifest = manifest();
    h.routes.set(`GET /avatars/v1/${CHAR}`, () => ({ status: 200, body: listBody({}, []) }));
    h.routes.set(`POST /avatars/v1/${CHAR}/upload`, () => ({ status: 200, body: { state: 'exists' } }));
    h.routes.set(`POST /avatars/v1/${CHAR}/commit`, () => ({ status: 200, body: { avatar: { id: NEW_ID, rev: 'ef'.repeat(16) } } }));
    await h.client.sync(CHAR);
    expect(h.puts).toEqual([]);
    const commit = h.calls.find((c) => c.path.endsWith('/commit'))!.body as Record<string, unknown>;
    expect(commit.staging_path).toBeUndefined();
    expect(h.events.find((e) => e.event === 'avatar_uploaded')?.props).toMatchObject({ dedupe: true, source: 'migration' });
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

  it('rejects a download whose hash does not match, and does not fetch it again', async () => {
    const h = harness();
    const url = 'https://x.supabase.co/sign/model.zip';
    h.downloads.set(url, new Uint8Array([1, 2, 3]));
    h.routes.set(`GET /avatars/v1/${CHAR}`, () => ({
      status: 200,
      body: listBody({}, [item(A_MODEL, { kind: 'live2d', sha256: sha256Hex(ZIP), url, is_default: true })]),
    }));
    let downloads = 0;
    const real = h.downloads.get.bind(h.downloads);
    h.downloads.get = (k: string) => (downloads++, real(k));
    await h.client.ensure(CHAR);
    expect(h.local.imported).toBeNull();
    expect(h.events.at(-1)).toEqual({ event: 'avatar_library_failed', props: { op: 'download', reason: 'hash_mismatch' } });
    await h.client.sync(CHAR);
    expect(downloads).toBe(1);
  });

  it('a non-owner (no hash) downloads by rev; a model that fails to import is never downloaded again', async () => {
    const h = harness();
    const url = 'https://x.supabase.co/sign/bomb.zip';
    h.downloads.set(url, ZIP);
    const row = item(A_MODEL, { kind: 'live2d', sha256: null, is_default: true, url });
    h.routes.set(`GET /avatars/v1/${CHAR}`, () => ({ status: 200, body: listBody({ is_owner: false }, [item(A_CARD, { sha256: null }), row]) }));
    let imports = 0;
    const deps = (h.client as unknown as { d: AvatarLibraryDeps }).d;
    deps.models.import = async () => {
      imports++;
      throw new Error('avatar zip file expands past its declared size');
    };
    await h.client.ensure(CHAR);
    expect(imports).toBe(1);
    expect(h.skip.get(A_MODEL)).toBe(row.rev);
    expect(h.events.at(-1)?.props).toMatchObject({ op: 'download', reason: 'import_failed' });
    // later passes leave it alone
    await h.client.view(CHAR, { fresh: true });
    await h.client.ensure(CHAR);
    await h.client.sync(CHAR);
    expect(imports).toBe(1);
    // a new rev (the owner replaced it) is a new try; so is the viewer picking it again
    h.skip.set(A_MODEL, 'f'.repeat(32));
    await h.client.view(CHAR, { fresh: true });
    await h.client.ensure(CHAR);
    expect(imports).toBe(2);
    await h.client.setPick(CHAR, A_MODEL);
    expect(imports).toBe(3);
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
    expect(await h.client.animaAvatarFor(CHAR)).toEqual({ avatarId: A_ADULT, rev: item(A_ADULT).rev });
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

  it('never overwrites a viewer model imported by hand', async () => {
    const h = harness();
    h.local.manifest = manifest();
    const url = 'https://x.supabase.co/sign/m.zip';
    h.downloads.set(url, ZIP);
    h.routes.set(`GET /avatars/v1/${CHAR}`, () => ({
      status: 200,
      body: listBody({ is_owner: false }, [item(A_MODEL, { kind: 'live2d', sha256: sha256Hex(ZIP), is_default: true, url })]),
    }));
    await h.client.sync(CHAR);
    expect(h.local.imported).toBeNull();
    expect(h.calls.some((c) => c.method === 'POST')).toBe(false);
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
    const r = await h.client.modelRemovedLocally(CHAR, { avatarId: A_MODEL, rev: item(A_MODEL).rev });
    expect(r.ok).toBe(true);
    expect(h.pick.v).toBe(A_CARD);
    expect(h.calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('a refused owner delete of a locally removed model does not bring it back', async () => {
    const h = harness();
    const url = 'https://x.supabase.co/sign/model.zip';
    h.downloads.set(url, ZIP);
    const model = item(A_MODEL, { kind: 'live2d', sha256: sha256Hex(ZIP), is_default: true, url });
    h.routes.set(`GET /avatars/v1/${CHAR}`, () => ({ status: 200, body: listBody({}, [model]) }));
    h.routes.set(`DELETE /avatars/v1/${CHAR}/${A_MODEL}`, () => ({ status: 409, body: { error: 'last_public' } }));
    await h.client.ensure(CHAR);
    expect(h.local.imported).toEqual(ZIP);
    // the user removes it on this device (ipc avatar.remove clears the store first)
    h.local.manifest = null;
    h.local.imported = null;
    const r = await h.client.modelRemovedLocally(CHAR, { avatarId: A_MODEL, rev: model.rev });
    expect(r).toEqual({ ok: false, error: 'last_public' });
    await h.client.sync(CHAR);
    await h.client.ensure(CHAR);
    expect(h.local.imported).toBeNull();
  });

  it('writes offline answer offline without calling the proxy', async () => {
    const h = harness();
    h.online.v = false;
    expect(await h.client.setFlags(CHAR, A_CARD, { is_public: true })).toEqual({ ok: false, error: 'offline' });
    expect(await h.client.addPortrait(CHAR, ZIP, null)).toEqual({ ok: false, error: 'bad_content' });
    expect(h.calls).toEqual([]);
  });
  // ── round 3: upload limits, refusals, busy, processing ──────────────────────

  function uploadRoutes(h: H, avatars: () => unknown[], over: Record<string, unknown> = {}) {
    h.routes.set(`GET /avatars/v1/${CHAR}`, () => ({ status: 200, body: listBody(over, avatars()) }));
    h.routes.set(`POST /avatars/v1/${CHAR}/upload`, () => ({
      status: 200,
      body: { state: 'upload', upload: { url: 'https://x.supabase.co/upload/sign/s', path: 'staging/u/1' } },
    }));
  }

  it('a local model the server refused is never sent again by sync (per character + zip hash)', async () => {
    const h = harness();
    h.local.manifest = manifest();
    uploadRoutes(h, () => []);
    h.routes.set(`POST /avatars/v1/${CHAR}/commit`, () => ({ status: 400, body: { error: 'bad_content' } }));
    await h.client.sync(CHAR);
    expect(h.skip.get(refusedUploadKey(CHAR))).toBe(sha256Hex(ZIP));
    expect(h.puts).toHaveLength(1);
    const asked = h.calls.length;
    await h.client.sync(CHAR);
    // Only the list again: no upload ask, no PUT, no commit.
    expect(h.calls.slice(asked).map((c) => `${c.method} ${c.path}`)).toEqual([`GET /avatars/v1/${CHAR}`]);
    expect(h.puts).toHaveLength(1);
    // The user adding it by hand gets one more try.
    await h.client.addLocalModel(CHAR);
    expect(h.calls.filter((c) => c.path.endsWith('/commit'))).toHaveLength(2);
  });

  it('a busy, rate-limited or quota answer is not remembered as a refusal', async () => {
    for (const [status, error] of [[503, 'busy'], [429, 'staging_quota'], [413, 'quota']] as const) {
      const h = harness();
      h.local.manifest = manifest();
      uploadRoutes(h, () => []);
      h.routes.set(`POST /avatars/v1/${CHAR}/commit`, () => ({ status, body: { error } }));
      if (error === 'staging_quota') h.routes.set(`POST /avatars/v1/${CHAR}/upload`, () => ({ status, body: { error } }));
      await h.client.sync(CHAR);
      expect(h.skip.has(refusedUploadKey(CHAR))).toBe(false);
    }
  });

  it('a model over the listed zip cap is refused before any upload request', async () => {
    const h = harness();
    h.local.manifest = manifest();
    uploadRoutes(h, () => [], { limits: { max_per_character: 8, max_image_bytes: 1000, max_zip_bytes: ZIP.byteLength - 1 } });
    expect(await h.client.addLocalModel(CHAR)).toEqual({ ok: false, error: 'too_big' });
    expect(h.calls.some((c) => c.path.endsWith('/upload') || c.path.endsWith('/commit'))).toBe(false);
    expect(h.skip.get(refusedUploadKey(CHAR))).toBe(sha256Hex(ZIP));
  });

  it('portraits: animated or over 4096 px or over the listed byte cap are refused before anything goes up', async () => {
    const h = harness();
    uploadRoutes(h, () => [], { limits: { max_per_character: 8, max_image_bytes: 200, max_zip_bytes: 1000 } });
    await h.client.view(CHAR);
    expect(await h.client.addPortrait(CHAR, pngHeader(8, 8, true), null)).toEqual({ ok: false, error: 'bad_content' });
    expect(await h.client.addPortrait(CHAR, pngHeader(4097, 8), null)).toEqual({ ok: false, error: 'too_big' });
    expect(await h.client.addPortrait(CHAR, new Uint8Array([...pngHeader(8, 8), ...new Uint8Array(300)]), null)).toEqual({ ok: false, error: 'too_big' });
    expect(await h.client.addPortrait(CHAR, PNG, null)).toEqual({ ok: false, error: 'bad_content' });
    expect(h.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('503 busy on commit is retried a little later; still busy surfaces busy', async () => {
    const h = harness();
    uploadRoutes(h, () => []);
    let n = 0;
    h.routes.set(`POST /avatars/v1/${CHAR}/commit`, () =>
      ++n < 3 ? { status: 503, body: { error: 'busy' } } : { status: 200, body: { avatar: { id: NEW_ID, rev: 'ab'.repeat(16) } } },
    );
    expect((await h.client.addPortrait(CHAR, pngHeader(8, 8), 'x')).ok).toBe(true);
    expect(n).toBe(3);
    expect(h.sleeps).toEqual([...COMMIT_BUSY_RETRY_MS]);
    // The same staging upload each time.
    const bodies = h.calls.filter((c) => c.path.endsWith('/commit')).map((c) => (c.body as { staging_path?: string }).staging_path);
    expect(bodies).toEqual(['staging/u/1', 'staging/u/1', 'staging/u/1']);

    const h2 = harness();
    uploadRoutes(h2, () => []);
    h2.routes.set(`POST /avatars/v1/${CHAR}/commit`, () => ({ status: 503, body: { error: 'busy' } }));
    expect(await h2.client.addPortrait(CHAR, pngHeader(8, 8), null)).toEqual({ ok: false, error: 'busy' });
    expect(h2.calls.filter((c) => c.path.endsWith('/commit'))).toHaveLength(1 + COMMIT_BUSY_RETRY_MS.length);
  });

  it('202 processing: looks for the row by hash in the owner list, then links the model', async () => {
    const h = harness();
    h.local.manifest = manifest();
    let avatars: unknown[] = [];
    let polls = 0;
    h.routes.set(`GET /avatars/v1/${CHAR}`, () => {
      polls++;
      return { status: 200, body: listBody({}, avatars) };
    });
    h.routes.set(`POST /avatars/v1/${CHAR}/upload`, () => ({
      status: 200,
      body: { state: 'upload', upload: { url: 'https://x.supabase.co/upload/sign/s', path: 'staging/u/1' } },
    }));
    h.routes.set(`POST /avatars/v1/${CHAR}/commit`, () => {
      // The background commit lands two polls later.
      const at = polls + 2;
      h.routes.set(`GET /avatars/v1/${CHAR}`, () => {
        polls++;
        if (polls >= at) avatars = [item(NEW_ID, { kind: 'live2d', sha256: sha256Hex(ZIP), rev: 'cd'.repeat(16), is_public: false })];
        return { status: 200, body: listBody({}, avatars) };
      });
      return { status: 202, body: { state: 'processing' } };
    });
    const r = await h.client.addLocalModel(CHAR);
    expect(r.ok).toBe(true);
    expect(h.sleeps).toEqual([COMMIT_POLL_MS, COMMIT_POLL_MS]);
    expect(h.local.manifest?.library).toEqual({ avatarId: NEW_ID, rev: 'cd'.repeat(16) });
  });

  it('202 processing that never shows up answers processing (nothing remembered as refused)', async () => {
    const h = harness();
    h.local.manifest = manifest();
    uploadRoutes(h, () => []);
    h.routes.set(`POST /avatars/v1/${CHAR}/commit`, () => ({ status: 202, body: { state: 'processing' } }));
    expect(await h.client.addLocalModel(CHAR)).toEqual({ ok: false, error: 'processing' });
    expect(h.sleeps).toHaveLength(COMMIT_POLLS);
    expect(h.skip.size).toBe(0);
    expect(h.events.find((e) => e.event === 'avatar_library_failed')?.props).toEqual({ op: 'upload', reason: 'processing' });
  });

  it('card row: 202 processing counts as rebuilt, busy is retried on the next sync quietly', async () => {
    const h = harness();
    h.card.v = { bytes: PNG, mime: 'image/png' };
    h.routes.set(`GET /avatars/v1/${CHAR}`, () => ({ status: 200, body: listBody({}, []) }));
    h.routes.set(`POST /avatars/v1/${CHAR}/commit`, () => ({ status: 202, body: { state: 'processing' } }));
    await h.client.sync(CHAR);
    // Rebuilt: the list is read again.
    expect(h.calls.filter((c) => c.method === 'GET')).toHaveLength(2);
    const h2 = harness();
    h2.card.v = { bytes: PNG, mime: 'image/png' };
    h2.routes.set(`GET /avatars/v1/${CHAR}`, () => ({ status: 200, body: listBody({}, []) }));
    h2.routes.set(`POST /avatars/v1/${CHAR}/commit`, () => ({ status: 503, body: { error: 'busy' } }));
    expect((await h2.client.sync(CHAR)).state).toBe('ready');
    expect(h2.events.filter((e) => e.event === 'avatar_library_failed')).toEqual([]);
  });
});
