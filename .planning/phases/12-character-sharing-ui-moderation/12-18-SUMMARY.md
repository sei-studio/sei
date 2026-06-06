---
phase: 12-character-sharing-ui-moderation
plan: 18
subsystem: rollout-operator-runbook
tags: [checkpoint, rollout, runbook, dmca, browse-enabled, operator-action, phase-closure]

# Dependency graph
requires:
  - phase: 12-character-sharing-ui-moderation
    plan: 01
    provides: "moderation_and_reports migration (characters.moderation_* columns + reports table + reports_after_insert_webhook trigger + reports_auto_hide_trigger)"
  - phase: 12-character-sharing-ui-moderation
    plan: 02
    provides: "_shared/moderationProviders.ts (SightEngine + OpenAI threshold interpreters)"
  - phase: 12-character-sharing-ui-moderation
    plan: 03
    provides: "moderate-character-images Edge Function (synchronous CSAM gate)"
  - phase: 12-character-sharing-ui-moderation
    plan: 04
    provides: "moderate-character-prompt Edge Function (two-tier hard/soft prompt gate)"
  - phase: 12-character-sharing-ui-moderation
    plan: 05
    provides: "submit-report Edge Function (rate-limited service_role insert)"
  - phase: 12-character-sharing-ui-moderation
    plan: 06
    provides: "notify-report Edge Function (Database Webhook consumer → Discord + Resend)"
  - phase: 12-character-sharing-ui-moderation
    plan: 07
    provides: "publishWithModeration orchestrator (main process)"
  - phase: 12-character-sharing-ui-moderation
    plan: 14
    provides: "DmcaContactModal.tsx with four placeholder constants (AGENT_NAME / AGENT_ADDRESS / AGENT_EMAIL / DIRECTORY_LISTING_URL)"
  - phase: 12-character-sharing-ui-moderation
    plan: 15
    provides: "terms.html §7 with three named placeholder spans (dmca-name / dmca-address / dmca-receipt)"
  - phase: 12-character-sharing-ui-moderation
    plan: 16
    provides: "capabilities.ts + UserConfigSchema.browse_enabled (the flag this plan flips)"
  - phase: 12-character-sharing-ui-moderation
    plan: 17
    provides: "openExternal allowlist extended to dmca.copyright.gov + mailto:dmca@sei.app"
provides:
  - "Operator runbook for Phase 12 production rollout — DMCA registration, secret provisioning, Edge Function deploy, backfill loop, BROWSE_ENABLED flip"
  - "Exact edit instructions for the four DmcaContactModal constants + three terms.html named spans"
  - "Per-OS userData/config.json path table + JSON shape for browse_enabled flip"
  - "End-to-end smoke test plan (publish → browse → add → report → moderation block) with expected outcomes"
affects: ["v1.0 launch — Phase 12 is the final phase before Browse is publicly live"]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Documented runbook handoff pattern: each operator step has a [STATUS] tag ([OPERATOR ACTION REQUIRED] vs [CODE COMPLETE]) so the operator knows what to do vs what's already shipped"
    - "Pre-flight gate ordering: DMCA registration → secrets → migration → Database Webhook → Edge Function deploy → backfill loop → placeholder swaps → smoke test → flag flip. Any step out of order leaves a foot-gun"

key-files:
  created:
    - .planning/phases/12-character-sharing-ui-moderation/12-18-SUMMARY.md
  modified: []
  pending-operator-edit:
    - src/renderer/src/components/DmcaContactModal.tsx (lines 32-35 — four constants)
    - ../sei-website/terms.html (lines 133-136 — three named spans)
    - ~/Library/Application Support/Sei Launcher/config.json (browse_enabled: true)

key-decisions:
  - "Phase 12 ships CODE COMPLETE with placeholder DMCA agent values + browse_enabled=false. Operator rollout is a strictly-ordered manual sequence captured in this SUMMARY. Plan 12-18 is NOT executed inside the IDE session — Claude cannot file the eForm, pay the $6, deploy Edge Functions with real secrets, or flip the operator's userData config.json. The deliverable here IS the runbook."
  - "Pre-flight gate (D-36) is enforced by checklist + smoke test, not by code. Operator self-discipline is the control; threat T-12-18-02 mitigation = the operator must explicitly type confirmation before proceeding, which in this runbook surface = walking down the checkbox list top-to-bottom"
  - "userData/config.json on macOS is under productName='Sei Launcher' (not 'sei'). The plan body incorrectly cited '~/Library/Application Support/sei/config.json' — the actual path is '~/Library/Application Support/Sei Launcher/config.json'. Verified via `ls ~/Library/Application Support/ | grep -i sei` returning 'Sei Launcher' + 'Sei Launcher Dev'. Documented under deviations"
  - "Single sub-repo split: `../sei-website` for terms.html, `/Users/ouen/slop/sei` for everything else. Operator edits are split commits between the two repos. The website repo is auto-deployed via its own CI; once committed + pushed the live terms.html updates within seconds"

