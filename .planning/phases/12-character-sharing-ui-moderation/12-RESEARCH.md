# Phase 12: Character Sharing UI + Moderation — Research

**Researched:** 2026-05-22
**Domain:** Moderated public character library (Browse UI + 3 moderation gates + DMCA)
**Confidence:** HIGH on stack/APIs; MEDIUM on Supabase Database-Webhook pattern (verified via docs but never exercised in this codebase yet); LOW only on SightEngine per-call price (free tier ample for v1.0; exact paid pricing requires contacting sales)

## Summary

Phase 12 is a UI + moderation phase, not an architecture phase. Most of the heavy lifting (Postgres schema, RLS, Storage buckets, the `cloudCharacterClient` IPC ladder, the local sync queue, the cache-on-demand pattern, and the `useCloudCharactersStore` membership-test pattern) already shipped in Phase 11. Phase 12 layers four new things on top:

1. **Browse UI** — new `useBrowseStore` zustand store + new Browse tab in `CharactersScreen.tsx` (today this is `HomeScreen.tsx`; check whether a wrapper or rename is needed). Server-side ILIKE search via a single Supabase RPC `search_public_characters`. Infinite scroll via `IntersectionObserver` sentinel pattern. Add-to-Mine reuses `cacheOnDemand.ensureLocallyCached` via the existing `chars:openPrepare` IPC channel — no new "claim" IPC needed.
2. **Three moderation gates** — all implemented as Supabase Edge Functions following the established `delete-me/index.ts` precedent: `moderate-character-images` (SightEngine `nudity-2.1,face-attributes` — the model spelling is `face-attributes`, NOT `minor`), `moderate-character-prompt` (OpenAI `omni-moderation-latest`), `notify-report` (email + Discord). Synchronous block at upload for image/prompt; trigger-fired async for reports.
3. **`reports` table + auto-hide trigger + retroactive-scan one-shot** — additive schema migration. The pg_notify pattern in CONTEXT D-34b is reframed below — Supabase's first-class **Database Webhooks** wrap `pg_net.http_post`, which is the standard pattern for trigger → external Edge Function. `pg_notify` alone does NOT cross the network boundary.
4. **DMCA + BROWSE_ENABLED flag** — manual paperwork ($6 / 3yr eForm to copyright.gov) + a new boolean in `config.json` read at main-process boot and pushed to renderer via a new entry on `app:warnings` payload OR a fresh `app:capabilities` channel.

**Primary recommendation:** Use Supabase **Database Webhooks** (not raw `pg_notify`) for the report-insert → `notify-report` Edge Function fan-out. The Phase 11 architecture (public Storage buckets per `20260521000100_storage_buckets.sql`) is INCONSISTENT with CONTEXT D-32b's "use the existing private bucket pattern from Phase 11 + signed-URL-only public read after clean" — the buckets are PUBLIC today. Planner must either (a) keep buckets public and gate publicly-visible-on-Browse on `characters.shared = true AND moderation_status = 'clean'` (simpler; relies on Pitfall 10 UUID-entropy obscurity), or (b) introduce a Phase 12 migration to flip buckets to private and add `createSignedUrl`-based serving. Recommend option (a) — keeps Phase 11 invariants intact and the moderation gate lives at the row level where Browse RPC enforces it.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|---|---|---|---|
| Browse tab UI + search | Renderer | Main (IPC) | Renderer drives query state via `useBrowseStore`; main proxies the `supabase.rpc(...)` call (renderer has no direct `@supabase/supabase-js` — Phase 11 boundary invariant) |
| Server-side text search RPC | Database (plpgsql) | — | `search_public_characters(query, limit, offset)` runs ILIKE in Postgres; RLS already permits SELECT where `shared = true` |
| CSAM image moderation | Edge Function | SightEngine API | Synchronous fetch from `cloudCharacterClient.uploadPortrait`; API call out via Deno fetch; result blocks upload |
| Prompt moderation | Edge Function | OpenAI API | Free API, ~100ms latency, called server-side so the key never leaves the Edge env |
| Report submission | Renderer → Main → DB INSERT | RLS | User-scoped INSERT; rate-limit enforced by Edge Function NOT direct INSERT (see Pitfall 4) |
| Report notification fan-out | Database Webhook → Edge Function | Discord/email | `pg_net.http_post` invoked from trigger; Edge Function sends to Discord webhook URL + Resend/Postmark email |
| Auto-hide 3-reporters-in-24h | Database trigger (plpgsql) | — | Row-level AFTER INSERT trigger on `reports`; updates `characters.shared = false` when threshold met |
| Add-to-Mine | Renderer → Main (IPC) | Existing `cacheOnDemand` | Reuses `chars:openPrepare` — the cloud row's RLS already permits SELECT on `shared = true`, the renderer just needs the UUID |
| BROWSE_ENABLED flag | Main process (boot config) | Renderer (via capabilities IPC) | Boolean in `<userData>/config.json`; renderer hides Browse tab when false |
| DMCA agent surfaces | Renderer (settings) + sei-website repo | — | Static content, three publishing surfaces (a) (b) (c) per D-35a |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---|---|---|---|
| `@supabase/supabase-js` | `^2.106.0` (already installed; latest `2.106.1` verified via `npm view`) | Browse RPC call from main; report INSERT | Existing dep; matches Phase 11 pattern |
| Deno runtime + `@supabase/supabase-js` (Deno) | (Edge runtime, pinned by Supabase) | 4 new Edge Functions | Established pattern per `supabase/functions/delete-me/index.ts` |
| OpenAI Moderation API | `omni-moderation-latest` (released 2024-09-26) | Prompt moderation | Free; multimodal capable; project-locked per D-33 |
| SightEngine REST API | `nudity-2.1` + `face-attributes` models | Portrait CSAM scan | Project-locked per D-32a; the `nudity-2.1` model alone has no minor field — `face-attributes` carries the `attributes.minor` 0..1 score |

### Supporting
| Library | Version | Purpose | When to Use |
|---|---|---|---|
| `pg_net` | bundled with Supabase | HTTP from Postgres triggers | Wrapped by Database Webhooks; no need to call directly |
| `IntersectionObserver` (browser native) | — | Infinite scroll sentinel | No 3rd-party hook lib needed for a single grid; ~30-line custom hook |
| `zustand` | already installed | `useBrowseStore` | Mirrors `useCloudCharactersStore`, `useSyncStore` shape |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|---|---|---|
| Database Webhook | Direct `pg_notify` + LISTEN in a long-poll Edge Function | LISTEN does not survive cold-starts and requires a stateful subscriber; Webhook (pg_net) is the documented Supabase pattern [VERIFIED: supabase.com/docs/guides/database/webhooks] |
| SightEngine | PhotoDNA / NCMEC | PhotoDNA is free + authoritative for known CSAM hashes but requires partnership vetting (~4-8 weeks per D-32a). CONTEXT decision: ship SightEngine v1.0; apply for PhotoDNA in parallel; swap via interface |
| ILIKE search | `tsvector` full-text + GIN index | Per CONTEXT D-31a, listing volume in hundreds — ILIKE is adequate, no `tsvector` overhead |
| `react-infinite-scroll-component` | npm pkg with built-in scroll listener | New dep for ~30 lines of `IntersectionObserver` code; avoid |

**Installation:** Zero new npm deps in the desktop app. Edge Functions use Deno runtime (`createClient` from `@supabase/supabase-js` Deno bundle, already used in `delete-me/index.ts`).

**Version verification:**
- `npm view @supabase/supabase-js version` → `2.106.1` (current; project on `^2.106.0` matches).
- OpenAI `omni-moderation-latest` is a permanent alias that auto-tracks the latest snapshot per OpenAI's versioning convention [CITED: developers.openai.com/api/docs/guides/moderation].
- SightEngine `nudity-2.1` is the current advanced model [CITED: sightengine.com/docs/advanced-nudity-detection-model-2.1].

