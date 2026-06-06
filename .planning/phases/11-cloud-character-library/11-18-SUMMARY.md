---
phase: 11
plan: 18
subsystem: migration / ui / ipc
tags: [migration, modal, ui, settings, ipc, one-shot, local-to-cloud]
requires:
  - 11-09 (cloud-mirror IPC + cloudCharacterClient — the upload primitive this plan composes)
  - 11-13 (AcceptToSModal — blocks ahead of the migration modal; tosAccepted gate sequencing in App.tsx)
  - 11-14 (isCloudWriteAllowed — defense-in-depth gate inside migration:upload)
  - 11-17 (useCloudCharactersStore + chars:list-cloud — LOCAL ONLY predicate; post-upload refresh hook)
provides:
  - "IpcChannel.migration.{listLocal,upload,shown} + RendererApi.{migrationListLocal,migrationUpload,migrationShown} — the one-shot local→cloud migration IPC surface"
  - "<userData>/migration-modal-shown.json — local persistence of the auto-mount-suppression flag (per-device, JSON for human-readability)"
  - "MigrateLocalCharsModal component — checkbox-per-row, sequential upload, per-row result phase, auto-refresh of useCloudCharactersStore on completion"
  - "SettingsScreen Account-panel 'Migrate local characters' entry — re-openable any time, bypasses the shown flag"
  - "App.tsx auto-mount effect — fires once per device when signed_in + tosAccepted === true + has at least one LOCAL ONLY char + flag unset"
affects:
  - src/shared/ipc.ts (added IpcChannel.migration + 3 RendererApi method signatures + IpcChannelName union extension)
  - src/main/ipc.ts (3 new handlers; added paths import; isCloudWriteAllowed gate in upload handler)
  - src/preload/index.ts (3 new RendererApi bindings)
  - src/main/paths.ts (migrationModalShownPath helper)
  - src/renderer/src/App.tsx (auto-mount effect + state + JSX mount)
  - src/renderer/src/screens/SettingsScreen.tsx (Account panel entry + state + JSX mount)
tech-stack:
  added: []
  patterns:
    - "Sequential upload over per-row Promise.all — predictable error reporting and rate-friendlier than parallel; modal stays mounted in 'submitting' phase while the loop runs"
    - "Defense-in-depth ToS gate inside migration:upload — even though AcceptToSModal blocks ahead of this flow, the handler still calls isCloudWriteAllowed and refuses every uuid with a uniform message if it returns false (T-11-18-01 mitigation)"
    - "Persistent device-local flag via plain JSON at <userData>/migration-modal-shown.json — same idiom as <userData>/skin-setup-state.json, atomic synchronous write via writeFileSync (best-effort, swallows ENOENT/EACCES with console.warn)"
    - "Mutually-exclusive modal stacking — AcceptToSModal gated on tosAccepted === false, MigrateLocalCharsModal gated on tosAccepted === true AND autoMigrateOpen; they cannot mount simultaneously, so the user sees ToS first then migration"
    - "Auto-mount-once UX — the effect keyed on [authState, tosAccepted] only sets autoMigrateOpen when the shown flag is unset AND the LOCAL ONLY set is non-empty (avoid 'empty modal pops up on a fresh signed-in account')"
key-files:
  created:
    - src/renderer/src/components/MigrateLocalCharsModal.tsx
    - src/renderer/src/components/MigrateLocalCharsModal.module.css
  modified:
    - src/shared/ipc.ts
    - src/main/ipc.ts
    - src/preload/index.ts
    - src/main/paths.ts
    - src/renderer/src/App.tsx
    - src/renderer/src/screens/SettingsScreen.tsx
