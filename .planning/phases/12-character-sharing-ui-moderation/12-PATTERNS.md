# Phase 12: Character Sharing UI + Moderation — Pattern Map

**Mapped:** 2026-05-22
**Status:** Ready for planning
**Scope:** Phase 12 (SHARE-01..SHARE-10) — Browse tab, search/Add-to-Mine, three moderation gates (CSAM scan, prompt moderation, Report/DMCA), DMCA agent publication, BROWSE_ENABLED feature flag.

This file maps each new artifact the Phase 12 plans will produce to its closest existing analog in the Sei codebase. The planner consumes each entry to write task-level "follow this pattern, change these specifics" directives.

---

## File Classification

| New / Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `supabase/functions/moderate-character-images/index.ts` | Edge Function | request-response (HTTP REST out to SightEngine) | `supabase/functions/delete-me/index.ts` | role-match (auth+admin precedent) |
| `supabase/functions/moderate-character-prompt/index.ts` | Edge Function | request-response (HTTP REST out to OpenAI) | `supabase/functions/delete-me/index.ts` | role-match |
| `supabase/functions/backfill-moderate-existing/index.ts` | Edge Function | batch / idempotent walk | `supabase/functions/delete-me/index.ts` | partial — closest service-role admin pattern |
| `supabase/functions/notify-report/index.ts` | Edge Function | event-driven (pg_notify webhook) | `supabase/functions/delete-me/index.ts` | partial — first webhook trigger consumer |
| `supabase/migrations/20260522*_moderation_and_reports.sql` | DB migration | DDL + RPC + trigger | `supabase/migrations/20260521000000_characters_tos.sql` | exact (same table & RLS conventions) |
| `src/shared/ipc.ts` (additions) | IPC contract | request-response | existing `IpcChannel.{chars,migration,tos}` blocks | exact |
| `src/main/ipc.ts` (additions) | Main handlers | request-response | existing migration / tos / chars handler blocks | exact |
| `src/preload/index.ts` (additions) | Preload bindings | bridge | existing migration / tos bindings | exact |
| `src/renderer/src/screens/CharactersScreen.tsx` (refactor of HomeScreen) | Screen + tab control | local-state-driven | `src/renderer/src/screens/HomeScreen.tsx` | exact (this IS the file under refactor) |
| `src/renderer/src/components/BrowseCard.tsx` | Component | render-only | `src/renderer/src/components/CharacterCard.tsx` | exact |
| `src/renderer/src/components/ReportModal.tsx` | Component (modal) | request-response on submit | `src/renderer/src/components/MigrateLocalCharsModal.tsx` | exact (phased modal w/ idle→submitting→results) |
| `src/renderer/src/lib/stores/useBrowseStore.ts` | Zustand store | pull-on-demand + paged | `src/renderer/src/lib/stores/useCloudCharactersStore.ts` (shape) + `useSyncStore.ts` (init pattern) | role-match |
| `src/renderer/src/components/DmcaContactModal.tsx` | Component (modal) | static info display | `src/renderer/src/components/AcceptToSModal.tsx` | role-match (info modal, external link to agent registration) |
| `src/renderer/src/screens/SettingsScreen.tsx` (Legal panel addition) | Screen (panel section) | static + click-to-open | existing `section` blocks in `SettingsScreen.tsx` (ACCOUNT, PROFILE, APPEARANCE) | exact (just another `<section>`) |
| `src/main/cloud/cloudCharacterClient.ts` (additions: `moderateAndUpload*` wrappers) | Service | request-response | existing `upsertCharacter` / `uploadPortrait` / `uploadSkin` | exact |
| `src/main/capabilities.ts` (new — BROWSE_ENABLED gate) | Config | one-shot read at boot | `src/main/configStore.ts` + `src/main/ipc.ts` `app:warnings` handler | role-match (boot-time one-shot query) |
| `../sei-website/terms.html` (§7 DMCA Notices insertion + section renumber) | Static legal doc | n/a | existing §7 (Third-Party Game Compatibility) | exact (HTML section pattern) |
| `../sei-website/privacy.html` (cross-ref add) | Static legal doc | n/a | existing privacy.html §11 Contact | exact |

---

## Pattern Assignments

### `supabase/functions/moderate-character-images/index.ts`