## Phase Requirements

| ID | Description | Research Support |
|---|---|---|
| SHARE-01 | Characters page split Home / Browse | D-31 tab bar reuses `CharacterCard`; `HomeScreen.tsx` gets the tab control. See "Browse Tab Plumbing" below. |
| SHARE-02 | Text search across name + persona description | D-31a server-side ILIKE RPC `search_public_characters(query, limit, offset)`. See "Browse RPC pattern" below. D-37: `persona_source` IS the description column. |
| SHARE-03 | Browse cards with avatar/skin/name/snippet/attribution | `BrowseCard` variant extending `CharacterCard`; +Report button + creator attribution slot (D-31, Claude's Discretion). |
| SHARE-04 | Preview + Add-to-Mine | Reuses `chars:openPrepare` from Plan 11-19 (cacheOnDemand). No new "claim" IPC. See "Add-to-Mine flow" below. |
| SHARE-05 | Public/private toggle with content-policy confirmation | Toggle UI shipped in Plan 11-15. Phase 12 adds the pre-publish moderation check + a confirmation modal at first publication. |
| SHARE-06 | CSAM scan on every image before publish | D-32a SightEngine `nudity-2.1,face-attributes`. D-32 PORTRAITS ONLY (skins out of scope v1.0). Synchronous Edge Function. See "SightEngine integration" below. |
| SHARE-07 | Prompt moderation at upload | D-33 OpenAI `omni-moderation-latest`. Two-tier: hard block (name+persona_source), soft regenerate (persona_expanded). See "Prompt moderation" below. |
| SHARE-08 | Report button + moderation queue | D-34 `reports` table + Database Webhook + `notify-report` Edge Function emails + Discord. Auto-hide trigger at 3-distinct-reporters-in-24h. See "Reports flow" below. |
| SHARE-09 | DMCA agent registered + contact in app/ToS | D-35 sole-proprietor eForm at dmca.copyright.gov; receipt URL captured; three surfaces (a) app Settings, (b) terms.html, (c) privacy.html. |
| SHARE-10 | Public listings show last-updated; attribution (creator profiles deferred) | `characters.updated_at` already exists from Phase 11. Attribution = "by user-a1b2" UUID-fragment placeholder; no profile pages in v1.0. |

## Architecture Patterns

### System Architecture Diagram

```
┌──────────────── RENDERER (Electron renderer) ──────────────┐
│                                                            │
│   CharactersScreen.tsx                                     │
│      ├── HomeTab (existing CharacterCard grid)            │
│      └── BrowseTab (new)                                   │
│            ├── search input (250ms debounce)              │
│            ├── BrowseCard[] (avatar+name+snippet+Report)  │
│            ├── IntersectionObserver sentinel → loadMore() │
│            └── ReportModal (reason picker + free text)    │
│                                                            │
│   useBrowseStore (zustand)                                 │
│      entries / query / loading / loadMore / setQuery       │
│                                                            │
│   useCloudCharactersStore (existing — for "Already in     │
│      My Library" badge state)                              │
└──────────────────┬─────────────────────────────────────────┘
                   │ IPC (contextBridge)
                   ▼
┌──────────────────── MAIN (Electron main) ──────────────────┐
│   ipc.ts new handlers:                                     │
│     browse:search(q, limit, offset)                        │
│     browse:report(charId, reason, detail)                  │
│     mod:moderatePortraitForPublish(uuid)  ← pre-publish    │
│     mod:moderatePromptForPublish(uuid)    ← pre-publish    │
│     app:capabilities (NEW; includes browseEnabled)         │
│                                                            │
│   cloudCharacterClient.ts new wrappers:                    │
│     searchPublicCharacters(...)  →  rpc('search_public_…')│
│     submitReport(...)            →  reports INSERT         │
│     callModerationEdge(...)      →  fetch Edge Function    │
│                                                            │
│   cloud/moderationGate.ts (NEW) — calls 2 mod edges       │
│      before flipping shared=true on a character             │
└──────────────────┬─────────────────────────────────────────┘
                   │ HTTPS + RLS
                   ▼
┌────────────── SUPABASE ─────────────────────────────────────┐
│ Postgres:                                                   │
│   characters (existing + 3 new moderation_* cols)           │
│   reports (NEW — RLS: insert-own, service_role select)     │
│   trigger reports_after_insert → pg_net.http_post →        │
│      Edge Function notify-report                            │
│   trigger reports_auto_hide → updates characters.shared    │
│   RPC search_public_characters(text,int,int)               │
│                                                             │
│ Edge Functions (Deno):                                      │
│   moderate-character-images   → SightEngine                │
│   moderate-character-prompt   → OpenAI Moderation          │
│   notify-report               → email + Discord webhook    │
│   backfill-moderate-existing  → one-shot retroactive scan  │
│                                                             │
│ Storage (existing skins/portraits buckets — PUBLIC today)  │
└────────────────────────────────────────────────────────────┘
                   │
                   │  Outbound HTTPS from Edge Functions
                   ▼
            ┌──────────────┬───────────┬───────────┐
            ▼              ▼           ▼           ▼
        SightEngine     OpenAI     Discord     SMTP/Resend
        check.json    /v1/mods    webhook URL  → dmca@sei.app
```

### Recommended Project Structure

Phase 12 NEW files:

```
src/
├── main/
│   └── cloud/
│       ├── moderationGate.ts          # NEW — pre-publish mod orchestration
│       └── moderationEdgeClient.ts    # NEW — typed Edge Function client
├── renderer/src/
│   ├── screens/
│   │   └── CharactersScreen.tsx       # NEW (or HomeScreen renamed) — Home+Browse tabs
│   ├── components/
│   │   ├── BrowseCard.tsx             # NEW — variant of CharacterCard
│   │   ├── ReportModal.tsx            # NEW — match MigrateLocalCharsModal pattern
│   │   ├── ContentPolicyConfirmModal.tsx  # NEW — for SHARE-05 first-publish gate
│   │   └── BrowseSearchField.tsx      # NEW — debounced input
│   └── lib/
│       ├── stores/
│       │   └── useBrowseStore.ts      # NEW — zustand listing store
│       └── hooks/
│           └── useInfiniteScroll.ts   # NEW — IntersectionObserver hook
supabase/
├── migrations/
│   ├── 20260523000000_characters_moderation.sql   # NEW — 3 cols
│   ├── 20260523000100_reports.sql                  # NEW — table+RLS
│   ├── 20260523000200_reports_auto_hide_trigger.sql # NEW — plpgsql
│   ├── 20260523000300_search_public_characters_rpc.sql # NEW
│   └── 20260523000400_reports_webhook.sql           # NEW (or via dashboard)
└── functions/
    ├── moderate-character-images/index.ts          # NEW
    ├── moderate-character-prompt/index.ts          # NEW
    ├── notify-report/index.ts                       # NEW
    └── backfill-moderate-existing/index.ts          # NEW
../sei-website/
├── terms.html                                       # MODIFY § "7. DMCA Notices"
└── privacy.html                                     # MODIFY add DMCA link
```

### Pattern 1: Supabase Database Webhook (the actual pg_notify-equivalent for Edge Functions)

**What:** Supabase Database Webhooks are a managed convenience wrapper over `pg_net.http_post` invoked from a Postgres AFTER trigger. They are the standard pattern for "trigger on row INSERT → call an Edge Function." Raw `pg_notify` does NOT cross the network boundary to Edge Functions; it only fires for in-database LISTEN subscribers, which Edge Functions are not.

**When to use:** Any INSERT/UPDATE/DELETE → external HTTP fan-out. Exactly the SHARE-08 report → notify-report case.

**Example (migration-level — preferred over dashboard so the wiring is in git):**

```sql
-- Source: supabase.com/docs/guides/database/webhooks (Database Webhooks are a
-- convenience wrapper around triggers using the pg_net extension)

-- Enable pg_net (idempotent)
create extension if not exists pg_net with schema extensions;

-- Trigger function — fires AFTER INSERT on reports
create or replace function public.tg_notify_report_inserted()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  edge_url text;
  service_key text;
begin
  -- Both values come from Database Settings → Vault, exposed via
  -- supabase_vault.secrets. For project-local dev they come from a Database
  -- parameter set via ALTER DATABASE ... SET app.settings.edge_url = '…';
  -- See "Pitfall A8" below.
  edge_url    := current_setting('app.settings.edge_url', true) || '/functions/v1/notify-report';
  service_key := current_setting('app.settings.service_role_key', true);

  perform net.http_post(
    url     := edge_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || service_key
    ),
    body    := jsonb_build_object('report_id', new.id, 'character_id', new.character_id)
  );
  return new;
end;
$$;

create trigger reports_after_insert
  after insert on public.reports
  for each row execute function public.tg_notify_report_inserted();
```

**Alternate (Dashboard UI):** Create via Database → Webhooks UI; auto-generates an equivalent trigger. Less reproducible across environments — prefer the migration.

### Pattern 2: Auto-hide via Postgres trigger (3 distinct reporters in 24h)

**What:** Row-level AFTER INSERT trigger on `reports` runs a `SELECT count(DISTINCT reporter_id)` over the last 24h for the reported character; if `>= 3`, UPDATE `characters.shared = false` and signal a second Discord webhook for "auto-hidden" alert.

```sql
create or replace function public.tg_reports_auto_hide()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  distinct_reporters int;
begin
  select count(distinct reporter_id) into distinct_reporters
    from public.reports
   where character_id = new.character_id
     and created_at > now() - interval '24 hours';

  if distinct_reporters >= 3 then
    update public.characters
       set shared = false
     where id = new.character_id
       and shared = true;   -- avoid duplicate auto-hides
  end if;
  return new;
end;
$$;

create trigger reports_auto_hide_trigger
  after insert on public.reports
  for each row execute function public.tg_reports_auto_hide();
```

**Why a trigger and not the Edge Function:** Keeps the auto-hide atomic with the INSERT — no race window where 4 reports land between Edge Function poll cycles. The "auto-hide notification" (creator email + Discord) is still fired by `notify-report` (the Edge Function checks `characters.shared` post-insert and includes that signal in the Discord message).

### Pattern 3: Browse RPC (server-side ILIKE + RLS-respecting)

```sql
-- Returns the rows the caller is permitted to see (RLS-respected because
-- security invoker is the default). 'characters' RLS policy
-- 'characters_select_own_or_shared' already permits SELECT where
-- shared = true OR owner = auth.uid().
create or replace function public.search_public_characters(
  search_query text default '',
  page_limit int default 24,
  page_offset int default 0
)
returns setof public.characters
language sql
stable
as $$
  select *
    from public.characters
   where shared = true
     and (moderation_status is null or moderation_status = 'clean')
     and (
       search_query = ''
       or name ilike '%' || search_query || '%'
       or persona_source ilike '%' || search_query || '%'
     )
   order by updated_at desc
   limit greatest(1, least(page_limit, 50))   -- defensive cap
  offset greatest(0, page_offset);
$$;
```

Notes:
- `stable` lets Postgres reuse plans within a transaction.
- `security invoker` (default) means the RPC runs with caller's RLS — anon callers see only `shared = true` rows (matches the existing `characters_select_own_or_shared` policy).
- `moderation_status` is the NULL → 'clean' → 'flagged' enum (text) from D-32d. Filter is `null OR clean` so the backfill window doesn't disappear from Browse mid-backfill — once backfill flips `BROWSE_ENABLED=true`, all rows are non-null.
- Hard cap of 50 prevents a misbehaving renderer from requesting 10000.
- Pagination via offset is fine at hundreds-of-rows scale (D-31a); keyset pagination only matters at 10k+.

**Renderer call (via main IPC):**

```typescript
// In src/main/cloud/cloudCharacterClient.ts
export async function searchPublicCharacters(
  q: string, limit: number, offset: number
): Promise<Character[]> {
  const { data, error } = await withTimeout(
    getClient().rpc('search_public_characters', {
      search_query: q, page_limit: limit, page_offset: offset
    }),
    TIMEOUT_MS,
  );
  if (error) throw new Error(`${CLOUD_LIST_FAILED}: ${error.message}`);
  return (data ?? []).map((r) => CharacterSchema.parse(r));
}
```

### Pattern 4: SightEngine portrait scan Edge Function

```typescript
// supabase/functions/moderate-character-images/index.ts
import { corsHeaders } from '../_shared/cors.ts';

const SIGHTENGINE_URL = 'https://api.sightengine.com/1.0/check.json';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders });

  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ error: 'missing_jwt' }), { status: 401, headers: corsHeaders });
  }

  // Body: { portrait_url: string }  — caller (main) sends the PUBLIC bucket URL.
  const { portrait_url } = await req.json();
  if (!portrait_url || typeof portrait_url !== 'string') {
    return new Response(JSON.stringify({ error: 'bad_request' }), { status: 400, headers: corsHeaders });
  }

  const params = new URLSearchParams({
    url: portrait_url,
    models: 'nudity-2.1,face-attributes',
    api_user: Deno.env.get('SIGHTENGINE_API_USER')!,
    api_secret: Deno.env.get('SIGHTENGINE_API_SECRET')!,
  });

  const se = await fetch(`${SIGHTENGINE_URL}?${params}`);
  if (!se.ok) {
    return new Response(JSON.stringify({ error: 'provider_error', status: se.status }), { status: 502, headers: corsHeaders });
  }
  const data = await se.json();

  // Block rules:
  //   1. Any face with attributes.minor > 0.5 AND any nudity intensity != 'none' > 0.3
  //   2. nudity.sexual_activity > 0.5 (adult-only) — soft block for v1.0; user can edit
  //   3. Any minor + suggestive classes > 0.5 = hard block
  const flagged =
    (data.faces ?? []).some((f) => (f.attributes?.minor ?? 0) > 0.5) &&
    (
      (data.nudity?.sexual_activity ?? 0) > 0.3 ||
      (data.nudity?.sexual_display ?? 0) > 0.3 ||
      (data.nudity?.erotica ?? 0) > 0.3 ||
      (data.nudity?.very_suggestive ?? 0) > 0.3 ||
      (data.nudity?.suggestive ?? 0) > 0.5
    );

  return new Response(JSON.stringify({
    flagged,
    provider: 'sightengine-v2.1+face-attributes',
    raw: data,   // log for human review; do NOT leak to end-user
  }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});
```

**Critical correction to CONTEXT D-32a:** The CONTEXT calls this "SightEngine `nudity-2.1` + `minor` model." SightEngine has NO model called `minor` — the `models=` parameter spelling is `face-attributes`, and the minor signal is `attributes.minor` (0..1) per face [VERIFIED: sightengine.com/docs/face-attribute-model]. The combined call is `models=nudity-2.1,face-attributes`. Update CONTEXT or just record this correction.

### Pattern 5: OpenAI prompt moderation Edge Function

```typescript
// supabase/functions/moderate-character-prompt/index.ts
import { corsHeaders } from '../_shared/cors.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders });

  // Body: { text: string, kind: 'hard' | 'soft' }
  const { text, kind } = await req.json();

  const r = await fetch('https://api.openai.com/v1/moderations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${Deno.env.get('OPENAI_API_KEY')}`,
    },
    body: JSON.stringify({
      model: 'omni-moderation-latest',
      input: text,
    }),
  });

  if (!r.ok) {
    return new Response(JSON.stringify({ error: 'provider_error', status: r.status }), { status: 502, headers: corsHeaders });
  }
  const data = await r.json();
  const result = data.results[0];
  const scores = result.category_scores;
  // Per D-33 thresholds. sexual/minors is ZERO-TOLERANCE.
  const blocked =
    (scores['sexual/minors'] ?? 0) > 0  // any non-zero = hard block
    || (scores['violence/graphic'] ?? 0) > 0.85
    || (scores['hate/threatening'] ?? 0) > 0.85
    || (scores['self-harm/intent'] ?? 0) > 0.85;

  // For 'hard' kind: return blocked. For 'soft' kind: caller (main) will
  // re-expand the persona with a moderation-steer prompt and re-call.
  return new Response(JSON.stringify({
    blocked,
    kind,
    flagged_categories: Object.entries(result.categories).filter(([_,v]) => v).map(([k]) => k),
    raw: data,
  }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});
