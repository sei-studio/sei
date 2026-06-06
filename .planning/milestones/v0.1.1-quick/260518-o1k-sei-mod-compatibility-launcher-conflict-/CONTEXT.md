---
quick_id: 260518-o1k
slug: sei-mod-compatibility-launcher-conflict-
date: 2026-05-19
status: ready-for-planning
---

# CONTEXT — Sei mod-compatibility & launcher-conflict resolution

## Origin

Bug reproduction: user runs the v0.1.1 setup wizard against a vanilla
`.minecraft` that already has `SkyHanni-3.8.0.jar` (Fabric mod targeting MC
1.8.9) in `<.minecraft>/mods/`. The wizard installs Fabric Loader for 1.21.4
and drops `CustomSkinLoader_Fabric-X.jar` into the same shared `mods/`. On
"Play" via the renamed "Sei" launcher profile, Fabric Loader rejects with
**"Incompatible mods found! Mod 'SkyHanni' requires version 1.8.9 of
'Minecraft', but only the wrong version is present: 1.21.4"** — game won't
launch.

Root cause: the Sei launcher profile has no `gameDir`, so Fabric loads every
JAR in `<.minecraft>/mods/` against MC 1.21.4. The Sei profile inherits the
user's entire mods folder regardless of target version.

## Goal

Make Sei compatible with:

1. **Vanilla Fabric, Sei as the only mod** (clean install — must Just Work).
2. **Vanilla Fabric with pre-existing mods** (mix of MC-version-mismatched
   and -compatible mods — must launch successfully; user's compatible mods
   like Sodium/Iris should keep working in the Sei profile).
3. **Third-party launcher with other mods** (CurseForge today; future:
   Prism/MultiMC/Modrinth/Lunar — out of scope for this task per locked
   decision below, except Lunar gets a "limited" detection badge).

Eventual north-star (NOT this task's scope): Sei works in heavy modpacks
like **Pixelmon** (Forge 1.16.5). This task is a **prerequisite** —
specifically the version-conflict-resolution machinery. Modded-item /
modded-rule awareness is **explicitly out of scope**.

## Locked decisions (from `--discuss` session)

### D1. Isolation: always isolated `gameDir`

The Sei launcher profile always uses `<install>/sei/` as `gameDir` (vanilla
installs only — CurseForge instances are already isolated per-instance).

- Sei `gameDir` layout:
  ```
  <.minecraft>/sei/
    mods/
      CustomSkinLoader_Fabric-X.X.X.jar
      <hardlinks to compatible user mods — see D2>
    config/CustomSkinLoader/CustomSkinLoader.json
    CustomSkinLoader/CustomSkinLoader.json     (legacy path)
    saves/         (isolated — Sei profile has its own worlds)
    resourcepacks/ (isolated)
    screenshots/   (isolated)
  ```
- `launcher_profiles.json` Sei entry gets `gameDir: "<absolute path>/sei"`.
- Saves/resourcepacks isolation is **accepted**. Sei is for multiplayer
  bot companionship; isolated worlds don't impact the primary use case.
- The launcher's main `.minecraft/mods/` is **never** mutated by Sei (we
  stop dropping CSL there; existing orphaned `CustomSkinLoader_*.jar` from
  v0.1.1 is left in place — harmless to other profiles).

### D2. Conflict resolution: auto-link compatible mods

For vanilla installs only: when the wizard runs, scan the user's
`<.minecraft>/mods/` directory. For each JAR:

1. Parse mod metadata from the ZIP:
   - Fabric: `fabric.mod.json` (root of JAR) → `depends.minecraft` field
     (semver range, e.g. `">=1.21.0"`, `"1.8.9"`, `"~1.20.1"`).
   - Forge / NeoForge: `META-INF/mods.toml` → `[[dependencies]]` block with
     `modId = "minecraft"` and `versionRange`.
2. Resolve the constraint against Sei's target MC version (the version the
   wizard is installing Fabric for, e.g. `1.21.4`).
3. **Compatible** → hardlink (fallback symlink, fallback copy) the JAR into
   `<install>/sei/mods/`. **Incompatible / unparseable** → exclude.

