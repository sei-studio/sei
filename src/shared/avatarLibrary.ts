/**
 * Avatar library (261106): a character's server-stored avatars, each with a
 * public/private lock and one default. Shared between main and the renderer.
 * Design: docs/agents/avatar-library.md. Server: sei-proxy /avatars/v1/*.
 *
 * An avatar is how a companion appears as a living figure (SeiLink room,
 * overlay, call tile), not the card image: a portrait (played as its Anima
 * face set, else its cutout) or a Live2D / rig model zip.
 */

export const AVATAR_KINDS = ['portrait', 'live2d', 'rig', 'facepack'] as const;
export type AvatarKind = (typeof AVATAR_KINDS)[number];

/** Kinds the app can upload today (facepack is reserved server-side). */
export const UPLOADABLE_AVATAR_KINDS = ['portrait', 'live2d', 'rig'] as const;
export type UploadableAvatarKind = (typeof UPLOADABLE_AVATAR_KINDS)[number];

export type AvatarModeration = 'pending' | 'clean' | 'flagged' | 'needs_review';

/** One avatar as the proxy lists it. */
export interface AvatarItem {
  id: string;
  kind: AvatarKind;
  /** 'card' mirrors the card image (one per character); 'upload' is anything else. */
  source: 'card' | 'upload';
  name: string | null;
  sha256: string;
  bytes: number;
  mime: string;
  is_public: boolean;
  is_default: boolean;
  sort_order: number;
  moderation: AvatarModeration;
  /** Public AND visible to other users right now (moderation clean, character public). */
  shareable: boolean;
  /** Signed download URL (short-lived), or null. */
  url: string | null;
  expires_in?: number;
}

export interface AvatarLibraryLimits {
  max_per_character: number;
  max_image_bytes: number;
  max_zip_bytes: number;
  user_quota_bytes?: number;
  /** Owner only: bytes this user's avatars take. */
  used_bytes?: number;
}

/** GET /avatars/v1/:character_id. A non-owner only ever sees shareable rows. */
export interface AvatarLibraryList {
  character_id: string;
  is_owner: boolean;
  character_public: boolean;
  default_id: string | null;
  avatars: AvatarItem[];
  limits?: AvatarLibraryLimits;
}

/** What the renderer gets: the list plus the viewer's own pick and what plays. */
export interface AvatarLibraryView {
  /** 'none': no cloud row, signed out, offline, or the server has no library yet. */
  state: 'ready' | 'none';
  list: AvatarLibraryList | null;
  /** The viewer's pick (UserConfig.avatar_prefs[id].avatar_id), when still listed. */
  pick_id: string | null;
  /** What plays for this viewer: the pick, else the default. */
  effective_id: string | null;
}

/** Errors the IPC surfaces to the renderer (closed set, also the analytics reasons). */
export const AVATAR_LIBRARY_ERRORS = [
  'offline',
  'signed_out',
  'not_found',
  'forbidden',
  'too_big',
  'too_many',
  'quota',
  'last_public',
  'not_shareable',
  'card_avatar',
  'hash_mismatch',
  'bad_content',
  'bad_kind',
  'import_failed',
  'rate_limited',
  'network',
  'server',
] as const;
export type AvatarLibraryError = (typeof AVATAR_LIBRARY_ERRORS)[number];

export function isAvatarLibraryError(v: unknown): v is AvatarLibraryError {
  return typeof v === 'string' && (AVATAR_LIBRARY_ERRORS as readonly string[]).includes(v);
}

/** Result of a write from the renderer: the fresh view, or an error code. */
export type AvatarLibraryResult = { ok: true; view: AvatarLibraryView } | { ok: false; error: AvatarLibraryError };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA_RE = /^[0-9a-f]{64}$/;

function asItem(v: unknown): AvatarItem | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  if (typeof r.id !== 'string' || !UUID_RE.test(r.id)) return null;
  if (typeof r.kind !== 'string' || !(AVATAR_KINDS as readonly string[]).includes(r.kind)) return null;
  if (typeof r.sha256 !== 'string' || !SHA_RE.test(r.sha256)) return null;
  const moderation = (['pending', 'clean', 'flagged', 'needs_review'] as const).find((m) => m === r.moderation) ?? 'pending';
  return {
    id: r.id,
    kind: r.kind as AvatarKind,
    source: r.source === 'card' ? 'card' : 'upload',
    name: typeof r.name === 'string' ? r.name.slice(0, 80) : null,
    sha256: r.sha256,
    bytes: typeof r.bytes === 'number' && Number.isFinite(r.bytes) ? r.bytes : 0,
    mime: typeof r.mime === 'string' ? r.mime : '',
    is_public: r.is_public === true,
    is_default: r.is_default === true,
    sort_order: typeof r.sort_order === 'number' ? r.sort_order : 0,
    moderation,
    shareable: r.shareable === true,
    url: typeof r.url === 'string' && /^https:\/\//i.test(r.url) ? r.url : null,
    ...(typeof r.expires_in === 'number' ? { expires_in: r.expires_in } : {}),
  };
}

/** Validate a proxy list reply (the single parse point; anything malformed is dropped). */
export function parseAvatarList(v: unknown): AvatarLibraryList | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  if (typeof r.character_id !== 'string' || !Array.isArray(r.avatars)) return null;
  const avatars = r.avatars.map(asItem).filter((a): a is AvatarItem => a !== null);
  avatars.sort((a, b) => a.sort_order - b.sort_order);
  const ids = new Set(avatars.map((a) => a.id));
  const def = typeof r.default_id === 'string' && ids.has(r.default_id) ? r.default_id : null;
  const limits = r.limits as AvatarLibraryLimits | undefined;
  return {
    character_id: r.character_id,
    is_owner: r.is_owner === true,
    character_public: r.character_public === true,
    default_id: def ?? avatars.find((a) => a.is_default)?.id ?? null,
    avatars,
    ...(limits && typeof limits === 'object' && typeof limits.max_per_character === 'number' ? { limits } : {}),
  };
}

/**
 * What plays for this viewer: their own pick when it is still in the list,
 * else the list's default, else the first avatar. Null for an empty list.
 */
export function effectiveAvatar(list: AvatarLibraryList | null, pickId: string | null | undefined): AvatarItem | null {
  if (!list || list.avatars.length === 0) return null;
  const byId = (id: string | null | undefined) => (id ? list.avatars.find((a) => a.id === id) ?? null : null);
  return byId(pickId) ?? byId(list.default_id) ?? list.avatars[0];
}

/** Public avatars of a list (the ones that count for the public rule). */
export function publicCount(list: AvatarLibraryList): number {
  return list.avatars.filter((a) => a.is_public).length;
}

/**
 * The lock of this avatar cannot be opened to private: the character is
 * public and this is its last public avatar (the server enforces the same).
 */
export function isLastPublicLock(list: AvatarLibraryList, item: AvatarItem): boolean {
  return list.character_public && item.is_public && publicCount(list) <= 1;
}

/** Megabytes rounded to one decimal, for analytics (never exact sizes). */
export function mbBucket(bytes: number): number {
  return Math.round(bytes / 1e5) / 10;
}
