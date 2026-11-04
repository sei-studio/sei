# Build & release

Bundler is **electron-vite** (`electron.vite.config.ts`), three targets:

- `main` and `preload` use `externalizeDepsPlugin`; **preload outputs `.cjs`**.
- Build-time `define` injects OPTIONAL overrides from `.env`: `SUPABASE_URL` +
  `SUPABASE_ANON_KEY` (direct-to-Supabase, for self-hosters; anon key is public
  by design — RLS is the security boundary) and `SEI_PROXY_URL`. Since the
  260704 anon-key migration a build with NO `.env` is fully functional:
  `src/main/env.ts` routes Supabase through the proxy's transparent
  `/supabase/*` reverse proxy (`https://api.sei.gg/supabase`) with a
  placeholder key the proxy swaps for the real anon key server-side.
  `SEI_PROXY_URL` is defined ONLY when set — an unconditional `?? ''` define
  used to replace `process.env.SEI_PROXY_URL` with `''` and dead-code every
  `?? 'https://api.sei.gg'` runtime fallback. See `.env.example`.

Packaging is **electron-builder** (`electron-builder.yml`):

- `appId: com.sei.app` is **LOCKED** — changing it strands every existing user's
  `safeStorage` keychain entries. Treat as irrevocable.
- `asar: true`, with `asarUnpack` for **`src/bot/**`**, **`node_modules/**`**
  (so the forked bot can resolve its native + ESM deps from outside the asar),
  and **`resources/skins/**`**.
- **macOS:** per-arch (`arm64`/`x64`) `dmg` + `zip`, `hardenedRuntime` +
  notarization (Apple Team ID from the `APPLE_TEAM_ID` env var). The `zip` is
  what electron-updater installs from; the `dmg` is manual download only.
- **Windows:** NSIS x64, ONE-CLICK per-user installer since 260929 (was the
  assisted installer through v0.6.4). Upgrade safety from assisted installs and
  the per-machine migration hook (`build/installer.nsh`) are documented above
  the `nsis:` block in electron-builder.yml; `.github/workflows/nsis-upgrade-check.yml`
  (manual dispatch) re-verifies them on windows-latest. Release builds are
  signed through Azure Trusted Signing (the "unsigned for v1" note is stale).
- **Linux:** AppImage (best-effort unsigned).
- `postinstall` runs `electron-builder install-app-deps` to rebuild native
  modules against Electron's ABI.
- **Version bumps:** run `npm install --package-lock-only` only where
  `node_modules` is already installed. In a fresh worktree without it
  (v0.6.5-beta.2) it looped through postinstall and stripped the `libc`
  fields from the lockfile; after a bump, `git diff package-lock.json` should
  show only the version lines.

**No remote debugging in stable builds (260925).** The fuses
(`electronFuses` in `electron-builder.yml`) turn off RunAsNode, NODE_OPTIONS and
`--inspect`, but Chromium's `--remote-debugging-port` / `--remote-debugging-pipe`
have no fuse: any local process could relaunch the signed app with CDP and drive
the renderer (preload IPC + TCC grants). `src/main/remoteDebugGuard.ts`, the
FIRST import of `src/main/boot.ts` (the main entry since 261031), calls `process.exit(1)` when a packaged
build whose version has no prerelease tag sees `--remote-debugging-*`,
`--inspect*`, `--debug-port` or `--js-flags` (argv scan plus
`app.commandLine.hasSwitch`; pure policy in `remoteDebugPolicy.ts`). Packaged
betas (`X.Y.Z-beta.N`) and dev are unaffected. Measured on Linux: Chromium
opens the DevTools port only AFTER the main script has evaluated, so exiting
there means the port never listens. Consequence: **installed-app CDP
verification (`open -a Sei --args --remote-debugging-port=...`) only works on a
beta**; a stable install quits immediately. Keep the guard the first import, and
never `appendSwitch` a debugging switch in production code.

Common scripts: `npm run dev` (electron-vite dev), `npm run build`,
`npm run dist:mac` / `dist:win` / `dist:linux`.

### Updater

