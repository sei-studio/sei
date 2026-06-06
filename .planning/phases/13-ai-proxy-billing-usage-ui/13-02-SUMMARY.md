---
phase: 13-ai-proxy-billing-usage-ui
plan: 02
subsystem: ipc
tags: [ipc, zod, contract, apiKeyStore, configStore, preload, aiBackendKind, credits, trial, subscription, lemonSqueezy]

# Dependency graph
requires:
  - phase: 11-cloud-character-library
    provides: contextBridge preload + IpcChannel three-layer convention
  - phase: 12-character-sharing-ui-moderation
    provides: lazy-import discipline inside ipcMain handlers + Zod arg validation pattern
provides:
  - aiBackendKind ('local' | 'cloud-proxy') persisted in UserConfig — single source of truth for credits-UI visibility (D-57)
  - safeStorageBackendKind() renamed from backendKind() to clarify it answers OS keychain (api-key.bin) — not the AI backend question
  - Six new ipcMain.handle channels (proxy.configure / trial.claim / credits.get / credits.openCheckout / subscription.status / subscription.cancel) with Zod-validated stub returns matching the typed contract
  - Two push channels (credits:status:update, credits:hard-stop) wired in preload + helper emitters (emitCreditsStatusUpdate, emitCreditsHardStop) exported from main/ipc.ts for Wave 2 anthropicClient interceptor
  - Eight new RendererApi methods + CreditsStatus + SubscriptionStatusInfo + CreditsHardStopEvent domain types + REMAINING_PCT_ROUND_STEP=5 const
affects: [13-04-trial-claim, 13-05-credits-get, 13-06-checkout, 13-07-lemon-webhook, 13-08-proxy-server, 13-13-pricing-icon, 13-14-credits-screen, 13-15-hard-stop-modal, 13-16-settings-row]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Phase 13 stub-contract pattern — register the channel + Zod schema today, lazy-import Wave 3 implementation tomorrow without changing the channel name or argument shape"
    - "Push-emitter export pair (emitCreditsStatusUpdate / emitCreditsHardStop) lives in main/ipc.ts and walks BrowserWindow.getAllWindows() — mirrors the syncQueue.statusUpdate broadcaster pattern from Phase 11"

key-files:
  created: []
  modified:
    - src/main/apiKeyStore.ts
    - src/main/configStore.ts
    - src/shared/characterSchema.ts
    - src/shared/ipc.ts
    - src/main/ipc.ts
    - src/preload/index.ts
    - src/main/index.ts
    - src/main/auth/sessionStore.ts
    - src/renderer/src/App.tsx
    - src/renderer/src/screens/OnboardingScreen.tsx

key-decisions:
  - "13-02: ai_backend_kind lives in UserConfigSchema (src/shared/characterSchema.ts) — the canonical project-wide UserConfig schema source — not in src/main/configStore.ts (plan's stated path) because configStore.ts is a persistence module that imports the schema, not a schema owner. Added a JSDoc breadcrumb in configStore.ts pointing readers at characterSchema.ts."
  - "13-02: PATTERNS Option A taken cleanly — backendKind() renamed to safeStorageBackendKind() across 4 call sites (src/main/index.ts boot warning, src/main/ipc.ts app:warnings handler, two doc comments). New AiBackendKind type + getAiBackendKind / setAiBackendKind helpers persist via the existing configStore writeConfig flow — no new persistence layer (D-57)."
  - "13-02: AiBackendKind type defaults to 'local' so existing users see zero behavior change; the credits UI surface stays dark for BYOK users (PROXY-11). Zod schema declared as `.optional().default('local')` mirroring the browse_enabled forward-compat pattern from 12-16."
  - "13-02: Stub-handler placeholders return shapes that match TypeScript types exactly — credits.get returns `{remaining_pct:100, plan:'trial', renews_at:null, trial_claimed:false, ai_backend_kind:<real>}` so renderer plans 13-13/14/15 can develop against a real value for ai_backend_kind (the only field that's wired today) while Wave 3 swaps the rest."
  - "13-02: proxy.configure is FULLY wired (not stubbed) because flipping aiBackendKind is the only action that unlocks the credits UI surface. Wave 3 only adds a signed-in guard. Other handlers (trial/credits/subscription) return placeholder shapes."
  - "13-02: Push helpers exported as module-level functions, not class members — emitCreditsStatusUpdate(status) + emitCreditsHardStop(info) walk BrowserWindow.getAllWindows() with isDestroyed() guards. Wave 2 anthropicClient.js will import these for the X-Sei-Remaining-Pct response-header interceptor (D-41) and the 402/503 branches (D-51)."
  - "13-02: TrialClaimArgsSchema regex `^[A-Za-z0-9_]{1,16}$` matches Mojang username rules verbatim — same predicate as CharacterSchema.username refinement (D-42). Edge Function re-validates server-side (T-13-02-01 defense-in-depth)."

