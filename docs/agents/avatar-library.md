# Avatar library (261106)

Server-stored avatars per character, shareable, with a public/private lock on
each one. Product feedback (261106): "store anima characters and live2d in
server, so we don't have to regenerate Sui or another public character for
every person. If a character has multiple avatars, the owner decides which
ones are public (small lock on each tile), but a public character keeps at
least one public. For Sui, run anima on her non-chibi avatar too and make
both public. By default show the non-chibi one."

The library spans both repos:

- sei-proxy: `src/avatars/` (routes, service, zip check, moderation), the
  per-avatar Anima request (`src/anima/service.ts`), migration
  `supabase/migrations/20261106120000_character_avatars.sql`.
- sei: `src/main/avatarLibrary/` (sync, download, upload, effective-avatar
  pick), `src/renderer/src/components/avatar/AvatarLibraryTiles.tsx` (tiles in
  the edit modal's Appearance section and on the character page's Avatar tab).

## What an avatar is

An avatar is how a companion appears as a living figure: the SeiLink room,
the floating avatar overlay, the call tile. It is not the card image. The
card image (`characters.portrait_image`) stays the identity picture on cards,
chat and Browse, and is still edited with the existing portrait picker.

| kind | bytes | what plays it |
|---|---|---|
| `portrait` | one PNG/JPEG/WebP | the Anima face set baked from it (`tha3-v1`), else its cutout |
| `live2d` | a zip with a `.model3.json`, `.moc3`, textures | AvatarView (Cubism) |
| `rig` | a zip with a `rig.json` and layer PNGs | RigView |
| `facepack` | a zip of a hand-made `sei-facepack` v1 | reserved: schema and storage accept it, the upload route answers 400 `bad_kind` in v1 |

A face set is not an avatar of its own: it is derived from a `portrait`
avatar, one bake per portrait hash, exactly as before (`anima_jobs`, dedupe
key `(kind, pipeline, portrait_hash)`). The library row's `content_sha256` IS
that portrait hash, so the proxy never re-downloads a library portrait to
hash it.

## Data model

`public.character_avatars`, one row per avatar of a character:

| column | meaning |
|---|---|
| `id` | uuid |
| `character_id` | `characters.id`, on delete cascade |
| `owner` | the character's owner when the row was made (auth.users, cascade) |
| `kind` | `portrait` / `live2d` / `rig` / `facepack` |
| `source` | `card` (mirrors the card image, at most one per character, updated in place when the card changes) or `upload` |
| `content_sha256` | sha256 of the stored bytes |
| `storage_path` | object path in bucket `avatars`, `<kind>/<sha256>.<ext>` |
| `bytes`, `mime` | size and type of the stored object |
| `name` | display name (model name or "Card image"), at most 80 chars |
| `is_public` | the lock: true = others can see and download it while the character is public |
| `is_default` | what plays when the viewer has not picked another (at most one per character) |
| `sort_order` | tile order (new rows go last) |
| `moderation_status` | `pending` / `clean` / `flagged` / `needs_review` (uploads); a `card` row follows the character's own `moderation_status` at read time |
| `meta` | small jsonb (model expression count, rig layer count), at most 8 KB |

Unique `(character_id, content_sha256)`: the same bytes twice on one
character are one avatar. Partial unique indexes keep one default and one
card row per character.

Clients never touch the table. RLS is on with no policies and every grant is
revoked from anon/authenticated, the same as `anima_*`. All writes go through
service-role RPCs that lock the character row first: `avatar_commit`,
`avatar_set_flags`, `avatar_delete`, `avatar_reorder`, plus
`avatar_gc_candidates` for the storage sweep.

## Storage layout and dedupe

Bucket `avatars`, PRIVATE (no storage policies; the proxy writes with the
service key and hands out signed URLs), 64 MB per object.

```
portrait/<sha256>.png|jpg|webp     one object per distinct image
live2d/<sha256>.zip                one object per distinct model zip
rig/<sha256>.zip
facepack/<sha256>.zip              (reserved)
staging/<user_id>/<uuid>           signed-upload landing spot, moved or deleted on commit
```

