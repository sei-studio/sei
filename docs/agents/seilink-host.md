# SeiLink desktop host (261104, milestones 3 and 4)

The companion's room as a live wallpaper: one window behind the desktop
icons on the primary display (Windows: the WorkerW/Progman layer; macOS: the
desktop window level plus a small hit panel over her). On while SeiLink is on
(`gate.ts` `seilinkEnabled()`: Settings > Labs > "Desktop room"
`seilink_enabled`, per profile, off by default, on a supported install; or the
dev flag, unpackaged with `SEI_SEILINK_PACKS`). Supported = macOS or Windows
with the host addon in the build; elsewhere the Labs toggle is disabled with
the reason. Linux reports `unsupported_platform`; the app builds and runs the
same. The room source (`roomStore.roomSource`) is gated the same way, so a
user with SeiLink off gets no room line and no look() tool (no added tokens).
With SeiLink on, only the companion who moved in gets them, and only while
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
macOS the hit panel takes the desktop's clicks inside it. Shawn's
room-editor deck puts these shortcuts in "the bottom dock" of the room, so it
lives on the wallpaper, not in the app or a tray.
- Edit room → main `deps.openRoomEditor` (shows Sei, pushes
  `seilink:open-room-editor`; App.tsx navigates to her page and
  `useSeilinkStore.requestEditor` opens her editor there).
- Deafen → toggles `seilink_deafened` (main-owned, per profile), pushed back
  as `dock-state`. Mutes her IDLE lines only; a reply to a poke still shows.
- Move out → the first press turns the button into "Move out?" for 4 s, a
  second press sends the action; main `stopSeilinkHost('user_stop', 'dock')`.
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
  ipc.ts). The face set is the facepack dev flag's, as in the app.

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
  account switch (`restoreSeilinkHost`, which also mirrors the Labs setting
  into gate.ts). A restore first checks she still exists: a companion whose
  file is gone has her move-in cleared and nothing starts. A user stop, the setting turning off (`applySeilinkSetting`
  from the config:save handler) and deleting or removing her
  (`onSeilinkCharacterRemoved`, reason `character_removed`) clear it; quit,
  failure and an account switch keep it.
- Move-in (M4): the companion page's gear menu has "Move onto desktop" /
  "Move off desktop" and "Edit room" while SeiLink is on. The first move-in
  of a companion (no saved room: `SeilinkRoomPayload.saved`), or one that
  moves someone else out, opens `MoveInSheet` (room cards from the packs
  that exist, three lines on what it means, Move in). Otherwise the page
  starts the host directly. `lib/seilink/moveIn.ts` has the rules.
- Account switch: `endAccountSessions` calls
  `stopSeilinkHostForAccountSwitch()`; starts take `beginSessionStart()`
  (`ACCOUNT_SWITCHING` during a switch).

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
- M4: `seilink_setting_toggled` {enabled, supported} on a Labs change;
  `seilink_moved_in` {character_id, swapped, preset, first_room} (not on a
  restore); `seilink_moved_out` {character_id, via app|dock};
  `seilink_dock_action` {action edit|deafen|moveout, character_id,
  deafened?}; `seilink_line_shown` {kind poke|idle, chars, character_id}.
  Never the line's text.

## Dev and CI

- Fake desktop: unpackaged + `SEI_SEILINK_FAKE_DESKTOP=1` makes the room a
  plain window with no addon, so Linux runs the whole pipe, supervisor and
  page path.
- Self-test (`selfTest.ts`, unpackaged + `SEI_SEILINK_SELFTEST=<outdir>`):
  attach, first frame, cover → 0 fps, uncover, click her / bare wallpaper /
  double click, a press on the dock's deafen button (twice, so it ends where
  it started; must not open her chat), kill → reattach, hang → detected and replaced, (Windows)
  Explorer restart, stop. Writes `result.json`, `selftest.log` and
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
- `lip`: the front face of the plank. When something rests on that top,
  the plan adds the part's own frame again clipped to the lip
  (`SlotLayer.clip`), at the top of that top's z band, so the lip covers the
  base of the items on it and stays under the plank below's items. Tops of
  one part are ranked by height and get stacked z bands. Lip layers are baked
  into the renderer's cached composites (no per-frame cost) and have no glow
  of their own; the picker ignores a lip outside its polygon.
- Tuck (261105, Shawn: "the items are in front of shelf, put shelf in
  front"): an item's opaque base ends about 4 px (sprite px) above its
  contact, so an item at the front of a top used to end exactly on the
  plank's front edge and read as perched in front of it. Now a lipped top's
  contact may reach `LIP_TUCK` (5 canvas px) into the lip (`AreaSurface.poly`
  is the traced `face` stretched forward, back edge fixed), and every item
  on a lipped top is cut to above the lip's top edge minus `KEEP_LIFT`
  (`ItemLayer.clip` = `AreaSurface.keep`, from `lipKeep`), so the plank's
  front outline always draws over its base and nothing shows on the front
  face or under a thin plank. The renderer (`roomCompose`), look()
  (`keepInside`), the picker and the drag ghost (CSS `clip-path` on the
  sprite, lift shadow on its wrapper) all apply the cut. Only the lip's TOP
  edge matters for the cut; the guide still glows the traced face.
- `sink` (canvas px, a bed or a cushion): items on it are drawn `sink x
  scale` lower, their base fading out just under the contact, with a soft
  contact shadow as wide as the base (`sinkLook`, `contactShadow`,
  `baseSpan`). look() does the same in `roomRender.ts` (`sinkItem`,
  `cutToPolygons` for lips).
- Labelling: `scripts/seilink-region-overlay.mjs --bands <part>` measures
  plank tops and lips from the art and prints `surfaceTops` for a draft;
  logs and beds are traced by hand with `--grid 25 --crop`; the
  overlay draws tops (orange), lips (cyan hatch) and `sink N`; `--merge`
  writes the draft into the manifest. The editor's drag guide glows the top
  under the pointer and draws the lip over the drag ghost.
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
  so they set `group: "fabrics"` (Shawn msg 1580: recolour or repattern only
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
