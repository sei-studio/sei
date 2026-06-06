---
quick_id: 260518-o1k
slug: sei-mod-compatibility-launcher-conflict-
mode: quick
status: ready-for-execution
honors: CONTEXT.md D1–D5 (NON-NEGOTIABLE)
---

# PLAN — Sei mod-compatibility & launcher-conflict resolution

## Objective

Stop Fabric Loader from rejecting "Sei" profile launches when the user's
`<.minecraft>/mods/` contains MC-version-mismatched mods. Achieve this by:

1. Always isolating Sei behind its own `gameDir` (`<.minecraft>/sei/`) for
   vanilla installs (D1).
2. Parsing mod metadata from JAR central directories and auto-linking only
   the compatible subset of the user's mods into the Sei `gameDir` (D2).
3. Adding read-only Lunar Client detection with a "limited" compatibility
   badge (D3, minimal scope).
4. Surfacing the link/exclusion summary in the wizard UI (D2 visibility).
5. Inline-warning on pre-1.14 MC version detection (D4).

CurseForge path is unchanged in behavior (D5) — only the placement-target
abstraction lands (T5) so vanilla can take its own branch.

## Cross-cutting constraints (apply to every task)

These are CLAUDE.md / CONTEXT.md invariants. Any task that violates one is a
failed task regardless of acceptance-line completion.

- **Wall-clock timeout on every external call.** The new ZIP parser
  (`modScanner.ts`) reads files synchronously off local disk via `yauzl` —
  no network, no IPC, no subprocess — so it does NOT need a wall-clock
  timeout. Document this in the file header so a future reader doesn't
  re-introduce a timeout reflexively. Every other new code path (none
  currently planned) inherits the existing
  `composedAbort(timeoutMs, userSignal)` pattern from `fabricInstaller.ts`.
- **Hardlink fallback chain (T6).** `fs.link → fs.symlink → fs.copyFile`.
  Each level wrapped in its own try/catch with the failure reason logged at
  `warn` level (so diagnostics survive). The per-JAR link manifest records
  which of the three strategies succeeded under a `strategy` field
  (`'link' | 'symlink' | 'copy'`) for triage.
- **CSL JAR is never eligible for mod-link scan.** The scanner in T6 MUST
  filter out any JAR whose filename matches the existing
  `/^CustomSkinLoader[_-].*\.jar$/i` regex (already defined in
  `customSkinLoader.ts` / `mcInstallScan.ts`). If the user has dropped a
  random CSL build into `<.minecraft>/mods/`, we ignore it — Sei always
  installs its own into `<sei gameDir>/mods/`.
- **Idempotency / reconciliation (T6).** Re-running the wizard on the same
  install reconciles `<sei gameDir>/mods/` against
  `<.minecraft>/mods/`. Algorithm:
  1. List entries in `<sei gameDir>/mods/`.
  2. For each entry, if it matches the CSL regex, leave it alone.
  3. Otherwise, look up the entry in the persisted link manifest. If its
     source path (under `<.minecraft>/mods/`) no longer exists OR re-scanning
     the source returns `compatible: false`, `fs.unlink` the entry and drop
     it from the manifest.
  4. After cleanup, walk the source mods/ again; for each currently-
     compatible JAR not already linked, perform the hardlink-fallback chain
     and append to the manifest.
  5. Atomic-write the new manifest. (Use the existing
     `src/bot/brain/storage/atomicWrite.js` helper for consistency with how
     `customSkinLoader.ts` writes its config.)
- **Cancellation (T6).** Every long-running step honors the existing
  `signal: AbortSignal` threaded through `wizard.ts → installFabricLoader /
  downloadCustomSkinLoader`. The new `'mods-linking'` stage MUST check
  `signal.aborted` once per JAR (between scan and link) and throw
  `MOD_DOWNLOAD_FAILED: cancelled` on abort so existing
  `isCancellationError` branches unwind cleanly.
- **Cross-platform paths.** All new path construction via `path.join`.
  Never concat. Lunar candidate paths (T3) MUST go through `path.join` even
  when they only have one segment beyond home.
- **Zod-validated IPC (T2).** Today there are NO inbound zod schemas for
  `McInstall` / `WizardProgressEvent` — they cross IPC as untyped TS shapes
  emitted by main. The new fields therefore don't require zod-gate edits at
  the IPC boundary. They DO require the TS type union changes to compile in
  both `src/main/` and `src/renderer/`. Document this asymmetry in T2 so a
  future security pass doesn't conclude the changes were skipped.

## Out of scope (explicit non-goals — boundary visibility)

Per CONTEXT.md §"Scope boundaries":

- Modded items / blocks / recipes / game-rule awareness in bot LLM.
- NeoForge installer (continue treating `neoforge-X` as forge for CSL).
- Prism / MultiMC / Modrinth / ATLauncher / GDLauncher detection.
- Manual "Browse for folder" install picker.
- User-facing MC-version picker UI.
- Per-JAR "force include" toggle in wizard UI.
- `neoforge.mods.toml` parsing or language-loader auto-detection.
- v0.1.1 migration beyond the optional orphan cleanup in T9.
- Functional integration with Lunar Client (detection only — no Fabric/CSL
  install path for Lunar rows).

## Tasks

Tasks are ordered so each leaves the codebase in a working state. The wave
intent: T1 is pure / standalone, T2 unblocks types for T3+T7, T3–T8 build
in dependency order, T9 is optional and last.

---

### T1 — ZIP central-directory mod-metadata parser