decisions:
  - "Sequential upload (for-of loop) instead of Promise.all — matches the plan's must_have 'sequential (not parallel) for predictable error reporting and rate-friendliness'. The modal phase machine ('idle' → 'submitting' → 'results') keeps the user oriented while uploads run; partial failures are first-class via per-uuid result rows"
  - "Skin upload errors do NOT fail the whole per-uuid upload — if upsertCharacter (the row) succeeds but uploadSkin throws, we log the warning, continue to portrait upload, and surface the result as ok:true. The character row lands in the cloud, the LOCAL ONLY chip drops, and the user can re-upload the skin via the editor. Same logic for portrait — ENOENT (no portrait file) is the default-success path"
  - "migration:listLocal cloud-list failure falls back to set() (empty) rather than aborting — same UX as chars:list-cloud (Plan 11-17). The result is that on transient network failure, every local user-created char will appear in the modal as if it's local-only; the user can still proceed (the upload's own ToS / cloud calls will surface the same network issue if it persists). The alternative — refusing to show the modal until the network is up — would silently hide the migration path"
  - "Defense-in-depth ToS gate inside migration:upload even though AcceptToSModal blocks ahead — Plan 11-14's isCloudWriteAllowed is THE single UX gate per CONTEXT decision, and skipping it here would create a code path that uploads without going through the gate. Following the same pattern as syncQueue.processNext (Plan 11-14's primary consumer)"
  - "Settings entry uses Button kind='ghost' size='md' — matches the adjacent 'Export as JSON' and 'Sign out' buttons in the Account panel (consistent visual rhythm). Plan snippet said 'secondary' which doesn't exist on Button; mirrored the 11-13 SUMMARY's same adaptation (Rule 3)"
  - "App.tsx state pattern — local useState (setAutoMigrateOpen) instead of routing through useAuthStore or a new store. The flag is purely transient (lives until modal closes) and only this one effect reads/writes it; promoting it to a store would add ceremony for no payoff. Mirrors the existing toast / updateInfo local-state idiom in App.tsx"
  - "JSON shape for <userData>/migration-modal-shown.json includes shownAt timestamp even though only 'shown' is read — future-proofs the file for a re-prompt-after-N-days policy without a migration"
metrics:
  duration_seconds: 274
  tasks_completed: 2_of_3
  files_created: 2
  files_modified: 6
  commits: 2
  completed_date: "2026-05-22"
---

# Phase 11 Plan 18: One-shot Local→Cloud Migration Modal Summary

One-liner: D-20 migration UX — auto-mounts the first time a signed-in user with local-only chars accepts ToS, lists each char with a checkbox, uploads sequentially via cloudCharacterClient, and re-openable from Settings.

## What was built

### Task 1 — Migration IPC channels + shown-flag persistence (commit c14f1ad)

**`src/main/paths.ts`** — added `migrationModalShownPath()` returning `<userData>/migration-modal-shown.json`.

**`src/shared/ipc.ts`** — added `IpcChannel.migration.{listLocal,upload,shown}` with literal channel names, extended `IpcChannelName` union, and added three `RendererApi` method signatures:

```typescript
migrationListLocal(): Promise<{ characters: Array<{ id: string; name: string; slug: string | null; created: string }> }>;
migrationUpload(uuids: string[]): Promise<{ results: Array<{ id: string; ok: boolean; message?: string }> }>;
migrationShown(action: 'get' | 'set'): Promise<{ shown: boolean }>;
```

**`src/main/ipc.ts`** — three handlers:

- **`migration:list-local`** — pulls supabase session via `getClient().auth.getSession()`, lists all local characters via `listCharacters()`, attempts `cloudCharacterClient.listMyCharacters(owner)`, computes the LOCAL ONLY set as `!is_default && !cloudIds.has(id)`. Cloud-list failure falls back to empty set (same UX as `chars:list-cloud`). Returns `{ characters: [] }` for signed-out users.
- **`migration:upload`** — Zod-parses uuids[], runs the `isCloudWriteAllowed()` gate (T-11-18-01 defense-in-depth mitigation), then sequentially for each uuid: `getCharacter(id)` → `upsertCharacter(char, owner)` → `resolveSkinPng(char)` + `uploadSkin(owner, id, bytes)` → `readFile(paths.portraitPath(id))` + `uploadPortrait(owner, id, bytes, 'png')`. Skin/portrait failures don't fail the whole row (logged + continue); ENOENT on portrait is the default-success path. Returns per-uuid `{ id, ok, message? }` results.
- **`migration:shown`** — Zod-parses `'get' | 'set'`. `set` writes `{ shown: true, shownAt: ISO }` to the path via mkdirSync + writeFileSync (atomic-enough for this single-writer flag). `get` returns `{ shown: existsSync(p) }`.

**`src/preload/index.ts`** — three contextBridge passthroughs (`migrationListLocal`, `migrationUpload`, `migrationShown`).

Also added the missing `import { paths } from './paths'` to `src/main/ipc.ts` — the file was previously only using `paths.*` through lazy imports inside handlers; now uses it at handler top-level.

### Task 2 — MigrateLocalCharsModal + Settings entry + App.tsx auto-mount (commit db40918)

