/**
 * Avatar library client (261106): a character's server-stored avatars
 * (sei-proxy /avatars/v1), kept in step with this app. Design:
 * docs/agents/avatar-library.md. Wiring: avatarLibraryRuntime.ts.
 *
 *   view(id)        the list + the viewer's pick + what plays (cached 60 s)
 *   sync(id)        owner: ask the proxy to rebuild the card row when the
 *                   card hash changed (the proxy reads the card image itself;
 *                   no bytes go up), and upload a local Live2D/rig model with
 *                   no library link yet (the migration of existing local
 *                   models: uploaded private, never made the default or
 *                   public; this device picks it for the owner), then
 *                   ensure(). Anyone else: just ensure().
 *   ensure(id)      make the local avatar store match what plays: download a
 *                   public model once (other users' copies of a public
 *                   character never regenerate it), clear a library-backed
 *                   local model when a portrait plays instead. A row that
 *                   failed to import (or that the user removed locally) is
 *                   on the skip list and never downloaded again.
 *   animaAvatarFor  the portrait avatar Anima should bake for her (per
 *                   portrait hash, not per character), or null (old path).
 *
 * Writes (upload, setFlags, remove, setPick) answer AvatarLibraryResult with
 * a closed error code; the server enforces the public rule, the UI only
 * mirrors it. Nothing here throws to its caller. Uploads check the listed
 * byte caps and the image rules (avatarImage.ts) before anything goes up; a
 * model the server refused (too_big, bad_content, bad_kind) is remembered by
 * its zip hash so sync never sends the same bytes again. A commit answered
 * 503 busy is retried twice; 202 processing is followed by looking for the
 * row by hash in the owner list.
 *
 * Analytics, shape only (kinds, MB, counts, the character id): avatar_uploaded,
 * avatar_visibility_changed, avatar_default_changed, avatar_downloaded_shared,
 * avatar_library_failed.
 */
import { createHash } from 'node:crypto';
import type { AvatarManifest } from '../../shared/ipc';
import { avatarImageProblem, MAX_PORTRAIT_SIDE, sniffAvatarImage } from '../avatar/avatarImage';
import {
  effectiveAvatar,
  mbBucket,
  parseAvatarList,
  publicCount,
  type AvatarLibraryError,
  type AvatarLibraryList,
  type AvatarLibraryResult,
  type AvatarLibraryView,
  type UploadableAvatarKind,
} from '../../shared/avatarLibrary';

export const LIST_TTL_MS = 60_000;
/** Download cap for a model zip: the proxy's zip cap, and the local store's (AVATAR_ZIP_MAX_BYTES). */
export const MODEL_DOWNLOAD_MAX_BYTES = 64 * 1024 * 1024;
/** 503 busy on commit: wait this long, then commit again (the staging upload stays valid for hours). */
export const COMMIT_BUSY_RETRY_MS = [5_000, 15_000] as const;
/** 202 processing: the server finishes the commit in the background; look for the row this often. */
export const COMMIT_POLL_MS = 10_000;
export const COMMIT_POLLS = 6;
/** Server refusals of the bytes themselves: the same bytes are never sent again by sync. */
const REFUSED_CODES: ReadonlySet<AvatarLibraryError> = new Set(['too_big', 'bad_content', 'bad_kind']);
/** Skip-list key of a local model the server refused (rev = the zip's sha256). */
export function refusedUploadKey(characterId: string): string {
  return `upload:${characterId}`;
}

export class AvatarLibraryNoSession extends Error {
  constructor() {
    super('no session');
    this.name = 'AvatarLibraryNoSession';
  }
}

export interface LocalModelStore {
  manifest(characterId: string): Promise<AvatarManifest | null>;
  /** The stored model as a stable zip (zipStoredAvatar), or null. */
  zip(characterId: string): Promise<Uint8Array | null>;
  import(characterId: string, zip: Uint8Array): Promise<AvatarManifest>;
  link(characterId: string, link: { avatarId: string; rev: string } | null): Promise<AvatarManifest | null>;
  remove(characterId: string): Promise<void>;
}

/**
 * Library rows (by id + rev) this profile does not download again: an import
 * that failed, or a model the user removed locally. Persisted per profile.
 */
export interface SkipList {
  has(avatarId: string, rev: string): Promise<boolean>;
  add(avatarId: string, rev: string): Promise<void>;
  /** The user chose this row again: allow one more try. */
  clear(avatarId: string): Promise<void>;
}

