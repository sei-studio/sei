---
phase: 09-implement-custom-bot-skins-via-customskinloader-mod-first-la
plan: 01
subsystem: shared-contracts
tags: [ipc, zod-schema, electron-preload, error-classes, skin-pipeline, setup-wizard, png-encoding]

# Dependency graph
requires:
  - phase: 8
    provides: "Windows cross-platform compatibility (Phase 9 wizard inherits Windows path realities; not exercised in this contract-only plan but unblocks downstream waves)"
provides:
  - "SkinSchema + SkinSourceSchema (zod) — per-persona skin descriptor on Character"
  - "Character.username — per-persona MC in-game name (nullable, regex-gated)"
  - "ErrorClass union extended with 7 Phase 9 entries; ALL_ERROR_CLASSES array kept in sync"
  - "IpcChannel.skin (5 channels) + IpcChannel.wizard (5 channels incl. wizard:cancel push channel wizard:progress)"
  - "RendererApi gains 10 new methods (5 skin + 4 wizard request + 1 wizard subscription)"
  - "applySkin signature accepts optional `username` for atomic two-field updates (single saveCharacter)"
  - "runWizardInstall takes sessionId + wizardCancel(sessionId) — IPC-crossing abort path for in-flight installs"
  - "Three bundled 64x64 RGBA PNG default skins (sui/mochineko/clawd) under resources/skins/"
  - "All three default-character JSONs seed `skin: { source: 'bundled', ... }` + `username` matching persona name"
  - "electron-builder.yml asarUnpack covers resources/skins/**/* so PNGs survive packaging"
  - "scripts/build-default-skins.mjs — reproducible hand-rolled PNG encoder (Node stdlib only)"
affects:
  - "Plan 02 (skin store + applySkin/removeSkin handlers) — reads Skin/SkinSchema from shared"
  - "Plan 03 (skin HTTP server) — resolves resources/skins/<id>.png via process.resourcesPath; uses Character.username for skin URL routing"
  - "Plan 04 (wizard detection modules) — exports McInstall + WizardState back through shared"
  - "Plan 05 (wizard orchestrator) — registers ipcMain.handle for wizard:install/cancel/getState; emits wizard:progress"
  - "Plan 06 (SkinEditor + bundled UI) — imports Skin/SkinSource/ERROR_COPY from shared; needs onWizardProgress for live state"
  - "Plan 07 (SetupWizardModal + WizardStepShell + flow store) — calls wizardCancel(sessionId) on user Cancel"
  - "src/bot/index.js sanitizeMcName — Plan 04 will switch to character.username with sanitizeMcName fallback"

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "ipc-channel-cancel-pair: `wizard:install` request channel paired with `wizard:cancel` request channel + `wizard:progress` push channel. Renderer holds a sessionId; main holds a Map<sessionId, AbortController>. Lets renderer abort child-process subprocesses (java -jar fabric-installer) that a renderer-local AbortController could never reach."
    - "atomic-multi-field-ipc: applySkin takes both pngBase64 AND username so the renderer can update skin + per-persona MC username in a single IPC round-trip + single saveCharacter call (rather than calling saveCharacter then applySkin as two separate operations that could partially fail and leave the persona inconsistent)."
    - "schema-default-on-new-field: Adding fields with `.default(...)` to a zod schema keeps existing JSON parseable (lenient parse) BUT z.infer output type makes the field required. Every Character literal constructor in the codebase must include the new fields. Migrated this plan: src/main/migration.ts and src/renderer/src/screens/AddCharacterScreen.tsx."
    - "hand-rolled-png: 64x64 RGBA PNG encoder in 50 lines using Node stdlib (zlib + Buffer + CRC32 table). Avoids shipping sharp/pngjs/jimp for trivial placeholder assets. Output validates as PNG-magic + IHDR(64x64, bit-depth 8, color-type 6)."