`src/main/updater.ts` drives **electron-updater** over the **GitHub Releases**
feed (`publish: github`, `sei-studio/sei`). It is loaded **only behind
`app.isPackaged`** — `autoUpdater` throws when unpackaged, so dev runs the pure
policy functions only. A side-channel `GET https://sei.gg/version.json` carries
`{ version, apply, changelog }` to decide ask-first vs silent install. On macOS
updates install from the zip artifact. Semver alone sets the level (patch =
mandatory, minor/major = optional, `updatePolicy.ts`), except that an optional
`minSupported` in the policy feed (version.json, and version-beta.json for
beta users) makes the update mandatory for installs below it
(`applyMinSupported`, 261031); missing or invalid = no effect, timing still
from `apply`. Velopack installs share this path.

**The download never blocks the app (260801).** Two renderer surfaces, split by
whether the state needs a decision right now: `UpdatePopup` is the modal (the
optional-update offer with its changelog, the post-update what's-new, and the
`apply:'now'` restart); everything else lives in `useUpdateStore` and never
takes the pointer. Before the split, `app:update-progress` drove the popup into
a scrimmed `downloading` state with no dismiss path, so a routine MANDATORY
patch, which updater.ts deliberately downloads without asking, locked the user
out of the app until it finished. The consented flow no longer auto-installs
either: the accepted download may land minutes later with the user mid-game,
so `autoInstallOnAppQuit` applies it on the next quit and the UI only OFFERS
the restart. `forced` is the one state that still takes the window, because
main quits a few seconds later regardless. The downloading state has no
dismiss (nothing to decide while it works), so `App.tsx` clears it on
`app:update-error` or a dead download pins it at whatever percent it reached
(`clearRail` never clears a READY update).

**"Update Sei" is a sidebar button, and one click finishes the job (261023).**
`UpdateRailButton` sits full-bleed at the foot of `IconRail` (Telegram's
"Update Telegram" footer is the reference): a quiet hairline bar while
downloading, a `--green` to `--accent-strong` block when ready, a spinner while
restarting. It replaced the corner `UpdatePill`, which was easy to dismiss and
forget. A click while a call, a companion bot, chess, a screen share or a
Draw! turn is live confirms first (`liveSessionForRestart`). The install args
come from `src/main/updateInstall.ts` (`restartInstallArgs`). macOS ignores
them (Squirrel relaunches). The update-on-quit run stays `--updated /S` with
no relaunch. `build/installer.nsh` tells the silent runs apart by
`--force-run`: the one-time legacy per-machine cleanup (a UAC prompt) runs on
the in-app restart but never on the quit run.

**Windows restart = Sei's own update progress window (261030, corner 261031).**
The install re-unpacks the whole app (median ~104 s for real users), and with
nothing on screen people thought Sei had crashed. On win32 `restartIntoUpdate`
in updater.ts (both "Update Sei" and the forced `apply:'now'` restart) calls
`installWithProgressWindow` (`src/main/windowsUpdateInstall.ts`):
`updateProgressHelper.ts` copies `resources/update-progress/` (a Windows
PowerShell 5.1 + WPF script, bundled Oswald/Rajdhani fonts, logo) to a private
`%TEMP%` folder and starts it in two stages (stage 1 is Sei's child and only
starts the detached window process, which escapes node's kill-on-close job).
Everything the window says, its theme (from `theme_mode`), language (en/zh)
and its time-based bar curve (estimate from past `installSeconds`, the
download counted as the first 40%) come from a `config.json` built and
unit-tested in TypeScript; the script only plays it back and watches the
installer process, the new Sei process and its first window, then sprints to
100% and fades out. Once the window reports `ready` (first frame, within
12 s, 20 s if WPF already loaded) Sei quits with `quitAndInstall(true, true)`
= `--updated /S --force-run`, so no installer window shows under it. No
`ready` (Group Policy blocks scripts, Constrained Language Mode, a slow
machine) = the stock path, `quitAndInstall(false, true)` = `--updated
--force-run`, the one-click "Installing, please wait" banner. The window sits
in the **bottom-right corner of the primary display's work area** (above the
taskbar, the card 16 px in from the edges; Shawn, 261031) so the user can keep
using the computer, is topmost only for its first 4 s (while Sei's own window
is going away), is draggable, and if no Sei comes back it starts `Sei.exe`
itself, then says so and closes on a click or after a minute (hard cap 15
min). The script must stay ASCII (PS 5.1 reads BOM-less scripts in the ANSI
code page); non-English text arrives through config.json. CI:
`nsis-upgrade-check.yml` `suite=progress` runs the real upgrade under the
window, `suite=preview` (no build, a few minutes) records each theme/language
over a stand-in installer and asserts the corner placement; stills and video
are the artifacts. An
An
accepted OPTIONAL download stashes `pending` with `brief: true`, so the
relaunch shows the small `UpdatedToast` ("Updated to Sei X" plus the first
changelog bullet, `topChangelogLine`) instead of reopening the changelog the
user already read; mandatory updates keep the full what's-new modal.