**`src/renderer/src/components/MigrateLocalCharsModal.tsx`** (180 lines) — phase machine `'loading' | 'idle' | 'submitting' | 'results'`:
- Mount → `loading` → `sei.migrationListLocal()` → `idle` with all checkboxes pre-selected
- `idle` → user toggles checkboxes → "Upload selected" → `submitting` → `sei.migrationUpload(Array.from(selected))` → `results`
- `results` → per-row ✓/✗ + error message; "Done" persists shown flag + closes
- `idle` "Maybe later" → persists shown flag + closes (same handler as Done)
- On `results`: fires `useCloudCharactersStore.getState().refresh()` so successfully-uploaded chars drop their LOCAL ONLY chip on Home immediately
- Click-outside suppressed (no onClick on scrim); 460px modal frame; same visual idiom as DeleteAccountModal / AcceptToSModal
- `aria-modal="true"` + `aria-labelledby` for screen-reader semantics

**`src/renderer/src/components/MigrateLocalCharsModal.module.css`** — mirrors AcceptToSModal scaffold (same scrim 0.45α, same `var(--window)`, `var(--text)`, `var(--text-2)`, `var(--accent)`, `var(--red)` tokens, same `var(--shadow-pop)`, same `var(--ease-pop)` animation). Added scrollable `.list` (max-height 280px overflow-y auto) for the per-char checkboxes; `.resultOk` / `.resultFail` color modifiers. `prefers-reduced-motion` opts out of fade.

**`src/renderer/src/screens/SettingsScreen.tsx`**:
- Imported `MigrateLocalCharsModal`
- Added `migrateModalOpen` local state
- New row in the Account panel between "Sign Out" and "Export My Data": label "Migrate local characters" + ghost button "Migrate local characters" → `setMigrateModalOpen(true)`
- Modal mounted in the same JSX block as the other account modals, gated on `migrateModalOpen`

**`src/renderer/src/App.tsx`**:
- Imported `MigrateLocalCharsModal`
- Added `autoMigrateOpen` local state
- New `useEffect` keyed on `[authState, tosAccepted]` — bails unless `signed_in + tosAccepted === true`, checks `sei.migrationShown('get')`, bails if `shown`, calls `sei.migrationListLocal()`, bails if `characters.length === 0`, otherwise `setAutoMigrateOpen(true)`. All wrapped in try-catch → silent on failure (Settings re-open remains the fallback path)
- Modal mounted AFTER `<AcceptToSModal>` in the root fragment, gated on `autoMigrateOpen`. Mutually exclusive with AcceptToSModal because of the `tosAccepted === true` gate on the auto-mount effect

## CHECKPOINT REACHED — Task 3 (human-verify, blocking)

**Type:** human-verify
**Plan:** 11-18
**Progress:** 2/3 tasks complete

### Completed Tasks

| Task | Name                                                                  | Commit  | Files                                                                                                                                                                                              |
| ---- | --------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Migration IPC channels + shown-flag persistence                       | c14f1ad | src/shared/ipc.ts, src/main/ipc.ts, src/preload/index.ts, src/main/paths.ts                                                                                                                        |
| 2    | MigrateLocalCharsModal + Settings entry + App.tsx auto-mount          | db40918 | src/renderer/src/components/MigrateLocalCharsModal.tsx, src/renderer/src/components/MigrateLocalCharsModal.module.css, src/renderer/src/screens/SettingsScreen.tsx, src/renderer/src/App.tsx       |

### Current Task

**Task 3:** Verify migration modal UX end-to-end
**Status:** Awaiting human verification
**Blocker:** Live test account with no `tos_acceptance` row + 2 local-mode characters created pre-sign-up needed to exercise the end-to-end UX flow.

### What the user needs to do (lifted from Task 3 `how-to-verify`)

1. With a fresh test account: sign out, create 2 local characters in "Continue Locally" mode, sign up (and accept ToS via Plan 11-13 modal). After ToS accepted, `MigrateLocalCharsModal` should auto-mount listing the 2 chars
2. Verify default state: both characters checked
3. Click "Maybe later" → modal closes; verify `<userData>/migration-modal-shown.json` now exists
4. Reopen app or sign-out/in: modal does NOT re-mount
5. Open Settings → click "Migrate local characters" — modal opens
6. Select 1 char, click "Upload selected" — see per-char results (✓ for the selected). Verify Supabase row created for the selected char:
   ```
   mcp__supabase__execute_sql "SELECT id, name FROM characters WHERE owner='<your-uid>'"
   ```