```

**OpenAI response shape** (verified via docs):
```json
{
  "id": "modr-...",
  "model": "omni-moderation-latest",
  "results": [{
    "flagged": true,
    "categories": { "sexual": false, "sexual/minors": false, "harassment": false,
                    "harassment/threatening": false, "hate": false, "hate/threatening": false,
                    "illicit": false, "illicit/violent": false,
                    "self-harm": false, "self-harm/intent": false, "self-harm/instructions": false,
                    "violence": false, "violence/graphic": false },
    "category_scores": { /* same keys, 0..1 floats */ },
    "category_applied_input_types": { /* per-category list of "text"/"image" */ }
  }]
}
```

### Pattern 6: notify-report Edge Function (Discord + email)

```typescript
// supabase/functions/notify-report/index.ts
import { createClient } from '@supabase/supabase-js';
import { corsHeaders } from '../_shared/cors.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders });

  // Body: { report_id, character_id }  — sent by Database Webhook
  const { report_id, character_id } = await req.json();

  // service_role to read across RLS
  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // Fetch report + char in parallel
  const [{ data: report }, { data: char }] = await Promise.all([
    admin.from('reports').select('*').eq('id', report_id).single(),
    admin.from('characters').select('id,name,owner,shared').eq('id', character_id).single(),
  ]);

  if (!report || !char) {
    return new Response('not_found', { status: 404, headers: corsHeaders });
  }

  const autoHidden = char.shared === false;   // auto-hide trigger fired in same txn

  // 1) Discord webhook
  const discordUrl = Deno.env.get('DISCORD_REPORT_WEBHOOK_URL')!;
  await fetch(discordUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: `${autoHidden ? '🚨 AUTO-HIDDEN' : '⚠️ New report'} for character \`${char.name}\` (${char.id})\n` +
               `Reason: **${report.reason}**\n` +
               `Detail: ${report.detail ?? '(none)'}\n` +
               `Reporter: \`${report.reporter_id}\``,
    }),
  });

  // 2) Email to dmca@sei.app via Resend (or whatever provider — RESEND_API_KEY)
  // Same shape — fetch POST to https://api.resend.com/emails
  // ...

  // 3) If auto-hidden, email the creator too — admin.auth.admin.getUserById(char.owner)
  // ...

  return new Response(null, { status: 204, headers: corsHeaders });
});
```

### Pattern 7: Add-to-Mine flow — REUSES existing IPC

**Crucial:** Per Plan 11-19 cacheOnDemand summary, `chars:openPrepare(uuid)` already:
1. Short-circuits on `existsSync` cache hit
2. Downloads the cloud row + skin + portrait
3. Writes via `saveCharacterRaw` (no cloud-mirror re-upload)
4. Handles concurrency (after fixing HR-02 — currently lacks per-uuid in-flight guard; planner should ensure HR-02 fix lands before Phase 12 wires Add-to-Mine)

**Phase 12 Add-to-Mine** therefore does NOT need a new IPC channel. The renderer flow is:
1. User clicks "Add to Mine" on a `BrowseCard`
2. Renderer calls `sei.charsOpenPrepare(browseEntry.id)` — same call HomeScreen makes for cloud-only cards
3. On resolve, refresh `useCloudCharactersStore` so the "Already in My Library" badge appears
4. Optionally navigate to the character page

Note: The "Add to Mine" action conceptually means "I want this character listed under my Home tab too." Since the cache is identified by UUID and the `useCloudCharactersStore.cloudIds` is `[ownerUuid==me]` characters only, **Add-to-Mine for a character not owned by the user must NOT add it to `useCloudCharactersStore.cloudIds`** — it's still owned by the original author. The renderer's "is in my library" badge on Browse uses a DIFFERENT predicate: `existsSync(charactersDir + browseEntry.id + '.json')` — i.e., "is this file on my disk?" This needs a new `chars:isLocallyCached(uuid)` IPC OR the renderer can rely on the `useDataStore.characters` list (which reads `chars:list` = local files). The latter is simpler. **Recommend: planner uses `useDataStore.characters.some(c => c.id === browseEntry.id)` for the badge predicate — no new IPC.**

### Pattern 8: BROWSE_ENABLED flag plumbing

There is NO existing `app:capabilities` IPC channel today. There IS an `app:warnings` channel (`src/shared/ipc.ts:491`) which is a one-shot startup query for boot warnings. Two options:

**Option A (recommended):** New `app:capabilities` IPC channel. Returns `{ browseEnabled: boolean }`. Renderer calls once on mount. Future capabilities (vision-enabled, multi-provider-enabled) plug in here.

**Option B:** Extend `UserConfig` schema (`src/shared/characterSchema.ts:126`) with `browseEnabled?: boolean`, read via existing `config:get` IPC.

Recommend Option A — keeps `UserConfig` for user-editable preferences and capabilities for boot-time/feature-flag state.

**Boot-time read in main:**
```typescript
// src/main/capabilities.ts (new)
import { readFile } from 'node:fs/promises';
import { paths } from './paths';

