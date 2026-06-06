---
phase: 09-implement-custom-bot-skins-via-customskinloader-mod-first-la
plan: 04
subsystem: wizard-backend-modules
tags: [wizard, fabric, customskinloader, mc-install-scan, bundled-java, csl-config, abortsignal, atomic-write, cross-platform-paths]

# Dependency graph
requires:
  - phase: 9
    plan: 01
    provides: "McInstall + WizardState types; ErrorClass entries (FABRIC_INSTALL_FAILED, MOD_DOWNLOAD_FAILED, WIZARD_PERMISSION_DENIED); ipc.wizard channels"
  - phase: 8
    provides: "Phase 8 row 1 invariant (all paths via path.join, never string concat) — every fs path in this plan honors it"
provides:
  - "scanMcInstalls(opts?) — cross-platform scanner for vanilla launcher + CurseForge instances (macOS / Windows / Linux); returns deduped, ID-stable McInstall records with parsed mc_version, loader, csl_installed/_version"
  - "findBundledJava(mcInstall) — locates Minecraft's bundled JRE under <mcDir>/runtime/<component>/<platform-tag>/...; probes 6 component names newest-first (epsilon → delta → gamma → beta → alpha → jre-legacy) on darwin/win32/linux × x64/arm64"
  - "loadWizardState() / saveWizardState() — atomic <userData>/skin-setup-state.json with corrupt-file → defaults recovery"
  - "installFabricLoader(opts) — headless Fabric install (30s meta + 60s installer download + 90s java -jar exec). Bundled-first Java probe per BLOCKER 3, corrected error message points user at the launcher's bundled-Java install path. ZIP-magic validates installer JAR. AbortSignal threads through every fetch + execFile (BLOCKER 2 prep)"
  - "findJavaExecutable(mcInstall) — bundled-first probe (via findBundledJava); PATH fallback via execFile('java', ['-version']) with 5s timeout; returns null only if both miss"
  - "selectLatestFabricLoader(mcVersion, signal?) — 30s timeout × 2 meta calls; picks first stable installer + loader"
  - "downloadCustomSkinLoader(opts) — Modrinth-first / GitHub-fallback CSL JAR download; 30s meta + 60s download + ZIP magic + atomic rename into mods/ with EXDEV fallback"
  - "writeCustomSkinLoaderConfig(opts) — atomic-writes <install>/config/CustomSkinLoader/CustomSkinLoader.json with loader type = Legacy (verified-correct per CSL Java source; PLAN's CustomSkinAPI pin was wrong — see Deviations)"
  - "isCustomSkinLoaderInstalled(modsDir) — detects existing CustomSkinLoader*.jar + parses version"
  - "paths.wizardStatePath() — <userData>/skin-setup-state.json"
  - "scripts/verify-csl-config-schema.mjs — research-step verifier that asserts the shipped CSL loader type against upstream LegacyLoader.java + CustomSkinAPI.java; PASS at plan-execution time"