**Goal.** Add a pure, network-free function `scanModJar(jarPath, targetMc)`
that reads `fabric.mod.json` and/or `META-INF/mods.toml` out of a JAR's
ZIP central directory and returns whether the JAR's declared minecraft
version constraint is satisfied by `targetMc`.

**Files modified / created.**
- `src/main/modScanner.ts` — NEW.
- `scripts/test-modScanner.mjs` — NEW (Node script harness; no test
  framework — follows the existing `scripts/test-*.mjs` convention seen
  throughout the codebase).

**Action.**
1. Create `src/main/modScanner.ts` exporting:
   ```ts
   export type ModCompatibility =
     | { compatible: true;  loader: 'fabric' | 'forge'; modId: string; modVersion: string; declaredMc: string }
     | { compatible: false; loader: 'fabric' | 'forge'; modId: string; modVersion: string; declaredMc: string; reason: 'mc-version-mismatch' }
     | { compatible: false; loader: null;               reason: 'unparseable' | 'no-metadata' | 'read-error'; detail?: string };

   export async function scanModJar(jarPath: string, targetMc: string): Promise<ModCompatibility>;
   ```
2. Use `yauzl` (already in `package-lock.json` transitively via mineflayer;
   add a top-level dependency entry if `import yauzl from 'yauzl'` doesn't
   resolve from a clean install — the package is small and stable). Open the
   JAR with `lazyEntries: true`, walk entries until either
   `fabric.mod.json` (Fabric, JSON at the JAR root) OR `META-INF/mods.toml`
   (Forge, TOML) is seen, then read just that entry. Stop on first match.
3. Fabric branch: parse JSON. Pull `id`, `version`, and
   `depends.minecraft` (string OR array OR omitted). Normalize: if array,
   take the first string entry; if omitted, treat as `no-metadata`.
4. Forge branch: parse `mods.toml`. Use a minimal in-house TOML reader (the
   file is small; tomli/smol-toml is fine if already in lockfile — verify
   before adding a new dep) — extract `mods.modId`, `mods.version`, and
   the first `[[dependencies."<modId>"]]` block where `modId = "minecraft"`,
   pulling `versionRange`. Forge's version range is Maven-range syntax
   (`[1.20,1.21)`); the Fabric range is semver (`>=1.21.0`, `~1.20.1`,
   `1.8.9`). Implement two small range-resolvers — keep them in this file,
   exported for the harness:
   ```ts
   export function satisfiesFabric(range: string, version: string): boolean;
   export function satisfiesForgeMavenRange(range: string, version: string): boolean;
   ```
   Use `semver` (already transitively present via mineflayer — verify with
   `require.resolve('semver')` in the harness; if absent, add as a direct
   dep) for Fabric. Forge ranges are Maven brackets — write a small parser
   covering `[a,b]`, `[a,b)`, `(a,b]`, `(a,b)`, and bare `a` (exact).
5. Returns `compatible: false, reason: 'unparseable'` on JSON / TOML parse
   error, `'no-metadata'` if neither file is present, `'read-error'` on
   yauzl I/O failure (caught + logged at `warn`).
6. NO wall-clock timeout. Document in the file header WHY: synchronous
   local-disk read, no IPC, no subprocess, no network — bounded by file size
   (<50MB typical, <2GB Pixelmon-tier). CLAUDE.md's "every external call"
   covers network / subprocess / IPC; a local fs read is not an external
   call.
7. Create `scripts/test-modScanner.mjs`. Pattern after the existing
   `scripts/test-personaExpansion.mjs` — a plain Node script, no test
   framework, exits 0 on success / 1 on failure with a printed diff. The
   script should:
   - Look for real-world JARs under `~/Library/Application Support/minecraft/mods/`
     and `~/.minecraft/mods/` (best-effort — skip with a printed notice if
     absent); for each found JAR, print `<filename>: <scan result>`.
   - Always run a synthetic fixture suite — programmatically construct
     in-memory ZIPs (using `adm-zip` if present, otherwise a few hard-coded
     PK-magic byte arrays) for:
       - Fabric mod targeting `1.21.4` against target `1.21.4` → compatible.
       - Fabric mod targeting `1.8.9` against target `1.21.4` → incompatible.
       - Forge mod with `versionRange = "[1.20,1.21)"` against `1.20.1` →
         compatible.
       - Forge mod with `versionRange = "[1.16.5]"` against `1.21.4` →
         incompatible.
       - JAR with neither metadata file → `no-metadata`.
       - JAR with malformed `fabric.mod.json` → `unparseable`.

**Acceptance.**
- `scanModJar` returns a discriminated union exactly matching the
  `ModCompatibility` type above.
- The five synthetic fixtures in the harness all return the expected
  variant.
- `scanModJar` does NOT make any network or subprocess calls (verify by
  reading the implementation — no `fetch`, no `child_process`, no
  `dgram`, no socket access).
- File header documents the "no wall-clock timeout" rationale (CLAUDE.md
  invariant compliance, with the carve-out explicit).

**Verification.**
- `npx tsc --noEmit` passes.
- `node scripts/test-modScanner.mjs` exits 0 and prints PASS for each of
  the six synthetic cases.
- `grep -E "fetch\\(|child_process|net\\." src/main/modScanner.ts` returns
  no lines (no external call surface).

**Dependencies.** None — pure additive.

**Commit.** `feat(modScanner): parse fabric.mod.json + mods.toml from JAR central directory`

---

### T2 — IPC type extensions for Lunar, compatibility, mod-link summary

**Goal.** Extend the shared IPC TS types so downstream tasks (T3, T6, T7)
have a stable contract to compile against. No behavior change in this
commit — only type widening + propagation through call-sites.