export async function readCapabilities(): Promise<{ browseEnabled: boolean }> {
  const env = process.env.BROWSE_ENABLED;
  if (env === 'true') return { browseEnabled: true };  // D-36a dev/local override
  try {
    const txt = await readFile(paths.configPath(), 'utf-8');
    const cfg = JSON.parse(txt);
    return { browseEnabled: cfg.browseEnabled === true };  // default false
  } catch { return { browseEnabled: false }; }
}
```

**Renderer:**
```tsx
// CharactersScreen.tsx
const [browseEnabled, setBrowseEnabled] = useState(false);
useEffect(() => { sei.appCapabilities().then(c => setBrowseEnabled(c.browseEnabled)); }, []);
return browseEnabled ? <TabBar /> : <HomeTabOnly />;
```

### Anti-Patterns to Avoid

- **Storing SightEngine `api_secret` or OpenAI key in the desktop client.** Both keys MUST live ONLY in `supabase secrets set` (Edge Function Vault). Same invariant as `delete-me`'s `SUPABASE_SERVICE_ROLE_KEY`.
- **Direct INSERT into `reports` from the renderer with no server-side rate limiting.** A griefer could spam-INSERT to mass-auto-hide legit chars (3 sock-puppet accounts → trigger fires). Mitigation: D-34d "5 reports per reporter per hour" rate limit MUST live in the Edge Function `submit-report`, NOT in the direct INSERT path. **Therefore: do NOT have the renderer call `supabase.from('reports').insert(...)` directly. Route through an Edge Function `submit-report` that enforces the per-reporter rate limit before INSERT.**
- **Using `pg_notify` to "trigger" an Edge Function.** It does not work — Edge Functions don't LISTEN. Use Database Webhooks (`pg_net.http_post`).
- **Trusting client-claimed `reporter_id`.** The Edge Function must read `reporter_id` from `auth.getUser()`, never from the request body.
- **Letting un-moderated characters be Browseable.** D-32c retroactive backfill MUST complete + verify `count(*) where shared=true and moderation_status IS NULL == 0` BEFORE `BROWSE_ENABLED` flips true. This is the D-30 → D-36(b) gate.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---|---|---|---|
| CSAM detection | Custom image classifier | SightEngine `nudity-2.1` + `face-attributes`; PhotoDNA later | Liability, false-negative rate, ongoing model maintenance |
| Text moderation | Regex word-list or custom classifier | OpenAI `omni-moderation-latest` | Free, multilingual (42% better on multimodal eval, 70% better on low-resource langs per OpenAI Sep 2024 announcement), maintained categorization |
| pg → HTTP fan-out | Custom Edge Function polling reports table | Supabase Database Webhooks (pg_net) | Built-in, async, doesn't block the INSERT, no cold-start latency on the report path |
| Infinite scroll listener | Scroll-event throttle | `IntersectionObserver` sentinel pattern | Native; cheap; ~30 lines; passive observer doesn't fight React renders |
| Email delivery from Edge Function | Direct SMTP from Deno | Resend / Postmark / Supabase SMTP integration | Deliverability + SPF/DKIM hassle; transactional email APIs are cents/month |
| Discord notifications | OAuth Discord bot | Discord webhook URL (single POST) | Webhooks are zero-setup, no bot accounts, exactly the right primitive |
| DMCA registration | Self-host a DMCA contact form | US Copyright Office eForm at dmca.copyright.gov | Statute requires Designated Agent registration with the Copyright Office; can't be self-served |

**Key insight:** Every moderation provider in this phase is "pick the established API, store the secret in Edge Function env, call from server-side." The only originality is in the orchestration (when to call, what to gate, how to backfill).

## Runtime State Inventory

> Phase 12 is a feature-add phase — not a rename/refactor — so most categories are N/A. But there IS one important runtime concern (the BROWSE_ENABLED gate) that fits this rubric.

| Category | Items Found | Action Required |
|---|---|---|
| Stored data | New columns on `characters` (`moderation_status`, `moderation_checked_at`, `moderation_provider`); new `reports` table. Existing rows have NULL `moderation_status` until backfilled. | Migration + backfill Edge Function |
| Live service config | Supabase Edge Function env vars: `SIGHTENGINE_API_USER`, `SIGHTENGINE_API_SECRET`, `OPENAI_API_KEY`, `DISCORD_REPORT_WEBHOOK_URL`, `RESEND_API_KEY` (or chosen email provider); Database settings `app.settings.edge_url`, `app.settings.service_role_key` for the webhook trigger | `supabase secrets set` for the function envs; `ALTER DATABASE postgres SET app.settings.edge_url = '<project ref url>';` for the DB-level params |
| OS-registered state | None — Phase 12 doesn't touch OS state | None |
| Secrets/env vars | New keys above; the `BROWSE_ENABLED` boolean lives in `<userData>/config.json` (per D-36) | Document in onboarding checklist; user MANUALLY flips after the D-36 pre-flight passes |
| Build artifacts | None — purely additive code | None |

## Common Pitfalls

### Pitfall 1: SightEngine model name confusion
**What goes wrong:** Implementer tries `models=nudity-2.1,minor` (per CONTEXT D-32a wording) and gets a 400 from SightEngine. There is no `minor` model.
**Why it happens:** CONTEXT was written from memory; SightEngine's actual API uses `face-attributes` for minor detection and returns `attributes.minor` per face.
**How to avoid:** Use `models=nudity-2.1,face-attributes`. Inspect `data.faces[i].attributes.minor` (0..1).
**Warning signs:** SightEngine returns `{status: 'failure', error: {code: 25, message: "Invalid model 'minor'"}}`.

### Pitfall 2: pg_notify ≠ Edge Function trigger
**What goes wrong:** Implementer reads CONTEXT D-34b "pg_notify → Edge Function" literally, writes a `pg_notify('reports_new', ...)` in a trigger, then can't figure out why the Edge Function never fires.
**Why it happens:** `pg_notify` only delivers to in-database LISTEN subscribers. Edge Functions are external HTTP services with no Postgres connection.
**How to avoid:** Use Supabase Database Webhooks (which wrap `pg_net.http_post`). The trigger pattern in "Pattern 1" above is the correct shape.
**Warning signs:** Trigger fires (rows inserted) but Edge Function logs show zero invocations.

### Pitfall 3: Public bucket means everyone can see un-moderated portraits
**What goes wrong:** A portrait uploaded with `shared=true` BEFORE the moderation Edge Function returns "flagged" is briefly publicly reachable via its Storage URL (UUIDs are unguessable but indexed by anyone holding the URL).
**Why it happens:** Phase 11 created `skins` and `portraits` buckets as PUBLIC (see `20260521000100_storage_buckets.sql:5-10`). CONTEXT D-32b says "use the existing private bucket pattern from Phase 11 + signed-URL-only public read after clean" — but the existing pattern is PUBLIC, not private.
**How to avoid:** Decision needed. Two options:
  - **(a) Keep buckets public; gate moderation at the row level.** `shared = true` is set only AFTER moderation returns clean. The Browse RPC filters `shared = true AND moderation_status = 'clean'`. The Storage URL exists during the upload→moderate window but is unreachable by anyone not handed the UUID directly (Pitfall 10 from Phase 11 — 122-bit entropy). RECOMMEND.
  - **(b) Flip buckets to private + serve via signed URLs.** Bigger schema migration, all Browse cards now need server-issued signed URLs (CDN cache misses per result, see "supabase storage" research). Phase-12-blocking.
**Warning signs:** None automated; this is a design decision the planner must make explicitly. The recommendation is (a) for v1.0 with a deferred-items note to revisit if abuse is observed.

### Pitfall 4: Report flooding via direct INSERT
**What goes wrong:** Renderer does `supabase.from('reports').insert(...)`; griefer scripts 1000 inserts in 10 seconds; auto-hide trigger fires on every legit character.
**Why it happens:** D-34d's "5 reports per reporter per hour" rate limit lives in an Edge Function, but if the renderer can INSERT directly via RLS (`reports_insert_own` policy: `with check (reporter_id = auth.uid())`), the rate limit is bypassed.
**How to avoid:** Either (a) DON'T add an `insert-own` RLS policy on `reports`; route all submissions through an Edge Function `submit-report` that enforces rate-limit then uses `service_role` to INSERT. (b) Add an additional rate-limit trigger that counts inserts-per-reporter-per-hour and RAISES EXCEPTION at >5. RECOMMEND (a) — simpler, matches the `delete-me` pattern.
**Warning signs:** During load testing, single user account can produce >5 reports/hour without 429.

### Pitfall 5: Backfill stops mid-list, BROWSE_ENABLED flipped too early
**What goes wrong:** `backfill-moderate-existing` fails on row 73 of 200 (e.g., SightEngine rate-limit); operator sees no errors in dashboard and flips BROWSE_ENABLED. Rows 74-200 still have `moderation_status IS NULL` and the Browse RPC's `null OR clean` clause shows them.
**Why it happens:** Backfill is one-shot; partial completion is invisible without explicit verification.
**How to avoid:**
- Backfill function must be **idempotent + resumable** — `select * from characters where shared=true and moderation_status is null order by id` and process in batches; each row updated immediately so re-running picks up where it left off.
- Pre-flight check before flipping BROWSE_ENABLED: `select count(*) from characters where shared=true and moderation_status is null` must equal 0.
- Browse RPC clause should be `moderation_status = 'clean'` (NOT `null OR clean`) ONCE backfill is verified done. Until then, keep `null OR clean` so a single retroactive backfill failure doesn't black-hole the user's own characters from their My Library.
**Warning signs:** Browse shows characters whose names weren't approved by you yet.

### Pitfall 6: persona_expanded soft-regenerate infinite loop
**What goes wrong:** D-33b says `persona_expanded` flagged → regenerate with mod-steering prompt. If the LLM keeps producing flagged content (e.g., the user's persona is "an angry assassin"), the regenerate→moderate→regenerate cycle loops.
**Why it happens:** No bound on retries.
**How to avoid:** Cap retries at 2. If still flagged after 2 attempts, fall back to a generic "edgy but bounded" persona expansion, or store the un-regenerated `persona_expanded` with a `moderation_status='soft_flagged'` tag and surface it to admin. Recommend: cap at 2, on third flag mark `moderation_status='flagged'` (treated as hard-flag).
**Warning signs:** Edge Function logs show >2 invocations for the same character_id within 60s.

### Pitfall 7: BrowseCard Report button gestural conflict
**What goes wrong:** User taps "Report" → card click handler ALSO fires → preview overlay opens behind the confirm sheet.
**Why it happens:** React click events bubble.
**How to avoid:** `e.stopPropagation()` on the Report button onClick. Verified pattern from existing modals in the codebase.
**Warning signs:** QA: tap Report on mobile/touch, preview opens.

### Pitfall 8: Browse infinite scroll fires loadMore() repeatedly during slow networks
**What goes wrong:** Sentinel observed → loadMore() fires → request inflight → user keeps scrolling → sentinel observed again → second loadMore() fires → duplicate page fetched.
**Why it happens:** No in-flight guard on `useBrowseStore.loading`.
**How to avoid:** `loadMore()` short-circuits if `state.loading === true`. Set loading=true synchronously before the await.
**Warning signs:** Duplicate cards on the grid; offset increments by >24 per real new page.

### Pitfall 9: HR-01 (carried from Phase 11) — chars:listCloud failure marks every char as LOCAL ONLY
**What goes wrong:** Phase 12 also uses `useCloudCharactersStore.cloudIds` for "Already in My Library" predicate on BrowseCards. The same bug regression applies: transient `chars:listCloud` failure → empty cloudIds → every BrowseCard's "Already in My Library" badge incorrectly hidden.
**Why it happens:** Documented in 11-REVIEW.md HR-01.
**How to avoid:** Apply the HR-01 fix BEFORE Phase 12 wiring depends on `useCloudCharactersStore`. Planner: include the HR-01 fix in Wave 0.
**Warning signs:** Already documented in 11-REVIEW.md.

### Pitfall 10: HR-02 (carried from Phase 11) — cacheOnDemand has no in-flight guard
**What goes wrong:** Phase 12's Add-to-Mine button (and existing Phase 11 cloud-only-card-click) calls `chars:openPrepare`. Double-click or React StrictMode → double download + race.
**How to avoid:** Apply the HR-02 fix BEFORE Phase 12 wires Add-to-Mine.
**Warning signs:** Already documented in 11-REVIEW.md.

### Pitfall 11: Mojang skin URL fetching for Browse cards is slow
**What goes wrong:** Each BrowseCard tries to fetch the user's Mojang skin URL live → 24 cards = 24 round-trips to Mojang per page; latency stacks.
**Why it happens:** Implementer treats Browse like Home (which uses live data).
**How to avoid:** Use the Phase 11 Storage-bucket URL for the skin (already public, CDN-cacheable via Supabase's edge cache). The `characters` row carries `skin_png_sha256` and the Storage path is deterministic (`<owner_uuid>/<character_uuid>.png`). No Mojang round-trip.
**Warning signs:** Browse load time scales with row count; network tab shows 24 sequential mojang.com requests.

### Pitfall 12: SightEngine free-tier limit (2000 ops/month, 500/day)
**What goes wrong:** Backfill scans 200 historical characters + new uploads + a viral moment → exceed 500/day → moderation 429s → uploads block.
**Why it happens:** Free tier is restrictive; planner sized cost expectation without checking.
**How to avoid:**
  - For v1.0 launch with hundreds of characters total: free tier is adequate. Document the limit in deferred-items.
  - Add Edge Function fallback: on 429 from SightEngine, return `{flagged: false, provider_unavailable: true}` and set `moderation_status='clean_pending_retry'` — character still publishes but flagged for re-scan. (Alternative: hard fail with user-friendly "moderation queue full, try again in a few minutes.") **RECOMMEND: hard fail** — never publish anything that wasn't scanned.
  - Pricing-tier upgrade trigger: monitor SightEngine usage, alert at 80% of monthly quota.
**Warning signs:** SightEngine dashboard shows >400 ops/day.

## Code Examples

### Migration: characters moderation columns (additive, ordered after Phase 11)

```sql
-- supabase/migrations/20260523000000_characters_moderation.sql
-- Phase 12 (SHARE-06 + SHARE-07 + D-30 backfill column) — additive moderation
-- columns on characters. NULL = not yet scanned (Phase 11 → 12 window rows).
-- The Phase 12 backfill Edge Function flips every NULL to clean|flagged.

