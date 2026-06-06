# Phase 11: Cloud Character Library — Pattern Map

**Mapped:** 2026-05-21
**Files analyzed:** 22 (10 NEW, 12 modified)
**Analogs found:** 22 / 22

The phase is largely "gluing existing primitives" — Phase 10 already shipped the singleton Supabase client, the safeStorage-encrypted persistent store, the typed-error families (`KEYCHAIN_*` / `SESSION_*`), the IPC `IdSchema` boundary, the SignInModal with `framingLabel` plumbing, the deletion-queue cron, and the Edge Function template. Every new file in Phase 11 has a close analog in the tree.

## File Classification

### NEW files (greenfield)

| New File | Role | Data Flow | Closest Analog | Match Quality |
|----------|------|-----------|----------------|---------------|
| `src/main/cloudCharacterClient.ts` | service (cloud wrapper) | CRUD + file-upload | `src/main/auth/edgeFunctionClient.ts` (timeout+abort), `src/main/skinStore.ts` (CRUD shape) | exact (composite) |
| `src/main/syncQueue.ts` | service (persistent queue) | event-driven + atomic-write | `src/main/auth/sessionStore.ts` (encrypted JSON dict, atomic, defensive read) | role-match |
| `src/main/portraitImageUtil.ts` | utility (image validator) | transform (pure) | `src/main/skinImageUtil.ts` (PNG magic+IHDR, throws typed errors) | exact |
| `src/main/auth/tosGate.ts` | service (cloud query) | request-response | `src/main/auth/exportBuilder.ts` (pure, session-scoped) + `src/main/auth/authHandlers.ts:deleteAccount` (supabase.from + error mapping) | role-match |
| `src/shared/legalVersions.ts` | config (constants) | n/a | `src/main/env.ts` (constants module pattern) | role-match |
| `supabase/migrations/<ts>_characters_tos.sql` | migration (schema + RLS) | n/a | `supabase/migrations/20260520000000_deletion_queue.sql` (table + RLS + cron) | exact |
| `supabase/migrations/<ts>_storage_buckets.sql` | migration (storage RLS) | n/a | `supabase/migrations/20260520000000_deletion_queue.sql` (RLS policy patterns) | role-match |
| `supabase/migrations/<ts>_storage_purge_extend.sql` | migration (cron body extension) | n/a | `supabase/migrations/20260520000000_deletion_queue.sql` (`cron.schedule` body) | exact |
| `src/renderer/src/components/AcceptToSModal.tsx` | component (blocking modal) | request-response | `src/renderer/src/components/DeleteAccountModal.tsx` (blocking, ESC-suppressed, IPC submit) | exact |
| `src/renderer/src/components/MigrateLocalCharsModal.tsx` | component (list-modal) | request-response | `src/renderer/src/components/DeleteAccountModal.tsx` (structure) + `src/renderer/src/components/SignInModal.tsx` (multi-state body) | role-match |
| `../sei-website/terms.html` + `privacy.html` | static asset | n/a | (existing static pages in `sei-website` — out-of-repo) | no analog (defer to repo) |

### MODIFIED files

| File | Role | Data Flow | Phase 11 Change |
|------|------|-----------|-----------------|
| `src/shared/characterSchema.ts` | schema (Zod) | n/a | Add `shared`, change `id` regex to UUID, add optional `slug`, refine `portrait_image` post-migration |
| `src/main/paths.ts` | utility (path resolver) | n/a | Add `portraitPath(uuid)`, `portraitsDir()`, `syncQueuePath()`, `migrationManifestPath()` |
| `src/main/characterStore.ts` | service (local CRUD) | CRUD | After atomic write, enqueue cloud-mirror via `syncQueue.enqueueUpsert(uuid)` (fire-and-forget) |
| `src/main/skinStore.ts` | service (skin bytes) | file-I/O | After atomic write, enqueue Storage upload; `IdSchema` regex updates upstream in `ipc.ts` |
| `src/main/skinServer.ts` | service (HTTP loopback) | request-response | URL contract unchanged; `paths.skinPngPath` now resolves UUID |
| `src/main/migration.ts` | migration | one-shot | Extend with `runUuidRenameMigration()` — slug→UUID rename pass, idempotent, manifest-gated |
| `src/main/defaultCharacters.ts` | config (bundled defaults) | n/a | Add hardcoded `DEFAULT_CHARACTER_UUIDS` map; bundled JSON `id` fields become UUIDs |
| `src/main/ipc.ts` | controller (IPC) | request-response | Update `IdSchema` to accept UUID v4 regex; add new channels (`chars:set-shared`, `tos:*`, `migration:*`, `sync:*`); generalize `'sui' === id` to `is_default` precondition |
| `src/main/auth/exportBuilder.ts` | service (envelope) | CRUD-read | Fill `characters[]` via `supabase.from('characters').select('*').eq('owner', userId)` |
| `src/main/auth/authState.ts` | state machine | event-driven | Add `isCloudWriteAllowed()` helper (signed_in AND email_verified AND tos_accepted) |
| `src/main/index.ts` | composition root | n/a | Call new `runUuidRenameMigration()` in `bootstrap()` chain; gate `bot.summon` until migration completes |
| `src/renderer/src/screens/CharacterPage.tsx` | screen (UI) | event-driven | Add `shared` toggle; signed-out → open `SignInModal` with `framingLabel='share this character'` |
| `src/renderer/src/screens/HomeScreen.tsx` | screen (UI) | event-driven | Render "local only" chip + sync `StatusPill` per card |
| `src/renderer/src/screens/SettingsScreen.tsx` | screen (UI) | event-driven | Add "Migrate local characters" Account-panel entry |
| `src/renderer/src/components/PortraitImagePicker.tsx` | component (upload control) | file-I/O | Replace inline base64-data-URL with canvas-resize + IPC upload of bytes (returns path reference) |

