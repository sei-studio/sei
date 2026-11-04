import { mkdtemp, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { animaPackId, isAnimaPackId } from '../../shared/anima';
import { AnimaPackError, AnimaPackStore, sha256Hex } from './animaPacks';
import { AnimaClient, AnimaNoSession, CHECK_TTL_MS, type AnimaClientDeps, type ProxyReply } from './animaClient';

const CHAR = 'bbf5b66f-2f0f-4918-a953-a2cf66d5a586';
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
    expect(await store.prune()).toBe(1);
    expect(await store.hasPack(ia.id)).toBe(false);
    expect(await store.prune(true)).toBe(1);
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
  events: Array<Record<string, unknown>>;
  statuses: string[];
  ready: string[];
  timers: Array<{ fn: () => Promise<void> | void; ms: number }>;
  replies: Array<ProxyReply | { status: number; body: unknown } | Error>;
  clock: { t: number };
  set(o: Partial<{ online: boolean; ref: string | null | undefined; zip: Uint8Array }>): void;
  /** Run the next timer. */
  tick(): Promise<void>;
}

async function harness(): Promise<Harness> {
  const store = new AnimaPackStore(() => root);
  const h: Partial<Harness> = { calls: [], events: [], statuses: [], ready: [], timers: [], replies: [], clock: { t: 1_000_000 } };
  const opts = { online: true, ref: 'sui.png|t1|1' as string | null | undefined, zip: await packZip() };
  h.set = (o) => Object.assign(opts, o);
  const deps: AnimaClientDeps = {
    api: async (method, p) => {
      h.calls!.push({ method, path: p });
      const r = h.replies!.shift();
      if (!r) throw new Error('no reply queued');
      if (r instanceof Error) throw r;
      if ('status' in r && typeof (r as { status: unknown }).status === 'number') return r as { status: number; body: unknown };
      return { status: 200, body: r };
    },
    online: () => opts.online,
    download: async () => opts.zip,
    store,
    portraitRef: async () => opts.ref,
    capture: (_e, props) => h.events!.push(props),
    onReady: (id) => h.ready!.push(id),
    onStatus: (s) => h.statuses!.push(s.state),
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
    const s = await h.client.prepare(CHAR, 'move_in_sheet');
    expect(s.state).toBe('preparing');
    expect(h.calls).toEqual([{ method: 'POST', path: '/anima/v1/request' }]);
    expect(h.timers[0].ms).toBe(10_000);

    h.replies.push({ state: 'running', portrait_hash: 'p1' });
    await h.tick();
    expect(h.calls[1]).toEqual({ method: 'GET', path: `/anima/v1/status/${CHAR}` });

    h.replies.push(readyReply(zip));
    await h.tick();
    expect(h.client.status(CHAR).state).toBe('ready');
    expect(h.ready).toEqual([CHAR]);
    expect(await h.store.packIdFor(CHAR)).toBe(animaPackId(sha256Hex(zip)));
    expect(h.statuses).toEqual(['preparing', 'ready']);
    const phases = h.events.map((e) => e.phase);
    expect(phases).toEqual(['requested', 'ready']);
    expect(h.events[0]).toMatchObject({ trigger: 'move_in_sheet', state: 'queued', created: true });
    expect(h.events[1]).toMatchObject({ from_cache: false, source: 'baked', wait_ms: 20_000 });
    expect(h.timers).toEqual([]);
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
    await h.client.prepare(CHAR, 'move_in_sheet');
    expect(h.events.at(-1)).toMatchObject({ phase: 'failed', reason: 'hash_mismatch' });
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
    // The old pack goes after a delay.
    expect(h.timers).toHaveLength(1);
    await h.tick();
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
    expect(h.events).toEqual([
      { phase: 'shown', avatar_kind: 'portrait', surface: 'desktop', anima_state: 'idle' },
      { phase: 'shown', avatar_kind: 'facepack', surface: 'desktop', anima_state: 'idle' },
    ]);
  });

  it('ignores ids that are not cloud uuids', async () => {
    const h = await harness();
    await h.client.prepare('local-only', 'editor');
    expect(h.calls).toEqual([]);
  });
});