alter table public.characters
  add column moderation_status     text,        -- NULL | 'clean' | 'flagged' | 'soft_flagged' | 'clean_pending_retry'
  add column moderation_checked_at timestamptz,
  add column moderation_provider   text,        -- 'sightengine-v2.1+face-attributes' | 'photodna-v1' | ...
  add column moderation_text_provider text,     -- 'openai-omni-moderation-latest' | ...
  add column moderation_text_checked_at timestamptz;

-- Constraint: shared=true must imply moderation_status IS NOT NULL ONCE
-- backfill completes. Enforce as a CHECK only post-backfill — uncomment in a
-- subsequent migration after operator confirms backfill clean.
-- ALTER TABLE public.characters ADD CONSTRAINT shared_implies_moderated
--   CHECK (shared = false OR moderation_status IS NOT NULL);

-- Index for backfill queries
create index characters_unmoderated_idx on public.characters (moderation_status)
  where moderation_status is null and shared = true;
```

### Migration: reports table + RLS (insert via Edge Function only)

```sql
-- supabase/migrations/20260523000100_reports.sql
create table public.reports (
  id              uuid primary key default gen_random_uuid(),
  reporter_id     uuid not null references auth.users(id) on delete set null,
  character_id    uuid not null references public.characters(id) on delete cascade,
  reason          text not null check (reason in (
                    'sexual_content_minors',
                    'hate_speech_harassment',
                    'copyright_infringement',
                    'other'
                  )),
  detail          text check (char_length(detail) <= 500),
  created_at      timestamptz not null default now(),
  resolved_at     timestamptz,
  resolution      text
);