---

## Pattern Assignments

### `src/main/cloudCharacterClient.ts` (NEW — service, CRUD + file-upload)

**Build by analogy to:** `src/main/auth/edgeFunctionClient.ts` (lines 30–81) for the timeout+abort wrapper; `src/main/skinStore.ts` (lines 105–168) for the validate+act+throw-typed-error shape.

**Imports pattern** (from `auth/edgeFunctionClient.ts` lines 17–28 + `auth/supabaseClient.ts`):
```typescript
import { getClient } from './auth/supabaseClient';
import type { Character } from '../shared/characterSchema';
// Optional, if file-IO needed:
import { readFile } from 'node:fs/promises';
```

**Timeout pattern** (copy from `auth/edgeFunctionClient.ts` lines 36–80):
```typescript
const UPSERT_TIMEOUT_MS = 15_000;

const controller = new AbortController();
const timeoutHandle = setTimeout(() => controller.abort(), UPSERT_TIMEOUT_MS);
try {
  const { error } = await supabase
    .from('characters')
    .upsert({ /* row */ })
    .abortSignal(controller.signal);
  if (error) throw new Error(`CLOUD_SYNC_UPSERT_FAILED: ${error.message}`);
} finally {
  clearTimeout(timeoutHandle);
}
```

**Typed-error pattern** (copy from `apiKeyStore.ts:25` `throw new Error('KEYCHAIN_UNAVAILABLE')` and `sessionStore.ts:82` `throw new Error('SESSION_UNAVAILABLE')`):

```typescript
// New error family (Phase 11) — surfaces through IPC to renderer mapping table
throw new Error('CLOUD_SYNC_REFUSED_DEFAULT');     // D-22 invariant
throw new Error('CLOUD_SYNC_REFUSED_DATA_URL');    // Pitfall 2 guard
throw new Error('CLOUD_SYNC_UPSERT_FAILED: ...');  // wraps supabase error
throw new Error('CLOUD_STORAGE_UPLOAD_FAILED: ...');
throw new Error('CLOUD_SYNC_TIMEOUT');             // AbortError mapping
throw new Error('CLOUD_LIST_FAILED: ...');
```

**Bundled-defaults guard** (anti-Pitfall 4):
```typescript
if (c.is_default) {
  throw new Error('CLOUD_SYNC_REFUSED_DEFAULT: bundled defaults never upload (D-22)');
}
```

**Public API to export:**
- `upsertCharacter(c: Character, ownerId: string): Promise<void>`
- `deleteCharacter(uuid: string): Promise<void>`
- `listMyCharacters(ownerId: string): Promise<Character[]>`
- `downloadCharacter(uuid: string): Promise<Character | null>`
- `uploadSkin(uuid: string, bytes: Buffer): Promise<void>`
- `uploadPortrait(uuid: string, bytes: Buffer, format: 'png'|'jpeg'|'webp'): Promise<void>`
- `deleteStorageObjects(paths: string[]): Promise<void>`

---

### `src/main/syncQueue.ts` (NEW — service, event-driven + atomic-write)

**Build by analogy to:** `src/main/auth/sessionStore.ts` (lines 24–124) — the encrypted JSON dict at `<userData>/session.bin` with `readDict()` / `writeDict()` and defensive ENOENT/corrupt-blob handling. Drop the `safeStorage` encryption (queue contents are non-secret) and replace with plaintext atomic write via the brain helpers.

**Imports pattern** (model: `characterStore.ts` lines 22–29):
```typescript
import { readFile, mkdir } from 'node:fs/promises';
import { atomicWrite } from '../bot/brain/storage/atomicWrite.js';
import { withFileLock } from '../bot/brain/storage/fileLock.js';
import { paths } from './paths';
```

**Atomic write of the queue file** (copy from `characterStore.ts:55-61` `writeIndex`):
```typescript
async function writeQueue(q: SyncOp[]): Promise<void> {
  const target = paths.syncQueuePath();
  await mkdir(path.dirname(target), { recursive: true });
  await withFileLock(target, async () => {
    await atomicWrite(target, JSON.stringify(q, null, 2) + '\n');
  });
}
```

**Defensive read** (copy from `characterStore.ts:35-43` `readJson`):
```typescript
async function readQueue(): Promise<SyncOp[]> {
  let raw: string;
  try { raw = await readFile(paths.syncQueuePath(), 'utf8'); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  try { return JSON.parse(raw) as SyncOp[]; }
  catch { return []; }  // corrupt → start fresh, log
}
```

**Backoff schedule** (from RESEARCH §Pattern 4): 1s → 5s → 30s → 5min → 30min → fail.