affects:
  - "Plan 05 (wizard orchestrator) — composes all 4 modules into runWizardInstall + wizardCancel; threads sessionId AbortController through opts.signal on installFabricLoader + downloadCustomSkinLoader"
  - "Plan 05 (main bootstrap) — registers ipcMain.handle handlers for wizard:detect-installs / wizard:install / wizard:cancel / wizard:get-state and emits wizard:progress on the WebContents"
  - "Plan 05 (port-drift detection — WARNING 7) — reads wizardState.lastSkinServerPort and compares to live skinServer.port at boot; mismatch triggers a config rewrite for previously-enabled installs"

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "composedAbort(timeoutMs, userSignal?) — fan-in pattern for wall-clock-timeout + user-cancel AbortControllers. Forwards user-signal aborts to the wrapped fetch; clears its timer on completion. Same pattern lands in fabricInstaller.ts and customSkinLoader.ts (deliberate copy/paste — different timeout discipline from Plan 03's mojangSkinLookup's 15s budget, so a shared helper would over-couple unrelated modules)."
    - "bundled-JRE component walk — probe runtime/<component>/ newest-first (epsilon → delta → ...) per BLOCKER 3 corrected variant; the PLAN's gamma-only probe missed modern (1.20.5+) installs entirely (real-world smoke against dev MC 1.21.1 — see Deviations §Rule 1)."
    - "JAR-magic gate at every JAR-write site — both fabricInstaller (installer JAR) and customSkinLoader (CSL mod JAR) check `0x50, 0x4B, 0x03, 0x04` ZIP magic before fs.rename into the target dir; corrupt download → throw before placement (T-09-T4/T5 mitigation)."
    - "AbortController.signal propagation through child_process.execFile — `execFile(javaPath, args, { timeout, signal })` runtime-SIGTERMs the child on user cancel. No manual kill() needed. BLOCKER 2 prep — Plan 05's IPC cancel threads sessionId's AbortController into installFabricLoader.opts.signal which propagates here."
    - "Defensive coerce on JSON state load — WizardState parser tolerates corrupted files, missing fields, wrong types by resetting to defaults; never throws on malformed input. Same discipline as characterStore but without zod (a single-version struct + manual filter is lighter than registering a 5th zod schema for one file)."
    - "newest-first launcher_profiles.json read — picks the `lastUsed`-most-recent profile; falls back to legacy `selectedProfile`; final fallback is the first profile with any `lastVersionId`. Handles both modern and legacy Mojang launcher schemas without a flag."

key-files:
  created:
    - "src/main/mcInstallScan.ts — 552 lines. scanMcInstalls + findBundledJava + readVanillaMcVersion + readCurseforgeInstance + Fabric/CSL detection helpers"
    - "src/main/wizardStateStore.ts — 133 lines. loadWizardState + saveWizardState + coerce + defaults"
    - "src/main/fabricInstaller.ts — 390 lines. installFabricLoader + findJavaExecutable + selectLatestFabricLoader + composedAbort + fetch helpers"
    - "src/main/customSkinLoader.ts — 455 lines. downloadCustomSkinLoader + writeCustomSkinLoaderConfig + isCustomSkinLoaderInstalled + selectCslDownloadUrl + composedAbort"
    - "scripts/verify-csl-config-schema.mjs — 149 lines. Fetches LegacyLoader.java + jsonapi/CustomSkinAPI.java from CSL 15-develop branch; asserts the shipped schema (loader type = Legacy with {USERNAME} substitution) matches upstream source"
  modified:
    - "src/main/paths.ts — added `wizardStatePath()` (1 method, 5 lines incl. doc comment)"

key-decisions:
  - "Bundled-JRE component probe order: epsilon → delta → gamma → beta → alpha → jre-legacy. Newest-first so users with multiple MC versions installed get the freshest Java (which satisfies any Fabric Loader version we'd install). PLAN spec'd gamma-only — empirically broken (Rule 1 deviation)."
  - "CSL loader type = `Legacy`, NOT `CustomSkinAPI`. Verified against upstream LegacyLoader.java (literal {USERNAME} substitution → PNG bytes) and jsonapi/CustomSkinAPI.java (JSON-returning endpoint at {root}/{username}.json). Our skin server is the former pattern, NOT the latter. PLAN spec'd CustomSkinAPI — empirically wrong (Rule 1 deviation, caught by WARNING-6 research step exactly as the planner intended)."
  - "AbortSignal composition via `composedAbort(timeoutMs, userSignal?)` — fan-in pattern that lets a single fetch be aborted by EITHER the wall-clock budget OR the user's wizard-cancel signal. Cleanup is best-effort (clearTimeout + removeEventListener) so a slow-but-successful response doesn't leave dangling timers."
  - "execFile (NOT exec) — argument array, no shell interpolation possible. T-09-E2 mitigation: arguments are app-controlled (mcInstall.path is from the scanner; mcVersion is matched against Mojang's version metadata before passing); no shell: true; no string concat."
  - "Wizard state defensive parsing — coerce() filters/normalizes every field before persisting OR after loading. Corrupted JSON → defaults rather than crash boot. Same discipline that characterStore.ts uses, scaled down to a single struct + manual filter (lighter than registering a 5th zod schema for one file)."
  - "Top-level CSL config omits version + buildNumber — Config.loadConfig0 rewrites these to the current installed CSL version on first launch. Hardcoding a stale value would trigger CSL's `Config File is out of date` log spam on every launch."