create index reports_character_recent_idx on public.reports (character_id, created_at desc);
create index reports_reporter_recent_idx  on public.reports (reporter_id, created_at desc);

alter table public.reports enable row level security;

-- Per Pitfall 4: NO insert-own policy. Submissions MUST route through the
-- submit-report Edge Function (which enforces the per-reporter rate limit
-- before inserting with service_role).
-- Only service_role (Edge Function) can SELECT / INSERT / UPDATE / DELETE.
-- Users have NO direct visibility into reports (privacy: can't see who
-- reported what).
```

### Migration: Database Webhook trigger + auto-hide trigger

(See Patterns 1 and 2 above for full SQL.)

### Migration: search_public_characters RPC

(See Pattern 3 above for full SQL.)

### Renderer: BrowseStore (shape sketch)

```typescript
// src/renderer/src/lib/stores/useBrowseStore.ts
import { create } from 'zustand';

interface BrowseStore {
  entries: Character[];
  query: string;
  loading: boolean;
  exhausted: boolean;
  error: string | null;
  setQuery: (q: string) => void;  // debounced caller upstream
  loadMore: () => Promise<void>;
  reset: () => void;
}

export const useBrowseStore = create<BrowseStore>((set, get) => ({
  entries: [],
  query: '',
  loading: false,
  exhausted: false,
  error: null,
  setQuery: (q) => {
    if (q === get().query) return;
    set({ query: q, entries: [], exhausted: false, error: null });
    void get().loadMore();
  },
  loadMore: async () => {
    if (get().loading || get().exhausted) return;
    set({ loading: true, error: null });
    try {
      const { query, entries } = get();
      const page = await sei.browseSearch(query, 24, entries.length);
      set({
        entries: [...entries, ...page],
        loading: false,
        exhausted: page.length < 24,
      });
    } catch (e) {
      set({ loading: false, error: (e as Error).message });
    }
  },
  reset: () => set({ entries: [], query: '', loading: false, exhausted: false, error: null }),
}));
```

### Renderer: IntersectionObserver hook for the sentinel

```typescript
// src/renderer/src/lib/hooks/useInfiniteScroll.ts
import { useEffect, useRef } from 'react';

