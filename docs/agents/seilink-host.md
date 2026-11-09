# WorldLink desktop host (261104, milestones 3 and 4)

The feature was called SeiLink until 261106 (product feedback (261106)); only
the user-visible name changed. Code identifiers, file paths, IPC channels
(`seilink:*`), storage keys and analytics events (`seilink_*`) keep `seilink`.

The companion's room as a live wallpaper: one window behind the desktop
icons on the primary display (Windows: the WorkerW/Progman layer; macOS: the
desktop window level plus a small hit panel over her). Available wherever
the install can run it (`gate.ts` `seilinkEnabled()`: a supported install, or
the dev flag, unpackaged with `SEI_SEILINK_PACKS`). Supported = macOS or
Windows with the host addon in the build. There is no on/off setting: the
Settings > Labs "Desktop room" toggle (`seilink_enabled`) and the whole Labs
group were removed on 261105 (T337); the schema drops an old
`seilink_enabled` and a saved move-in stays. Linux reports `unsupported_platform`; the app builds and runs the
same. The room source (`roomStore.roomSource`) is gated the same way, and
only the companion who moved in gets a room line and look() (no added tokens
for anyone else), and only while
her host session is open (`gate.seilinkResident`, set by seilinkHost.ts);
the others do not live there.

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
- Pipe: `\\.\pipe\sei-seilink-<pid>-<n>` on Windows,
  `<tmp>/sei-seilink-<pid>-<n>.sock` elsewhere; `<n>` counts the sessions of
  this main process, so a new session never deletes or collides with the
  path of the one still closing. Line limit 4 MB, so file BYTES never travel over it.
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
- Hung = nothing heard from the host for 3 s (`HOST_HEARTBEAT_TIMEOUT_MS`,
  watchdog every 250 ms; detected in about 3.1 s on Linux). Any line counts:
  the host's 1 s heartbeat and its `pong` to main's 1 s `ping`. The pong is
  answered from the pipe read in the host's main process, so App Nap
  stretching the host's timers while it is covered does not make it look
  hung. While its last heartbeat said covered or paused the limit is 15 s
  (`HOST_PAUSED_HEARTBEAT_TIMEOUT_MS`). No hello within 20 s = killed.
- Sleep: main forwards `powerMonitor` `suspend` (nothing judged until
  resume) and `resume` / `unlock-screen` (a 15 s grace, `HOST_RESUME_GRACE_MS`).
  A watchdog tick more than 2 s late (main's own timers were stopped) gives
  the same grace.
- 5 restarts within 10 min (`HOST_MAX_RESTARTS`, `HOST_RESTART_WINDOW_MS`),
  attached or not, = give up: the session ends with state `failed` and a
  failure class (the last failure since her last good attach, or
  `crash_loop`), `seilink_ended` carries it, her page's gear menu says her
  room stopped, and nothing spawns again until a user move-in or an app
  restart (the saved move-in is kept, so the next app start retries once).
- Kill: `taskkill /T /F` on Windows, SIGKILL elsewhere. Stop sends `quit`,
  waits 1.5 s, then kills.

## Coverage, power and clicks

- `coverage.ts` `RoomActivity`: covered (a maximized or full-screen window,
  Windows coverage events; macOS occlusion of the room window and of the hit
  panel), locked, asleep, held → fps 0, otherwise the cap
  (`SEILINK_HOST_FPS` 30, 15 on battery). The page stops every rAF loop at 0.
- `clicks.ts` `ClickClassifier`: a single click waits for the OS double-click
  interval (clamped 200 to 900 ms). Click on her → main `openChat` (restore,
  show and focus the main window, navigate to her chat). Double click → a
  poke: `desktopLines.onSeilinkPoke` asks her for a short reply, shown as a
  bubble (see Desktop lines). Drag = a stroke.
- Click area: the page measures `[data-seilink-hit]` (RoomAvatarHost marks
  her figure) 4 times a second; none while she is `visibility: hidden`
  (walked out of the frame). Windows: the host's raw-input hit test
  (`setHitRect`, physical px). macOS: an almost transparent NSPanel over her
  (`hitPanel`, points); clicks elsewhere reach the desktop.
- M4: the native click area is ONE rect, the union of her box and the dock
  buttons (`dock.ts` `unionBox`). hostEntry routes each press by position
  (`pressTarget`, page CSS px via `toPagePoint`: Windows physical px divided
  by the scale factor, mac global top-left points minus the display origin):
  a dock button → `CH.dockPress` to the page; her → the click classifier;
  the small gap the union adds → ignored. On mac the press target is taken
  at `down`, and a dock press acts on `click` (dblclick and drags dropped).

## The dock (M4)

`host/HostDock.tsx`, drawn by the wallpaper page itself: a small glass pill
of three round, borderless buttons at the bottom of the work area (above the
taskbar or the Dock; the host sends `CH.layout` with the work area), beside
her box (`lib/seilink/dockPlace.ts`: right of her when it fits, else left,
else centred under her seat). Her figure runs to the bottom of the screen in
the cozy room, so a dock under her seat sat on her chest. It stays next to
her box because the native click area is the union of the two (one rect): on
macOS the hit panel takes the desktop's clicks inside it. The product
room-editor deck puts these shortcuts in "the bottom dock" of the room, so it
lives on the wallpaper, not in the app or a tray.
- Edit room → main `deps.openRoomEditor` → `stageFlow.openDesktopEditor`
  (261106): pushes `seilink:open-room-editor {characterId, openedFrom,
  desktop}` WITHOUT showing Sei; the renderer mounts her editor and puts it
  on the desktop stage (see "The desktop stage" below). No stage enter
  within 4 s shows the window the usual way, editor inside.
- Deafen → toggles `seilink_deafened` (main-owned, per profile), pushed back
  as `dock-state`. Mutes her IDLE lines only; a reply to a poke still shows.
- Move out → the first press turns the button into "Move out?" for 4 s, a
  second press sends the action; main `stopSeilinkHost('user_stop', 'dock')`.
- 261106 the offer (`dock-state.offer`, `her` | `prompt` | `none`): after
  her first move-in into the blank room the dock holds "Decorate together"
  (`decorate`, BrushIcon, accent fill) and "Not now" (`later`); `prompt` adds
  the line "Decorate {name}'s room together?" above them (her own line did
  not come). Main only accepts `decorate` / `later` while an offer is up.
  On the plain first state (first-link v3, HostDock `plain`) the copy is
  "Set up together", "Set up {name}'s room together?" and, after Not now,
  "Set up the room anytime with the brush."; the actions are the same.
The page never gets DOM clicks: it reports its buttons' boxes (`CH.dock`) and
answers a press with `CH.dockAction`, which the host relays as FromHost
`dock`. A short caption above the dock says what a press did (no hover).
Colours come from the room (`RoomCanvas onOverlay`), not the app theme.

## Desktop lines (M4, `seilink/desktopLines.ts`)

- Poke (double click): one short reply, under the plan's own limits (a free
  account's weekly cap is the proxy's), at most 6 an hour, 20 s apart. The
  hourly counts live in main (one `LinePacer` per app session), so a host
  restart or a companion swap does not reset them.
- Idle: unprompted, rare (a random 25 to 50 min gap, at most 2 an hour),
  never while covered or paused, deafened, busy (chatting with her), in a game
  or on a call, or when nobody has touched the computer for 2 min
  (`powerMonitor.getSystemIdleTime`). Free cloud accounts never get idle
  lines (the free tier must cost about nothing per extra user): paid plans
  under their limit, or the user's own AI (`ai_backend_kind` 'local': BYOK,
  ChatGPT plan, Ollama) only. The plan is read through `creditsGet()` and
  cached 10 minutes.
- The turn is `chatService.sendDesktopLineTurn` (her persona, memory,
  summary, knowledge and room line; the note after the cache breakpoint;
  remember() honored; the line saved to her chat and folded like any reply;
  `(silence)` drops an idle line). Skipped when another turn for her is
  running or she has no room right now.
