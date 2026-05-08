---
phase: 04-electron-gui-packaging
plan: 03
subsystem: persistence
tags: [electron, safeStorage, zod, atomic-write, file-lock, migration, userData]
dependency_graph:
  requires:
    - phase: 04-electron-gui-packaging plan 01
      provides: "src/bot/ namespace + tsconfig.node.json (allowJs) for main-process TS compilation"
    - phase: 04-electron-gui-packaging plan 02 (parallel — wave 2)
      provides: "src/shared/characterSchema.ts CharacterSchema/CharacterIndexSchema/UserConfigSchema + Character/CharacterIndex/UserConfig types"
  provides:
    - "src/main/paths.ts canonical userData path resolution (configPath, charactersDir, indexPath, apiKeyPath, logsDir, memoryDir, characterPortraitPath) with TEST-ONLY override"
    - "src/main/configStore.ts loadConfig/saveConfig with UserConfigSchema + atomicWrite + withFileLock"
    - "src/main/characterStore.ts listCharacters/getCharacter/saveCharacter/deleteCharacter with index.json manifest, per-character memory dir bootstrap"
    - "src/main/apiKeyStore.ts saveApiKey/loadApiKey/hasApiKey/backendKind via Electron safeStorage; binary-safe atomic write"
    - "src/main/migration.ts runFirstLaunchMigration idempotent legacy persona → characters/sui.json transfer"
  affects:
    - "Phase 4 plan 04 (bot supervisor + main entry + IPC) — wires loadConfig/saveConfig/loadApiKey/saveApiKey/character CRUD into ipcMain.handle and runs runFirstLaunchMigration on app.whenReady"
    - "Phase 4 plan 09 (error mapping) — KEYCHAIN_FALLBACK_PLAINTEXT surfaced via apiKeyStore.backendKind() === 'basic_text'"
    - "Phase 4 plan 11 (clean-VM smoke) — paths._setUserDataOverride hook available for fixture-based tests"
tech_stack:
  added: []
  patterns:
    - "ALL <userData>/... paths funnel through src/main/paths.ts (single source of truth; testable override hook)"
    - "Reuse existing brain helpers (atomicWrite + withFileLock) for ALL utf8 file IO — CONTEXT explicit 'DO NOT roll a separate file-write helper'"
    - "Binary blob (api_key.bin) uses hand-rolled tmp+rename with same shape as atomicWrite.js — preserves atomicity for non-utf8 contents"
    - "Idempotent migration via fileExists guard + early-return"
    - "safeStorage isolation — only apiKeyStore.ts imports/touches safeStorage; characterStore + configStore + migration are safeStorage-free"
key_files:
  created:
    - "src/main/paths.ts"
    - "src/main/configStore.ts"
    - "src/main/characterStore.ts"
    - "src/main/apiKeyStore.ts"
    - "src/main/migration.ts"
  modified:
    - ".planning/phases/04-electron-gui-packaging/deferred-items.md (logged pre-existing TS-3.9 / missing-electron environment blocker)"
key_decisions:
  - "Removed plan-template @ts-expect-error directives on .js imports — under TS 5.4 + allowJs:true + moduleResolution:Bundler, the .js relative imports resolve cleanly without errors, so the directives became 'unused @ts-expect-error' compile errors. (Rule 1 auto-fix.)"
  - "Used named import { rename } from 'node:fs/promises' at module top of apiKeyStore.ts instead of plan's dynamic await import('node:fs/promises') call inside saveApiKey — equivalent semantics, less ceremony, same atomicity."
patterns_established:
  - "Pattern: atomic write idiom for binary blobs — tmp filename `.<basename>.tmp.<pid>.<ts>`, writeFile(tmp, buf) then rename(tmp, target), unlink(tmp) on rename failure. Mirrors src/bot/brain/storage/atomicWrite.js shape."
  - "Pattern: per-character memory dir bootstrap inside saveCharacter (mkdir paths.memoryDir(id) recursive) so the bot's atomicWrite calls into OWNER.md/DIARY.md/AFFECT.md never face ENOENT on the parent dir on first run."
  - "Pattern: idempotent migration short-circuit — `if (await fileExists(paths.characterPath('sui'))) return;` BEFORE any reads; no-op on second run, no-op when no legacy config exists."
requirements_completed: [GUI-01, GUI-04, GUI-05]
metrics:
  duration_min: 6
  tasks_completed: 3
  files_changed: 5
  loc_added: 392
  completed: "2026-05-08T18:30:00Z"