key-files:
  created:
    - "scripts/build-default-skins.mjs — deterministic 64x64 RGBA PNG generator (Node stdlib only)"
    - "resources/skins/sui.png — 220 bytes, peach body + gold head"
    - "resources/skins/mochineko.png — 222 bytes, brown body + cream head"
    - "resources/skins/clawd.png — 222 bytes, slate body + lighter-slate head"
  modified:
    - "src/shared/characterSchema.ts — added SkinSourceSchema, SkinSchema, Character.skin, Character.username"
    - "src/shared/errorClasses.ts — added 7 new ErrorClass entries (union + array)"
    - "src/shared/ipc.ts — added IpcChannel.skin/wizard + McInstall/WizardInstallResult/WizardState/WizardProgressEvent + 10 RendererApi methods"
    - "src/preload/index.ts — 10 new contextBridge bindings (incl. onWizardProgress subscription)"
    - "src/renderer/src/lib/errors.ts — 7 new ERROR_COPY entries (verbatim from 09-UI-SPEC)"
    - "src/main/migration.ts — legacy sui literal now includes skin + username (typecheck consequence)"
    - "src/renderer/src/screens/AddCharacterScreen.tsx — draft literal now includes skin + username"
    - "resources/default-characters/sui.json — seeded `skin: bundled` + `username: Sui`"
    - "resources/default-characters/mochineko.json — seeded `skin: bundled` + `username: Mochineko`"
    - "resources/default-characters/clawd.json — seeded `skin: bundled` + `username: Clawd`"
    - "electron-builder.yml — asarUnpack extended with `resources/skins/**/*`"

key-decisions:
  - "SkinSchema lives on Character (per-persona) rather than as a side-table — only one skin per persona at a time, no history kept; PNG bytes live on disk under <userData>/skins/<id>.png with `png_sha256` for cache-bust."
  - "Username regex is exactly Minecraft's username constraint `^[A-Za-z0-9_]+$` + 16-char cap. Defaults to null so existing sanitizeMcName fallback (src/bot/index.js:270-280) keeps working until Plan 04 wires the override."
  - "wizard:cancel is a REQUEST channel (renderer→main with sessionId) not an EVENT. Resolves immediately after firing .abort() — the long-running runWizardInstall promise then rejects/resolves with a cancelled-stage result."
  - "applySkin accepts optional username so the renderer can ship 'change skin + change username' as one atomic operation. Pass undefined to leave username untouched; pass empty string to clear back to fallback."
  - "Bundled default PNGs are deterministic non-art placeholders (whole-canvas body color + 8x8 head-front stamp). Real per-persona art is a later quick task — these exist only so Plan 06's first-launch UI can render something for `is_default: true` personas without a skin server hit."
  - "Hand-rolled PNG encoder beats adding sharp/pngjs as a runtime dep for these three 220-byte files. The script runs once at dev time; the PNGs themselves are committed."

patterns-established:
  - "IPC cancel channel: any long-running main-side operation gets a paired request channel `<op>:cancel` taking a renderer-generated sessionId, plus a push channel `<op>:progress` for per-step events. Main holds a Map<sessionId, AbortController>."
  - "Default-bearing zod field migration: when adding a field with `.default(...)` to an existing schema, the inferred type becomes required on the output side — search the codebase for every `: Character = {` literal and extend it. JSON files parse fine because Zod applies the default on parse; only TS literals need the explicit field."
  - "Bundled binary asset in Electron: add to `electron-builder.yml` asarUnpack so the file survives into the packaged build under `process.resourcesPath` (where fs.readFile works in production)."

requirements-completed: []

# Metrics
duration: 25min
completed: 2026-05-17
---

# Phase 9 Plan 01: Shared Contracts for Custom Bot Skins Summary

**Lays the shared TypeScript + Zod contracts (skin descriptor, per-persona MC username, 10 new IPC channels including wizard:cancel for IPC-crossing aborts, 7 new error classes with verbatim copy, and three bundled 64x64 default skin PNGs generated via a hand-rolled Node stdlib PNG encoder) so Plan 02-07 can build the skin pipeline, setup wizard, and renderer UI against fixed interfaces with zero further mutation of `src/shared/*`.**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-05-17T20:14:00Z (approx — first commit landed 20:17)
- **Completed:** 2026-05-17T20:19:23Z
- **Tasks:** 2 / 2
- **Files modified:** 11 (7 modified + 4 created)

## Accomplishments