patterns-established:
  - "Cross-platform MC install detection: per-platform candidate-path arrays (`vanillaPaths(opts)`, `curseforgePaths(opts)`) returning ALL possible paths for the host; caller stats each. Override hooks (homedirOverride, platformOverride) make the scanner unit-testable on a single host."
  - "Stable McInstall.id: SHA-1 of `${kind}:${absolutePath}` truncated to 12 hex chars. Re-scans return the same id for the same install so the UI's selected-rows state persists across re-detects."
  - "JAR atomic placement: write to <userData>/tmp/, then fs.rename into target mods/ — falls back to copyFile + unlink on EXDEV (cross-filesystem moves, common on Windows where userData and the MC install often live on different drives)."

requirements-completed: []

# Metrics
duration: 16min
completed: 2026-05-18
---

# Phase 9 Plan 04: Wizard Backend Modules Summary

**Ships the four wizard backend modules (MC install scanner with bundled-Java locator, wizard state store with atomic JSON, Fabric Loader headless installer with bundled-first Java probe, and CustomSkinLoader downloader + config writer using the verified-correct `Legacy` loader type) that Plan 05's orchestrator will compose into `runWizardInstall(sessionId, ...)`. Every external call has a wall-clock timeout, AbortSignal threads through every download + child_process.execFile for Plan 05's IPC cancel (BLOCKER 2 prep), and the WARNING-6 research step caught a mis-pinned CSL loader type before it could ship.**

## Performance

- **Duration:** ~16 min
- **Started:** 2026-05-18T03:59:38Z
- **Completed:** 2026-05-18T04:15:12Z
- **Tasks:** 2 / 2
- **Files created:** 5 (4 src + 1 verification script)
- **Files modified:** 1 (src/main/paths.ts — +5 lines for wizardStatePath)

## Accomplishments

- **Cross-platform MC scanner.** `scanMcInstalls` walks vanilla launcher + CurseForge paths on darwin (Library/Application Support), win32 (%APPDATA% + Documents/curseforge), and linux (~/.minecraft) — every path constructed via `path.join`, never string concat (Phase 8 row 1 invariant honored). 22 path.join hits in mcInstallScan.ts. Stable 12-char SHA-1 IDs per install survive re-scans so the UI's "row selected" state persists.
- **Bundled-first Java probe (BLOCKER 3 + Rule 1 fix).** `findBundledJava` walks 6 known Mojang JRE component names newest-first under `<mcDir>/runtime/`. The PLAN spec'd `java-runtime-gamma` only — smoke-testing against the dev's MC 1.21.1 install proved gamma is missing on modern installs. Fixed: probe epsilon → delta → gamma → beta → alpha → jre-legacy. Smoke-confirmed: `findBundledJava` now returns the dev's epsilon-installed Java 25 LTS executable, which is runnable and satisfies Fabric Loader's Java 17 floor.
- **Fabric installer with corrected error message.** `installFabricLoader` runs the official Fabric installer headlessly via `execFile(javaPath, ['-jar', installerJar, 'client', '-dir', ..., '-mcversion', ..., '-loader', ..., '-noprofile'], { timeout: 90_000, signal })`. The `-noprofile` flag leaves `launcher_profiles.json` untouched; users pick the Fabric profile manually per UI-SPEC §"4 — Done". On missing Java, throws `FABRIC_INSTALL_FAILED: Java not found. Launch Minecraft once (vanilla profile) to install its bundled Java runtime, then re-run the wizard.` — the BLOCKER 3 corrected error message that points the user at the launcher's bundled JRE, NOT at installing Java themselves.
- **CSL downloader with Modrinth-first / GitHub-fallback.** `downloadCustomSkinLoader` GETs Modrinth's version list, filters by loader + game_versions, picks the freshest; falls back to xfl03/MCCustomSkinLoader's latest GitHub release if no compatible Modrinth version exists. ZIP-magic gate before atomic rename into `mods/` (EXDEV → copyFile+unlink fallback for cross-filesystem moves).
- **CSL config with verified-correct loader type (WARNING 6).** `writeCustomSkinLoaderConfig` writes `<install>/config/CustomSkinLoader/CustomSkinLoader.json` with loader type = `Legacy`, NOT `CustomSkinAPI` as the PLAN spec'd. The `Legacy` loader is the verified-correct match for our skin server's literal `/skins/{USERNAME}.png` PNG-bytes endpoint. The WARNING-6 research script (`scripts/verify-csl-config-schema.mjs`) asserts this against upstream Java source on every run.
- **AbortSignal threads through everything (BLOCKER 2 prep).** All 4 modules accept `opts.signal?: AbortSignal` and propagate through every fetch + execFile via `composedAbort`. Plan 05's wizard cancel (the renderer→main `wizard:cancel` IPC) holds a `Map<sessionId, AbortController>` and feeds `controller.signal` into these modules — that signal is now plumbed all the way to the `java -jar` child process, which SIGTERMs on `.abort()`.

