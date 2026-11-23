import { mkdtemp, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { animaPackId, isAnimaPackId } from '../../shared/anima';
import { AnimaPackError, AnimaPackStore, sha256Hex, type SparePolicy } from './animaPacks';
import { AnimaClient, AnimaNoSession, CHECK_TTL_MS, type AnimaClientDeps, type ProxyReply } from './animaClient';

const CHAR = 'bbf5b66f-2f0f-4918-a953-a2cf66d5a586';
const NO_SPARE: SparePolicy = { count: 0, maxAgeMs: 0, maxBytes: 0 };
const MANIFEST = { format: 'sei-facepack', version: 1, character: 'Sui', canvas: [512, 768], expressions: { neutral: {} } };

async function packZip(files: Record<string, string | Uint8Array> = {}): Promise<Uint8Array> {
  const z = new JSZip();
  z.file('facepack.json', JSON.stringify(MANIFEST));
  z.file('frames/neutral/base.webp', new Uint8Array([1, 2, 3]));
  for (const [k, v] of Object.entries(files)) z.file(k, v);
  return z.generateAsync({ type: 'uint8array', compression: 'STORE' });
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'anima-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('AnimaPackStore', () => {
  it('installs a verified pack and serves its files', async () => {
    const store = new AnimaPackStore(() => root);
    const zip = await packZip();
    const sha = sha256Hex(zip);
    const r = await store.install(zip, sha);
    expect(r.id).toBe(animaPackId(sha));
    expect(isAnimaPackId(r.id)).toBe(true);
    expect(r.files).toBe(2);
    expect((await store.manifest(r.id))?.character).toBe('Sui');
    expect(await store.filePath(r.id, 'frames/neutral/base.webp')).toBe(path.join(root, 'packs', r.id, 'frames/neutral/base.webp'));
    expect(await store.filePath(r.id, '../index.json')).toBeNull();
    expect(await store.filePath(r.id, 'frames/missing.webp')).toBeNull();
    // A second install of the same bytes is a no-op.
    expect((await store.install(zip, sha)).files).toBe(0);
  });

  it('installs a pack format 2 archive (AVIF frames, 261124)', async () => {
    const store = new AnimaPackStore(() => root);
    const zip = await packZip({ 'frames/neutral/c.avif': new Uint8Array([4, 5]), 'frames/neutral/c_eyes_half.avif': new Uint8Array([6]) });
    const r = await store.install(zip, sha256Hex(zip));
    expect(r.files).toBe(4);
    expect(await store.filePath(r.id, 'frames/neutral/c.avif')).toBe(path.join(root, 'packs', r.id, 'frames/neutral/c.avif'));
  });

  it('refuses a hash mismatch, unsafe entries and a pack without a manifest', async () => {
    const store = new AnimaPackStore(() => root);
    const zip = await packZip();
    await expect(store.install(zip, 'f'.repeat(64))).rejects.toMatchObject({ code: 'hash_mismatch' });

    const evil = new JSZip();
    evil.file('facepack.json', JSON.stringify(MANIFEST));
    evil.file('frames\\escape.webp', new Uint8Array([1]));
    const evilZip = await evil.generateAsync({ type: 'uint8array' });
    await expect(store.install(evilZip, sha256Hex(evilZip))).rejects.toBeInstanceOf(AnimaPackError);

    const exe = await packZip({ 'run.exe': 'x' });
    await expect(store.install(exe, sha256Hex(exe))).rejects.toMatchObject({ code: 'bad_entry' });

    const bare = new JSZip();
    bare.file('frames/a.webp', new Uint8Array([1]));
    const bareZip = await bare.generateAsync({ type: 'uint8array' });
    await expect(store.install(bareZip, sha256Hex(bareZip))).rejects.toMatchObject({ code: 'no_manifest' });

    const badManifest = new JSZip();
    badManifest.file('facepack.json', '{"format":"other"}');
    const bmZip = await badManifest.generateAsync({ type: 'uint8array' });
    await expect(store.install(bmZip, sha256Hex(bmZip))).rejects.toMatchObject({ code: 'no_manifest' });

    // Nothing half-written was left behind.
    const left = await readdir(path.join(root, 'packs')).catch(() => []);
    expect(left).toEqual([]);
  });

  it('maps characters to packs and prunes the rest', async () => {
    const store = new AnimaPackStore(() => root);
    const a = await packZip();
    const b = await packZip({ 'frames/extra.webp': new Uint8Array([9]) });
    const ia = await store.install(a, sha256Hex(a));
    const ib = await store.install(b, sha256Hex(b));
    await store.setEntry(CHAR, { pack_sha256: sha256Hex(b), portrait_hash: 'p', portrait_ref: 'r', checked_at: 1 });
    expect(await store.packIdFor(CHAR)).toBe(ib.id);
    await mkdir(path.join(root, 'packs', '.tmp-an-leftover'), { recursive: true });
    await writeFile(path.join(root, 'packs', 'unrelated.txt'), 'x');
    expect(await store.prune(false, NO_SPARE)).toBe(1);
    expect(await store.hasPack(ia.id)).toBe(false);
    expect(await store.prune(true, NO_SPARE)).toBe(1);
    expect((await readdir(path.join(root, 'packs'))).sort()).toEqual([ib.id, 'unrelated.txt'].sort());
    // The index survives a reload.
    const again = new AnimaPackStore(() => root);
    expect((await again.entry(CHAR))?.portrait_ref).toBe('r');
  });
});