**Windows moves to Velopack (v0.7.0, 261030).** macOS stays on
electron-updater. Through v0.7.x every Windows release ships BOTH the NSIS
installer (the sei.gg download and the electron-updater feed) and Velopack
files mirrored to `dl.sei.gg/velopack`; NSIS installs move to Velopack only
when `migration.<channel>.json` says so. `src/main/updater.ts` picks
`velopackUpdater.ts` when the running copy was installed by Velopack. A
Velopack update or migration Setup is applied only after its sha256 matches
the feed AND Windows reports it Authenticode Valid and signed by the
`WIN_PUBLISHER_NAME` baked in at build (`SEI_WIN_PUBLISHER`,
`velopackVerify.ts`; unsigned builds skip the check), and only while the
rollout file on dl.sei.gg allows it (an unreadable one holds the update).
Release steps, the asset counts for publishing the draft, the three-part kill
switch (update rollout to 0, the GitHub release back to draft, migration to
0), rollback-by-rolling-forward, the users' way out of a broken Velopack copy,
re-running a cancelled mirror, and the one-time move of the workflows to
`main` are in **`docs/design/velopack-runbook.md`**. Read it before any
Windows release.

**Staged rollout (electron-updater, 261101).** Every shipped client (0.6.x,
electron-updater 6.8.3) honours `stagingPercentage` in latest.yml /
latest-mac.yml: `AppUpdater.isStagingMatch` offers the update only when the
device's bucket (the last 4 bytes of the UUID in `<userData>/.updaterId`, as a
fraction of 2^32) is below N/100. Field absent = everyone; **0 = nobody**
(bucket < 0 never holds), so 0 is the pause value; a value that is not an
integer reads as everyone, which is why the script accepts only 0-100.
`.github/workflows/rollout.yml` (inputs `tag`, `action` set|pause|promote,
`percent`, `force`, `dry_run` default true) rewrites the field in the GitHub
release's feed ymls (`gh release upload --clobber`) and in the dl.sei.gg
mirror's flat `updates/*.yml` that serve that version, keeping every other byte
(`scripts/set-staging.mjs` over `scripts/lib/stagingYml.mjs`, tested). It
refuses a prerelease tag unless `force` (betas stay at 100%) and a tag with
two releases (delete the stray draft first). `mirror-release.yml` re-reads the
ymls just before writing them and keeps a same-version value the mirror
already has, so a publish or re-mirror cannot reopen a paused rollout.
- Default for a stable: set 20% on the DRAFT, publish, 50% after a day with
  no bad signal, then promote:
  `gh workflow run rollout.yml -f tag=vX.Y.Z -f percent=20 -f dry_run=false`,
  `... -f percent=50 -f dry_run=false`,
  `... -f action=promote -f dry_run=false`.
  Buckets are fixed per device, so raising the percent only adds devices.
- Rollback = `-f action=pause -f dry_run=false` (no new installs take it),
  then ship the fix as the next patch. electron-updater never downgrades:
  installs already on the bad version, or holding its download for the next
  quit, keep it until the fix arrives.
- Not staged: new downloads from sei.gg, and Velopack installs (0.7.0+
  Windows, `velopack-rollout.yml`). Beta-channel clients below the stable read
  the same staged yml (GitHub) or its beta* copy (mirror).
- `release: published` and `workflow_dispatch` run the DEFAULT branch's
  workflow files, so `rollout.yml`, `mirror-release.yml`,
  `scripts/set-staging.mjs` and `scripts/lib/stagingYml.mjs` must be on
  `main`. Runbook: `docs/design/velopack-runbook.md`, "Staged rollout
  (electron-updater)".

### Boot safety and settings recovery (261031, T277)

A build that cannot start must still be able to update itself, and a damaged
`config.json` must not throw a signed-in user back to onboarding.

- **Entry shim.** `src/main/boot.ts` is the main entry (`dist/main/index.js`);
  `src/main/index.ts` is the app, built as `dist/main/app.js` and loaded with
  `await import('./index')` only in normal mode. boot.ts imports the
  remoteDebugGuard / velopackBoot / velopackMigration trio first (same order
  as before), sets the app name + userData, takes the single-instance lock,
  runs the boot guard, then starts the updater on `ready` BEFORE the app's own
  bootstrap. Anything boot.ts imports statically also loads in safe mode, so
  keep heavy modules (games, auth, native addons) behind the app import.
  Shared code lands in `dist/main/chunks/`, where `__dirname` is the chunk
  folder: use `app.getAppPath()` for repo-relative paths in main.