- Shown with ToHost `line` → `CH.line`: a bubble above her head for its
  reading time; her mouth moves for about the time saying it would take
  (`speaking` on HostAvatar, with a made-up syllable level since no audio
  plays in the host). TTS on the desktop is not wired.
- Room edit reaction (261105, T335, `seilink/roomReaction.ts`): when a
  companion editor session ends (CompanionRoomEditor sends
  `seilink:editor-session` open/close; RoomEditor.tsx is not involved) and
  her SAVED room differs from the saved room at open, she says one line
  about it (kind `react`, shown as a poke bubble). Diff:
  `shared/seilinkRoomDiff.ts` (moves with a direction, recolours with
  tintName words, patterns, add/remove/swap, time, preset), at most 5 named,
  biggest first, in the note after the cache breakpoint. Only for the
  resident at open and at close (never before she moves in or with WorldLink
  off), one per session, 5 min cooldown, paid like a poke (free inside the
  weekly cap; refused = silent). On a call, in a game, on cooldown, over the
  limit or after a failed line, the room before the session is kept
  (`roomChangeNote.ts`, 30 min) and the next chat, call or desktop turn that
  has her room gets one note diffed against the room it read. The room line
  itself is read fresh every turn (no cache), so a new preset shows at once.
- Decorating together (261105, T336). Main: `seilink/editorTogether.ts`
  (session state, no electron; chatService reads it), `decorateTogether.ts`
  (open/close/sync IPC, live-line scheduler), `shared/seilinkDecorate.ts`
  (the decorate tool), `shared/seilinkTogether.ts` (event types). Renderer:
  `components/seilink/RoomTogether.tsx`, drawn through RoomEditor's
  `together` render prop by CompanionRoomEditor, only for the resident.
  - The editor sends its UNSAVED room (`seilink:editor-sync`, 400 ms
    debounce, validated with the pack like a save). Every surface that reads
    her room (`roomForSurface` -> `liveRoomFor`) sees that room while the
    editor is open.
  - Live lines, off a call: edits arm a 5 s pause timer; then one line
    (`speakEditorLine`, a `react` desktop turn with the live note, pushed to
    her chat, no host bubble) about what changed since she last said
    something. 40 s apart, at most 4 per session, paid like a poke (free
    inside the weekly cap, silent over it). Silence counts as seen. The idle
    tick does nothing while her editor is open.
  - Closing line: `roomReaction.closed(token, together)` diffs against what
    she already saw live. Nothing new since her last live line = skipped
    `seen_live`; within 40 s of a live line = `cooldown` (the baseline is
    kept for her next turn).
  - Every chat, call or talk-box turn while the editor is open gets
    `editorTurnNote` in the uncached tail: what changed since her last turn
    and the room now. On a call she also gets a look() picture of the room
    (a synthesized look tool_use and tool_result) on the player's next line,
    only when the room changed since the last picture and at most one per
    20 s.
  - The decorate tool is offered (last in the tool list, the same on every
    voice turn kind) only while that companion's editor is open. `apply`
    resolves each change against the pack (real parts, palettes, patterns,
    side placement) and sends ops on `seilink:editor-event`; the editor
    applies them as ONE undo step (`commitEdit(endGesture(h), next, null)`),
    crossfades, rings the changed parts and shows "Undo {name}'s changes".
    `suggest` shows "Try {name}'s idea". At most 5 changes; refusals list the
    real options and get one more hop. So does any call with more than one
    change (she says what landed; one change she already answered for ends
    the turn). While the tool is offered the reply cap is 400 tokens, not
    200 (a lead line plus five changes ran into 200 in the probe).
  - Undo: when the very next room change puts the room back to just before
    her last applied changes, her next turn or live line hears "They undid
    your last changes" instead of the change list (once).
  - The talk box is her normal chat turn (`useChatStore.send`), so the rows
    land in her chat. Hidden on a call (there is a call pill with
    CallControls instead; edits count as presence). Over the limit it shows
    "Usage limit reached" and opens the HardStopModal (ModalShell lifts over
    the editor through `--sei-modal-lift`).

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
| `speaking` | one of her lines is in a bubble (`levelRef` is a made-up syllable envelope; no audio plays in the host) |
| `emotion`, `face`, `faceSeq` | her face for the line (261105, below) |
| `facepack` | not passed (RoomAvatar asks main for her pack) |

The contract for any replacement is in the file header.

### Her face on the desktop (261105)

Each desktop line carries her face, at no added tokens: main
(`sendSeilinkLine`, `shared/seilinkExpression.ts` `desktopLineFace`) takes
the face tag the line led with (`[happy] ...`, read by
`sendDesktopLineTurn`; only the facepack dev flag prompts for one), else
the call overlay's spoken-line lexicon (`classifyEmotion`, now in
`shared/avatarEmotion.ts`). The `line` message gets `emotion` (Live2D's
closed set) and `face` (a face-set word: shy = embarrassed, angry =
annoyed, love = happy). The page (`host/hostLook.ts`) passes `emotion` only
while she says the line (Live2DView then lingers half the line and decays,
as on a call) and holds `face` while the bubble is up (at least 1.5x the
speaking time), then sends `neutral`; FacepackView's own timeline may
decay a strong face (laugh, surprised) sooner, as in the app. A cover drops
the bubble and her face. The portrait cutout and the silhouette have no
face. Counted as `expressions` (seilink_health / seilink_ended) and
`expression` tag/lexicon/none on `seilink_line_shown`. Her replies in the
app's chat do not change her desktop face (she is held still while you chat).
Shots: `scripts/seilink-host-shots.mjs --shots host-expression --facepacks ...`.

### What RoomAvatar can read in the host

- **Portrait.** The host has no `sei-portrait://`. Main resolves
  `portrait_image` (`hostAvatarCalls.ts` `hostPortrait`): `https:`,
  `data:image/` and bundled `./img/...` paths pass through, everything else
  (file://, UNC, http:, other schemes) is dropped; a stored `<uuid>.png` becomes
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
  ipc.ts). The face set is her downloaded anima pack (below), else the
  facepack dev flag's, as in the app. `avatarShown` (analytics only) reports
  which kind RoomAvatar settled on.
- **Her look: anima face sets (261105).** `src/main/anima/`. The first time
  WorldLink opens for her (the move-in sheet, the room editor, her host
  starting or being restored; never at app start for anyone else), main asks
  sei-proxy `POST /anima/v1/request {character_id}` with the user's Sei JWT;
  the proxy bakes a facepack from her cloud portrait on a GPU worker
  (content-addressed by the portrait, so the defaults bake once for everyone)
  and answers queued/running/ready/no_pack/failed/deferred/unavailable.
  Main polls `GET /anima/v1/status/:id` (10 s, 20 s, then 45 s, 25 min max),
  downloads the signed `pack.zip`, checks its sha256, extracts it into
  `<userData>/anima/packs/an-<sha32>/` (temp dir + rename; entries must pass
  `isSafePackPath`, a readable sei-facepack v1 manifest is required), and
  records her in `<userData>/anima/index.json`. Then it re-broadcasts her
  avatar manifest (app windows + `avatar-manifest` to the host), so every
  RoomAvatar re-resolves; a portrait or silhouette crossfades to the face set
  once it has drawn. `facepackForCharacter` / `facepackManifest` /
  `facepackFile` serve `an-` ids in every build (no dev flag). Skipped
  offline and signed out (fallback avatar, nothing shown). BYOK and local
  model users with a Sei account still get a bake (it goes through the
  proxy, not their key). The pack on disk is used without the network while
  her portrait ref (portrait_image, cloud watermark, local file size+mtime)
  is unchanged and the last check is under 12 h old; a character save that
  changes it re-asks (with rechecks while the cloud row catches up).
  Renderer: `useAnimaLook(characterId, trigger)` (IPC
  `seilink:anima-prepare|status`, push `seilink:anima-changed`) drives the
  quiet "Preparing {name}'s look…" line in the move-in sheet and the
  editor's avatar panel. Account switch: `anima.reset()` stops every poll.