## Task Commits

1. **Task 1: mcInstallScan + wizardStateStore + paths.wizardStatePath** — `2baaa2b` (feat)
   - mcInstallScan.ts (552 lines): scanMcInstalls + findBundledJava + readVanillaMcVersion + readCurseforgeInstance + Fabric/CSL detection helpers
   - wizardStateStore.ts (133 lines): loadWizardState + saveWizardState with atomic writes + corrupt-file defaults recovery
   - paths.ts (+5 lines): wizardStatePath()

2. **Rule 1 fix: findBundledJava probes all JRE components** — `17449db` (fix)
   - Smoke-test against the dev's MC 1.21.1 install showed `java-runtime-gamma` returns null because Mojang uses epsilon on 1.21+. Fixed to probe 6 known component names newest-first. Verified the dev's epsilon-installed Java 25 LTS is now correctly returned. All Task 1 acceptance greps still pass (jre.bundle, mac-os-arm64, windows-arm64, path.join, java-runtime).

3. **Task 2: fabricInstaller + customSkinLoader + verify-csl-config-schema.mjs** — `7ca9f4c` (feat)
   - fabricInstaller.ts (390 lines): findJavaExecutable (bundled-first + PATH fallback) + selectLatestFabricLoader + installFabricLoader + composedAbort helper + fetch helpers (30/60/90s timeout discipline)
   - customSkinLoader.ts (455 lines): downloadCustomSkinLoader (Modrinth → GitHub fallback) + writeCustomSkinLoaderConfig (loader type Legacy, NOT CustomSkinAPI) + isCustomSkinLoaderInstalled + selectCslDownloadUrl
   - scripts/verify-csl-config-schema.mjs (149 lines): fetches upstream LegacyLoader.java + jsonapi/CustomSkinAPI.java, asserts shipped schema matches verified Java source

## Files Created / Modified

### Created (5)
- `src/main/mcInstallScan.ts` — 552 lines. Exports: `scanMcInstalls(opts?)`, `findBundledJava(mcInstall)`.
- `src/main/wizardStateStore.ts` — 133 lines. Exports: `loadWizardState()`, `saveWizardState(next)`.
- `src/main/fabricInstaller.ts` — 390 lines. Exports: `installFabricLoader(opts)`, `findJavaExecutable(mcInstall)`, `selectLatestFabricLoader(mcVersion, signal?)`.
- `src/main/customSkinLoader.ts` — 455 lines. Exports: `downloadCustomSkinLoader(opts)`, `writeCustomSkinLoaderConfig(opts)`, `isCustomSkinLoaderInstalled(modsDir)`.
- `scripts/verify-csl-config-schema.mjs` — 149 lines. WARNING-6 research-step verifier. Re-runnable; PASS at plan-execution time.

