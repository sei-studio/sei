# SeiLink desktop host (261104, milestone 3)

The companion's room as a live wallpaper: one window behind the desktop
icons on the primary display (Windows: the WorkerW/Progman layer; macOS: the
desktop window level plus a small hit panel over her). Behind the SeiLink dev
flag (`seilinkDevEnabled()`: unpackaged with `SEI_SEILINK_PACKS`) until the
dock and first-run milestone. Linux reports `unsupported_platform`; the app
builds and runs the same.

The numbers and the Windows recovery rules come from the spike
(`exp/seilink-spike`, `spikes/seilink/`), measured on windows-2022/2025 and
macos-15/26.

## Processes and files

```
main (src/main/seilink/host/seilinkHost.ts)        host (hostEntry.ts, same binary)
  startSeilinkHost(id) ──spawn──▶  Sei --seilink-host --seilink-ipc=<pipe>
  HostSupervisor (supervisor.ts)        --seilink-userdata=<userData>/SeiLinkHost [--seilink-test]
  pipe server  ◀── newline JSON ──▶ pipe client (protocol.ts)
                                   BrowserWindow seilink-host.html
                                     preload src/preload/seilinkHost.cjs
                                     page SeilinkHostView → RoomCanvas → HostAvatar (RoomAvatar)
```

- `boot.ts` sends a `--seilink-host` launch to `hostEntry` (dynamic import, a
  small chunk) before the app name, the single-instance lock, the boot guard
  or the updater. `velopackBoot` / `velopackMigration` skip host launches.
  The pipe token rides in env `SEI_SEILINK_TOKEN`; main ignores every
  connection until a `hello` with that token from the pid it spawned.
- Pipe: `\\.\pipe\sei-seilink-<pid>` on Windows, `<tmp>/sei-seilink-<pid>.sock`
  elsewhere. Line limit 4 MB, so file BYTES never travel over it.
- The host has its own userData (`<mainUserData>/SeiLinkHost`: host.log,
  stdio.log, its own Chromium session) and owns no app state.
- Addon: `native/seilink` (win.cc, mac.mm; CI click helpers in ci/), built by
  `scripts/build-seilink-addon.mjs` into `resources/seilink/seilink.node`
  (mac universal via lipo, win x64). Loaded only in the host through
  `native.ts` (`bundleRequire`, never `createRequire(process.cwd())`).
  `--test` also builds `native/seilink/out/seilink_test.node` (synthetic
  clicks for CI), never shipped.

## Supervisor (supervisor.ts)

- Restart backoff 0, 0.5, 1, 2 s ... capped at 10 s; a host up for 20 s
  (`HOST_STABLE_MS`) resets the streak.
- Hung = no heartbeat for 3 s (`HOST_HEARTBEAT_TIMEOUT_MS`, watchdog every
  250 ms; detected in about 3.1 s on Linux). No hello within 20 s = killed.
- 6 starts in a row that never attached (`HOST_MAX_FAILURES`) = state
  `failed`, no more spawns.
- Kill: `taskkill /T /F` on Windows, SIGKILL elsewhere. Stop sends `quit`,
  waits 1.5 s, then kills.

## Coverage, power and clicks

- `coverage.ts` `RoomActivity`: covered (a maximized or full-screen window,
  Windows coverage events; macOS occlusion of the room window and of the hit
  panel), locked, asleep, held → fps 0, otherwise the cap
  (`SEILINK_HOST_FPS` 30, 15 on battery). The page stops every rAF loop at 0.
- `clicks.ts` `ClickClassifier`: a single click waits for the OS double-click
  interval (clamped 200 to 900 ms). Click on her → main `openChat` (restore,
  show and focus the main window, navigate to her chat). Double click →
  `onDoubleClick` hook (unused, reserved for the dock). Drag = a stroke.
- Click area: the page measures `[data-seilink-hit]` (RoomAvatarHost marks
  her figure) 4 times a second; none while she is `visibility: hidden`
  (walked out of the frame). Windows: the host's raw-input hit test
  (`setHitRect`, physical px). macOS: an almost transparent NSPanel over her
  (`hitPanel`, points); clicks elsewhere reach the desktop.

## The avatar mount point

`src/renderer/src/components/seilink/host/hostAvatar.tsx` is the one place
that decides what she is on the desktop. `HostAvatar` is `RoomAvatarHost`,
which renders `RoomAvatar` with:

| prop | from |
|---|---|
| `slot` | RoomCanvas avatar slot (fps = the cap) |
| `characterId`, `name` | the room message |
| `portrait` | `SeilinkHostRoom.portrait` (below) |
| `use` | `roomAvatarUse(room.state.avatar)` |
| `busy` | main (a chat turn with her, held 60 s after the reply) OR 8 s after a click on her |
| `speaking`, `levelRef`, `emotion`, `facepack` | not passed yet (her voice does not play in the host) |

The contract for any replacement is in the file header.

### What RoomAvatar can read in the host

- **Portrait.** The host has no `sei-portrait://`. Main resolves
  `portrait_image` (`hostAvatarCalls.ts` `hostPortrait`): https and bundled
  `./img/...` paths pass through; a stored `<uuid>.png` becomes
  `sei-room://_portrait/<file>?v=<mtime>` and its realpath is added to the
  host's allowlist. A portrait changed while she is moved in shows after the
  next room message (a room save, a host restart).