// ── AnimaClient ─────────────────────────────────────────────────────────────

interface Harness {
  client: AnimaClient;
  store: AnimaPackStore;
  calls: Array<{ method: string; path: string }>;
  bodies: unknown[];
  events: Array<Record<string, unknown>>;
  statuses: string[];
  /** 261106: every stage push (onProgress), as `stage` or `stage:failure`. */
  stages: string[];
  ready: string[];
  timers: Array<{ fn: () => Promise<void> | void; ms: number }>;
  replies: Array<ProxyReply | { status: number; body: unknown } | Error>;
  clock: { t: number };
  /** 261124: how many downloads were started. */
  downloads: number;
  set(
    o: Partial<{
      online: boolean;
      ref: string | null | undefined;
      zip: Uint8Array;
      avatar: { avatarId: string; rev: string } | null;
      /** A download waits for this before it answers. */
      gate: Promise<void> | null;
    }>,
  ): void;
  /** Run the next timer. */
  tick(): Promise<void>;
}

async function harness(): Promise<Harness> {
  const store = new AnimaPackStore(() => root);
  const h: Partial<Harness> = { calls: [], bodies: [], events: [], statuses: [], stages: [], ready: [], timers: [], replies: [], clock: { t: 1_000_000 }, downloads: 0 };
  const opts = {
    online: true,
    ref: 'sui.png|t1|1' as string | null | undefined,
    zip: await packZip(),
    avatar: null as { avatarId: string; rev: string } | null,
    gate: null as Promise<void> | null,
  };
  h.set = (o) => Object.assign(opts, o);
  const deps: AnimaClientDeps = {
    api: async (method, p, body) => {
      h.calls!.push({ method, path: p });
      h.bodies!.push(body);
      const r = h.replies!.shift();
      if (!r) throw new Error('no reply queued');
      if (r instanceof Error) throw r;
      if ('status' in r && typeof (r as { status: unknown }).status === 'number') return r as { status: number; body: unknown };
      return { status: 200, body: r };
    },
    online: () => opts.online,
    download: async () => {
      h.downloads!++;
      const zip = opts.zip;
      if (opts.gate) await opts.gate;
      return zip;
    },
    store,
    portraitRef: async () => opts.ref,
    avatarFor: async () => opts.avatar,
    capture: (_e, props) => h.events!.push(props),
    onReady: (id) => h.ready!.push(id),
    onStatus: (s) => h.statuses!.push(s.state),
    onProgress: (s) => h.stages!.push(s.failure ? `${s.stage}:${s.failure}` : String(s.stage)),
    now: () => h.clock!.t,
    setTimeout: (fn, ms) => {
      const t = { fn, ms };
      h.timers!.push(t);
      return t;
    },
    clearTimeout: (t) => {
      const i = h.timers!.indexOf(t as { fn: () => Promise<void> | void; ms: number });
      if (i >= 0) h.timers!.splice(i, 1);
    },
  };
  h.client = new AnimaClient(deps);
  h.store = store;
  h.tick = async () => {
    const t = h.timers!.shift();
    if (!t) throw new Error('no timer');
    h.clock!.t += t.ms;
    await t.fn();
  };
  return h as Harness;
}

function readyReply(zip: Uint8Array, portrait = 'p1'): ProxyReply {
  return { state: 'ready', portrait_hash: portrait, pack: { url: 'https://x.supabase.co/sign/pack.zip', sha256: sha256Hex(zip), bytes: zip.byteLength, expires_in: 3600 } };
}

