---
quick_id: 260604-uoy
slug: plan-and-implement-the-in-app-updater-tw
date: 2026-06-04
mode: quick
flags: [validate]
status: planned
---

# Quick Task: In-app updater (electron-updater) with two policy levels

## Goal

Replace the notify-and-redirect-to-website updater (`src/main/updateChecker.ts` +
`UpdateToast.tsx`) with a real **in-app updater** that downloads and installs
updates in place, preserving all user data (userData is never touched). Driven by
`electron-updater` over the existing GitHub Releases channel, with update **policy**
(changelog + mandatory timing) carried by the existing `https://sei.gg/version.json`
side-channel.

This reverses planning decision **D-63** ("auto-update is OUT of scope") â€” noted in
`electron-builder.yml` and here.

## Locked design (from design conversation 2026-06-04)

### Two policy levels â€” derived from semver, no manual flag

Compare installed `current` vs available `latest` (use the `semver` dep already in
`package.json`):

| Bump | Level | Behavior |
|------|-------|----------|
| major or minor (`0.1.x â†’ 0.2.0`, `0.x â†’ 1.0`) | **optional** | Ask the user. Show changelog up front; download only on consent; restart after download. |
| patch only (`0.1.1 â†’ 0.1.2`) | **mandatory** | Silent background download. Changelog shown *after* update. |

> If a user is several behind (on `0.1.1`, latest `0.2.0`), minor differs â†’ **optional**,
> and the skipped patch rides along inside it. The mandatory/silent path triggers
> ONLY when major.minor are equal and only patch moved.

### Mandatory has two timings â€” from `version.json.apply`

semver can't distinguish a routine patch from an urgent one, so the timing comes from
a policy field:

- `"apply": "on-restart"` (DEFAULT) â€” silent download, applies on next app quit
  (`autoInstallOnAppQuit`), changelog shown on next launch.
- `"apply": "now"` â€” silent download, then **immediate forced restart** (brief blocking
  "Critical update â€” restartingâ€¦" overlay â†’ `quitAndInstall()`).

### version.json â€” extended schema (served at https://sei.gg/version.json)

```json
{
  "version": "0.1.2",
  "apply": "on-restart",
  "changelog": "## 0.1.2\n- Fixed crash on â€¦",
  "downloadUrl": "https://sei.gg/#download"
}
```

- `apply` consulted ONLY for mandatory updates; default `"on-restart"` when absent/invalid.
- `changelog` is the human notes (markdown-ish) for popups.
- Legacy fields (`version`, `downloadUrl`, `notes`) still parse â€” backward compatible.

### electron-updater config

- `autoDownload = false` (we branch per level), `autoInstallOnAppQuit = true` (default).
- Real wiring guarded by `app.isPackaged` â€” in dev the pure policy fns still run but
  `autoUpdater` is NOT touched (it throws unpackaged). Log "updater disabled in dev".

## Flows

**A. Startup auto-check** (replaces the 8s `checkForUpdate` in `index.ts`):
`autoUpdater.checkForUpdates()` â†’ on `update-available(info)`:
1. `level = deriveLevel(current, info.version)`; fetch `version.json` â†’ `{apply, changelog}`.
2. **optional** â†’ push `app:update-available` `{currentVersion, latestVersion, level:'optional', changelog, downloadUrl}`. No download yet.
3. **mandatory** â†’ `downloadUpdate()` (silent); stash `{version, changelog}` for next-launch what's-new. On `update-downloaded`:
   - `apply==='now'` â†’ push `app:update-downloaded {forced:true}`, then `setTimeout(quitAndInstall, ~3500ms)`.
   - `apply==='on-restart'` â†’ nothing visible; `autoInstallOnAppQuit` applies on quit.

**B. Settings "Check for updates"**: `app:update-check` invoke â†’ same event flow; renderer shows Checkingâ€¦/Up to date/Available.

**C. Optional accept (popup "Update now")**: `app:update-download` invoke â†’ `downloadUpdate()`; `download-progress` â†’ `app:update-progress {percent}`; `update-downloaded` â†’ `app:update-downloaded {forced:false}` â†’ renderer shows "restartingâ€¦" â†’ `app:update-install` invoke â†’ `quitAndInstall()`.

**D. Post-update "what's new" (next launch)** using device-global `update-state.json`:
- `cur = app.getVersion()`.
- if `pending && pending.version === cur` â†’ push `app:whats-new {version:cur, changelog}`; clear pending.
- else if `lastSeenVersion && semver.lt(lastSeenVersion, cur) && isPatchOnlyBump(lastSeenVersion, cur)` â†’ best-effort fetch version.json changelog â†’ push `app:whats-new` (fallback).
- minor/major bump â†’ no what's-new (user already saw changelog up front).
- always set `lastSeenVersion = cur`.

## Tasks (atomic commits)

