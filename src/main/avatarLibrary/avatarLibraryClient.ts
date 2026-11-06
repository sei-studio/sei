/**
 * Avatar library client (261106): a character's server-stored avatars
 * (sei-proxy /avatars/v1), kept in step with this app. Design:
 * docs/agents/avatar-library.md. Wiring: avatarLibraryRuntime.ts.
 *
 *   view(id)        the list + the viewer's pick + what plays (cached 60 s)
 *   sync(id)        owner: upload the card image when its hash changed and a
 *                   local Live2D/rig model with no library link yet (this is
 *                   the migration of existing local models: a model on disk
 *                   is uploaded the next time its owner opens the character),
 *                   then ensure(). Anyone else: just ensure().
 *   ensure(id)      make the local avatar store match what plays: download a
 *                   public model once (other users' copies of a public
 *                   character never regenerate it), clear a library-backed
 *                   local model when a portrait plays instead.
 *   animaAvatarFor  the portrait avatar Anima should bake for her (per
 *                   portrait hash, not per character), or null (old path).
 *
 * Writes (upload, setFlags, remove, setPick) answer AvatarLibraryResult with
 * a closed error code; the server enforces the public rule, the UI only
 * mirrors it. Nothing here throws to its caller.
 *
 * Analytics, shape only (kinds, MB, counts, the character id): avatar_uploaded,
 * avatar_visibility_changed, avatar_default_changed, avatar_downloaded_shared,
 * avatar_library_failed.
 */
import { createHash } from 'node:crypto';
import type { AvatarManifest } from '../../shared/ipc';
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
/** Download cap for a model zip (the proxy's own cap is lower). */
export const MODEL_DOWNLOAD_MAX_BYTES = 128 * 1024 * 1024;

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
  link(characterId: string, link: { avatarId: string; sha256: string } | null): Promise<AvatarManifest | null>;
  remove(characterId: string): Promise<void>;
}

export interface AvatarLibraryDeps {
  /** sei-proxy with the user's Sei JWT. Throws AvatarLibraryNoSession when signed out. */
  api(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<{ status: number; body: unknown }>;
  online(): boolean;
  /** PUT bytes to a signed upload URL. */
  putSigned(url: string, bytes: Uint8Array, mime: string): Promise<void>;
  download(url: string, maxBytes: number): Promise<Uint8Array>;
  /** The owner's card image bytes, or null. */
  cardPortrait(characterId: string): Promise<{ bytes: Uint8Array; mime: string } | null>;
  models: LocalModelStore;
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
  log?(line: string): void;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Image type by magic bytes (png / jpeg / webp), or null. */
export function imageMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

/** Map a proxy answer to the closed error set. */
export function errorOf(status: number, body: unknown): AvatarLibraryError {
  const code = (body as { error?: unknown } | null)?.error;
  const known: AvatarLibraryError[] = [
    'too_big', 'too_many', 'quota', 'last_public', 'not_shareable', 'card_avatar', 'hash_mismatch', 'bad_content', 'bad_kind',
  ];
  if (typeof code === 'string' && (known as string[]).includes(code)) return code as AvatarLibraryError;
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
  async animaAvatarFor(characterId: string): Promise<{ avatarId: string; sha256: string } | null> {
    if (!UUID_RE.test(characterId)) return null;
    const view = await this.ensure(characterId);
    const eff = view.list?.avatars.find((a) => a.id === view.effective_id) ?? null;
    return eff && eff.kind === 'portrait' ? { avatarId: eff.id, sha256: eff.sha256 } : null;
  }

  // ── writes ────────────────────────────────────────────────────────────────

  /** Upload an image as a new portrait avatar (owner). */
  async addPortrait(characterId: string, bytes: Uint8Array, name: string | null): Promise<AvatarLibraryResult> {
    const mime = imageMime(bytes);
    if (!mime) return { ok: false, error: 'bad_content' };
    return this.write('upload', characterId, async () => {
      await this.upload(characterId, 'portrait', bytes, mime, { name, source: 'upload', origin: 'user' });
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
  async modelRemovedLocally(characterId: string, link: { avatarId: string; sha256: string }): Promise<AvatarLibraryResult> {
    const list = await this.list(characterId, false).catch(() => null);
    if (!list) return { ok: false, error: 'not_found' };
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
    opts: { name: string | null; source: 'card' | 'upload'; origin: 'user' | 'migration' | 'card'; makeDefault?: boolean },
  ): Promise<{ id: string } | null> {
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
    const commit = await this.d.api('POST', `/avatars/v1/${characterId}/commit`, {
      kind,
      sha256: sha,
      ...(staging ? { staging_path: staging } : {}),
      ...(opts.name ? { name: opts.name.slice(0, 80) } : {}),
      source: opts.source,
      ...(opts.makeDefault ? { make_default: true } : {}),
    });
    if (commit.status !== 200) throw new OpError(errorOf(commit.status, commit.body));
    const c = commit.body as { avatar?: { id?: string; moderation?: string } } | null;
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
    return typeof id === 'string' && UUID_RE.test(id) ? { id } : null;
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
      if (!cardRow || cardRow.sha256 !== sha) {
        await this.upload(characterId, 'portrait', card.bytes, card.mime, { name: null, source: 'card', origin: 'card' });
        changed = true;
      }
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
   * library), make it the default (it is what she shows on this device), and
   * link the local copy. True when the library changed.
   */
  private async pushLocalModel(
    characterId: string,
    list: AvatarLibraryList,
    manifest: AvatarManifest,
    origin: 'user' | 'migration',
  ): Promise<boolean> {
    const zip = await this.d.models.zip(characterId);
    if (!zip) return false;
    const sha = sha256Hex(zip);
    const kind: UploadableAvatarKind = manifest.kind === 'rig' ? 'rig' : 'live2d';
    const existing = list.avatars.find((a) => a.sha256 === sha && a.kind === kind) ?? null;
    let avatarId: string | null = existing?.id ?? null;
    let changed = false;
    if (!existing) {
      const item = await this.upload(characterId, kind, zip, 'application/zip', {
        name: manifest.name,
        source: 'upload',
        origin,
        makeDefault: true,
      });
      avatarId = item?.id ?? null;
      changed = true;
    } else if (!existing.is_default) {
      const res = await this.d.api('PATCH', `/avatars/v1/${characterId}/${existing.id}`, { is_default: true });
      if (res.status !== 200) throw new OpError(errorOf(res.status, res.body));
      changed = true;
    }
    if (avatarId) {
      const m = await this.d.models.link(characterId, { avatarId, sha256: sha });
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
      if (manifest?.library?.sha256 === eff.sha256) return;
      // An owner's local import not uploaded yet is never overwritten.
      if (manifest && !manifest.library && list.is_owner) return;
      if (!eff.url) throw new OpError('server');
      const t0 = this.d.now();
      const zip = await this.d.download(eff.url, MODEL_DOWNLOAD_MAX_BYTES);
      if (sha256Hex(zip) !== eff.sha256) throw new OpError('hash_mismatch');
      let m: AvatarManifest | null;
      try {
        await this.d.models.import(characterId, zip);
        m = await this.d.models.link(characterId, { avatarId: eff.id, sha256: eff.sha256 });
      } catch {
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