describe('AnimaClient', () => {
  it('requests, polls a running bake, installs the pack and tells the views', async () => {
    const h = await harness();
    const zip = await packZip();
    h.set({ zip });
    h.replies.push({ state: 'queued', portrait_hash: 'p1', created: true });
    const s = await h.client.prepare(CHAR, 'host_start');
    expect(s.state).toBe('preparing');
    expect(h.calls).toEqual([{ method: 'POST', path: '/anima/v1/request' }]);
    expect(h.bodies[0]).toEqual({ character_id: CHAR, pack_format: 2 });
    expect(h.timers[0].ms).toBe(4_000);

    h.replies.push({ state: 'running', portrait_hash: 'p1' });
    await h.tick();
    expect(h.calls[1]).toEqual({ method: 'GET', path: `/anima/v1/status/${CHAR}?pack_format=2` });

    h.replies.push(readyReply(zip));
    await h.tick();
    expect(h.client.status(CHAR).state).toBe('ready');
    expect(h.ready).toEqual([CHAR]);
    expect(await h.store.packIdFor(CHAR)).toBe(animaPackId(sha256Hex(zip)));
    expect(h.statuses).toEqual(['preparing', 'ready']);
    const phases = h.events.map((e) => e.phase);
    expect(phases).toEqual(['requested', 'ready']);
    expect(h.events[0]).toMatchObject({ trigger: 'host_start', state: 'queued', created: true, fetch: true });
    expect(h.events[1]).toMatchObject({ from_cache: false, source: 'baked', wait_ms: 8_000, bytes: zip.byteLength, pack_format: 1 });
    expect(h.timers).toEqual([]);
  });

  it('reports each stage of a bake (the WorldLink intro paces its lines on them)', async () => {
    const h = await harness();
    const zip = await packZip();
    h.set({ zip });
    h.replies.push({ state: 'queued', portrait_hash: 'p1', created: true });
    const pending = h.client.prepare(CHAR, 'editor');
    // Before the first await: a caller reading status() right away sees this run.
    expect(h.client.status(CHAR).stage).toBe('checking');
    await pending;
    expect(h.client.status(CHAR)).toMatchObject({ state: 'preparing', stage: 'queued' });
    h.replies.push({ state: 'running', portrait_hash: 'p1' });
    await h.tick();
    h.replies.push(readyReply(zip));
    await h.tick();
    expect(h.stages).toEqual(['checking', 'requesting', 'queued', 'running', 'downloading', 'ready']);
    // A second open with the pack on disk: checking, then ready (no network).
    h.stages.length = 0;
    await h.client.prepare(CHAR, 'host_start');
    expect(h.stages).toEqual(['checking', 'ready']);
  });

  it('ends a stage run with how it failed, or unavailable when no pack will come', async () => {
    const h = await harness();
    h.replies.push({ state: 'queued', portrait_hash: 'p1' });
    await h.client.prepare(CHAR, 'move_in_sheet');
    h.replies.push({ state: 'failed', portrait_hash: 'p1' });
    await h.tick();
    expect(h.client.status(CHAR)).toMatchObject({ stage: 'failed', failure: 'bake_failed' });

    h.replies.push({ state: 'deferred', reason: 'user_cap', portrait_hash: 'p1' });
    await h.client.prepare(CHAR, 'host_start');
    expect(h.client.status(CHAR).stage).toBe('unavailable');
    expect(h.client.status(CHAR).failure).toBeUndefined();

    h.replies.push(new Error('ECONNRESET'));
    await h.client.prepare(CHAR, 'host_start');
    expect(h.client.status(CHAR)).toMatchObject({ stage: 'failed', failure: 'network' });

    h.replies.push({ status: 500, body: { error: 'x' } });
    await h.client.prepare(CHAR, 'host_start');
    expect(h.client.status(CHAR)).toMatchObject({ stage: 'failed', failure: 'http' });

    h.set({ online: false });
    await h.client.prepare(CHAR, 'host_start');
    expect(h.client.status(CHAR).stage).toBe('offline');

    h.client.reset();
    expect(h.client.status(CHAR).stage).toBeUndefined();
  });

  it('uses the pack on disk without the network while her portrait is unchanged', async () => {
    const h = await harness();
    const zip = await packZip();
    h.set({ zip });
    h.replies.push(readyReply(zip));
    await h.client.prepare(CHAR, 'host_start');
    expect(h.events.at(-1)).toMatchObject({ phase: 'ready', from_cache: true, source: 'cloud_cache' });
    h.calls.length = 0;

    await h.client.prepare(CHAR, 'editor');
    expect(h.calls).toEqual([]);
    expect(h.client.status(CHAR).state).toBe('ready');

    // Stale check, or a new portrait: ask again.
    h.clock.t += CHECK_TTL_MS + 1;
    h.replies.push(readyReply(zip));
    await h.client.prepare(CHAR, 'editor');
    expect(h.calls).toHaveLength(1);
    expect(h.ready).toEqual([CHAR]); // same pack: no second re-resolve
  });

  it('does nothing offline or signed out, and keeps quiet on final verdicts', async () => {
    const h = await harness();
    h.set({ online: false });
    expect((await h.client.prepare(CHAR, 'move_in_sheet')).state).toBe('idle');
    expect(h.calls).toEqual([]);
    expect(h.events).toEqual([{ phase: 'skipped', reason: 'offline', trigger: 'move_in_sheet' }]);

    h.set({ online: true });
    h.replies.push(new AnimaNoSession());
    expect((await h.client.prepare(CHAR, 'move_in_sheet')).state).toBe('idle');
    expect(h.events.at(-1)).toMatchObject({ phase: 'skipped', reason: 'signed_out' });

    h.replies.push({ state: 'no_pack', portrait_hash: 'p1' });
    expect((await h.client.prepare(CHAR, 'editor')).state).toBe('idle');
    expect(h.events.at(-1)).toMatchObject({ phase: 'no_pack', trigger: 'editor' });

    h.replies.push({ state: 'deferred', reason: 'budget', portrait_hash: 'p1' });
    await h.client.prepare(CHAR, 'host_start');
    expect(h.events.at(-1)).toMatchObject({ phase: 'deferred', reason: 'budget' });

    h.replies.push({ status: 404, body: { error: 'not_found' } });
    await h.client.prepare(CHAR, 'host_restore');
    expect(h.events.at(-1)).toMatchObject({ phase: 'unavailable', reason: 'not_found' });
    expect(h.statuses).toEqual([]);
    expect(h.timers).toEqual([]);
    expect(h.ready).toEqual([]);
  });

  it('a pack whose sha256 does not match is not installed', async () => {
    const h = await harness();
    const zip = await packZip();
    h.set({ zip });
    h.replies.push({ ...readyReply(zip), pack: { ...readyReply(zip).pack!, sha256: 'a'.repeat(64) } });
    await h.client.prepare(CHAR, 'host_start');
    // The bytes came over the network even though they were refused.
    expect(h.events.at(-1)).toMatchObject({ phase: 'failed', reason: 'hash_mismatch', bytes: zip.byteLength });
    expect(await h.store.packIdFor(CHAR)).toBeNull();
    expect(h.ready).toEqual([]);
  });

  it('keeps polling through network blips, backs off on 429, and stops at reset', async () => {
    const h = await harness();
    h.replies.push({ state: 'queued', portrait_hash: 'p1' });
    await h.client.prepare(CHAR, 'move_in_sheet');
    h.replies.push(new Error('ECONNRESET'));
    await h.tick();
    expect(h.timers).toHaveLength(1);
    h.replies.push({ status: 429, body: { error: 'rate_limited' } });
    await h.tick();
    expect(h.timers[0].ms).toBe(60_000);
    h.client.reset();
    expect(h.timers).toEqual([]);
    expect(h.client.status(CHAR).state).toBe('idle');
  });

  it('a portrait edit re-checks until the cloud has the new portrait', async () => {
    const h = await harness();
    const zipA = await packZip();
    h.set({ zip: zipA });
    h.replies.push(readyReply(zipA, 'old'));
    await h.client.prepare(CHAR, 'host_start');
    expect(h.ready).toEqual([CHAR]);

    h.set({ ref: 'sui.png|t1|2' });
    await h.client.portraitMaybeChanged(CHAR);
    expect(h.timers).toHaveLength(1);
    // First look: the cloud row still has the old portrait.
    h.replies.push(readyReply(zipA, 'old'));
    await h.tick();
    expect(h.timers).toHaveLength(1);
    // Then the new portrait is being baked, then it is ready.
    h.replies.push({ state: 'queued', portrait_hash: 'new' });
    await h.tick();
    const zipB = await packZip({ 'frames/b.webp': new Uint8Array([7]) });
    h.set({ zip: zipB });
    h.replies.push(readyReply(zipB, 'new'));
    await h.tick();
    expect(h.ready).toEqual([CHAR, CHAR]);
    expect(await h.store.packIdFor(CHAR)).toBe(animaPackId(sha256Hex(zipB)));
    expect((await h.store.entry(CHAR))?.portrait_ref).toBe('sui.png|t1|2');
    // The prune after a delay keeps the old pack as a spare (261124): switching back needs no download.
    expect(h.timers).toHaveLength(1);
    await h.tick();
    expect(await h.store.hasPack(animaPackId(sha256Hex(zipA)))).toBe(true);
    expect(await h.store.prune(false, NO_SPARE)).toBe(1);
    expect(await h.store.hasPack(animaPackId(sha256Hex(zipA)))).toBe(false);
  });

  it('a new portrait with no pack drops her old face set', async () => {
    const h = await harness();
    const zip = await packZip();
    h.set({ zip });
    h.replies.push(readyReply(zip, 'old'));
    await h.client.prepare(CHAR, 'host_start');
    h.set({ ref: 'sui.png|t2|3' });
    h.replies.push({ state: 'no_pack', portrait_hash: 'new' });
    await h.client.prepare(CHAR, 'editor');
    expect(await h.store.packIdFor(CHAR)).toBeNull();
    expect(h.client.status(CHAR).state).toBe('idle');
    expect(h.ready).toEqual([CHAR, CHAR]);
  });

  it('reports what a view showed once per kind and surface', async () => {
    const h = await harness();
    h.client.noteShown(CHAR, 'portrait', 'desktop');
    h.client.noteShown(CHAR, 'portrait', 'desktop');
    h.client.noteShown(CHAR, 'facepack', 'desktop');
    h.client.noteShown('not-a-uuid', 'facepack', 'desktop');
    h.client.noteShown(CHAR, 'live2d', 'editor', { l2d_ids: 'standard', l2d_mouth: true });
    expect(h.events).toEqual([
      { phase: 'shown', avatar_kind: 'portrait', surface: 'desktop', anima_state: 'idle' },
      { phase: 'shown', avatar_kind: 'facepack', surface: 'desktop', anima_state: 'idle' },
      { phase: 'shown', avatar_kind: 'live2d', surface: 'editor', anima_state: 'idle', l2d_ids: 'standard', l2d_mouth: true },
    ]);
  });

  it('ignores ids that are not cloud uuids', async () => {
    const h = await harness();
    await h.client.prepare('local-only', 'editor');
    expect(h.calls).toEqual([]);
  });
});

