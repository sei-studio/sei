# Phase 12 — Plan Index

**Created:** 2026-05-22
**Total plans:** 18 across 4 waves
**Requirements coverage:** SHARE-01..SHARE-10 (10 of 10)

Use this index to drive `/gsd-execute-phase 12`. Waves run in order; within a wave, `depends_on` chains sequence the plans that share files.

## Wave Plan

| Wave | Concurrent Plans | Sequenced (within-wave deps) |
|------|------------------|------------------------------|
| 1 | — | 12-01 → 12-02 |
| 2 | 12-03, 12-04, 12-05, 12-06 (all parallel after 12-01/02) | 12-07 depends on 12-03 + 12-04 |
| 3 | 12-08 first; 12-09 after; 12-10 → 12-11 → 12-12 (CharactersScreen chain) | 12-09 ∥ 12-10 once 12-08 lands |
| 4 | 12-13, 12-16, 12-17 parallel; 12-14 after 12-17; 12-15 after 12-14; 12-18 last (depends on everything) | sequential at the tail |

## Plan Index

| ID | Wave | Title | Autonomous | Requirements | Files-modified count |
|----|------|-------|------------|--------------|----------------------|
| 12-01 | 1 | Migration: characters.moderation_* + reports table + search RPC + auto-hide + Database Webhook triggers | yes | SHARE-02, 06, 07, 08 | 1 |
| 12-02 | 1 | Backfill Edge Function + shared moderationProviders helper | yes | SHARE-06, 07 | 2 |
| 12-03 | 2 | Edge Function: moderate-character-images (SightEngine) | yes | SHARE-06 | 1 |
| 12-04 | 2 | Edge Function: moderate-character-prompt (OpenAI two-tier) | yes | SHARE-07 | 1 |
| 12-05 | 2 | Edge Function: submit-report (rate-limited; TDD) | yes | SHARE-08 | 2 |
| 12-06 | 2 | Edge Function: notify-report (Discord + Resend) | yes | SHARE-08 | 1 |
| 12-07 | 2 | Main: moderationGate.ts orchestrator (TDD) + CLOUD_MODERATION_* sentinels | yes | SHARE-05, 06, 07 | 3 |
| 12-08 | 3 | IPC: browse:list / browse:report / browse:publish-with-moderation / capabilities:get + moderationEdgeClient | yes | SHARE-01, 02, 04, 05, 08 | 4 |
| 12-09 | 3 | Renderer: useBrowseStore (TDD; in-store debounce) | yes | SHARE-01, 02, 04 | 2 |
| 12-10 | 3 | Renderer: CharactersScreen refactor (HomeScreen → tabbed Home + Browse) | yes | SHARE-01 | 4 |
| 12-11 | 3 | Renderer: BrowseCard component + CharactersScreen wiring | yes | SHARE-03, 04, 08, 10 | 3 |
| 12-12 | 3 | Renderer: Add-to-Mine integration (toast + refresh chain + HR-02 verify) | yes | SHARE-04 | 2 |
| 12-13 | 4 | Renderer: ReportModal (phased; cancellable; rate-limit handling) | yes | SHARE-08 | 3 |
| 12-14 | 4 | Renderer: DmcaContactModal + SettingsScreen Legal panel | yes | SHARE-09 | 3 |
| 12-15 | 4 | Legal: terms.html §7 DMCA + privacy.html cross-ref + TOS/PRIVACY version bump (human-verify checkpoint) | NO | SHARE-09 | 3 |
| 12-16 | 4 | Main: capabilities.ts + UserConfigSchema browse_enabled | yes | SHARE-01 | 2 |
| 12-17 | 4 | Main: openExternal allowlist for dmca.copyright.gov + mailto: | yes | SHARE-09 | 1 |
| 12-18 | 4 | Rollout: DMCA registration + placeholder swap + BROWSE_ENABLED flip (human-action + human-verify) | NO | SHARE-09 | 3 |

## Wave Overlap Audit

Within each wave, plans either touch disjoint files OR are sequenced by `depends_on` (executor runs deps first).

- **Wave 1:** 12-01 then 12-02 (12-02 depends on 12-01). No file overlap.
- **Wave 2:** 12-03/04/05/06 touch distinct Edge Function dirs (parallel safe). 12-07 depends on 12-03 + 12-04 — runs after. No conflicts.
- **Wave 3:** 12-08 lands first (sole writer of src/shared/ipc.ts + src/main/ipc.ts in this wave); 12-09 + 12-10 can run in parallel after; 12-10 → 12-11 → 12-12 chain on CharactersScreen.tsx (explicit depends_on serializes).
- **Wave 4:** 12-13, 12-16, 12-17 fully parallel (disjoint files). 12-14 depends on 12-17 (allowlist must land before modal). 12-15 depends on 12-14 (legal copy references modal swap). 12-18 depends on EVERYTHING (rollout terminus).