export function useInfiniteScroll(onIntersect: () => void): React.RefObject<HTMLDivElement> {
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => { if (entries[0].isIntersecting) onIntersect(); },
      { rootMargin: '200px' }   // fire 200px before sentinel enters viewport
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [onIntersect]);
  return sentinelRef;
}
```

### Main: moderation pre-publish gate

```typescript
// src/main/cloud/moderationGate.ts
import { uploadPortrait, upsertCharacter } from './cloudCharacterClient';
import { callEdgeFunction } from '../auth/edgeFunctionClient';

export async function publishWithModeration(c: Character, ownerUuid: string): Promise<void> {
  // 1. Upload portrait bytes FIRST (un-shared row); we need a Storage URL to scan
  if (c.portrait_image) {
    await uploadPortrait(ownerUuid, c.id, /* bytes */);
  }
  const portraitUrl = `${SUPABASE_URL}/storage/v1/object/public/portraits/${ownerUuid}/${c.id}.png`;

  // 2. Image moderation (synchronous block per D-32b)
  const imgResult = await callEdgeFunction('moderate-character-images', { portrait_url: portraitUrl });
  if (imgResult.flagged) {
    throw new Error('MODERATION_IMAGE_FLAGGED: Image flagged by automated review — please use a different portrait.');
  }

  // 3. Prompt moderation — hard tier
  const hardResult = await callEdgeFunction('moderate-character-prompt', {
    text: `${c.name}\n\n${c.persona_source}`,
    kind: 'hard',
  });
  if (hardResult.blocked) {
    throw new Error('MODERATION_PROMPT_FLAGGED: We can\'t publish this character because the persona description hits our content guidelines. Edit the persona and try again, or save it as private.');
  }

  // 4. Prompt moderation — soft tier (persona_expanded)
  // ... attempt up to 2 regenerations per Pitfall 6 ...

  // 5. All clean → upsert with shared=true AND moderation_status='clean'
  await upsertCharacter({
    ...c,
    shared: true,
    moderation_status: 'clean',
    moderation_checked_at: new Date().toISOString(),
    moderation_provider: 'sightengine-v2.1+face-attributes',
    moderation_text_provider: 'openai-omni-moderation-latest',
    moderation_text_checked_at: new Date().toISOString(),
  }, ownerUuid);
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|---|---|---|---|
| OpenAI `text-moderation-latest` (text-only) | `omni-moderation-latest` (multimodal, 13 categories) | 2024-09-26 (OpenAI) | Free; can moderate images too if needed later; new categories `illicit` and `illicit/violent` |
| pg_notify + Realtime polling | Database Webhooks (pg_net.http_post) | Supabase managed feature since 2023 | Don't have to write polling Edge Functions |
| SightEngine `nudity` v1 (binary) | `nudity-2.1` (29-class fine-grained) | 2023 | Need to interpret 29 classes — but more nuanced gating decisions possible |
| `react-window` + scroll listeners | `IntersectionObserver` sentinel | Browser-native since 2019 | Less code, passive observation |

**Deprecated / outdated:**
- OpenAI `text-moderation-007`: superseded by `omni-moderation-latest`; new code should not use it.
- Supabase old "Realtime triggers" hack for notifying functions: superseded by Database Webhooks.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|---|---|---|
| A1 | SightEngine free tier is adequate for v1.0 launch (hundreds of characters) | Pitfall 12 | If wrong, uploads block at 500/day cap — user impact at viral moment |
| A2 | SightEngine pricing model is "operations" not "per-image" — exact rate not verified for `nudity-2.1+face-attributes` combo (combined call may count as 2 ops?) | Standard Stack | Cost projection off by 2x |
| A3 | OpenAI Moderation remains free indefinitely | Standard Stack | If OpenAI adds metered billing, monthly cost goes from $0 to ~cents/month at v1.0 scale |
| A4 | The existing public Storage bucket pattern is acceptable for v1.0 with row-level moderation gating (Pitfall 3 option a) | Pitfall 3 | If a portrait is leaked via direct URL during upload→moderation window, reputation harm |
| A5 | Phase 11 HR-01 and HR-02 will be fixed before Phase 12 wiring depends on them | Pitfalls 9, 10 | If skipped, Phase 12 inherits + amplifies the bugs |
| A6 | `BROWSE_ENABLED` as a `<userData>/config.json` field is acceptable (vs. a hardcoded build-time const) | BROWSE_ENABLED flag plumbing | If wrong, requires recompile to enable Browse; recommend config.json so the user can flip without rebuild |
| A7 | Resend (or similar) is acceptable for the dmca@sei.app email channel; no specific provider locked in CONTEXT | Pattern 6 | Planner needs to choose provider; cost minimal |
| A8 | Database trigger parameters (`app.settings.edge_url`, `app.settings.service_role_key`) need to be set via `ALTER DATABASE ... SET ...` (or via Supabase Vault + `vault.secrets`). Specific Supabase-recommended approach not verified by deeper search this session. | Pattern 1 | If wrong, the trigger fires but the HTTP POST has no URL — manual operations needed |
| A9 | SightEngine `face-attributes` minor field is reliable enough to gate CSAM. Provider docs warn 15-20yo cluster near 0.5 | Pattern 4 | Conservative threshold (>0.5) may yield false positives on legit teen-looking adult characters; document false-positive appeals path (per D-32 deferred: "creator emails dmca@sei.app for manual review") |

## Open Questions

1. **Email provider for dmca@sei.app delivery from Edge Function?**
   - What we know: CONTEXT names dmca@sei.app as the destination; doesn't lock a sender provider.
   - What's unclear: Resend vs Postmark vs Supabase SMTP wrapper. All cheap.
   - Recommendation: Use Resend (developer-friendly, generous free tier of 3000/mo). Add `RESEND_API_KEY` to Edge Function secrets.

2. **Should `submit-report` Edge Function be invoked from main or directly from renderer via JWT?**
   - What we know: Renderer never imports `@supabase/supabase-js` (Phase 11 invariant); main has `edgeFunctionClient.ts` for Edge Function calls.
   - What's unclear: Whether to add the report-submit Edge Function call to `edgeFunctionClient.ts` or a new `moderationEdgeClient.ts`.
   - Recommendation: New `moderationEdgeClient.ts` for the 4 mod-domain Edge Functions; mirrors existing `edgeFunctionClient.ts` shape.

3. **How does the "Add to Mine" badge predicate distinguish "I own this in cloud" vs "I have a local cached copy of someone else's character"?**
   - What we know: `useCloudCharactersStore.cloudIds` is the set of characters where `owner = me`. A Browse entry by user-X is NOT in my cloudIds even after Add-to-Mine.
   - What's unclear: Per CONTEXT D-31c, the badge is "Already in My Library" — by which they mean "has a local cached copy."
   - Recommendation: Use `useDataStore.characters.some(c => c.id === entry.id)` for the badge predicate. This is the local-file list. No new IPC; matches the conceptual "is this in my library?" question.

4. **Does the "Browse" tab persist a search-result cache across navigation away?**
   - What we know: CONTEXT D-31c says `useBrowseStore` exposes `entries`, `query`, `loading`, `loadMore`, `setQuery`. Doesn't specify a reset on unmount.
   - What's unclear: Should re-entering Browse re-fetch from offset=0, or restore prior scroll position?
   - Recommendation: Keep store state across navigation (Zustand default behavior). Add a manual `refresh` button if poll-on-focus isn't shipping for v1.0.

5. **Should the backfill Edge Function be invoked manually (curl) or scheduled?**
   - What we know: D-32c says "one-shot Edge Function ... walks all `characters WHERE shared=true AND moderation_status IS NULL`."
   - What's unclear: Trigger mechanism — operator runs `curl` once? Supabase Cron Job?
   - Recommendation: One-shot manual invocation via authenticated curl from operator's machine. Function is idempotent + resumable so re-runs are safe.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|---|---|---|---|---|
| Supabase project (live) | All cloud features | Yes (from Phase 10/11) | n/a | None |
| Supabase Edge Function runtime (Deno) | 4 new Edge Functions | Yes (from Phase 10 `delete-me`) | Deno managed | None |
| SightEngine account + API user/secret | Image moderation | NEW — user must register | n/a | If unavailable: uploads with portraits cannot be moderated → publish blocked. Free tier is sufficient. |
| OpenAI API account + key | Prompt moderation | NEW — user likely has from Phase 0 of project but a separate account / key advised | n/a | Required; no fallback (no equivalent free moderation API) |
| Resend (or chosen email provider) account + key | dmca@sei.app inbox delivery | NEW | n/a | Could fall back to Supabase built-in SMTP if configured |
| Discord webhook URL | Report notifications | NEW — user creates one in their Discord server | n/a | Operator just sets a stub URL; the operator-running-this-step controls the destination |
| US Copyright Office account | DMCA agent registration | NEW | n/a | Required by SHARE-09; no fallback (statutory) |
| `pg_net` extension on Supabase | Database Webhook | Yes (always enabled on Supabase) | n/a | None needed |

**Missing dependencies with no fallback:**
- SightEngine account (Phase 12 cannot deploy until SightEngine keys are provisioned)
- OpenAI API key for moderation (already required by AUTH/PROXY phases conceptually, but needs to be present at deploy time)
- DMCA registration paperwork ($6, 24-48hr Copyright Office processing)

**Missing dependencies with fallback:**
- Email provider — multiple options viable; planner picks one. Resend recommended for the developer experience.

## Validation Architecture

> SKIPPED — `workflow.nyquist_validation` is explicitly `false` in `.planning/config.json`.

## Project Constraints (from CLAUDE.md)

| Constraint | Phase 12 implication |
|---|---|
| Three-process Electron (main ↔ renderer via contextIsolation ↔ utilityProcess) | Browse RPC + moderation Edge Function calls live in MAIN. Renderer has no `@supabase/supabase-js` import. utilityProcess (mineflayer) untouched by this phase. |
| Closed action registry; LLM never generates code | Persona-expansion soft-regenerate (D-33b) is a structured LLM call — output is text persona only, not code. Already an established pattern from Phase 11 (`expandAndSaveCharacter`). |
| Every external call has a timeout | Wrap SightEngine + OpenAI calls in 15s `AbortController` (matches `cloudCharacterClient.ts` `TIMEOUT_MS = 15_000`). Discord/email calls in `notify-report` also wrapped. |
| Commit planning docs alongside code changes | Phase 12 plans + this RESEARCH.md commit per `commit_docs: true` in config |
| After each phase: update STATE.md + ROADMAP.md | Standard end-of-phase workflow |
| Push target is `dev`, not `main` | Phase 12 commits/PRs target `dev` |

## Sources

### Primary (HIGH confidence)
- `supabase/functions/_shared/cors.ts` (read in session) — Sei's CORS helper convention
- `supabase/functions/delete-me/index.ts` (read in session) — Sei's Edge Function precedent
- `supabase/migrations/20260521000000_characters_tos.sql` (read in session) — current characters schema
- `supabase/migrations/20260521000100_storage_buckets.sql` (read in session) — confirms buckets are PUBLIC, critical for Pitfall 3
- `.planning/phases/11-cloud-character-library/11-CONTEXT.md` (read in session) — Phase 11 decisions Phase 12 builds on
- `.planning/phases/11-cloud-character-library/11-19-SUMMARY.md` (read in session) — cacheOnDemand contract for Add-to-Mine reuse
- `.planning/phases/11-cloud-character-library/11-17-SUMMARY.md` (read in session) — useCloudCharactersStore contract
- `.planning/phases/11-cloud-character-library/11-REVIEW.md` (read in session) — HR-01, HR-02 bugs that block Phase 12
- [Supabase Database Webhooks](https://supabase.com/docs/guides/database/webhooks) — pg_net pattern for trigger→function
- [Supabase Database Functions](https://supabase.com/docs/guides/database/functions) — RPC + security invoker
- [SightEngine Nudity 2.1](https://sightengine.com/docs/advanced-nudity-detection-model-2.1) — 29-class model, no minor field
- [SightEngine Face Attributes](https://sightengine.com/docs/face-attribute-model) — minor field 0..1, model spelling `face-attributes`
- [SightEngine API Reference](https://sightengine.com/docs/reference) — model chaining via comma
- [OpenAI Moderation Guide](https://developers.openai.com/api/docs/guides/moderation) — endpoint, multimodal, categories
- [OpenAI omni-moderation announcement](https://openai.com/index/upgrading-the-moderation-api-with-our-new-multimodal-moderation-model/) — 2024-09-26 release, scope
- [US Copyright Office DMCA Directory FAQs](https://www.copyright.gov/dmca-directory/faq.html) — $6 fee, online-only, sole prop eligible
- `npm view @supabase/supabase-js version` → `2.106.1` (verified in session)

### Secondary (MEDIUM confidence)
- [SightEngine Pricing](https://sightengine.com/pricing) — free tier 2000 ops/month, 500/day; per-model cost not enumerated
- [Sequin: Trigger Supabase Edge Functions from DB changes](https://sequinstream.com/docs/guides/supabase-function) — third-party confirmation of Webhook pattern
- [freeCodeCamp: Infinite Scrolling in React](https://www.freecodecamp.org/news/infinite-scrolling-in-react/) — IntersectionObserver hook idiom

### Tertiary (LOW confidence)
- [evolink.ai: omni-moderation guide](https://evolink.ai/blog/omni-moderation-latest-guide) — third-party blog corroborating OpenAI response shape (flagged for validation against official docs at integration time)
- [analyticsvidhya: OpenAI Omni Moderation](https://www.analyticsvidhya.com/blog/2026/05/openai-omni-moderation/) — corroborating multimodal capability
- [Supabase docs: signed URLs](https://supabase.com/docs/reference/javascript/storage-from-createsignedurl) — referenced if Pitfall 3 option (b) is chosen instead of (a)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — every dep is either already installed or has clear official docs
- Architecture: HIGH — every pattern reuses an established Phase 11 surface
- API contracts (SightEngine, OpenAI, Supabase Webhooks): HIGH — fetched official docs in this session
- Pitfalls: HIGH — most cite specific bugs (HR-01/HR-02) or schema realities (public buckets) verified in source
- Operational details (DMCA paperwork, Discord webhook setup): MEDIUM — process is well-documented but not exercised in this codebase yet
- SightEngine pricing for combined model call: LOW — pricing page does not enumerate per-model rates; planner should confirm with SightEngine before committing to free tier

**Research date:** 2026-05-22
**Valid until:** 2026-06-22 (30 days — OpenAI Moderation API and Supabase Database Webhooks are stable; SightEngine pricing tier may shift)

---

## RESEARCH COMPLETE
