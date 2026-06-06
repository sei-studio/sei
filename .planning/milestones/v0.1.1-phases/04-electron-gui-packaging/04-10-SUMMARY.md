---
phase: 04-electron-gui-packaging
plan: 10
subsystem: packaging
tags: [electron-builder, entitlements, hardened-runtime, notarize, packaging]
status: paused-at-checkpoint
dependency_graph:
  requires:
    - 04-01-SUMMARY.md   # electron-builder.yml stub + postinstall
    - 04-02..04-09       # Electron app surface that gets packaged
  provides:
    - "electron-builder.yml: final mac/win/linux packaging config (placeholder appId pending Task 2)"
    - "build/entitlements.mac.plist: hardened runtime entitlements"
    - "electron.vite.config.ts: dist/ output paths matching package.json main"
  affects:
    - "package.json: main field already references dist/main/index.js (now satisfied)"
tech_stack:
  added: []
  patterns:
    - "Hardened Runtime entitlements (mac signing prereq)"
    - "electron-vite custom outDir (dist/{main,preload,renderer})"
    - "CJS preload bundle (electron preload script convention)"
key_files:
  created:
    - build/entitlements.mac.plist
  modified:
    - electron-builder.yml
    - electron.vite.config.ts
decisions:
  - "Route electron-vite output to dist/ (matches package.json main + plan acceptance) instead of electron-vite default out/"
  - "Force CJS preload format with .js extension so main/index.ts preloadPath() resolves correctly (electron-vite forces .mjs for ESM preload)"
  - "Preserve appId=app.sei.placeholder until BLOCKING Task 2 checkpoint resolves"
metrics:
  duration_minutes: 4
  tasks_completed: 1
  tasks_total: 2
  files_changed: 3
  commits:
    - afb7086
  completed: 2026-05-08
---

# Phase 04 Plan 10: Packaging Configuration Summary

**One-liner:** Fleshed out `electron-builder.yml` with mac hardened-runtime + notarization fields, created `build/entitlements.mac.plist` with the four runtime entitlements, fixed electron-vite outDir to match `package.json` `main`, and verified `npm run build` produces `dist/{main,preload,renderer}` artifacts cleanly. Plan paused at Task 2 BLOCKING checkpoint pending user-locked appId.

## Outcome

Plan 04-10 is partially complete. Task 1 (autonomous: config + smoke build) executed successfully. Task 2 (`checkpoint:human-action`) requires the user to choose the final reverse-DNS `appId` (e.g., `gg.sei.app`, `studio.sei.app`, `bot.sei.app`) and to provide their Apple Developer identity + notarization secrets before any signed `dist:mac` build runs. This is intentionally BLOCKING because once a signed build ships, changing `appId` strands all existing macOS Keychain `safeStorage` entries.

## What Was Built

### `electron-builder.yml`
- Kept `appId: app.sei.placeholder` and the `# TODO(lock-before-signing)` marker (per plan acceptance criteria — Task 2 will lock these).
- Added top-level: `productName: Sei`, `copyright: Copyright (c) 2026 Sei`, full `directories`, expanded `files` glob (excludes node_modules test/license cruft + sourcemaps), `asar: true`, `asarUnpack: src/bot/**/*` (Pitfall 1 — mineflayer native bindings).
- `mac` block: `category: public.app-category.games`, `target: dmg arch:[universal]`, `hardenedRuntime: true`, `gatekeeperAssess: false`, commented identity placeholder (Task 2), `notarize: true` (lazy — env-driven), `entitlements` + `entitlementsInherit` → `build/entitlements.mac.plist`.
- `dmg` block: `sign: false` (electron-builder ≥20.43 default) plus standard 410/130 contents layout for the Applications symlink + app icon.
- `win` block: `target: nsis arch:[x64]` ONLY. **No `signtoolOptions` and no `azureSignOptions`** per RESEARCH §Resolved Q2 — Windows ships unsigned v1; SmartScreen "unknown publisher" UX is documented in plan 11 release notes.
- `nsis` block: `oneClick: false`, `perMachine: false` (per-user install, no admin prompt), `allowToChangeInstallationDirectory: true`.
- `linux` block: `AppImage` target, `category: Game`. Best-effort unsigned per D-60.
- **No `publish` top-level key** — auto-update OUT of scope per D-63.