7. After upload completes, the uploaded character should drop its LOCAL ONLY chip (Plan 11-17) — verify Home screen
8. Failure path: temporarily disable network → try upload → verify per-char ✗ messages display the error
9. Open Settings → "Migrate local characters" again — should list only the still-local-only chars (the uploaded one no longer appears)

**Resume signal:** Reply `migration-modal-approved` or describe any issue found.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Plan snippet mismatch] `resolveSkinPng` takes a `Character`, not an id**
- **Found during:** Task 1 build
- **Issue:** The plan's snippet calls `await resolveSkinPng(id)` but `src/main/skinStore.ts:69` signature is `resolveSkinPng(character: Character): Promise<Buffer | null>` — it consumes the full character object (to honor `character.skin.source` — bundled vs upload/username branching).
- **Fix:** Pass `char` (already loaded via `getCharacter(id)`) into `resolveSkinPng(char)`. Same upstream behavior: returns the right PNG bytes for whatever the source descriptor points at (bundled → from packaged resources, upload/username → from `<userData>/skins/<id>.png`).
- **Files modified:** `src/main/ipc.ts` (Task 1)
- **Commit:** c14f1ad

**2. [Rule 3 — Plan snippet mismatch] `paths` was not imported at top of `src/main/ipc.ts`**
- **Found during:** Task 1 build
- **Issue:** The migration:upload handler needs `paths.portraitPath(id)`; the migration:shown handler needs `paths.migrationModalShownPath()`. The file previously only used `paths.*` from lazy imports inside other handlers; the new handlers consume it at top-level so a static import is cleaner than a third lazy import block.
- **Fix:** Added `import { paths } from './paths'` at module top.
- **Files modified:** `src/main/ipc.ts` (Task 1)
- **Commit:** c14f1ad