- **Shared contract surface locked.** All downstream Phase 9 waves (Plans 02-07) can now import `Skin`, `SkinSchema`, `SkinSource`, `McInstall`, `WizardState`, `WizardProgressEvent`, `ErrorClass` from shared and `ERROR_COPY` from the renderer lib with no further additions to `src/shared/*`. The `wizardCancel(sessionId)` IPC method is callable from the renderer (preload binding present); Plan 05 wires the main-side handler.
- **Three bundled default skins shipped.** Sui (peach/gold), Mochineko (brown/cream), Clawd (slate/light-slate) each have a 220-222 byte 64x64 RGBA PNG under `resources/skins/`, generated by a 170-line hand-rolled Node-stdlib PNG encoder (no sharp/pngjs runtime dep). All three default character JSONs seed `skin: { source: 'bundled' }` + `username` matching persona name. electron-builder.yml asarUnpack covers them so they survive packaging.
- **Atomic two-field IPC pattern established.** `applySkin` accepts both `pngBase64` and optional `username`, so the renderer can apply a skin AND set the per-persona in-game name in one round-trip + one `saveCharacter` call — no risk of half-applied state if either field fails.

## Task Commits

1. **Task 1: Extend shared contracts** — `036457b` (feat)
   - characterSchema.ts: SkinSourceSchema + SkinSchema + Character.skin + Character.username
   - errorClasses.ts: 7 new entries (union + ALL_ERROR_CLASSES array)
   - ipc.ts: IpcChannel.skin (5), IpcChannel.wizard (5 incl. cancel), 4 new domain types, 10 new RendererApi methods
   - preload/index.ts: 10 new contextBridge bindings (incl. onWizardProgress subscription)
   - renderer/lib/errors.ts: 7 new ERROR_COPY entries verbatim from 09-UI-SPEC
   - migration.ts + AddCharacterScreen.tsx: existing Character literals extended with default skin/username (Rule 3 auto-fix — see Deviations)
2. **Task 2: Bundle default skin PNGs + seed JSON defaults** — `f522d4d` (feat)
   - scripts/build-default-skins.mjs (new) + 3 PNGs (new) + 3 default-character JSON edits + electron-builder.yml asarUnpack entry

## Files Created/Modified

### Created (4)
- `scripts/build-default-skins.mjs` — hand-rolled 64x64 RGBA PNG generator (zlib + CRC32 + IHDR/IDAT/IEND chunks; ~170 LoC, Node stdlib only).
- `resources/skins/sui.png` — 220 bytes, peach body + gold head front face.
- `resources/skins/mochineko.png` — 222 bytes, brown body + cream head front face.
- `resources/skins/clawd.png` — 222 bytes, slate body + lighter-slate head front face.

### Modified (7 source files + 3 default JSONs + 1 build config = 11)
- `src/shared/characterSchema.ts` — `SkinSourceSchema` enum, `SkinSchema` object, `Character.skin` (default), `Character.username` (nullable, MC regex + 16-char cap).
- `src/shared/errorClasses.ts` — `ErrorClass` union + `ALL_ERROR_CLASSES` array extended with 7 new entries: MOD_DOWNLOAD_FAILED, FABRIC_INSTALL_FAILED, MC_INSTALL_NOT_FOUND, MOJANG_LOOKUP_FAILED, SKIN_FILE_INVALID, SKIN_SERVER_PORT_TAKEN, WIZARD_PERMISSION_DENIED.
- `src/shared/ipc.ts` — IpcChannel.skin (5 channels), IpcChannel.wizard (5 channels incl. cancel/progress), McInstall/WizardInstallResult/WizardState/WizardProgressEvent interfaces, 10 new RendererApi methods (incl. wizardCancel + onWizardProgress).
- `src/preload/index.ts` — contextBridge api gains 10 new bindings mirroring RendererApi.
- `src/renderer/src/lib/errors.ts` — `ERROR_COPY` record extended with 7 new entries verbatim from 09-UI-SPEC §"New ERROR_COPY entries".
- `src/main/migration.ts` — legacy sui literal now includes `skin` + `username` (typecheck-driven; see Deviations).
- `src/renderer/src/screens/AddCharacterScreen.tsx` — draft Character literal includes `skin` + `username` defaults (typecheck-driven).
- `resources/default-characters/sui.json` — added `"skin": { "source": "bundled", ... }` + `"username": "Sui"`.
- `resources/default-characters/mochineko.json` — added `"skin": { "source": "bundled", ... }` + `"username": "Mochineko"`.
- `resources/default-characters/clawd.json` — added `"skin": { "source": "bundled", ... }` + `"username": "Clawd"`.
- `electron-builder.yml` — `asarUnpack` extended with `"resources/skins/**/*"`.