---

# Phase 4 Plan 03: Stores and Secrets Summary

**Five main-process persistence modules — userData path resolution, UserConfig + Character + index JSON CRUD, Electron safeStorage-backed API key, and an idempotent first-launch migration that lifts CLI users' legacy `persona` into `characters/sui.json`.**

## Performance

- **Duration:** ~6 min
- **Started:** 2026-05-08T18:14:00Z
- **Completed:** 2026-05-08T18:30:00Z
- **Tasks:** 3 (all auto, no TDD)
- **Files created:** 5

## Accomplishments

- `paths.ts`: canonical userData resolution — every `<userData>/...` write across main process must funnel through this module. Includes a TEST-ONLY `_setUserDataOverride` for harnesses.
- `configStore.ts`: round-trips `<userData>/config.json` through `UserConfigSchema.parse(...)`. Missing-file → `DEFAULT_CONFIG`. Save uses `atomicWrite` inside `withFileLock(target, ...)`. Legacy `persona` field silently dropped on parse (schema rejects unknown keys via `.parse` on `z.object({...})` — Zod's default).
- `characterStore.ts`: list/get/save/delete `<id>.json` with `<userData>/characters/index.json` manifest. `saveCharacter` pre-creates `<userData>/memory/<id>/` so the bot's atomicWrite calls land safely. `deleteCharacter` removes JSON + optional `<id>.png` portrait + memory dir + index entry, all idempotent.
- `apiKeyStore.ts`: encrypts plaintext via `safeStorage.encryptString` and writes Buffer via tmp+rename to `<userData>/api_key.bin`. Throws `KEYCHAIN_UNAVAILABLE` if `isEncryptionAvailable()` is false. `backendKind()` defensively probes `getSelectedStorageBackend` so older Electron releases don't crash.
- `migration.ts`: idempotent dev-clone migration. If `characters/sui.json` already exists OR cwd `config.json` is absent → no-op. Otherwise reads legacy `persona`, writes `sui.json` with `is_default: true`, then strips `persona` from the cwd file (only when `!app.isPackaged` — packaged builds run from a read-only signed bundle, so we never attempt EROFS-prone writes there).

## Task Commits

1. **Task 1: paths.ts + configStore.ts** — `e532f24` (feat)
2. **Task 2: characterStore.ts + apiKeyStore.ts** — `37254da` (feat)
3. **Task 3: migration.ts** — `d4022f2` (feat)

## Module Surface (final exported signatures)

### `src/main/paths.ts`
```ts
export function _setUserDataOverride(p: string | null): void;
export const paths: {
  userData: () => string;
  configPath: () => string;
  charactersDir: () => string;
  characterPath: (id: string) => string;
  characterPortraitPath: (id: string) => string;
  indexPath: () => string;
  apiKeyPath: () => string;
  logsDir: () => string;
  memoryDir: (characterId: string) => string;
};
```

### `src/main/configStore.ts`
```ts
export const DEFAULT_CONFIG: UserConfig;
export async function loadConfig(): Promise<UserConfig>;
export async function saveConfig(config: UserConfig): Promise<void>;
```

### `src/main/characterStore.ts`
```ts
export async function listCharacters(): Promise<Character[]>;
export async function getCharacter(id: string): Promise<Character | null>;
export async function saveCharacter(character: Character): Promise<void>;
export async function deleteCharacter(id: string): Promise<void>;
```

### `src/main/apiKeyStore.ts`
```ts
export async function saveApiKey(plaintext: string): Promise<void>;       // throws 'KEYCHAIN_UNAVAILABLE' if isEncryptionAvailable() is false
export async function loadApiKey(): Promise<string>;                       // throws on missing file or decrypt failure
export async function hasApiKey(): Promise<boolean>;
export function backendKind(): string;                                     // 'kwallet' | 'kwallet5' | 'kwallet6' | 'gnome_libsecret' | 'basic_text' | 'unknown'
```

### `src/main/migration.ts`
```ts
export async function runFirstLaunchMigration(cwdConfigPath?: string): Promise<void>;
```

## File-IO Funnel Audit

| File | Helper used | Notes |
|------|-------------|-------|
| `configStore.ts` saveConfig | `withFileLock` + `atomicWrite` | utf8 JSON |
| `characterStore.ts` writeIndex | `withFileLock` + `atomicWrite` | utf8 JSON |
| `characterStore.ts` saveCharacter | `withFileLock` + `atomicWrite` | utf8 JSON |
| `apiKeyStore.ts` saveApiKey | hand-rolled tmp+rename | binary Buffer (encrypted blob); same algorithm shape as `atomicWrite.js` |
| `migration.ts` strip-write | raw `writeFile(cwdConfigPath, ...)` | dev-only legacy file outside `<userData>`; gated `!app.isPackaged`; not in atomic-write contract |

`grep -L "atomicWrite\|withFileLock" src/main/configStore.ts src/main/characterStore.ts` returns nothing — both files use the existing helpers, per CONTEXT mandate.
`grep -l "safeStorage" src/main/{characterStore,configStore,migration}.ts` returns nothing — safeStorage isolation maintained.

## Decisions Made

1. **Removed `@ts-expect-error` directives on `.js` imports** (Rule 1 auto-fix). Under `tsconfig.node.json` (`allowJs: true`, `moduleResolution: Bundler`) plus the symlinked `node_modules`, the `import { atomicWrite } from '../bot/brain/storage/atomicWrite.js'` line resolves cleanly with no diagnostic. The plan template inserted `// @ts-expect-error` to suppress an expected error that doesn't actually fire — TypeScript then emits `TS2578 Unused '@ts-expect-error' directive`. Replaced with explanatory comments noting `allowJs` handles resolution.

2. **`rename` imported at module top of `apiKeyStore.ts`**, not lazy-imported inside `saveApiKey`. The plan template called `await import('node:fs/promises')` mid-function; consolidating into the existing top-of-file `import { ... rename } from 'node:fs/promises'` is semantically identical, fewer micro-allocations, and matches every other file's import style.

3. **All other plan code retained verbatim.** Logger shape, error class names, comment provenance, threat-model references, `void persona` to silence unused-destructured-rest warnings — all preserved as-spec.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Removed unused `@ts-expect-error` directives in configStore.ts and characterStore.ts**
- **Found during:** Task 1 (configStore.ts type-check) and reapplied during Task 2 (characterStore.ts).
- **Issue:** Plan template's two `// @ts-expect-error` lines preceding the `.js` ESM imports compiled cleanly under TS 5.4 + `allowJs: true`. TypeScript then flags them as `TS2578 Unused '@ts-expect-error' directive`, breaking the per-task tsc verify.
- **Fix:** Replaced both `@ts-expect-error` comments with a single explanatory comment ("allowJs:true in tsconfig.node.json lets TS resolve these .js modules at compile time").
- **Files modified:** src/main/configStore.ts, src/main/characterStore.ts
- **Verification:** `npx --yes -p typescript@5.4 tsc --noEmit ...` exits 0 with all five files included (plus electron + characterSchema stubs to compensate for plan 02 / npm-install not being present in this worktree).
- **Commits:** Folded into the Task 1 (e532f24) and Task 2 (37254da) commits — fix applied before each commit landed.

**2. [Rule 1 - Bug] Replaced `await import('node:fs/promises')` with top-level `rename` import in apiKeyStore.ts**
- **Found during:** Task 2 implementation.
- **Issue:** Plan template's saveApiKey body lazy-imported `rename`. With the existing `import { readFile, writeFile, access, mkdir, unlink } from 'node:fs/promises'` at module top, lazy-importing one more named export is unnecessary noise.
- **Fix:** Added `rename` to the top-level destructured import; removed the `await import(...)` line.
- **Files modified:** src/main/apiKeyStore.ts
- **Verification:** Type-check passes; behavior identical (rename is invoked exactly once, same Promise semantics).
- **Commit:** 37254da.

### Out-of-scope items (logged to deferred-items.md, not fixed)

**1. Pre-existing environment: TypeScript 3.9.10 installed (vs `^5.4.0` declared)**
- The repository's `node_modules/typescript` is `3.9.10` and `electron@42.0.0` is not installed at all, despite both appearing in package.json (added by plan 04-01). Plan 01 SUMMARY shows `npm install` ran but apparently against an older lockfile / a previous `package.json` snapshot.
- This blocks the plan's `npx tsc --noEmit -p tsconfig.node.json` verify command end-to-end in this worktree (TS 3.9 doesn't even understand `target: ES2022` or `moduleResolution: Bundler`; missing electron module rejects `import ... from 'electron'`).
- **Workaround used during this plan:** type-checked all 5 files via `npx --yes -p typescript@5.4 tsc --noEmit ...` with explicit flags + temporary in-`/tmp` stubs for `electron` and `*characterSchema`. All 5 files compile clean (0 errors, 0 warnings) under TS 5.4.
- **Scope:** pre-existing env issue, not caused by plan 04-03's changes. Logged to `.planning/phases/04-electron-gui-packaging/deferred-items.md`.
- **Recommendation:** wave-merge / pre-build step must run `npm install` on the merged tree before plan 04-04 begins. Plan 04-11 (clean-VM smoke) already exercises a fresh install end-to-end.

