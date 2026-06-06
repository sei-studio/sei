---
quick_id: 260518-o1k
status: complete
tasks_completed: ["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8"]
tasks_skipped: ["T9"]
commits:
  - "f3e7247"  # T1 modScanner
  - "8503a4c"  # T2 IPC types
  - "61bfdd1"  # T3 Lunar detection
  - "6e39e35"  # T4 Fabric gameDir
  - "02ab467"  # T5 CSL targetDir
  - "0c365e8"  # T6 mod-link orchestrator
  - "2d3a0e1"  # T7 wizard UI
  - "2ac72dc"  # T8 warning copy + tooltips
---

# Sei mod-compatibility & launcher-conflict resolution

## What was built

The core change is structural: the Sei launcher profile now lives in its
own isolated `gameDir` at `<.minecraft>/sei/` and only loads the mods that
get explicitly linked into `<.minecraft>/sei/mods/`. That isolation is what
stops Fabric Loader from crashing the Sei profile when the user has
wrong-MC-version mods (e.g. SkyHanni-1.8.9) sitting in the launcher's
shared `<.minecraft>/mods/` folder.

Supporting machinery:

- **`modScanner.ts`** (T1) — pure ZIP-central-directory reader that parses
  `fabric.mod.json` and `META-INF/mods.toml` from a JAR and resolves the
  declared `minecraft` constraint against a target version. Includes a
  Maven bracket-range parser and a Fabric semver resolver. No network, no
  subprocess — deliberate carve-out from the "every external call has a
  timeout" rule, documented in the file header.
- **`fabricInstaller.ts`** (T4) — pre-creates the Sei `gameDir` + `mods/`
  subdir and writes `gameDir` to the renamed Sei profile in
  `launcher_profiles.json`. Profile matching tightened to an exact-key
  match on `fabric-loader-<loaderVersion>-<mcVersion>` with a warn-logged
  prefix-match fallback.
- **`customSkinLoader.ts`** (T5) — `writeCustomSkinLoaderConfig` field
  renamed from `mcInstallDir` → `targetDir`. Vanilla installs pass the Sei
  gameDir; CurseForge instances pass the instance dir (unchanged).
- **`wizard.ts`** (T6) — new `runModLinkStage` function. Hardlinks
  compatible JARs via `fs.link → fs.symlink → fs.copyFile` fallback chain
  and persists a `LinkManifest` per install so re-runs reconcile.
- **`mcInstallScan.ts`** (T3) — Lunar Client detection. Emits
  `kind: 'lunar'`, `compatibility: 'limited'`. Wizard orchestrator
  early-returns on Lunar rows.
- **Renderer** (T7 + T8) — Lunar rows render read-only with a "Limited"
  pill and a caption. Pre-1.14 MC versions show an informational inline
  warning. Installing step shows live `mods-linking` counters. Done step
  renders a per-install summary with a `<details>` disclosure listing
  excluded mods (with tooltip copy on parse-failure rows).

## Verification

- `npx tsc --noEmit` — clean across main / preload / renderer.
- `node scripts/test-modScanner.mjs` — 13/13 pass.
- `node --import ./scripts/lib/electron-stub-loader.mjs scripts/test-lunarDetect.mjs`
  — 4/4 pass.
- `node --import ./scripts/lib/electron-stub-loader.mjs scripts/test-modLinkOrchestrator.mjs`
  — 5/5 pass.

## Deviations from PLAN

1. **T5 added a third call-site.** `src/main/index.ts`'s boot-time
   port-drift rewrite had to switch to `targetDir` semantics too, or it
   would silently keep writing config to `<.minecraft>/CustomSkinLoader/...`
   (the old location). PLAN listed only `customSkinLoader.ts` +
   `wizard.ts`. Same change shape, just additional call-site. Flagged in
   the T5 commit body.
2. **T1 chose the in-house TOML reader** over adding `smol-toml` /
   `@iarna/toml`. PLAN explicitly permitted either; the in-house ~40-line
   reader was cleaner than another dep given that `mods.toml` is small
   and only needs three fields.
3. **T9 deferred** per the prompt's explicit "optional if budget allows"
   framing. T9 introduces a new zod-validated IPC method (path delete)
   which is materially riskier surface than the rest of the work and
   worth a separate, focused pass.

No CONTEXT.md decisions (D1–D5) were violated.

## Manual smoke test (acceptance criterion #2)

The reproduction scenario in CONTEXT.md — vanilla `.minecraft` with
mixed-version mods producing a SEI profile that LAUNCHES — can only be
verified end-to-end against a real Mojang launcher. The harness tests
verify the orchestrator's link/reconcile algorithm in isolation but
cannot confirm the launcher accepts the rewritten
`launcher_profiles.json` or that real Fabric Loader stops complaining
once `<.minecraft>/sei/` is the gameDir.

**To smoke-test manually:**

1. `npm run build`.
2. Run against a vanilla `.minecraft` with mixed-version mods (e.g. drop
   SkyHanni-3.8.0 alongside Sodium-fabric-0.6.0 into
   `<.minecraft>/mods/`).
3. Run the wizard; complete it.
4. Confirm:
   - `<.minecraft>/sei/mods/` contains links to Sodium + CSL but NOT
     SkyHanni.
   - `launcher_profiles.json` has a "Sei" profile entry with `gameDir`
     set to the absolute Sei dir.
   - Mojang launcher's "Sei" profile shows a custom game-directory line.
   - Clicking Play on the Sei profile launches MC successfully (no
     "Incompatible mods found!" dialog).
5. Re-run the wizard — same numbers, no churn on disk.
6. Delete a previously-linked source mod from `<.minecraft>/mods/` and
   re-run — confirm its link in `<.minecraft>/sei/mods/` disappears.

The orphan `CustomSkinLoader_Fabric-14.28.jar` left in the shared
`mods/` by v0.1.1 will still be present — that's T9's job, deferred.
It's harmless to other launcher profiles.