- **Avatar bridge.** The host preload exposes `window.sei` with ONLY
  `avatarGet`, `avatarModelFiles`, `onAvatarManifest`,
  `facepackForCharacter`, `facepackManifest`, `facepackFile`
  (`SEILINK_HOST_AVATAR_METHODS`). The host relays them (`avatarRelay.ts`)
  to main, which answers for the moved-in character only
  (`answerHostAvatarCall`) and NAMES files; the host reads them (16 MB per
  facepack file, 256 MB per model). Imports, removals and accessory
  toggles reach the host as `avatar-manifest` (`hostSignals.ts`, called from
  ipc.ts). The face set is the facepack dev flag's, as in the app.

## On/off, persistence, account switch

- `startSeilinkHost(id, {restored?})` / `stopSeilinkHost(reason)`, IPC
  `seilink:host-start|stop|status`, push `seilink:host-status-changed`
  (the dock reads `SeilinkHostStatus`). One companion at a time; a start for
  someone else replaces her (`replaced`).
- Who moved in: `seilink_moved_in {character_id, moved_in_at}`, a
  MAIN-owned UserConfig key (per profile). Restored at app start and after an
  account switch (`restoreSeilinkHost`). A user stop or the flag turning off
  clears it; quit, failure and an account switch keep it.
- Account switch: `endAccountSessions` calls
  `stopSeilinkHostForAccountSwitch()`; starts take `beginSessionStart()`
  (`ACCOUNT_SWITCHING` during a switch).

## Analytics (shape only)

- `seilink_started` {character_id, layout raised|classic|mac|other,
  attach_ms, restored}, on the first attach of a session.
- `seilink_attach_failed` {character_id, failure_class, reattach,
  from_host}, once per class per session.
- `seilink_ended` {character_id, reason, duration_ms, attached, restarts,
  failure_class?} at the single end choke point (`endSession`).
- NOT in the dashboard's `SESSION_EVENTS` (playtime): a wallpaper runs for
  hours and would swamp it. Decide its place when the dock ships.

## Dev and CI

- Fake desktop: unpackaged + `SEI_SEILINK_FAKE_DESKTOP=1` makes the room a
  plain window with no addon, so Linux runs the whole pipe, supervisor and
  page path.
- Self-test (`selfTest.ts`, unpackaged + `SEI_SEILINK_SELFTEST=<outdir>`):
  attach, first frame, cover → 0 fps, uncover, click her / bare wallpaper /
  double click, kill → reattach, hang → detected and replaced, (Windows)
  Explorer restart, stop. Writes `result.json`, `selftest.log` and
  screenshots, then exits 0 or 1. Moves Sui in when the profile has her.
- Linux smoke:
  `node scripts/seilink-dev-pack.mjs --out /tmp/packs && npx electron-vite build &&
  SEI_SEILINK_PACKS=/tmp/packs SEI_SEILINK_SELFTEST=/tmp/st SEI_SEILINK_FAKE_DESKTOP=1
  SEI_DEV_USERDATA=SeiLinkSmoke timeout 240 xvfb-run -a -s "-screen 0 1920x1080x24"
  ./node_modules/.bin/electron . --no-sandbox` (cover/uncover/click are
  skipped there).
- CI: `.github/workflows/seilink-host-check.yml` (windows-2022/2025,
  macos-15/26; dispatch, or push to `feat/seilink-host` under the host
  paths). One runner per OS also packages a dir build and checks the addon
  lands in `resources/seilink` and loads.

## Gotchas

- Rollup drops a side-effect-free busy loop: the `test-hang` loop counts
  and logs its spins so the hang actually happens.
- Linux dev hosts need `--no-sandbox` (passed through when main has it), or
  Chromium's sandbox setup kills them with SIGTRAP.
- macOS: the hit panel is clipped to the work area (`clipRect`). The menu bar
  and the Dock row stay visible over a zoomed window, so a panel reaching into
  them never reads as occluded and the room never drops to 0 fps.
- Windows: the room window is created with `thickFrame: false`. With the
  resize frame, the attached child kept an 8 px non-client strip each side
  (wallpaper showing at the edges, her click box 8 px off). Attach logs
  `client WxH of WxH` if the client area ever differs again.
- macOS CI covers with TextEdit sized through Accessibility (the test addon's
  `axSetWindowFrame`); the runners have no Automation grant for AppleScript,
  and a window of our own bundle did not occlude the panel.
- The host page preload may import only `electron` (sandboxed; a test
  checks), and spells its channel names out (`seilinkHostChannels.ts`).

## Not done (dock and first-run milestone)

- Turn the flag into a real setting, a dock entry and a first-run move-in;
  read `seilink:host-status-changed` for its UI (state, covered, fps,
  failure).
- More displays: everything goes through `primaryRect()`; attach takes a
  rect, so it is a window per display plus bookkeeping.
- Her voice in the host (`speaking`, `levelRef`), and a character that is
  deleted while moved in (the host keeps her room until the next start).