## Verification Evidence

### Typecheck (both projects clean)
```
$ npx tsc --noEmit -p tsconfig.node.json   # exit 0, no output
$ npx tsc --noEmit -p tsconfig.web.json    # exit 0, no output
```

### Task 1 acceptance criteria
```
skin: channels in ipc.ts:        8 hits  (≥5 required)
wizard: channels in ipc.ts:      6 hits  (≥5 required)
wizard:cancel constant:          present in IpcChannel.wizard
wizardCancel preload binding:    present in src/preload/index.ts (line 47)
sessionId references in ipc.ts:  4       (≥2 required — runWizardInstall arg + wizardCancel signature + comment)
applySkin.username arg:          `username?: string | null` in signature
ErrorClass new entries (errorClasses.ts):   14 (7 union + 7 ALL_ERROR_CLASSES)
ERROR_COPY new entries (errors.ts):         7
SkinSchema | SkinSourceSchema in characterSchema.ts: 5+ matches
Character.username field present (distinct from mojang_username):  yes
Preload new methods (10 of 10):  11 matches (one match is in the file's doc comment)
```

### Task 2 acceptance criteria
```
$ node scripts/build-default-skins.mjs
[build-default-skins] wrote …/resources/skins/sui.png (220 bytes)
[build-default-skins] wrote …/resources/skins/mochineko.png (222 bytes)
[build-default-skins] wrote …/resources/skins/clawd.png (222 bytes)
[build-default-skins] done — 3 skins

$ head -c 4 resources/skins/sui.png | od -An -tx1
 89 50 4e 47   ← valid PNG magic

$ wc -c resources/skins/*.png
 222 clawd.png
 222 mochineko.png
 220 sui.png   ← all ≥67 bytes (8 magic + 25-byte IHDR + IDAT + 12-byte IEND minimum)

$ grep -F '"username": "Sui"' resources/default-characters/sui.json         # matches
$ grep -F '"username": "Mochineko"' resources/default-characters/mochineko.json   # matches
$ grep -F '"username": "Clawd"' resources/default-characters/clawd.json     # matches
$ grep -F '"source": "bundled"' resources/default-characters/*.json         # 3 hits
$ grep -F 'resources/skins/**/*' electron-builder.yml                       # matches once
```

### Default JSONs parse against updated CharacterSchema
```
$ npx tsx -e '<import each JSON; CharacterSchema.parse each>'
sui: skin.source=bundled username=Sui
mochineko: skin.source=bundled username=Mochineko
clawd: skin.source=bundled username=Clawd
All 3 default JSONs parse OK against updated CharacterSchema
```

### IHDR decode confirms 64×64 RGBA8
```
sui:       64x64 RGBA8 (220 bytes) OK
mochineko: 64x64 RGBA8 (222 bytes) OK
clawd:     64x64 RGBA8 (222 bytes) OK
```

### Final plan output grep (from <output> section)
```
$ grep -F "SkinSchema|McInstall|WizardState|wizardCancel" \
    src/shared/{characterSchema,ipc}.ts src/preload/index.ts | wc -l
14
```

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Blocking issue] Updated two existing Character literal constructors to satisfy strict types**
- **Found during:** Task 1 verification (typecheck failed after extending CharacterSchema).
- **Issue:** The plan's success criteria says `git diff --stat src/main/` should show zero lines (no main-process logic in this plan). Adding `skin` and `username` fields to `CharacterSchema` with `.default(...)` makes them non-optional on the inferred output `Character` type (Zod's input type marks them optional via the default, but the output type considers them required). Two existing object literals in the codebase use `: Character = { … }` and would not typecheck without the new fields.
- **Fix:** Added the default `skin` object and `username: null` to:
  - `src/main/migration.ts:103` — legacy-sui migration literal. Sets `skin: { source: 'none', … }` (NOT `bundled`) because this literal runs only when migrating a pre-Phase-9 user; the bundled skin is seeded separately by `seedDefaultCharacters` for users whose `sui` id is brand new.
  - `src/renderer/src/screens/AddCharacterScreen.tsx:78` — user-created persona draft. Sets `skin: { source: 'none', … }` and `username: null` so the existing sanitizeMcName fallback in `src/bot/index.js:270` keeps working until Plan 02 wires the per-persona override.