---

**Total deviations:** 2 auto-fixed (both Rule 1 bug — fixing TS template artifacts).
**Impact on plan:** None. Module surfaces, behavior, threat-model assignments, and key-link patterns all match the plan exactly. Out-of-scope env blocker logged for visibility, not scope-creeping into this plan to fix.

## Issues Encountered

- The Write tool initially wrote `paths.ts` and `configStore.ts` to `/Users/ouen/slop/sei/src/main/` (parent repo) instead of the worktree. Caught immediately on first verify-grep (files reported MISSING in worktree), `mv`'d to the worktree's `src/main/`, then verified in place. Subsequent writes used the absolute worktree path. No commits affected — the move happened pre-commit.

## Threat Flags

None. Per the plan's `<threat_model>`, all 6 STRIDE threats (T-04-08 through T-04-13) have explicit mitigations baked into the implementation:
- T-04-08 (malformed JSON): `CharacterSchema.parse(...)` on every read
- T-04-09 (api_key.bin disclosure): plaintext never on disk; safeStorage encrypts before fs.writeFile
- T-04-10 (Linux basic_text): `backendKind()` returns the backend name; caller surfaces KEYCHAIN_FALLBACK_PLAINTEXT
- T-04-11 (symlink attack on api_key.bin): tmp+rename in same dir; `<userData>` is OS-protected per-user
- T-04-12 (concurrent saveCharacter on same id): `withFileLock(target, ...)` serializes per-path
- T-04-13 (migration re-run): early-return when `characters/sui.json` already exists