## On/off, persistence, account switch

- Start, stop, restore, the account-switch stop and the removal cleanup run
  one at a time in call order (`serial` in seilinkHost.ts); the gear menu's
  move button is also disabled while one is on its way.
- `startSeilinkHost(id, {restored?})` / `stopSeilinkHost(reason)`, IPC
  `seilink:host-start|stop|status`, push `seilink:host-status-changed`
  (the dock reads `SeilinkHostStatus`). One companion at a time; a start for
  someone else replaces her (`replaced`).
- Who moved in: `seilink_moved_in {character_id, moved_in_at}`, a
  MAIN-owned UserConfig key (per profile). Restored at app start and after an
  account switch (`restoreSeilinkHost`). A restore first checks she still exists: a companion whose
  file is gone has her move-in cleared and nothing starts. A user stop and deleting or removing her
  (`onSeilinkCharacterRemoved`, reason `character_removed`) clear it; quit,
  failure and an account switch keep it.
- Move-in (M4): the companion page's gear menu has "Move onto desktop" /
  "Move off desktop" and "Edit room" while WorldLink is available, and the chat
  top bar has the WorldLink button (261105, see "Entry points and the first
  link" below). The first move-in
  of a companion (no saved room: `SeilinkRoomPayload.saved`), or one that
  moves someone else out, opens `MoveInSheet` (room cards from the packs
  that exist, three lines on what it means, Move in). Otherwise the page
  starts the host directly. `lib/seilink/moveIn.ts` has the rules.
- Account switch: `endAccountSessions` calls
  `stopSeilinkHostForAccountSwitch()`; starts take `beginSessionStart()`
  (`ACCOUNT_SWITCHING` during a switch).

## Open on login (261107)

Opt-in, so her room comes back after a restart. Shown only on a packaged
macOS or Windows build where WorldLink runs (`openAtLoginSupported`), in two
places. IPC `seilink:login-item-get|set` answers `OpenAtLoginState
{supported, enabled, needsApproval, decided}` after main has read the OS back.

- **The setup step** (product call 261107; it was a switch on the move-in
  sheet before): after the guided room setup's Done, once. RoomEditor shows
  it in the guide's frame (`renderLoginStep`, helpers in
  `lib/seilink/loginStep.ts`, source from CompanionRoomEditor): the title
  "Open on login", one line ("{name} comes back after a restart."), and
  "Not now" / "Turn on". "Turn on" is the hot button: the preselected answer,
  as the step's other buttons are Skip / Next. Two buttons, not a switch:
  the editor has no switch control (the app Toggle's accent colours are not
  the editor's ink-on-glass), and the footer pairing matches every earlier
  step. The state is read when a guided run opens; the step is due when
  `supported && !decided`. Nothing is registered until "Turn on" is
  pressed: closing the editor on the step (close button, Escape) registers
  nothing and leaves it unanswered, and since setup is done the step does
  not come back (Settings has it). A refusal shows "Could not change this
  setting. Try again." with both buttons still there; macOS approval shows
  the System Settings line with Done.
  - Who sees it: only people who press Done on the last guided step, in a
    first run or a resumed one. Skip on a step still goes on to Done, so
    skipping steps does not skip it. "Not now" on the room step while she is
    still plain, or closing part way, leaves the run unfinished: no login
    step then, and it comes at the end of the resumed run. Rooms set up
    before this build, and a normal (unguided) editor, never show it.
- **Settings > Appearance** (`OpenAtLoginRow.tsx`, label "Open on login",
  with the info tip): a switch that reflects the real state; the macOS
  approval note, and a refused change flips back with a line.
- `decided` (in `open-at-login.json`, sticky) is set by any answer: the
  step (either button), the Settings row, or the item turned off in the OS
  (launch sync `reflect_off`). An older file that is on or registered counts
  as decided. macOS "Not now" with nothing registered writes the file only
  and never calls `setLoginItemSettings` (a hand-added login item survives).

- Files: `seilink/openAtLogin.ts` (setting + OS item + launch sync, pure
  `decideSync`), `seilink/loginLaunch.ts` (pure launch rules),
  `seilink/loginLaunchRuntime.ts` (Electron wiring), `seilink/loginItemUninstall.ts`
  (Velopack uninstall), `build/installer.nsh` `customUnInstall` (NSIS).
- The choice lives in the device-global `<userData>/open-at-login.json`
  (`open_at_login`, `registered`, `registered_path` on Windows,
  `approval_pending` on macOS, `decided`). The OS item is device-global too, so the
  setting is not per profile.
- Registration: `app.setLoginItemSettings`. macOS: `{openAtLogin}` only
  (SMAppService mainApp on 13+, status read back). Windows: its own HKCU Run
  value `SeiWorldLink` (never the AppUserModelId name the retired tray item
  used), `args: ['--seilink-login']`, path = `<root>\current\Sei.exe` for a
  Velopack install (stable across updates) or the NSIS exe.
- Every change is read back. A throw or a mismatch flips the switch back and
  sends `seilink_login_item_failed`. macOS `requires-approval` right after
  Sei's own register stays on with "Allow Sei in System Settings" until it
  is approved.
- Launch sync (`syncOpenAtLoginAtLaunch`, at ready, AFTER
  `cleanupLegacyTraySettings`): the user removed or turned off the item in the
  OS (Login Items, Task Manager) = off in Sei, never re-added
  (`changed` with surface `os`; marks it decided). Windows only: a missing value with the
  setting on is written again (NSIS to Velopack moves the exe), but an old
  path with a disabled value stays off. Setting off = a stray item is removed
  (macOS only one Sei registered, so a hand-added login item survives).
- A login launch (Windows: the marker arg; macOS: `wasOpenedAtLogin` and the
  setting on): no splash, no launch-time update apply, the main window made
  hidden. The room restores as usual; a click on her, the Dock or a second
  launch shows the window. The player-end "next time" LLM check and the
  Velopack migration wait for that first show (`afterLoginReveal`). Once
  bootstrap is done and the seilink queue is idle, no room up (signed out,
  nobody moved in, unsupported, start failed) = quiet quit; her room ending
  while still hidden quits too.
- Windows residency: closing the last window keeps Sei running while her room
  is up and the setting is on (or it is a login launch); it quits when the
  room ends with no window. macOS is unchanged (always resident).
- Uninstall: NSIS removes the value on a real uninstall (not an update) only
  when it starts `$INSTDIR`; Velopack's uninstall hook does the same with
  reg.exe. macOS: dragging Sei to the Trash runs no code, so the
  SMAppService entry may stay in Login Items until the user removes it
  (not verified on a real Mac).
  Factory reset unregisters before the wipe. Sign-out keeps the item; a login
  launch with no move-in in that profile just quits.
- Caveat: the avatar overlay set to "Always" may show on a login launch, since
  the renderer runs hidden.

## Entry points and the first link (261105, T337)

- Every way into WorldLink goes through `lib/seilink/seilinkFlow.ts`, and the
  move-in sheet, the room editor and the intro are rendered once, by
  `SeilinkFlowHost` (mounted in App.tsx, state in `useSeilinkStore.flow` /
  `.intro`). Entry points:
  - the WorldLink button in `ChatTopBar` (after Backseat, before Call;
    `data-tutorial="seilink-btn"`), shown wherever WorldLink is available.
    She lives there: her room editor. Otherwise: move her in
    (`openSeilink`, source `button`).
  - the companion page's gear menu: "Move onto desktop" / "Move off desktop"
    (`moveInOrOut`), "Edit room" (`openRoomEditor`), "Replay WorldLink intro"
    (`replayIntro`). Source `gear`.
  - the dock's edit button (main push `seilink:open-room-editor`), `dock`.
  - the guide's tour (below), `tour`.
  Each records `seilink_entry {source, action}` and passes the source on
  (`seilink_movein_sheet.entry`, the editor's `opened_from`).
- There is no on/off setting (the Settings "Labs" section was removed
  261105): WorldLink is available wherever `seilinkSupport()` says it can run.
- **The first-link flow (261106; v3 the same day: plain spawn + guided
  setup).** She first moves in on a PLAIN background, no room at all:
  `plainRoomState(manifest)` in shared/seilinkRoom.ts is the bare preset room
  (`bareRoomState`: every optional slot empty, no items) with `plain: true`.
  RoomCanvas draws nothing of the room for a plain state, only black (OS dark
  mode) or white (light mode) from `lib/seilink/plainTone.ts`
  (`prefers-color-scheme`, followed live; `PLAIN_COLOURS`), with her at the
  preset's seat, and gives the dock and the editor glass to match
  (`plainOverlay`). Rooms saved before stay as they are (a saved blank room
  from the first pass still gets the offer, `isFirstRoom`); only a companion
  with no saved room starts plain. While plain: her prompt line is
  `PLAIN_ROOM_LINE` (roomContext.ts), look() answers in words with no
  picture, `describeRoom` / `roomNowLine` list nothing, and her first applied
  decorate op sets the bare room up (`resolveDecorate` works on
  `withoutPlain`, `applyRoomOps` drops the flag). `sanitizeRoomState` keeps
  `plain` and `setup`.
  1. MoveInSheet (no room picker): "{name} starts on a plain background. You
     can set up the room together, step by step." Move in saves
     `firstRoomState(packs)` (the cozy frame, else the first pack's) and
     starts the host with `fresh: true`.
  2. The first link plays the intro ON the desktop stage (`stage: true`):
     the window covers the primary display and the intro settles into the
     plain colour (or her room, for a companion who has one), full screen
     (`holdEnd`: only the captions fade; a skip rushes to that frame).
     When the start answered ok the window steps aside (`exit` with
     `reveal`), so the wallpaper, the same picture, is what stays, icons on
     top. A failed start comes back to the window and the sheet's retry. A
     first room without the intro (already seen on this account) steps aside
     the same way once she is in (`reveal`, purpose `move_in`).
  3. Then `seilink:offer` (`main/seilink/decorateOffer.ts`): she asks in one
     desktop line (a `react` turn with `DECORATE_OFFER_NOTE_PLAIN`, or
     `DECORATE_OFFER_NOTE` for a blank room, after the cache breakpoint,
     through the poke budget: nothing for a free account over its cap, no
     tokens on any other turn), and the dock holds the two answers. Her line
     has `OFFER_LINE_WAIT_MS` (8 s); without it the dock asks in UI copy
     (`prompt`). Asked once per companion per run, only while the room is
     still `isFirstRoom`; it expires after 10 min, and closes when she moves
     out or the room is set up another way.
  4. "Set up together" opens her editor on the desktop (`opened_from:
     offer`) in the GUIDED SETUP (below), shared with her as usual
     (RoomTogether: her live reactions and edits use the existing budgeted
     paths, no new per-turn tokens). "Not now": she stays plain, the dock
     comes back with the caption "Set up the room anytime with the brush."
     and the offer is not asked again.
  5. In the editor the Sei avatar is her portrait or face set, drawn as the
     wallpaper draws her (RoomEditor `portrait`, from CompanionRoomEditor);
     the glass figure is only for a companion with no portrait.
  6. **The guided setup** (RoomEditor `guided`, default on; helpers in
     `lib/seilink/roomSetup.ts`). Four optional steps, each a panel of the
     normal editor under a title, a hint, "Step n of m" with dots, and
     Back / Skip / Next (Done on the last): `room` (the room type cards, each
     shown bare), `colours` (Walls & fabrics), `furniture`, `extras` (the
     items library). A step the pack has nothing for is left out
     (`setupSteps`). On the room step while she is still plain, Skip is "Not
     now" (closes, she stays plain) and Next takes the checked room bare
     (cozy by default). The editor opens guided while she is plain or while
     `RoomState.setup` (`{done: steps}`, saved on every Next and Skip, never
     in the undo history) says a run was left unfinished, and resumes at the
     first step not done (`resumeStep`; the room step while still plain).
     Done saves without the marker and closes onto the wallpaper; the next
     open is the normal editor. An `initial.panel` (a deep link) opens the
     normal editor. Escape does not close panels while guided.
- **The desktop stage (261106, `main/seilink/desktopStage.ts`,
  `stageFlow.ts`).** The room editor (and the first-link intro) open ON the
  desktop, above the desktop icons, by turning the MAIN window into a
  borderless surface the size of the primary display (where the wallpaper
  is); RoomCanvas `fit="cover"` at that size draws the room where the
  wallpaper draws it, and the covered wallpaper drops to 0 fps. Not a second
  window (the editor needs the main renderer's stores, chat, call, modals)
  and not the wallpaper window raised (re-parenting out of WorkerW / the
  desktop level and back is the riskiest native step WorldLink has).
  - macOS: move onto the primary display, hide the traffic lights,
    `setSimpleFullScreen(true)` (no Space animation, stays on the desktop's
    Space). A window in native fullscreen (its own Space) is refused
    (`native_fullscreen`); the editor stays in the window.
  - Windows / Linux: unmaximize, `setResizable(false)`,
    `setBounds(display.bounds)` on the frameless window (the shell draws a
    monitor-sized foreground window over the taskbar). Not `setFullScreen`:
    leaving it while hidden turns WS_VISIBLE back on and flashes the app.
  - Stepping aside (`reveal`): macOS hides the window first, leaves simple
    fullscreen, restores the frame, then `app.hide()` when no other Sei
    window is up ('activate' and second-instance show a hidden main window
    again). Windows hides, restores bounds while hidden, then minimizes (a
    maximized window is maximized again on its next restore).
  - A hidden or minimized window comes back at opacity 0, is moved and
    sized, then made opaque, so the old frame never flashes.
  - The renderer drives it (`seilink:stage` enter / exit / reveal, main
    window only): the editor or intro is already mounted over the whole
    window when the window changes size, so the app UI never shows full
    screen. CompanionRoomEditor `desktop`: enter 120 ms after mount (a
    timer: a hidden window draws no frames), close = exit with reveal, then
    unmount; any other unmount exits without reveal. A renderer reload while
    staged gives the window back (`app:renderer-ready`).
  - Every editor entry point opens the desktop editor for the companion who
    lives there with the host running (the dock, the offer, the WorldLink
    button, the gear menu's Edit room); anyone else gets the in-app editor.
    Closing always steps aside onto the desktop.
- **The first-link intro** (`components/seilink/intro/`), v6 "WorldLink"
  (261106, product feedback (261106)): nine status lines, one at a time over
  the light, then the success line, and only then does she come in.
  `startSeilinkHost` (the only host start in the renderer) requests it
  alongside the start, so it never delays the host. The lines
  (`lib/seilink/worldLink.ts`, `STATUS_LINES`, word for word) wait on real
  milestones (`LINK_MILESTONES`) from a progress source (`LinkSource`):

  | # | Line | Waits for | Dwell |
  |---|---|---|---|
  | 1 | Initializing WorldLink… | 0.7 s after the start | 4 s |
  | 2 | Sending signal to World N… | the Anima request is sent (`requesting`) | 6 s |
  | 3 | Waiting for a reply… | (same) | 12 s |
  | 4 | Signal received. | the proxy answered (`queued` / `running` / ready) | 4 s |
  | 5 | Syncing world clocks… | answered, and 40% of `EXPECTED_LINK_MS` (75 s), cut short by the bake finishing | 2.8 s |
  | 6 | Matching physics constants… | the bake is running, and 60% (same cut) | 2.8 s |
  | 7 | Correcting for time dilation… | the bake is running, and 80% (same cut) | 2.8 s |
  | 8 | Stabilizing the link… | the bake is done (`downloading`) | 2.8 s |
  | 9 | Inviting {name}… | her face set installed (`ready`) and the host start answered ok | 3.2 s (`LAST_LINE_MS`) |
  | | WorldLink established between World 0 and World N. | `LAST_LINE_MS` after line 9, on the full solid | |

  A line never shows sooner than the line before has had its dwell (its
  `dwell` in `STATUS_LINES`, default `LINE_DWELL_MS` 2.8 s; the first four
  are longer, product feedback (261106): sending a signal and waiting for a
  reply should take a while). The milestone gates apply on top: a slow
  proxy holds "Waiting for a reply…" until it answers. Measured: a 75 s
  bake shows the lines at 0.7, 4.7, 10.7, 22.7, 30, 45, 60, 72 and 75 s,
  success 78.2 s, end 88.2 s; a 20 s bake (and a cached look or a replay)
  at 0.7, 4.7, 10.7, 22.7, 26.7, 29.5, 32.3, 35.1 and 37.9 s, success
  41.1 s, end 51.1 s. On a slow stage the current line holds (no filler lines) while
  the light keeps moving. The proxy says nothing finer than queued, running
  and ready, so lines 5 to 7 spread over the expected-duration curve, and an
  early finish plays the rest at the minimum dwell (`planLink`; a start
  that is past never moves when more arrives). "World N" is
  `worldNumber(characterId)`: FNV-1a 32 of the id, mod 900000, plus 100000
  (six digits, stable). The app's source is `lib/seilink/animaLinkSource.ts`:
  it calls `seilinkAnimaPrepare(id, 'host_start')` (a no-op while a bake
  runs, a retry after one failed) and follows the `stage` main now puts on
  every `AnimaStatus` (`AnimaStage`: checking, requesting, queued, running,
  downloading, ready, unavailable, offline, failed + `AnimaFailure`;
  `animaClient.ts setStage`, pushed on `seilink:anima-changed`).
  `unavailable` (no pack will come, signed out) counts as every milestone:
  the fallback avatar is her look and the link still works. A replay plays
  the lines at the minimum dwell (`instantLog`).

  Failure ("WorldLink failed. Lost contact with World N. Come back later.",
  at the soonest `FAIL_BEAT_MS` (2.8 s) after the current line came up, so
  a failure during the 12 s "Waiting for a reply…" shows after a short
  beat): offline (stage or the window offline for
  5 s), a request, bake or install error, no line 9 by `LINK_TIMEOUT_MS`
  (3.5 min; the bake goes on in the background), or the host start failing.
  The light calms and stays, no her; Skip turns into Close (Esc too), which
  fades the overlay out as `aborted`. FirstLinkIntro then stops the host if
  it had started (`seilinkHostStop({reason: 'link_failed'})`, which also
  clears the move-in), gives the window back without a reveal, and leaves
  the intro unseen, so the next WorldLink press plays it again. Skip before
  the success line (on the desktop stage) crossfades into the solid and
  plays her entrance, then rushes the settle. Reduced motion: the same
  lines, order and failure, calm (crossfades, no bloom). Once per account
  (`lib/seilink/introPref.ts`, localStorage
  `sei.seilinkIntroSeen.v1.<scope>`): seen when it completed or was skipped
  on a move-in that worked. Replay plays it over her room with nothing
  starting.
  - Typing (v7, product feedback (261106); letter by letter since v9,
    product feedback (261107), `lib/seilink/typing.ts`): every line, the
    success and failure lines too, types in letter by letter like a
    typewriter (`typeUnits`: grapheme clusters from Intl.Segmenter, so
    emoji and CJK stay whole; `Array.from` without it). Each letter takes
    `TYPE_CHAR_MS` (34) give or take `TYPE_SPREAD_MS` (6), a fixed spread
    hashed from the text so renders are stable, plus `TYPE_SPACE_MS` (12)
    after a space and `TYPE_PUNCT_MS` (45) after punctuation
    (`typeDelays`), starting `TYPE_START_MS` (300) after the line's start
    and capped at `TYPE_MAX_MS` (1.8 s, a long translation types faster),
    so it always fits inside the shortest dwell and never moves line
    timing. The newest letter comes up over `CHAR_IN_MS` (20). A trailing
    ellipsis ("…", "...", "。。。", "⋯", repeats) is not typed: once the
    letters are in it becomes dots cycling ".", "..", "..." every
    `DOT_STEP_MS` (400) until the next line (`splitEllipsis`; "。" dots
    only for a "。。。" source; the catalogs keep their text). The view
    draws each line as typed / newest / rest (laid out with
    `visibility: hidden`) / three dot slots (opacity only), so the line
    keeps its full width and centre from the first frame; the line going
    out keeps its letters and dots as they were when
    the next one started (`caption.prevAge`). Reduced motion: the whole
    line at once with its own static ellipsis, crossfaded as before. The
    drawn lines are `aria-hidden`; a visually hidden `aria-live` element
    gets each whole line once.
  - Frames are pure (`introFrame.ts` computeFrame(introTimes(planLink(log)),
    t, W, H, reduced, end, tone), `introFx.ts` canvases), so the harness
    seeks them: `?seilinkintro=1` (DevIntroPreview, `&room=plain|blank|default
    &tone=dark|light&hold=1&reduced=1&manual=1`, and a simulated link:
    `&sim=<ms>` the bake done then, `&simfail=<ms>&failure=<class>`; the
    seeked length is `window.__firstLinkLength`), and
    `scripts/seilink-intro-shots.mjs` renders the review mp4s (`worldlink`
    75 s and `worldlink-light`, `fast` 20 s, `fail`, `reduced`,
    `reduced-light`, `instant`; `--stills ms,ms` for PNGs only) and prints each one's
    biggest frame-to-frame change of mean luminance (`<name>-luma.txt`; a
    cut shows as a big one). `scripts/seilink-first-room-flow.mjs --intro
    --intro-light` opens its flow videos with the whole intro (`--intro-from`
    seconds) and reports the same.
  - 261106 (product feedback: keep the aurora, make it space themed): the aurora is
    the only light (`IntroStyle` 'aurora'; bloom and tide are gone). v4 the
    same day: the product pick was the `eclipse` colours (gold light and blue-white
    rims against violet and teal nebula, `INTRO_PALETTE`); the other moods
    (accretion, nebula) and the `sei.seilinkIntroMood` switch are gone, and
    the event's `mood` is always `eclipse` (`INTRO_MOOD`). Layers: the void
    gradient, a faint seeded starfield canvas (half scale, `STAR_SCALE`), the
    curtains canvas (a sixth, `FIELD_SCALE`), the room, the front glows, a
    still grain tile (dither, alpha 5 or less, fades with the ending), the
    solid layer (the theme's colour, v5), the HUD. Gradients and glows only, additive: no
    lines, rings or grids. Skia dithers canvas gradients in a 2x2 pattern
    that shows as a checker once the small canvas is stretched, so each
    canvas gets a blur(1.2px) self-copy pass (`melt`).
  - The climax (261106 v5, product feedback: "fade to black not hard cut, like the
    light expands until fully bright or dark depending on dark or light
    theme"; v6 moved it under line 9, `lib/seilink/introTimeline.ts`
    `introTimes`, ms from line 9 / the success line). The solid
    (`IntroFrame.solid`, `tone`) is the theme's plain colour (PLAIN_COLOURS):
    white in light mode, black in dark mode, also for a room ending (the OS
    theme at mount), so light mode never goes black and dark never white. The
    intro opens out of the solid (`OPEN_MS` 1800) as the light wakes. v7
    (product feedback (261106)): the aurora is built per line. Each status
    line adds one wave (`IntroFrame.waves`, `WAVES` 9, tall bands about half
    the screen high whose edges `WAVE_ROWS` spread evenly top to bottom) and
    a ninth of `field.energy` (both smoothstep over `STEP_MS` 1200):
    brighter, wider swaying, more stars and a faster clock (up to 1.6x), so
    line 1 is one faint wave and line 9 the full aurora. Nine additive waves
    pile up fast, so per-wave alpha is lower than the old four curtains and
    the dark-mode climax gains no extra wave brightness (it stayed white
    otherwise). Under line 9 the light builds
    from +500 to its peak at +1500 (`field.peak`, the clock up to 2x more),
    then the bloom keeps expanding (`field.fill`) while the solid comes over
    it (+1550 to +2700): in light mode it blooms into white, in dark mode it
    dims into black. The success line lands on the full solid (+3200). v7:
    the light never comes back. It fades out behind the full solid; her
    place (the plain colour or her room, full screen) is laid in under it
    from the success line (`room.opacity` over 1 s); the success line types
    in, holds and fades out (`textOut` +3200, `TEXT_OUT_MS` 1000); then she
    is put in under the solid at `lift` (+4400) and the solid fades off her
    and her place by `clear` (+7200, 2.8 s, a slight rise and blur clearing),
    so what comes in is exactly what the wallpaper shows; port = clear,
    linked +7800, overlay fade +9400, end +10000 (reduced: textOut +2800,
    lift +4000, clear +6800, end +9200). She has no frame before the
    success line (no `after` timing exists until it is planned). HUD ink goes to day ink
    over the white solid (`roomBehind`). Every fade is a smoothstep of a
    second or more: tests cap each 30 fps step and the brightness reversals
    (at most two direction changes in any second) for instant, 20 s, 75 s
    and failed runs. A skip on the desktop stage rushes to the end only
    after the solid has cleared (`skipFrom`). Reduced motion: no peak and no
    build; a still, dimmer aurora (every wave, `REDUCED_ENERGY` 0.4) that
    crossfades into the solid (+400 to +2000 under line 9); she fades in as
    the solid fades off her.
  - The ending (`IntroEndOn`, `introEndFor(state, tone)` in plainTone.ts):
    `plain_dark` / `plain_light` (the plain colour, the same as the solid)
    or `room` (her room, full screen, no reveal circle since v7). It is laid
    in under the solid, so the hand-off is the solid fading off her; the
    v5 bloom, the white flood (`FLOOD_MAX`), her halo and the link-glow
    breath were removed in v7 (they were light coming back). The last frame
    is exactly the wallpaper.
  - Captions (v7): centred on the screen (`captionTop`), since she is
    never on screen with a status line. The WORLDLINK corner label is gone
    (the dialog keeps `aria-label="WorldLink"`). The captions and Skip/Close
    switch from light ink over a soft dark cloud to deep ink over a soft
    white cloud by how much light background is behind them (`roomBehind`
    + `dayInk`: the white solid, or her place as the solid fades off it).
    Feathered radial clouds, no boxes.
- **The guide's WorldLink tour** (`lib/seilink/tourPref.ts` decides,
  `seilinkTour.ts` records, `useTutorialStore` mode `seilink`, steps
  `sl_offer` / `sl_button` / `sl_room` in TutorialOverlay). App.tsx polls
  for a calm Home (no modal, tour, first moment, call, game or share; the
  same `readCalmUi` as the boot offers). Only where WorldLink is available,
  never in a session that ran onboarding, never for someone already linked.
  Existing users: "Hey! Remember me? I'm back! ..." New players: a day after
  onboarding. Sure: her chat, the WorldLink button spotlighted with two lines,
  then the move-in sheet. Not now: asked once more 3 days later, then never.
  Not persisted in `tutorial_state` (a quit ends it).

## Analytics (shape only)

The full event table (did it show, health, interaction, move-in, editor,
errors) is in [`seilink-analytics.md`](seilink-analytics.md). The basics:

- `seilink_started` {character_id, layout raised|classic|mac|other,
  attach_ms, restored}, on the first attach of a session.
- `seilink_attach_failed` {character_id, failure_class, reattach,
  from_host}, once per class per session.
- `seilink_ended` {character_id, reason, duration_ms, attached, restarts,
  failure_class?} at the single end choke point (`endSession`).
- NOT in the dashboard's `SESSION_EVENTS` (playtime), decided at M4: a
  wallpaper left running in the background is not playtime (same rule as a
  chat left open), and it would swamp the number. Her desktop lines are
  counted by `seilink_line_shown` instead.
- M4: `seilink_moved_in` {character_id, swapped, preset, first_room,
  blank_room (261106), plain_room + plain_tone dark|light|unknown (261106
  v3, from nativeTheme)} (not on a restore); `seilink_moved_out` {character_id, via app|dock};
  `seilink_dock_action` {action edit|deafen|moveout, character_id,
  deafened?}; `seilink_line_shown` {kind poke|idle|react, chars, character_id}.
  Never the line's text.

## Dev and CI

- Fake desktop: unpackaged + `SEI_SEILINK_FAKE_DESKTOP=1` makes the room a
  plain window with no addon, so Linux runs the whole pipe, supervisor and
  page path.
- Self-test (`selfTest.ts`, unpackaged + `SEI_SEILINK_SELFTEST=<outdir>`):
  attach, first frame, cover → 0 fps, uncover, click her / bare wallpaper /
  double click, a press on the dock's deafen button (twice, so it ends where
  it started; must not open her chat), kill → reattach, hang → detected and replaced, (Windows)
  Explorer restart survived by the same host, stop. Writes `result.json`, `selftest.log` and
  screenshots, then exits 0 or 1. Moves Sui in when the profile has her.
- Linux smoke:
  `node scripts/seilink-dev-pack.mjs --out /tmp/packs && npx electron-vite build &&
  SEI_SEILINK_PACKS=/tmp/packs SEI_SEILINK_SELFTEST=/tmp/st SEI_SEILINK_FAKE_DESKTOP=1
  SEI_DEV_USERDATA=SeiLinkSmoke timeout 240 xvfb-run -a -s "-screen 0 1920x1080x24"
  ./node_modules/.bin/electron . --no-sandbox` (cover/uncover/click are
  skipped there).
- Screenshots, no Electron: `?seilinkhost=1&pack=<url>`
  (DevHostPreview: the wallpaper page with the dock and a bubble over a fake
  bridge), `?dashshot=screen&seilink=on|off|unsupported` and
  `&modal=movein&pack=<url>[&swap=1]` (DevScreenShot), all shot by
  `node scripts/seilink-host-shots.mjs --out <dir>` (bundled cozy pack by default).
  `--shots host-crossfade --portrait <png> --facepacks <packs dir> --facepack-id <an-...>`
  shoots the portrait-to-face-set crossfade as a timed sequence (the face set
  "arrives" 1.5 s after the room draws; dev stub in `devHarnessStubs.ts`).
- The first-room flow (261106) on a simulated desktop (generic menu bar,
  icons, dock bar): `?seilinkflow=1&pack=<url>&phase=desktop|offer|prompt|
  later|editor|decorated|closed[&live=1]` (DevFirstRoomFlow; it starts on
  the plain state; `live=1` follows the presses: "Set up together" opens the
  guided editor over the desktop and Done comes back to the saved
  wallpaper). `node scripts/seilink-first-room-flow.mjs --out <dir>
  [--intro <worldlink.mp4>] [--intro-light <worldlink-light.mp4>]` clicks through
  the guided setup like a person, once per OS theme, and writes stills plus
  `first-room-flow-dark.mp4` / `-light.mp4`.
  261107: `phase=login` opens on the "Open on login" step over the decorated
  room; `&loginitem=off|approval|fail` fakes a supported, unanswered login
  item (with `live=1` the step follows the guided Done). Shots:
  `node scripts/seilink-host-shots.mjs --shots setup-login-light,setup-login-dark,setup-login-ja-light,settings-login-dark`.
- CI: `.github/workflows/seilink-host-check.yml` (windows-2022/2025,
  macos-15/26; dispatch, or push to `feat/seilink-host` under the host
  paths). One runner per OS also packages a dir build and checks the addon
  lands in `resources/seilink` and loads.

## Room placement: surface tops (261105)

Where items may go is labelled per pack (`seilinkRoom.ts` format,
`seilinkPlace.ts` math, `seilinkDraw.ts` order; the renderer, editor, look()
and thumbnails all use the same plan).

- `surfaceTops: [{area, lip?, sink?}]` on a part: `area` is the WHOLE top
  face (back edge to the front of the top, a quad for a plank), so an item's
  contact may rest anywhere in its depth with x free along it. Older
  `surfaceLines` / `surfaceAreas` still load (a line still means "on the
  line"); a pack can mix them.
- Leeway: a drag lands on a top while the pointer is within
  `SURFACE_CAPTURE` (48 canvas px) of it, above, below or past its end; the
  top it was on is kept while within capture; past capture the nearest wins
  with a lean downward (`DOWN_BIAS`). The anchor stays `END_INSET` (0.45 of
  the sprite width) in from the ends and the back of the base (one foot
  behind the contact, `BACK_OF_BASE`) stays on the top, so nothing hangs off
  or floats at the back. Rooms saved on the old lines are snapped onto the
  band on load (`settleItems` via `sanitizeRoomState`); items already inside
  stay where they were.
- `lip`: the WHOLE visible plank below its top face: front face, end face,
  underside and the dark bottom outline (261105, product feedback: "select the entire
  visible plank (both the side and under part) and put it on top of the
  object"). When something rests on that top, the plan adds the part's own
  frame again clipped to the lip (`SlotLayer.clip`), at the top of that
  top's z band, so the plank covers the base of the items on it and stays
  under the plank below's items. Tops of one part are ranked by height and
  get stacked z bands. Lip layers are baked into the renderer's cached
  composites (no per-frame cost) and have no glow of their own. The picker
  treats a lip as a hit anywhere inside its polygon (no alpha test); a lip
  that is not pickable still blocks the items under it, so an item cannot
  be grabbed through the plank. Manifest polygons are capped at 64 points
  (`ROOM_LIMITS.polygonPoints`); a longer lip is dropped by validation
  without a warning, so the tracer simplifies to fit.
- Tuck (261105): an item's opaque base ends about 2-4 px (sprite px) above
  its contact, so with the old 5 px tuck the item's own bottom outline still
  showed along the plank edge. Now a lipped top's contact may reach
  `LIP_TUCK` (10 canvas px) into the lip (`AreaSurface.poly` is the traced
  `face` stretched forward, back edge fixed), which hides roughly 9-12 px
  (6-10%) of an item at the front. Every item on a lipped top is cut to
  above the plank's BOTTOM edge (`ItemLayer.clip` = `AreaSurface.keep`, from
  `lipKeep` via `bottomEdge`; the old `KEEP_LIFT` top-edge cut is gone), so
  nothing pokes out under a thin plank and the lip layer hides the rest.
  The renderer (`roomCompose`), look() (`keepInside` + `cutToPolygons`), the
  picker and the drag ghost (CSS `clip-path` on the sprite plus `LipGhost`)
  all apply it. The guide still glows the traced face.
- `sink` (canvas px, a bed or a cushion): items on it are drawn `sink x
  scale` lower, their base fading out just under the contact, with a soft
  contact shadow as wide as the base (`sinkLook`, `contactShadow`,
  `baseSpan`). look() does the same in `roomRender.ts` (`sinkItem`,
  `cutToPolygons` for lips).
- Labelling: `scripts/seilink-region-overlay.mjs --bands <part>` traces
  plank tops and lips from the art's alpha (subpixel edges, median filters
  against bracket pins, Douglas-Peucker to at most 64 points) and prints
  `surfaceTops` for a draft; the top face is the first light run of 5+ rows
  in each column and the end face is the leading columns without one (cozy
  areas therefore start at x 25, after the end face). Logs and beds are
  traced by hand with `--grid 25 --crop`; the overlay draws tops (orange),
  lips (cyan hatch) and `sink N`; `--merge` writes the draft into the
  manifest. `roomRenderTops.test.ts` checks the bundled lips against the
  shelf art column by column. The editor's drag guide glows the top under
  the pointer and draws the lip over the drag ghost.
- Labelling the shipped packs (261105): floor and wall areas cover the BARE
  shell (`--without bed,chair,...`) and every part blocks its own silhouette,
  so removing an optional part frees its spot. Gamer's black planks need
  `--bands black_wall_shelves --dark 60`; its bed top and forest's log ridges
  are hand traced. Forest has no wall (a poster on the tree
  read wrong); its horizon is 300, not the distant hills, because the art's
  props barely shrink with depth (a far backpack ends up about half size,
  which matches the campfire ring's foreshortening). The log also blocks the
  ground behind Sei's seat (x 1040-1560): items there vanished behind her.
  Editor panels: a slot's panel comes from its id (`roomGroups.ts`) unless
  the pack names one (`slots.<id>.group`: room, fabrics or furniture).
  Forest's tent (bed slot) and log blanket (chair slot) are only recoloured,
  so they set `group: "fabrics"` (product feedback msg 1580: recolour or repattern only
  = Walls & fabrics, standalone pieces = Furniture).
  The tree stump has no top (261105): it sits behind Sei's head, so decor
  placed there never showed; a room saved with an item on it settles onto
  the log. Item `foot` = the sprite's first opaque row minus 3 (the
  cozy convention).

## Room catalog engine (261105)

Format additions are documented where they are parsed (`src/shared/seilinkRoom.ts`,
`seilinkValidate.ts`); all are optional, so the three packs and saved rooms
without them render as before.
- Patterns: a tintable part names a `patternSurface` (or an item a
  `patterns` list); `patternsFor` gives the 11 code-drawn tiles plus the
  pack's `patternTiles` (painted greyscale files, e.g. ditsy, leaves,
  clouds, sakura: none shipped yet). White in the tile = base colour, black =
  accent (default `toneOnTone(base)`), and the frame's shading multiplies on
  top. `patternQuads` (frame px, `[tl, tr, br, bl]`, `size` in surface units,
  about 388 per metre, optional `uv`) lay the tile in perspective; later
  quads win, pixels outside every quad get plain base. The warp
  (`roomPattern.ts`) is cached per frame + pattern + geometry and per colour,
  so the frame loop never runs it. Fitting quads: back-wall and floor planes
  from the vanishing points (cozy f about 2157, gamer about 2111); beds were
  hand-fit because the art's perspective does not agree with itself.
- Shared views: `_shared/views/<name>_<time>.webp`, referenced as
  `_shared/...` from any pack (resolved against the pack root's
  `_shared`, falling back to the bundled one). A view is one component with
  `fit: "cover"` and a per-room `focus: [x, y]`. Adding a view = one
  manifest entry per pack.
- Particles: a frame's `particles` (rain, snow, petals, fireflies, embers,
  dust) with optional `area`, `density`, `wind`, `glass` (rain drops on the
  window). A view's particles draw 'outside': clipped to the view box and cut
  by the glass mask (the view box minus everything drawn over it, cropped to
  the panes, built once per cached time). Other parts' particles draw in the
  'scene'. Simulation is seeded and shared (`seilinkParticles.ts`, scene cap
  160); reduced motion shows one settled still without rain; nothing runs
  while the wallpaper is covered or paused.
  Perf: the outside layer is masked IN PLACE on the fx canvas (one clipped
  destination-in), never via a scratch canvas: blitting a canvas that
  changed this frame measured 7.3 ms on a software GPU against 0.14 ms.
- Lights: a slot whose frames have `glowTint` lights its glow in the part's
  colour; `cycle: true` offers the colour-cycle swatch (body drawn white,
  glow steps round the hues every 125 ms, 20 s a lap). Glows combine by
  screen inside the glow layer (a glow file's opaque black adds nothing).
- Labels: `slots.<id>.label` names a slot per pack (forest: Tent, Log seat,
  Light post, Stump, Sky, Clearing). New optional slots `lights` and `tree`.
  Every label and pattern name is an i18n key (five dictionaries).
- Test pack: `node scripts/seilink-catalog-testpack.mjs --out <dir>
  [--no-particles]` overlays the bundled packs with cozy weather and
  placeholder fairy lights (never shipped); pass `--packs <dir>` to
  `seilink-editor-shots.mjs` (`--shots cat-...` for the catalog shots,
  `--fx --scenes name=query --video` for perf numbers and mp4s).
  Dev preview query state: `tint.<slot>=hex`, `pattern.<slot>=id`,
  `accent.<slot>=hex`, `cycle.<slot>=1`, `part.<slot>=id|none`.
- Colours (261105 colour pass, T333): each tintable part lists its curated
  `swatches` (default tint first, then light to dark, picked against the
  room's own art) and patterned parts their `accentSwatches`; parts without
  them get `DEFAULT_SWATCHES` / `DEFAULT_ACCENT_SWATCHES` (seilinkEdit.ts).
  Every row is nine cells: eight presets (or the automatic / colour-cycle
  cell and seven), then the custom swatch, which opens `RoomColorPicker`
  (square + hue + hex + a recent row kept in localStorage
  `sei.seilinkRecentColors`, per user, not per room). A drag previews once per
  frame under the row's gesture key: one undo step per drag. The popover is
  portalled into `[data-color-host]` (the side column, so it fades with the
  panel during an item drag) or the editor root; the editor's keys ignore
  events inside `[data-color-picker]`. Colours are stored as values, so a room
  saved with an old palette's colour draws the same and shows it on the
  custom swatch (`seilinkPalettes.test.ts`). Shots: `--shots col-...`;
  `--perf` drags in the picker (60 steps) against 12 part swaps.

## Gotchas

- macOS reopen: with the main window closed Sei keeps running. A Dock click
  or a click on her desktop room calls `openMainWindowAgain` (index.ts),
  which recreates ONLY the window (plus its events, popup guards and the auth
  window binding). It used to run `bootstrap()` again, which threw at step 0
  (`SUPABASE_CLIENT_ALREADY_CREATED`) and then on `protocol.handle` for an
  already handled scheme, so no window came back. `registerSeilinkIpc` and
  `registerSeilinkProtocol` are also idempotent.

- Rollup drops a side-effect-free busy loop: the `test-hang` loop counts
  and logs its spins so the hang actually happens.
- Linux dev hosts need `--no-sandbox` (passed through when main has it), or
  Chromium's sandbox setup kills them with SIGTRAP.
- macOS: the hit panel is clipped to the work area inset 12 pt (`clipRect`,
  `MAC_PANEL_EDGE_INSET`). The menu bar
  and the Dock row stay visible over a zoomed window, so a panel reaching into
  them never reads as occluded and the room never drops to 0 fps.
- Windows: the room window is created with `thickFrame: false`. With the
  resize frame, the attached child kept an 8 px non-client strip each side
  (wallpaper showing at the edges, her click box 8 px off). Attach logs
  `client WxH of WxH` if the client area ever differs again.
- Windows Explorer restart (261105, T332): when explorer.exe exits, Windows
  frees Progman / the WorkerW and every child window in them, the room
  window too, although it belongs to the host. The free reaches the room's
  thread as a bare WM_NCDESTROY with no WM_DESTROY before it (seen with the
  CI native trace); Chromium expects WM_DESTROY first and hit a CHECK inside
  the callback, so the host died with 0xC000041D before any JS ran and the
  supervisor restarted it (analytics said `host_restart`/`host_crash`).
  `win.cc` now subclasses the room window ("room window guard"): a
  WM_NCDESTROY without WM_DESTROY gets the WM_DESTROY replayed first, so the
  BrowserWindow closes normally; its 'closed' handler reads `roomLost()`,
  sets `shellLost`, and `recoverWindow` makes a new room window once the new
  shell is up (validate() keeps retrying if Explorer stays away longer than
  its 30 s wait). That attach is `shell-lost:window-closed`: cause
  `explorer_restart`, detail `shell_lost`. A container window of our own does
  not help: the free walks the tree bottom-up and the container gets nothing
  before the room does (tried, CI 261105). The CI explorer check fails if the
  host exits, restarts or changes pid, or the re-attach is not a
  `shell-lost:` one counted as `explorer_restart`.
- `SEI_SEILINK_NATIVE_TRACE=<file>` (set by the CI self-test only): win.cc
  appends every exception the process raises (code plus a module+offset
  stack, from an observing vectored handler), the room window's messages
  and the watcher's shell events, flushed per line so a dying host still
  leaves it. Artifact `native-trace.log`.
- macOS CI covers with TextEdit sized through Accessibility (the test addon's
  `axSetWindowFrame`); the runners have no Automation grant for AppleScript,
  and a window of our own bundle did not occlude the panel.
- The host page preload may import only `electron` (sandboxed; a test
  checks), and spells its channel names out (`seilinkHostChannels.ts`).

## Not done

- More displays: everything goes through `primaryRect()`; attach takes a
  rect, so it is a window per display plus bookkeeping.
- Her voice on the desktop: TTS lives in the main renderer and is tied to
  calls, so desktop lines are bubbles only (the mouth moves without audio).
- The dock is always shown (no hover on the wallpaper: Windows raw input
  only reports presses, the mac panel only covers the click area).
- Pack downloads (`downloadPack` is a stub): the three presets (cozy, gamer,
  forest, about 2.5 MB each) ship bundled in `resources/seilink-packs`
  (extraResources); a pack that fails to load shows its card disabled.

## Setup pass (261110, product call 261110)

- **Work-area stage on Windows.** `desktopStage.planEnter` sizes the stage
  to `display.workArea` on win32 (the taskbar stays visible and on top; a
  frameless window the size of the display that is not in the foreground
  does not cover the taskbar, which hid the editor's bottom row). macOS and
  Linux keep the whole display. The enter result carries a `frame` (the
  display's rect relative to the window, from the real content bounds) and
  RoomCanvas / FirstLinkIntroView / RoomEditor offset the room by it, so
  the staged room lines up with the wallpaper behind the taskbar. On
  win32 a setBounds that did not take (DPI across monitors) is set once
  more.
- **minimize_others** (`seilink:stage {action:'minimize_others'}`,
  `main/seilink/minimizeOthers.ts`). Windows: a PowerShell EnumWindows
  script minimizes every visible, minimizable top-level window of other
  processes without activating it (skips Sei's own pids, owned/tool/
  noactivate/cloaked windows, Progman/WorkerW/the taskbars). macOS:
  `Menu.sendActionToFirstResponder('hideOtherApplications:')` (the app
  menu's Hide Others; no Apple Events, no new entitlement). Linux:
  `unsupported`. Hand-test only.
- **LiveCard** (`components/seilink/LiveCard.tsx`, `lib/seilink/liveHintPref.ts`):
  "{name} lives on your desktop now", the show-desktop shortcut (Win+D;
  F11 / fn+F11), click = chat, double-click = a quick reply, and Minimize /
  Got it. Over the first link's held last frame before the window steps
  aside (FirstLinkIntro waits on it), or in the app after a move-in without
  the intro (`useSeilinkStore.liveHint`, SeilinkFlowHost; a fresh move-in
  steps aside once it is dismissed). Once per account (localStorage). The
  window going hidden while it is up (Win+D) counts as dismissed.
- Room editor: outlined placement areas (PlacementGuide, `.placeGuide`, no
  blur), sharp DPR-sized thumbnails (`roomThumbs.thumbScale`), a compact
  room step (`.roomCompact`), the items panel moves right when it would
  hide the shelves (`panelSide.ts`), and a Call button by the talk box
  (`lib/voice/callGate.ts` + useVoiceStore.startCall).
- Harness: `scripts/seilink-setup-shots.mjs` (DevFirstRoomFlow
  `together=`, `voicegate=consent`, `livecard=stage|app`, `os=`).

### Not done: the editor overlaid on the real desktop

The editor still covers the desktop with a picture of the room (the stage)
instead of editing the live wallpaper behind transparent controls. Doing
that needs: a transparent always-on-top overlay BrowserWindow per display
with its own renderer (the editor's stores, the room source and the call
audio live in the main renderer today); the host to draw unsaved edits
live (a preview-state push over the host protocol, rate-limited, with a
revert on cancel); the host's coverage detection to ignore our own overlay
(it pauses the wallpaper while a window covers it); and the talk box and
calls bridged into the overlay. Until then: work-area staging, Minimize
other windows, and the go-to-desktop hint.