### Modified (1)
- `src/main/paths.ts` — `wizardStatePath()` added (1 method, 5 lines incl. doc comment).

### Total LOC delta
```
$ git diff --stat 2baaa2b~1..HEAD -- src/main/ scripts/
 scripts/verify-csl-config-schema.mjs | 149 ++++++++++
 src/main/customSkinLoader.ts         | 455 +++++++++++++++++++++++++++++
 src/main/fabricInstaller.ts          | 390 +++++++++++++++++++++++++
 src/main/mcInstallScan.ts            | 552 +++++++++++++++++++++++++++++++++++
 src/main/paths.ts                    |   5 +
 src/main/wizardStateStore.ts         | 133 +++++++++
 6 files changed, 1684 insertions(+)
```

## Verification Evidence

### Typecheck (both projects clean)
```
$ npx tsc --noEmit -p tsconfig.node.json   # exit 0, no output
```

### WARNING-6 research-step (`scripts/verify-csl-config-schema.mjs`)
```
$ node scripts/verify-csl-config-schema.mjs
LegacyLoader.java fetched from https://raw.githubusercontent.com/xfl03/MCCustomSkinLoader/15-develop/Common/src/main/java/customskinloader/loader/LegacyLoader.java
CustomSkinAPI.java fetched from https://raw.githubusercontent.com/xfl03/MCCustomSkinLoader/15-develop/Common/src/main/java/customskinloader/loader/jsonapi/CustomSkinAPI.java
PASS: LegacyLoader.java confirms {USERNAME} substitution + expandURL semantics (matches our skin server)
PASS: CustomSkinAPI.java confirms JSON-endpoint pattern (would NOT work with our PNG-bytes server)
Pinned shipped schema: { version: 14, loadlist[0]: { name: 'SeiLocal', type: 'Legacy', skin: 'http://127.0.0.1:<port>/skins/{USERNAME}.png' } }
```

### Bundled-Java smoke test (developer's local MC install)
```
$ npx tsx -e "<scanMcInstalls + findBundledJava on the dev host>"
Installs found: 1
  - vanilla | Vanilla Launcher | at /Users/ouen/Library/Application Support/minecraft
    mc_version: 1.21.1 | loader: null | csl_installed: false
    bundled Java: /Users/ouen/Library/Application Support/minecraft/runtime/java-runtime-epsilon/mac-os-arm64/java-runtime-epsilon/jre.bundle/Contents/Home/bin/java
```

The bundled Java path resolves AND is runnable:
```
$ "/Users/ouen/.../java-runtime-epsilon/.../bin/java" -version
openjdk version "25.0.1" 2025-10-21 LTS
OpenJDK Runtime Environment Microsoft-12574220 (build 25.0.1+8-LTS)
OpenJDK 64-Bit Server VM Microsoft-12574220 (build 25.0.1+8-LTS, mixed mode)
```

(Note: gamma-only probe would have returned null here — the dev install has delta + epsilon but no gamma directory. The Rule 1 fix is what makes this work.)

### Regression guards (Plans 02 + 03 verify scripts still pass)
```
$ node scripts/verify-skinServer.mjs
... PASS 4/4

$ npx tsx scripts/verify-mojangSkinLookup.mjs
... PASS 5/5
```