describe('AnimaClient per-avatar bakes (261106)', () => {
  // `rev` is the row's opaque content tag (not its hash, which non-owners never get).
  const AV1 = { avatarId: '11111111-2222-4333-8444-555555555555', rev: 'a'.repeat(32) };
  const AV2 = { avatarId: '66666666-7777-4888-8999-000000000000', rev: 'b'.repeat(32) };
  const H1 = 'a'.repeat(64);
  const H2 = 'b'.repeat(64);

  it('asks for the library avatar that plays and re-asks when it changes', async () => {
    const h = await harness();
    const zip = await packZip();
    h.set({ zip, avatar: AV1 });
    h.replies.push({ state: 'queued', portrait_hash: H1, created: true });
    await h.client.prepare(CHAR, 'editor');
    expect(h.bodies[0]).toEqual({ character_id: CHAR, avatar_id: AV1.avatarId, pack_format: 2 });
    h.replies.push(readyReply(zip, H1));
    await h.tick();
    expect(h.calls[1]).toEqual({ method: 'GET', path: `/anima/v1/status/${CHAR}?avatar_id=${AV1.avatarId}&pack_format=2` });
    expect((await h.store.entry(CHAR))?.portrait_ref).toBe(`avatar:${AV1.avatarId}:${AV1.rev}`);

    // Same avatar: nothing to ask.
    h.calls.length = 0;
    await h.client.avatarChanged(CHAR);
    expect(h.calls).toEqual([]);

    // The owner made another portrait the default: asked right away, for that one.
    h.set({ avatar: AV2 });
    const zip2 = await packZip({ 'frames/extra.webp': new Uint8Array([7]) });
    h.set({ zip: zip2 });
    h.replies.push(readyReply(zip2, H2));
    await h.client.avatarChanged(CHAR);
    expect(h.bodies.at(-1)).toEqual({ character_id: CHAR, avatar_id: AV2.avatarId, pack_format: 2 });
    expect(await h.store.packIdFor(CHAR)).toBe(animaPackId(sha256Hex(zip2)));
  });

  it('falls back to the per-character request without a library avatar', async () => {
    const h = await harness();
    h.set({ avatar: null });
    h.replies.push({ state: 'no_pack', portrait_hash: 'p1', reason: 'qc' });
    await h.client.prepare(CHAR, 'editor');
    expect(h.bodies[0]).toEqual({ character_id: CHAR, pack_format: 2 });
  });
});