1. **build**: `npm install electron-updater` (â†’ dependencies, not dev). `electron-builder.yml`: add `publish: {provider: github, owner: sei-studio, repo: sei}`; add mac `zip` target alongside the existing `dmg` (electron-updater installs from the zip, not the dmg); replace the "DO NOT add publish" comment with a D-63-reversal note referencing this task. **USER-ACTION note in SUMMARY**: packaged-build verification required â€” electron-builder.yml unpacks `node_modules/**/*` (the reason mac is already two-dmg, not universal); electron-updater + its transitive deps enlarge that unpack set, so confirm (a) the generated `app-update.yml` owner/repo matches the real GitHub release, (b) electron-updater resolves from `app.asar.unpacked`, and (c) both arch dmgs + zips still build. Not validatable here.
2. **main/policy**: `src/main/updatePolicy.ts` â€” pure fns (NO electron import): `deriveLevel(cur, latest): 'optional'|'mandatory'|'none'`, `isPatchOnlyBump(from, to)`, `normalizeApply(raw): 'on-restart'|'now'`, `shouldShowWhatsNew(lastSeen, cur)`. Use `semver`. + `src/main/updatePolicy.test.ts` (vitest): optional/mandatory/none, multi-version skip, patch-only, apply normalization.
3. **main/state**: `src/main/updateStateStore.ts` â€” device-global `<userDataRoot>/update-state.json` `{version:1, lastSeenVersion, pending:{version,changelog}|null}`. Mirror `wizardStateStore.ts` (atomicWrite + withFileLock + defensive parse). Add a device-global path helper in `paths.ts` analogous to the wizard-state file (MUST be `userDataRoot`, not `profileRoot` â€” version is per-install). NOTE (checker finding 5): the what's-new/state path runs in dev too (only `autoUpdater` is `app.isPackaged`-gated). In an unpackaged dev build `app.getVersion()` returns a benign string â€” the store must tolerate it and not write junk; simplest is to skip the what's-new check entirely when `!app.isPackaged`.
4. **shared+preload**: `src/shared/ipc.ts` â€” extend `UpdateAvailableEvent` (`level`, `apply?`, `changelog?`); add `UpdateProgressEvent`, `UpdateDownloadedEvent`, `WhatsNewEvent`; add `IpcChannel.app` channels: push `updateChecking`, `updateNotAvailable`, `updateProgress`, `updateDownloaded`, `updateError`, `whatsNew`; invoke `updateCheck`, `updateDownload`, `updateInstall`, `version`. `src/preload/index.ts` â€” extend the existing app object: keep `onUpdateAvailable`, add `onUpdateChecking/onUpdateNotAvailable/onUpdateProgress/onUpdateDownloaded/onUpdateError/onWhatsNew`, and `checkForUpdates()/downloadUpdate()/installUpdate()/getVersion()`.
5. **main/updater**: `src/main/updater.ts` â€” `autoUpdater` wiring + flows A/B/C/D + the version.json fetch (port the `net.request` logic out of `updateChecker.ts`). Delete `src/main/updateChecker.ts` **and any stale `src/main/updateChecker.js` shadow**. `index.ts`: replace the `checkForUpdate` setTimeout block with `initUpdater(getMainWindow)` and run the what's-new check on launch (skipped when `!app.isPackaged`). `ipc.ts`: register `update-check/update-download/update-install/version` handlers.
6. **renderer/popup**: `src/renderer/src/components/UpdatePopup.tsx` (+ `.module.css`) â€” modal following the existing modal pattern (overlay, sharp card, tokens.css, `Button`). Prop-driven states: `available-optional` (changelog + [Update now]/[Later]), `downloading` (progress bar â€” `PercentBar` exists at `components/PercentBar.tsx`, props `{value, label?, size?}`, reuse it), `downloaded` ("restartingâ€¦"), `forced` (non-dismissable "Critical update â€” restartingâ€¦"), `whats-new` (post-update changelog + [Got it]). Render changelog with minimal markdown (## heading, - bullet) â€” no new dependency. Wire in `App.tsx`: replace the `UpdateToast`/`updateInfo` block with the full subscription set driving `UpdatePopup`. **Delete `UpdateToast.tsx` AND its `UpdateToast.js` shadow** (it has no `.module.css` â€” inline styles).
   - **Vite `.js`-shadow trap (checker finding 1 â€” known Sei pitfall)**: `tsc --build` emits `.js` next to `.tsx` and Vite serves the stale `.js` over edited `.tsx`. `src/renderer/src/App.js` imports `UpdateToast`; after editing `App.tsx` and deleting `UpdateToast.tsx`, the stale `App.js` + `UpdateToast.js` must be removed or the build resolves to dead JS. After all renderer edits: delete the `.js` artifacts shadowing edited/removed `.tsx` files (skip `src/bot`), then restart dev.
7. **renderer/settings**: `SettingsScreen.tsx` â€” new "Updates" section: current version (via `getVersion()`), "Check for updates" `Button` â†’ `sei.checkForUpdates()`, inline status text reflecting events. Follow existing Settings section styling.
8. **tests**: run `npx vitest run`; keep the suite green; fix fallout (App.tsx/preload type changes). Commit.

## Verification (UAT)

- [ ] `npx vitest run` green (incl. new `updatePolicy.test.ts`); `tsc` clean (baseline 2 pre-existing tsconfig.node errors acceptable).
- [ ] `deriveLevel`: minor/major â†’ optional, patch-only â†’ mandatory, no-bump â†’ none, multi-version-skip with minor diff â†’ optional.
- [ ] No `electron-updater` import in any renderer or pure-fn file; `autoUpdater` only touched behind `app.isPackaged`.
- [ ] `update-state.json` resolves under `userDataRoot` (device-global), not `profileRoot`.
- [ ] `electron-builder.yml` has `publish` + mac `zip`; package.json has `electron-updater` in `dependencies`.
- [ ] `updateChecker.ts` + `UpdateToast.tsx` removed; no dangling imports.

## Out of scope (deferred, per design conversation)

Staged/percentage rollout, update telemetry, Windows code-signing, beta/stable channels,
rollback, enterprise opt-out. End-to-end install can only be validated on a packaged build
against a real GitHub release â€” recorded as a USER-ACTION, not done here.