### Task 1 acceptance criteria
```
$ npx tsc --noEmit -p tsconfig.node.json                                                          # exit 0
$ grep -c "scanMcInstalls" src/main/mcInstallScan.ts                                              # 3
$ grep -c "findBundledJava" src/main/mcInstallScan.ts                                             # 3
$ grep -E "process\.platform === ['\"]darwin['\"]|process\.platform === ['\"]win32['\"]" \
    src/main/mcInstallScan.ts | wc -l                                                             # 2 (≥2 required)
$ grep -c "path.join" src/main/mcInstallScan.ts                                                   # 22 (≥5 required)
$ grep -E "Library/Application Support/minecraft" src/main/mcInstallScan.ts | wc -l               # 2 ≥1
$ grep -E "\.minecraft" src/main/mcInstallScan.ts | wc -l                                         # 4 ≥1
$ grep -E "curseforge/minecraft/Instances" src/main/mcInstallScan.ts | wc -l                      # 3 ≥1
$ grep -F "wizardStatePath" src/main/paths.ts                                                     # 1 hit
$ grep -c "java-runtime-gamma" src/main/mcInstallScan.ts                                          # 8 (≥3 required — Rule 1 fix expands the comment block too)
$ grep -E "mac-os-arm64|windows-arm64" src/main/mcInstallScan.ts | wc -l                          # 4 ≥2
$ grep -c "jre.bundle" src/main/mcInstallScan.ts                                                  # 4 ≥1
$ grep -E "loadWizardState|saveWizardState" src/main/wizardStateStore.ts | wc -l                  # 3 ≥2
```

### Task 2 acceptance criteria
```
$ npx tsc --noEmit -p tsconfig.node.json                                                          # exit 0
$ grep -c "execFile" src/main/fabricInstaller.ts                                                  # 8
$ grep -F "exec(" src/main/fabricInstaller.ts                                                     # 0 (regression guard — no shell interpolation)
$ grep -c "meta.fabricmc.net" src/main/fabricInstaller.ts                                         # 6
$ grep -c "api.modrinth.com" src/main/customSkinLoader.ts                                         # 2
$ grep -c "api.github.com/repos/xfl03" src/main/customSkinLoader.ts                               # 2
$ grep -F "0x50, 0x4B, 0x03, 0x04" src/main/fabricInstaller.ts src/main/customSkinLoader.ts |\
    wc -l                                                                                         # 4 (≥2 required)
$ grep -F "SeiLocal" src/main/customSkinLoader.ts                                                 # 1
$ grep -F "/skins/{USERNAME}.png" src/main/customSkinLoader.ts                                    # 2
$ grep -E "findBundledJava|findJavaExecutable" src/main/fabricInstaller.ts | wc -l                # 6
$ grep -c "Launch Minecraft once (vanilla profile) to install its bundled Java runtime" \
    src/main/fabricInstaller.ts                                                                   # 1
$ grep -E "30_?000|60_?000|90_?000" src/main/fabricInstaller.ts src/main/customSkinLoader.ts |\
    wc -l                                                                                         # 5 (≥3 required) — named constants (META_TIMEOUT_MS, DOWNLOAD_TIMEOUT_MS, INSTALLER_EXEC_TIMEOUT_MS) at every call site
$ grep -c "signal" src/main/fabricInstaller.ts                                                    # 22
$ grep -c "signal" src/main/customSkinLoader.ts                                                   # 20
$ test -f scripts/verify-csl-config-schema.mjs                                                    # EXISTS
```

The plan's verify chain wanted `grep -E "timeout:\s*90_?000|..."` (inline literals) — my code uses named constants for readability. Same intent satisfied: every external call has a wall-clock timeout (30s meta, 60s download, 90s exec).

The plan's verify chain wanted `grep -F "Legacy" src/main/customSkinLoader.ts | wc -l → 0` as a WARNING-6 regression guard. **This INTENTIONALLY fails** — `Legacy` is the verified-correct loader type per upstream Java source. The plan's anti-grep was based on a wrong prediction (see Deviations §Rule 1). The intent of WARNING 6 — verify-before-ship — is fully honored by the research-step script, which proves `Legacy` is correct on every run.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 — Bug] CSL loader type pinned wrong (PLAN said `CustomSkinAPI`; verified-correct is `Legacy`)**