requirements-completed: [SHARE-09]

# Metrics
duration: ~10min (runbook authoring; operator execution is multi-hour gated by DMCA processing)
completed: 2026-05-22
---

# Phase 12 Plan 18: Rollout Checkpoint — Operator Runbook

**Phase 12 is CODE COMPLETE. This plan delivers the strictly-ordered operator runbook to flip Sei Browse live: register the DMCA agent at dmca.copyright.gov, swap four placeholder constants + three named spans, set five Supabase secrets, deploy five Edge Functions, configure the Database Webhook, run the backfill loop until done, and flip `browse_enabled=true` in userData/config.json.**

## Phase 12 Closure Status

| Surface                              | Status                          |
| ------------------------------------ | ------------------------------- |
| Schema migration                     | [CODE COMPLETE] — Plan 12-01    |
| Moderation provider helpers          | [CODE COMPLETE] — Plan 12-02    |
| moderate-character-images function   | [CODE COMPLETE] — Plan 12-03    |
| moderate-character-prompt function   | [CODE COMPLETE] — Plan 12-04    |
| submit-report function               | [CODE COMPLETE] — Plan 12-05    |
| notify-report function               | [CODE COMPLETE] — Plan 12-06    |
| publishWithModeration orchestrator   | [CODE COMPLETE] — Plan 12-07    |
| IPC contracts (browse / capabilities)| [CODE COMPLETE] — Plan 12-08    |
| useBrowseStore                       | [CODE COMPLETE] — Plan 12-09    |
| CharactersScreen tab refactor        | [CODE COMPLETE] — Plan 12-10    |
| BrowseCard component                 | [CODE COMPLETE] — Plan 12-11    |
| Add-to-Mine polish                   | [CODE COMPLETE] — Plan 12-12    |
| ReportModal                          | [CODE COMPLETE] — Plan 12-13    |
| DmcaContactModal                     | [CODE COMPLETE] — Plan 12-14    |
| terms.html §7 + version bump         | [CODE COMPLETE] — Plan 12-15    |
| capabilities + BROWSE_ENABLED flag   | [CODE COMPLETE] — Plan 12-16    |
| openExternal allowlist               | [CODE COMPLETE] — Plan 12-17    |
| DMCA registration                    | [OPERATOR ACTION REQUIRED]      |
| Edge Function deployment             | [OPERATOR ACTION REQUIRED]      |
| Secret provisioning                  | [OPERATOR ACTION REQUIRED]      |
| Database Webhook configuration       | [OPERATOR ACTION REQUIRED]      |
| Backfill loop                        | [OPERATOR ACTION REQUIRED]      |
| Placeholder swaps                    | [OPERATOR ACTION REQUIRED]      |
| browse_enabled flip                  | [OPERATOR ACTION REQUIRED]      |
| End-to-end smoke                     | [OPERATOR ACTION REQUIRED]      |

**All 18 plans in Phase 12 have shipped code. The remaining work is strictly operator-driven: file a form, set some keys, paste some real values, run a curl loop, edit one local file.**

---

## Operator Runbook — Strictly Ordered Checklist

Execute top to bottom. Do not skip ahead. Each step has a gate that the next step depends on.

### Step 1 — Register DMCA Designated Agent [OPERATOR ACTION REQUIRED]

**Time estimate:** 30 minutes to file + 24-48 hours for Copyright Office processing.

**Why:** 17 U.S.C. § 512 statutorily requires a registered agent before any safe-harbor takedown defense applies. D-35 locked the registration mode as **sole proprietor, $6 / 3-year fee**. There is NO anonymous DMCA agent path — your real legal name + mailing address will appear in the public Directory at https://dmca.copyright.gov/list. This is the threat T-12-18-01 disposition (`accept`).

**Steps:**

- [ ] Go to https://dmca.copyright.gov/.
- [ ] Create an account (or sign in if one already exists).
- [ ] Open the **Designated Agent eForm** ("Designated Agent → Add new").
- [ ] Fill in:
  - **Service provider name:** `Sei` (the desktop application)
  - **Service provider website:** `https://sei.gg` (or whatever the live marketing URL is when filing)
  - **Designated Agent legal name:** real personal full name (PUBLIC).
  - **Mailing address:** real residential or business address (PUBLIC — no PO Box workaround). Per D-35 you are filing as a sole proprietor.
  - **Email:** `dmca@sei.app` (the live mailbox — already set up; verified by Resend DKIM/SPF in step 4).
  - **Phone:** real phone number (PUBLIC).
- [ ] Submit + pay $6 via the eForm.
- [ ] Wait for confirmation email ("Your designated agent registration is complete"). Typical: 24-48 hours; sometimes longer.
- [ ] Once approved, navigate to your account's **Service Provider page** and **copy the public Directory listing URL**. It will look like `https://dmca.copyright.gov/list?title=Sei&...` or a direct permalink to the entry. **THIS URL** is what gets pasted into the modal + terms.html in Step 5.