**Files modified.**
- `src/shared/ipc.ts` — extend `McInstall`, extend `WizardProgressEvent`,
  add a new `WizardInstallResult` field.

**Action.**
1. `McInstall`:
   - Widen `kind: 'vanilla' | 'curseforge'` to `'vanilla' | 'curseforge' | 'lunar'`.
   - Add `compatibility: 'full' | 'limited'` (required field —
     `'full'` for vanilla + curseforge, `'limited'` for Lunar). Default in
     the scanner; readers can rely on it being present.
2. `WizardProgressEvent`:
   - Add a new variant:
     ```ts
     | { installId: string; stage: 'mods-linking'; scanned: number; linked: number; excluded: number; totalEstimate: number | null }
     ```
   - `totalEstimate` is the count returned by the initial `readdir`; null
     before that read completes (event may fire with 0/0/null at stage
     entry).
3. `WizardInstallResult`:
   - Add optional fields:
     ```ts
     modLinkSummary?: {
       linked: number;
       excluded: number;
       linkedJars: { sourceName: string; strategy: 'link' | 'symlink' | 'copy' }[];
       excludedJars: { name: string; reason: 'mc-version-mismatch' | 'unparseable' | 'no-metadata' | 'read-error'; declaredMc?: string }[];
     };
     ```
     (Vanilla installs only; absent for curseforge/lunar.)
4. Document in a code comment that NO zod schema needs updating: inbound
   IPC arg validation in `src/main/ipc.ts` only zod-parses `runWizardInstall`
   args (sessionId/installIds/skinServerBaseUrl), `wizardCancel` args
   (sessionId), and skin args. `McInstall` and `WizardProgressEvent` are
   emitted main→renderer untyped — pure TS contract.
5. `scanMcInstalls` and all McInstall construction sites must compile.
   Since the new `compatibility` field is required, every existing
   construction in `src/main/mcInstallScan.ts` gets `compatibility: 'full'`
   added inline. (T3 then ALSO sets it on the new Lunar branch but adds
   `compatibility: 'limited'` there.)

**Acceptance.**
- The widened types compile under `tsc --noEmit` across `src/main/`,
  `src/preload/`, and `src/renderer/`.
- Every existing `McInstall` literal in the codebase has a
  `compatibility: 'full'` field.
- `WizardProgressEvent` discriminated union now includes a `'mods-linking'`
  variant.
- A comment in `src/shared/ipc.ts` records the zod-schema asymmetry.

**Verification.**
- `npx tsc --noEmit` passes.
- `grep -n "compatibility" src/shared/ipc.ts` shows the new field on
  `McInstall`.
- `grep -n "'mods-linking'" src/shared/ipc.ts` shows the new event variant.

**Dependencies.** None (additive types). MUST land before T3, T6, T7.

**Commit.** `feat(ipc): add Lunar kind, compatibility, mods-linking stage to IPC types`

---

### T3 — Lunar Client detection in scanMcInstalls

**Goal.** Surface Lunar Client installs in the wizard install list with
`kind: 'lunar'`, `compatibility: 'limited'`. No Fabric/CSL install path
attached.

**Files modified.**
- `src/main/mcInstallScan.ts` — add `lunarPaths()` + Lunar scanner branch
  inside `scanMcInstalls`.

**Action.**
1. Add a `lunarPaths(opts?)` helper, mirroring `vanillaPaths`/`curseforgePaths`:
   - darwin: `path.join(homeDir(opts), '.lunarclient')`
   - linux:  `path.join(homeDir(opts), '.lunarclient')`
   - win32:  both
     `path.join(homeDir(opts), '.lunarclient')` AND
     `path.join(process.env.LOCALAPPDATA ?? path.join(homeDir(opts), 'AppData', 'Local'), 'Programs', 'lunarclient')`.
2. For each Lunar candidate that stats as a directory, push a `McInstall`:
   ```ts
   {
     id: idFor('lunar', vp),                      // reuse stable-hash helper
     kind: 'lunar',
     label: 'Lunar Client',
     path: vp,
     mc_version: null,                            // we don't probe it; Lunar manages its own profiles
     loader: null,
     loader_version: null,
     csl_installed: false,                        // we never install into Lunar
     csl_version: null,
     sei_enabled: false,
     compatibility: 'limited',
   }
   ```
3. Extend `idFor` signature: change union to
   `'vanilla' | 'curseforge' | 'lunar'`. Trivial widen.
4. Do NOT run `detectCustomSkinLoader` on Lunar — Lunar has no
   user-accessible `mods/` and we wouldn't act on it anyway.
5. Wizard orchestrator side: T6 will skip Lunar rows up-front (early
   return), but defensive guard goes here too — the existing
   `processOneInstall` already only runs Fabric for `install.kind ===
   'vanilla'`. Add a top-of-`processOneInstall` early return when
   `install.kind === 'lunar'`: push a no-op success result with
   `ok: true` and empty version fields, and emit
   `stage: 'done'`. (This keeps the wizard from getting wedged if a
   future UI bug lets a Lunar row through the selection set.)

**Acceptance.**
- On a machine with `~/.lunarclient/` present, `scanMcInstalls` returns
  a Lunar row alongside the vanilla row.
- The Lunar row has `kind: 'lunar'`, `compatibility: 'limited'`,
  `loader: null`, `csl_installed: false`.
- `runWizardInstall` invoked with a Lunar id does NOT call
  `installFabricLoader` or `downloadCustomSkinLoader`; it emits `queued →
  done` and returns `ok: true`.