- **Failed starts.** `<userData>/boot-state.json` (written synchronously,
  never in the settings store; `bootGuard.ts` pure, `bootContext.ts` the
  process state). A normal start writes a pending record and succeeds when
  the main window's renderer sends `app:renderer-ready` (App.tsx mount) and
  the app stays up `SUCCESS_HOLD_MS` (5 s). Failures: the previous pending
  start never finished (`unclean_exit`: crash, kill, power loss), bootstrap
  threw, the app graph failed to import, the renderer died or its main frame
  failed to load before ready, or a quit at least `NEVER_READY_QUIT_MS` (30 s)
  after start with no ready ping. An in-process failure is recorded and Sei
  relaunches itself; the guard picks safe mode once `FAILURE_THRESHOLD` (2)
  failures are in a row. A new app version resets the count, safe-mode runs
  never count, update hand-overs (`restartIntoUpdate`, `restartIntoVelopack`,
  a Velopack apply at launch) are neutral (`noteNeutralExit`), and so is an
  OS shutdown or log-off (`noteOsShutdown`, from crashReporting.ts's
  `session-end` / powerMonitor `shutdown`). A renderer gone with reason
  `clean-exit` never counts; `killed` counts only if no OS shutdown shows up
  within `KILLED_GRACE_MS` (3 s) (`rendererGoneVerdict`). The main window
  closing before the start is judged judges it then, by the quit rule
  (`noteMainWindowClosed`): on macOS a window closed during the splash and a
  quit hours later is neutral. Dev counts
  nothing unless `SEI_BOOT_GUARD=1`; `--safe-mode` or `SEI_SAFE_MODE=1`
  forces safe mode anywhere.
- **Crash analytics seam (T280).** boot-state.json and session.json stay
  separate files. A start the guard judges failed is written `start_failed`
  to session.json BEFORE Sei relaunches (`app.exit(0)` would otherwise read
  as a clean quit), opens safe mode in-process, or quits never-ready
  (`onStartFailed`, registered by crashReporting.ts `linkBootGuard`). Starts
  that die before crash reporting runs are written by boot.ts
  (`recordFailedStart`): the previous normal start left pending with no
  marker of its own, and an app graph that failed to load. Safe-mode runs
  write no marker.
- **Safe mode** never loads the app graph: no games, native addons, overlays,
  desktop companion, voice, bot, auth or analytics. It runs the updater
  (`initUpdater({safeMode: true})`, electron-updater or Velopack; the NSIS to
  Velopack migration is not scheduled) and a small window
  (`safeMode/`: page = `safeModePage.ts` as a data: URL with a strict CSP,
  sandboxed preload `src/preload/safeMode.ts` built to
  `dist/preload/safeMode.cjs`, which may import only electron). Buttons:
  Check for updates / download / restart, Try normal start (one-shot
  `forceNormalOnce`, then relaunch), Reset settings (confirmed; every
  profile, keeps `RESET_KEEP_KEYS` identity, the old file set aside as
  `config.before-reset-<ts>.json`), Open logs folder. Copy is en + zh.
  Updater pushes are held until the renderer is listening (ready ping, with
  fallback flushes) so an early "update available" is not lost. A check
  with no updater event for `SAFE_MODE_CHECK_TIMEOUT_MS` (30 s) gives the
  button back with a plain "no answer" line.
- **Settings recovery** (`configStore.ts`, header comment has the details):
  durable writes (`durableWrite.ts`: temp + fsync + rename), last-known-good
  `config.json.bak`, damaged files quarantined as
  `config.corrupt-<ts>.json` (newest 3 kept) then restored from the backup,
  else the newest quarantined copy that parses (T283), else rebuilt from the
  identity keys readable in the damaged text, the backup and the
  quarantined copies, else defaults. A config that is MISSING while a
  backup or quarantined copy sits beside it (a restore that never landed)
  is recovered the same way instead of reading as defaults. A recovery that
  cannot be written back (read-only folder, disk full) is HELD in memory for
  the process (`heldConfigs`): reads serve it (no second quarantine, one
  report), saves update it without throwing and retry the disk, the first
  write that lands quarantines a damaged file still in place and drops the
  hold, and a valid file appearing on disk wins. Safe-mode Reset COPIES the
  old file aside before replacing it, so config.json is never missing in
  between. Unknown keys from
  a newer build are kept on every write; `schema_version` is stamped and
  migrations are idempotent. Logs carry kinds and key names, never values.