// ── cloud cut-outs (261118) ─────────────────────────────────────────────────

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 1, 2, 3]);
const PNG2 = new Uint8Array([...PNG, 4]);

function cutoutReply(png: Uint8Array, portrait = 'p1'): ProxyReply {
  return { state: 'no_pack', portrait_hash: portrait, cutout: { url: 'https://x.supabase.co/sign/cutout.png', sha256: sha256Hex(png), bytes: png.byteLength, expires_in: 3600 } };
}

describe('AnimaPackStore cut-outs (261118)', () => {
  it('stores a verified PNG, keeps its own index map, and prunes unused ones', async () => {
    const store = new AnimaPackStore(() => root);
    await expect(store.installCutout(PNG, 'f'.repeat(64))).rejects.toMatchObject({ code: 'hash_mismatch' });
    const notPng = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    await expect(store.installCutout(notPng, sha256Hex(notPng))).rejects.toMatchObject({ code: 'bad_image' });
    expect((await store.installCutout(PNG, sha256Hex(PNG))).bytes).toBe(PNG.byteLength);
    expect((await store.installCutout(PNG, sha256Hex(PNG))).bytes).toBe(0);
    await store.installCutout(PNG2, sha256Hex(PNG2));
    await store.setCutoutEntry(CHAR, { sha256: sha256Hex(PNG2), portrait_hash: 'p', portrait_ref: 'r', checked_at: 1 });
    expect((await store.cutoutFileFor(CHAR))?.path).toBe(path.join(root, 'cutouts', `${sha256Hex(PNG2)}.png`));
    // Never a pack: packIdFor and the old `characters` map know nothing of it.
    expect(await store.packIdFor(CHAR)).toBeNull();
    expect(await store.entry(CHAR)).toBeNull();
    await writeFile(path.join(root, 'cutouts', '.tmp-leftover'), 'x');
    expect(await store.prune()).toBe(1);
    expect(await store.hasCutout(sha256Hex(PNG))).toBe(false);
    expect(await store.prune(true)).toBe(1);
    expect(await readdir(path.join(root, 'cutouts'))).toEqual([`${sha256Hex(PNG2)}.png`]);
    // Survives a reload; an index written by a build without cut-outs still loads.
    expect((await new AnimaPackStore(() => root).cutoutEntry(CHAR))?.portrait_ref).toBe('r');
    await writeFile(path.join(root, 'index.json'), JSON.stringify({ version: 1, characters: {} }));
    expect(await new AnimaPackStore(() => root).cutoutEntry(CHAR)).toBeNull();
  });
});

