---
quick_id: 260604-uoy
slug: plan-and-implement-the-in-app-updater-tw
date: 2026-06-04
status: complete
---

# Summary: In-app updater (electron-updater) with two policy levels

## What shipped

A real in-app updater replacing the notify-and-redirect-to-website flow
(`updateChecker.ts` + `UpdateToast.tsx`). Driven by `electron-updater` over the
GitHub Releases channel; update **policy** (changelog + mandatory timing) carried
by `https://sei.gg/version.json`. Reverses decision **D-63**.

- **Two policy levels, derived from semver** (`src/main/updatePolicy.ts`): major/minor
  bump → **optional** (ask up front, changelog popup, download on consent, restart);
  patch-only bump → **mandatory** (silent).
- **Mandatory has two timings** (`version.json.apply`): `on-restart` (default — applies
  on next quit, what's-new shown next launch) and `now` (immediate forced restart).
- `src/main/updater.ts` — autoUpdater wiring, Flows A–D, guarded on `app.isPackaged`.
- `src/main/updateStateStore.ts` — device-global `update-state.json` (lastSeenVersion +
  pending what's-new) under `userDataRoot()`; `paths.updateStatePath()`.
- `src/renderer/src/components/UpdatePopup.tsx` — modal with states available-optional /
  downloading / downloaded / forced / whats-new; `App.tsx` subscribes to all events.
- IPC contract + preload bindings (`shared/ipc.ts`, `preload/index.ts`,
  `main/ipc.ts` handlers: update-check/download/install/version).
- `electron-builder.yml`: `publish` (github sei-studio/sei) + mac `zip` target.

## Commits (clean, on `dev`)

| # | SHA | Scope |
|---|-----|-------|
| 1 | `57667aa` | build: electron-updater dep + publish config + mac zip |
| 2 | `067ab4a` | updatePolicy.ts (+19 tests) + updateStateStore.ts + paths |
| 3 | `2a7015b` | updater.ts + index.ts wiring + ipc.ts handlers; del updateChecker.ts |
| 4 | `e0c8ca1` | IPC contract (shared/ipc.ts) + preload bindings |
| 5 | `85f2da8` | UpdatePopup + App.tsx; del UpdateToast.tsx |

## Verification

- **Clean updater state (isolated worktree, no WIP): vitest 607/607 pass, web `tsc` clean.**
- Commit range `f7be49d..85f2da8` = 17 updater files, **zero WIP-token leak** (verified).
- 2 node-`tsc` errors in `characterStore.ts`/`personaExpansion.ts` are **pre-existing at
  f7be49d** (the user's persona-expansion-progress refactor straddles committed/uncommitted
  code) — NOT introduced by this task; confirmed by running node-tsc on pure f7be49d.

## Re-split note (important)

This task was executed against a dirty ~80-file working tree (parallel Phase-15
planning + a SettingsScreen refactor + UI work). The first execution swept that WIP
into the updater commits. At the user's direction the commits were **un-entangled**:
soft-reset, then the updater changes for 6 shared files (`paths.ts`, `index.ts`,
`ipc.ts`, `shared/ipc.ts`, `preload/index.ts`, `App.tsx`) were reconstructed as
`base+updater` index blobs (byte-exact, verified updater-only) and recommitted; all
WIP was left uncommitted in the working tree.

- **SettingsScreen.tsx is intentionally NOT in the updater commits.** Its "Check for
  updates" UI is intertwined with the in-flight SettingsScreen refactor (the update-check
  button reuses the base dev-console `<Button>` DOM; deviation #2 below sits in the same
  hunk). It was left whole in the user's WIP; the Settings updater UI lands when the user
  commits their Settings work. The updater backend does not depend on it.
- Safety net: the original entangled 8-commit state is preserved on branch
  **`wip-backup-260604-uoy`** + tag **`uoy-entangled-snapshot`**. Delete once satisfied.

## Deviations

1. First execution entangled WIP into the updater commits (now un-entangled — above).
2. The original commit `f5d5c82` re-added the line "Useful for debugging skin and bot
   issues." to satisfy a stale `SettingsScreen.test.tsx` A7.4, reverting a user WIP
   removal. That change now lives only in the user's uncommitted SettingsScreen WIP
   (not in any clean commit) for the user to resolve (update the test vs keep the line).

## USER-ACTIONS (not validatable here — needs packaged build + real release)

1. Create the first GitHub release with `publish` configured so `sei-studio/sei` Releases
   carries artifacts + generated `latest-mac.yml`/`latest.yml`/`latest-linux.yml`.
2. Verify packaged-build dep resolution: (a) generated `app-update.yml` owner/repo matches
   the real release repo, (b) `electron-updater` resolves from `app.asar.unpacked`,
   (c) both arch dmg **and** zip still build (the `node_modules/**/*` asarUnpack +
   universal-merge "pattern too long" wall must not return).
3. Extend `version.json` schema with `apply` + `changelog` and serve it from sei.gg.
4. Only then can end-to-end install (download → apply → relaunch → what's-new) be validated.

Deferred per design conversation: staged rollout, telemetry, Windows signing, channels,
rollback, enterprise opt-out.
