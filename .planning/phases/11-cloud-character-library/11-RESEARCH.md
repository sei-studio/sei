# Phase 11: Cloud Character Library — Research

**Researched:** 2026-05-21
**Domain:** Supabase-backed character CRUD with offline-safe cache, image storage, GDPR/legal gating
**Confidence:** HIGH

## Summary

Phase 11 turns Sei from a local-file character store into a Supabase-authoritative one for signed-in users while preserving the v0.1.1 offline experience for "Continue Locally" mode. The phase is **backend-shape**: schema, RLS, Storage buckets, a sync queue, image validation, slug→UUID rename, legal pages + acceptance flow. UI touches are light (toggle, sync pill, modals) and reuse existing primitives (`Banner`, `DeleteConfirmModal`, `SignInModal` with `framingLabel`).

The build is well-derisked because Phase 10 already shipped the singleton Supabase client with PKCE + safeStorage session, the Edge Function convention (`supabase/functions/_shared/cors.ts`), the deletion_queue migration pattern, the IPC trust boundary with `IdSchema`, and the inline-upgrade `SignInModal` plumbing.

**Primary recommendation:** Direct `@supabase/supabase-js` calls from main process for character CRUD (RLS is the security gate); reuse the `deletion_queue` cron-purge pattern for orphan Storage cleanup; **public** Storage buckets for skins + portraits (cache + CDN benefits, RLS still gates writes); UUID becomes the canonical id with hardcoded UUIDs for the three bundled defaults; ship ToS + Privacy Policy as `terms.html` / `privacy.html` in `../sei-website/` linked from the app via `shell.openExternal`; `tos_acceptance` table gates the first cloud write.

## User Constraints (from CONTEXT.md)

### Locked Decisions

**State model (D-15..D-19):**
- D-15: Every NEW character created while signed-in is cloud-backed. No "private local-only" state for new signed-in chars. Legacy local-mode chars that pre-date sign-in stay local until promoted. Signed-out users keep v0.1.1 file-only behavior.
- D-16: Single `shared` boolean, default = `true` for signed-in users' new chars. Toggle on character page. `shared = false` keeps row + Storage but hides from Browse (Browse lights up Phase 12). Schema column ships now.
- D-17: Signed-out users see the same toggle, defaulted to private and disabled. Sliding to public opens `SignInModal` with `framingLabel = "share this character"` (reuses Phase 10 D-10 + the existing `'share this character'` literal in `useAuthStore.ts:24`).
- D-18: Local-first, mirror-cloud-immediately. Local write synchronous (GUI feels instant). Cloud upload fires in parallel. Sync pill: syncing / synced / sync failed — retry. Offline → enqueue. Last-write-wins on cloud.
- D-19: Cache-on-demand. On a new machine, Characters page lists cloud chars via Supabase; opening a character downloads + caches. Previously-opened chars survive offline. No eager prefetch.

**Migration UX (D-20):**
- One-shot local→cloud upload prompt at first sign-in for users who started in Continue Locally then signed up. Per-char checkbox. Requires ToS+PP acceptance. Skipped chars stay local + "local only" chip. Re-openable via Settings → "Migrate local characters".

**Identity (D-22, D-23, D-24):**
- D-22: Bundled defaults (`sui`/`lyra`/`clawd`) are read-only at the user level, NEVER uploaded to cloud regardless of `shared` value. Updates ship via app releases only. Stable hardcoded UUIDs in `defaultCharacters.ts`.
- D-23: UUID is canonical id. Local cache renames `<userData>/characters/<uuid>.json` + `<userData>/skins/<uuid>.png`. One-shot slug→uuid rename migration. Slug stays as a separate human-friendly field.
- D-24: Full-row mirror — every `CharacterSchema` field gets a column. Plus `metadata jsonb` escape hatch. Includes `last_launched` and `playtime_ms`.

**Legal (D-25, D-26, D-27):**
- D-25: Privacy Policy + ToS live at `../sei-website/terms.html` and `../sei-website/privacy.html`. Linked via `shell.openExternal`.
- D-26: Acceptance captured at sign-up (checkbox in form + OAuth first-time-callback). Phase 10 alpha accounts without an acceptance row get a blocking modal at next launch.
- D-27: `tos_acceptance(user_id, tos_version, privacy_version, accepted_at)` table + RLS (insert/select own only). Version bump → re-prompt via same modal.

**Images (D-28, D-29):**
- D-28: Skin: existing 64×64 RGBA rule, reuse `src/main/skinImageUtil.ts`. Portrait: PNG/JPEG/WebP, max 1024×1024 (client-side canvas downscale), max 500 KB ceiling after resize.
- D-29: Skin storage is uniform — every cloud-backed character's skin gets PNG bytes uploaded at `skins/<uuid>.png`, regardless of source (`upload`/`username`/`none`). No source-based branching. `skin.source` preserved in the row for UI provenance only.

### Claude's Discretion

- CRUD path: default to direct `supabase-js` + RLS for character CRUD. Use Edge Functions only when admin-privileged action is needed (e.g., cross-bucket Storage cleanup on delete cascade).
- Sync retry queue: simple persistent queue at `<userData>/sync-queue.json` mirroring `apiKeyStore.ts` atomic-write. Bounded retries, exponential backoff. Surface failure to inline sync pill.
- "local only" chip styling: match existing chip patterns.
- Migration modal copy: lead with "These characters are saved on this machine only. Upload any to your cloud library to access them from other devices?".
- Slug→UUID rename: one-shot startup migration similar to `runFirstLaunchMigration()`; idempotent; logged.
- Delete cascade: direct supabase delete (RLS owner-only) + Storage object cleanup. If Storage delete fails post-row-delete, log + don't block UI; orphan cleanup runs nightly via the same `deletion_queue` cron pattern.
- Conflict on stale local cache: last-write-wins from cloud on open. If local has unflushed pending writes, preserve them + flag `<row>.json.conflict` shadow file + banner. Rare edge case; can defer if cost is high.

### Deferred Ideas (OUT OF SCOPE)