No two plans in the same wave touch the same file WITHOUT an explicit depends_on chain.

## Requirements Coverage

Every SHARE-N requirement appears in at least one plan:

| Requirement | Plans addressing |
|-------------|------------------|
| SHARE-01 (Home/Browse split) | 12-08, 12-09, 12-10, 12-16 |
| SHARE-02 (Text search) | 12-01, 12-08, 12-09 |
| SHARE-03 (Browse cards) | 12-11 |
| SHARE-04 (Preview + Add to Mine) | 12-08, 12-09, 12-11, 12-12 |
| SHARE-05 (Public/private + content-policy confirm) | 12-07, 12-08 |
| SHARE-06 (CSAM scan) | 12-01, 12-02, 12-03, 12-07 |
| SHARE-07 (Prompt moderation) | 12-01, 12-02, 12-04, 12-07 |
| SHARE-08 (Report flow) | 12-01, 12-05, 12-06, 12-08, 12-11, 12-13 |
| SHARE-09 (DMCA agent + ToS) | 12-14, 12-15, 12-17, 12-18 |
| SHARE-10 (last-updated + attribution placeholder) | 12-11 (BrowseCard creatorLabel + updatedAt fields) |

## Researcher Pitfall Citations

Each pitfall flagged in 12-RESEARCH.md is enforced by at least one plan:

| Pitfall | Enforced by |
|---------|-------------|
| 1 (SightEngine `face-attributes` not `minor`) | 12-02 helper + 12-03 inherits |
| 2 (Database Webhook not pg_notify) | 12-01 tg_notify_report_inserted uses net.http_post |
| 3 (Public bucket — gate at row level) | 12-01 search_public_characters filter; documented as accepted |
| 4 (Report flooding via direct INSERT) | 12-01 no RLS insert policy; 12-05 submit-report rate-limit |
| 5 (Backfill resumable + verify count=0 before flip) | 12-02 idempotent batch; 12-18 Task 3 checklist |
| 6 (persona_expanded soft-regenerate infinite loop) | 12-07 SOFT_RETRY_CAP=2; tested |
| 7 (Report button gestural conflict) | 12-11 e.stopPropagation() on Report click |
| 8 (Infinite scroll duplicate fetches) | 12-09 useBrowseStore loading guard; tested |
| 9 (HR-01 carryover) | Resolved in Phase 11; documented |
| 10 (HR-02 carryover) | 12-12 Task 2 verification + optimistic exit |
| 11 (Mojang skin URL latency) | 12-08 BrowseEntry.skinUrl uses Supabase Storage URL |
| 12 (SightEngine free tier 500/day) | 12-03 hard-fail on 502; documented in deferred-items |

## Operator Runbook (cross-plan)

After all plans execute, the operator MUST complete these out-of-band steps for the phase to be functionally live:

1. **Supabase secrets** (12-02/03/04/05/06):
   ```
   supabase secrets set \
     SIGHTENGINE_API_USER=... SIGHTENGINE_API_SECRET=... \
     OPENAI_API_KEY=... \
     DISCORD_REPORT_WEBHOOK_URL=... \
     RESEND_API_KEY=...
   ```
2. **Supabase Database settings** (12-01 Section 4):
   ```
   alter database postgres set app.settings.edge_url = 'https://<ref>.supabase.co';
   alter database postgres set app.settings.service_role_key = '<service-role-key>';
   ```
3. **Database Webhook config** (12-01 + 12-06):
   - Supabase Dashboard → Database → Webhooks → create `report_new_webhook` targeting `https://<ref>.supabase.co/functions/v1/notify-report` with `Authorization: Bearer <service_role>` header.
4. **Edge Function deployment**:
   ```
   supabase functions deploy backfill-moderate-existing moderate-character-images \
                              moderate-character-prompt submit-report notify-report
   ```
5. **Backfill loop** (12-02 + 12-18 Task 3):
   ```
   while true; do
     R=$(curl -s -X POST -H "Authorization: Bearer $SERVICE_ROLE" \
        https://<ref>.supabase.co/functions/v1/backfill-moderate-existing)
     [ "$(echo $R | jq -r .nextCursor)" = "done" ] && break
   done
   ```
6. **DMCA registration** (12-18 Task 1): manual, 24-48h at dmca.copyright.gov.
7. **BROWSE_ENABLED flip** (12-18 Task 4): edit userData/config.json after Task 3 checklist passes.
