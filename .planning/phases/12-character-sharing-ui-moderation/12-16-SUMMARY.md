---
phase: 12-character-sharing-ui-moderation
plan: 16
subsystem: capabilities-feature-flags
tags: [main, config, feature-flag, capabilities, browse-enabled, boot-time]

# Dependency graph
requires:
  - phase: 12-character-sharing-ui-moderation
    plan: 08
    provides: "capabilities:get IPC channel + RendererApi.getCapabilities() + minimal process.env-only handler stub waiting for this plan to replace"
provides:
  - "src/main/capabilities.ts — readCapabilities() composing process.env.BROWSE_ENABLED (D-36a dev override) and <userData>/config.json browse_enabled (D-36 production flag)"
  - "DEFAULT_CAPABILITIES = { browseEnabled: false } exported sentinel for fail-safe fallback (T-12-16-03)"
  - "UserConfigSchema.browse_enabled — z.boolean().optional().default(false) — backward-compatible config.json extension"
  - "Replacement IPC handler body for capabilities:get that delegates to readCapabilities() via lazy import"
affects: [12-17-browse-enabled-gate, future-CharactersScreen-tab-visibility]

# Tech tracking
tech-stack:
  added: []  # Reuses existing Zod + loadConfig + paths
  patterns:
    - "Boot-time one-shot capability reader composed from env + config.json with explicit OR precedence (env wins)"
    - "Delegate config.json parse to existing loadConfig() helper rather than duplicating readFile+JSON.parse+Zod (DRY; same ENOENT-safe + UserConfigSchema-validated path)"
    - "try/catch fail-safe to DEFAULT_CAPABILITIES on any error other than the well-tested ENOENT path (mitigates T-12-16-03 corrupted-config disclosure)"
    - "Lazy import inside the ipcMain.handle closure to keep module init acyclic with configStore.ts → characterSchema.ts"
    - "Zod `.optional().default(false)` for new UserConfig fields — backward-compatible with configs predating the field"
    - "Schema-driven config object literals in renderers — when a Zod field with `.default()` is added, all object-literal call sites of saveConfig must add the field explicitly because z.infer produces a non-optional output type"

key-files:
  created:
    - src/main/capabilities.ts
    - src/main/capabilities.test.ts
  modified:
    - src/shared/characterSchema.ts
    - src/main/ipc.ts
    - src/renderer/src/screens/OnboardingScreen.tsx
    - .gitignore

key-decisions:
  - "Reuse loadConfig() over inlining readFile/JSON.parse/Zod. The plan body in Task 2 inlines the parse; configStore.loadConfig() already does the exact same work (ENOENT-safe, UserConfigSchema-validated, atomic-aware via shared paths.configPath()). Inlining duplicates 20 lines of error-handling for zero behavioral gain. Documented inline in capabilities.ts JSDoc."
  - "Env override wins over config file. process.env.BROWSE_ENABLED === 'true' short-circuits BEFORE the config read — a developer with the env set never depends on having a valid config.json. This is also marginally faster (skip an fs read in dev) and makes the test matrix cleaner (env tests don't need to write config.json)."
  - "Strict env match. Only the literal string 'true' triggers the override; 'false', '1', '', undefined all fall through to config. Validated by a dedicated test (`BROWSE_ENABLED=false` does NOT force false). This matches the established Node convention and prevents accidents like a stale env from an unrelated shell session."
  - "Fail-safe on corrupted config. T-12-16-03 in the plan's threat register specified `mitigate` — and the chosen mitigation is a single try/catch around loadConfig() returning DEFAULT_CAPABILITIES rather than letting the IPC handler throw. The renderer's CharactersScreen would otherwise crash silently when getCapabilities() rejects."
  - "Plan body referenced `readFile` from node:fs/promises and direct UserConfigSchema.parse — implemented behaviorally identical via loadConfig() instead. The grep gate (`grep -c readCapabilities|DEFAULT_CAPABILITIES|browse_enabled|BROWSE_ENABLED`) returns 12 (plan asserted >= 4); all keywords present."

patterns-established:
  - "Feature-flag module pattern: boot-time one-shot read composed from (env var dev override) OR (config.json field) with explicit precedence + try/catch fail-safe. Future flags (e.g. PROXY_ENABLED in Phase 13) follow this exact shape — extend Capabilities interface + add a second OR branch."
  - "Backward-compatible Zod schema extension: any new UserConfig field is `.optional().default(<safe>)` so existing config.json files parse cleanly through loadConfig() without a migration. New saveConfig call sites must pass the field explicitly (or spread an existing UserConfig)."

requirements-completed: [SHARE-01]

# Metrics
duration: ~3min
completed: 2026-05-22
---

# Phase 12 Plan 16: Capabilities Module (BROWSE_ENABLED feature flag) Summary