patterns-established:
  - "Stub-contract: register channels + Zod + RendererApi today, swap implementation tomorrow"
  - "Push emitter pair exported from main/ipc.ts walks BrowserWindow.getAllWindows() with destroyed-window guards"
  - "AI backend kind is the SINGLE source of truth for credits-UI visibility — every UI gate reads from a renderer-store value that shadows apiKeyStore.getAiBackendKind() (D-57)"

requirements-completed: [PROXY-11]

# Metrics
duration: 7min
completed: 2026-05-22
---

# Phase 13 Plan 02: IPC Contract Stub Surface Summary

**Five new IPC channel groups (proxy/trial/credits/subscription) + two push channels stubbed across all three IPC layers; aiBackendKind persistence wired end-to-end as the D-57 single source of truth for credits-UI visibility.**

## Performance

- **Duration:** 7 min
- **Started:** 2026-05-22T21:02:53Z
- **Completed:** 2026-05-22T21:09:25Z
- **Tasks:** 3
- **Files modified:** 10

## Accomplishments

- Renamed `apiKeyStore.backendKind()` → `safeStorageBackendKind()` and updated all four production call sites + two doc comments (PATTERNS Option A clean-cut, no compatibility shim per CLAUDE.md "no backwards-compat hacks").
- Added the `AiBackendKind` type plus `getAiBackendKind()` / `setAiBackendKind()` reading/writing `UserConfig.ai_backend_kind` via the existing `configStore` (no new persistence layer).
- Extended `UserConfigSchema` (in `src/shared/characterSchema.ts`) with the `ai_backend_kind` enum field — `.optional().default('local')` so existing config.json files round-trip and existing users see zero behavior change.
- Added six new `IpcChannel` entries (`proxy.configure`, `trial.claim`, `credits.get`, `credits.openCheckout`, `subscription.status`, `subscription.cancel`) plus two push channels (`credits:status:update`, `credits:hard-stop`); extended `IpcChannelName` discriminated union accordingly.
- Added three Zod schemas at the trust boundary (`ProxyConfigureArgsSchema`, `TrialClaimArgsSchema`, `CreditsCheckoutArgsSchema`) — `mc_username` regex verbatim matches Mojang rules used by `CharacterSchema.username` (D-42 single canonical predicate).
- Added `CreditsStatus`, `SubscriptionStatusInfo`, `CreditsHardStopEvent` domain types and the `REMAINING_PCT_ROUND_STEP = 5` const (D-41 % bar alignment).
- Added eight new `RendererApi` methods (six request/response + two push subscriptions) with full JSDoc for renderer-side consumers.
- Stub-registered six `ipcMain.handle` handlers in `src/main/ipc.ts`; `proxy.configure` is the only one fully wired (calls `setAiBackendKind`) because flipping the backend kind is what unlocks the credits UI surface; the other five return Zod-validated placeholder shapes that match the typed return contract.
- Exported `emitCreditsStatusUpdate(status)` and `emitCreditsHardStop(info)` from `src/main/ipc.ts` — module-level helpers that walk `BrowserWindow.getAllWindows()` with `isDestroyed()` guards, ready for Wave 2's `anthropicClient` interceptor to call without touching `ipc.ts` again.
- Bound all six request/response methods and both push subscriptions in `src/preload/index.ts` inside the existing `contextBridge.exposeInMainWorld('sei', api)` shape.

## Task Commits

Each task was committed atomically:

1. **Task 1: Extend apiKeyStore + configStore with aiBackendKind** — `697aa43` (feat)
2. **Task 2: Add IpcChannel namespaces, Zod schemas, RendererApi entries** — `59b4747` (feat)
3. **Task 3: Stub main/ipc.ts handlers + preload bindings** — `f4633ab` (feat)