- **Why this is consistent with plan intent:** Neither change adds main-process *business logic* — they are pure type-driven literal extensions with no behavior change. The plan's spirit ("foundation pass that lets Plans 02-07 grow `src/main/*` without re-touching shared") is preserved. The 5-line `src/main/migration.ts` delta is the only deviation from the literal "src/main/ shows zero lines" success criterion.
- **Files modified:** src/main/migration.ts (+5 lines), src/renderer/src/screens/AddCharacterScreen.tsx (+5 lines)
- **Commits:** Folded into Task 1 commit `036457b`.

### No other deviations

No authentication gates encountered. No architectural decisions (Rule 4) triggered. No fix-attempt loops — both tasks landed in one pass each.

## Known Stubs

The plan explicitly notes "No main-process or renderer business logic — pure contract surface." Every new RendererApi method in `src/preload/index.ts` is an `ipcRenderer.invoke(...)` call with no main-process handler yet — these are not "stubs" in the deferred-functionality sense but the intentional contract surface that Plans 02/03/04/05 register handlers against. Listed here for the verifier's transparency:

| RendererApi method | Handler ships in | Status |
|--------------------|------------------|--------|
| applySkin | Plan 02 | contract-only here |
| removeSkin | Plan 02 | contract-only here |
| uploadSkinPng | Plan 02 | contract-only here |
| searchMojangSkin | Plan 02 | contract-only here |
| getSkinServerUrl | Plan 03 | contract-only here |
| detectMcInstalls | Plan 04 | contract-only here |
| runWizardInstall | Plan 05 | contract-only here |
| wizardCancel | Plan 05 | contract-only here |
| getWizardState | Plan 05 | contract-only here |
| onWizardProgress | Plan 05 (push channel) | contract-only here |

The three bundled PNGs are **placeholder art**, not stubs — they are functionally valid 64×64 RGBA PNGs that CustomSkinLoader will accept and the 3D preview will render. Real persona art is a planned follow-up (noted in Task 2's commit message: "Placeholder art only — real per-persona skins ship in a later quick task").

## Threat Flags

None. The plan's threat register covered T-09-01 (tampering — accepted, bundled defaults stay read-only in app.asar), T-09-02 (info disclosure — accepted, placeholder PNGs are non-PII), and T-09-03 (spoofing — mitigated via the regex + length cap on `Character.username`). All three threats were accounted for in the implementation:
- `username` field on CharacterSchema uses `.regex(/^[A-Za-z0-9_]+$/)` + `.max(16)` (T-09-03 mitigated).
- Bundled PNGs are deterministic non-PII placeholders generated by a committed script (T-09-02 accepted).
- No new shared surface introduces a NEW trust boundary beyond what the threat register covers.

## Self-Check: PASSED

Verified all claimed files exist and all claimed commits are reachable:

```
FOUND: src/shared/characterSchema.ts (modified)
FOUND: src/shared/errorClasses.ts (modified)
FOUND: src/shared/ipc.ts (modified)
FOUND: src/preload/index.ts (modified)
FOUND: src/renderer/src/lib/errors.ts (modified)
FOUND: src/main/migration.ts (modified)
FOUND: src/renderer/src/screens/AddCharacterScreen.tsx (modified)
FOUND: resources/default-characters/sui.json (modified)
FOUND: resources/default-characters/mochineko.json (modified)
FOUND: resources/default-characters/clawd.json (modified)
FOUND: electron-builder.yml (modified)
FOUND: scripts/build-default-skins.mjs (created)
FOUND: resources/skins/sui.png (created, 220 bytes)
FOUND: resources/skins/mochineko.png (created, 222 bytes)
FOUND: resources/skins/clawd.png (created, 222 bytes)
FOUND: commit 036457b (Task 1)
FOUND: commit f522d4d (Task 2)
```