**Public API:**
- `enqueueUpsert(uuid: string): Promise<void>` (collapses duplicate UUIDs; drainer re-reads local file at drain time)
- `enqueueDelete(uuid: string, storagePaths: string[]): Promise<void>`
- `processNext(): Promise<void>` (drainer — invoke on auth:signed_in, network reconnect, and after every successful op)
- `getStatus(): { pending: number; failed: SyncOp[] }` (for the `sync:status` IPC)

---

### `src/main/portraitImageUtil.ts` (NEW — utility, transform)

**Build by analogy to:** `src/main/skinImageUtil.ts` (lines 33–86) — pure-Node PNG parsing, no dep, throws clear errors.

**Magic-byte pattern** (extend `skinImageUtil.ts:46` `PNG_SIGNATURE` + new constants for JPEG/WebP per RESEARCH Example 4):
```typescript
const PNG_MAGIC  = [0x89, 0x50, 0x4E, 0x47];
const JPEG_MAGIC = [0xFF, 0xD8, 0xFF];
const WEBP_RIFF  = [0x52, 0x49, 0x46, 0x46];
const WEBP_TAG   = [0x57, 0x45, 0x42, 0x50];
const MAX_BYTES = 500 * 1024;     // D-28
const MAX_DIM = 1024;             // D-28
```

**Header parse + throw shape** (copy from `skinImageUtil.ts:58-85` `parsePngIhdr`):
```typescript
export function validatePortrait(bytes: Buffer): { format: 'png' | 'jpeg' | 'webp' } {
  if (bytes.length > MAX_BYTES) throw new Error(`PORTRAIT_TOO_LARGE: ${bytes.length} > ${MAX_BYTES}`);
  if (bytes.length < 24) throw new Error('PORTRAIT_TOO_SHORT');
  // ... magic-byte branch as in RESEARCH Example 4 ...
  // For PNG: reuse parsePngIhdr to check dims ≤ MAX_DIM.
  // For JPEG/WebP: trust the renderer's canvas resize (constructively ≤ MAX_DIM).
}
```