**Verification.**
- `npx tsc --noEmit` passes.
- Local smoke: `mkdir -p ~/.lunarclient && node -e "import('./out/main/mcInstallScan.js').then(m=>m.scanMcInstalls()).then(r=>console.log(r.filter(i=>i.kind==='lunar')))"`
  (or run via the Electron app and inspect the wizard list).
- A unit-style probe in `scripts/test-modScanner.mjs` or a new
  `scripts/test-lunarDetect.mjs` constructing a fixture homedir with a
  `.lunarclient/` subdir and calling `scanMcInstalls({ homedirOverride,
  platformOverride: 'darwin' })`.

**Dependencies.** T2 (needs `compatibility` field on McInstall + `'lunar'`
in the kind union).

**Commit.** `feat(mcInstallScan): detect Lunar Client install with limited compatibility marker`

---

### T4 — Fabric installer writes gameDir on the Sei profile

**Goal.** Make the Sei launcher profile use `<.minecraft>/sei/` as its
`gameDir` so Fabric Loader stops loading the shared `<.minecraft>/mods/`
against MC 1.21.4. Tighten profile matching to avoid renaming unrelated
profiles.

**Files modified.**
- `src/main/fabricInstaller.ts` — the post-install
  `launcher_profiles.json` rewrite at L388–L409.

**Action.**
1. Compute `seiGameDir = path.join(mcInstall.path, 'sei')` once at the top
   of the rename block.
2. `fs.mkdir(seiGameDir, { recursive: true })` and
   `fs.mkdir(path.join(seiGameDir, 'mods'), { recursive: true })` BEFORE
   touching `launcher_profiles.json`. (Mojang launcher tolerates a missing
   gameDir but is clearer to pre-create.)
3. Tighten the profile-key matcher. Today the code matches any key starting
   with `fabric-loader-`. Replace with an exact match on the freshly-installed
   profile key:
   ```ts
   const expectedKey = `fabric-loader-${loaderVersion}-${mcVersion}`;
   ```
   Iterate `Object.entries(parsed.profiles)`; for the entry whose KEY
   matches `expectedKey` exactly, set:
     - `prof.name = 'Sei'`
     - `prof.gameDir = seiGameDir`         (ABSOLUTE path — Mojang launcher
       accepts both relative and absolute; absolute is unambiguous across
       launcher working-dir quirks)
   If no exact match is found, fall back to the previous broad matcher BUT
   log a `warn` with both the expected key and the keys actually present —
   this lets us diagnose Fabric installer version drift.
4. Return `seiGameDir` from `installFabricLoader` so the caller (`wizard.ts`)
   can pass it to T5+T6:
   ```ts
   return { loaderVersion, seiGameDir };
   ```
   Update the return-type annotation in the function signature.
5. Update the caller in `src/main/wizard.ts` (the `processOneInstall`
   vanilla branch) to capture `seiGameDir` and pass it down. CurseForge
   branch is unaffected — `seiGameDir` is undefined there and the T5
   `targetDir` falls back to the install path as before.

**Acceptance.**
- After a successful Fabric install against a vanilla `.minecraft`:
  - `<.minecraft>/sei/` exists with a `mods/` subdir.
  - `launcher_profiles.json` shows the Sei-renamed profile with
    `gameDir: "<abs path>/sei"` and exactly one match (the Sei one).
  - Other profiles (Fabric or otherwise) are untouched.