**Ships the boot-time feature-flag plumbing: capabilities.ts composes process.env.BROWSE_ENABLED (dev override per D-36a) OR <userData>/config.json browse_enabled (operator flips post-checklist per D-36) into a single resolved boolean. Replaces 12-08's minimal env-only stub and adds the matching UserConfigSchema field. CharactersScreen (12-10/12-17) consumes the resolved value via window.sei.getCapabilities() — the IPC channel from 12-08 is unchanged.**

## Performance

- **Duration:** ~3 min
- **Tasks:** 2 (plus IPC handler rewire that the user prompt specified)
- **Files created:** 2 (`src/main/capabilities.ts`, `src/main/capabilities.test.ts`)
- **Files modified:** 4 (`src/shared/characterSchema.ts`, `src/main/ipc.ts`, `src/renderer/src/screens/OnboardingScreen.tsx`, `.gitignore`)
- **Tests:** 10/10 pass in `capabilities.test.ts` (full verification matrix + 2 backward-compat + 2 fail-safe paths); no pre-existing tests regressed (verified `moderationGate.test.ts` 8/8 still pass).

## Accomplishments

### `src/main/capabilities.ts` — the module

Exports:

```typescript
export interface Capabilities { browseEnabled: boolean }
export const DEFAULT_CAPABILITIES: Capabilities = { browseEnabled: false };
export async function readCapabilities(): Promise<Capabilities>
```

Resolution order (top-to-bottom, first match wins):

1. **`process.env.BROWSE_ENABLED === 'true'`** → `{ browseEnabled: true }`. Strict string match — only the literal `'true'` activates the override. Honored per CONTEXT D-36a (dev/local development workflow).
2. **`<userData>/config.json` `browse_enabled === true`** → `{ browseEnabled: true }`. Read via the existing `loadConfig()` helper from `configStore.ts` which handles ENOENT, atomic-write semantics, and Zod validation through `UserConfigSchema`.
3. **Otherwise** → `{ browseEnabled: false }`. Production default (D-36 operator must manually flip).

Fail-safe: any throw from `loadConfig()` (corrupted JSON, schema-incompatible legacy shape, fs errors other than ENOENT) is caught → returns `DEFAULT_CAPABILITIES`. Mitigates threat **T-12-16-03** (information disclosure on corrupted config).

### `src/shared/characterSchema.ts` — `UserConfigSchema.browse_enabled`

Added: `browse_enabled: z.boolean().optional().default(false)`. The `.optional().default(false)` shape is the same pattern `theme_mode` used when it was introduced (CONTEXT D-33) — existing `config.json` files predating this plan parse cleanly without a migration.

The resulting `z.infer<typeof UserConfigSchema>` type now includes `browse_enabled: boolean` (non-optional in the OUTPUT type because of the default). This forced one downstream fix in `OnboardingScreen.tsx` — see Deviations §1.

### `src/main/ipc.ts` — `capabilities:get` handler rewire

Old (12-08 stub):
```typescript
ipcMain.handle(IpcChannel.capabilities.get, async () => {
  const envOverride = process.env.BROWSE_ENABLED === 'true';
  return { browseEnabled: envOverride };
});
```

New:
```typescript
ipcMain.handle(IpcChannel.capabilities.get, async () => {
  const { readCapabilities } = await import('./capabilities');
  return readCapabilities();
});
```

Lazy import inside the closure (per 12-PATTERNS §IPC handlers) so module init can't form a cycle with `configStore.ts` → `characterSchema.ts`. The IPC channel string + `RendererApi` method shape from 12-08 are unchanged — no renderer-side work needed.

### `src/main/capabilities.test.ts` — 10-case verification matrix

Mirrors `migration.test.ts` harness (`vi.mock('electron')` + `_setUserDataOverride` to a `mkdtemp` scratch directory). Covers:

1. No config.json → `{ browseEnabled: false }` (production default)
2. config.json `browse_enabled: true` → `{ browseEnabled: true }`
3. config.json `browse_enabled: false` → `{ browseEnabled: false }`
4. `BROWSE_ENABLED=true` env + config `false` → `{ browseEnabled: true }` (dev override wins per D-36a)
5. `BROWSE_ENABLED=true` env without any config → `{ browseEnabled: true }`
6. `BROWSE_ENABLED=false` env + config `true` → `{ browseEnabled: true }` (strict-match — non-'true' env doesn't force override)
7. Backward-compat: legacy config.json without `browse_enabled` field → `{ browseEnabled: false }`
8. Corrupted JSON → `DEFAULT_CAPABILITIES` (T-12-16-03 fail-safe)
9. Schema-incompatible shape (e.g. `provider: 'openai'`) → `DEFAULT_CAPABILITIES`
10. `DEFAULT_CAPABILITIES` export equals `{ browseEnabled: false }`

All 10 pass.

## Task Commits

Each task committed atomically:

1. **Task 1: Extend UserConfigSchema with browse_enabled** — `efdc857` (feat)
2. **Task 2: Implement capabilities.ts + tests + IPC rewire + OnboardingScreen fix + .gitignore** — `35486e7` (feat)

The user's prompt explicitly added the IPC handler rewire (`Update the capabilities:get IPC handler in src/main/ipc.ts to call the new module`) as part of the plan scope; commit 2 bundles it with the module + tests since they're a single logical change.

## D-36 Pre-Flight Checklist (operator gate for flipping `browse_enabled: true`)

CharactersScreen (12-10) hides the Browse tab entirely while `browseEnabled === false`. The operator manually flips by either:
- Editing `<userData>/config.json` to set `"browse_enabled": true`, OR
- Setting `BROWSE_ENABLED=true` in `.env.local` (dev only — production env vars are user-managed per CONTEXT D-36a).

Production flip MUST wait until all four items pass:

1. **DMCA agent registration confirmed** — Designated Agent registered via `dmca.copyright.gov` ($6/3yr); receipt URL captured. Shipped by Plan 12-15 (Legal panel + DmcaContactModal) + Plan 12-18 (registration completion).
2. **`backfill-moderate-existing` clean** — Edge Function returns `processed: 0` (no remaining `shared=true AND moderation_status IS NULL` rows) and the human-review queue contains zero `flagged` entries. Shipped by Plan 12-03.
3. **All four moderation Edge Functions deployed:** `moderate-character-images` (12-02), `moderate-character-prompt` (12-04), `notify-report` (12-06), `submit-report` (12-05).
4. **Migrations applied:** `reports` table + `characters.moderation_status` / `moderation_provider` / `moderation_checked_at` columns (Plan 12-01).

The renderer NEVER gets an "Enable Browse" button — the deliberately friction-y manual edit is the gate. This matches CONTEXT D-36a: "Production builds ship with config defaulting to browse_enabled: false until the user manually flips it post-checklist."

## CharactersScreen consumption (already wired by 12-08 + 12-17)

The renderer-side flow already exists from prior plans:

1. Plan 12-08 added `IpcChannel.capabilities.get` + `RendererApi.getCapabilities(): Promise<{ browseEnabled: boolean }>` to the IPC contract.
2. Plan 12-08 also added the preload binding (`getCapabilities: () => ipcRenderer.invoke(IpcChannel.capabilities.get)`) inside the `api: RendererApi` object.
3. Plan 12-17 (Browse tab gate) calls `window.sei.getCapabilities()` from a `useCapabilitiesStore` and renders the tab bar only when `browseEnabled === true`.

This plan (12-16) replaces ONLY the IPC handler body. No contract change → no preload/renderer changes needed beyond the OnboardingScreen literal fix (which was driven by the schema extension, not the capabilities module itself).

## Deviations from Plan

The plan executed essentially as written, with three deviations:

### Auto-fixed Issues

**1. [Rule 3 — Blocking type error] OnboardingScreen.tsx UserConfig literal missing `browse_enabled`**

- **Found during:** Task 1 verification (`npx tsc --build`).
- **Issue:** `OnboardingScreen.tsx:102` calls `sei.saveConfig({ ... })` with an object literal. The `RendererApi.saveConfig` arg is typed as `UserConfig = z.infer<typeof UserConfigSchema>`. Adding `browse_enabled: z.boolean().optional().default(false)` to the schema means the OUTPUT type now includes `browse_enabled: boolean` (non-optional in the output because `.default()` is applied) — so any explicit object literal must include the field. Build error:
  ```
  Property 'browse_enabled' is missing in type '{ ... }' but required in type
  '{ ... browse_enabled: boolean; }'.
  ```
- **Fix:** Added `browse_enabled: false` to the OnboardingScreen literal, matching the pattern used for `linuxBasicTextWarnDismissed: false` immediately above. New onboards default to `false` (no Browse) regardless of operator state — they'll never see Browse until the operator flips the global config.
- **Files modified:** `src/renderer/src/screens/OnboardingScreen.tsx`
- **Commit:** `35486e7`

**2. [Rule 2 — Critical wiring] capabilities:get IPC handler still inlined process.env-only stub**

- **Found during:** User prompt explicitly directed this (`Update the capabilities:get IPC handler in src/main/ipc.ts to call the new module instead of inlining process.env.BROWSE_ENABLED`).
- **Issue:** Plan 12-16 as written described only the capabilities.ts module + schema extension. Without rewiring the handler, the new module would be unreachable from the renderer — 12-08's stub would still answer `capabilities:get` requests with env-only logic. The plan's success criterion #6 ("Renderer calling `window.sei.getCapabilities()` receives correct boolean (end-to-end via 12-08 handler)") implicitly requires this rewire.
- **Fix:** Replaced the handler body with `await import('./capabilities'); return readCapabilities()`. Lazy import preserves the 12-PATTERNS handler discipline (no module-init cycles). Updated the JSDoc above the handler to point at the new module.
- **Files modified:** `src/main/ipc.ts`
- **Commit:** `35486e7`

**3. [Plan refinement — DRY] Use `loadConfig()` instead of inlining `readFile + JSON.parse + UserConfigSchema.parse`**

- **Found during:** Task 2 implementation.
- **Issue:** The plan's Task 2 body inlines `readFile(paths.configPath(), 'utf-8')` + `UserConfigSchema.parse(JSON.parse(raw))`. The existing `src/main/configStore.ts:loadConfig()` already does exactly this — same path, same Zod schema, with the added bonus of ENOENT-safe behavior built in. Inlining duplicates 20 lines of error-handling logic for zero behavioral gain, and would diverge if `loadConfig()` ever grows additional defensive behavior (e.g. an atomic-write recovery path).
- **Fix:** Capabilities.ts calls `loadConfig()` inside the try/catch and reads `config.browse_enabled === true`. Behaviorally identical to the plan's example body — same file, same schema, same default. Documented the choice inline in capabilities.ts JSDoc so future readers don't see the divergence as accidental.
- **Files modified:** `src/main/capabilities.ts`
- **Commit:** `35486e7`

None of (1)–(3) is a behavior change relative to the plan's success criteria; all three keep the resolution order, the fail-safe semantics, and the exported surface identical to the spec.

## Issues Encountered

Two pre-existing TS errors observed during build, unchanged from 12-08's report:

1. `src/main/auth/loopbackPkce.ts(83,57)` — `flowType` not in Supabase auth options type. Pre-existing.
2. `src/main/auth/supabaseClient.test.ts(19,58)` — spread argument tuple type mismatch. Pre-existing.

Per SCOPE BOUNDARY, both pre-date this plan. Not introduced; not addressed.

## Threat Surface — Re-verify Against 12-16-PLAN `<threat_model>`

Plan listed 3 STRIDE threats. Implementation status:

| Threat ID  | Disposition | Implemented as                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-12-16-01 | accept      | User editing `<userData>/config.json` to set `browse_enabled: true` before the D-36 checklist passes is the operator's call. The Browse RPC + moderation backend are enforced server-side regardless of the renderer's tab visibility — worst case the operator sees a partially-moderated Browse listing during the backfill window. The capabilities module is the renderer-side gate, not the security boundary.                                                                                                                          |
| T-12-16-02 | accept      | `BROWSE_ENABLED=true` env set in production is a user-managed `.env.local` (or shell) concern. Documented in the JSDoc.                                                                                                                                                                                                                                                                                                                                                                                                            |
| T-12-16-03 | mitigate    | `try { const config = await loadConfig(); ... } catch { return DEFAULT_CAPABILITIES; }` returns the fail-safe `{ browseEnabled: false }` on corrupted JSON, schema-incompatible shapes, or fs errors. Validated by two dedicated tests (`corrupted JSON` + `schema-incompatible shape`) — both return `DEFAULT_CAPABILITIES` instead of throwing. No information disclosure: the catch block ignores the error rather than logging it to the renderer.                                                                                                                                                                  |

No new threat surface beyond the plan. No `Threat Flags` section needed.

## Self-Check: PASSED

- `src/main/capabilities.ts` — FOUND (created, 64 lines)
- `src/main/capabilities.test.ts` — FOUND (created, 173 lines, 10 tests pass)
- `src/shared/characterSchema.ts` — modified (browse_enabled field added; grep `browse_enabled` returns 1)
- `src/main/ipc.ts` — modified (handler delegates to readCapabilities via lazy import)
- `src/renderer/src/screens/OnboardingScreen.tsx` — modified (browse_enabled: false added to literal)
- `.gitignore` — modified (tsc emit artifacts under src/**/*.js excluded)
- `grep -c "readCapabilities\|DEFAULT_CAPABILITIES\|browse_enabled\|BROWSE_ENABLED" src/main/capabilities.ts` = 12 (plan asserted >= 4)
- `grep -c "browse_enabled" src/shared/characterSchema.ts` = 1 (plan asserted >= 1)
- `npx tsc --build` — no new errors (loopbackPkce + supabaseClient.test pre-existing errors filtered)
- `npx vitest run src/main/capabilities.test.ts` — 10/10 pass
- `npx vitest run src/main/cloud/moderationGate.test.ts` — 8/8 pass (no regression)
- Commit `efdc857` (Task 1) — FOUND in git log
- Commit `35486e7` (Task 2) — FOUND in git log

---
*Phase: 12-character-sharing-ui-moderation*
*Completed: 2026-05-22*