Content addressed: rows on different characters (or of different users) with
the same bytes share one object. Access is decided by rows, never by the
object, so a private row and a public row of the same bytes are fine. An
object is deleted only when no row references its path any more
(`avatar_delete` returns `orphan_path`; `avatar_gc_candidates` lists objects
left over by cascades and staging older than a day).

Upload is two steps so the bytes never pass through a Fly machine's request
body:

1. `POST /avatars/v1/:character_id/upload {kind, sha256, bytes, mime}`:
   checks owner, kind, size, count and quota. If an object for that kind and
   hash already exists: `{state:'exists'}`. Otherwise a signed upload URL to
   `staging/<user>/<uuid>` (`{state:'upload', upload:{url, path, expires_in}}`).
2. The client PUTs the bytes, then `POST /avatars/v1/:character_id/commit
   {kind, sha256, staging_path?, name?, source?, make_default?}`. The proxy
   downloads the staging object (at most 2 at a time per machine), checks the
   sha256 and the size, checks the content (image magic bytes; for a zip the
   central directory: entry count, extracted size, no absolute or `..` paths,
   the required entry file), moderates it, moves it to its content path and
   calls `avatar_commit`.

## The public rule

A public character (`characters.shared = true`) with at least one avatar row
keeps at least one public avatar. Enforced three times:

- In SQL, always: a constraint trigger on `character_avatars` raises
  `last_public_avatar` when an update or delete would leave a shared
  character with rows and none public. A trigger on `characters` (shared
  turning true) makes the default avatar public (or the card row, or the
  first row) when none is, so publishing never fails on it.
- In the RPCs: `avatar_set_flags` and `avatar_delete` check first and answer
  `last_public` (HTTP 409 `{error:'last_public'}`) instead of raising.
- In the UI: on a public character the lock of the last public avatar is
  disabled, with the tooltip "A public character needs at least one public
  avatar."

A character with no rows yet (everything made before this feature, until its
owner's app syncs) satisfies the rule trivially: its card image is already
public through the `portraits` bucket.

## Who can read what

| caller | sees |
|---|---|
| the character's owner | every row, with signed URLs, moderation state and flags |
| anyone signed in, character public (`shared`) or a default (owner = `DEFAULT_CHARACTERS_OWNER`), character moderation not `flagged`/`soft_flagged` | rows with `is_public` AND (source `card` OR moderation `clean`) |
| anyone else | nothing (403 for a private character, 404 for none) |

Private rows are never listed, signed or baked for anyone but the owner.
`default_id` in a non-owner list is the default when it is visible, else the
first visible row.

Signed URLs: `GET /avatars/v1/:character_id` signs every listed row in one
`createSignedUrls` call, 1 hour (`AVATAR_SIGN_TTL_S`). The client downloads at
once and keeps the bytes; a later download asks the list again.

## Routes

All behind originLockGate, ipRateLimitGate, verifyJwt and a per-user hourly
gate (in memory, per machine): list 600, upload 30, commit 30, flags 120,
delete 60, order 60.

| route | body | answer |
|---|---|---|
| `GET /avatars/v1/:character_id` | | `{character_id, is_owner, character_public, default_id, avatars[], limits}` |
| `POST /avatars/v1/:character_id/upload` | `{kind, sha256, bytes, mime}` | `{state:'exists'}` or `{state:'upload', upload}`; 400 `bad_kind`/`too_big`/`bad_request`, 403, 404, 409 `too_many`/`quota` |
| `POST /avatars/v1/:character_id/commit` | `{kind, sha256, staging_path?, name?, source?, make_default?}` | `{avatar, created}`; 400 `hash_mismatch`/`bad_content`/`missing_upload`, 403, 409 `too_many`/`quota` |
| `PATCH /avatars/v1/:character_id/:avatar_id` | `{is_public?, is_default?}` | `{avatars[]}`; 409 `last_public`/`not_shareable` |
| `DELETE /avatars/v1/:character_id/:avatar_id` | | `{avatars[]}`; 409 `last_public`/`card_avatar` |
| `POST /avatars/v1/:character_id/order` | `{ids[]}` | `{avatars[]}` |

An avatar item: `{id, kind, source, name, sha256, bytes, mime, is_public,
is_default, sort_order, moderation, shareable, url, expires_in}`. `shareable`
= public and visible to others right now.

Anima per avatar: `POST /anima/v1/request {character_id, avatar_id?}` and
`GET /anima/v1/status/:character_id?avatar_id=`. With `avatar_id` the proxy
bakes that portrait avatar (must be kind `portrait` and visible to the
caller), using its stored hash and a 48-hour signed URL as the worker's
portrait URL. Without it the old behaviour stays (the card image), so
shipped clients keep working. Caps and priority are unchanged: a default
character's bake never uses a weekly slot.

## Limits and moderation

The proxy caps avatars per character, zip and image size, and stored bytes
per user, and checks zips the same way the app's avatarStore does (entry
count, extracted size, safe paths, the required entry file). Uploads are
moderated before anyone else can see them: until a row is `clean` only its
owner sees it (with a note that it is waiting for review). A `card` row
follows the card image's own moderation. The numbers, thresholds and
operator steps are in the proxy repo (`sei-proxy/docs/avatar-library.md`).