No NEW security-relevant surface introduced beyond what the plan's threat model anticipated.

## Notes for Plan 04 Executor

- `runFirstLaunchMigration` MUST be called inside `app.whenReady().then(...)` BEFORE any `loadConfig()` / `listCharacters()` call. Migration is idempotent so a stray re-call is harmless, but the legacy strip-write makes more sense before the first read.
- All 4 store modules (`configStore`, `characterStore`, `apiKeyStore`, plus `migration`) are pure async TS — no top-level side effects. Safe to import lazily inside `ipcMain.handle` factory closures.
- `apiKeyStore.backendKind()` is **synchronous**. The IPC handler should call it during the safeStorage-availability check at startup and forward the result via the `LogBatch`/error channel if it equals `'basic_text'`.
- `paths._setUserDataOverride` exists for testing only — production main entry must NEVER call it.

## Notes for Plan 11 Executor

- `paths._setUserDataOverride(<tmpdir>)` lets the smoke harness route every read/write into a scratch dir without monkey-patching `app.getPath`. Set it before triggering `runFirstLaunchMigration`.
- Verify on a clean VM that `<userData>/{config.json, characters/index.json, characters/sui.json, api_key.bin}` all appear after first onboarding completion. `characters/sui.json` only appears if a legacy cwd `config.json` was present OR the user fills the personality form (plan 08 territory — saveCharacter call from renderer).

## Self-Check: PASSED

Verified files exist:
- FOUND: src/main/paths.ts
- FOUND: src/main/configStore.ts
- FOUND: src/main/characterStore.ts
- FOUND: src/main/apiKeyStore.ts
- FOUND: src/main/migration.ts

Verified commits exist in git log:
- FOUND: e532f24 (Task 1 — paths + configStore)
- FOUND: 37254da (Task 2 — characterStore + apiKeyStore)
- FOUND: d4022f2 (Task 3 — migration)

Verified plan-level <verification> grep checks all pass:
- `grep -L "atomicWrite\|withFileLock" src/main/{configStore,characterStore}.ts` returns nothing — both files use existing helpers.
- `grep -L "import.*safeStorage" src/main/apiKeyStore.ts` returns nothing — safeStorage IS imported.
- `grep -l "safeStorage" src/main/{characterStore,configStore,migration}.ts` returns nothing — separation of concerns maintained.

Type-check (TS 5.4, with electron + characterSchema stubs to compensate for unrun npm-install in this worktree): 0 errors across all 5 files.

---
*Phase: 04-electron-gui-packaging*
*Completed: 2026-05-08*