## Files Created/Modified

- `src/main/apiKeyStore.ts` (modified) — renamed `backendKind()` → `safeStorageBackendKind()`; added `AiBackendKind` type + `getAiBackendKind()` + `setAiBackendKind()` reading/writing `UserConfig.ai_backend_kind` via configStore.
- `src/main/configStore.ts` (modified) — added JSDoc breadcrumb pointing at the schema source in `src/shared/characterSchema.ts` (the schema itself isn't owned here; only persistence behavior is).
- `src/shared/characterSchema.ts` (modified) — added `ai_backend_kind: z.enum(['local', 'cloud-proxy']).optional().default('local')` to `UserConfigSchema`.
- `src/shared/ipc.ts` (modified) — added Phase 13 domain types (`CreditsStatus`, `SubscriptionStatusInfo`, `CreditsHardStopEvent`), `REMAINING_PCT_ROUND_STEP` const, three Zod schemas, eight `RendererApi` methods, four new `IpcChannel` namespaces (`proxy`/`trial`/`credits`/`subscription`), and extended `IpcChannelName` union.
- `src/main/ipc.ts` (modified) — six new `ipcMain.handle` stubs with Zod arg parsing; `emitCreditsStatusUpdate` + `emitCreditsHardStop` exported push helpers.
- `src/preload/index.ts` (modified) — six new `ipcRenderer.invoke` bindings + two `ipcRenderer.on` push subscriptions with returned unsubscribe fns.
- `src/main/index.ts` (modified) — updated boot-time Linux fallback warning to use renamed `safeStorageBackendKind()`.
- `src/main/auth/sessionStore.ts` (modified) — doc comment updated to reference renamed `safeStorageBackendKind()`.
- `src/renderer/src/App.tsx` (modified) — doc comment updated to reference renamed `safeStorageBackendKind()`.
- `src/renderer/src/screens/OnboardingScreen.tsx` (modified) — UserConfig object literal at the onboarding submit site now sets `ai_backend_kind: 'local'` (Rule-2 auto-fix; see Deviations).

## Decisions Made

- **Schema home for `ai_backend_kind`:** The plan instructed adding the field to `src/main/configStore.ts`. The actual project shape is that `UserConfigSchema` lives in `src/shared/characterSchema.ts` and `configStore.ts` is a thin persistence wrapper. Added the field to the canonical schema source and left a JSDoc breadcrumb in `configStore.ts`. (Rule 3 — Schema source location is a project-level invariant; the plan's path was a sketch.)
- **`safeStorageBackendKind()` rename surface:** Three production call sites updated (`src/main/ipc.ts` app:warnings handler, `src/main/index.ts` boot warning, both imports). Two doc-comment references (`src/main/auth/sessionStore.ts`, `src/renderer/src/App.tsx`) updated for accuracy. The build-artifact `src/renderer/src/App.js` is git-ignored and was not touched (it regenerates from `App.tsx`).
- **`proxy.configure` wired today, others stubbed:** This is the only one of the six new handlers that flips real state. It writes `ai_backend_kind` through `setAiBackendKind` directly — Wave 3 only needs to wrap a "must be signed in for `'cloud-proxy'`" guard around the existing body. The other five handlers return Zod-validated placeholder shapes whose runtime values land in Wave 3.
- **Push helpers as module-level exports (not class methods):** `emitCreditsStatusUpdate(status)` / `emitCreditsHardStop(info)` live at the bottom of `src/main/ipc.ts` walking `BrowserWindow.getAllWindows()`. Wave 2's `src/bot/llm/anthropicClient.js` will `import` these directly for the response-header / 402 / 503 paths; the renderer broadcast does NOT need a per-window subscriber registry because there is one renderer window in v1.0 (the same simplification the Phase 11 sync.statusUpdate broadcaster relies on).
- **Stub-handler return shapes are TypeScript-exact:** Every return literal type-checks against the `RendererApi` return type. `credits.get` returns `{remaining_pct:100, plan:'trial', renews_at:null, trial_claimed:false, ai_backend_kind:<real>}` so renderer dev sees a "clean trial" state during local dev while the `ai_backend_kind` field is the one signal the renderer should already gate the credits UI on (D-57).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Schema field added to `src/shared/characterSchema.ts`, not `src/main/configStore.ts`**
- **Found during:** Task 1
- **Issue:** Plan said "In `src/main/configStore.ts`: Add the `ai_backend_kind?` field to the UserConfig type / Zod schema." But `UserConfigSchema` lives in `src/shared/characterSchema.ts` (the project-wide canonical schema source); `configStore.ts` imports it as `UserConfigSchema`. Adding the field to `configStore.ts` would require duplicating the schema or splitting ownership.
- **Fix:** Added the field to `characterSchema.ts` next to the existing `browse_enabled` field (same `.optional().default(...)` forward-compat pattern). Added a JSDoc breadcrumb in `configStore.ts` so future readers find the schema by following the `// Phase 13 13-02 (D-57): UserConfigSchema ... now carries ai_backend_kind` block.
- **Files modified:** `src/shared/characterSchema.ts`, `src/main/configStore.ts`
- **Verification:** `npx tsc --noEmit -p tsconfig.web.json` and `tsconfig.node.json` both pass for this scope; `UserConfig` type at every call site (e.g. `loadConfig().then(c => c.ai_backend_kind)`) resolves correctly.
- **Committed in:** `697aa43` (Task 1 commit)

**2. [Rule 1 - Bug] Onboarding submit literal failed type-check after schema change**
- **Found during:** Task 1 verification
- **Issue:** `src/renderer/src/screens/OnboardingScreen.tsx` constructs a `UserConfig` object literal at the wizard's "Save" step. After adding `ai_backend_kind` to the schema as `.optional().default('local')`, Zod's INPUT type stays optional but the OUTPUT type (the inferred `UserConfig`) becomes required — so the existing literal failed `tsc` with `Property 'ai_backend_kind' is missing`.
- **Fix:** Added `ai_backend_kind: 'local'` to the onboarding literal alongside `browse_enabled: false`, matching the same defensive-explicit pattern Plan 12-16 used when introducing `browse_enabled`.
- **Files modified:** `src/renderer/src/screens/OnboardingScreen.tsx`
- **Verification:** `npx tsc --noEmit -p tsconfig.web.json` now clean.
- **Committed in:** `697aa43` (Task 1 commit)

**3. [Rule 3 - Blocking] Plan verification uses `tsconfig.main.json` which does not exist**
- **Found during:** Task 1 verification block
- **Issue:** The plan's `<verify>` and `<verification>` blocks reference `tsconfig.main.json`. The project actually uses `tsconfig.node.json` (covers main + preload + shared) per the root `tsconfig.json` references; there is no `tsconfig.main.json` file.
- **Fix:** Ran type-checks against the real config names (`tsconfig.web.json` for renderer, `tsconfig.node.json` for main/preload/shared). Per SCOPE BOUNDARY, leaving the plan's typo intact (won't affect future readers — they'll discover the typo same way I did).
- **Files modified:** None (verification command substitution only).
- **Verification:** Two pre-existing errors in `src/main/auth/loopbackPkce.ts` and `src/main/auth/supabaseClient.test.ts` remain — both unchanged across this plan (noted as pre-existing in 12-08-SUMMARY and unchanged across 12-09/10/14 too).
- **Committed in:** N/A (process-only deviation)

**4. [Rule 1 - Bug] `subscription.status` handler multi-line form undercounted the plan's verification regex**
- **Found during:** Task 3 verification
- **Issue:** The plan's verification regex `ipcMain.handle\(IpcChannel\.(proxy|trial|credits|subscription)` requires the channel constant on the same line as `ipcMain.handle(`. I had wrapped the `subscription.status` registration onto two lines for readability, dropping the visible count from 6 to 5.
- **Fix:** Reformatted the `subscription.status` registration onto a single line. All six handlers now match the regex; the code itself was functionally complete either way.
- **Files modified:** `src/main/ipc.ts`
- **Verification:** `grep -cE "ipcMain.handle\(IpcChannel\.(proxy|trial|credits|subscription)" src/main/ipc.ts` → 6.
- **Committed in:** `f4633ab` (Task 3 commit, before commit)

---

**Total deviations:** 4 auto-fixed (1 schema-location, 1 follow-on type error, 1 stale verification path, 1 regex-cosmetic).
**Impact on plan:** None on contract surface or behavior. Two of the four (#1, #2) reflect the plan's `configStore.ts` sketch being slightly out of step with where `UserConfigSchema` actually lives; the cascade was a single-line fix in OnboardingScreen. #3 and #4 are cosmetic (tsconfig name + regex formatting). No scope creep.

## Issues Encountered

- Pre-existing main-side type errors in `src/main/auth/loopbackPkce.ts:83` (`flowType` not in `SignInWithOAuthOptions`) and `src/main/auth/supabaseClient.test.ts:19` (spread-arg shape mismatch). Both noted in 12-08-SUMMARY as pre-existing and unchanged by this plan — out of scope per SCOPE BOUNDARY.
- Pre-existing Vitest mis-pickup of the Deno-only `supabase/functions/submit-report/index.test.ts` file. Noted in 12-09 / 12-10 / 12-14 summaries — out of scope, unchanged.
- An untracked `13-03-SUMMARY.md` appeared in `.planning/phases/13-ai-proxy-billing-usage-ui/` during execution (a parallel agent on Wave 1). Not touched by this plan.

## Threat Surface Scan

No new threat surface beyond what the plan's `<threat_model>` covers. All four declared mitigations (T-13-02-01..04) are honoured:

- **T-13-02-01 (Tampering, `trial.claim` mc_username):** `TrialClaimArgsSchema` enforces `^[A-Za-z0-9_]{1,16}$` at the IPC boundary. Edge Function will re-validate server-side in Wave 3.
- **T-13-02-02 (Tampering, `credits.openCheckout` kind):** `CreditsCheckoutArgsSchema` is `z.enum(['pack','subscription'])`; any other value 400s before the lazy import.
- **T-13-02-03 (Spoofing, renderer claims backend kind):** `ProxyConfigureArgsSchema.kind` is `z.enum(['local','cloud-proxy'])`; persistence goes through `setAiBackendKind` which round-trips through `UserConfigSchema.parse` again.
- **T-13-02-04 (Information Disclosure, placeholder creditsGet returns plan='trial' to BYOK users):** Accepted at the plan level — stub state. The renderer SHOULD gate the credits UI on `ai_backend_kind === 'cloud-proxy'` (D-57) regardless; the `plan` field's stub value is irrelevant when the UI is dark for BYOK users.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- All Wave 3 renderer plans (13-13 PricingIcon, 13-14 CreditsScreen, 13-15 HardStopModal, 13-16 Settings row) can now build against the finished IPC contract; their JSDoc-typed return shapes are stable across Wave 2 backend wiring.
- Wave 2 plans (13-04 trial-claim Edge Function, 13-05 credits.get proxy wiring, 13-06 checkout URL composer, 13-07 lemon-webhook Edge Function, 13-08 proxy server) need only swap each lazy import — the channel surface stays unchanged.
- The Wave 2 `anthropicClient` X-Sei-Remaining-Pct interceptor has its push surface ready: `import { emitCreditsStatusUpdate, emitCreditsHardStop } from '../../main/ipc.ts'` (or a re-export) gives it the fan-out without touching this file.
- aiBackendKind is the live D-57 single-source-of-truth; renderer stores can now subscribe to its value via `creditsGet()` and gate the credits UI surface accordingly.

## Self-Check: PASSED

- File `src/main/apiKeyStore.ts` FOUND (modified)
- File `src/shared/characterSchema.ts` FOUND (modified)
- File `src/shared/ipc.ts` FOUND (modified)
- File `src/main/ipc.ts` FOUND (modified)
- File `src/preload/index.ts` FOUND (modified)
- File `src/main/configStore.ts` FOUND (modified)
- File `src/main/index.ts` FOUND (modified)
- File `src/main/auth/sessionStore.ts` FOUND (modified)
- File `src/renderer/src/App.tsx` FOUND (modified)
- File `src/renderer/src/screens/OnboardingScreen.tsx` FOUND (modified)
- Commit `697aa43` FOUND (Task 1)
- Commit `59b4747` FOUND (Task 2)
- Commit `f4633ab` FOUND (Task 3)

---
*Phase: 13-ai-proxy-billing-usage-ui*
*Completed: 2026-05-22*