- **Analog:** `supabase/functions/delete-me/index.ts` (Deno + supabase-js + `_shared/cors.ts`)
- **Copy:**
  - CORS pre-flight handling (`req.method === 'OPTIONS'` → 200 with `corsHeaders`).
  - Method gating (`req.method !== 'POST'` → 405).
  - Bearer-token JWT extraction + `userClient.auth.getUser()` identity check (lines 29–50 of `delete-me/index.ts`).
  - Two-client pattern: `userClient` (anon key + caller's JWT) for identity; `adminClient` (service_role) for the moderation update on `characters` row (lines 36–44).
  - Compensating-write structure: if SightEngine call succeeds but DB UPDATE fails, log and return 500 so the caller knows the moderation state is unconfirmed.
  - Top-of-file JSDoc preamble documenting flow steps + invariants (lines 1–21).
- **Change:**
  - Body shape: `{ characterId: string, portraitUrl: string }` (signed URL to the just-uploaded portrait — the function reads it back, never accepts raw bytes over IPC-to-edge).
  - Outbound call = `fetch('https://api.sightengine.com/1.0/check.json?models=nudity-2.1,offensive,minor&...')` with `SIGHTENGINE_USER` + `SIGHTENGINE_SECRET` from `Deno.env`.
  - On clean → `adminClient.from('characters').update({ moderation_status: 'clean', moderation_checked_at: now, moderation_provider: 'sightengine-v2.1' }).eq('id', characterId)`.
  - On flagged → same UPDATE with `moderation_status: 'flagged'` AND `shared = false`.
  - Response: `{ status: 'clean' | 'flagged', category?: string }`.
  - Wrap outbound `fetch` in an AbortController with a 10s timeout (mirrors `edgeFunctionClient.ts` pattern — every external call has a timeout per CLAUDE.md invariant).
- **Pitfalls:**
  - `delete-me` uses `corsHeaders` set to `'Access-Control-Allow-Origin': 'null'` because Sei is a desktop app — every Edge Function is invoked from main-process `fetch` via `callEdgeFunction`, never browser-origin. Preserve this. Do NOT widen to `'*'` (see WR-08 comment in `_shared/cors.ts`).
  - `delete-me` re-orders destructive ops to be GDPR-safe (delete-user-first, queue-second). For image moderation the analog is: write `moderation_status` to DB BEFORE returning success; if the DB write fails after the SightEngine call lands, the caller MUST retry rather than assume clean.
  - SightEngine returns category scores, not a binary verdict — the threshold logic (`minor.prob > 0` blocks; `nudity > 0.5` blocks) lives inside this function. Document thresholds in the JSDoc preamble like `delete-me` does.
  - `service_role` key lives ONLY in Edge Function secrets (`supabase secrets set SUPABASE_SERVICE_ROLE_KEY=...`), never in the desktop client (invariant from `delete-me/index.ts:17`).

### `supabase/functions/moderate-character-prompt/index.ts`

- **Analog:** `supabase/functions/delete-me/index.ts`
- **Copy:**
  - Same JWT + CORS + method scaffolding as `moderate-character-images`.
  - Two-client pattern (userClient for identity, adminClient for DB writes).
- **Change:**
  - Body shape: `{ name: string, persona_source: string, persona_expanded?: string }`.
  - Outbound call = `fetch('https://api.openai.com/v1/moderations', { method: 'POST', headers: { Authorization: \`Bearer ${Deno.env.get('OPENAI_API_KEY')}\`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'omni-moderation-latest', input: \`${name}\\n\\n${persona_source}\` }) })`.
  - Two-tier logic per CONTEXT D-33b:
    - Tier 1 (hard block): run on `name + persona_source` concatenated. Flag → return `{ verdict: 'block', category: '<friendly mapped category>' }`.
    - Tier 2 (soft regenerate): if `persona_expanded` is non-empty, run separately. Flag → return `{ verdict: 'regenerate', expandedNeedsRetry: true }`.
  - Friendly category mapping (NEVER expose raw OpenAI categories per CONTEXT D-33c): function-local lookup table.
  - 10s timeout on outbound fetch (same as `moderate-character-images`).
- **Pitfalls:**
  - OpenAI Moderation API is free but RATE-LIMITED on the account key. Cache identical (name+persona) inputs for 5 min in Edge Function memory (in-process Map) — repeated upload attempts of the same prompt should hit a single moderation call.
  - The response shape from OpenAI nests `results[0].categories` + `results[0].category_scores`. Don't blindly pass through — map to the friendly verdict shape above so the renderer ERROR_COPY surface stays stable across provider swaps (CONTEXT D-32b notes the provider abstraction).
  - Hard-block thresholds per CONTEXT D-33: sexual/minors ANY score; violence/graphic >0.85; hate/threat >0.85; self-harm/intent >0.85. Encode as constants at file top with JSDoc, not magic numbers in the conditional.

### `supabase/functions/backfill-moderate-existing/index.ts`

- **Analog:** `supabase/functions/delete-me/index.ts` (admin-client + service_role pattern)
- **Copy:**
  - Service-role admin client (NEVER expose to renderer).
  - JWT check on the trigger caller (when invoked from `supabase functions invoke` with a service-role JWT, the function still validates the bearer — defense in depth).
  - CORS scaffolding (called from local dev as well).
- **Change:**
  - No request body — function walks the entire `characters` table.
  - Query: `select id, owner, portrait_image from characters where shared = true and moderation_status is null order by created_at asc limit 100`.
  - For each row: call `moderate-character-images` internally (function-to-function via `fetch` to its own URL, signed with service_role JWT) OR factor the SightEngine call into a shared helper imported by both functions.
  - Idempotent: re-running picks up wherever it left off (the WHERE clause excludes `moderation_status IS NOT NULL`).
  - On flagged: same `shared=false` + `moderation_status='flagged'` UPDATE.
  - Email creator on flag (reuse the email path from `notify-report`).
  - Return `{ processed: number, flagged: number, errors: number }`.
- **Pitfalls:**
  - Edge Functions have a wall-clock execution limit (~150s on Supabase free tier). Use `limit 100` per invocation and have the function return `nextCursor: <last_id>` so the runner can re-invoke until empty. DO NOT try to walk the whole table in one call.
  - This function MUST complete before BROWSE_ENABLED flips true (CONTEXT D-36b). Operations runbook: invoke manually until `processed === 0` returned, then verify `select count(*) from characters where shared = true and moderation_status is null` returns 0.
  - The function is ONE-SHOT in practice but the code should be safe to run again at any time (idempotent on already-scanned rows because of the `moderation_status IS NULL` filter).

### `supabase/functions/notify-report/index.ts`

- **Analog:** `supabase/functions/delete-me/index.ts` (CORS + service_role + outbound HTTP pattern)
- **Copy:**
  - CORS + method gating preamble.
  - Service-role admin client for reading `reports` row + reporter email lookup.
  - 15s outbound fetch timeout pattern.
- **Change:**
  - Invocation path is Database Webhook on `reports` INSERT (configured via Supabase Dashboard → Database → Webhooks → "report_new"). The function receives the row payload directly per Supabase webhook contract (`{ type: 'INSERT', table: 'reports', record: { id, reporter_id, character_id, reason, detail, created_at } }`).
  - Two outbound fetches:
    1. SMTP via Resend / Postmark / Mailgun (whichever the project standardises — `RESEND_API_KEY` env var seems likely based on Supabase docs). Body = templated email to `dmca@sei.app` with character_id + reason + reporter info.
    2. Discord webhook to `Deno.env.get('DISCORD_REPORT_WEBHOOK_URL')`. Body = JSON Discord embed.
  - On auto-hide (separate trigger fires from DB; this function ALSO listens for the auto-hide notification): post a second Discord alert + email creator.
  - Rate-limit guard: refuse to forward if the same `reporter_id + character_id` already has a row in the last hour (DB query before sending — prevents griefer-spam-reports inflating SMTP costs).
- **Pitfalls:**
  - Database Webhook bodies are NOT signed in the Supabase free tier (no HMAC verification available). Defense: verify the call comes from Supabase by checking the `Authorization` header carries a known shared secret stored in `Deno.env.get('WEBHOOK_SECRET')` (set on both the DB webhook config and the Edge Function).
  - SMTP failures should NOT roll back the `reports` INSERT (the report is the user's intent and must persist even if email delivery is degraded). Log + Discord-alert + return 200 to the webhook so it doesn't retry-storm.
  - Discord webhook URLs are SECRETS — never log them. Even in error paths, log only the failure status, not the URL.

### `supabase/migrations/20260522000000_moderation_and_reports.sql`

- **Analog:** `supabase/migrations/20260521000000_characters_tos.sql` (table + RLS + trigger conventions) + `supabase/migrations/20260521000100_storage_buckets.sql` (RLS policy naming convention).
- **Copy:**
  - Table-creation idiom: `create table public.<name> (...)` with `id uuid primary key default gen_random_uuid()`, `created_at timestamptz not null default now()`.
  - RLS-enable + per-action policy pattern: `alter table public.<name> enable row level security;` followed by `create policy "<name>_<action>_<scope>"` for select/insert/update/delete.
  - Trigger naming + function shape: `create or replace function public.tg_set_updated_at()` + `create trigger <table>_set_updated_at before update on public.<table>` (lines 46–50 of `20260521000000_characters_tos.sql`).
  - Composite-key + immutable-row idiom from `tos_acceptance` (lines 53–68) for `reports` (reports are append-only from the user perspective — only service_role can resolve them).
  - Indexes alongside table-creation (line 27–30 of `20260521000000_characters_tos.sql`).
- **Change:** This migration is the union of FOUR DDL units:
  1. **Add columns to `characters`** (CONTEXT D-32d):
     ```sql
     alter table public.characters
       add column moderation_status text check (moderation_status in ('clean', 'flagged') or moderation_status is null),
       add column moderation_checked_at timestamptz,
       add column moderation_provider text;
     create index characters_moderation_pending_idx
       on public.characters (created_at)
       where shared = true and moderation_status is null;
     ```
  2. **Create `reports` table** (CONTEXT D-34a):
     ```sql
     create table public.reports (
       id uuid primary key default gen_random_uuid(),
       reporter_id uuid not null references auth.users(id) on delete cascade,
       character_id uuid not null references public.characters(id) on delete cascade,
       reason text not null check (reason in ('csam', 'hate', 'copyright', 'other')),
       detail text check (char_length(detail) <= 500),
       created_at timestamptz not null default now(),
       resolved_at timestamptz,
       resolution text
     );
     alter table public.reports enable row level security;
     create policy "reports_insert_own" on public.reports
       for insert with check (reporter_id = auth.uid());
     -- NO select/update/delete policies — service_role only (mirrors tos_acceptance immutability invariant).
     create index reports_character_recent_idx on public.reports (character_id, created_at desc);
     create index reports_reporter_recent_idx on public.reports (reporter_id, created_at desc);
     ```
  3. **RPC `search_public_characters`** (CONTEXT D-31a):
     ```sql
     create or replace function public.search_public_characters(query text, lim int default 24, off int default 0)
     returns setof public.characters
     language sql stable
     security invoker  -- inherits caller RLS; "shared=true OR owner=auth.uid()" select policy already in place
     as $$
       select * from public.characters
       where shared = true
         and moderation_status = 'clean'
         and (query = '' OR name ilike '%' || query || '%' OR persona_source ilike '%' || query || '%')
       order by updated_at desc
       limit lim offset off
     $$;
     ```
  4. **Auto-hide trigger** (CONTEXT D-34c):
     ```sql
     create or replace function public.tg_reports_auto_hide() returns trigger language plpgsql as $$
     declare distinct_reporters int;
     begin
       select count(distinct reporter_id) into distinct_reporters
         from public.reports
        where character_id = new.character_id
          and created_at > now() - interval '24 hours';
       if distinct_reporters >= 3 then
         update public.characters set shared = false where id = new.character_id;
         perform pg_notify('reports_auto_hide', new.character_id::text);
       end if;
       perform pg_notify('reports_new', new.id::text);
       return new;
     end $$;
     create trigger reports_after_insert after insert on public.reports
       for each row execute function public.tg_reports_auto_hide();
     ```
- **Pitfalls:**
  - `reports` has NO select policy — that's intentional (mirrors `tos_acceptance`'s no-update/no-delete invariant). Reporter sees a generic "thanks, we received it" toast and never sees the row back. Admin SELECT happens via `supabase` CLI or Dashboard against service_role only.
  - `search_public_characters` uses `security invoker` so RLS on the caller is honoured — DO NOT set `security definer` (would bypass RLS and leak rows where `shared = false` after auto-hide).
  - The auto-hide trigger fires on INSERT AFTER (not BEFORE) so the count includes the new row. Verify with a 3-distinct-reporters test in dev.
  - Add the columns to `characters` BEFORE creating the index that filters on `moderation_status` — Postgres rejects "column does not exist" otherwise.
  - The existing `characters_set_updated_at` trigger (from `20260521000000_characters_tos.sql:49`) fires on EVERY UPDATE — that means `moderation-character-images`'s status UPDATE will bump `updated_at`. This is fine for Browse `order by updated_at desc` since just-moderated chars naturally float to top. But it means the backfill function MUST batch updates carefully (or new shared chars get flooded out by retroactive moderation completions). Process backfill in `created_at asc` order so the oldest-first order is preserved in the final Browse listing.

### `src/shared/ipc.ts` — additions

- **Analog:** existing `IpcChannel.migration` and `IpcChannel.tos` blocks (lines 543–565 of `src/shared/ipc.ts`).
- **Copy:**
  - Channel naming: `<domain>:<kebab-action>` strings (e.g. `'migration:list-local'`, `'tos:status'`).
  - JSDoc preamble before each new channel block explaining what it does + which IPC handler implements it.
  - Add the new channel grouping to the `IpcChannelName` discriminated union at file end (lines 567–578).
  - For each new method on `RendererApi`, JSDoc covering behaviour, return shape, signed-out fallback.
- **Change:** Add a new block:
  ```typescript
  // Phase 12 — Browse + moderation + reports.
  browse: {
    /** Paged listing of public, moderated-clean characters. Args: { query, limit, offset }. */
    list: 'browse:list',
    /** Submit a report on a public character. Args: { characterId, reason, detail? }. */
    report: 'browse:report',
    /** Moderate-then-publish a character (calls moderate-character-images + -prompt before flipping shared=true). Args: { characterId }. */
    publishWithModeration: 'browse:publish-with-moderation',
  },
  capabilities: {
    /** Read BROWSE_ENABLED + future feature flags from main. One-shot. */
    get: 'capabilities:get',
  },
  ```
  Plus on `RendererApi`:
  ```typescript
  browseList(args: { query: string; limit: number; offset: number }): Promise<{ entries: BrowseEntry[]; hasMore: boolean }>;
  browseReport(args: { characterId: string; reason: 'csam' | 'hate' | 'copyright' | 'other'; detail?: string }): Promise<{ ok: true } | { ok: false; code: 'rate_limited' | 'network'; message: string }>;
  charsPublishWithModeration(characterId: string): Promise<{ ok: true } | { ok: false; code: 'image_flagged' | 'prompt_flagged' | 'network'; message: string }>;
  getCapabilities(): Promise<{ browseEnabled: boolean }>;
  ```
  And a new domain type:
  ```typescript
  export interface BrowseEntry {
    id: string;
    name: string;
    personaSnippet: string;        // first 120 chars of persona_source, ellipsised
    creatorLabel: string;          // 'by anonymous' or 'by user-<short uuid frag>' per CONTEXT §specifics
    portraitUrl: string | null;    // signed/public URL from getStoragePublicUrl
    skinUrl: string | null;
    updatedAt: string;             // ISO
    inMyLibrary: boolean;          // computed renderer-side from useCloudCharactersStore.cloudIds
  }
  ```
- **Pitfalls:**
  - `BrowseEntry.inMyLibrary` is computed BY THE MAIN HANDLER, not the renderer — main does the cloud-id set lookup so the renderer doesn't have to await two stores before render. This is a divergence from `useCloudCharactersStore`'s renderer-side `inCloudSet` lookup pattern (`CharacterCard.tsx:75`); the Browse listing comes through main pre-joined for snappy paging.
  - The `IpcChannelName` discriminated union at the file end MUST be updated for each new channel group — TS doesn't warn if you forget, but the preload wiring will throw at runtime when the channel name doesn't match the registered handler.
  - DO NOT add `browse:list` to the cloud-write gate (`isCloudWriteAllowed`) — listing public characters is READ, available to signed-out users. Only `browse:report` and `charsPublishWithModeration` go through the gate.

### `src/main/ipc.ts` — additions

- **Analog:** existing `IpcChannel.migration.listLocal` + `migration.upload` handler blocks (lines 509–601).
- **Copy:**
  - Lazy-import discipline: `const { ... } = await import('./...');` inside the handler body (matches lines 510, 516, 543 — prevents module-init cycles).
  - Session check pattern: `const { data: { session } } = await getClient().auth.getSession(); if (!session?.user?.id) return <signed-out shape>;` (lines 511–512 + 543–547).
  - Cloud-write gate: `const { isCloudWriteAllowed } = await import('./auth/authState'); if (!(await isCloudWriteAllowed())) return <refused>;` (lines 539–542) — applies to `browseReport` and `charsPublishWithModeration`.
  - Zod argument validation at boundary (e.g. lines 532, 604).
  - Per-uuid result shape for partial-failure batch operations (lines 554–600).
- **Change:**
  - `browse:list` handler: signed-in OR signed-out (no gate); calls `supabase.rpc('search_public_characters', { query, lim, off })` via `cloudCharacterClient`; joins each row with `getStoragePublicUrl` to produce `portraitUrl` / `skinUrl`; computes `inMyLibrary` against the session user's cloud-id set.
  - `browse:report` handler: gated by `isCloudWriteAllowed`; Zod schema `z.object({ characterId: IdSchema, reason: z.enum(['csam','hate','copyright','other']), detail: z.string().max(500).optional() })`; INSERT into `reports` via main-process supabase client. Returns `{ ok: true }` even when the user has already reported this character (Postgres unique constraint via partial index — main translates the conflict into a friendly "thanks").
  - `browse:publish-with-moderation` handler: gated by `isCloudWriteAllowed`; calls `cloudCharacterClient.moderateAndPublish(characterId)` which internally invokes `callEdgeFunction('moderate-character-images', ...)` and `callEdgeFunction('moderate-character-prompt', ...)` SERIALLY (image first since portrait upload is a hard prerequisite for prompt moderation having a row to update); on clean → flips `shared = true`; on flagged → returns the flagged-category code so the renderer renders the friendly error from CONTEXT §specifics.
  - `capabilities:get` handler: reads `<userData>/config.json` (via existing `loadConfig`) for `browse_enabled` field; merges with `process.env.BROWSE_ENABLED === 'true'` override per CONTEXT D-36a (dev mode); returns `{ browseEnabled: boolean }`.
- **Pitfalls:**
  - The migration handler at line 509 demonstrates the correct shape for "signed-out returns []" — replicate for `browse:list` so the Browse tab renders cleanly under signed-out (LIB-04 invariant — Browse is read-public, even signed-out users can view).
  - `browse:report` MUST NOT echo back the reporter's identity in error messages — keep the response shape minimal (`{ ok, code, message }`) to avoid leaking PII through the IPC boundary if the renderer accidentally logs it.
  - `IpcChannel.app.openExternal` at line 627 URL-allowlists to `sei.gg` — the DMCA contact modal links to `https://dmca.copyright.gov/` and `mailto:dmca@sei.app`. Either extend the allowlist (preferred — add `dmca.copyright.gov` for the registration receipt link) OR add a parallel `app:open-dmca-link` handler with its own narrow allowlist. The planner should pick one and document.
  - `migration.upload` lazy-imports `readFile` from `node:fs/promises` (line 552) — same convention applies for any node:* imports in the new Browse handlers (avoids the static-import-at-top + cyclic-imports problem documented in `tosGate` lazy-imports).

### `src/preload/index.ts` — additions

- **Analog:** existing migration bindings at lines 97–100 and sync push channel at lines 50–54.
- **Copy:**
  - One-line `ipcRenderer.invoke(IpcChannel.X.Y, args)` wrappers for request-response.
  - For push channels (if any), the on/off handler wrapping pattern at lines 86–90.
- **Change:**
  - Add the new bindings under a `// --- Browse + moderation (Phase 12) ---` comment block:
    ```typescript
    browseList: (args) => ipcRenderer.invoke(IpcChannel.browse.list, args),
    browseReport: (args) => ipcRenderer.invoke(IpcChannel.browse.report, args),
    charsPublishWithModeration: (id) => ipcRenderer.invoke(IpcChannel.browse.publishWithModeration, id),
    getCapabilities: () => ipcRenderer.invoke(IpcChannel.capabilities.get),
    ```
- **Pitfalls:**
  - The preload is the ONLY surface the renderer touches `ipcRenderer` through. The new bindings MUST appear inside the `api: RendererApi = {...}` object so they're exposed via `contextBridge.exposeInMainWorld('sei', api)` at line 129. Adding them outside that object is a silent no-op.

### `src/renderer/src/screens/CharactersScreen.tsx` (refactor of `HomeScreen.tsx`)

- **Analog:** `src/renderer/src/screens/HomeScreen.tsx` — this IS the file under refactor.
- **Copy:**
  - Existing imports + theme detection (lines 17–26, 107–109).
  - Existing LAN pill + "+ New" header (lines 170–187) — these belong on the HOME tab.
  - Existing local + cloud-only grid (lines 188–298) — belongs on the HOME tab.
  - Per CONTEXT D-31 wording: the refactor introduces a segmented control / tab bar at the top of the screen. Pattern for the tab bar: use the existing `Button` component with `kind="quiet"` for inactive and `kind="primary"` for active, mirroring `SetupWizardModal`'s step indicator if available.
  - When BROWSE_ENABLED === false, render ONLY the Home tab (no tab bar visible — CharactersScreen looks identical to today's HomeScreen). The capability comes from `getCapabilities` IPC + a renderer-side `useCapabilitiesStore` or memoised hook.
- **Change:**
  - Rename file from `HomeScreen.tsx` → `CharactersScreen.tsx`. Update the route in `App.tsx` accordingly.
  - Add tab state: `const [tab, setTab] = useState<'home' | 'browse'>('home')`.
  - Add `{ tab === 'home' ? <HomeGrid /> : <BrowseGrid /> }` switch; both grids extracted into local components (or co-located in the same file) to keep the refactor reviewable.
  - `<BrowseGrid />` uses `useBrowseStore` for entries + query + loadMore.
  - Search input at top of Browse tab: `<TextField value={query} onChange={(q) => useBrowseStore.getState().setQuery(q)} placeholder="Search characters..." />` with 250ms debounce inside the store (NOT in the screen — store owns debounce so multiple consumers stay consistent).
  - Empty state per CONTEXT §specifics: `"No public characters yet — be the first to share one."`.
  - Tab bar visibility gated on `useCapabilitiesStore(s => s.browseEnabled)`.
- **Pitfalls:**
  - The existing HomeScreen already fires `sei.charsListMerged()` in a useEffect (lines 76–102). When refactoring, KEEP this on the Home tab — moving it to a parent screen would re-trigger network on every tab switch.
  - `cloudOnly` state + the `useEffect` that depends on `[authKind, characters]` (line 102 dep array) is local to the Home grid — move them into a co-located `HomeGrid` component, not into `CharactersScreen`'s body.
  - LAN pill belongs ONLY on the Home tab per CONTEXT — the Browse tab header is `Browse` H1 + search field, no LAN pill.
  - There's an existing `ComingSoonScreen.tsx` in screens/ — if BROWSE_ENABLED is false at runtime, do NOT redirect to ComingSoon; just hide the tab bar entirely so the user sees Home as they always have.

### `src/renderer/src/components/BrowseCard.tsx`

- **Analog:** `src/renderer/src/components/CharacterCard.tsx`
- **Copy:**
  - Top-level `<div className={styles.card} onClick={onOpen} role="button" tabIndex={0}>` wrapper (line 82).
  - `<PixelPortrait ...>` portrait wrap with gradient (lines 83–90). Same `pickPalette(c.id + c.name, theme)` seeding pattern.
  - Chip system at top-right (lines 91–96) for "Already in Library" / "Add to Mine" / status hints — reuse `styles.chip` + `styles.chipCustom` / `styles.chipDefault` styling primitives.
  - `<div className={styles.nameOverlay}>{c.name}</div>` overlay pattern (line 173).
  - `<div className={styles.hoverOverlay}>` action-on-hover slot (line 174).
  - JSDoc preamble explaining role, click contract, and source decision (lines 1–14).
- **Change:**
  - Props: `{ entry: BrowseEntry; onOpen: () => void; onAddToMine: () => void; onReport: () => void; theme: 'light' | 'dark' }`.
  - Hover-overlay button is "Add to Mine" (`kind="accent"`, icon = `<PlusIcon />` if available, else `<SparkleIcon />` from `icons.tsx`). When `entry.inMyLibrary === true`, swap for a disabled "Already in My Library" pill (use the LOCAL ONLY chip styling at line 107 as a starting point but with a friendlier label).
  - Add a creator attribution line under the portrait: `<div className={styles.creatorMeta}>{entry.creatorLabel}</div>`.
  - Persona snippet below name (truncated to 120 chars with `…` per CONTEXT D-31d): `<div className={styles.personaSnippet}>{entry.personaSnippet}</div>`.
  - Report button: small ghost-style icon button positioned top-LEFT (opposite of the existing top-right chip cluster) so it doesn't compete with the chip rail. Call `onReport` with `e.stopPropagation()` (mirrors the Summon click handler at lines 179–186).
  - Skip the entire sync-pill / LOCAL-ONLY / CLOUD chip logic — BrowseCard is for PUBLIC characters owned by other users; none of those states apply.
- **Pitfalls:**
  - CharacterCard reads `useAuthStore`, `useSyncStore`, `useCloudCharactersStore` (lines 23–25, 56–80). BrowseCard does NOT need any of these — keep it lean. The `inMyLibrary` flag is precomputed by main (see `BrowseEntry`). This avoids re-renders from sync/auth stores cascading through the Browse grid.
  - Report button MUST `e.stopPropagation()` — otherwise clicking Report also fires `onOpen` and the preview overlay appears under the modal.
  - Use the EXISTING `CharacterCard.module.css` styling primitives where possible. Per CONTEXT §discretion, the planner can introduce a `BrowseCard.module.css` for the new bits (creator meta, persona snippet, top-left report-button slot) but should NOT duplicate the existing `.card` / `.portraitWrap` / `.gradient` rules — `composes:` them from the original module or just `className={`${characterStyles.card} ${browseStyles.cardExtras}`}`.

### `src/renderer/src/components/ReportModal.tsx`

- **Analog:** `src/renderer/src/components/MigrateLocalCharsModal.tsx`
- **Copy:**
  - Phased state machine: `'idle' | 'submitting' | 'results'` (line 47).
  - Scrim with `onClick` SUPPRESSED for blocking-modal feel (lines 119–122 + JSDoc explaining the rationale).
  - Footer with `kind="quiet"` cancel + `kind="accent"` submit (lines 151–163).
  - JSDoc preamble explaining mount points (this one only has one: Browse card / preview overlay click) and the post-submit refresh hook (none — reports are fire-and-forget from the renderer perspective).
  - `aria-labelledby` + `role="dialog"` wiring (lines 116, 122).
  - `useState` buffer pattern for the form fields with `selected` set or radio state (line 51).
- **Change:**
  - Props: `{ characterId: string; characterName: string; onClose: () => void }`.
  - State: reason radio (`'csam' | 'hate' | 'copyright' | 'other'`) + detail textarea (capped 500 chars, `<textarea maxLength={500}>`).
  - Submit: `await sei.browseReport({ characterId, reason, detail })` then transition to `'results'` and render a `"Thanks — we'll review."` confirmation. On `{ ok: false, code: 'rate_limited' }`, render the friendly 429 copy.
  - NO refresh of any store on success — reports don't change the renderer-visible Browse listing immediately (the auto-hide trigger happens server-side; the next refresh of `useBrowseStore` will pick it up).
  - DOES need an `Esc` close path UNLIKE `AcceptToSModal.tsx:51-62` and UNLIKE `MigrateLocalCharsModal`'s click-outside-suppressed pattern — reports are not legal-gates, the user should be able to cancel mid-form. So: scrim onClick = onClose, AND a keydown Esc handler.
- **Pitfalls:**
  - The detail textarea MUST enforce the 500-char cap BOTH in the UI (`maxLength={500}` attribute) AND at the IPC boundary (Zod `.max(500)` in the main handler). DB CHECK constraint is the third defence (the migration above).
  - Reason values MUST match the DB CHECK constraint exactly (`'csam' | 'hate' | 'copyright' | 'other'`). Use a shared const exported from `src/shared/ipc.ts` so any future enum change propagates to all three layers.
  - On rate-limit 429, don't lock the user out — show the friendly copy + a "Try again later" button that just calls `onClose`. Locking the form would invite confused "what is sei doing" reports about Sei's own report UI.

### `src/renderer/src/lib/stores/useBrowseStore.ts`

- **Analog:** `src/renderer/src/lib/stores/useCloudCharactersStore.ts` (state-shape + init pattern) + `src/renderer/src/lib/stores/useSyncStore.ts` (idempotent init + refresh discipline).
- **Copy:**
  - File-level JSDoc explaining lifecycle + what triggers refresh (lines 1–23 of `useCloudCharactersStore.ts`).
  - `interface FooState` separated from `interface FooActions` (lines 28–56 of `useCloudCharactersStore.ts`).
  - `try/catch` with set-initialized-even-on-failure pattern (lines 65–74 of `useCloudCharactersStore.ts`).
  - Idempotent init guard (line 71 of `useSyncStore.ts`: `if (get().initialized) return;`).
- **Change:**
  - State shape:
    ```typescript
    interface BrowseState {
      entries: BrowseEntry[];
      query: string;
      loading: boolean;
      hasMore: boolean;
      offset: number;
      error: string | null;
      debounceHandle: number | null;
    }
    interface BrowseActions {
      setQuery: (q: string) => void;           // schedules a debounced (250ms) refresh
      loadMore: () => Promise<void>;            // appends next page (offset += 24)
      refresh: () => Promise<void>;             // resets and re-fetches from offset 0
      reset: () => void;
    }
    ```
  - `setQuery` cancels any in-flight debounce timer and schedules a fresh `refresh()` 250ms later (CONTEXT D-31a). Debounce lives IN THE STORE so the screen doesn't have to manage timers.
  - `loadMore` is a no-op when `hasMore === false` or `loading === true` (prevents double-fetch on rapid scroll).
  - `refresh` calls `sei.browseList({ query, limit: 24, offset: 0 })` and replaces `entries`; subsequent `loadMore` calls append.
- **Pitfalls:**
  - `useCloudCharactersStore.cloudIds` is a `Set<string>` for O(1) lookups (line 34). `useBrowseStore.entries` is an array because it's ORDERED by `updated_at desc` — don't substitute a Set. The "Already in Library" decision is precomputed by main and lives on each `BrowseEntry.inMyLibrary`, so the renderer never crosses the two stores.
  - The debounce timer is `window.setTimeout` not `setTimeout` — TypeScript will complain about return-type mismatch (number vs NodeJS.Timeout) inside the renderer module. `useDataStore` and `useSyncStore` model this correctly.
  - Don't call `refresh()` from the store's module-init; let `CharactersScreen` call it from a useEffect when the Browse tab mounts. This mirrors `useSyncStore.init()` being called from `App.tsx` rather than self-bootstrapping (line 12 JSDoc of `useSyncStore.ts`).

### `src/renderer/src/components/DmcaContactModal.tsx`

- **Analog:** `src/renderer/src/components/AcceptToSModal.tsx`
- **Copy:**
  - Scrim + modal + title + body layout (lines 91–135 of `AcceptToSModal.tsx`).
  - `aria-labelledby` wiring + `role="dialog"` (lines 89, 93).
  - `openExternal` link pattern via `sei.openExternal('https://...')` (lines 82–88 of `AcceptToSModal.tsx`).
  - JSDoc preamble naming the mount point (here: `SettingsScreen` → Legal panel → "Report copyright infringement (DMCA)" button).
- **Change:**
  - Props: `{ onClose: () => void }`.
  - Body content: agent name (placeholder until DMCA registration completes — per CONTEXT D-35b, the registration receipt URL is captured in Phase 12), mailing address, email (`dmca@sei.app`), link to the public Copyright Office Designated Agent Directory listing.
  - Two action buttons: "Open Directory listing" (`sei.openExternal('https://dmca.copyright.gov/list')`) + "Email DMCA agent" (`sei.openExternal('mailto:dmca@sei.app')`) + a Close button.
  - NO blocking-modal Esc suppression — this is an info modal, Esc closes it. Mirror `MigrateLocalCharsModal`'s footer button approach rather than `AcceptToSModal`'s ESC-blocked behaviour.
- **Pitfalls:**
  - `sei.openExternal` is URL-allowlisted in main (`src/main/ipc.ts:629-633`) to `sei.gg` only today. The DMCA modal needs to open `dmca.copyright.gov` AND `mailto:` — main MUST be extended (preferred: extend allowlist to include `dmca.copyright.gov` over https + the `mailto:` scheme). Document the allowlist change in the migration to the Legal panel plan.
  - The agent name + address are PUBLIC by Copyright Office mandate (you cannot DMCA-register anonymously). The modal text MUST not promise privacy to the registrant — match the legal reality.

### `src/renderer/src/screens/SettingsScreen.tsx` — Legal panel addition

- **Analog:** existing ACCOUNT / PROFILE / APPEARANCE `<section>` blocks (lines 218–393 of `SettingsScreen.tsx`).
- **Copy:**
  - `<section className={styles.section}>` with `<div className={styles.sectionTitle}>LEGAL</div>` (line 308 pattern).
  - `<div className={styles.row}>` rows with `rowLabel` + `Button` (line 248–252 pattern).
  - State for modal open/closed: `const [dmcaModalOpen, setDmcaModalOpen] = useState(false);` mirroring `signOutModalOpen` (line 60).
  - Conditional mount at component bottom: `{dmcaModalOpen ? <DmcaContactModal onClose={() => setDmcaModalOpen(false)} /> : null}` (mirrors line 395–404).
- **Change:**
  - Insert a new `<section>` after APPEARANCE (or wherever the planner deems best — Legal panel is a less-frequently-used section so end-of-screen is fine).
  - Rows: "Report copyright infringement (DMCA)" → opens DmcaContactModal; "Open Terms of Service" → `sei.openExternal('https://sei.gg/terms.html')`; "Open Privacy Policy" → `sei.openExternal('https://sei.gg/privacy.html')`.
  - Visible to BOTH signed-in and signed-out users (DMCA is a public-law thing — anyone running the app should be able to find the contact).
- **Pitfalls:**
  - Do not nest the Legal panel inside the existing `authState.kind === 'signed_in'` block (line 218). Move it OUTSIDE that conditional so signed-out users still see it.
  - The existing `<MigrateLocalCharsModal>` mount uses `migrateModalOpen` state (line 418–420) — copy that exact mount/unmount discipline rather than co-mounting via context (the codebase has no modal-mount provider).

### `src/main/cloud/cloudCharacterClient.ts` — `moderateAndUpload*` additions

- **Analog:** existing `upsertCharacter` + `uploadPortrait` + `uploadSkin` functions in this same file (lines 114–238).
- **Copy:**
  - Top-of-function `BEFORE-NETWORK guards` pattern (lines 114–120 of `upsertCharacter`).
  - `withTimeout` wrapper (lines 56–69) — every external call wrapped.
  - `CLOUD_*` sentinel-prefixed errors thrown so ERROR_COPY in renderer can route by prefix.
- **Change:**
  - New exports:
    ```typescript
    /** Moderates a freshly-uploaded portrait. Calls moderate-character-images Edge Function. */
    export async function moderatePortrait(characterId: string): Promise<{ status: 'clean' | 'flagged'; category?: string }> { ... }

    /** Moderates name + persona_source (hard block) + persona_expanded (soft regenerate). */
    export async function moderatePrompt(input: { name: string; personaSource: string; personaExpanded?: string }): Promise<{ verdict: 'clean' | 'block' | 'regenerate'; category?: string }> { ... }

    /** Full flow: moderate image + prompt, then UPSERT with shared=true. Used by SHARE-05. */
    export async function publishWithModeration(characterId: string): Promise<{ ok: true } | { ok: false; code: 'image_flagged' | 'prompt_flagged'; category: string }> { ... }
    ```
  - Each `moderate*` wrapper uses `callEdgeFunction` (from `../auth/edgeFunctionClient.ts`) — the established pattern for Edge Function calls in this project.
  - JWT for `callEdgeFunction` comes from the main-process supabase client session (mirrors `authHandlers.ts:438`).
- **Pitfalls:**
  - The `withTimeout` wrapper in `cloudCharacterClient.ts:56` uses `.abortSignal(signal)` on supabase-js calls. `callEdgeFunction` already has its own AbortController + timeout (line 38–39 of `edgeFunctionClient.ts`) — DO NOT double-wrap. Just call `callEdgeFunction(name, { jwt, body, timeoutMs: 30_000 })` with a longer timeout (30s) for the moderation calls because SightEngine + OpenAI together can run 5–10s.
  - `publishWithModeration` runs prompt moderation BEFORE flipping `shared = true` — the order matters because we don't want a flagged prompt to be publicly visible for any window. If image moderation already ran at upload (which it does — Edge Function fires from uploadPortrait), `publishWithModeration` may skip image step and just run prompt. Document this in the JSDoc.
  - The existing storage SDK in `uploadSkin`/`uploadPortrait` (lines 204–238) does NOT accept an AbortSignal (supabase-js bug #1185 noted at line 200). The new `moderate*` calls go through `callEdgeFunction` (regular `fetch`) so they DO have timeouts — no carry-over of the supabase-js limitation.

### `src/main/capabilities.ts` (new)

- **Analog:** `src/main/configStore.ts` (load-from-disk shape) + `src/main/ipc.ts` `app:warnings` handler at line 409 (one-shot boot-time query).
- **Copy:**
  - File-top JSDoc explaining role + invariants (lines 1–9 of `configStore.ts`).
  - Async loader function that reads + Zod-validates `<userData>/config.json` (lines 26–46).
  - Default constant exported alongside the loader (`export const DEFAULT_CAPABILITIES = { browseEnabled: false }`).
  - The `app:warnings` handler at `src/main/ipc.ts:409` is the precedent for a one-shot boot-state IPC: it composes multiple sub-checks into one return shape. `capabilities:get` follows that pattern.
- **Change:**
  - This module reads BOTH:
    - `<userData>/config.json` (existing UserConfig) — checks for `browse_enabled: true` (a new optional field on UserConfigSchema in `src/shared/characterSchema.ts`).
    - `process.env.BROWSE_ENABLED === 'true'` (CONTEXT D-36a — dev-mode override).
  - Returns `{ browseEnabled: boolean }` and any future flags. Wired into `IpcChannel.capabilities.get` handler.
- **Pitfalls:**
  - The UserConfigSchema is shared between main and renderer (`src/shared/characterSchema.ts`) — adding `browse_enabled` requires extending the Zod schema AND ensuring backward compatibility (existing config.json files don't have the field). Use `.optional().default(false)` so the schema parses old configs cleanly (mirrors how `theme_mode` was introduced).
  - Don't expose the raw env var value to the renderer — main composes the OR (`env_override OR config_file`) and returns just the resolved boolean. This keeps the renderer pure (no `process.env` access on the renderer side, which is correct under contextIsolation anyway).
  - Production builds MUST ship with config defaulting to `browse_enabled: false` (CONTEXT D-36a). The user manually flips it post-checklist by editing config.json or via a future admin command. The renderer NEVER gets a "Enable Browse" button — that's a deliberately friction-y manual step.

### `../sei-website/terms.html` — §7 DMCA Notices insertion

- **Analog:** existing `<h2>7. Third-Party Game Compatibility</h2>` section at lines 125–130 (the section that needs to be RENUMBERED to §8) and the existing footer pattern at lines 180–187.
- **Copy:**
  - Exact `<h2>N. Title</h2>` + `<p>...</p>` shape — matches every existing section.
  - `<a href="mailto:dmca@sei.app">dmca@sei.app</a>` linkification pattern (line 182).
  - `<code>VAR_NAME</code>` for any explicit version constants if referenced (line 177 — `<code>TOS_VERSION</code>` precedent).
- **Change:**
  - Insert a NEW `<h2>7. DMCA Notices</h2>` block BEFORE the current §7 (which becomes §8: Third-Party Game Compatibility). All subsequent sections shift by +1: 8→9, 9→10, ..., 13→14.
  - Content: full Designated Agent registration details (real legal name, mailing address, `dmca@sei.app`, link to the public Copyright Office Directory listing receipt URL captured during registration per CONTEXT D-35b).
  - Update the "Effective Date" footer (line 186) to reflect that the new §7 is a material change, AND bump `src/shared/legalVersions.ts:TOS_VERSION` from `'2026-05-21'` to `'2026-05-22'` (or whatever the next Phase 12 deploy date is) so existing signed-in users re-accept via `AcceptToSModal`.
- **Pitfalls:**
  - Renumbering sections means EVERY cross-reference in `terms.html` AND `privacy.html` that mentions a section number must be updated. There aren't many today, but search both files for `§\d+` and `section \d` first.
  - The TOS_VERSION bump triggers a blocking modal on every signed-in user on next launch (per `AcceptToSModal.tsx` mount logic). Plan the Phase 12 deploy timing so this isn't a surprise — coordinate with the BROWSE_ENABLED flip so users see "review new terms" + "Browse tab appeared" together rather than in two separate sessions.
  - DMCA agent listing is PUBLIC by federal law — do not include any "private/redacted" framing. Just the facts as the Copyright Office expects them.

### `../sei-website/privacy.html` — cross-ref to Terms §7

- **Analog:** existing `<h2>11. Contact</h2>` section at line 195+ of `privacy.html`.
- **Copy:** Same `<h2>` + `<p>` shape.
- **Change:** Either add a sentence in §11 Contact: `For DMCA copyright notices, see our <a href="/terms.html#dmca">Terms of Service §7</a>.`, OR add a new short `<h2>12. Copyright Notices</h2>` that links to terms §7. The CONTEXT D-35a wording leaves this open ("§ adds a link to Terms §7 for DMCA contact"); planner picks the cleaner shape.
- **Pitfalls:**
  - The `<h2 id="dmca">` anchor on the Terms side MUST be added if the privacy.html link uses `#dmca`. Otherwise the link 404s to a fragment.
  - Bumping `PRIVACY_VERSION` is not strictly required since cross-references don't materially change privacy practices — but the user-facing experience is smoother if both bump together (one re-acceptance prompt covers both docs).

---

## Cross-file conventions to preserve

These are project-wide patterns the planner should call out explicitly so each plan reinforces them:

1. **IPC channel naming = `<domain>:<kebab-action>`.** Every channel in `src/shared/ipc.ts` follows this. Phase 12 adds `browse:list`, `browse:report`, `browse:publish-with-moderation`, `capabilities:get` — all lowercase, hyphenated, single-colon. The `IpcChannelName` union at file end MUST be updated for each new group.

2. **Three-layer IPC contract: `src/shared/ipc.ts` (channel string + types + RendererApi method) → `src/main/ipc.ts` (`ipcMain.handle` + Zod validation at boundary) → `src/preload/index.ts` (`ipcRenderer.invoke` binding inside the `api: RendererApi` object).** All three must be updated in lockstep; the TS compiler ENFORCES the RendererApi shape but does NOT enforce that a channel constant has a handler registered. Run the renderer once with the new channel and watch for "no handler registered" errors as the final check.

3. **Main-process Zod validation at every IPC boundary.** Every `ipcMain.handle` body uses `XxxSchema.parse(arg)` before doing work (`IdSchema`, `PlaintextSchema`, ad-hoc `z.object({...})`). Phase 12 adds report-shape and browse-args schemas. The Zod schema is the trust boundary — preload doesn't validate, renderer can't be trusted.

4. **Lazy-import discipline inside IPC handler bodies.** Modules that touch supabase, fs, or cyclically-related code are imported via `const { ... } = await import('...')` INSIDE the handler closure (see `src/main/ipc.ts:471-486, 509-601`). This prevents module-init cycles and keeps the IPC registration synchronous. Phase 12 handlers follow the same pattern.

5. **Zustand store shape: `interface FooState` + `interface FooActions`, combined via `create<State & Actions>(...)`.** Initial state at top of the factory; actions below; selector helpers as actions for O(1) lookups. JSDoc preamble explains lifecycle + what fires `refresh()`. `useCloudCharactersStore.ts` is the canonical small store; `useSyncStore.ts` adds the idempotent `init()` + push-subscription pattern.

6. **Modal pattern: `<div className={styles.scrim} role="dialog" aria-modal="true" aria-labelledby={titleId}>` outermost, with explicit click-outside policy documented in JSDoc.** Blocking modals (legal, destructive) suppress click-outside AND ESC (`AcceptToSModal.tsx:54-62`); informational/cancellable modals allow both. Phased modals carry a `'loading' | 'idle' | 'submitting' | 'results'` state machine and a footer `<Button kind="quiet">Cancel</Button> <Button kind="accent">Submit</Button>` row.

7. **CSS module per component (`<Component>.module.css`).** Every component in `src/renderer/src/components/` ships with its own `.module.css`. No global stylesheet additions for component-level styling. New Phase 12 components (`BrowseCard`, `ReportModal`, `DmcaContactModal`) get their own modules; cross-component layout primitives are exposed via CSS custom properties on `:root` (light/dark theme).

8. **`CLOUD_*` sentinel-prefixed errors for renderer routing.** `src/main/cloud/cloudErrors.ts` enumerates the sentinels (`CLOUD_SYNC_TIMEOUT`, `CLOUD_STORAGE_UPLOAD_FAILED`, etc.); the renderer's ERROR_COPY map routes by prefix to user-friendly text. Phase 12 adds `CLOUD_MODERATION_IMAGE_FLAGGED`, `CLOUD_MODERATION_PROMPT_FLAGGED`, `CLOUD_REPORT_RATE_LIMITED` — all caught and remapped at the IPC boundary.

9. **Every external call wraps in an AbortController timeout.** `cloudCharacterClient.withTimeout` (15s default) for supabase-js queries; `edgeFunctionClient.callEdgeFunction` (15s default, 30s for moderation) for Edge Function calls; `fetch` inside Edge Functions uses its own `AbortController` (10s for SightEngine + OpenAI). This is the CLAUDE.md "every external call has a timeout — no exceptions" invariant.

10. **Edge Function CORS = `'Access-Control-Allow-Origin': 'null'`.** Sei is a desktop app, never browser-origin. `supabase/functions/_shared/cors.ts` documents the WR-08 rationale. All new Edge Functions in Phase 12 import `corsHeaders` from this shared module — do not override.

11. **`service_role` key NEVER leaves Edge Function secrets.** Set via `supabase secrets set SUPABASE_SERVICE_ROLE_KEY=...` and accessed only via `Deno.env.get(...)`. The desktop client uses the anon key + per-user JWT. Phase 12 reinforces this: SightEngine credentials, OpenAI API key, Discord webhook URL, Resend API key all live in Edge Function secrets.

12. **Schema-version constants live in `src/shared/legalVersions.ts` and are bumped manually.** Bumping `TOS_VERSION` triggers `AcceptToSModal` for every signed-in user on next launch. Phase 12 bumps both `TOS_VERSION` and `PRIVACY_VERSION` for the §7 DMCA insertion + cross-ref — coordinate with the BROWSE_ENABLED flip so users experience the re-acceptance and the new feature in the same session.