- The Mojang launcher's "Sei" profile entry shows the new game-directory
  field (visible by clicking the profile's settings in the launcher UI).
- `installFabricLoader` return type now includes `seiGameDir: string` and
  the caller in `wizard.ts` compiles against it.

**Verification.**
- `npx tsc --noEmit` passes.
- Smoke: against a real vanilla `.minecraft`, run the wizard; inspect
  `launcher_profiles.json` and confirm the Sei profile has the
  `gameDir` field set to the absolute path of `<.minecraft>/sei`.
- `grep -n "expectedKey" src/main/fabricInstaller.ts` shows the tightened
  matcher.

**Dependencies.** T2 (no direct type usage, but the wizard.ts caller change
co-evolves with the WizardInstallResult shape).

**Commit.** `feat(fabricInstaller): set isolated gameDir on Sei profile; tighten profile match`

---

### T5 — CSL placement honors a caller-supplied targetDir

**Goal.** Decouple `customSkinLoader.ts` from the "always use mcInstall.path"
assumption. The wizard orchestrator now computes a per-install `targetDir`
(Sei gameDir for vanilla, instance dir for CurseForge) and passes it to
both CSL helpers. Forge/CurseForge behavior is unchanged.

**Files modified.**
- `src/main/customSkinLoader.ts` — extend `DownloadCustomSkinLoaderOpts`
  and `WriteCustomSkinLoaderConfigOpts`.
- `src/main/wizard.ts` — compute `targetDir` per install; pass to both
  CSL calls.

**Action.**
1. `DownloadCustomSkinLoaderOpts`: `modsDir` is already caller-supplied
   (current value is `path.join(install.path, 'mods')`). No type change
   needed here — only the call-site change in `wizard.ts`.
2. `WriteCustomSkinLoaderConfigOpts`: rename `mcInstallDir` to `targetDir`
   (the directory under which CSL writes both `CustomSkinLoader/...` and
   `config/CustomSkinLoader/...`). Update the two `path.join` calls inside
   `writeCustomSkinLoaderConfig` accordingly. Keep the dual-path write
   (root + modern) — that decision (per file header L441-445) is
   verified-correct against the installed CSL 14.x build.
3. In `src/main/wizard.ts`:
   ```ts
   // After Fabric install (vanilla only) we have seiGameDir.
   const targetDir = install.kind === 'vanilla'
     ? seiGameDir!                              // T4 returns this
     : install.path;                            // curseforge / (future) anything else
   const modsDir = path.join(targetDir, 'mods');
   // ...
   await downloadCustomSkinLoader({ ..., modsDir, ... });
   await writeCustomSkinLoaderConfig({ targetDir, loaderKind, skinServerBaseUrl });
   ```
4. CurseForge instances continue passing `install.path` as `targetDir`,
   so the on-disk CSL placement under `<cf-instance>/mods/` and
   `<cf-instance>/config/CustomSkinLoader/...` is unchanged.

**Acceptance.**
- For vanilla installs, after the wizard runs:
  - CSL JAR sits at `<.minecraft>/sei/mods/CustomSkinLoader_Fabric-X.jar`
    (NOT in `<.minecraft>/mods/`).
  - Both `<.minecraft>/sei/CustomSkinLoader/CustomSkinLoader.json` and
    `<.minecraft>/sei/config/CustomSkinLoader/CustomSkinLoader.json` exist
    with the SeiLocal loadlist entry.
- For CurseForge instances:
  - CSL JAR sits at `<instance>/mods/CustomSkinLoader_<Kind>-X.jar`
    (unchanged).
  - Both config paths exist under `<instance>/...` (unchanged).
- `writeCustomSkinLoaderConfig`'s `mcInstallDir` field is renamed to
  `targetDir`; old name does not appear anywhere in the codebase.

**Verification.**
- `npx tsc --noEmit` passes.
- `grep -rn "mcInstallDir" src/main/ src/renderer/` returns no hits.
- Smoke: run the wizard end-to-end against a vanilla install; confirm
  the four file locations above with `ls -la`.

**Dependencies.** T4 (needs `seiGameDir` from `installFabricLoader`).

**Commit.** `feat(customSkinLoader): place CSL under caller-supplied targetDir (Sei gameDir for vanilla)`

---

### T6 — Mod-link orchestrator step in wizard.ts

**Goal.** After the Fabric install and before the CSL config write (for
vanilla installs only), scan `<.minecraft>/mods/`, run T1's `scanModJar`
per non-CSL JAR, and link compatible ones into `<sei gameDir>/mods/` via
the hardlink-fallback chain. Maintain a link manifest. Reconcile on
re-run.

**Files modified.**
- `src/main/wizard.ts` — insert new `'mods-linking'` stage.
- `src/main/wizardStateStore.ts` — extend the persisted state to hold
  per-install link manifests.

**Action.**
1. In `src/main/wizardStateStore.ts`, extend the persisted state shape with
   an optional `linkManifests: Record<installId, LinkManifest>` field where
   ```ts
   type LinkManifest = {
     targetMc: string;
     entries: { sourceName: string; sourcePath: string; targetPath: string; strategy: 'link' | 'symlink' | 'copy'; linkedAt: string }[];
     excluded: { name: string; reason: 'mc-version-mismatch' | 'unparseable' | 'no-metadata' | 'read-error'; declaredMc?: string }[];
   };
   ```
   Backward-compatible default (`{}`) on load. Bump the persisted state
   `version` if the loader does a discriminated check; otherwise just
   tolerate the missing field. (Inspect `loadWizardState` first; it
   currently returns `WizardState`.)
2. In `src/main/wizard.ts`, factor out a new function:
   ```ts
   async function runModLinkStage(args: {
     install: McInstall;
     seiGameDir: string;
     targetMc: string;
     signal: AbortSignal;
     onProgress: (ev: WizardProgressEvent) => void;
     priorManifest: LinkManifest | null;
   }): Promise<{ manifest: LinkManifest; summary: WizardInstallResult['modLinkSummary'] }>;
   ```
3. Algorithm inside `runModLinkStage`:
   - Emit `{ stage: 'mods-linking', scanned: 0, linked: 0, excluded: 0, totalEstimate: null }`.
   - Read `entries = await fs.readdir(path.join(install.path, 'mods'))`
     (the SOURCE — user's `.minecraft/mods`). ENOENT → entries = [].
   - Emit again with `totalEstimate = entries.length`.
   - Filter out the CSL regex `/^CustomSkinLoader[_-].*\.jar$/i` and any
     non-`.jar` files.
   - For each remaining JAR:
     - `signal.aborted` check → throw `MOD_DOWNLOAD_FAILED: cancelled`.
     - Call `scanModJar(sourcePath, targetMc)`.
     - If `compatible: true`:
       - `targetPath = path.join(seiGameDir, 'mods', sourceName)`.
       - If a file already exists at `targetPath` whose realpath equals
         `sourcePath`, treat as already-linked (record strategy `'link'`
         or `'symlink'` based on `lstat`); skip the link call.
       - Otherwise try `fs.link(sourcePath, targetPath)`. On error
         (`EXDEV`, `EPERM`, `EACCES`, `ENOTSUP`), log at `warn` with the
         errno code and the path pair, then try `fs.symlink(sourcePath,
         targetPath)`. On its error, fall back to `fs.copyFile(sourcePath,
         targetPath)`.
       - Record `{ sourceName, sourcePath, targetPath, strategy,
         linkedAt: new Date().toISOString() }` in the new manifest.
     - If `compatible: false`: record in `excluded[]` with the scan's
       `reason` (and `declaredMc` when available).
     - Increment counters, emit `{ stage: 'mods-linking', scanned,
       linked, excluded, totalEstimate }`.
   - Reconciliation pass against `priorManifest`:
     - For each entry in `priorManifest.entries` NOT present in the new
       `entries[]` (by `sourceName`): `fs.unlink(targetPath)` (best-effort;
       ENOENT is fine). DO NOT touch the CSL JAR.
4. In `processOneInstall` (vanilla branch only), between Fabric install
   and CSL download, call `runModLinkStage` with the prior manifest from
   `wizardStateStore`. After CSL placement, attach `modLinkSummary` to
   the `WizardInstallResult` push for that install. Persist the updated
   manifest via `saveWizardState`.
5. CurseForge branch: do NOT run this step. CurseForge instances are
   already isolated per-instance and version-coherent (D5).
6. Lunar branch: already short-circuited in T3 via early return.

**Acceptance.**
- Against a vanilla `.minecraft` with mods `SkyHanni-3.8.0.jar` (1.8.9),
  `Sodium-fabric-0.6.0.jar` (1.21.4), and `Iris-1.7.0.jar` (1.21.4) plus
  the wizard installing for MC 1.21.4:
  - `<.minecraft>/sei/mods/` contains hardlinks (or symlinks / copies) of
    Sodium and Iris but NOT SkyHanni.
  - The CSL JAR is in `<.minecraft>/sei/mods/` and is unchanged by the
    link pass.
  - The wizard's `WizardInstallResult.modLinkSummary` shows
    `linked: 2, excluded: 1` with SkyHanni's `reason:
    'mc-version-mismatch'` and `declaredMc: '1.8.9'`.
- Re-running the wizard with no changes is idempotent — the manifest
  matches before and after (same `sourceName` set, same `strategy` per
  entry).
- Removing `Sodium-fabric-0.6.0.jar` from `<.minecraft>/mods/` and
  re-running the wizard removes `<.minecraft>/sei/mods/Sodium-fabric-0.6.0.jar`.
- On a clean install (no compatible mods present), the Sei `mods/`
  contains only the CSL JAR; manifest `entries: []`,
  `excluded` populated as appropriate.
- Cancellation: hitting Cancel mid-stage stops the loop within the next
  JAR iteration and emits `stage: 'cancelled'`.

**Verification.**
- `npx tsc --noEmit` passes.
- Smoke harness `scripts/test-modLinkOrchestrator.mjs`:
  - Creates a temp dir tree simulating `<.minecraft>/mods/` and
    `<.minecraft>/sei/mods/` (the latter empty).
  - Drops three small fixture JARs (use the same in-memory ZIP helper from
    T1's harness) — one compatible Fabric mod for 1.21.4, one
    incompatible Fabric mod for 1.8.9, and one CSL JAR.
  - Invokes `runModLinkStage` directly (exported for testability) with a
    fake `onProgress` capturing all events.
  - Asserts: target dir contains exactly the compatible mod (verified by
    `fs.lstat`); CSL JAR untouched; manifest contains expected entries;
    progress events monotonic.
  - Re-runs and asserts no changes (idempotent).
- `grep -n "CustomSkinLoader" src/main/wizard.ts` shows the CSL-exclusion
  filter in the new function.

**Dependencies.** T1, T2, T4, T5.

**Commit.** `feat(wizard): scan user mods, hardlink compatible JARs into Sei gameDir, reconcile on re-run`

---

### T7 — Wizard UI surfaces link summary + Lunar "limited" badge

**Goal.** Make the new behavior visible to the user.

**Files modified.**
- `src/renderer/src/components/SetupWizardModal.tsx` — render link summary
  on the `done` / `one-failed` step.
- `src/renderer/src/components/InstallProgressList.tsx` — render the new
  `'mods-linking'` stage row with `scanned / linked / excluded` counters.
- `src/renderer/src/components/McInstallRow.tsx` — render Lunar's
  `compatibility: 'limited'` pill + caption.
- `src/renderer/src/components/SetupWizardModal.module.css` — CSS for the
  new summary block + Lunar caption.
- `src/renderer/src/lib/stores/useWizardStore.ts` — relay
  `modLinkSummary` from `WizardInstallResult` into the rendered state
  (no shape change — `WizardInstallResult` already carries it from T2).

**Action.**
1. `McInstallRow.tsx`:
   - In `pillFor`, branch on `install.kind === 'lunar'` BEFORE the
     `sei_enabled` branch. Return:
     ```ts
     { tone: 'warn', label: 'Limited', secondary: install.path }
     ```
   - Render an additional caption beneath the pill when `install.kind ===
     'lunar'`:
     "Sei can connect to the same server you play on, but Lunar doesn't
     support custom skin mods — the bot will appear with a default Mojang skin."
   - Disable the checkbox + onClick for Lunar rows. The row is read-only;
     it shows up in the list for transparency only. Add `aria-disabled`
     and visually muted styling.
2. `InstallProgressList.tsx`:
   - Add a switch case for the new `'mods-linking'` stage:
     "Scanning your mods (linked X of Y so far, Z excluded)." Use the
     `scanned / linked / excluded / totalEstimate` fields. When
     `totalEstimate === null`, render "Scanning your mods…" without
     numerics.
3. `SetupWizardModal.tsx`:
   - On the `DoneStep` and `OneFailedStep`, beneath the existing copy and
     when `results.some(r => r.modLinkSummary)`, render a per-install
     summary block:
     ```
     {install.label}
       Linked {linked} mods
       Excluded {excluded} (wrong MC version or unreadable metadata)
         ▸ <details> with a <ul> of excludedJars: each "{name} — targets MC {declaredMc ?? '?'}"
     ```
   - The disclosure widget uses `<details><summary>` (native, a11y-correct,
     no extra dep). Inline `<ul>` of exclusions inside the open state.
4. CSS:
   - New class `.modLinkSummary` for the block (padding-top: var(--space-md),
     border-top: 1px solid var(--surface-border)).
   - `.modLinkExclusionList` — small text, monospace JAR names, two-column
     "name | reason" layout (CSS grid).
   - `.lunarCaption` — small muted caption beneath the McInstallRow pill.

**Acceptance.**
- Wizard pick step shows a Lunar row when `~/.lunarclient/` exists; the
  row's checkbox is disabled and a "Limited" pill + caption are visible.
- During install of a vanilla profile with mixed-version mods, the
  `installing` step shows the "Scanning your mods…" line with live
  counters.
- On the `done` step, a per-install summary block lists linked /
  excluded counts; expanding the disclosure shows excluded JARs with
  their declared MC version (or `?` for unparseable).
- `npx tsc --noEmit` passes across the renderer.

**Verification.**
- Visual: run the Electron app with a fixture `.minecraft` containing
  mixed-version mods, screenshot the done step.
- `npx tsc --noEmit` passes.
- `grep -n "mods-linking" src/renderer/src/components/` shows the new
  branch in `InstallProgressList.tsx`.
- `grep -n "lunar" src/renderer/src/components/McInstallRow.tsx` shows the
  new branch.

**Dependencies.** T2 (types), T3 (Lunar emit), T6 (mod-link emit +
modLinkSummary on result).

**Commit.** `feat(wizard-ui): show mod-link summary + Lunar limited badge`

---

### T8 — Error copy + edge cases (pre-1.14 inline warning, parse-failure surface)

**Goal.** Add user-facing copy for the two new failure / warning modes
introduced by this plan. Pre-1.14 MC detection surfaces as an inline
warning on the pick step (NOT a hard block — user can deselect the
problem install and proceed). Mod-scan parse failures surface in the
existing exclusion list (already wired in T7) — this task adds the copy
strings.

**Files modified.**
- `src/renderer/src/lib/errors.ts` — add new copy strings.
- `src/renderer/src/components/McInstallRow.tsx` — emit a small inline
  warning beneath the row when `install.kind === 'vanilla'` and
  `install.mc_version` parses to a version `< 1.14`.

**Action.**
1. `errors.ts`:
   - Add (as plain exported constants, not part of `ERROR_COPY` since
     these aren't `ErrorClass`-keyed):
     ```ts
     export const WARN_COPY = {
       MC_VERSION_PRE_1_14:
         "Detected MC {version}. Sei requires MC 1.14 or newer for the current Fabric Loader. " +
         "Pick a newer profile or switch to 1.21.x before continuing.",
       MOD_SCAN_PARSE_FAIL:
         "Couldn't read mod metadata — this mod will be skipped. " +
         "If it's actually compatible, copy it into <install>/sei/mods/ manually.",
     } as const;
     ```
   - Substitution: caller does the `{version}` interpolation inline (no
     template engine — just `WARN_COPY.MC_VERSION_PRE_1_14.replace('{version}', v)`).
2. `McInstallRow.tsx`:
   - Add a helper `isPre114(v: string | null): boolean` that parses
     `major.minor[.patch]` and returns true when `major < 1` (never
     occurs) or `major === 1 && minor < 14`. Otherwise false.
     Unparseable / null → false (don't warn on what we can't read).
   - When the install is vanilla and `isPre114(install.mc_version)`,
     render a small `.warning` element beneath the pill:
     `WARN_COPY.MC_VERSION_PRE_1_14.replace('{version}', install.mc_version!)`.
   - `T7`'s exclusion list (in `SetupWizardModal.DoneStep`) already
     surfaces the "no-metadata" / "unparseable" / "read-error" cases via
     the manifest reason. No additional rendering needed there — the
     copy in WARN_COPY exists for hover/title tooltips on the exclusion
     row, attached via the `title` HTML attribute.
3. CSS for `.warning`: small (font-size: var(--text-sm)), tone `--warn`
   color, indent matches the row content gutter.

**Acceptance.**
- A vanilla row with `mc_version: '1.8.9'` renders an inline warning with
  the verbatim WARN_COPY text (after `{version}` substitution).
- A vanilla row with `mc_version: '1.21.4'` renders no warning.
- The Continue button is NOT disabled — the user can still deselect the
  problem row and proceed (per D4: "no version override picker added in
  this task"). The warning is purely informational.
- Hovering an exclusion row in the done-step summary shows the
  `MOD_SCAN_PARSE_FAIL` tooltip (for `unparseable` / `read-error`
  reasons; `mc-version-mismatch` rows show the declared MC version
  inline instead).

**Verification.**
- `npx tsc --noEmit` passes.
- Visual: fixture run with a pre-1.14 vanilla install; screenshot the
  pick step.
- `grep -n "WARN_COPY" src/renderer/src/lib/errors.ts` shows the new
  constants.

**Dependencies.** T7 (the exclusion-list disclosure is where parse-failure
tooltips attach).

**Commit.** `feat(wizard-ui): inline pre-1.14 MC warning + parse-failure tooltips`

---

### T9 — (optional) Orphan cleanup of v0.1.1 leftover CSL JAR

**Goal.** When the wizard runs and finds a `CustomSkinLoader_*.jar` in the
shared `<.minecraft>/mods/` (left there by v0.1.1's bug), offer to remove
it. We never delete without consent.

**Flag.** This task is OPTIONAL. Land if T1–T8 ship within budget; defer
otherwise.

**Files modified.**
- `src/main/wizard.ts` — detect the orphan, surface via a new
  `WizardInstallResult.orphanCsl` field.
- `src/renderer/src/components/SetupWizardModal.tsx` — render a
  confirm-and-remove prompt on the `done` step.
- `src/shared/ipc.ts` — add a small `wizard:remove-orphan-csl` IPC method.
- `src/main/ipc.ts` — register the handler (zod-gate the path arg).

**Action.**
1. In the existing pre-link scan (T6), detect the CSL JAR via the existing
   regex. If found AND we are about to write a NEW CSL JAR into the Sei
   gameDir, attach to the result:
   `orphanCsl: { sourcePath: string }`.
2. New IPC method `removeOrphanCsl(absPath: string): Promise<{ removed: boolean }>`
   that zod-validates the path is INSIDE one of the known vanilla
   `<.minecraft>/mods/` directories (defense in depth — never let the
   renderer pass an arbitrary path to delete) before `fs.unlink`.
3. Wizard `done` step renders a one-line prompt: "We noticed an old
   CustomSkinLoader file in your launcher's shared mods folder
   (`<path>`). Sei no longer uses it. Remove it?" with "Remove" /
   "Keep" buttons. "Remove" calls the new IPC method and updates local
   state. "Keep" is a no-op.

**Acceptance.**
- A vanilla install with both `<.minecraft>/mods/CustomSkinLoader_Fabric-X.jar`
  (from v0.1.1) AND a fresh Sei install in `<.minecraft>/sei/mods/`
  surfaces the prompt.
- Clicking "Remove" deletes the orphan and the prompt disappears.
- Clicking "Keep" leaves the orphan in place; the wizard does NOT prompt
  again on subsequent re-runs (persist a per-install
  `orphanCslPromptedAt` flag in the manifest extension from T6).
- Path validation rejects paths outside the canonical `<.minecraft>/mods/`
  directories.

**Verification.**
- `npx tsc --noEmit` passes.
- Smoke fixture: place a junk CSL JAR in a temp `<.minecraft>/mods/`, run
  the wizard, click Remove, confirm the file is gone.
- `grep -n "orphan" src/main/wizard.ts src/renderer/src/components/SetupWizardModal.tsx`
  shows the new code paths.

**Dependencies.** T6 (extends the same manifest).

**Commit.** `feat(wizard): consent-gated removal of v0.1.1 orphan CustomSkinLoader JAR`

---

## Goal-backward verification (CONTEXT.md acceptance criteria coverage)

CONTEXT.md §"Acceptance criteria" lists five outcomes. Each maps to one or
more task acceptance lines:

| # | Acceptance criterion | Covered by |
|---|---|---|
| 1 | Wizard against clean vanilla `.minecraft` produces a working Sei profile launching MC 1.21.x | T4 (gameDir + tightened profile match) + T5 (CSL placed under Sei gameDir) — Sei profile is isolated, contains only the CSL JAR, MC has no foreign mods to reject. |
| 2 | Wizard against vanilla `.minecraft` containing mixed-version mods produces a working Sei profile that loads compatible mods, excludes wrong-version ones, and reports exclusions in the UI | T1 (parser) + T6 (link orchestrator + reconciliation) + T7 (UI summary). The SkyHanni-1.8.9 vs Sodium-1.21.4 scenario in T6's acceptance line is the exact reproduction case from CONTEXT.md §"Origin". |
| 3 | Wizard against a CurseForge Pixelmon instance installs CSL Forge into the instance and reports success | T5 (CSL goes to `<instance>/mods/` for `kind: 'curseforge'`) — behavior unchanged from today, but T5's refactor makes the targetDir explicit so it cannot accidentally regress. Pixelmon's Forge instance reports `loader: 'forge'` → `decideLoaderKind` returns `'forge'` → CSL Forge JAR installs (existing code path, exercised). |
| 4 | Wizard with Lunar Client detected lists Lunar as "limited" and does not attempt Fabric/CSL install for it | T3 (detection + `compatibility: 'limited'`) + T3's defensive early-return in `processOneInstall` + T7 (UI: disabled checkbox, "Limited" pill, caption). |
| 5 | Re-running the wizard is idempotent (gameDir persists; mod-link scan reconciles) | T4 (re-run re-writes gameDir on the same profile key; no duplication) + T6 (manifest reconciliation algorithm — add new, remove vanished, leave existing). T6's acceptance line explicitly tests the re-run case. |

**All five criteria are covered.** No task additions required.

## Task summary

- 8 required tasks (T1–T8) + 1 optional task (T9).
- Total files touched (required only): ~10 files
  (`src/main/modScanner.ts` [new], `src/main/mcInstallScan.ts`,
   `src/main/fabricInstaller.ts`, `src/main/customSkinLoader.ts`,
   `src/main/wizard.ts`, `src/main/wizardStateStore.ts`,
   `src/shared/ipc.ts`, `src/renderer/src/components/McInstallRow.tsx`,
   `src/renderer/src/components/InstallProgressList.tsx`,
   `src/renderer/src/components/SetupWizardModal.tsx` +
   `SetupWizardModal.module.css`, `src/renderer/src/lib/errors.ts`,
   `src/renderer/src/lib/stores/useWizardStore.ts`).
- Plus 2 new test harness scripts under `scripts/`.
- T9 adds ~3 more files if landed.