### `build/entitlements.mac.plist`
Verbatim from RESEARCH §Code Examples §4. Four entitlements only — minimum surface for Hardened Runtime + Electron + Anthropic + LAN multicast:
- `com.apple.security.cs.allow-jit` (V8 JIT)
- `com.apple.security.cs.allow-unsigned-executable-memory` (V8 ICs)
- `com.apple.security.network.client` (Anthropic API + Minecraft TCP)
- `com.apple.security.network.server` (LAN multicast watcher on UDP 4445)

`plutil -lint` passes.

No file-system, microphone, camera, or AppleEvents entitlements (T-04-42 mitigation).

### `electron.vite.config.ts`
Reconciled the gap between (a) the plan's verify gate + `package.json` `main: "dist/main/index.js"` + `src/main/index.ts` `preloadPath()` (which all expect `dist/`) and (b) electron-vite's default `out/` directory. Added `build.outDir` to each of `main`, `preload`, `renderer` and forced preload to CJS with `.js` extension (electron-vite forces `.mjs` for ESM preload, breaking `preloadPath()`).

### `npm run build` smoke
```
dist/main/index.js                    27.50 kB
dist/preload/index.js                  2.07 kB
dist/renderer/index.html               0.39 kB
dist/renderer/assets/index-*.css      33.18 kB
dist/renderer/assets/index-*.js      641.96 kB
```
All three runtime entry points present. The `dist:mac` / `dist:win` / `dist:linux` runs are explicitly out of scope (deferred to plan 11 + the post-checkpoint signed build).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] electron-vite output dir mismatched runtime expectations**
- **Found during:** Task 1, Step 3 (`npm run build` smoke).
- **Issue:** First `npm run build` emitted to `out/main/index.js`, `out/preload/index.mjs`, `out/renderer/index.html` (electron-vite defaults). However, `package.json` declares `"main": "dist/main/index.js"` and `src/main/index.ts:42` resolves preload via `path.join(__dirname, '../preload/index.js')`. Both runtime entry resolution and the plan's verify gate (`test -f dist/main/index.js && test -f dist/preload/index.js && test -f dist/renderer/index.html`) would fail.
- **Fix:** Set `build.outDir` to `dist/main`, `dist/preload`, `dist/renderer` in `electron.vite.config.ts`. Forced preload to `format: 'cjs'` with `entryFileNames: '[name].js'` (electron-vite hard-codes `.mjs` for ESM preload — see `node_modules/electron-vite/dist/chunks/lib-q6ns0vZr.js:435`).
- **Files modified:** `electron.vite.config.ts`.
- **Commit:** afb7086.

No other deviations. Plan 10 Task 1 ran exactly as written modulo the build-output fix.

## Authentication Gates

None encountered during Task 1. Task 2 itself is structured as a `checkpoint:human-action` that surfaces the auth-adjacent prerequisites (Apple Developer identity, notarization secrets) — see Resume Plan below.

## Threat Surface Scan

No new surface introduced beyond what is already in the plan's `<threat_model>`. The packaging config is the mitigation layer for T-04-40 (signing → Gatekeeper trust), T-04-41 (one-time appId lock — Task 2), and T-04-42 (minimum entitlements set).

## Known Stubs

- `appId: app.sei.placeholder` and the commented `# identity:` line are intentional stubs preserved for Task 2 BLOCKING checkpoint.

## Resume Plan (Task 2 — `checkpoint:human-action`)

The user must:

1. **Pick a reverse-DNS appId** — e.g., `gg.sei.app`, `studio.sei.app`, or `bot.sei.app`. Once the first signed build ships, this binds all macOS `safeStorage` Keychain entries; changing it later invalidates them all (RESEARCH §Resolved Q1).
2. **Replace** `appId: app.sei.placeholder` with the chosen value AND remove the `# TODO(lock-before-signing)` line in `electron-builder.yml`.
3. **Populate** `mac.identity` with `Developer ID Application: <Name> (<TEAM_ID>)` (TEAM_ID from Apple Developer Membership tab).
4. **Verify** `security find-identity -v -p codesigning | grep "Developer ID Application"` lists at least one identity.
5. **Set** notarization env vars: either `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`, or `APPLE_API_KEY` + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER`.
6. **Test build** with `npm run dist:mac` (NOT executed by this plan), mount the `.dmg`, install to `/Applications`, launch, confirm Gatekeeper passes without right-click → Open.
7. **Commit** the locked `electron-builder.yml`.

Once resolved, plan 11 (clean-VM smoke) takes the resulting `.dmg` / `.exe` / `AppImage` to clean macOS / Windows / Linux VMs.

## Notes for Plan 11 Executor

- The user, when running `npm run dist:mac`, should record:
  - Final chosen `appId`
  - Exact `mac.identity` string used
  - Architecture(s) built (`universal` per D-60)
- Bring `.dmg` → clean macOS VM (parallels/utm/cloud).
- Bring `.exe` → clean Windows VM. Capture SmartScreen UX (per RESEARCH §Resolved Q2) for release notes.
- Bring `AppImage` → clean Ubuntu VM.

## Self-Check: PASSED

- `electron-builder.yml`: FOUND
- `build/entitlements.mac.plist`: FOUND
- `electron.vite.config.ts`: FOUND (modified)
- `dist/main/index.js`: FOUND
- `dist/preload/index.js`: FOUND
- `dist/renderer/index.html`: FOUND
- Commit `afb7086`: FOUND in `git log --all`
- `appId: app.sei.placeholder`: PRESENT (verified with grep)
- `# TODO(lock-before-signing)`: PRESENT (verified with grep)
- No `signtoolOptions:` / `azureSignOptions:` / top-level `publish:`: VERIFIED ABSENT

## Checkpoint Resolution (2026-05-08)

The Task 2 `checkpoint:human-action` was raised to the user and **resolved as DEFERRED**.

### Decision

- `appId` lock is **DEFERRED**. `electron-builder.yml` retains `appId: app.sei.placeholder` plus the `# TODO(lock-before-signing)` marker exactly as committed in `afb7086`. No source-code changes accompany this resolution.
- `mac.identity`, Apple Developer credentials, and notarization env vars are likewise deferred — they cannot be set without a final `appId` and are not needed for any plan-04 deliverable.
- Linux and Windows code-signing follow-ups (Azure Trusted Signing, `.deb` / `.rpm` beyond the `AppImage` already configured) are **also deferred — explicitly out of scope for v1** per CONTEXT D-43 (Windows ships unsigned, Linux best-effort `AppImage`-only).

### Reason

The reverse-DNS `appId` cannot be locked because the user has not yet picked the final domain TLD. Per RESEARCH §"Resolved During Plan-Phase (2026-05-08)" Q1, the candidates are:

- `gg.sei.app`
- `studio.sei.app`
- `bot.sei.app`

Locking the `appId` prematurely would bind the choice to all macOS `safeStorage` Keychain entries on the first signed build; any subsequent rename would strand existing user secrets (Pitfall: T-04-41, "one-time appId lock"). Deferring is the correct conservative posture while the domain decision is still open.

### Follow-up

A separate post-phase task is owed **before the first signed `dist:mac` build is shipped**:

1. User registers their chosen `sei.app` subdomain (`gg` / `studio` / `bot`).
2. User edits `electron-builder.yml`: replace `appId: app.sei.placeholder` with the locked reverse-DNS value, remove the `# TODO(lock-before-signing)` line, populate `mac.identity` with `Developer ID Application: <Name> (<TEAM_ID>)`.
3. User sets notarization env vars (`APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`, or the `APPLE_API_KEY*` triplet).
4. User runs `npm run dist:mac`, mounts the `.dmg`, confirms Gatekeeper passes without right-click → Open.
5. Commit the locked config.

**Owner:** the user (post-phase, gated on domain registration).

Until then, plan 10 is **functionally complete with the user-acknowledged deferral on record**. Plan 11 (clean-VM smoke) can proceed against unsigned local builds; the signed-build smoke is the only step that must wait on this follow-up.