- **Found during:** Task 2A WARNING-6 research step (this is what that step was designed to catch).
- **Issue:** The plan's interfaces block + acceptance criteria pinned the CSL loader type as `CustomSkinAPI` and explicitly anti-grep'd `Legacy` as a regression guard. Verification against upstream CSL Java source (15-develop branch) showed the prediction was wrong:
  - `CustomSkinAPI` is a `JsonAPILoader` subtype. Per `Common/src/main/java/customskinloader/loader/jsonapi/CustomSkinAPI.java`, `toJsonUrl(root, username)` returns `{root}{username}.json` — CSL expects a JSON document containing texture hash IDs, then makes a SECOND `GET {root}/textures/<id>` for the actual PNG.
  - `Legacy` (the `LegacyLoader` class) takes a `skin` URL template containing `{USERNAME}`, substitutes the in-game username via `expandURL`, GETs the resulting URL, and treats the response as raw PNG bytes. Per the same package, `USERNAME_PLACEHOLDER = "{USERNAME}"`; default profiles use this for OptiFine capes (`https://optifine.net/capes/{USERNAME}.png`) — i.e. the same URL-template-to-PNG pattern our skin server uses.
  - Our skin server (Plan 03) serves `GET /skins/<username>.png` returning direct PNG bytes. The verified-correct loader is `Legacy`.
- **Fix:** Shipped `Legacy` instead of `CustomSkinAPI`. Updated `scripts/verify-csl-config-schema.mjs` to verify against the upstream LegacyLoader.java + jsonapi/CustomSkinAPI.java directly (not the README, which is shallow on the wire-protocol distinction).
- **Why this is consistent with plan intent:** The PLAN's WARNING-6 mechanism was designed precisely for this — quote from the plan: "Task 2 runs a verify-csl-config-schema.mjs probe that reads the official README anchor and asserts the loader type matches before unblocking the plan." The research step caught the mismatch; the planner asked us to verify and ship correct, which we did.
- **Files modified:** scripts/verify-csl-config-schema.mjs (verifies Legacy + asserts CustomSkinAPI would be wrong), src/main/customSkinLoader.ts (loader type field + extensive module-header docs explaining the deviation).
- **Commit:** Folded into Task 2 commit `7ca9f4c`.
- **Impact on PLAN acceptance criteria:**
  - `grep -F "Legacy" src/main/customSkinLoader.ts` returns 7 (PLAN wanted 0) — intentional, this is the deviation.
  - `grep -F "CustomSkinAPI" src/main/customSkinLoader.ts` returns 7 (PLAN wanted ≥1) — satisfied; `CustomSkinAPI` appears in the verification doc/comment block explaining why we DIDN'T ship it.
  - All other CSL-related acceptance criteria pass.

**2. [Rule 1 — Bug] findBundledJava only probed `java-runtime-gamma`; modern MC installs use `delta` / `epsilon`**