## The app

- **Sync (owner)** runs when the owner opens the Appearance section or the
  Avatar tab, and after a local Live2D/rig import: it uploads the card image
  as the `card` row when the card hash changed, and uploads the local model
  when it has no library link yet. That is the migration of existing local
  Live2D avatars: nothing to opt into, a model that exists on disk is
  uploaded (private) the next time its owner opens the character. The
  manifest records the link (`AvatarManifest.library = {avatarId, sha256}`)
  so it is uploaded once. The zip is rebuilt from the stored files in a fixed
  order with fixed dates, so its hash is stable.
- **Effective avatar** (any viewer): the viewer's own pick
  (`UserConfig.avatar_prefs[id].avatar_id`, per user, never synced) when it is
  still listed, else the list's `default_id`. A `live2d`/`rig` effective
  avatar is downloaded once into the local avatar store (same import and
  normalization as a hand upload) when the store does not already hold those
  bytes. A `portrait` effective avatar asks Anima for that avatar's face set;
  a library-linked local model is then cleared so it does not shadow the face
  set (it is still on the server).
- **Other users' copies of a public character** download its public avatars
  instead of regenerating them: models through the signed URL, face sets
  through the per-avatar Anima request, which finds the existing bake by hash.
- **Tiles**: Appearance section (owner) lists every avatar as a tile with a
  lock (public/private) and a "Default" pick, plus Add image / Add model. The
  character page's Avatar tab shows the public ones to everyone and lets a
  viewer pick which one plays for them. Sharp corners, no button borders.

## Cost

Storage only: bakes stay one per portrait hash and a public avatar is stored
once for everyone, so the free tier stays at about zero marginal cost per
user. Figures are in the proxy repo doc.

## Sui

Her chibi card image becomes her `card` avatar (public) and an adult,
non-chibi portrait becomes a second public avatar and her default, with its
own Anima face set. Her card image does not change. The rows are seeded on
the server (operator script in the proxy repo); there is no bundled Sui data
to patch, since the bundle baseline was removed 260707 and Sui is cloud-only
(`src/shared/defaultCharacters.ts`).

## Analytics

Main sends these (shape only: kinds, sizes in MB buckets, counts, the
character id; never a file name, URL or model name):

| event | when | props |
|---|---|---|
| `avatar_uploaded` | a commit succeeded | kind, source `user`/`migration`/`card`, dedupe (bytes already stored), mb, moderation, own_character_public |
| `avatar_visibility_changed` | a lock was toggled | kind, to `public`/`private`, character_public, public_count |
| `avatar_default_changed` | the owner picked another default, or a viewer picked one | kind, by `owner`/`viewer`, from_kind |
| `avatar_downloaded_shared` | a non-owner's app downloaded a public model | kind, mb, ms |
| `avatar_library_failed` | any step failed | op `list`/`upload`/`commit`/`flags`/`delete`/`download`/`sync`, reason (closed set: `offline`, `signed_out`, `http_4xx` code, `too_big`, `too_many`, `quota`, `last_public`, `hash_mismatch`, `bad_content`, `import_failed`, `network`, `server`) |

## Deploy order

1. Apply the migration (Management API + history row, never `supabase db push`).
2. `fly deploy` sei-proxy (routes 404 until then; the app treats 404 as "no
   library" and keeps today's behaviour).
3. Seed Sui's rows and trigger her bake (script above).
4. Ship the client.