- **Recovered is not new (T283).** Onboarding is keyed on `preferred_name`,
  and a config recovered to defaults has none. Every renderer path that
  routes a nameless profile to onboarding (boot `bootDestination`, the
  scope-changed handler, the import-offer resolve, OnboardApp's
  `accountHasProfile`) first asks `config:profile-state`
  (`profileSetupState.ts` -> `configStore.configShowsPriorSetup`; renderer
  `lib/profileSetUp.ts`). Set up before = this process recovered the
  config, a `config.corrupt-*` copy exists, the `.bak` or a
  `config.before-reset-*` copy names the player (Reset runs on every
  profile, so a nameless pre-reset copy is no evidence), or a companion has
  a `MEMORY.md` or a `chat.jsonl` with a user or companion line (system
  play rows alone can land after a factory reset wipe).
  A config + backup with no name (an onboarding left half way, or a fresh
  install after main's boot writes) is still new. Such a profile goes home
  signed in (main first reads the name back from the cloud profile,
  bounded 5 s) and to the sign-in panel signed out, whose "Continue
  locally" then goes home; a still-missing name is set in Settings.
- **Analytics** (packaged only, through the normal helper so opt-out holds):
  `boot_safe_mode_entered {reason, failures}` on the first normal start after
  a safe-mode run, `settings_recovered {kind}` (`salvaged`, `restored_backup`,
  `restored_quarantine` since T283, `reset_defaults`; once per recovery).
- Verify the page in a plain browser: render `renderSafeModeHtml` with a
  stub `window.seiSafeMode`. Live: `SEI_BOOT_GUARD=1` and kill two starts
  before ready, or launch with `--safe-mode`.

### Startup popup (261027, replaced the notices inbox)

One operator page from sei.gg shown once per install, set by the optional
`popup` field of `https://sei.gg/notices.json`:
`{ id, url, minVersion?, maxVersion?, until?, width?, height?, skipIf? }`. Clients up to
0.6.9 read only `notices` and ignore it; new clients no longer show `notices`
(the Playtime "Inbox" button and `NoticesInboxModal` are gone). How to publish
one is in the website repo's `README-popup.md`.

- **Rules (main, pure):** `src/main/startupPopup.ts`. `url` must be
  `https://sei.gg/popup/...` (no credentials, no other host/port/scheme);
  a bad version, date or url drops the popup (fail closed); `width`/`height`
  count only as an in-bounds pair, else the page is 70% of the window.
  `skipIf` (261029) names a condition from `POPUP_SKIP_CONDITIONS`
  (today only `"chatgpt-connected"`: the active ChatGPT account is signed in
  with plan usage, checked in `notices.ts` `skipConditionHolds`) under which
  the install does not need the popup; it is re-checked at every hand-out and
  in the loaded handler, and a skipped popup is not recorded. A `skipIf`
  this build does not know drops the popup (fail closed). That does NOT
  cover older builds: v0.6.10 (the first with the popup) ignores unknown
  keys, so it shows the popup without the skip and opens action links in
  the browser. **A popup that uses `skipIf` or an action link must set
  `minVersion` to the first release that ships them (0.7.0, or
  `0.7.0-beta.0` to include betas: semver ranks `0.7.0-beta.N` below
  `0.7.0`), and the fallback page at each action URL must be live on sei.gg
  before the feed entry is.**
- **Feed + show-once:** `src/main/notices.ts` refreshes on the updater
  cadence (startup, focus, resume, 30 min, manual check) and in dev too. An
  unreachable, unparseable or non-object feed keeps the last state (never
  takes a popup down). Shown ids live in `popupShownIds` in
  `<userData>/notices.json`, recorded only when main confirms the frame
  committed a 2xx page (`app:startup-popup-loaded`). A page that 404s, is
  offline or never loads shows nothing and stays owed. Dev only
  (`!app.isPackaged`): `SEI_NOTICES_URL` overrides the feed and its origin is
  allowed for popup pages.
- **Rendering:** `components/StartupPopup.tsx`, a sandboxed iframe
  (`sandbox="allow-popups"` and nothing else: no scripts, opaque origin, no
  forms, no top navigation; cross-origin so it runs out of process and gets no
  preload). Loaded hidden, revealed only after main's 2xx check. Waits for a
  calm screen (`popupUiReady`: home/character/awaken/settings/credits/
  coming-soon, no modal, tour, first moment, call, game or share). Closes on
  the X (inside the page's top-right corner on a translucent dark disc since
  261029, fixed colours because it sits on the page's art), Esc (ignored
  while another dialog is open on top) or a click outside the page. z 1000
  (ModalShell base, was 1100), and App.tsx mounts it BEFORE every dialog
  (the `modal?.kind` group, the setup wizard, ToS, import offer, migrate,
  hard stop, update, recovery), so a dialog that appears after it lands on
  top of it. Keep it first if you add dialogs.
- **Never in a first-run session (261029, `lib/firstRunSession.ts`).** A
  session that shows the Sui onboarding scene, the tour or the first moment,
  or boots with a saved unfinished tour (`tutorial_state`, read before the
  first look because boot routing can put Home up before it resumes the
  tour), holds the popup until the next launch. The calm-screen check alone
  had gaps: a tour ending without a first moment lands on a calm Home, so
  does the first Home visit after the first-moment card. The popup stays
  owed (never recorded), so nothing is lost.
- **Action links (261029, `src/shared/popupActions.ts`).** A popup button
  that does something in the app is a plain link to
  `https://sei.gg/popup/_action/<name>` (a page with `<base target="_blank">`
  routes it through `setWindowOpenHandler`, otherwise `will-frame-navigate`).
  Main cancels it (nothing is fetched), checks the name against
  `POPUP_ACTIONS` and that it came from the committed popup frame (the
  navigating frame shows a popup page, or, for window.open, a popup page is
  committed in some subframe), and pushes it on `app:startup-popup-action`.
  The renderer closes the popup and runs `runPopupAction`
  (`lib/popupActions.ts`), which checks the name again. Unknown names and
  action URLs from any other frame are dropped (no browser tab either); an
  action URL is never an allowed popup page. Actions take NO parameters from
  the URL. A followed link is not proof of a click (a meta refresh or a
  `Refresh` header navigates the script-less page too), so the renderer
  takes actions only while the popup is shown and not in its first
  `POPUP_ACTION_ARM_MS` (500 ms, `armShownPopup` in
  `lib/startupPopup.ts`); popup pages must not use a refresh. One action
  runs at a time (`runPopupAction`'s in-flight latch), so a double click
  starts one browser sign-in. `chatgpt-plan` opens Settings scrolled to the
  ChatGPT plan row (`view.focus: 'chatgpt-plan'`, a short highlight) and
  does what the row's own button would: start "Continue with ChatGPT" (then
  the "Use ChatGPT plan" switch with its cloud -> local confirm, only if
  plan use really came back on), sign in again with `enablePlan` for an
  account signed in with plan use declined (a plain sign-in re-approves
  without the plan scope), run the switch for an account already signed in,
  or only show the row when the plan is in use or a sign-in is running. The
  `view.useChatgptPlan` switch intent is one-shot
  (`lib/chatgptPlanIntent.ts`): Settings drops it when the plan is not
  ready rather than waiting, so it cannot fire later. Clients older than the action open the URL in the
  browser, so sei.gg must serve a fallback page at each action URL saying
  where the feature is in the app. Adding an action = the name, a renderer
  case, a test, and that fallback page.
- **Main guards** (`src/main/popupFrameGuards.ts`): EVERY subframe of the
  main window is navigation-locked to the popup allow-list; any other link
  opens in the default browser through `assertSafeExternalUrl` (only when
  the navigating frame is showing a popup page, i.e. following a link; a nested
  `<iframe>` embed's first load is cancelled silently), and
  `setWindowOpenHandler` denies all child windows the same way (action links
  excepted, above). A future
  feature that embeds another iframe in the main window must extend this
  allow-list deliberately. sei.gg sends `X-Frame-Options: SAMEORIGIN`, so the
  header (and CSP `frame-ancestors`) is dropped for allowed popup URLs loaded
  as a subframe of the main window only. Keys typed inside the frame never
  reach the renderer, so Esc is relayed from `before-input-event`
  (`app:startup-popup-escape`); CDP `Input.dispatchKeyEvent` bypasses that
  hook, so test it with a real key (xdotool).

---