describe('AnimaClient cut-outs (261118)', () => {
  it('no_pack with a cut-out downloads it, tells the views, and serves it while her picture is the same', async () => {
    const h = await harness();
    h.set({ zip: PNG });
    h.replies.push(cutoutReply(PNG));
    await h.client.prepare(CHAR, 'host_start');
    expect(h.ready).toEqual([CHAR]);
    expect(h.client.status(CHAR)).toMatchObject({ state: 'idle', stage: 'unavailable' });
    expect(await h.store.packIdFor(CHAR)).toBeNull();
    const cut = await h.client.cutoutFor(CHAR);
    expect(cut?.sha256).toBe(sha256Hex(PNG));
    expect(h.events.map((e) => e.phase)).toEqual(['requested', 'cutout']);
    expect(h.events[1]).toMatchObject({ trigger: 'host_start', source: 'cloud_cache', cutout_kb: 0, bytes: PNG.byteLength });
    // The same answer next time: nothing new for the views.
    h.replies.push(cutoutReply(PNG));
    await h.client.prepare(CHAR, 'editor');
    expect(h.ready).toEqual([CHAR]);
    // A new picture: the old cut-out is not hers any more.
    h.set({ ref: 'sui.png|t2|9' });
    expect(await h.client.cutoutFor(CHAR)).toBeNull();
  });

  it('a bad cut-out is a failure event and nothing is stored', async () => {
    const h = await harness();
    const bad = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    h.set({ zip: bad });
    h.replies.push(cutoutReply(bad));
    await h.client.prepare(CHAR, 'editor');
    expect(h.ready).toEqual([]);
    expect(await h.client.cutoutFor(CHAR)).toBeNull();
    expect(h.events.at(-1)).toMatchObject({ phase: 'failed', reason: 'cutout_bad_image' });
  });

  it('a face set replaces the cut-out, and a cut-out for a new picture replaces an old face set', async () => {
    const h = await harness();
    h.set({ zip: PNG });
    h.replies.push(cutoutReply(PNG, 'a'));
    await h.client.prepare(CHAR, 'editor');
    const zip = await packZip();
    h.set({ zip, ref: 'sui.png|t2|1' });
    h.replies.push(readyReply(zip, 'b'));
    await h.client.prepare(CHAR, 'editor');
    expect(await h.store.cutoutEntry(CHAR)).toBeNull();
    expect(await h.store.packIdFor(CHAR)).toBe(animaPackId(sha256Hex(zip)));
    h.set({ zip: PNG2, ref: 'sui.png|t3|1' });
    h.replies.push(cutoutReply(PNG2, 'c'));
    await h.client.prepare(CHAR, 'editor');
    expect(await h.store.packIdFor(CHAR)).toBeNull();
    expect((await h.client.cutoutFor(CHAR))?.sha256).toBe(sha256Hex(PNG2));
    expect(h.ready).toEqual([CHAR, CHAR, CHAR]);
  });

  it('a plain no_pack for another picture drops her old cut-out', async () => {
    const h = await harness();
    h.set({ zip: PNG });
    h.replies.push(cutoutReply(PNG, 'a'));
    await h.client.prepare(CHAR, 'editor');
    h.set({ ref: 'sui.png|t2|2' });
    h.replies.push({ state: 'no_pack', portrait_hash: 'b' });
    await h.client.prepare(CHAR, 'editor');
    expect(await h.store.cutoutEntry(CHAR)).toBeNull();
    expect(h.ready).toEqual([CHAR, CHAR]);
  });
});