- REQUIREMENTS.md wording fix for LIB-03 (one-line edit; not a Phase 11 deliverable).
- Cloud-fetched defaults table — out of scope per D-22.
- Conflict resolution UI for stale local cache — sketch only; full UX deferred.
- Per-character `recommended_model` hint — Future Requirements.
- Retroactive moderation scan for the Phase 11→12 window — Phase 12 planner deliverable per D-30.

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| LIB-01 | Character definition (name, description, system prompt, skin PNG, portrait image) stored in Supabase (Postgres + Storage), not user memory files | §Architecture: `characters` table schema (D-24) + `skins/` + `portraits/` Storage buckets. RLS = owner-or-shared read, owner-only write. |
| LIB-02 | Runtime memory (`OWNER.md`, `DIARY.md`, in-session context) stays local under `<userData>/memory/<id>/` — never synced | §Invariant Audit: nothing under `memory/` is referenced by cloud-write code paths. UUID rename touches `paths.memoryDir(id)` — verify it still resolves correctly. Plan must include a grep-gate: zero references to `paths.memoryDir` from any `supabase.from('characters')` or storage code path. |
| LIB-03 | On first sign-in, existing local characters offered for one-shot migration to cloud | §Migration: D-20 reframes this — modal lists user-created local chars (excludes bundled defaults), per-char checkbox, requires ToS+PP. Stored in renderer state; reopened from Settings. |
| LIB-04 | Cloud characters cached locally in existing `characters/<id>.json` + `skins/<id>.png` so bot runs offline against opened chars | §Cache-on-demand: lazy fetch on character open; write-through to same paths after UUID rename. Bot loop (utilityProcess) reads from local files unchanged. |
| LIB-05 | User can create/edit/delete characters from GUI; changes write through to Supabase + refresh local cache | §IPC: `chars.save` extends with cloud-mirror post-local-write (fire-and-forget into sync queue); `chars.delete` extends with `supabase.from('characters').delete()` + Storage cleanup. RLS = owner-only write enforces auth. |
| LIB-06 | Privacy policy + ToS live and accepted on first sign-in before any cloud write | §Legal: `terms.html` + `privacy.html` in `../sei-website/`; `tos_acceptance` table (D-27); accept-gate is checked main-side in every cloud-mirror call (defense in depth — RLS does NOT check `tos_acceptance`). |
| LIB-07 | Character creation/edit accepts skin upload (validated PNG, dim/size limits) + portrait image (validated, dim/size limits) | §Image Validation: skin reuses `skinImageUtil.ts` (64×64 RGBA). Portrait: client-side magic-byte detection (PNG/JPEG/WebP) + canvas resize to ≤1024×1024 + post-resize ≤500 KB ceiling; defense-in-depth re-validate in main. |

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|--------------|----------------|-----------|
| Character CRUD (read/write/delete) | Main process (Electron) | Supabase Postgres + RLS | Main owns Supabase client (`getClient()` is main-only per Phase 10 invariant). Renderer must not import `supabaseClient.ts`. RLS is the cloud-side security gate. |
| Skin + portrait byte storage | Main process | Supabase Storage | Main does the upload (`supabase.storage.from('skins').upload(...)`). Renderer hands bytes to main via IPC (base64-encoded for skin per existing pattern; portrait can also be base64 since it's already a data URL in `character.portrait_image`). |
| Local cache (file write) | Main process | — | `<userData>/characters/<uuid>.json` + `<userData>/skins/<uuid>.png` — same atomic-write pattern as today. |
| Sync queue | Main process | — | `<userData>/sync-queue.json` atomic-write. Replays on connectivity. Renderer observes queue state via IPC for the sync pill. |
| Public/private toggle UI | Renderer | — | `CharacterPage.tsx` adds a two-state toggle. Calls `chars.set-shared` IPC. Signed-out → opens `SignInModal` with framing. |
| ToS acceptance modal | Renderer | Main | Renderer mounts the modal; main owns the `auth:accept-tos` IPC that inserts the `tos_acceptance` row. |
| Skin server URL routing | Main process (local HTTP) | — | `skinServer.ts` continues to serve `/skins/<username>.png` — but the in-memory persona lookup is unchanged; only `paths.skinPngPath` shifts from slug to UUID. No URL contract change. |
| Image validation (portrait) | Renderer (client-resize + cap) | Main (defense-in-depth) | Renderer downscales via canvas → reduces upload bytes. Main re-validates magic bytes + caps because main is the trust boundary. |
| Bot loop reads | utilityProcess | Main writes the local cache file | utilityProcess (`src/bot/index.js`) reads `characters/<uuid>.json` via main-injected path. Cloud reads never happen in utilityProcess. |
| JWT for cloud calls | Main (Supabase client auto-attaches) | — | `supabase.from()` automatically uses the active session JWT. `authState.kind === 'signed_in'` gates every cloud call. |

## Project Constraints (from CLAUDE.md)

- **Three-process Electron architecture is load-bearing.** Mineflayer in utilityProcess only. Main owns Supabase client + safeStorage. Renderer NEVER imports `supabaseClient.ts` (Phase 10 invariant). [VERIFIED: `src/main/auth/supabaseClient.ts` docblock + `src/preload/index.ts`]
- **Closed action registry — LLM calls Zod-typed actions only.** Phase 11 does not touch this; calling out as a check-the-box invariant. [VERIFIED: CLAUDE.md Architecture #2]
- **Every external call has a timeout.** Cloud calls — both `supabase.from()` and `supabase.storage.upload()` — must have wall-clock timeouts via AbortController. [VERIFIED: CLAUDE.md Critical Pitfalls]
- **`@electron/rebuild` in postinstall.** Phase 11 adds no native dep (no `sharp`, no `better-sqlite3`); portrait resize uses HTMLCanvas in the renderer. [VERIFIED: package.json — no native deps added]
- **GSD workflow: read STATE + ROADMAP before starting work; commit planning docs alongside code.** [VERIFIED: STATE.md + ROADMAP.md read in this research]

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@supabase/supabase-js` | 2.106.1 (latest) | DB queries + Storage uploads + Auth (already a Phase 10 dep at `^2.106.0`) | Singleton already wired in `src/main/auth/supabaseClient.ts`. Built-in retry on transient errors as of v2.102.0 (HTTP 408/409/503/504 + network failures). [VERIFIED: npm registry, supabase docs] |
| Existing Phase 10 Edge Function pattern (Deno) | — | Reuse `supabase/functions/_shared/cors.ts` + `delete-me/index.ts` shape **only if** a privileged action is needed | D-13 sets the convention. Default Phase 11 path is direct supabase-js + RLS — Edge Functions add cold-start cost and ops surface; not warranted for character CRUD. [VERIFIED: `supabase/functions/delete-me/index.ts`] |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| Built-in `node:crypto.randomUUID()` | Node 20+ | Generate UUIDs for new characters | Available everywhere — Electron 42 bundles Node 22. No dep needed. [VERIFIED: Node 20+ stable API] |
| Built-in `HTMLCanvasElement.toBlob` | — | Renderer-side portrait downscale to ≤1024×1024 + re-encode to PNG/JPEG/WebP | No sharp / native module needed. Runs in renderer where canvas exists. |
| Existing `src/bot/brain/storage/atomicWrite.js` + `fileLock.js` | — | Reuse for sync-queue + UUID rename | Already used by `characterStore.ts` + `skinStore.ts` + `apiKeyStore.ts`. Pattern is locked. |
| Existing `src/main/skinImageUtil.ts` | — | Skin PNG magic + IHDR + 64×64 RGBA validation | D-28 — reuse unchanged. Add a sibling `portraitImageUtil.ts` for portrait magic+dims validation in main. |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Direct `supabase.from('characters').upsert()` from main | RxDB Supabase Replication Plugin | RxDB ships a full offline-first sync pipeline. Overkill for Phase 11's cache-on-demand model (D-19 explicitly rejects eager prefetch). Adds a heavyweight dep + a new local DB. Defer; revisit if Phase 11+ adds bidirectional sync. [CITED: rxdb.info/replication-supabase.html] |
| Public Storage buckets | Private buckets + signed URLs | Public bucket = predictable URL + CDN cache + zero signing latency. Signed URLs would force every read through a 60s URL-mint round-trip — wrong shape for a cached `<uuid>.png` that the renderer caches indefinitely. Write protection comes from RLS on `storage.objects` keyed to `auth.uid()` and the bucket path's first segment. RECOMMENDED: PUBLIC buckets. [CITED: supabase.com/docs/guides/storage/buckets/fundamentals; dev.to/kanta13jp1/supabase-storage-deep-dive] |
| `sharp` (native) for portrait resize in main | `HTMLCanvasElement` in renderer | sharp is faster but adds a native dep (`@electron/rebuild` already burdened). Canvas is plenty fast for 1024×1024 one-shot resizes done at upload time. RECOMMENDED: canvas in renderer. |
| `better-sqlite3` for the sync queue | JSON file via `atomicWrite` | A SQLite-backed queue is sturdier under crashes but requires a native module. A JSON file at `<userData>/sync-queue.json` with `apiKeyStore`-style atomic-write covers the actual failure modes (write-after-crash is guarded by atomic rename). RECOMMENDED: JSON file. |
| Slug-as-id with parallel UUID column | UUID-as-id with slug as separate field | D-23 locks UUID-as-id. Slug becomes a non-unique human-readable field. The grep-audit in Step 2.5 below catches places where slug-as-filename still leaks. |

**Installation:**

No new npm deps required. `@supabase/supabase-js` is already at `^2.106.0` (resolves to current 2.106.1).

**Version verification:**

```bash
npm view @supabase/supabase-js version    # → 2.106.1 (verified 2026-05-21)
```

[VERIFIED: npm registry, 2026-05-21]

## Architecture Patterns

### System Architecture Diagram

```
                       Renderer (React)
                              |
                              | IPC (chars.save / chars.delete / chars.set-shared
                              |      tos.status / tos.accept / migration.* / sync.status)
                              v
+-------------------------+   |   +-----------------------------------------+
| User picks portrait img |---|-->| Main: validate magic + canvas-resize    |
| (PortraitImagePicker)   |   |   |       cap @ 1024px / 500KB              |
+-------------------------+   |   +-----------------------------------------+
                              v
              +-------------------------------------+
              | Main: characterStore.saveCharacter  |
              |   (local atomic write — D-18 first) |
              +-------------------------------------+
                              |
                +-------------+----------------+
                |                              |
                v                              v
   <userData>/characters/<uuid>.json    +---------------------+
   <userData>/skins/<uuid>.png          | sync-queue.json     |
   (cache, primary read path for        | enqueue upsert +    |
    bot supervisor + skin server)       | storage upload      |
                                        +---------+-----------+
                                                  |
                                  online + signed_in + tos_accepted?
                                                  |
                                                  v
                                +-------------------------------------+
                                | Supabase                            |
                                |   - characters table (Postgres+RLS) |
                                |   - storage.objects: skins/<uuid>   |
                                |   - storage.objects: portraits/<uuid>|
                                |   - tos_acceptance (gate)           |
                                +-------------------------------------+

         Cloud-fetch path (cache-on-demand, D-19):
            chars.list (renderer) -> main -> supabase.from('characters').select()
                                              -> merge with local cache view
            chars.open -> main: fetch row + download skin + portrait if missing
                              -> write to <uuid>.json + <uuid>.png locally

         Bot loop (utilityProcess) — UNCHANGED data flow:
            reads <userData>/characters/<uuid>.json + skin via local skinServer

         Skin server (main, loopback HTTP):
            GET /skins/<username>.png  →  in-memory persona lookup  →  resolveSkinPng
              (file path resolution shifts from slug to UUID via paths.skinPngPath
               UPDATE — URL contract unchanged)
```

### Component Responsibilities

| File | Responsibility | Phase 11 Change |
|------|---------------|-----------------|
| `src/shared/characterSchema.ts` | Zod schemas | Add `shared: z.boolean().default(true)`. Change `id` semantics from slug to UUID (regex update to UUID v4 form). Slug becomes a separate optional `slug` field. |
| `src/main/paths.ts` | Path resolvers | Add `portraitPath(uuid)` (today `portrait_image` is inlined as a base64 data URL — see "Portrait pipeline change" below); add `syncQueuePath()`. Existing `characterPath` / `skinPngPath` keep their signatures — caller passes a UUID now. |
| `src/main/characterStore.ts` | Local CRUD | `saveCharacter` adds a fire-and-forget enqueue to the sync queue after the local write lands. `deleteCharacter` extends with cloud-delete + Storage cleanup enqueue. |
| `src/main/skinStore.ts` | Skin bytes | `applyPng` enqueues a Storage upload after local write. Path regex updated for UUID. |
| `src/main/skinServer.ts` | Local HTTP skin server | **NO URL contract change** — still `/skins/<username>.png`. The username→character lookup in `readSkinPng` unchanged; only `paths.skinPngPath` resolves to a UUID-named file. |
| `src/main/skinImageUtil.ts` | Skin validation | Unchanged. |
| `src/main/portraitImageUtil.ts` (NEW) | Portrait validation | Magic bytes for PNG (89 50 4E 47), JPEG (FF D8 FF), WebP (52 49 46 46 ... 57 45 42 50). Dimension check (≤1024×1024). Byte cap (≤500 KB). |
| `src/main/migration.ts` | First-launch migration | Extend with the slug→UUID rename pass — see "Migration patterns" below. |
| `src/main/defaultCharacters.ts` | Bundled defaults | Add hardcoded UUIDs for `sui`, `lyra`, `clawd`. Default JSON files in `resources/default-characters/` get their `id` field changed to the UUID + a new `slug` field. Memory dir path keys off the new UUID. |
| `src/main/auth/supabaseClient.ts` | Singleton | Unchanged. All Phase 11 cloud calls go through `getClient()`. |
| `src/main/auth/authState.ts` | State machine | Add a helper `isCloudWriteAllowed()` that returns `true` only when `kind === 'signed_in'` AND ToS is accepted AND email is verified (per Phase 10 D-04). |
| `src/main/auth/exportBuilder.ts` | Export envelope | Fill `characters[]` by calling `supabase.from('characters').select('*').eq('owner', user.id)` — D-14 reserved slot. |
| `src/main/syncQueue.ts` (NEW) | Persistent retry queue | `enqueueUpsert(uuid)`, `enqueueDelete(uuid, storagePaths)`, `processNext()`. Exponential backoff (1s, 5s, 30s, 5min, give up). Replays on `authState` becoming `signed_in` + on network reconnect (Electron's `net.online`). |
| `src/main/cloudCharacterClient.ts` (NEW) | Thin wrapper over `supabase.from('characters')` | `upsertCharacter(row)`, `deleteCharacter(uuid)`, `listMyCharacters()`, `downloadCharacter(uuid)`, `uploadSkin(uuid, bytes)`, `uploadPortrait(uuid, bytes)`, `deleteStorageObjects(paths[])`. All calls wrapped in 15s AbortController timeout (Phase 10 pattern). |
| `src/main/ipc.ts` | IPC | New channels: `chars:set-shared`, `tos:status`, `tos:accept`, `migration:list-local`, `migration:upload`, `sync:status`, `sync:retry`. |
| `src/renderer/src/screens/CharacterPage.tsx` | UI | Add public/private toggle. Signed-out path opens `SignInModal({ framingLabel: 'share this character' })` — already in the `UpgradeFraming` union. |
| `src/renderer/src/screens/HomeScreen.tsx` | UI | Add "local only" chip on legacy local-mode cards. Add inline sync pill (`StatusPill` reuse) on each cloud-backed card. |
| `src/renderer/src/screens/SettingsScreen.tsx` | UI | Add "Migrate local characters" entry under Account panel. |
| `src/renderer/src/components/Banner.tsx` | UI | Reuse for the legacy-account ToS+PP re-acceptance banner (D-26). |
| `src/renderer/src/components/AcceptToSModal.tsx` (NEW) | UI | Blocking modal with checkbox + two `shell.openExternal` links. Reuses `DeleteAccountModal.tsx`'s structural pattern. |
| `src/renderer/src/components/MigrateLocalCharsModal.tsx` (NEW) | UI | Per-character checkbox list + Upload action + Skip-all dismissal. |
| `supabase/migrations/<ts>_characters_tos.sql` (NEW) | Schema | `characters` table + `tos_acceptance` table + RLS policies. |
| `supabase/migrations/<ts>_storage_buckets.sql` (NEW) | Schema | Create `skins` + `portraits` public buckets + storage.objects RLS. |
| `supabase/migrations/<ts>_storage_purge_extend.sql` (NEW) | Schema | Extend `purge-deletion-queue` cron body to actually delete Storage objects per `storage_paths` entry (fulfills Phase 10's deferred BL-03 follow-on). |
| `../sei-website/terms.html` (NEW) | Legal | ToS body. |
| `../sei-website/privacy.html` (NEW) | Legal | Privacy Policy body. |
| `../sei-website/index.html` | Legal links | Footer additions to `terms.html` / `privacy.html`. |

### Pattern 1: Supabase characters table + RLS (D-24)

**What:** Full-row mirror of `CharacterSchema` with a `metadata jsonb` escape hatch.
**When to use:** Always — the canonical cloud shape.
**SQL sketch (planner refines exact column types):**

```sql
-- Source: D-24 (CONTEXT) + STACK.md §1 RLS sketch + 2026 Supabase docs
create table public.characters (
  id              uuid primary key,                       -- caller supplies; matches client UUID
  owner           uuid not null references auth.users(id) on delete cascade,
  slug            text,                                   -- human-readable, NOT unique (multiple users can have 'sui'-shaped slugs)
  name            text not null,
  persona_source  text not null,
  persona_expanded text not null default '',
  -- Skin
  skin_source     text not null default 'none',          -- 'bundled' | 'upload' | 'username' | 'none'
  mojang_username text,
  skin_png_sha256 text,
  skin_applied_at timestamptz,
  -- Other character fields
  username        text,
  is_default      boolean not null default false,        -- always false in cloud (bundled defaults never reach cloud per D-22)
  shared          boolean not null default true,         -- D-16
  created_at      timestamptz not null default now(),
  last_launched   timestamptz,
  playtime_ms     bigint not null default 0,
  portrait_image  text,                                  -- Storage object path 'portraits/<uuid>.png' OR null
  -- Escape hatch
  metadata        jsonb not null default '{}'::jsonb,
  updated_at      timestamptz not null default now()
);
create index on public.characters (owner);
create index on public.characters (shared, updated_at desc) where shared = true; -- Phase 12 Browse path
-- Optional Phase 12 prep: full-text search index, ship now or defer
-- create index on public.characters using gin (to_tsvector('english', name || ' ' || coalesce(persona_source, '')));

alter table public.characters enable row level security;

-- Read: shared OR owner
create policy "characters_select" on public.characters
  for select using (shared = true OR owner = auth.uid());

-- Write (insert/update/delete): owner only
create policy "characters_insert" on public.characters
  for insert with check (owner = auth.uid());
create policy "characters_update" on public.characters
  for update using (owner = auth.uid()) with check (owner = auth.uid());
create policy "characters_delete" on public.characters
  for delete using (owner = auth.uid());

-- updated_at trigger
create or replace function public.tg_set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
create trigger characters_set_updated_at before update on public.characters
  for each row execute function public.tg_set_updated_at();
```

`is_default` is always `false` in cloud rows because bundled defaults never reach cloud (D-22) — but ship the column anyway for forward-compat with a hypothetical Phase 12+ cloud-fetched defaults table.

### Pattern 2: tos_acceptance table + RLS (D-27)

```sql
-- Source: D-27 (CONTEXT)
create table public.tos_acceptance (
  user_id          uuid not null references auth.users(id) on delete cascade,
  tos_version      text not null,
  privacy_version  text not null,
  accepted_at      timestamptz not null default now(),
  primary key (user_id, tos_version, privacy_version)
);

alter table public.tos_acceptance enable row level security;
create policy "tos_select_own" on public.tos_acceptance
  for select using (user_id = auth.uid());
create policy "tos_insert_own" on public.tos_acceptance
  for insert with check (user_id = auth.uid());
-- No update/delete policies — acceptance is immutable.
```

Versions are app-defined string constants (e.g., `"2026-05-21"` or `"v1"`). Bump → app prompts re-acceptance via blocking modal.

### Pattern 3: Storage buckets with RLS (D-29)

**What:** Two public buckets — `skins` and `portraits` — with RLS on `storage.objects` keyed to the path's first segment.
**Why public:** Avatars + portraits are read-on-render assets. Public bucket → predictable CDN-cached URL. Write protection comes from RLS, not from URL obscurity. [CITED: supabase docs]
**Key strategy:** `skins/<uuid>.png` and `portraits/<uuid>.png`. RLS uses `storage.foldername(name)[1]` — see the **Storage RLS path layout caveat** below.

```sql
-- Pseudo: planner should run via mcp__supabase__apply_migration or supabase CLI
-- The buckets are created via the dashboard or the supabase.storage.createBucket() admin API.
-- Public read: anyone can GET; only the owner can INSERT/UPDATE/DELETE.

-- Anyone can read (skins + portraits buckets)
create policy "public_read_skins" on storage.objects
  for select using (bucket_id = 'skins');
create policy "public_read_portraits" on storage.objects
  for select using (bucket_id = 'portraits');

-- The character row's owner can write the object whose name is '<uuid>.png'
-- and whose <uuid> is the id of a row this user owns.
create policy "owner_write_skins" on storage.objects
  for all
  using (
    bucket_id = 'skins'
    and auth.uid() = (
      select owner from public.characters
      where id::text = regexp_replace(name, '\.png$', '')
    )
  )
  with check (
    bucket_id = 'skins'
    and auth.uid() = (
      select owner from public.characters
      where id::text = regexp_replace(name, '\.png$', '')
    )
  );
-- (Identical policy on bucket 'portraits'.)
```

**Storage RLS path layout caveat:** Supabase docs recommend `<user_id>/<file>` so RLS can use `storage.foldername(name)[1] = auth.uid()`. We use `<uuid>.png` flat keying because UUIDs are globally unique and the character row carries the ownership relation. That means RLS needs the subquery shown above — it's a sub-select per write, fine for write-rate but worth flagging. **Alternative layout:** `<owner_uuid>/<character_uuid>.png` — let the planner choose. The flat layout is simpler for the renderer's "construct the URL from the character row alone" UX; the nested layout is faster RLS check + matches Supabase's recommended pattern. [CITED: dev.to/asheeshh/mastering-supabase-rls; supabase.com/docs/guides/storage/security/access-control]

### Pattern 4: Sync queue (Claude's discretion)

**Shape:** `<userData>/sync-queue.json`. Array of pending ops:

```ts
type SyncOp =
  | { kind: 'upsert'; uuid: string; queuedAt: string; attempts: number; nextAttemptAt: string }
  | { kind: 'delete'; uuid: string; storagePaths: string[]; queuedAt: string; attempts: number; nextAttemptAt: string };
```

**Processing:**
- Trigger: every `chars.save` / `chars.delete` enqueues. A drainer fires on `auth:state` → signed_in, on `online` event, and on every successful op.
- Backoff: 1s, 5s, 30s, 5min, 30min, give up (attempt 6 → mark failed, surface via `sync:status` IPC).
- For upserts, the queue stores the UUID only — the drainer re-reads the current local file at drain time so it ships the latest content (not whatever was at enqueue time). This means a fast-then-slow burst of edits collapses to one upsert.
- For deletes, the queue stores the full `storagePaths` array because the local row is gone.
- Atomic write of the queue file via `atomicWrite` + `withFileLock` mirroring `apiKeyStore` / `sessionStore`.

**This is NOT a full offline-first sync engine.** Cache-on-demand (D-19) means we don't try to replay reads. RxDB-style sync would be over-engineering for the explicit "last-write-wins, no merge UI" stance in D-18. [CITED: rxdb.info on offline-first considerations]

### Pattern 5: Portrait pipeline change (D-28)

**Current state (v0.1.1):** Portrait is stored as a **base64 data URL inline in `character.portrait_image`** (see `src/renderer/src/components/PortraitImagePicker.tsx`, capped at 512 KB encoded). It is NOT a file on disk despite `paths.characterPortraitPath(id)` existing. [VERIFIED: grep audit + PortraitImagePicker source read]

**Phase 11 change:**
- Portrait moves to its own file/object — `portraits/<uuid>.png` in Storage, mirrored at `<userData>/portraits/<uuid>.png` (or similar — planner decides exact path; D-28 doesn't pin the local layout).
- `character.portrait_image` field becomes a **path reference** (e.g., `portraits/<uuid>.png`) instead of a base64 data URL. Existing local chars whose `portrait_image` is a base64 data URL need migration: at slug→UUID rename time, also decode the data URL bytes → write to `<userData>/portraits/<uuid>.png` → replace field with the path reference.
- Renderer's `PixelPortrait.tsx` accepts either a `file://` path (local cache) or a public Storage URL (cloud render); planner picks one. **Recommendation:** ship a tiny `portrait:get-url(uuid)` IPC that returns the local file URL when cached, else the Storage URL (lets renderer always pass the same string to `<img src>`).
- Validation rules (LIB-07 / D-28): PNG / JPEG / WebP magic, ≤1024×1024 (renderer canvas resize if larger), ≤500 KB after resize. Defense-in-depth re-validation in main via `portraitImageUtil.ts`.

### Pattern 6: Slug→UUID rename migration

**What:** One-shot startup migration in `runFirstLaunchMigration()` chain in `src/main/index.ts`.
**Steps (idempotent):**

1. Read `<userData>/characters/index.json`.
2. For each `id` in `order`:
   - If `id` is already a UUID v4 → skip (already migrated).
   - Else (slug like `sui`, `lyra`, `clawd`, or a user-created kebab slug):
     - Look up the target UUID:
       - For bundled defaults: from the hardcoded UUID table in `defaultCharacters.ts`.
       - For user-created chars: generate `crypto.randomUUID()` and persist in the migration manifest.
     - Read `<userData>/characters/<slug>.json`; rewrite into `<userData>/characters/<uuid>.json` with `id` updated (and a new `slug` field carrying the old slug for human-readability).
     - Rename `<userData>/skins/<slug>.png` → `<userData>/skins/<uuid>.png` if it exists.
     - Rename `<userData>/memory/<slug>/` → `<userData>/memory/<uuid>/` if it exists. **Critical** — LIB-02 invariant says runtime memory stays local but the directory key still needs to follow the rename.
     - For chars whose `portrait_image` is a base64 data URL: decode + write to `<userData>/portraits/<uuid>.png`; replace `portrait_image` with the path reference.
     - Update `index.json` order entry.
     - Delete the old slug-keyed files (post-write).
3. Write a migration manifest at `<userData>/migration-uuid-rename.json` so this never re-runs.

**Rollback safety:** Until step 3 commits, the slug files still exist. Crash mid-migration → next launch re-applies idempotently (uuid file already exists → skip). The manifest is the "done" marker.

**Interaction with `is_default`:** Defaults are detected by their hardcoded UUID. After rename, `defaults-seeded.json` (existing tracker) is also updated to reference UUIDs. The existing `'sui' is undeletable` rule in `ipc.ts:135` (`if (id === 'sui') throw`) becomes a generic `is_default` check.

### Pattern 7: ToS acceptance gate

**On sign-up (D-26):**
- `SignInModal.tsx` (signup mode) gains a required checkbox: "I agree to the [Terms of Service] and [Privacy Policy]". Links open via `shell.openExternal` to `https://sei.gg/terms.html` and `/privacy.html`. The submit button is disabled until checked.
- After successful `signUp()`, main writes the `tos_acceptance` row via `supabase.from('tos_acceptance').insert(...)`. Failure logs but does not block sign-up — the next cloud-write attempt will re-prompt.
- Google OAuth: the loopback callback handler in `loopbackPkce.ts` already runs main-side. After `exchangeCodeForSession`, check `supabase.from('tos_acceptance').select().eq('user_id', user.id).limit(1)`. If empty → mount the blocking modal in the renderer before completing the sign-in transition (i.e., before `transitionToSignedIn`).

**On launch for legacy Phase 10 alphas (D-26):**
- After `initAuthState` resolves session → if `kind === 'signed_in'` AND no `tos_acceptance` row exists → mount `AcceptToSModal` as a blocking overlay. The modal prevents all cloud-mirror code paths (the `isCloudWriteAllowed()` helper checks both auth state AND tos status).

**Version bump:** Storing `tos_version` and `privacy_version` as constants in `src/shared/legalVersions.ts` (e.g., `TOS_VERSION = '2026-05-21'`). At launch, query: `select tos_version, privacy_version from tos_acceptance where user_id = $1 order by accepted_at desc limit 1`. If returned row's versions don't match constants → re-prompt.

### Pattern 8: Bundled defaults UUID assignment (D-22)

**What:** Hardcode three UUIDs in `defaultCharacters.ts`:

```ts
// Source: D-22 + D-23 — stable UUIDs frozen at first 11-* commit so
// every install resolves the same default character to the same key.
// Generated once via crypto.randomUUID() and never regenerated.
export const DEFAULT_CHARACTER_UUIDS = {
  sui:   '<frozen uuid v4 — generate once during plan execution>',
  lyra:  '<frozen uuid v4>',
  clawd: '<frozen uuid v4>',
} as const;
```

**Why this matters:** The defaults' UUIDs become primary keys in any user's local cache (and the slug→uuid migration above keys off them). They must be **stable across machines** for resource-loading parity (the bundled PNG under `resources/skins/<slug>.png` is keyed by slug, not UUID — `bundledSkinPath` reads `DEFAULT_CHARACTERS.some(c => c.id === ...)` which becomes `some(c => c.id === uuid)` after the rename; `resources/skins/<slug>.png` stays slug-keyed because that's the shipped asset path).

**Never uploaded to cloud:** The cloud-mirror code path (every `supabase.from('characters').upsert(row)` call site) must check `if (row.is_default === true) return` BEFORE the upsert. This is a runtime invariant; also surface as a grep-gate verification step (e.g., "the upsert is called only inside a code path that has just checked `!is_default`").

### Anti-Patterns to Avoid

- **Storing the portrait as a base64 data URL in the cloud row.** It's how v0.1.1 ships, but it bloats the Postgres row, defeats CDN caching, and pushes Postgres against its 8KB-row sweet spot. Moving to Storage is non-negotiable for Phase 11.
- **Using anonymous Supabase calls for character CRUD.** The Phase 10 client is already PKCE + session-aware; every `supabase.from('characters')` call automatically carries the JWT — but only if the client was instantiated by the time of the call. Verify the cloud-mirror code path never short-circuits the session restore.
- **Trusting RLS for ToS gating.** RLS does NOT check `tos_acceptance`. The block must be in main-side code (`isCloudWriteAllowed()`). A user with a stolen JWT bypassing the client would land in Supabase still being blocked by `characters_insert` RLS (owner-only), but the ToS check is a client-side defense and the planner must wire it correctly.
- **Uploading the bundled-default skin PNG to cloud.** D-22 — never. Even if the user toggles `shared = true`, the row + objects don't go up.
- **Eager prefetch on sign-in.** D-19 — cache-on-demand only. A new machine's Characters page shows cloud rows from a list query; opening triggers download. Never pre-pull all skins/portraits on sign-in.
- **Synchronous cloud upload in the chars.save handler.** D-18 — local first, mirror in parallel via the sync queue. Blocking the IPC on cloud latency makes the GUI feel laggy.
- **A separate Edge Function for character CRUD.** Cold-start cost + ops surface for no gain (RLS already provides authz). Only use Edge Functions for admin-privileged actions (e.g., cross-bucket Storage cleanup when the user deletes their account — but that already lives in `delete-me`).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| JWT verification + user identification on cloud writes | Custom JWT decoder | `supabase.from()` calls automatically attach the session JWT; RLS evaluates `auth.uid()` | The Phase 10 client is already PKCE + autoRefresh + storage-adapter wired. The JWT machinery is invisible at the call site. |
| Authz on character rows | App-side `if (row.owner === currentUser.id)` checks | RLS policies (owner-or-shared read, owner-only write) | The Supabase docs are explicit: RLS at the table is the security boundary; client-side checks are defense-in-depth at best, fraud at worst. [CITED: dev.to/asheeshh/mastering-supabase-rls] |
| Image resize | Native `sharp` install | `HTMLCanvasElement.toBlob` in renderer | Already-present platform API. No native-dep ABI risk. Sufficient for 1024×1024 one-shot. |
| Retry on transient supabase failure | Custom retry loop | Built-in (supabase-js v2.102.0+) auto-retries on HTTP 408/409/503/504 + network. Our sync queue handles longer-term retry (offline / dead network) | Don't double-layer retries — the queue handles "user offline for 2 hours"; supabase-js handles "5xx for 3 seconds". [CITED: supabase.com/docs/guides/api/automatic-retries-in-supabase-js] |
| UUID generation | Random string from custom RNG | `crypto.randomUUID()` (Node 20+ built-in) | Crypto-quality, no dep. |
| File-system path safety | New per-file regex | Existing `IdSchema` in `ipc.ts`, regex bumped to UUID v4 form | Defense-in-depth already in place. |
| Atomic file writes | Roll-your-own tmp+rename | `src/bot/brain/storage/atomicWrite.js` + `fileLock.js` | Already-proven; used by every Phase 10 store. |
| Edge Function templating | New Deno project | Phase 10's `supabase/functions/_shared/cors.ts` + `delete-me/index.ts` shape | If a privileged action is needed at all in Phase 11, reuse the convention. Almost certainly NOT needed for direct CRUD. |
| ToS/Privacy boilerplate text | Write from scratch | Iubenda / Termly generator ($5–15/mo) OR hand-write tied to our actual data practices (Anthropic + Supabase subprocessors listed) | Per Pitfall 11. The wording can be derived from a generator but the subprocessor list (Anthropic, Supabase, future Lemon Squeezy) MUST be accurate. |

**Key insight:** Phase 11 is mostly **gluing existing primitives** — the Phase 10 Supabase client, the existing atomic-write helpers, the `IdSchema` boundary, the `SignInModal` framing — into new IPC handlers + SQL schema. The only genuinely new code is (1) `cloudCharacterClient.ts` (thin supabase-js wrapper with timeouts), (2) `syncQueue.ts`, (3) `portraitImageUtil.ts`, (4) the slug→UUID migration, and (5) the SQL migration. Plus three modals (ToS accept, migrate local, sync pill is a `StatusPill` reuse).

## Runtime State Inventory

This phase is **partly rename/refactor** (slug→UUID rename of existing on-disk files) and **partly greenfield** (cloud schema, new buckets, new tables). The rename half needs an explicit inventory.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | (1) `<userData>/characters/<slug>.json` for `sui`, `lyra`, `clawd` and any user-created slugs. (2) `<userData>/skins/<slug>.png` (when source ≠ bundled). (3) `<userData>/memory/<slug>/` (PLAYER.md, MEMORY.md). (4) `<userData>/characters/index.json` `order: [slug, ...]`. (5) `<userData>/defaults-seeded.json` `ids: [slug, ...]`. (6) `character.portrait_image` field contains a **base64 data URL** inline (not a file path), per `PortraitImagePicker.tsx`. | Slug→UUID rename: file content (id field), file names (json, png, memory dir), index.json order array, defaults-seeded.json ids. Portrait data URL: decode bytes + write to `<userData>/portraits/<uuid>.png` + replace field with path reference. ALL of these are local-only state — no cloud-side equivalents. Both a code edit (write new UUID-keyed paths) AND a data migration (rewrite existing rows). |
| Live service config | **None for Phase 10 carryover.** Supabase project has 1 table (`deletion_queue`) and 1 Edge Function (`delete-me`) live, neither of which holds character data yet. Phase 11 introduces the first character row + first Storage objects — they're greenfield. | None for the rename. New work: Supabase Storage buckets `skins` + `portraits` must be created via dashboard or `supabase.storage.createBucket()` admin API — verify whether the planner does this via `mcp__supabase__apply_migration` (SQL) or a manual dashboard step. Note: bucket CREATION via SQL works (`insert into storage.buckets`) but the recommended path is the dashboard or admin API. |
| OS-registered state | **None.** Sei has no Windows Task Scheduler / launchd / systemd registrations. The skin server is loopback-only and ephemeral. The CustomSkinLoader URL on the user's MC client embeds the skin server's loopback port + `/skins/<username>.png` — **but the URL format is unchanged** (username, not slug), so MC clients don't need re-registration. | None. Explicitly verified: no MC-side registration encodes the slug. |
| Secrets / env vars | `SUPABASE_URL` + `SUPABASE_ANON_KEY` in `.env` (Phase 10 — unchanged). `apiKeyStore.ts` (`<userData>/api_key.bin`) and `sessionStore.ts` (`<userData>/session.bin`) are key-by-content, not by character. No env var or secret references a character slug. | None — verified by `grep -rni 'slug\|sui\|lyra\|clawd' .env*` returning nothing relevant. |
| Build artifacts / installed packages | `resources/default-characters/<slug>.json` (bundled). `resources/skins/<slug>.png` (bundled). Both are SLUG-KEYED on purpose — they're the shipped assets and stay slug-keyed across the UUID rename (the runtime maps slug→UUID at seed time). `defaults-seeded.json` ids array migrates to UUIDs. No `.egg-info`-style artifacts in this Node/Electron project. | The bundled JSON's `id` field changes from slug to UUID at build-time (edit the three `resources/default-characters/<slug>.json` files). The bundled PNG files keep their slug filenames (the asset path is slug-keyed; `bundledSkinPath` resolves slug via `DEFAULT_CHARACTERS.find(c => c.id === uuid)?.slug` after the rename — planner refines the exact lookup direction). |

**The canonical question:** After every file in `<userData>` is renamed slug→UUID, what runtime systems still have the old slug cached, stored, or registered? — **Only the bundled assets under `resources/`, which we keep slug-keyed deliberately because they're version-controlled in the repo.** Everything else (memory dir, skin PNG, character JSON, index order, defaults-seeded tracker) gets renamed in the migration pass.

## Common Pitfalls

### Pitfall 1: Migration kicks off before authState is ready
**What goes wrong:** The slug→UUID rename runs in `runFirstLaunchMigration()` which fires from `src/main/index.ts` during boot. The ToS acceptance check + the first cloud-mirror call depend on `authState` being resolved. If migration races ahead, the local files are renamed but the cloud upload (e.g., for an already-signed-in legacy alpha user mid-update) might fire before `tos_acceptance` is enforced.
**Why it happens:** Boot ordering — migration is currently called before `initAuthState`, but Phase 11 adds new boot steps.
**How to avoid:** Migration runs purely local-side (no cloud calls). The first cloud-write opportunity is gated by `isCloudWriteAllowed()` which fails closed when ToS isn't accepted. Explicit verify: grep the migration code path for any `supabase.from(...)` call — must be zero hits.
**Warning signs:** A test scenario: legacy alpha launches Phase 11 build → migration runs → ToS modal NOT yet shown → user creates a new character → cloud upload should NOT fire.

### Pitfall 2: Portrait data URL bloat causes Postgres row size warning
**What goes wrong:** Forgetting to migrate `portrait_image` from data URL to path reference means a row could carry up to ~512 KB of base64 in the column. Postgres handles this fine via TOAST, but query plans degrade and the row is far bigger than necessary.
**Why it happens:** The schema column allows arbitrary `text`; if a code path forgets to upload bytes to Storage and writes the data URL, no validation catches it.
**How to avoid:** `cloudCharacterClient.upsertCharacter` rejects any row where `portrait_image` starts with `data:`. Lint-style guard. Skin pipeline is unaffected (skin bytes never live in the row).

### Pitfall 3: Storage RLS allows write to a UUID the user doesn't own
**What goes wrong:** A user could call `supabase.storage.from('skins').upload('<some-other-user-uuid>.png', bytes)` and overwrite someone else's skin if the RLS check isn't well-formed.
**Why it happens:** The flat `<uuid>.png` layout means RLS must query the `characters` table to map UUID → owner — easy to write a permissive policy by mistake.
**How to avoid:** Write the storage.objects RLS as shown in Pattern 3. Adversarial test: as user A, attempt to upload to `skins/<user-B-character-uuid>.png` — must 403. Alternative: switch to `<owner_uuid>/<character_uuid>.png` path layout for RLS path-prefix matching (the Supabase canonical pattern).
**Warning signs:** No 403 on cross-user write attempt in a manual test.

### Pitfall 4: Bundled default uploaded to cloud because UUID check was forgotten
**What goes wrong:** A code path that mirrors `chars.save` to the cloud forgets to check `is_default`. The default character ends up in every user's cloud library, and worse, may collide on the primary key if the bundled-defaults UUIDs are hardcoded the same across all installs (which D-22 mandates).
**Why it happens:** D-22 is a side constraint; easy to forget on the upsert path.
**How to avoid:** `cloudCharacterClient.upsertCharacter` rejects `is_default: true` rows with a thrown error. Verification: a unit test asserts the throw; a grep audit verifies the check is present in every cloud-mirror site.

### Pitfall 5: Last-write-wins clobbers concurrent edits across machines
**What goes wrong:** User edits character C on Machine A (offline, in queue) and on Machine B (online, mirrored). When A reconnects, A's queue upserts overwrite B's edits.
**Why it happens:** D-18 explicitly accepts last-write-wins. The Claude's Discretion entry sketches a `<row>.json.conflict` shadow + banner for this case but full UX is deferred.
**How to avoid:** Ship the conflict-shadow path as a minimal viable: when downloading a cloud row to overwrite local, if the local file has a pending queue entry, write the incoming row to `<uuid>.json.conflict` instead and surface a banner. Don't build resolution UI — let the user inspect manually.
**Warning signs:** Reports of "I edited my character on my other machine and it reverted".

### Pitfall 6: Cloud delete succeeds, Storage delete fails — orphan PNG lingers
**What goes wrong:** `chars.delete` → row deleted (RLS owner-only check passes) → `supabase.storage.from('skins').remove(['<uuid>.png'])` fails (network) → orphan PNG persists.
**Why it happens:** Storage and Postgres are separate services; transactions don't span them.
**How to avoid:** On cloud-delete cascade, enqueue the storage paths into `deletion_queue` (the existing Phase 10 table) and let the nightly cron sweep them. Extends the cron body to actually iterate `storage_paths` and delete (the Phase 10 BL-03 deferred follow-on). The cron + Edge Function compensating-write pattern is established.

### Pitfall 7: UUID rename mid-bot-summon corrupts skinServer state
**What goes wrong:** User has bot summoned for character X (slug `sui`). They update to Phase 11. App boots, migration runs, renames `<userData>/characters/sui.json` → `<userData>/characters/<uuid>.json`. The active utilityProcess still holds the slug-keyed config.
**Why it happens:** The bot might have been hot-reloading or there's a pre-existing in-flight summon.
**How to avoid:** Migration must run BEFORE `botSupervisor` is wired and BEFORE the renderer can fire `bot.summon`. The existing `runFirstLaunchMigration()` call site in `index.ts` is pre-`app.whenReady`-tasks — verify the ordering and refuse `bot.summon` IPC until migration completes. Atomic-write the migration manifest first to make recovery safe.

### Pitfall 8: Email verification check forgotten on cloud write
**What goes wrong:** Phase 10 D-04 says email verification doesn't block sign-in but DOES block cloud-write attempts. Phase 11's cloud-mirror code path needs to honor that. A signed-in but unverified user's mirror calls should fail with a clean error → renderer shows "verify first" modal.
**Why it happens:** Easy to gate only on `kind === 'signed_in'` and miss `emailVerified`.
**How to avoid:** `isCloudWriteAllowed()` checks `kind === 'signed_in'` AND `user.emailVerified === true` AND `tosAccepted`. All three. Document the contract on the helper.

### Pitfall 9: GDPR — character prompt may contain PII
**What goes wrong:** A user puts their real name or address in a character's persona prompt and shares it (`shared = true`). The cloud row carries PII; Browse exposes it (Phase 12).
**Why it happens:** User-generated free text fields can carry anything.
**How to avoid:** ToS clause covers this ("don't put PII in character content"). Phase 11 is upload-side; Phase 12 will add content moderation. Phase 11 just needs the legal-text coverage. Note in privacy.html: "User-generated content uploaded with `shared = true` is publicly visible. Don't include personal information."

### Pitfall 10: Public Storage bucket URL leaks character UUIDs
**What goes wrong:** Public buckets mean `https://<project>.supabase.co/storage/v1/object/public/skins/<uuid>.png` is guessable if someone has the UUID. UUIDs aren't secret, but a third-party page that lists UUIDs becomes a backdoor to enumerate skins.
**Why it happens:** Public bucket trade-off accepted in D-29 / Storage pattern.
**How to avoid:** Acceptable — characters with `shared = true` are public-by-design. For `shared = false`, the skin is still publicly readable by UUID, which is a minor leak. **If this is a concern,** flip to private bucket + signed URLs for `shared = false` characters. PLANNER DECIDES — recommended default is public bucket for simplicity; revisit if Phase 12 introduces privacy-sensitive previews. Document the tradeoff in the plan.

## Code Examples

### Example 1: Upsert a character row (main process)

```ts
// Source: supabase docs (2026), Phase 10 supabaseClient.ts pattern
// in src/main/cloudCharacterClient.ts (NEW)
import { getClient } from './auth/supabaseClient';
import type { Character } from '../shared/characterSchema';

const UPSERT_TIMEOUT_MS = 15_000;

export async function upsertCharacter(c: Character, ownerId: string): Promise<void> {
  if (c.is_default) {
    throw new Error('CLOUD_SYNC_REFUSED_DEFAULT: bundled defaults never upload (D-22)');
  }
  const supabase = getClient();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSERT_TIMEOUT_MS);
  try {
    const { error } = await supabase
      .from('characters')
      .upsert({
        id: c.id,
        owner: ownerId,
        slug: c.slug ?? null,
        name: c.name,
        persona_source: c.persona.source,
        persona_expanded: c.persona.expanded,
        skin_source: c.skin.source,
        mojang_username: c.skin.mojang_username,
        skin_png_sha256: c.skin.png_sha256,
        skin_applied_at: c.skin.applied_at,
        username: c.username,
        is_default: false, // Always false in cloud — D-22 invariant
        shared: c.shared,
        last_launched: c.last_launched,
        playtime_ms: c.playtime_ms,
        portrait_image: c.portrait_image, // path reference 'portraits/<uuid>.png' or null
        metadata: {},
      })
      .abortSignal(controller.signal);
    if (error) {
      throw new Error(`CLOUD_SYNC_UPSERT_FAILED: ${error.message}`);
    }
  } finally {
    clearTimeout(timer);
  }
}
```

### Example 2: Upload skin bytes to Storage

```ts
// Source: supabase-js Storage API; Phase 11 D-29 (uniform PNG upload)
export async function uploadSkin(uuid: string, bytes: Buffer): Promise<void> {
  const supabase = getClient();
  const { error } = await supabase
    .storage
    .from('skins')
    .upload(`${uuid}.png`, bytes, {
      contentType: 'image/png',
      upsert: true, // overwrite on re-upload
      cacheControl: '3600',
    });
  if (error) {
    throw new Error(`CLOUD_STORAGE_UPLOAD_FAILED: ${error.message}`);
  }
}
```

### Example 3: List my characters + merge with local

```ts
export async function listMyCharacters(ownerId: string): Promise<Character[]> {
  const supabase = getClient();
  const { data, error } = await supabase
    .from('characters')
    .select('*')
    .eq('owner', ownerId);
  if (error) {
    throw new Error(`CLOUD_LIST_FAILED: ${error.message}`);
  }
  // Caller merges with local cache (cache-on-demand) — see lib/cacheMerger.ts
  return (data ?? []).map(rowToCharacter);
}
```

### Example 4: Portrait validation (main, defense-in-depth)

```ts
// src/main/portraitImageUtil.ts (NEW)
const PNG_MAGIC  = [0x89, 0x50, 0x4E, 0x47];
const JPEG_MAGIC = [0xFF, 0xD8, 0xFF];
const WEBP_RIFF  = [0x52, 0x49, 0x46, 0x46]; // 'RIFF' then 4 bytes size then 'WEBP'
const WEBP_TAG   = [0x57, 0x45, 0x42, 0x50];

const MAX_BYTES = 500 * 1024; // D-28
const MAX_DIM = 1024;

export function validatePortrait(bytes: Buffer): { format: 'png' | 'jpeg' | 'webp' } {
  if (bytes.length > MAX_BYTES) {
    throw new Error(`PORTRAIT_TOO_LARGE: ${bytes.length} > ${MAX_BYTES} bytes`);
  }
  if (bytes.length < 24) throw new Error('PORTRAIT_TOO_SHORT');
  const isPng = PNG_MAGIC.every((b, i) => bytes[i] === b);
  const isJpeg = JPEG_MAGIC.every((b, i) => bytes[i] === b);
  const isWebp = WEBP_RIFF.every((b, i) => bytes[i] === b)
    && WEBP_TAG.every((b, i) => bytes[8 + i] === b);
  if (!isPng && !isJpeg && !isWebp) {
    throw new Error('PORTRAIT_BAD_MAGIC: must be PNG, JPEG, or WebP');
  }
  // Dimension check requires format-specific parsing; PNG has IHDR at offset 16,
  // JPEG has SOFn marker, WebP has VP8/VP8L/VP8X chunk. Reuse skinImageUtil's
  // PNG IHDR parser; for JPEG and WebP, implement minimal parsers or trust the
  // renderer's canvas resize (it's already <=1024 by construction).
  // ... (full impl in plan)
  return { format: isPng ? 'png' : isJpeg ? 'jpeg' : 'webp' };
}
```

### Example 5: tos_acceptance gate

```ts
// src/main/auth/tosGate.ts (NEW)
import { getClient } from './supabaseClient';
import { TOS_VERSION, PRIVACY_VERSION } from '../../shared/legalVersions';

export async function isTosAccepted(userId: string): Promise<boolean> {
  const supabase = getClient();
  const { data, error } = await supabase
    .from('tos_acceptance')
    .select('tos_version, privacy_version')
    .eq('user_id', userId)
    .eq('tos_version', TOS_VERSION)
    .eq('privacy_version', PRIVACY_VERSION)
    .limit(1);
  if (error) {
    // Fail closed — treat unknown as not accepted.
    return false;
  }
  return (data ?? []).length > 0;
}

export async function recordAcceptance(userId: string): Promise<void> {
  const supabase = getClient();
  const { error } = await supabase
    .from('tos_acceptance')
    .insert({
      user_id: userId,
      tos_version: TOS_VERSION,
      privacy_version: PRIVACY_VERSION,
    });
  if (error) {
    throw new Error(`TOS_RECORD_FAILED: ${error.message}`);
  }
}
```

## State of the Art

| Old Approach (v0.1.1) | Current Approach (v1.0 / Phase 11) | When Changed | Impact |
|-----------------------|------------------------------------|--------------|--------|
| Slug as character id | UUID as character id | Phase 11 D-23 | All local paths under `<userData>` rename. Bundled assets in `resources/` stay slug-keyed (build-time, repo-tracked). |
| Portrait as inline base64 data URL in JSON | Portrait as separate file/object referenced by path | Phase 11 D-28 | Smaller cloud rows; CDN-cacheable portraits; one-time data-URL → file migration at slug→uuid time. |
| `sui`-undeletable as hardcoded id check | `is_default` precondition on edit/delete | Phase 11 D-22 | Generic rule covers all three defaults; new defaults added later don't need code edits. |
| No cloud storage of character definition | Supabase Postgres + Storage with cache-on-demand local cache | Phase 11 LIB-01..LIB-05 | Multi-device access; offline mode for opened chars. |
| `description` + `persona_prompt` (legacy) | `persona: { source, expanded }` (Phase 9, 260516-0yw) | Pre-Phase 11 | Carries through; no further schema breakage. |

**Deprecated/outdated:**
- `paths.characterPortraitPath(id)` is referenced in `characterStore.deleteCharacter` to unlink a `<characters>/<id>.png` — verify it ever actually exists. As of the v0.1.1 portrait-as-data-URL design, it does NOT (and the unlink swallows ENOENT). Phase 11 makes it real for the local cache (or moves to a `<portraits>/` subdir — planner decides).
- The `sui` literal check at `ipc.ts:135` becomes `is_default` precondition (`if (char.is_default) throw`).

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The 2026 Supabase free tier still includes Storage with no hard ceiling on objects per bucket beyond the 1 GB total + 5 GB egress | Standard Stack | If wrong, character uploads at scale fail. Plan should include a free-tier-limits check at deploy time. Validated against STACK.md (2026-05-19 research) which says "1 GB file storage" — **[ASSUMED]** that this hasn't shrunk between the STACK research and now. |
| A2 | `supabase.from().upsert()` accepts an `AbortSignal` via `.abortSignal(signal)` for timeout | Code Example 1 | If wrong, drop the abortSignal call and wrap with `Promise.race` against a timeout promise. **[ASSUMED]** — supabase-js v2 supports `.abortSignal()` on PostgrestFilterBuilder in modern versions; verify before final implementation. |
| A3 | Storage RLS via subquery on `public.characters` is performant enough for low-volume uploads (a user creates a handful of characters per session) | Pattern 3 | If wrong, switch to `<owner>/<uuid>.png` path layout and use `storage.foldername(name)[1]`. **[ASSUMED]** based on Supabase docs supporting this pattern. |
| A4 | The renderer-side canvas resize + re-encode (PNG/JPEG/WebP) preserves the bytes correctly across platforms (especially macOS arm64 where the canvas WebGL backend varies) | Pattern 5 | If wrong, large images cause renderer-side errors. **[ASSUMED]** — should be tested manually on macOS + Windows during plan execution. |
| A5 | `crypto.randomUUID()` is available in Electron 42's main process (Node 22) | Standard Stack | If wrong, swap to a `uuid` npm package (`npm install uuid` — small, no native). **[ASSUMED]** — `crypto.randomUUID()` has been Node-stable since v14.17 / v15.6; Electron 42 bundles Node 22. |
| A6 | The bundled-defaults UUIDs can be hardcoded once at Phase 11 plan-execution time and never re-rolled | Pattern 8 | If a bug requires re-rolling, every user's local cache breaks. **[ASSUMED]** — D-22 says "stable UUIDs hardcoded"; treating as immutable from first commit. Plan must generate them via `crypto.randomUUID()` once, paste them in, and never touch them. |
| A7 | The `sei-website` sibling repo is currently a static Vercel deploy (vercel.json present) and adding two HTML files + footer links is a routine PR there | Pattern 7 + canonical refs | If the repo's deploy pipeline has unusual constraints, the timing of Phase 11 implementation slows. **[ASSUMED]** — verified `vercel.json` exists; the user's memory notes "Don't think about Vercel until told" which suggests the existing sei-website Vercel deploy is OK to use but no new Vercel infra should be added. |
| A8 | Anthropic remains the only subprocessor that processes user-generated character content at Phase 11 (Phase 13 adds Lemon Squeezy, Phase 14 adds more providers) | Pitfall 9 | If wrong, the privacy policy under-discloses processors. **[ASSUMED]** — Phase 13/14 will revisit. |
| A9 | The Supabase free-tier project is OK to apply the new migration to without a deploy-window concern (the MCP tool can apply migrations directly) | Pattern 1 | If wrong, schema changes need a maintenance window. **[ASSUMED]** — MCP server is available per `.mcp.json`; Phase 10's deletion_queue was applied via MCP per the verification report. |

**Note for discuss-phase / user confirmation:** A1, A6, A7, A9 are the highest-risk assumptions worth confirming before plan-checker approves the plan. A1 may have changed since 2026-05-19 STACK research.

## Open Questions

1. **Storage bucket path layout — flat `<uuid>.png` vs nested `<owner>/<uuid>.png`?**
   - What we know: Both work. Nested is the Supabase-canonical pattern + faster RLS check via `storage.foldername`. Flat is simpler for the renderer's "construct URL from row" UX.
   - What's unclear: Whether the Phase 12 Browse query benefits from the URL pattern.
   - Recommendation: Default to nested `<owner>/<uuid>.png` for cleaner RLS. Planner picks.

2. **Should the Phase 11 plan include the deletion_queue cron extension for storage purge (Phase 10's BL-03 follow-on)?**
   - What we know: Phase 10 verification explicitly defers this to Phase 11. Phase 11 introduces the first Storage objects → this is the natural moment to land the extension.
   - What's unclear: Whether it's scoped into the Phase 11 plan or punted to Phase 12.
   - Recommendation: Ship the cron extension in Phase 11 — the orphan-cleanup path is needed the moment a user can have Storage objects. Plan should include a migration that updates the cron body.

3. **Migration modal — show on every fresh sign-in for users with local chars, or only on the FIRST sign-in?**
   - What we know: D-20 says "one-shot at first sign-in" + Settings re-open. "First sign-in" is ambiguous: first ever sign-in on this device, or first sign-in for this Supabase account?
   - What's unclear: A user who signed up on Machine A, signed in on Machine B, then later created local chars on Machine B might expect the migration prompt.
   - Recommendation: Track "modal shown" per-machine via a flag in `<userData>/migration-modal-shown.json`. First sign-in on a device that has local-mode chars → show modal once. User can re-open via Settings.

4. **For shared=false characters, is the skin/portrait still public-readable?**
   - What we know: Public bucket means yes — anyone with the UUID can fetch the PNG.
   - What's unclear: Whether D-16 + D-29 imply that private characters' assets should be private too.
   - Recommendation: For Phase 11, accept the leak (UUIDs are random, not secret). Surface as a known limitation in the plan. If Phase 12 Browse requires private assets to remain truly private, revisit at that boundary.

5. **`character.portrait_image` field — schema-level type change or graceful coexistence with old data URLs?**
   - What we know: Today it's any `text` (could be data URL, could be path).
   - What's unclear: Whether to add a Zod refinement that rejects data URLs at the boundary (catches the "forgot to upload" bug), or keep the field permissive for migration grace.
   - Recommendation: After migration completes, add a Zod refinement rejecting `data:` prefix. Before that, allow it (the migration code itself reads data URLs).

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node 20+ (built-in `crypto.randomUUID`) | UUID generation | ✓ | Electron 42 → Node 22 | — |
| `@supabase/supabase-js` | All cloud calls | ✓ | 2.106.x (in package.json) | — |
| Supabase project (DB + Storage + Auth) | Schema + buckets | ✓ | Free tier (live since Phase 10) | — |
| Supabase MCP server | Applying migrations | ✓ | Configured in `.mcp.json` | Fall back to `supabase` CLI |
| `../sei-website/` sibling repo | Hosting `terms.html` + `privacy.html` | ✓ | Existing Vercel deploy | — |
| Network connectivity at runtime | Cloud mirror | Variable | — | Sync queue handles offline / disconnect |
| `shell.openExternal` | Opening legal links + verification | ✓ | Electron built-in (used in Phase 10) | — |
| `HTMLCanvasElement.toBlob` | Portrait resize | ✓ | Renderer (web platform) | — |

**Missing dependencies with no fallback:** None.

**Missing dependencies with fallback:** Sync queue covers offline; that's by design.

## Security Domain

`security_enforcement` is not explicitly set in `.planning/config.json` — treat as enabled.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | Reuse Phase 10 Supabase Auth + safeStorage session. JWT auto-attached to every supabase-js call. |
| V3 Session Management | yes | Phase 10 owns this (`sessionStore.ts` + `safeStorage`). Phase 11 only consumes the session. |
| V4 Access Control | yes | Supabase RLS on `characters`, `tos_acceptance`, and `storage.objects`. Owner-or-shared read; owner-only write. Defense-in-depth: `IdSchema` (regex bumped to UUID) at the IPC boundary. |
| V5 Input Validation | yes | Zod schemas for every IPC payload (`CharacterSchema`, new `ApplyPortraitArgsSchema`, etc.). Magic-byte validation for images. Reject `data:` URLs in cloud rows. |
| V6 Cryptography | partial | SHA-256 of skin PNG (existing). Cloud objects keyed by `crypto.randomUUID()` (cryptographic-quality). No new crypto code; never hand-roll. |
| V10 Malicious Code | yes | Portrait magic-byte gate prevents polyglot file uploads (no SVG-with-JS). |
| V12 Files and Resources | yes | Path-traversal defense in `IdSchema` (UUID regex). Atomic writes for local cache. Public bucket trade-off documented (Pitfall 10). |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| User uploads polyglot image (e.g., HTML embedded in PNG) | Tampering / Elevation | Magic-byte check + re-encode through canvas (renderer) + main-side magic-byte re-validation. |
| Cross-user cloud write (modify someone else's character) | Tampering | RLS policy `characters_update` USING + WITH CHECK on `auth.uid() = owner`. |
| Cross-user Storage write (overwrite someone else's skin) | Tampering | RLS policy on `storage.objects` with subquery to `characters.owner` OR nested path layout `<owner>/<uuid>.png` + `storage.foldername(name)[1] = auth.uid()`. |
| Stolen JWT replay | Spoofing | Phase 10 short-lived JWT + refresh token; JWT revocable server-side on sign-out. |
| Bundled-default upload (leak from one user's machine to cloud) | Information disclosure (low severity) | `cloudCharacterClient` rejects `is_default: true`. |
| ToS gating bypass via direct API call | Authorization-bypass | Defense-in-depth: RLS `characters_insert` still requires `auth.uid() = owner`; ToS check is UX gate not security gate; document this in the plan. |
| Public Storage URL enumeration (guess UUIDs) | Information disclosure | UUIDs are 122 bits of entropy — unguessable. Acceptable risk per Pitfall 10. |
| Portrait data URL bloat → DoS via Postgres TOAST | Denial of service | Reject `data:` in `portrait_image` at the upsert boundary. Cap row size at the SQL level (no constraint needed beyond column type). |
| GDPR violation — PII in character content | Compliance | ToS clause; Phase 12 will add moderation. Out of scope for Phase 11 enforcement. |

## Sources

### Primary (HIGH confidence)

- `src/main/auth/supabaseClient.ts` — Singleton client config (PKCE, safeStorage adapter); Phase 10 baseline
- `src/main/auth/authState.ts` — Two-state machine; subscribed events
- `src/main/auth/exportBuilder.ts` — D-14 export envelope; Phase 11 fills `characters[]`
- `src/main/auth/edgeFunctionClient.ts` — JWT + timeout pattern; reusable for any Phase 11 Edge Function
- `supabase/functions/_shared/cors.ts` + `supabase/functions/delete-me/index.ts` — Established Edge Function shape
- `supabase/migrations/*.sql` — Migration pattern + cron-based purge (BL-03 follow-on lives in extending this)
- `src/shared/characterSchema.ts` — Current Zod schemas
- `src/main/characterStore.ts` + `src/main/skinStore.ts` + `src/main/paths.ts` + `src/main/migration.ts` — Local CRUD + atomic-write + first-launch migration
- `src/main/skinImageUtil.ts` — PNG IHDR + 64×64 RGBA validation
- `src/main/skinServer.ts` — Loopback HTTP skin server (URL unchanged — `/skins/<username>.png`)
- `src/main/ipc.ts` — `IdSchema` validator (regex bumps to UUID)
- `src/main/defaultCharacters.ts` — Bundled defaults seeding pattern
- `src/renderer/src/components/SignInModal.tsx` + `src/renderer/src/lib/stores/useAuthStore.ts` — `framingLabel` + `UpgradeFraming` ('share this character' literal already present)
- `src/renderer/src/components/PortraitImagePicker.tsx` — Reveals portraits are currently inlined as base64 data URLs (key finding)
- `.planning/research/STACK.md` §1 — Supabase pins + RLS sketch (illustrative; D-24 in CONTEXT supersedes)
- `.planning/research/PITFALLS.md` Pitfalls 11, 12, 13 — GDPR, public library moderation, account-deletion regression
- `.planning/phases/10-auth-foundation/10-CONTEXT.md` — D-06 (two-state model), D-10 (inline-upgrade pattern), D-13 (`supabase/functions/` convention), D-14 (export schema)
- `.planning/phases/10-auth-foundation/10-VERIFICATION.md` — Phase 10 deferred items (BL-03 storage-purge cron extension explicitly deferred to Phase 11)
- `package.json` — `@supabase/supabase-js ^2.106.0`
- `npm view @supabase/supabase-js version` → 2.106.1 (verified 2026-05-21)
- `.planning/config.json` — `nyquist_validation: false` (Validation Architecture section omitted)
- `.mcp.json` — Supabase MCP server configured

### Secondary (MEDIUM confidence)

- [Supabase Storage Access Control docs](https://supabase.com/docs/guides/storage/security/access-control) — Public vs private buckets, RLS on storage.objects
- [Supabase Storage Schema Design](https://supabase.com/docs/guides/storage/schema/design) — Path layout recommendations (`<user_id>/<file>` canonical pattern)
- [Supabase RLS Mastery (dev.to / asheeshh)](https://dev.to/asheeshh/mastering-supabase-rls-row-level-security-as-a-beginner-5175) — Subquery RLS pattern + common pitfalls
- [Supabase Storage Buckets Fundamentals](https://supabase.com/docs/guides/storage/buckets/fundamentals) — Public bucket semantics + CDN caching
- [JavaScript: Upsert data — supabase-js](https://supabase.com/docs/reference/javascript/upsert) — Upsert syntax
- [How to do automatic retries with supabase-js](https://supabase.com/docs/guides/api/automatic-retries-in-supabase-js) — Built-in retry on 408/409/503/504 + network (v2.102.0+)
- [Storage tradeoffs: public bucket vs signed URL (supabase discussion #6458)](https://github.com/orgs/supabase/discussions/6458) — Avatars-public guidance
- [Supabase Storage Deep Dive (dev.to / kanta13jp1)](https://dev.to/kanta13jp1/supabase-storage-deep-dive-bucket-design-signed-urls-image-transforms-and-rls-3b9k) — Bucket design tradeoffs

### Tertiary (LOW confidence — informational only)

- [RxDB Supabase Replication Plugin](https://rxdb.info/replication-supabase.html) — Considered and rejected as over-engineering for the cache-on-demand model

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — supabase-js is already a Phase 10 dependency; version pinned; documented retry behavior; PKCE + storage adapter wired
- Architecture: HIGH — every component change has a concrete file mapping; the migration pattern + cron extension is established
- Pitfalls: HIGH — most pitfalls are extensions of Phase 10's pitfalls + standard Supabase RLS pitfalls; one open Storage RLS path-layout decision flagged
- Image validation: HIGH — `skinImageUtil.ts` is reused unchanged; portrait validation is a new sibling module
- Migration: MEDIUM — slug→UUID rename is straightforward but the portrait-data-URL → file-on-disk migration is a new conversion path; needs a careful idempotency manifest

**Research date:** 2026-05-21
**Valid until:** 30 days (Supabase Storage/RLS docs are stable; supabase-js patch versions don't change the API surface)

## RESEARCH COMPLETE

Phase 11 is a backend-shape extension of Phase 10's foundation — supabase-js + RLS + Storage buckets + a UUID rename + tos_acceptance gate — with all key primitives (auth client, atomic-write, IPC validator, inline-upgrade modal, deletion_queue cron) already in place; the only genuinely new code is `cloudCharacterClient.ts`, `syncQueue.ts`, `portraitImageUtil.ts`, the slug→UUID migration, the SQL migration, and three modals.