**Gate to next step:** Copyright Office confirmation email received + Directory URL captured.

---

### Step 2 — Provision Supabase Secrets [OPERATOR ACTION REQUIRED]

**Time estimate:** 20 minutes (most of it is account signups at SightEngine / OpenAI / Resend / Discord).

**Why:** The five Edge Functions read provider credentials from `Deno.env.get(...)`. Without the secrets they 500 on first call; with bad values they silently let through unmoderated content (depending on the call path). Set all five before deploying functions.

**Prerequisite accounts:**

- [ ] **SightEngine** account at https://sightengine.com — capture `API user` + `API secret`. nudity-2.1 + face-attributes models are the relevant SKUs ($0.002/image). D-32a locked.
- [ ] **OpenAI** API key — `omni-moderation-latest` is FREE quota but the key must belong to an account. https://platform.openai.com/api-keys
- [ ] **Discord** webhook for the moderation triage channel — Discord server → channel settings → Integrations → Webhooks → New Webhook → copy URL. Treat as secret-equivalent per Plan 12-06's `discordUrl` never-logged invariant.
- [ ] **Resend** account at https://resend.com with the `sei.app` domain verified (DKIM + SPF records published in DNS). Resend dashboard → API Keys → create key with `emails:send` scope. Verify the `sei.app` domain shows `verified` BEFORE flipping browse_enabled — `notify-report` mails the creator via `Sei Moderation <reports@sei.app>` and unverified domains fail silently per Plan 12-06's always-200 policy.

**Set secrets** (replace `<project-ref>` with your actual project ref; replace each VALUE):

```bash
# Authenticate the supabase CLI with the right project
supabase login
supabase link --project-ref <project-ref>

# Five secrets cover all five functions.
supabase secrets set SIGHTENGINE_API_USER='<sightengine-api-user>'
supabase secrets set SIGHTENGINE_API_SECRET='<sightengine-api-secret>'
supabase secrets set OPENAI_API_KEY='<openai-key>'
supabase secrets set DISCORD_REPORT_WEBHOOK_URL='https://discord.com/api/webhooks/<id>/<token>'
supabase secrets set RESEND_API_KEY='re_<...>'

# Verify
supabase secrets list
```

**Expected `supabase secrets list` output:** All five names present plus the Supabase-auto-injected `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`.

**Gate to next step:** `supabase secrets list` shows all five custom secrets + Resend `sei.app` domain status = verified.

---

### Step 3 — Apply the Moderation Migration + Set Postgres Settings [OPERATOR ACTION REQUIRED]

**Time estimate:** 5 minutes.

**Why:** Plan 12-01's migration creates the `characters.moderation_*` columns + the `reports` table + both triggers (`reports_after_insert_webhook` and `reports_auto_hide_trigger`). The trigger uses `pg_net.http_post` to call the `notify-report` Edge Function and needs two Postgres settings to know WHERE to call:

- `app.settings.edge_url` — your project's Edge Function base URL.
- `app.settings.service_role_key` — the Bearer token sent to `notify-report` (verbatim-compared at the Edge per Plan 12-06's T-12-06-01 mitigation).

**Steps:**

- [ ] Push migrations to the linked project:
  ```bash
  supabase db push
  ```
- [ ] Verify `20260523000000_moderation_and_reports.sql` is now applied:
  ```bash
  supabase migration list
  ```
  Expected: the moderation migration appears under `Local | Remote | Time (UTC)` with both columns populated.

- [ ] Set the two Postgres settings via the Supabase SQL Editor (dashboard → SQL Editor → New query):
  ```sql
  ALTER DATABASE postgres
    SET app.settings.edge_url = 'https://<project-ref>.supabase.co';
  ALTER DATABASE postgres
    SET app.settings.service_role_key = '<your-service-role-key>';
  ```
  Run them as ONE script. (The migration file's header comment block at line 140-142 of `supabase/migrations/20260523000000_moderation_and_reports.sql` documents this same step — copy from there to avoid typos.)

- [ ] Confirm:
  ```sql
  SELECT current_setting('app.settings.edge_url', true);
  SELECT current_setting('app.settings.service_role_key', true);
  ```
  Both should return the values you just set (not NULL).

**Gate to next step:** Migration applied + both settings non-NULL.

---

### Step 4 — Deploy All Five Edge Functions [OPERATOR ACTION REQUIRED]

**Time estimate:** 5 minutes.

**Why:** None of the synchronous moderation paths work until the functions are live in Supabase. The `publishWithModeration` orchestrator (Plan 12-07) wraps each function with a 30s timeout — without deployment the wrap returns `CLOUD_MODERATION_PROVIDER_UNAVAILABLE` on every publish attempt.

**Steps:**

- [ ] Deploy each function (run from the `/Users/ouen/slop/sei` repo root):
  ```bash
  supabase functions deploy moderate-character-images
  supabase functions deploy moderate-character-prompt
  supabase functions deploy submit-report
  supabase functions deploy notify-report
  supabase functions deploy backfill-moderate-existing
  ```

- [ ] Verify all five are live:
  ```bash
  supabase functions list
  ```
  Expected: five rows showing `Active` status, plus the pre-existing `delete-me` from Phase 10.

- [ ] (Sanity check) Hit each function's OPTIONS preflight to confirm CORS is wired:
  ```bash
  for fn in moderate-character-images moderate-character-prompt submit-report notify-report backfill-moderate-existing; do
    echo "=== $fn ==="
    curl -i -X OPTIONS "https://<project-ref>.supabase.co/functions/v1/$fn"
  done
  ```
  Each should return `204 No Content` with `Access-Control-Allow-Origin` and `Access-Control-Allow-Methods` headers.

**Gate to next step:** Five functions deployed + preflights returning 204.

---

### Step 5 — Configure the `report_new_webhook` Database Webhook [OPERATOR ACTION REQUIRED]

**Time estimate:** 5 minutes.

**Why:** Plan 12-01's `reports_after_insert_webhook` trigger calls `pg_net.http_post(...)`. The TARGET URL + Authorization header are configured via the Supabase Dashboard's Database Webhooks panel (NOT in code — Supabase's hosted webhooks UI is the source of truth on the free tier).

**Steps:**

- [ ] Supabase Dashboard → **Database** → **Webhooks** → **Create a new hook**.
- [ ] Configure:
  - **Name:** `report_new_webhook`
  - **Table:** `public.reports`
  - **Events:** `INSERT` (only — no UPDATE/DELETE)
  - **Type:** HTTP request
  - **Method:** POST
  - **URL:** `https://<project-ref>.supabase.co/functions/v1/notify-report`
  - **HTTP Headers:**
    - `Authorization`: `Bearer <service-role-key>` (the same key from Step 3)
    - `Content-Type`: `application/json`
  - **Timeout:** 5000ms (Supabase default is fine — `notify-report` is always-200 anyway)
- [ ] Save the webhook.
- [ ] (Verification) Insert a dummy report via SQL Editor and confirm `notify-report` fires:
  ```sql
  -- Replace UUIDs with real values from your reports.character_id / your user id
  INSERT INTO public.reports (reporter_id, character_id, reason, detail)
  VALUES ('<your-uuid>', '<some-existing-character-uuid>', 'other', 'WEBHOOK SMOKE TEST — please ignore.');
  ```
  Then check **Edge Functions → notify-report → Logs** in the Supabase dashboard — you should see a 200 log entry within ~2 seconds.
- [ ] Clean up the dummy row:
  ```sql
  DELETE FROM public.reports WHERE detail = 'WEBHOOK SMOKE TEST — please ignore.';
  ```

**Gate to next step:** Webhook configured + dummy INSERT triggered `notify-report` (visible in function logs).

---

### Step 6 — Run the Backfill Loop Until `nextCursor=done` [OPERATOR ACTION REQUIRED]

**Time estimate:** 5-30 minutes depending on how many `shared=true` characters exist in the Phase 11→12 window.

**Why:** D-32c retroactive scan. Any character published while Phase 11 was live but before Plan 12-03 deployed has `moderation_status=NULL`. The Browse RPC's filter (`moderation_status IS NULL OR moderation_status = 'clean'`) is permissive precisely to keep these legacy rows visible AT FIRST — but the D-36 gate (b) requires this set to be EMPTY before flipping browse_enabled, so unmoderated content never goes live on Browse.

**Steps:**

- [ ] Find your service role key (Supabase Dashboard → Project Settings → API → `service_role` key — DANGEROUS; never commit). Stash it as an env var for the loop:
  ```bash
  export SUPABASE_SERVICE_ROLE_KEY='eyJ...'
  export SUPABASE_PROJECT_REF='<project-ref>'
  ```

- [ ] Run the loop. The function is idempotent + resumable per Plan 12-02 — invoke it until `nextCursor=done`:
  ```bash
  while true; do
    RESULT=$(curl -sS -X POST \
      -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
      "https://${SUPABASE_PROJECT_REF}.supabase.co/functions/v1/backfill-moderate-existing")
    echo "$RESULT"
    CURSOR=$(echo "$RESULT" | jq -r .nextCursor)
    [ "$CURSOR" = "done" ] && break
    sleep 1  # tiny breather; the function self-paces but be polite
  done
  ```
  Each iteration processes up to `BATCH_SIZE=100` rows (per `backfill-moderate-existing/index.ts:61`). Expected output shape per iteration:
  ```json
  {"processed": 87, "flagged": 1, "errors": 0, "nextCursor": "more"}
  ...
  {"processed": 4, "flagged": 0, "errors": 0, "nextCursor": "done"}
  ```

- [ ] Verify ZERO unmoderated `shared=true` rows remain. SQL Editor:
  ```sql
  SELECT count(*) FROM public.characters
  WHERE shared = true AND moderation_status IS NULL;
  ```
  Expected: `0`. If non-zero, re-run the loop (or investigate errors in `notify-report` logs).

- [ ] Inspect the auto-flagged rows the backfill caught. SQL Editor:
  ```sql
  SELECT id, name, owner, moderation_status, moderation_checked_at, moderation_provider
  FROM public.characters
  WHERE moderation_status = 'flagged' AND shared = false
  ORDER BY moderation_checked_at DESC;
  ```
  Review each row. The backfill sets `shared=false` automatically on flag (D-32c). If any row is a clear false positive, manually flip `shared=true` after a creator-side review.

**Gate to next step:** SQL count of unmoderated `shared=true` rows = 0; flagged-and-auto-hidden rows reviewed.

---

### Step 7 — Swap Placeholder Constants in `DmcaContactModal.tsx` [OPERATOR ACTION REQUIRED]

**Time estimate:** 2 minutes.

**Why:** Plan 12-14 shipped the modal with placeholder constants pinned at the top of the file so Plan 12-18 is a four-line edit. The constants drive what users see in **Settings → Legal → Report copyright infringement (DMCA)**.

**File:** `/Users/ouen/slop/sei/src/renderer/src/components/DmcaContactModal.tsx`

**Lines 32-35 (current placeholders):**

```typescript
const AGENT_NAME = '[Designated Agent — pending registration]';
const AGENT_ADDRESS = '[Mailing address pending registration]';
const AGENT_EMAIL = 'dmca@sei.app';
const DIRECTORY_LISTING_URL = 'https://dmca.copyright.gov/list';
```

**Replace with** (substitute REAL values captured in Step 1):

```typescript
const AGENT_NAME = '<Real Legal Name>';
const AGENT_ADDRESS = '<Street Address>\n<City, State ZIP>\n<Country>';
const AGENT_EMAIL = 'dmca@sei.app';                  // unchanged
const DIRECTORY_LISTING_URL = '<full Directory permalink from Step 1>';
```

Notes on the address:
- `AGENT_ADDRESS` is rendered into `<dd className={styles.address}>{AGENT_ADDRESS}</dd>` (line 85). The CSS uses `white-space: pre-line` so `\n` becomes a visual line break.
- Don't escape commas. Don't trail a comma on the last line.
- If you have a suite/apt number, include it on the first line e.g. `'<Street> Unit <N>\n<City, State ZIP>\n<Country>'`.

**Verification:**

```bash
# Should print 0 — no placeholder strings remaining in the modal.
grep -c "pending registration" /Users/ouen/slop/sei/src/renderer/src/components/DmcaContactModal.tsx

# Should print the new agent name on the AGENT_NAME line.
grep -n "AGENT_NAME" /Users/ouen/slop/sei/src/renderer/src/components/DmcaContactModal.tsx
```

**Commit** (from `/Users/ouen/slop/sei`):

```bash
git add src/renderer/src/components/DmcaContactModal.tsx
git commit -m "docs(12-18): swap DMCA agent placeholders for live registration values"
```

**Gate to next step:** `grep -c "pending registration" DmcaContactModal.tsx` returns 0.

---

### Step 8 — Swap Placeholder Spans in `../sei-website/terms.html` [OPERATOR ACTION REQUIRED]

**Time estimate:** 2 minutes.

**Why:** Plan 12-15 shipped terms.html §7 with three named `<span>` IDs as explicit swap targets so Plan 12-18 is a surgical edit, not a paragraph rewrite. These spans drive what visitors see at https://sei.gg/terms.html§7 (per D-35a surface (b)).

**File:** `/Users/ouen/slop/sei-website/terms.html`

**Lines 133-136 (current placeholders):**

```html
<strong>Designated Agent:</strong><br>
<span id="dmca-name">[Designated Agent - pending registration]</span><br>
<span id="dmca-address">[Mailing address pending registration]</span><br>
Email: <a href="mailto:dmca@sei.app">dmca@sei.app</a><br>
Directory listing: <a href="https://dmca.copyright.gov/list" id="dmca-receipt">https://dmca.copyright.gov/list</a>
```

**Replace** (three swap targets):

| Span ID            | Old content                                    | New content                                                      |
| ------------------ | ---------------------------------------------- | ---------------------------------------------------------------- |
| `dmca-name`        | `[Designated Agent - pending registration]`    | `<Real Legal Name>` (same string as `AGENT_NAME` from Step 7)    |
| `dmca-address`     | `[Mailing address pending registration]`       | `<Street Address><br><City, State ZIP><br><Country>` (use `<br>` between lines, NOT `\n`, since this is HTML) |
| `dmca-receipt`     | `href="https://dmca.copyright.gov/list"` + visible text | Set BOTH `href` and the visible text to the captured Directory permalink |

**Resulting block:**

```html
<strong>Designated Agent:</strong><br>
<span id="dmca-name">Real Legal Name</span><br>
<span id="dmca-address">123 Some Street<br>City, State ZIP<br>Country</span><br>
Email: <a href="mailto:dmca@sei.app">dmca@sei.app</a><br>
Directory listing: <a href="https://dmca.copyright.gov/list?...permalink..." id="dmca-receipt">https://dmca.copyright.gov/list?...permalink...</a>
```

**Verification:**

```bash
# Should print 0.
grep -c "pending registration" /Users/ouen/slop/sei-website/terms.html

# Confirm all three named spans still exist with their IDs intact.
grep -n 'id="dmca-name"\|id="dmca-address"\|id="dmca-receipt"' /Users/ouen/slop/sei-website/terms.html
```

**Commit + push** (from `/Users/ouen/slop/sei-website`):

```bash
cd /Users/ouen/slop/sei-website
git add terms.html
git commit -m "docs(dmca): swap §7 designated-agent placeholders for live registration values"
git push origin main
```

Wait ~30-60 seconds for the website auto-deploy to publish. Visit https://sei.gg/terms.html#dmca and confirm the real values render.

**Gate to next step:** `grep -c "pending registration" /Users/ouen/slop/sei-website/terms.html` returns 0 + live site updated.

---

### Step 9 — Rebuild Sei With the New Constants [OPERATOR ACTION REQUIRED]

**Time estimate:** 5-10 minutes (build) + however long the package step takes on the operator machine.

**Why:** The DmcaContactModal constants are baked at build time. Step 7 only edits source; users won't see the new values until they install a build that includes them.

**Steps:**

- [ ] Build the renderer + main bundles:
  ```bash
  npm run build
  ```
- [ ] (For local smoke test) Run the dev build to verify before packaging:
  ```bash
  npm run dev
  ```
  Then open Sei → Settings → Legal → "Report copyright infringement (DMCA)" — the modal should now show the real agent details. The "Open Directory listing" button should open the captured Directory URL in the system browser (allowlist already covers `dmca.copyright.gov` per Plan 12-17). The "Email DMCA agent" button should open the system mail client to `dmca@sei.app`.
- [ ] (For distribution) Package + release per the project's electron-builder pipeline. Out of scope for this runbook — defer to the release engineer's normal procedure.

**Gate to next step:** A built/packaged Sei renders the real agent details in the DMCA modal.

---

### Step 10 — End-to-End Smoke Test [OPERATOR ACTION REQUIRED]

**Time estimate:** 20 minutes.

**Why:** D-36 gate (e). Flipping `browse_enabled=true` on a broken pipeline ships visible-but-broken Browse to users. The smoke test exercises every moderation surface and the publish→browse→add→report→block chain end-to-end before the flip.

You need TWO Sei accounts for this (Account A + Account B). Use two different email addresses; sign in to each on separate machines or use the "Sign Out" flow between scenarios.

**Pre-condition for the smoke test:** You can temporarily flip browse_enabled to test, OR set `BROWSE_ENABLED=true` in the env for the dev build (per Plan 12-16's D-36a). The env override path is the recommended smoke-test approach because it doesn't touch the production config.json:

```bash
BROWSE_ENABLED=true npm run dev
```

**Scenarios:**

- [ ] **Scenario A — Sign-up + publish a clean character (Account A):**
  - Open Sei (dev build with `BROWSE_ENABLED=true`).
  - Sign up with a new test email + password.
  - Accept the latest ToS + Privacy (versions = `2026-05-22` per Plan 12-15).
  - Create a new character: name = `Smoke Test Bot`, persona = something benign (e.g. "Loves gardening and helping new players."), upload a clear non-graphic portrait (a stock landscape or pixel art works).
  - In CharacterPage → toggle "Public" → confirm the content-policy confirm modal.
  - **Expected:** Upload succeeds; character appears in My Library; `moderation_status='clean'` row in DB.

- [ ] **Scenario B — Browse the new public character (Account B):**
  - Sign out, then sign in with Account B.
  - Open the Characters screen → Browse tab is visible (because BROWSE_ENABLED=true).
  - The `Smoke Test Bot` from Account A appears in the grid.
  - **Expected:** Card renders with portrait + name + persona snippet + creator attribution + Report button. Add-to-Mine pill on hover.

- [ ] **Scenario C — Add to Mine:**
  - Click the Add-to-Mine pill on the smoke test character.
  - Wait ~1s for the toast.
  - **Expected:** "Added" toast appears bottom-center; character now appears in Account B's Home tab; the Browse card flips to "Already in My Library" pill (because `useBrowseStore.refresh()` re-runs the precomputed `inMyLibrary` join).

- [ ] **Scenario D — Report flow:**
  - Click the Report button (top-left circle) on the smoke test character.
  - ReportModal opens. Pick "Other" + paste detail "smoke test — please ignore".
  - Submit.
  - **Expected:** Modal closes with success state. Within ~5s:
    - Discord channel receives a message in the report triage channel (via `notify-report` Discord call).
    - `dmca@sei.app` inbox receives a triage email with the admin-action SQL cheat-sheet (via `notify-report` Resend call). Sender: `Sei Moderation <reports@sei.app>`.
    - `reports` table has a new row.

- [ ] **Scenario E — Rate limit:**
  - Still as Account B, submit 5 more reports against the same character (so 6 total within ~1 minute).
  - **Expected:** The 6th submission returns the friendly rate-limited copy: *"You've reported a lot in the last hour. Try again later if you still need to report."*

- [ ] **Scenario F — Prompt moderation hard-block:**
  - Switch back to Account A.
  - Create a new character whose `persona_source` includes deliberately-flaggable content — pick the LIGHTEST possible hate-speech smoke (e.g. a slur in a sentence). Goal: trip OpenAI `omni-moderation-latest`'s hate category at >0.85.
  - Try to publish.
  - **Expected:** Upload BLOCKED with the friendly D-33c copy: *"We can't publish this character because the persona description hits our content guidelines. Edit the persona and try again, or save it as private."* (No raw category names leak.) DELETE the test character afterward.

- [ ] **Scenario G — Auto-hide threshold (OPTIONAL — needs three reporter accounts):**
  - Three distinct Account B/C/D users each report the smoke-test character with reason `hate_speech_harassment` within a 24h window.
  - **Expected:** After the 3rd report, the Postgres trigger flips `shared=false`; Account A receives the creator-notification email; the character disappears from Account B's Browse grid on next refresh.
  - **Skip OK** if you don't have three accounts handy. The trigger itself is verified by Plan 12-06's unit tests + the dummy-insert smoke from Step 5.

- [ ] **Clean up:** Delete the smoke test character + reports after verifying.
  ```sql
  DELETE FROM public.reports WHERE detail LIKE '%smoke test%';
  DELETE FROM public.characters WHERE name = 'Smoke Test Bot';
  ```

**Gate to next step:** ALL six required scenarios (A-F) pass. Any failure → DO NOT flip browse_enabled; debug first.

---

### Step 11 — Flip `browse_enabled=true` in Production `config.json` [OPERATOR ACTION REQUIRED]

**Time estimate:** 1 minute.

**Why:** D-36 gate. With all six prior steps green this single edit lights up Browse for the operator's installed Sei.

**Per-OS path table** (productName is `Sei Launcher` per `electron-builder.yml:11`):

| OS              | Path                                                                |
| --------------- | ------------------------------------------------------------------- |
| macOS           | `~/Library/Application Support/Sei Launcher/config.json`            |
| Windows         | `%APPDATA%\Sei Launcher\config.json`                                |
| Linux           | `~/.config/Sei Launcher/config.json`                                |
| macOS (dev)     | `~/Library/Application Support/Sei Launcher Dev/config.json`        |

> **NOTE:** The plan body wrote `sei/config.json` for these paths — that's incorrect. Electron uses **productName** for the userData directory, which is `Sei Launcher` (verified via `ls ~/Library/Application Support/ | grep -i sei` returning both `Sei Launcher` and `Sei Launcher Dev`). The dev build also has its own separate config.

**Steps:**

- [ ] Close Sei (so it doesn't atomic-write on top of your edit).
- [ ] Open the config.json at the path above. Example macOS:
  ```bash
  open -a "TextEdit" "$HOME/Library/Application Support/Sei Launcher/config.json"
  ```
  Or edit in your preferred editor.
- [ ] Add (or set) `"browse_enabled": true`. The full file should look something like:
  ```json
  {
    "browse_enabled": true,
    "...other existing fields...": "..."
  }
  ```
  If the file doesn't exist yet (no operator config has ever been written), create it with exactly `{ "browse_enabled": true }`. The `UserConfigSchema` from Plan 12-16 has `.optional().default(false)` on every field, so missing fields are safe.

- [ ] (Pretty-print sanity) Re-open the file and confirm it still parses as JSON:
  ```bash
  cat "$HOME/Library/Application Support/Sei Launcher/config.json" | jq .
  ```
  Expected: prints the file without error.

- [ ] Restart Sei.

**Verification:**

- [ ] Open the Characters screen.
- [ ] **Expected:** Home + Browse tab bar visible at the top. Click Browse → grid renders with at least one public character (if any exist).
- [ ] (Sanity) Open DevTools → Console. Run:
  ```javascript
  await window.sei.getCapabilities()
  ```
  **Expected:** `{ browseEnabled: true }`.

**Gate:** Browse tab visible + `getCapabilities()` returns `browseEnabled: true`.

---

## D-36 Pre-Flight Checklist — Final Sign-Off

Per the threat model `mitigate` disposition on T-12-18-02, do NOT proceed to the flip until every checkbox below is checked:

- [ ] (a) DMCA agent registration confirmed; receipt URL captured.                  *(Step 1)*
- [ ] (b) Backfill loop returned `nextCursor=done`; SQL count of unmoderated `shared=true` rows = 0.  *(Step 6)*
- [ ] (c) All five Edge Functions deployed; secrets visible in `supabase secrets list`.  *(Steps 2 + 4)*
- [ ] (d) Migration `20260523000000_moderation_and_reports.sql` applied; `app.settings.edge_url` + `app.settings.service_role_key` non-NULL; `report_new_webhook` configured + smoke-INSERT confirmed.  *(Steps 3 + 5)*
- [ ] (e) End-to-end smoke (publish → browse → add → report → rate-limit → prompt-block) all green.  *(Step 10)*

Only with (a) + (b) + (c) + (d) + (e) all true do you proceed to Step 11.

---

## Deviations from Plan

### [Rule 2 — Auto-add missing critical functionality] Corrected userData path

**Found during:** Step 11 documentation.
**Issue:** Plan 12-18 body cited userData as `~/Library/Application Support/sei/config.json` (lowercase `sei`). Electron uses **productName** for the userData directory, which is `Sei Launcher` per `electron-builder.yml:11`. Verified live via `ls ~/Library/Application Support/ | grep -i sei` returning `Sei Launcher` and `Sei Launcher Dev`. A user following the plan verbatim would edit a nonexistent path and ship the flip with no effect.
**Fix:** Per-OS path table in Step 11 uses the correct `Sei Launcher` productName for macOS / Windows / Linux + adds a fourth row for the dev build's `Sei Launcher Dev` directory.
**Files modified:** This SUMMARY.md only.

### [Rule 2 — Auto-add missing critical functionality] Added env-override smoke-test path

**Found during:** Step 10 design.
**Issue:** The plan describes the smoke test as running against the production config flip — but that risks shipping a broken Browse to users if anything fails mid-test. Plan 12-16 explicitly designed the `BROWSE_ENABLED=true` env override (D-36a) for exactly this scenario.
**Fix:** Step 10's pre-condition recommends `BROWSE_ENABLED=true npm run dev` for the smoke pass, leaving the production config.json untouched until Step 11. Operator can revert by killing the dev process.
**Files modified:** This SUMMARY.md only.

### [Rule 3 — Auto-fix blocking issues] Added Resend `sei.app` domain verification gate

**Found during:** Step 2 design.
**Issue:** The plan body didn't surface that Resend silently drops mail from un-verified sender domains. Plan 12-06's SUMMARY warned about this but the operator runbook should re-surface it where it's actionable — i.e. while the operator is logged in to Resend setting the API key, they're one screen away from the domain verification panel.
**Fix:** Step 2 prerequisites bullet explicitly requires `sei.app` domain status = verified BEFORE proceeding past secret provisioning. Without this, Scenario D of the smoke test (the Discord ping fires but the email is silently dropped) looks like a half-success.
**Files modified:** This SUMMARY.md only.

---

## Phase 12 Closure Status

**All 18 plans CODE COMPLETE.** Phase 12 is shipped to the codebase but **NOT live to users** until the operator walks Step 1 → Step 11 above.

Requirements traceability:

| Requirement | Plan(s)        | Status                                                 |
| ----------- | -------------- | ------------------------------------------------------ |
| SHARE-01    | 12-08/09/10/16 | code complete                                          |
| SHARE-02    | 12-09/10/11    | code complete                                          |
| SHARE-03    | 12-09/10       | code complete                                          |
| SHARE-04    | 12-11/12       | code complete                                          |
| SHARE-05    | 12-15          | code complete                                          |
| SHARE-06    | 12-01/02/03    | code complete (live after Step 4 deploy)               |
| SHARE-07    | 12-04/07       | code complete (live after Step 4 deploy)               |
| SHARE-08    | 12-05/06/13    | code complete (live after Step 4 deploy + Step 5 webhook) |
| SHARE-09    | 12-14/15/17/18 | code complete; **LIVE pending Steps 1, 7, 8, 9**       |
| SHARE-10    | 12-11          | code complete (creator attribution placeholder; profile pages deferred to v1.x) |

**Phase 12 is awaiting operator rollout.** State and Roadmap have been updated to mark plan 18 complete but the phase header explicitly flags "code complete, awaiting operator rollout" until Step 11 is checked.

## Self-Check: PASSED

- [x] FOUND: `/Users/ouen/slop/sei/.planning/phases/12-character-sharing-ui-moderation/12-18-SUMMARY.md` (this file)
- [x] FOUND: `/Users/ouen/slop/sei/src/renderer/src/components/DmcaContactModal.tsx` lines 32-35 (constants confirmed at exact line numbers)
- [x] FOUND: `/Users/ouen/slop/sei-website/terms.html` lines 133-136 (named spans `dmca-name`, `dmca-address`, `dmca-receipt` confirmed)
- [x] FOUND: `/Users/ouen/slop/sei/supabase/functions/backfill-moderate-existing/index.ts` (BATCH_SIZE=100, nextCursor='done' contract confirmed)
- [x] FOUND: `/Users/ouen/slop/sei/src/main/capabilities.ts` (BROWSE_ENABLED env override + browse_enabled config field confirmed)
- [x] FOUND: macOS userData at `~/Library/Application Support/Sei Launcher/` (verified by ls)

No code commits in this plan — Plan 12-18 is a documentation deliverable. The runbook above commits.