// ── only what is needed (261124, storage egress) ───────────────────────────

describe('AnimaClient downloads only what is needed (261124)', () => {
  it('the move-in sheet bakes but downloads nothing; her host starting downloads it', async () => {
    const h = await harness();
    const zip = await packZip();
    h.set({ zip });
    h.replies.push({ state: 'queued', portrait_hash: 'p1', created: true });
    await h.client.prepare(CHAR, 'move_in_sheet');
    expect(h.events[0]).toMatchObject({ phase: 'requested', trigger: 'move_in_sheet', fetch: false });
    h.replies.push(readyReply(zip));
    await h.tick();
    expect(h.downloads).toBe(0);
    expect(await h.store.packIdFor(CHAR)).toBeNull();
    expect(h.events.at(-1)).toMatchObject({ phase: 'held', trigger: 'move_in_sheet', skipped_bytes: zip.byteLength });
    // Nothing is on its way: no stage, idle, no run left.
    expect(h.client.status(CHAR)).toEqual({ characterId: CHAR, state: 'idle' });
    expect(h.client.inFlight(CHAR)).toBe(false);
    expect(h.ready).toEqual([]);

    // She moves in: the pack is downloaded now.
    h.replies.push(readyReply(zip));
    await h.client.prepare(CHAR, 'host_start');
    expect(h.downloads).toBe(1);
    expect(await h.store.packIdFor(CHAR)).toBe(animaPackId(sha256Hex(zip)));
    expect(h.events.at(-1)).toMatchObject({ phase: 'ready', trigger: 'host_start', bytes: zip.byteLength });
    expect(h.ready).toEqual([CHAR]);
  });

  it('a sheet run still baking is upgraded when her host starts', async () => {
    const h = await harness();
    const zip = await packZip();
    h.set({ zip });
    h.replies.push({ state: 'queued', portrait_hash: 'p1' });
    await h.client.prepare(CHAR, 'move_in_sheet');
    // The host start joins the live run (no second request).
    await h.client.prepare(CHAR, 'host_start');
    expect(h.calls).toHaveLength(1);
    h.replies.push(readyReply(zip));
    await h.tick();
    expect(h.downloads).toBe(1);
    expect(await h.store.packIdFor(CHAR)).toBe(animaPackId(sha256Hex(zip)));
    expect(h.events.map((e) => e.phase)).toEqual(['requested', 'ready']);
  });

  it('a sheet run does not download a cut-out either', async () => {
    const h = await harness();
    h.set({ zip: PNG });
    h.replies.push(cutoutReply(PNG));
    await h.client.prepare(CHAR, 'move_in_sheet');
    expect(h.downloads).toBe(0);
    expect(await h.client.cutoutFor(CHAR)).toBeNull();
    expect(h.events.at(-1)).toMatchObject({ phase: 'held', skipped_bytes: PNG.byteLength });
    h.replies.push(cutoutReply(PNG));
    await h.client.prepare(CHAR, 'editor');
    expect(h.downloads).toBe(1);
    expect((await h.client.cutoutFor(CHAR))?.sha256).toBe(sha256Hex(PNG));
  });

  it('a look already on disk is kept current from the sheet too', async () => {
    const h = await harness();
    const zipA = await packZip();
    h.set({ zip: zipA });
    h.replies.push(readyReply(zipA, 'old'));
    await h.client.prepare(CHAR, 'host_start');
    h.client.reset();
    // A new portrait, next app run: the sheet re-asks and downloads (she is already in use).
    h.set({ ref: 'sui.png|t2|1' });
    const zipB = await packZip({ 'frames/b.webp': new Uint8Array([7]) });
    h.set({ zip: zipB });
    h.replies.push(readyReply(zipB, 'new'));
    await h.client.prepare(CHAR, 'move_in_sheet');
    expect(h.downloads).toBe(2);
    expect(await h.store.packIdFor(CHAR)).toBe(animaPackId(sha256Hex(zipB)));
  });

  it('a restarted run waits for the download in flight instead of starting another', async () => {
    const h = await harness();
    const zip = await packZip();
    let open!: () => void;
    h.set({ zip, gate: new Promise<void>((r) => (open = r)) });
    h.replies.push(readyReply(zip));
    const first = h.client.prepare(CHAR, 'host_start');
    // Let the first run reach its download.
    // (time-based: the store reads real files, which can take many ticks on a loaded machine)
    for (let i = 0; i < 500 && h.downloads === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(h.downloads).toBe(1);
    // Her avatar changed mid-download: the run restarts and gets the same pack.
    h.set({ avatar: { avatarId: '7f0c7e52-6a62-4f3e-9d0e-3f1b1d2a9c11', rev: 'a'.repeat(16) } });
    h.replies.push(readyReply(zip));
    const second = h.client.avatarChanged(CHAR);
    // Give the restarted run time to reach the download and join it (if it arrives after, the pack is on disk: no download either way).
    await new Promise((r) => setTimeout(r, 150));
    open();
    await Promise.all([first, second]);
    expect(h.downloads).toBe(1);
    expect(await h.store.packIdFor(CHAR)).toBe(animaPackId(sha256Hex(zip)));
  });

  it('downloads the smaller encoding, or uses the older one already on disk', async () => {
    const h = await harness();
    const v1 = await packZip();
    const v2 = await packZip({ 'frames/neutral/c.avif': new Uint8Array([5]) });
    // An older build downloaded v1.
    await h.store.install(v1, sha256Hex(v1));
    const both: ProxyReply = {
      state: 'ready',
      portrait_hash: 'p1',
      pack: { url: 'https://x.supabase.co/sign/pack2.zip', sha256: sha256Hex(v2), bytes: v2.byteLength, expires_in: 3600, format: 2, alt_sha256: [sha256Hex(v1)] },
    };
    h.set({ zip: v2 });
    h.replies.push(both);
    await h.client.prepare(CHAR, 'host_start');
    expect(h.downloads).toBe(0);
    expect(await h.store.packIdFor(CHAR)).toBe(animaPackId(sha256Hex(v1)));
    expect(h.events.at(-1)).toMatchObject({ phase: 'ready', source: 'disk', bytes: 0, pack_format: 'alt' });

    // Another character with nothing on disk gets v2.
    const OTHER = '0b3c1b2e-5a3c-4c8e-9a4b-2f6d7e8f9a0b';
    await h.store.prune(false, NO_SPARE);
    h.replies.push({ ...both });
    const store2 = new AnimaPackStore(() => path.join(root, 'two'));
    expect(await store2.hasPack(animaPackId(sha256Hex(v1)))).toBe(false);
    await h.client.prepare(OTHER, 'host_start');
    expect(h.downloads).toBe(0); // v1 is still hers: the shared store already has an encoding of this pack
  });
});

describe('AnimaPackStore spares (261124)', () => {
  it('keeps the newest released packs within count, age and size, and drops the rest', async () => {
    const store = new AnimaPackStore(() => root);
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const z = await packZip({ [`frames/x${i}.webp`]: new Uint8Array([i]) });
      ids.push((await store.install(z, sha256Hex(z))).id);
    }
    const { utimes } = await import('node:fs/promises');
    const now = 10_000_000_000_000;
    // Released at now-4h, now-3h, now-2h, and one 40 days ago.
    const ages = [4, 3, 2, 40 * 24];
    for (let i = 0; i < 4; i++) {
      const t = new Date(now - ages[i] * 3600_000);
      await utimes(path.join(root, 'packs', ids[i]), t, t);
    }
    expect(await store.prune(false, { count: 2, maxAgeMs: 30 * 86_400_000, maxBytes: 1e9 }, now)).toBe(2);
    expect(await store.hasPack(ids[0])).toBe(false);
    expect(await store.hasPack(ids[1])).toBe(true);
    expect(await store.hasPack(ids[2])).toBe(true);
    expect(await store.hasPack(ids[3])).toBe(false);
    // A size cap below one pack's guess keeps none.
    expect(await store.prune(false, { count: 4, maxAgeMs: 30 * 86_400_000, maxBytes: 1 }, now)).toBe(2);
  });

  it('a pack she leaves is marked as just released', async () => {
    const store = new AnimaPackStore(() => root);
    const a = await packZip();
    const ia = await store.install(a, sha256Hex(a));
    const old = new Date(Date.now() - 60 * 86_400_000);
    const { utimes } = await import('node:fs/promises');
    await utimes(path.join(root, 'packs', ia.id), old, old);
    await store.setEntry(CHAR, { pack_sha256: sha256Hex(a), portrait_hash: 'p', portrait_ref: 'r', checked_at: 1 });
    await store.setEntry(CHAR, null);
    // Released just now, so it is a fresh spare, not a 60-day-old one.
    expect(await store.prune()).toBe(0);
    expect(await store.hasPack(ia.id)).toBe(true);
  });
});