**Reuse:** Import and call `parsePngIhdr` from `skinImageUtil.ts` for the PNG branch (don't duplicate the IHDR parser).

---

### `src/main/auth/tosGate.ts` (NEW — service, request-response)

**Build by analogy to:** `src/main/auth/exportBuilder.ts` (entire file, 48 lines) — small, pure, session-scoped helper; AND `src/main/auth/authHandlers.ts:464-...` `exportData` for the supabase + error-mapping pattern.

**Skeleton** (from RESEARCH Example 5):
```typescript
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
  if (error) return false;  // fail closed
  return (data ?? []).length > 0;
}

export async function recordAcceptance(userId: string): Promise<void> {
  const supabase = getClient();
  const { error } = await supabase
    .from('tos_acceptance')
    .insert({ user_id: userId, tos_version: TOS_VERSION, privacy_version: PRIVACY_VERSION });
  if (error) throw new Error(`TOS_RECORD_FAILED: ${error.message}`);
}
```

---

### `src/shared/legalVersions.ts` (NEW — config)

**Build by analogy to:** `src/main/env.ts` (constants module). Simplest possible export of two string constants:

```typescript
// Bump these on legal-text update → re-acceptance modal fires.
export const TOS_VERSION = '2026-05-21';
export const PRIVACY_VERSION = '2026-05-21';
```

---

### `supabase/migrations/<ts>_characters_tos.sql` (NEW — schema + RLS)

**Build by analogy to:** `supabase/migrations/20260520000000_deletion_queue.sql` (entire file) — the established pattern for a Phase migration: `create table ... ; alter table ... enable row level security; create policy ...; create trigger ...;`. Use RESEARCH §Pattern 1 + §Pattern 2 verbatim for the column lists and RLS policies.

**Excerpt to mirror** (from `20260520000000_deletion_queue.sql:17-28`):
```sql
create table public.deletion_queue (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,                       -- NO FK to auth.users; survives user deletion
  ...
);
create index on public.deletion_queue (deletion_requested_at) where purged_at is null;
alter table public.deletion_queue enable row level security;
-- (No policies — RLS default-deny is the policy.)
```

**Plus** the `tos_acceptance(user_id, tos_version, privacy_version, accepted_at)` table with select+insert-own RLS policies (D-27).

**Plus** the `characters` table with `characters_select / _insert / _update / _delete` policies (RESEARCH §Pattern 1) and the `tg_set_updated_at` trigger.

---

### `supabase/migrations/<ts>_storage_buckets.sql` (NEW — storage RLS)

**Build by analogy to:** the RLS block in `20260520000000_deletion_queue.sql` (lines 27–28) — `alter table ... enable row level security; create policy ...`. Apply to `storage.objects` per RESEARCH §Pattern 3. Recommend the nested layout `<owner_uuid>/<character_uuid>.png` for cleaner RLS (Pitfall 3 default). Buckets created via dashboard or `mcp__supabase__apply_migration`.

---

### `supabase/migrations/<ts>_storage_purge_extend.sql` (NEW — cron-body extension)

**Build by analogy to:** `supabase/migrations/20260520000000_deletion_queue.sql` lines 34–43 — the existing `cron.schedule('purge-deletion-queue', ...)` body. Use `cron.unschedule('purge-deletion-queue')` followed by `cron.schedule(...)` with an extended body that iterates `storage_paths` and calls `storage.objects` deletes (Phase 10's BL-03 follow-on).

**Existing body to extend** (lines 34–43):
```sql
select cron.schedule(
  'purge-deletion-queue',
  '0 3 * * *',
  $$
    update public.deletion_queue
    set purged_at = now()
    where deletion_requested_at < now() - interval '30 days'
      and purged_at is null
  $$
);
```

---

### `src/renderer/src/components/AcceptToSModal.tsx` (NEW — component, blocking modal)

**Build by analogy to:** `src/renderer/src/components/DeleteAccountModal.tsx` (entire 138 lines) — the canonical blocking-modal shape: scrim with no click-outside dismiss, ESC suppressed during submit, IPC submit via `sei.*`, success-transition state.

**Imports + props pattern** (from `DeleteAccountModal.tsx:16-26`):
```typescript
import React, { useEffect, useState } from 'react';
import { sei } from '../lib/ipcClient';
import { Button } from './Button';
import styles from './DeleteAccountModal.module.css';  // reuse css module structurally

export interface AcceptToSModalProps {
  onAccepted: () => void;
}
```

**ESC-suppression pattern** (`DeleteAccountModal.tsx:44-50`):
```typescript
useEffect(() => {
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && !submitting && phase === 'idle') {
      // blocking modal: do NOT call onClose — there is no dismissal
    }
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}, [submitting, phase]);
```

**Submit flow** (model `DeleteAccountModal.tsx:52-73`): call `sei.tosAccept()`, on success → `onAccepted()`. External-link buttons use `shell.openExternal` via an IPC bridge (model: any existing external-link site in the codebase if one exists; otherwise add a tiny `app:open-external` IPC).

**Body layout** (model `DeleteAccountModal.tsx:80-130`): scrim + modal frame; title `Review Sei's Terms`; two `shell.openExternal` links to `https://sei.gg/terms.html` + `/privacy.html`; single required checkbox; "I agree" primary button disabled until checked.

---

### `src/renderer/src/components/MigrateLocalCharsModal.tsx` (NEW — component, list modal)

**Build by analogy to:** `src/renderer/src/components/DeleteAccountModal.tsx` (frame, scrim, ESC handling) PLUS `src/renderer/src/components/SignInModal.tsx` lines 140–161 (multi-state body — the verification-pending sub-state shows how a single modal renders alternate content).

**State machine:** `idle` → `submitting` → `success`. Per-character checkbox list. Renders `[ ] Sui (created 5 days ago)` rows; "Upload selected" button + "Maybe later" dismissal button (per UI-SPEC dismissal-label policy: specific verb-noun, never "Cancel").

**Pulls list from:** new `migration:list-local` IPC (returns local characters where `!is_default && id is NOT a UUID-already-cloud-backed`).

**Submit:** new `migration:upload` IPC with the selected UUIDs; main runs `cloudCharacterClient.upsertCharacter()` + `uploadSkin()` for each in sequence (small N).

---

### `src/main/characterStore.ts` (MODIFY — service, CRUD)

**Existing analog (yourself, post-modify):** `saveCharacter` (lines 120–141) is the extension point. The cloud-mirror call slots in **after** the existing index update (still local; non-blocking).

**Existing local atomic write** (lines 125–127, **keep unchanged**):
```typescript
await withFileLock(target, async () => {
  await atomicWrite(target, JSON.stringify(validated, null, 2) + '\n');
});
```

**Add after the index update** (D-18 local-first, mirror-cloud-immediately):
```typescript
// 11-LIB-01 — cloud mirror is fire-and-forget. The sync queue
// re-reads the on-disk file at drain time so the latest content wins.
if (!validated.is_default) {  // D-22: defaults never upload
  void (await import('./syncQueue')).enqueueUpsert(validated.id);
}
```

**Delete extension** (existing lines 204–225):
```typescript
// After the existing local unlinks + index update:
if (!character.is_default && /* signed_in */) {
  void (await import('./syncQueue')).enqueueDelete(id, [
    `skins/<owner>/${id}.png`,
    `portraits/<owner>/${id}.png`,
  ]);
}
```

---

### `src/main/skinStore.ts` (MODIFY — service, file-I/O)

**Existing analog (yourself):** `applyPng` (lines 105–168) — the atomic-write block (lines 134–138) stays unchanged. Add a sibling Storage enqueue after the local write:

```typescript
// After saveCharacter() at line 166:
if (!character.is_default) {
  void (await import('./syncQueue')).enqueueUpsert(character.id);
  // The drainer reads <userData>/skins/<uuid>.png and uploads to
  // skins/<owner>/<uuid>.png (Pattern 3 path layout).
}
```

The `IdSchema` regex bump (slug→UUID) lives in `ipc.ts`, not here — `skinStore.ts` trusts its input per its existing docblock (lines 22–24).

---

### `src/main/skinServer.ts` (MODIFY — service, request-response)

**No URL contract change** (RESEARCH §Architectural Responsibility Map). Existing route `/skins/<username>.png` (lines 70–84) stays exactly as-is. Only `paths.skinPngPath(character.id)` in `skinStore.resolveSkinPng` resolves a UUID-named file post-rename — the change is transparent to this module.

**File requires zero edits in the read path.** Audit step only.

---

### `src/main/migration.ts` (MODIFY — migration)

**Existing analog (yourself):** `runFirstLaunchMigration` (lines 49–138) — the legacy-persona → `characters/sui.json` migration. Phase 11 adds a sibling migration `runUuidRenameMigration`.

**Idempotency pattern to copy** (line 53):
```typescript
// Idempotent guard: already migrated → no-op
if (await fileExists(paths.characterPath('sui'))) {
  return;
}
```

Replace with a manifest-file check per RESEARCH §Pattern 6:
```typescript
if (await fileExists(paths.migrationManifestPath())) return;
```

**Logger pattern** (lines 22–25, copy exactly):
```typescript
const logger = {
  info: (m: string) => console.log(`[sei] ${m}`),
  warn: (m: string) => console.warn(`[sei] ${m}`),
};
```

**Steps** (full sequence per RESEARCH §Pattern 6): read `index.json` → for each entry, if id is UUID v4 skip; else look up target UUID (defaults: hardcoded table; user-created: `crypto.randomUUID()`); rewrite JSON with new `id` + new `slug` field; rename `<slug>.json` / `<slug>.png` / `memory/<slug>/`; decode `portrait_image` data URL → `<userData>/portraits/<uuid>.png`; update `index.json` order; write manifest LAST.

---

### `src/main/defaultCharacters.ts` (MODIFY — config)

**Existing analog (yourself):** the existing `DEFAULT_CHARACTERS` array (line 33). Add a UUID map BEFORE the array (RESEARCH §Pattern 8):

```typescript
// Frozen UUIDs — generated once at first 11-* plan execution, never regenerated.
// Stability is load-bearing: every install's local cache + the bundled-defaults
// migration both key off these.
export const DEFAULT_CHARACTER_UUIDS = {
  sui:   '<frozen uuid v4 — generate via crypto.randomUUID() during plan exec>',
  lyra:  '<frozen uuid v4>',
  clawd: '<frozen uuid v4>',
} as const;
```

**Bundled JSON edit:** `resources/default-characters/{sui,lyra,clawd}.json` `id` field changes from slug to UUID; a new `slug` field carries the human-readable name. The existing `bundledSkinPath` lookup at `skinStore.ts:54-61` becomes a UUID→slug lookup (the bundled PNG files in `resources/skins/` stay slug-named).

**`seedDefaultCharacters` (lines 76–111):** loop and tracker logic unchanged; only the `id` value flowing through changes.

---

### `src/main/ipc.ts` (MODIFY — controller)

**Existing analog (yourself):** the entire 349-line file — every handler is a model for new ones.

**`IdSchema` update** (lines 55–57) — the most important schema change:
```typescript
// PRE-Phase-11 (slug regex):
const IdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, ...);

// Phase 11 — UUID v4 regex:
const IdSchema = z.string().uuid({
  message: 'characterId must be a UUID',
});
// or explicit:  z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, ...)
```

**Handler shape to mirror** (existing `chars.save` handler, lines 120–131):
```typescript
ipcMain.handle(IpcChannel.chars.save, async (_event, charArg: unknown, optsArg: unknown): Promise<Character> => {
  const character = CharacterSchema.parse(charArg);
  // ... main logic ...
  return await expandAndSaveCharacter({ character });
});
```

**`'sui' === id` generalization** (line 135 — the cited literal):
```typescript
// Before:
if (id === 'sui') throw new Error('Cannot delete the default character.');
// After (D-22 generalized):
const char = await getCharacter(id);
if (char?.is_default) throw new Error('Cannot delete a default character.');
```

**Owner-only-check pattern** (model: `chars.delete` line 137 — `deps.supervisor.getActiveId() === id` defense-in-depth). For Phase 11 cloud handlers, add a sibling check: `auth.getCurrentAuthState().kind === 'signed_in'` AND `isCloudWriteAllowed()`.

**Lazy-import discipline** (model: lines 154–183 + auth handlers 315–348): every new handler body does `const { fn } = await import('./newModule')` so cyclic imports can't deadlock at module-init.

**New channels to add** (RESEARCH §Component Responsibilities):
- `chars:set-shared` (IdSchema + boolean)
- `tos:status` → `{ accepted: boolean; tosVersion: string; privacyVersion: string }`
- `tos:accept` → `{ ok: true } | { ok: false; message: string }`
- `migration:list-local` → `Character[]`
- `migration:upload` (uuids[])
- `sync:status` → `{ pending: number; failed: Array<{uuid, kind, attempts}> }`
- `sync:retry` (uuid?)

---

### `src/main/auth/exportBuilder.ts` (MODIFY — service)

**Existing analog (yourself):** `buildExport` (lines 37–48). Phase 10 explicitly reserves `characters: []` (line 33 + the function-body comment block at lines 8–13). Phase 11 fills it.

**Existing body to extend:**
```typescript
export function buildExport(session: Session): SeiExportV1 {
  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    account: { email: session.user.email ?? '', createdAt: session.user.created_at },
    characters: [],     // <-- Phase 11 fills via async fetch
    sharing: [],
  };
}
```

**Phase 11 shape:** function becomes async (or returns a promise) and the caller awaits — fill `characters[]` via `supabase.from('characters').select('*').eq('owner', session.user.id)`. The schemaVersion stays at 1 (D-14 contract).

**Caller to update:** `authHandlers.ts:exportData` (around lines 464–479). Mirror its existing error mapping (`return { ok: false, code: 'write_failed', message: 'Not signed in' }` for missing session).

---

### `src/main/auth/authState.ts` (MODIFY — state machine)

**Existing analog (yourself):** the file is 137 lines; add a single helper.

**New helper** (D-26 + Phase 10 D-04 + Pitfall 8):
```typescript
import { isTosAccepted } from './tosGate';

export async function isCloudWriteAllowed(): Promise<boolean> {
  if (currentState.kind !== 'signed_in') return false;
  if (!currentState.user.emailVerified) return false;  // Phase 10 D-04
  return await isTosAccepted(currentState.user.id);
}
```

This function is the single defense-in-depth gate every cloud-mirror site checks before calling `cloudCharacterClient.*`. RLS is the wire-level gate; this is the UX gate.

---

### `src/main/index.ts` (MODIFY — composition root)

**Existing analog (yourself):** `bootstrap()` (lines 109+). Phase 11 inserts a new step **between** step 1 (`runFirstLaunchMigration`) and step 1b (`seedDefaultCharacters`).

**Existing pattern to mirror** (lines 120–129):
```typescript
// 1. Migration before any character is summoned (D-10)
try { await runFirstLaunchMigration(); }
catch (err) { logger.warn(`migration failed: ${(err as Error).message}`); }

// 1b. Seed shipped default characters ...
try { await seedDefaultCharacters(); }
catch (err) { logger.warn(`seedDefaultCharacters failed: ${(err as Error).message}`); }
```

**Insert** (between 1 and 1b — Pitfall 7 boot order):
```typescript
// 1a. Slug→UUID rename migration (Phase 11 D-23). Idempotent via manifest.
// MUST run before botSupervisor is wired and before any cloud-mirror call
// could fire.
try { await runUuidRenameMigration(); }
catch (err) { logger.warn(`uuid-rename migration failed: ${(err as Error).message}`); }
```

The drainer (`syncQueue.processNext`) must be wired AFTER `initAuthState` (step 5b, line 266) and listen for the auth-state push to drain on signed_in.

---

### `src/renderer/src/screens/CharacterPage.tsx` (MODIFY — screen)

**Existing analog:** the page itself + `SignInModal` consumption pattern. The `framingLabel = 'share this character'` literal is **already** defined in `useAuthStore.ts:24` (`UpgradeFraming` union).

**Signed-out toggle-flip handler** (model: D-10 inline-upgrade — open `SignInModal` with `framingLabel='share this character'`):
```typescript
const { setUpgradeFraming } = useAuthStore();
const onTogglePublic = () => {
  if (authState.kind === 'signed_in') {
    sei.charsSetShared({ id: c.id, shared: true });
  } else {
    setUpgradeFraming('share this character');
    openModal({ kind: 'signin' });
  }
};
```

---

### `src/renderer/src/screens/HomeScreen.tsx` (MODIFY — screen)

**Existing analog (yourself):** lines 67–99. The grid renders `<CharacterCard>` per row. Phase 11 adds:
1. **"local only" chip** — render inside `CharacterCard` next to the existing CUSTOM/DEFAULT chip (pattern model: `CharacterCard.tsx:59-64`, the `chip` + `chipDot` className pair). Match unobtrusive gray styling per CONTEXT §specifics.
2. **Inline sync `StatusPill`** — for cloud-backed cards, render `<StatusPill tone="muted|warn|pulse" label="SYNCED|SYNCING|FAILED — RETRY" />`. Pattern model: `StatusPill.tsx:44-58` and existing usage in CharacterPage modelRow (per StatusPill docblock).

---

### `src/renderer/src/screens/SettingsScreen.tsx` (MODIFY — screen)

**Existing analog:** the existing Account-panel entries (DeleteAccountModal trigger, ExportData trigger — both wired in plan 10-08/09). Phase 11 adds a sibling entry "Migrate local characters" that opens `MigrateLocalCharsModal` (or no-op when there are no migratable chars).

---

### `src/renderer/src/components/PortraitImagePicker.tsx` (MODIFY — component)

**Existing analog (yourself):** the whole 130-line file. The base64-data-URL inline storage at lines 38–48 is replaced by:
1. canvas-based resize/re-encode to ≤1024×1024 (RESEARCH §Pattern 5 — `HTMLCanvasElement.toBlob`)
2. IPC handoff to main with raw bytes
3. main validates via `portraitImageUtil.validatePortrait` then writes `<userData>/portraits/<uuid>.png` AND enqueues Storage upload

The component's `onChange` callback now passes a path reference (e.g., `portraits/<uuid>.png`) instead of a `data:image/...;base64,...` URL.

---

## Shared Patterns

### Atomic write (used by every NEW persistent-state file)

**Source:** `src/bot/brain/storage/atomicWrite.js` lines 1–40 + `src/bot/brain/storage/fileLock.js:33`
**Apply to:** `syncQueue.ts`, the UUID-rename migration manifest, portrait file writes, JSON queue file
**Excerpt** (canonical, model — copy from `characterStore.ts:55-61`):
```typescript
await mkdir(path.dirname(target), { recursive: true });
await withFileLock(target, async () => {
  await atomicWrite(target, JSON.stringify(value, null, 2) + '\n');
});
```

**Why locked:** The brain helper handles tmp+rename, Buffer-vs-string detection, and PID-stamped tmp names (no collision under concurrent writers). Re-implementing this is forbidden (RESEARCH §Don't Hand-Roll).

For pure-binary writes (encrypted blobs), the `apiKeyStore.ts:23-38` raw tmp+rename pattern applies instead — but Phase 11 doesn't need that (queue is JSON; portrait bytes go through `atomicWrite` which now supports Buffers per its 260517 fix at lines 36–41).

---

### Typed error class family (CLOUD_SYNC_*)

**Source:** `src/main/apiKeyStore.ts:25` (`throw new Error('KEYCHAIN_UNAVAILABLE')`) + `src/main/auth/sessionStore.ts:82` (`throw new Error('SESSION_UNAVAILABLE')`)
**Apply to:** `cloudCharacterClient.ts`, `tosGate.ts`, every Phase 11 cloud-call site
**Pattern:** prefix-coded sentinel strings the renderer maps to ERROR_COPY lookup.

**Phase 11 family** (extend the existing `KEYCHAIN_*` / `SESSION_*` convention):
- `CLOUD_SYNC_REFUSED_DEFAULT` — D-22 invariant violated
- `CLOUD_SYNC_REFUSED_DATA_URL` — Pitfall 2 (portrait stored as base64)
- `CLOUD_SYNC_UPSERT_FAILED: <detail>`
- `CLOUD_STORAGE_UPLOAD_FAILED: <detail>`
- `CLOUD_LIST_FAILED: <detail>`
- `CLOUD_SYNC_TIMEOUT`
- `CLOUD_DELETE_FAILED: <detail>`
- `TOS_NOT_ACCEPTED`
- `TOS_RECORD_FAILED: <detail>`
- `PORTRAIT_TOO_LARGE`
- `PORTRAIT_TOO_SHORT`
- `PORTRAIT_BAD_MAGIC`

Renderer ERROR_COPY table (the established pattern from Phase 10 — `src/renderer/src/lib/errorCopy.ts` or similar) gets new entries for each.

---

### IPC handler shape (IdSchema + Zod + lazy import + typed return)

**Source:** `src/main/ipc.ts:120-131` (`chars.save` handler) + `src/main/ipc.ts:154-173` (`skin.apply` handler)
**Apply to:** every NEW IPC handler in Phase 11
**Excerpt:**
```typescript
ipcMain.handle(IpcChannel.chars.setShared, async (_event, argsRaw: unknown): Promise<void> => {
  const args = z.object({ id: IdSchema, shared: z.boolean() }).parse(argsRaw);
  // Defense-in-depth: bundled defaults can't be made non-shared (D-22) — they're never in cloud anyway
  const char = await getCharacter(args.id);
  if (!char) throw new Error('Character not found.');
  if (char.is_default) throw new Error('Cannot share a default character.');
  // Lazy-import per the cyclic-import discipline
  const { saveCharacter } = await import('./characterStore');
  await saveCharacter({ ...char, shared: args.shared });
});
```

**Owner-only / preconditions** (model: `ipc.ts:135-139` — refuse-when-active pattern):
```typescript
if (char.is_default) throw new Error('...');     // D-22
if (deps.supervisor.getActiveId() === id) throw new Error('Stop first.');  // existing
```

---

### Singleton Supabase client (every cloud call)

**Source:** `src/main/auth/supabaseClient.ts:68-83`
**Apply to:** `cloudCharacterClient.ts`, `tosGate.ts`, the new `exportBuilder` fill path
**Excerpt:**
```typescript
import { getClient } from './auth/supabaseClient';

const supabase = getClient();
// All supabase-js calls automatically carry the active JWT — main owns
// the session via sessionStore.ts's safeStorage adapter.
```

**Never instantiate a second client.** The renderer never imports this module (Phase 10 invariant — see docblock lines 1–11). utilityProcess receives the access-token JWT via `jwtBridge`; not relevant for Phase 11 character CRUD (CRUD runs in main).

---

### Edge Function shape (only if needed)

**Source:** `supabase/functions/delete-me/index.ts` lines 22–105 + `supabase/functions/_shared/cors.ts`
**Apply to:** **probably no new Edge Functions in Phase 11** (RESEARCH §Standard Stack — direct supabase-js + RLS is the default). Reserved for the orphan Storage cleanup if RLS makes the direct-delete path inadequate.

**If used, copy:** CORS preflight handling (line 26), method gate (line 27), Bearer extraction (lines 29–32), two-client setup (lines 36–44), `userClient.auth.getUser()` (line 46), then the privileged operation, then return 204 (line 104). Mirror the BL-03 ordering note (lines 53–59) — destructive action BEFORE the queue insert.

---

### First-launch migration entry (idempotent + manifest-gated)

**Source:** `src/main/migration.ts:49-138` (`runFirstLaunchMigration`) — early-return idempotency at line 53
**Apply to:** the new `runUuidRenameMigration()` in `migration.ts`
**Wiring point:** `src/main/index.ts:120-122` (existing `runFirstLaunchMigration` call) — the new migration goes immediately after (RESEARCH §Pattern 6 + Pitfall 7).

**Boot-order invariant:** all migrations MUST complete before `botSupervisor` is wired (step 4 in `index.ts:243`). The existing chain already enforces this — keep the new migration inside the same pre-supervisor block.

---

### SignInModal `framingLabel` inline-upgrade

**Source:** `src/renderer/src/components/SignInModal.tsx` props at line 26–34 + render at lines 167–169 (`framingLabel ? 'Sign in to {framingLabel}' : null`)
**Apply to:** `CharacterPage.tsx` when a signed-out user toggles `shared = true`
**Existing literal:** `useAuthStore.ts:24` — `'share this character'` is already part of `UpgradeFraming`. **No new component work; no new framing literal.** Just wire the toggle's signed-out branch to set `upgradeFraming` and open the modal.

---

### Banner reuse for ToS re-acceptance announce

**Source:** `src/renderer/src/components/Banner.tsx` (entire 35-line file)
**Apply to:** Phase 10 alpha-account legacy ToS prompt (D-26) — show a Banner above the AcceptToSModal if the modal is currently mounted-but-deferred (rare), OR show it as a quieter alternative for users who already accepted but legal versions bumped.

**Existing API to consume:**
```typescript
<Banner kind="warn" message="We've updated our Terms of Service. Please review." />
```

---

### StatusPill reuse for sync state

**Source:** `src/renderer/src/components/StatusPill.tsx` (entire 59-line file) — five tones (green / red / warn / muted / pulse)
**Apply to:** HomeScreen card render + CharacterPage header
**Mapping:**
- `synced` → `tone="muted"` label `"SYNCED"` (or hide entirely after fade-out per CONTEXT §specifics)
- `syncing` → `tone="pulse"` label `"SYNCING"`
- `failed` → `tone="warn"` label `"SYNC FAILED — RETRY"` with a clickable retry handler

---

### Deletion-queue cron pattern for orphan Storage cleanup

**Source:** `supabase/migrations/20260520000000_deletion_queue.sql` lines 15–43 (`pg_cron`, `cron.schedule`)
**Apply to:** `<ts>_storage_purge_extend.sql` migration — `cron.unschedule('purge-deletion-queue')` then `cron.schedule(...)` with an extended body iterating `storage_paths`

**Existing body (lines 34–43) — the template to extend:**
```sql
select cron.schedule(
  'purge-deletion-queue',
  '0 3 * * *',
  $$
    update public.deletion_queue
    set purged_at = now()
    where deletion_requested_at < now() - interval '30 days'
      and purged_at is null
  $$
);
```

**Extended body** must call `storage.objects` DELETE for each entry in `storage_paths jsonb` before marking purged.

---

## No Analog Found

| File | Role | Reason |
|------|------|--------|
| `../sei-website/terms.html` | static legal | Lives in sibling repo; pattern is "static HTML page" — no in-repo precedent. Planner should look at the existing `index.html` / `pitch.html` in `../sei-website/` for footer + style continuity. |
| `../sei-website/privacy.html` | static legal | Same as above. |

These are the ONLY two files in Phase 11 without an in-repo analog — every other new/modified file has a concrete excerpt-source above.

---

## Metadata

**Analog search scope:**
- `src/main/**` (all 25 files including `auth/`)
- `src/shared/**`
- `src/renderer/src/components/**` + `src/renderer/src/screens/**` + `src/renderer/src/lib/stores/**`
- `supabase/migrations/**` + `supabase/functions/**`
- `src/bot/brain/storage/{atomicWrite,fileLock}.js`

**Files scanned:** ~50 source files, all read in full or via targeted line ranges as needed.

**Pattern extraction date:** 2026-05-21

**Key takeaway for planner:** Every NEW file in Phase 11 has a near-perfect existing analog. The phase is "copy these shapes + extend":
- `cloudCharacterClient.ts` = `edgeFunctionClient.ts` + `skinStore.ts` composition
- `syncQueue.ts` = `sessionStore.ts` without encryption
- `portraitImageUtil.ts` = `skinImageUtil.ts` with 3 magic-byte tables
- `tosGate.ts` = `exportBuilder.ts` shape with a supabase query
- New migrations = `20260520000000_deletion_queue.sql` shape
- `AcceptToSModal.tsx` / `MigrateLocalCharsModal.tsx` = `DeleteAccountModal.tsx` shape
- IPC handlers = existing `ipc.ts:120-131` shape with `IdSchema` regex bumped to UUID
- Error families = existing `KEYCHAIN_*` / `SESSION_*` prefix-coded sentinel pattern extended to `CLOUD_SYNC_*` / `TOS_*` / `PORTRAIT_*`

## PATTERN MAPPING COMPLETE

Phase 11 NEW files copy from edgeFunctionClient + skinStore + sessionStore + skinImageUtil + DeleteAccountModal + deletion_queue.sql; modified files extend characterStore/skinStore/ipc/migration with the established atomic-write, IdSchema-validated, lazy-import, CLOUD_SYNC_* typed-error conventions.