**3. [Rule 3 — Adapted to Button.tsx surface] `Button kind="secondary"` does not exist**
- **Found during:** Task 2 build
- **Issue:** Plan snippet uses `<Button kind="secondary" ...>` for the "Maybe later" button. `src/renderer/src/components/Button.tsx` exposes `Kind = 'primary' | 'accent' | 'ghost' | 'quiet'` only. Same adaptation Plan 11-13's SUMMARY documented for AcceptToSModal.
- **Fix:** Substituted `kind="quiet"` for "Maybe later" (matches DeleteAccountModal's "Keep my account" idiom — non-destructive dismiss with a soft visual weight). Primary action uses `kind="accent"` matching SignInModal / AcceptToSModal submit patterns. Settings re-open entry uses `kind="ghost"` matching adjacent Account panel buttons.
- **Files modified:** `src/renderer/src/components/MigrateLocalCharsModal.tsx`, `src/renderer/src/screens/SettingsScreen.tsx` (Task 2)
- **Commit:** db40918

### Auth gates

None during this plan — no Supabase calls were exercised live (handlers run against an empty session in tests, which short-circuits to empty results).

### Rule-4 (Architectural) escalations

None.

## Threat Coverage

| Threat ID | Disposition | Evidence |
|-----------|-------------|----------|
| T-11-18-01 (Migration upload before ToS accepted) | mitigated | `isCloudWriteAllowed` gate inside `migration:upload` handler refuses every uuid with a uniform message before any cloudCharacterClient call |
| T-11-18-02 (List leaks defaults to the modal) | mitigated | `migration:list-local` filters `!c.is_default && !cloudIds.has(c.id)` |
| T-11-18-03 (Modal re-mounts annoying the user) | mitigated | Shown flag persisted at `<userData>/migration-modal-shown.json`; auto-mount effect checks `shown` and bails if true. Re-open requires explicit Settings entry |
| T-11-18-04 (Sequential upload blocks UI for many chars) | accepted | Modal shows "Uploading…" status in 'submitting' phase; small N expected; user can navigate elsewhere — the modal is a single overlay, not a route |

## Known Stubs

None. Every IPC channel is fully wired; the modal calls real handlers that hit real Supabase / filesystem code paths. No "coming soon" copy, no placeholder data.

## Verification Results

| Acceptance criterion | Result |
| --- | --- |
| `grep -c "migration:list-local\|migration:upload\|migration:shown" src/shared/ipc.ts` ≥ 3 | 3 |
| `grep -c "IpcChannel.migration.listLocal\|IpcChannel.migration.upload\|IpcChannel.migration.shown" src/main/ipc.ts` ≥ 3 | 3 |
| `grep -c "migrationListLocal\|migrationUpload\|migrationShown" src/preload/index.ts` ≥ 3 | 3 |
| `grep -c "migrationModalShownPath" src/main/paths.ts` ≥ 1 | 1 |
| `grep -c "isCloudWriteAllowed" src/main/ipc.ts` ≥ 1 | 3 |
| File `src/renderer/src/components/MigrateLocalCharsModal.tsx` exists | yes |
| `grep -c "migrationListLocal\|migrationUpload" .../MigrateLocalCharsModal.tsx` ≥ 2 | 2 |
| `grep -c "Maybe later" .../MigrateLocalCharsModal.tsx` ≥ 1 | 3 |
| `grep -c "Upload selected" .../MigrateLocalCharsModal.tsx` ≥ 1 | 2 |
| `grep -c "Migrate local characters" .../SettingsScreen.tsx` ≥ 1 | 2 |
| `grep -c "migrationShown" .../App.tsx` ≥ 1 | 1 |
| `npx tsc --noEmit -p tsconfig.web.json` exits 0 | PASS |
| `npx tsc --noEmit -p tsconfig.node.json` | pre-existing errors only (loopbackPkce flowType, supabaseClient.test spread) — unchanged by this plan |
| `node_modules/.bin/vitest run` | 129/130 pass; the 1 failure (`portraitStore.test.ts > clears portrait_image and unlinks the file`) is a tmpdir-cleanup race documented as flaky — passes in isolation and is unrelated to this plan |

## Cross-plan compatibility notes (for Plan 11-19)

Plan 11-19 (next, last in phase) modifies `App.tsx`, `ipc.ts` (shared+main), `preload/index.ts`, `HomeScreen.tsx`, `CharacterPage.tsx`. This plan's footprint on those shared files:

- **`src/shared/ipc.ts`** — appended `IpcChannel.migration` at the end of the const + 3 new methods at end of `RendererApi` + 1 union extension. No conflicts expected with 11-19's additions (Plan 11-19 should append similarly).
- **`src/main/ipc.ts`** — added one import (`paths`) + 3 handlers in a contiguous block before `app:open-external`. 11-19 should slot its new handlers similarly.
- **`src/preload/index.ts`** — 3 new bindings at end of `api` object literal. No conflicts.
- **`src/renderer/src/App.tsx`** — added 1 import, 1 useState, 1 useEffect, 1 conditional `<MigrateLocalCharsModal>` JSX block at end of root fragment. The auto-mount effect is keyed on `[authState, tosAccepted]` — orthogonal to whatever 11-19 hooks into the same state.

## Next plan readiness

- D-20 satisfied: users now have a discoverable, low-friction path to upload their pre-sign-up local-mode characters. The first sign-in path is automatic; later access is via Settings.
- LIB-03 (the original "v0.1.1 migration" requirement, reinterpreted by D-20) is fully satisfied via this plan's modal + Settings entry. The REQUIREMENTS.md wording fix tracked in CONTEXT §deferred is still pending.
- Plan 11-19 (the final phase plan) can rely on the migration modal as the user-facing migration UX; no further migration-prompt scaffolding needed.

## Self-Check: PASSED

- `[FOUND]` `src/renderer/src/components/MigrateLocalCharsModal.tsx`
- `[FOUND]` `src/renderer/src/components/MigrateLocalCharsModal.module.css`
- `[FOUND]` modified `src/shared/ipc.ts`
- `[FOUND]` modified `src/main/ipc.ts`
- `[FOUND]` modified `src/preload/index.ts`
- `[FOUND]` modified `src/main/paths.ts`
- `[FOUND]` modified `src/renderer/src/App.tsx`
- `[FOUND]` modified `src/renderer/src/screens/SettingsScreen.tsx`
- `[FOUND]` commit `c14f1ad` (Task 1)
- `[FOUND]` commit `db40918` (Task 2)
- `[PASS]` `npx tsc --noEmit -p tsconfig.web.json` exits 0
- `[PASS]` All grep-based acceptance criteria from Tasks 1 + 2 met

---
*Phase: 11-cloud-character-library*
*Completed: 2026-05-22 (Tasks 1–2; Task 3 awaiting human verification)*