Size: hardlinks cost ~0 bytes. Copy fallback caps at file size (modern mods
are sub-50MB; even Pixelmon-tier modpacks are <2GB worst-case, which is
acceptable cost vs. game-doesn't-launch).

Wizard UI surfaces a summary per install:
- `12 mods linked, 3 excluded (target other MC versions)`
- Expandable list shows which JARs were excluded and why (their MC target).
- Optional "force include" toggle per excluded JAR is **out of scope** for
  this task — surface the exclusion, user can manually copy if they really
  want.

JARs with unparseable / missing metadata: **exclude** by default (treat as
"unknown target, assume incompatible"). Log to wizard summary so user can
investigate.

### D3. Launcher detection: vanilla + CurseForge (current) + minimal Lunar

No expansion of vanilla/CF detection in this task. Prism / MultiMC /
Modrinth / ATLauncher / GDLauncher / "Browse for folder" all deferred.

**Minimal Lunar exception:** add detection for Lunar Client install
(`~/.lunarclient/` on macOS/Linux, `%USERPROFILE%\.lunarclient\` on
Windows). If found, surface in the wizard list as a NEW `kind: 'lunar'`
with label `'Lunar Client'` and a `compatibility: 'limited'` marker. The
wizard:
- Shows it in the install list (read-only — no checkbox to enable).
- Displays a caption: *"Sei the bot can connect to the same server you
  play on, but Lunar doesn't support custom skin mods — the bot will
  appear with a default Mojang skin."*
- **Does not** run Fabric/CSL install for Lunar rows.

This is a UX nicety so Lunar users understand why the wizard isn't acting
on their install, not a functional integration.

### D4. MC version selection

Keep current auto-detect (`launcher_profiles.json` `lastUsed`), with these
hardening rules:

- If the detected version is **<1.14** (Fabric Loader's effective minimum
  for current loader builds), the wizard shows an inline warning:
  *"Detected MC X.Y. Sei requires MC 1.14 or newer for the current Fabric
  Loader. Pick a newer profile or switch to 1.21.x."* No version override
  picker added in this task.
- If detection fails entirely, fall back to `DEFAULT_MC_VERSION = '1.21.4'`
  (unchanged from today).

A user-facing MC-version picker is **deferred** — current auto-detect
handles 99% of cases; explicit picker is a future enhancement.

### D5. CurseForge path

Unchanged behavior: CSL is installed into the instance's existing `mods/`
(which is already isolated per-instance and version-coherent by design).
The Forge CSL build is used when the instance reports `loader: 'forge'`.

Pixelmon support specifically lands via this same path — when the user
selects a Pixelmon CurseForge instance, Sei installs CSL Forge into
`<pixelmon-instance>/mods/`. No new code path required, only verification
that CSL Forge coexists with Pixelmon's mod set (live-MC smoke test, not
code change).

## Scope boundaries (what this task DOES NOT do)

- ❌ Awareness of modded items, blocks, recipes, or game rules in the bot's
  LLM / action registry.
- ❌ NeoForge installer (we read `neoforge-X` from CurseForge metadata and
  treat as Forge for CSL purposes — no separate install path).
- ❌ Prism / MultiMC / Modrinth / ATLauncher / GDLauncher detection.
- ❌ "Browse for folder" manual install picker.
- ❌ User-facing MC-version picker.
- ❌ Migration of users who installed via v0.1.1 — they should re-run the
  wizard; the new install will sit alongside the old one and the orphaned
  `CustomSkinLoader_*.jar` in the shared `mods/` is harmless to other
  profiles. (Optional: best-effort cleanup of the orphan when we detect
  it during scan — flagged as a nice-to-have in the plan, not required.)
- ❌ Forge mod-metadata parsing improvements beyond `mods.toml` basics
  (no `neoforge.mods.toml`, no language-loader auto-detection).

## Acceptance criteria

1. Wizard against a clean vanilla `.minecraft` produces a working Sei
   profile that launches MC 1.21.x successfully via the Mojang launcher.
2. Wizard against a vanilla `.minecraft` containing a mix of 1.21.x-
   compatible Fabric mods AND wrong-version mods (e.g. SkyHanni 1.8.9)
   produces a Sei profile that:
   - Launches successfully (no "Incompatible mods found!" dialog).
   - Loads CSL + all compatible mods.
   - Reports the exclusion list in the wizard UI.
3. Wizard against a CurseForge Pixelmon instance installs CSL Forge into
   the instance and the wizard reports success.
4. Wizard with Lunar Client detected lists Lunar as "limited" and does
   not attempt Fabric/CSL install for it.
5. Re-running the wizard is idempotent (gameDir persists; mod-link scan
   re-runs and reconciles).

## Files expected to change

- `src/main/mcInstallScan.ts` — add Lunar detection (`kind: 'lunar'`,
  `compatibility` field).
- `src/main/fabricInstaller.ts` — set `gameDir` on Sei profile after
  rename; tighten profile-key matching to exact `fabric-loader-<L>-<V>`.
- `src/main/customSkinLoader.ts` — caller passes the Sei `gameDir` rather
  than `mcInstallDir`; CSL config + JAR placement go under the gameDir
  for vanilla installs (CurseForge path unchanged).
- `src/main/modScanner.ts` — **new**: parse `fabric.mod.json` +
  `META-INF/mods.toml` from a JAR's ZIP central directory; resolve
  `minecraft` version constraint against a target version. Pure function,
  unit-testable.
- `src/main/wizard.ts` — orchestrator wires up the new mod-scan + link
  step; populates new `WizardProgressEvent` stage `'mods-linking'`.
- `src/shared/ipc.ts` — extend `McInstall` with `kind: 'lunar'` variant
  and `compatibility` field; extend `WizardProgressEvent` /
  `WizardInstallResult` to carry the link/exclusion summary.
- `src/renderer/src/components/SetupWizardModal.tsx` (+ CSS) — surface
  per-install link/exclusion summary; render Lunar's "limited" badge.
- `src/renderer/src/lib/errors.ts` — copy strings for new failure modes
  (pre-1.14 MC, mod-scan parse failures).
- `src/shared/characterSchema.ts` / `src/main/wizardStateStore.ts` —
  may need to persist the link manifest per install for diagnostic /
  re-link logic (TBD in plan).

## Open technical items for the planner

- Hardlink strategy: macOS / Linux `fs.link()`; Windows `fs.link()` works
  on NTFS but not across drives. Fallback chain:
  `fs.link → fs.symlink → fs.copyFile`. Plan should specify the precise
  fallback order and how we tag link-vs-copy in the manifest.
- ZIP central-directory parsing: pick a dependency (`yauzl` is already
  battle-tested + small) vs. minimal in-house parser. `package.json`
  already includes mineflayer which transitively depends on `yauzl` —
  reuse path likely free.
- Re-link reconciliation: when the user adds/removes mods from
  `<.minecraft>/mods/` and re-runs the wizard, the Sei `gameDir/mods/`
  needs to be reconciled (remove links pointing to deleted JARs, add
  links for new compatible JARs, leave CSL alone). Plan should define
  the reconciliation algorithm precisely.
- Lunar detection on Windows — Lunar's install path varies
  (`%LOCALAPPDATA%\Programs\lunarclient\` vs `%USERPROFILE%\.lunarclient\`).
  Plan should enumerate the canonical paths.