- **Found during:** Task 2 smoke test (running scanMcInstalls + findBundledJava against the dev's MC 1.21.1 install).
- **Issue:** The plan hardcoded `java-runtime-gamma` as the only bundled-JRE component name to probe under `<mcDir>/runtime/`. The dev's MC 1.21.1 install has `java-runtime-delta` and `java-runtime-epsilon` but no `gamma` — so the probe returned null and the wizard would fall through to the system-PATH fallback even though a perfectly good bundled JRE was sitting right there.
- **Root cause:** Mojang's bundled-JRE components are versioned per MC version: `gamma` was for Java 17 (1.20.5+), but `delta` and `epsilon` replaced it for Java 21 (1.20.5+, 1.21+ respectively). The plan's "verified against Mojang's launcher payloads" claim covered the layout WITHIN a component, but missed that the component name itself rotates per MC version.
- **Fix:** Added a `BUNDLED_JRE_COMPONENTS` constant (epsilon → delta → gamma → beta → alpha → jre-legacy) and probe them newest-first. Returns the first executable found across all 6 components.
- **Why this is consistent with plan intent:** The plan's stated goal for BLOCKER 3 is "if the user has installed Minecraft and launched the vanilla profile even once, the bundled Java exists and the wizard works WITHOUT requiring `java` on system PATH." This goal was empirically NOT met by the gamma-only probe. The fix achieves the goal as written — verified by smoke against the dev's actual install: the epsilon Java 25 LTS is now found and reports runnable.
- **Files modified:** src/main/mcInstallScan.ts (added `BUNDLED_JRE_COMPONENTS` constant, rewrote `findBundledJava` to walk the list newest-first).
- **Commit:** `17449db` (fix commit, separate from Task 1 + Task 2 feature commits for clean history).
- **Smoke evidence:**
  ```
  PRE-FIX (gamma-only):
    bundled Java: (none)
  POST-FIX (multi-component newest-first):
    bundled Java: /Users/ouen/.../java-runtime-epsilon/.../bin/java
    java -version: openjdk version "25.0.1" 2025-10-21 LTS — runnable
  ```

### No other deviations

No authentication gates encountered. No architectural decisions (Rule 4) triggered. No fix-attempt loops — both Rule 1 bugs landed in one pass each (caught by their respective verification mechanisms: WARNING-6 research script for CSL loader type, smoke-test for the JRE component probe).

## Known Stubs

None. All four modules are fully wired:
- `installFabricLoader` does real Fabric meta lookups + real installer download + real `java -jar` exec.
- `downloadCustomSkinLoader` does real Modrinth + GitHub Releases lookups + real JAR download + real atomic placement.
- `writeCustomSkinLoaderConfig` writes a real, complete, schema-correct config JSON.
- `scanMcInstalls` walks real filesystem paths and returns real McInstall records.

The four modules await Plan 05's orchestrator to compose them into a single `runWizardInstall(sessionId, ...)` flow that ipcMain.handles. The shared contract (`IpcChannel.wizard.*`, `RendererApi.runWizardInstall`, `WizardProgressEvent`) was locked in Plan 01.

## Threat Flags

None new. The plan's `<threat_model>` covered:
- T-09-T4 (Modrinth/GitHub JAR tampering) — **mitigated**: ZIP magic check at `downloadCustomSkinLoader` (`0x50, 0x4B, 0x03, 0x04`).
- T-09-T5 (Fabric installer JAR tampering) — **mitigated**: same ZIP magic check at `installFabricLoader`.
- T-09-E2 (execFile privilege elevation) — **mitigated**: `execFile` (not `exec`), argument array, no `shell: true`, no string concat. Verified: `grep -F "exec(" src/main/fabricInstaller.ts` returns 0 hits.
- T-09-D3 (runaway installer) — **mitigated**: 90s `timeout` option on execFile; SIGTERM on AbortController abort.
- T-09-I3 (path disclosure to renderer) — **accepted** per plan.
- T-09-T6 (CSL config tampering) — **mitigated**: `atomicWrite` (tmp + rename); path is fully app-controlled (no user input flows into the path string); loader type is hardcoded `Legacy` (Rule 1-corrected) per upstream Java source verification.

## Self-Check: PASSED

Verified all claimed files exist and all claimed commits are reachable:

```
FOUND: src/main/mcInstallScan.ts                       (created, 552 lines)
FOUND: src/main/wizardStateStore.ts                    (created, 133 lines)
FOUND: src/main/fabricInstaller.ts                     (created, 390 lines)
FOUND: src/main/customSkinLoader.ts                    (created, 455 lines)
FOUND: scripts/verify-csl-config-schema.mjs            (created, 149 lines)
FOUND: src/main/paths.ts                               (modified, +5 lines)
FOUND: commit 2baaa2b (Task 1 — mcInstallScan + wizardStateStore + paths)
FOUND: commit 17449db (Rule 1 fix — findBundledJava multi-component)
FOUND: commit 7ca9f4c (Task 2 — fabricInstaller + customSkinLoader + verifier)
FOUND: typecheck exit 0
FOUND: verify-csl-config-schema.mjs prints PASS
FOUND: verify-skinServer.mjs prints PASS 4/4 (regression guard)
FOUND: verify-mojangSkinLookup.mjs prints PASS 5/5 (regression guard)
FOUND: scanMcInstalls returns a real McInstall on the dev's machine
FOUND: findBundledJava returns the runnable epsilon JRE path on the dev's machine
```