export interface AvatarLibraryDeps {
  /** sei-proxy with the user's Sei JWT. Throws AvatarLibraryNoSession when signed out. */
  api(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<{ status: number; body: unknown }>;
  online(): boolean;
  /** PUT bytes to a signed upload URL. */
  putSigned(url: string, bytes: Uint8Array, mime: string): Promise<void>;
  download(url: string, maxBytes: number): Promise<Uint8Array>;
  /** The owner's card image bytes (hashed only, never uploaded), or null. */
  cardPortrait(characterId: string): Promise<{ bytes: Uint8Array; mime: string } | null>;
  models: LocalModelStore;
  skip: SkipList;
  /** The viewer's pick (UserConfig.avatar_prefs[id].avatar_id). */
  getPick(characterId: string): Promise<string | null>;
  setPick(characterId: string, avatarId: string | null): Promise<void>;
  capture(event: string, props: Record<string, unknown>): void;
  /** The view changed (tiles re-render). */
  onView(characterId: string, view: AvatarLibraryView): void;
  /** The local model changed (views re-resolve her avatar). */
  onModel(characterId: string, manifest: AvatarManifest | null): void;
  /** What plays changed: Anima re-checks her face set. */
  onEffectiveChanged?(characterId: string): void;
  now(): number;
  /** Wait (tests pass an instant one). */
  sleep?(ms: number): Promise<void>;
  log?(line: string): void;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Image type by magic bytes (png / jpeg / webp), or null. Same sniff as the upload checks (full 8-byte PNG signature). */
export function imageMime(bytes: Uint8Array): string | null {
  const t = sniffAvatarImage(bytes);
  return t ? `image/${t}` : null;
}

/** Map a proxy answer to the closed error set. */
export function errorOf(status: number, body: unknown): AvatarLibraryError {
  const code = (body as { error?: unknown } | null)?.error;
  const known: AvatarLibraryError[] = [
    'too_big', 'too_many', 'quota', 'last_public', 'not_shareable', 'card_avatar', 'hash_mismatch', 'bad_content', 'bad_kind',
    'upload_required', 'staging_quota', 'card_changed', 'no_card', 'card_conflict', 'busy',
  ];
  if (typeof code === 'string' && (known as string[]).includes(code)) return code as AvatarLibraryError;
  // The staging upload is not there (or not this user's): upload again.
  if (code === 'missing_upload') return 'upload_required';
  if (status === 401) return 'signed_out';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server';
  return 'bad_content';
}

class OpError extends Error {
  constructor(public readonly code: AvatarLibraryError) {
    super(code);
  }
}

interface Cached {
  list: AvatarLibraryList | null;
  at: number;
}

export class AvatarLibraryClient {
  private readonly cache = new Map<string, Cached>();
  private readonly flights = new Map<string, Promise<AvatarLibraryView>>();
  /** Per character: what played last (to spot a change for Anima). */
  private readonly lastEffective = new Map<string, string | null>();
  private gen = 0;

  constructor(private readonly d: AvatarLibraryDeps) {}

  /** Account switch: forget everything. */
  reset(): void {
    this.gen++;
    this.cache.clear();
    this.flights.clear();
    this.lastEffective.clear();
  }

  // ── reads ─────────────────────────────────────────────────────────────────

  async view(characterId: string, opts: { fresh?: boolean } = {}): Promise<AvatarLibraryView> {
    const list = await this.list(characterId, opts.fresh === true).catch((err) => {
      this.fail('list', err);
      return null;
    });
    return this.viewOf(characterId, list);
  }

  /** Owner sync + ensure, single-flight per character. Never throws. */
  sync(characterId: string): Promise<AvatarLibraryView> {
    return this.flight(`sync|${characterId}`, () => this.runSync(characterId, true));
  }

  /** Make the local store match what plays. Never throws. */
  ensure(characterId: string): Promise<AvatarLibraryView> {
    return this.flight(`ensure|${characterId}`, () => this.runSync(characterId, false));
  }

  /** The portrait avatar Anima should bake for her, or null (bake her card image the old way). */
  async animaAvatarFor(characterId: string): Promise<{ avatarId: string; rev: string } | null> {
    if (!UUID_RE.test(characterId)) return null;
    const view = await this.ensure(characterId);
    const eff = view.list?.avatars.find((a) => a.id === view.effective_id) ?? null;
    return eff && eff.kind === 'portrait' ? { avatarId: eff.id, rev: eff.rev } : null;
  }

  // ── writes ────────────────────────────────────────────────────────────────

  /** Upload an image as a new portrait avatar (owner). */
  async addPortrait(characterId: string, bytes: Uint8Array, name: string | null): Promise<AvatarLibraryResult> {
    const mime = imageMime(bytes);
    if (!mime) return { ok: false, error: 'bad_content' };
    // The proxy's own checks, before anything goes up: static, at most
    // MAX_PORTRAIT_SIDE px, at most the listed byte cap.
    const problem = avatarImageProblem(bytes, MAX_PORTRAIT_SIDE);
    if (problem) return { ok: false, error: problem === 'image_too_large' ? 'too_big' : 'bad_content' };
    const maxBytes = this.cache.get(characterId)?.list?.limits?.max_image_bytes;
    if (typeof maxBytes === 'number' && bytes.byteLength > maxBytes) return { ok: false, error: 'too_big' };
    return this.write('upload', characterId, async () => {
      await this.upload(characterId, 'portrait', bytes, mime, { name, origin: 'user' });
    });
  }

  /**
   * Owner: a Live2D/rig zip was just imported into the local store (the
   * import cleared any library link): upload it and make it the default.
   */
  async addLocalModel(characterId: string): Promise<AvatarLibraryResult> {
    return this.write('upload', characterId, async () => {
      const list = await this.list(characterId, true);
      if (!list) throw new OpError('not_found');
      if (!list.is_owner) throw new OpError('forbidden');
      const manifest = await this.d.models.manifest(characterId);
      if (!manifest) throw new OpError('import_failed');
      if (manifest.library) return;
      await this.pushLocalModel(characterId, list, manifest, 'user');
    });
  }

  async setFlags(
    characterId: string,
    avatarId: string,
    flags: { is_public?: boolean; is_default?: boolean },
  ): Promise<AvatarLibraryResult> {
    if (!UUID_RE.test(avatarId)) return { ok: false, error: 'not_found' };
    const before = this.cache.get(characterId)?.list ?? null;
    const item = before?.avatars.find((a) => a.id === avatarId) ?? null;
    const body: Record<string, boolean> = {};
    if (typeof flags.is_public === 'boolean') body.is_public = flags.is_public;
    if (typeof flags.is_default === 'boolean') body.is_default = flags.is_default;
    return this.write('flags', characterId, async () => {
      const res = await this.d.api('PATCH', `/avatars/v1/${characterId}/${avatarId}`, body);
      if (res.status !== 200) throw new OpError(errorOf(res.status, res.body));
      const after = await this.list(characterId, true);
      const kind = item?.kind ?? after?.avatars.find((a) => a.id === avatarId)?.kind ?? null;
      if (body.is_public !== undefined && after) {
        this.d.capture('avatar_visibility_changed', {
          character_id: characterId,
          kind,
          to: body.is_public ? 'public' : 'private',
          character_public: after.character_public,
          public_count: publicCount(after),
        });
      }
      if (body.is_default === true) {
        await this.d.skip.clear(avatarId).catch(() => {});
        const prev = before ? effectiveAvatar(before, null) : null;
        this.d.capture('avatar_default_changed', {
          character_id: characterId,
          kind,
          by: 'owner',
          from_kind: prev?.kind ?? null,
        });
      }
    });
  }

  async remove(characterId: string, avatarId: string): Promise<AvatarLibraryResult> {
    if (!UUID_RE.test(avatarId)) return { ok: false, error: 'not_found' };
    return this.write('delete', characterId, async () => {
      const res = await this.d.api('DELETE', `/avatars/v1/${characterId}/${avatarId}`);
      if (res.status !== 200) throw new OpError(errorOf(res.status, res.body));
    });
  }

  /** The viewer's own pick of what plays for them (any public avatar), or null for the default. */
  async setPick(characterId: string, avatarId: string | null): Promise<AvatarLibraryResult> {
    const list = await this.list(characterId, false).catch(() => null);
    if (avatarId && !list?.avatars.some((a) => a.id === avatarId)) return { ok: false, error: 'not_found' };
    const prev = list ? effectiveAvatar(list, await this.d.getPick(characterId).catch(() => null)) : null;
    try {
      if (avatarId) await this.d.skip.clear(avatarId).catch(() => {});
      await this.d.setPick(characterId, avatarId);
    } catch {
      return { ok: false, error: 'server' };
    }
    const next = list ? effectiveAvatar(list, avatarId) : null;
    if (next && next.id !== prev?.id) {
      this.d.capture('avatar_default_changed', {
        character_id: characterId,
        kind: next.kind,
        by: 'viewer',
        from_kind: prev?.kind ?? null,
      });
    }
    return { ok: true, view: await this.ensure(characterId) };
  }

  /**
   * Her character file was saved. Only a character whose library this run
   * already loaded as its owner re-syncs (a new card image goes up); every
   * other save (cloud pulls, foreign characters) costs nothing.
   */
  characterSaved(characterId: string): Promise<AvatarLibraryView> | null {
    if (!this.cache.get(characterId)?.list?.is_owner) return null;
    return this.sync(characterId);
  }

  /**
   * The user removed a library-backed local model (Avatar tab). The owner
   * deletes it from the library (the server keeps the public rule); anyone
   * else switches their own pick to a portrait so it is not downloaded again.
   */
  async modelRemovedLocally(characterId: string, link: { avatarId: string; rev?: string }): Promise<AvatarLibraryResult> {
    // Whatever the server says next, this device does not fetch that model
    // back by itself (a refused delete, offline, another user's model).
    const known = this.cache.get(characterId)?.list?.avatars.find((a) => a.id === link.avatarId) ?? null;
    const rev = typeof link.rev === 'string' && link.rev ? link.rev : known?.rev ?? null;
    if (rev) await this.d.skip.add(link.avatarId, rev).catch(() => {});
    const list = await this.list(characterId, false).catch(() => null);
    if (!list) return { ok: false, error: 'not_found' };
    if (!rev) {
      const row = list.avatars.find((a) => a.id === link.avatarId);
      if (row) await this.d.skip.add(row.id, row.rev).catch(() => {});
    }
    if (list.is_owner) return this.remove(characterId, link.avatarId);
    const portrait = list.avatars.find((a) => a.kind === 'portrait') ?? null;
    if (!portrait) return { ok: false, error: 'not_found' };
    return this.setPick(characterId, portrait.id);
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private flight(key: string, fn: () => Promise<AvatarLibraryView>): Promise<AvatarLibraryView> {
    const live = this.flights.get(key);
    if (live) return live;
    const p = fn().finally(() => {
      if (this.flights.get(key) === p) this.flights.delete(key);
    });
    this.flights.set(key, p);
    return p;
  }

  private async list(characterId: string, fresh: boolean): Promise<AvatarLibraryList | null> {
    if (!UUID_RE.test(characterId)) return null;
    const hit = this.cache.get(characterId);
    if (!fresh && hit && this.d.now() - hit.at < LIST_TTL_MS) return hit.list;
    if (!this.d.online()) {
      if (hit) return hit.list;
      throw new OpError('offline');
    }
    const gen = this.gen;
    const res = await this.d.api('GET', `/avatars/v1/${characterId}`);
    // 404: no cloud row, or a proxy without the library yet. Either way: no library.
    let list: AvatarLibraryList | null = null;
    if (res.status === 200) list = parseAvatarList(res.body);
    else if (res.status !== 404 && res.status !== 403) throw new OpError(errorOf(res.status, res.body));
    if (gen === this.gen) this.cache.set(characterId, { list, at: this.d.now() });
    return list;
  }

  private async viewOf(characterId: string, list: AvatarLibraryList | null): Promise<AvatarLibraryView> {
    const pick = list ? await this.d.getPick(characterId).catch(() => null) : null;
    const pickId = pick && list?.avatars.some((a) => a.id === pick) ? pick : null;
    const eff = effectiveAvatar(list, pickId);
    return { state: list ? 'ready' : 'none', list, pick_id: pickId, effective_id: eff?.id ?? null };
  }

  private async write(op: string, characterId: string, fn: () => Promise<void>): Promise<AvatarLibraryResult> {
    if (!UUID_RE.test(characterId)) return { ok: false, error: 'not_found' };
    if (!this.d.online()) return { ok: false, error: 'offline' };
    try {
      await fn();
    } catch (err) {
      const code = this.fail(op, err);
      // A refused write still leaves a valid view; refresh it so the tiles show the truth.
      this.cache.delete(characterId);
      return { ok: false, error: code };
    }
    this.cache.delete(characterId);
    const view = await this.ensure(characterId);
    return { ok: true, view };
  }

  private fail(op: string, err: unknown): AvatarLibraryError {
    const reason: AvatarLibraryError =
      err instanceof OpError ? err.code : err instanceof AvatarLibraryNoSession ? 'signed_out' : 'network';
    // Expected states are not failures: signed out, offline, the public rule.
    if (reason !== 'signed_out' && reason !== 'offline' && reason !== 'last_public') {
      this.d.capture('avatar_library_failed', { op, reason });
      this.d.log?.(`[avatars] ${op} failed (${reason})`);
    }
    return reason;
  }

  /** Upload bytes as an avatar: ask, PUT unless the server has them, commit. */
  private async upload(
    characterId: string,
    kind: UploadableAvatarKind,
    bytes: Uint8Array,
    mime: string,
    opts: { name: string | null; origin: 'user' | 'migration'; makeDefault?: boolean },
  ): Promise<{ id: string; rev: string | null } | null> {
    const sha = sha256Hex(bytes);
    const ask = await this.d.api('POST', `/avatars/v1/${characterId}/upload`, { kind, sha256: sha, bytes: bytes.byteLength, mime });
    if (ask.status !== 200) throw new OpError(errorOf(ask.status, ask.body));
    const a = ask.body as { state?: string; upload?: { url?: string; path?: string } } | null;
    let staging: string | undefined;
    if (a?.state === 'upload') {
      if (!a.upload?.url || !/^https:\/\//i.test(a.upload.url) || !a.upload.path) throw new OpError('server');
      await this.d.putSigned(a.upload.url, bytes, mime);
      staging = a.upload.path;
    } else if (a?.state !== 'exists') {
      throw new OpError('server');
    }
    const c = await this.commitUpload(characterId, kind, sha, {
      kind,
      sha256: sha,
      ...(staging ? { staging_path: staging } : {}),
      ...(opts.name ? { name: opts.name.slice(0, 80) } : {}),
      source: 'upload',
      ...(opts.makeDefault ? { make_default: true } : {}),
    });
    const list = this.cache.get(characterId)?.list ?? null;
    this.d.capture('avatar_uploaded', {
      character_id: characterId,
      kind,
      source: opts.origin,
      dedupe: !staging,
      mb: mbBucket(bytes.byteLength),
      moderation: c?.avatar?.moderation ?? null,
      own_character_public: list?.character_public ?? null,
    });
    this.cache.delete(characterId);
    const id = c?.avatar?.id;
    const rev = typeof c?.avatar?.rev === 'string' ? c.avatar.rev : null;
    return typeof id === 'string' && UUID_RE.test(id) ? { id, rev } : null;
  }

  private sleep(ms: number): Promise<void> {
    return this.d.sleep ? this.d.sleep(ms) : new Promise((r) => setTimeout(r, ms));
  }

  /**
   * Commit an upload. 503 busy (the proxy checks one commit at a time): try
   * again a little later, twice. 202 processing (the check ran past the
   * proxy's deadline and finishes in the background): look for the row by
   * its hash in the owner list a few times; still not there is `processing`.
   */
  private async commitUpload(
    characterId: string,
    kind: UploadableAvatarKind,
    sha: string,
    body: Record<string, unknown>,
  ): Promise<{ avatar?: { id?: string; rev?: string; moderation?: string } } | null> {
    let res = await this.d.api('POST', `/avatars/v1/${characterId}/commit`, body);
    for (const wait of COMMIT_BUSY_RETRY_MS) {
      if (!(res.status === 503 && errorOf(res.status, res.body) === 'busy')) break;
      await this.sleep(wait);
      res = await this.d.api('POST', `/avatars/v1/${characterId}/commit`, body);
    }
    if (res.status === 200) return res.body as { avatar?: { id?: string; rev?: string; moderation?: string } } | null;
    if (res.status === 202 && (res.body as { state?: unknown } | null)?.state === 'processing') {
      for (let i = 0; i < COMMIT_POLLS; i++) {
        await this.sleep(COMMIT_POLL_MS);
        const list = await this.list(characterId, true).catch(() => null);
        const row = list?.avatars.find((a) => a.source === 'upload' && a.kind === kind && a.sha256 === sha) ?? null;
        if (row) return { avatar: { id: row.id, rev: row.rev, moderation: row.moderation } };
      }
      throw new OpError('processing');
    }
    throw new OpError(errorOf(res.status, res.body));
  }

  /**
   * Ask the proxy to rebuild the card row from the card image it holds.
   * `sha` is the hash of this device's card image; when the cloud copy is not
   * that yet (card_changed) or there is none (no_card), the next sync tries
   * again, quietly. card_conflict: those bytes sit on an upload row that is
   * not clean, which is the server's call to keep apart.
   */
  private async commitCard(characterId: string, sha: string): Promise<boolean> {
    const res = await this.d.api('POST', `/avatars/v1/${characterId}/commit`, { kind: 'portrait', source: 'card', sha256: sha });
    if (res.status === 200) {
      const c = res.body as { avatar?: { moderation?: string } } | null;
      const list = this.cache.get(characterId)?.list ?? null;
      this.d.capture('avatar_uploaded', {
        character_id: characterId,
        kind: 'portrait',
        source: 'card',
        dedupe: true,
        mb: null,
        moderation: c?.avatar?.moderation ?? null,
        own_character_public: list?.character_public ?? null,
      });
      return true;
    }
    // Past the proxy's deadline: the row is being written in the background.
    if (res.status === 202) return true;
    const code = errorOf(res.status, res.body);
    if (code === 'card_changed' || code === 'no_card' || code === 'card_conflict' || code === 'busy') {
      this.d.log?.(`[avatars] card row not rebuilt (${code})`);
      return false;
    }
    throw new OpError(code);
  }

  private async runSync(characterId: string, ownerUploads: boolean): Promise<AvatarLibraryView> {
    if (!UUID_RE.test(characterId)) return this.viewOf(characterId, null);
    let list: AvatarLibraryList | null;
    try {
      list = await this.list(characterId, ownerUploads);
    } catch (err) {
      this.fail(ownerUploads ? 'sync' : 'list', err);
      return this.viewOf(characterId, this.cache.get(characterId)?.list ?? null);
    }
    if (!list) return this.publish(characterId, null);

    if (ownerUploads && list.is_owner) {
      try {
        list = (await this.ownerUploads(characterId, list)) ?? list;
      } catch (err) {
        this.fail('sync', err);
      }
    }
    try {
      await this.applyEffective(characterId, list);
    } catch (err) {
      this.fail('download', err);
    }
    return this.publish(characterId, list);
  }

  private async publish(characterId: string, list: AvatarLibraryList | null): Promise<AvatarLibraryView> {
    const view = await this.viewOf(characterId, list);
    const prev = this.lastEffective.get(characterId);
    this.lastEffective.set(characterId, view.effective_id);
    try {
      this.d.onView(characterId, view);
    } catch {
      /* a closed window */
    }
    if (prev !== undefined && prev !== view.effective_id) this.d.onEffectiveChanged?.(characterId);
    return view;
  }

  /** Owner: card image + local model up to the server. Returns the fresh list when anything changed. */
  private async ownerUploads(characterId: string, list: AvatarLibraryList): Promise<AvatarLibraryList | null> {
    let changed = false;
    const card = await this.d.cardPortrait(characterId).catch(() => null);
    if (card) {
      const sha = sha256Hex(card.bytes);
      const cardRow = list.avatars.find((a) => a.source === 'card');
      if ((!cardRow || cardRow.sha256 !== sha) && (await this.commitCard(characterId, sha))) changed = true;
    }
    const manifest = await this.d.models.manifest(characterId).catch(() => null);
    if (manifest) {
      const linked = manifest.library ? list.avatars.find((a) => a.id === manifest.library!.avatarId) : null;
      if (manifest.library && !linked) {
        // Deleted on the server (another device): the local copy goes too.
        await this.d.models.remove(characterId);
        this.d.onModel(characterId, null);
      } else if (!manifest.library) {
        if (await this.pushLocalModel(characterId, list, manifest, 'migration')) changed = true;
      }
    }
    return changed ? this.list(characterId, true) : null;
  }

  /**
   * Upload her local, not yet linked model (or find it already in the
   * library) and link the local copy. It stays private. An upload the owner
   * just chose (`user`) becomes the default; a migration of a model already
   * on disk is never made the default, only picked on this device so it
   * keeps playing here. True when the library changed.
   */
  private async pushLocalModel(
    characterId: string,
    list: AvatarLibraryList,
    manifest: AvatarManifest,
    origin: 'user' | 'migration',
  ): Promise<boolean> {
    const maxZip = list.limits?.max_zip_bytes;
    const zip = await this.d.models.zip(characterId);
    if (!zip) return false;
    const sha = sha256Hex(zip);
    const kind: UploadableAvatarKind = manifest.kind === 'rig' ? 'rig' : 'live2d';
    const existing = list.avatars.find((a) => a.sha256 === sha && a.kind === kind) ?? null;
    let avatarId: string | null = existing?.id ?? null;
    let rev: string | null = existing?.rev ?? null;
    let changed = false;
    if (!existing) {
      const refusedKey = refusedUploadKey(characterId);
      // Refused before: sync never sends the same bytes again. The user
      // adding the model by hand gets one more try.
      if (origin === 'migration' && (await this.d.skip.has(refusedKey, sha).catch(() => false))) return false;
      let item: { id: string; rev: string | null } | null;
      try {
        // Over the listed cap: refused here, before any request.
        if (typeof maxZip === 'number' && zip.byteLength > maxZip) throw new OpError('too_big');
        item = await this.upload(characterId, kind, zip, 'application/zip', {
          name: manifest.name,
          origin,
          makeDefault: origin === 'user',
        });
      } catch (err) {
        if (err instanceof OpError && REFUSED_CODES.has(err.code)) await this.d.skip.add(refusedKey, sha).catch(() => {});
        throw err;
      }
      avatarId = item?.id ?? null;
      rev = item?.rev ?? null;
      changed = true;
    } else if (origin === 'user' && !existing.is_default) {
      const res = await this.d.api('PATCH', `/avatars/v1/${characterId}/${existing.id}`, { is_default: true });
      if (res.status !== 200) throw new OpError(errorOf(res.status, res.body));
      changed = true;
    }
    if (avatarId && !rev) {
      rev = (await this.list(characterId, true))?.avatars.find((a) => a.id === avatarId)?.rev ?? null;
    }
    if (avatarId && rev) {
      if (origin === 'migration') await this.d.setPick(characterId, avatarId).catch(() => {});
      const m = await this.d.models.link(characterId, { avatarId, rev });
      if (m) this.d.onModel(characterId, m);
    }
    return changed;
  }

  private async applyEffective(characterId: string, list: AvatarLibraryList): Promise<void> {
    const pick = await this.d.getPick(characterId).catch(() => null);
    const eff = effectiveAvatar(list, pick);
    if (!eff) return;
    const manifest = await this.d.models.manifest(characterId).catch(() => null);
    if (eff.kind === 'live2d' || eff.kind === 'rig') {
      if (manifest?.library?.avatarId === eff.id && manifest.library.rev === eff.rev) return;
      // A model the user imported by hand (no library link) is never overwritten:
      // the owner's is uploaded by sync, anyone else's is their own choice.
      if (manifest && !manifest.library) return;
      // Failed to import before, or removed by the user: never fetched again by itself.
      if (await this.d.skip.has(eff.id, eff.rev).catch(() => false)) return;
      if (!eff.url) throw new OpError('server');
      const t0 = this.d.now();
      const zip = await this.d.download(eff.url, MODEL_DOWNLOAD_MAX_BYTES);
      // The owner gets the hash; anyone else trusts the signed URL of that row.
      if (eff.sha256 && sha256Hex(zip) !== eff.sha256) {
        await this.d.skip.add(eff.id, eff.rev).catch(() => {});
        throw new OpError('hash_mismatch');
      }
      let m: AvatarManifest | null;
      try {
        await this.d.models.import(characterId, zip);
        m = await this.d.models.link(characterId, { avatarId: eff.id, rev: eff.rev });
      } catch {
        await this.d.skip.add(eff.id, eff.rev).catch(() => {});
        throw new OpError('import_failed');
      }
      this.d.onModel(characterId, m);
      if (!list.is_owner) {
        this.d.capture('avatar_downloaded_shared', {
          character_id: characterId,
          kind: eff.kind,
          mb: mbBucket(zip.byteLength),
          ms: this.d.now() - t0,
        });
      }
      return;
    }
    // A portrait plays: a library-backed local model would shadow its face set.
    if (manifest?.library) {
      await this.d.models.remove(characterId);
      this.d.onModel(characterId, null);
    }
  }
}
