# Game adapters: Stardew Valley + Don't Starve Together (260908)

The companion can be launched into the player's own Stardew Valley farm or
hosted Don't Starve Together world the way it is launched into a Minecraft
LAN world. Design and research: `docs/design/game-adapters-260908.md` (+
`docs/design/research/game-adapters-*-260908.md`, `dst-survivors-260908.md`).
Both tiles are `available: true` in `src/shared/games.ts` (flipped 260908 so
the user can run the live checklist from the app itself); the live checklist
(plan section 5, M3, per game) is still owed, and neither game self-launches
(`selfLaunch` off: each needs a player-run install pass first). Settings
hosts every game under ONE "Games & search" group (`GamesSettingsGroup`: left
column picks the game, right column shows that game's registered section; a
rule then the non-game `extraTabs`, today only "Web search").

- **Neither game has a mineflayer.** DST has no headless client and Steam
  allows one instance per account; a Stardew split-screen farmhand is
  gamepad-only. So in both games the companion is a BODY spawned by a
  Sei-owned mod inside the host's own game, visible to everyone in the world,
  and driven by the existing Node brain over localhost. The brain is not
  forked: `src/bot/brain/*` is one implementation and each game supplies an
  adapter (contract v2 in `src/bot/brain/types.js`).
- **Discovery in main, protocol in the bot**, like Minecraft (`lanWatcher`
  vs `adapter/minecraft/connect.js`). `src/main/games/<game>/watcher.ts`
  answers "is a world open"; `src/bot/adapter/<game>/runtime.js` speaks the
  game protocol. No game protocol code in main.
- **Reflexes live in the mod, decisions in the brain.** Retaliation,
  fleeing below a health floor, eating, darkness, end-of-day sleep run in the
  game process at frame rate (the Minecraft `behaviors/*` loops are the
  precedent) and report through the same `sei:attacked` / `sei:survival`
  event vocabulary. The LLM issues closed Zod-typed verbs; composite verbs
  (`gather(kind, count)`) loop mod-side so one call does a job.

**M0, the shared seams (all three games plug into these):**

- Bot: the composer `src/bot/index.js` is game-agnostic and dynamic-imports
  `src/bot/adapter/<kind>/runtime.js` (`botUsernameFor`, `adapterConfigFrom`,
  `checkJoinTarget`, `createRuntime(config, hooks) -> RuntimeHandle`), so
  mineflayer never loads for a non-Minecraft session. `adapter.kind` is
  `z.enum(GAME_KINDS)` with a real sub-schema per game in `src/bot/config.js`.
  Adapter contract v2 (`ADAPTER_INTERFACE_VERSION = 2`): every Minecraft name
  that had leaked into the brain is now an optional adapter member with a
  Minecraft default in `src/bot/brain/adapterDefaults.js` (`gameName`,
  `chatMaxChars`, `backgroundActions`, `progressActions`, `visionActions`,
  `prefilterToolBatch`/`postProcessToolBatch`, `surfaceBaseline`,
  `sessionEndClause`, `stuckNudges`, `eventAddendum` as the ONLY source of
  idle/attacked/survival/death prose, `getWorldIdentity`, `createTelemetry`,
  `classifyConnectError`), plus the optional `onIdleNudge` handler (a P3 idle
  tick with a named reason, ignored before the first spawn).
  `src/bot/brain/systemBlocks.minecraft.test.js` pins the Minecraft cached
  system prefix and tool list BYTE-FOR-BYTE against a fixture generated on the
  pre-refactor tree; touch the brain and that test tells you whether the model
  sees anything different.
- Main: `src/main/games/index.ts` `GameModule` registry (`effectiveUsername`,
  `collides`, `watcher`, `getJoinTarget`, `joinTargetMissingError`,
  `install`), registered from `src/main/index.ts`. `botSupervisor.summon(id,
  game)`; every `BotStatus` carries `game`; the play row, `bot_session_ended
  {game}` and `foldIfDue` (which Minecraft had been missing) key on the
  module. `src/shared/gameIpc.ts`: `GameId`, the `WorldState` and
  `GameDashboardSnapshot` unions, `world:*` and `gamedash:*` channels
  (`lan:*` / `mcdash:*` stay as Minecraft aliases). The chat-surface `launch`
  tool takes a `game` validated against catalog rows with `selfLaunch &&
  available`.
- Renderer: `registerGameSurface`, `registerSummonFlow`, `BOT_ERROR_ROUTES`
  by `(game, errorClass)`, `registerGameSettingsSection`,
  `registerGameSetupModal`; each game's `register*.ts` is imported once from
  `App.tsx`. `useMcDashboardStore.launch[id]` is the game whose launch panel
  is open. The controls window + status strip are shared
  (`mcdash/McDashControls.tsx`, `games/GameControlsWindow.tsx`), not copied.

**Game packs (260908, the user's decision 1).** Adapter runtimes are
DOWNLOADED on first use, Minecraft included: its deps (`minecraft-data`
429 MB, `prismarine-viewer` 392 MB, `gl` 218 MB on disk) live in the npm
workspace `packs/minecraft` which the root package does NOT depend on, so
electron-builder's npm collector (`npm list --omit dev` from the root) leaves
them out of the installer: measured 1.1 GB -> 706 MB app, 48 MB zip. Root
`npm ci` still hoists them, so dev and vitest are unchanged.
`scripts/build-game-pack.mjs <game> --platform --arch` builds
`sei-pack-<game>-<version>-<platform>-<arch>.zip` (Minecraft per platform
with natives rebuilt against Electron's ABI and the same texture prunes as
`electron-builder.yml`; Stardew and DST as `any-any` asset packs carrying
the game-side mod under `assets/`); `pack.json` carries a `treeHash` over
sorted paths + contents so a re-download is skipped when the content did not
change. The release workflow builds every pack beside the app and the release
job writes ONE `game-packs-<version>.json` manifest (sha256 per zip);
`mirror-release.yml` mirrors it all to `dl.sei.gg/updates/`. Client:
`src/shared/gamePacks.ts` (descriptors, asset names, mirror-first URLs),
`src/main/games/packs.ts` (`getPackState`, `ensurePack`: manifest, download
with progress, sha256 verify, jszip extract with traversal rejection,
`installed.json`, older versions pruned, single-flight; dev short-circuits
to the repo root, `SEI_GAME_PACKS_DIR` exercises the real path in dev),
`game:pack-*` IPC, `useGamePackStore` + `GamePackCard` in every launch
panel. **A treeHash match is not proof of a usable pack (260924).**
v0.6.5-beta.1 shipped a 745-byte DST pack: the builder hashed the staged
mod under `assets/` but zipped only `pack.json node_modules`, and the
client's extractor required `node_modules/`, which failed every Stardew
install (no node_modules in an asset pack) with ENOENT. Now the builder
zips every staged entry and re-reads each zip
(`scripts/lib/gamePackVerify.mjs`: treeHash re-derived from the zip bytes,
file count, the game's required payload), CI builds the two any-any packs
for real on every push, and the client checks `GAME_PACKS[game].requiredPaths`
(+ pack.json `files` on re-link and extract), so a payload-less install
reads as missing and is downloaded again even when its treeHash matches. The supervisor awaits `ensurePack(game)` BEFORE `startedAtMs` so a
multi-minute download never eats the 30 s summon deadline, and ships
`packRoot` in the init payload; `src/bot/packLoader.js` registers a
`module.register()` resolve hook (normal resolution first, pack second) plus
NODE_PATH for the CJS `createRequire` path BEFORE the composer imports the
runtime. **The composer's runtime import must stay dynamic**: a static
import is hoisted past the hook. Two traps: the root `overrides` entry for
`gl` must be the literal tarball spec (an override cannot reference a
workspace dep), and a fresh worktree needs `npm install --ignore-scripts` to
link `node_modules/@sei/*` before the pack builder's `npm list` sees the
workspaces.

**Stardew Valley (M1)** `native/stardew-mod/SeiCompanion/` (C#, net6.0,
SMAPI >= 4.5, MIT; `PROTOCOL.md` beside it, mirrored in
`src/shared/stardewIpc.ts`). Body = a vanilla `NPC` (the visible sprite,
default placeholder art generated by `scripts/gen-stardew-placeholder-art.mjs`)
paired with an invisible `BotFarmer : Farmer` shadow (Farmtronics pattern)
that performs tool use, combat and placement through the game's own APIs;
the shadow is NEVER added to `Game1.otherFarmers`. Decompile facts that
shaped it, cited in code: `MeleeWeapon.DoDamage` returns early for a
non-local farmer (combat goes through `location.damageMonster`),
`Farmer.Money` throws for anyone but `Game1.player` (own wallet in
`modData`), `Crop.harvest` hands items to `Game1.player` (re-implemented),
`WarpPathfindingCache` ignores the Farm (own BFS over warps + doors),
monsters target only `location.farmers` (contact damage is simulated by the
reflex loop). Transport: `HttpListener` on `http://localhost:<port>/`,
`GET /hello` unauthenticated for the watcher, `/ws?token=` NDJSON for the
bot (every client dials `localhost`, not `127.0.0.1`, for Windows
`HttpListener`). 20 verbs in `src/bot/adapter/stardew/registry.js`. Install
(`src/main/games/stardew/install.ts`) ports SMAPI's GameScanner logic,
downloads the SMAPI installer (mirror first), runs it `--install --no-prompt`,
copies the mod from `<packRoot>/assets/stardew-mod/SeiCompanion`. The setup
only runs while something is missing, so `launchStardew` calls
`upgradeModIfNewer` before it starts the game (260925): when the pack's
`manifest.json` Version is newer than the installed one it re-places the mod,
keeping `config.json` (token + port). A game started through Steam instead
keeps its old mod until the next launch from Sei. **Bump the manifest Version
with every mod change** or installed copies never update. **The mod
compiles only against the game's assemblies** (verified clean against
1.6.15 + SMAPI 4.5.2 on this machine), so `assets/stardew-mod/` is a TRACKED
build output the release packs with `--skip-build`; rebuild and commit it
with any C# change. Verified live 260910 (see the Stardew live-test
paragraph below): the SMAPI installer driven from Node on macOS, the NPC
walking (with the barrier hop), fishing, tool swings, cross-map travel and
the shop. Still unverified: combat in the mines (spring 5+), a farmhand.

**Setup failure handling (261104).** The scan also looks in
`<drive>:\XboxGames\Stardew Valley\Content` (the Xbox app's newer
default). When nothing is found the step offers Choose folder
(`stardew:choose-folder`): the pick is resolved to the folder holding
`Stardew Valley.dll` (an XboxGames or `.app` pick works), saved in
`<userData>/stardew-game-path.json` (never SMAPI's `stardewvalley.targets`)
and checked first on every scan (`state.manual`). The game version comes
from the dll's PE FileVersion (`readGameVersion`, cached by size + mtime; a
1.0.0 / non-1.x answer reads as unknown) against
`STARDEW_MIN_GAME_VERSION`, which a test pins to the mod manifest's
`MinimumGameVersion`. **Unverified on a real install:** that the dll's
FileVersion is the game version. SMAPI failures carry their own class:
SMAPI_NETWORK_FAILED, SMAPI_GAME_RUNNING (also checked before the
download, `stardew:game-running` process probe), SMAPI_PERMISSION_DENIED,
SMAPI_ANTIVIRUS_SUSPECTED (installer said done or left its dll, but
`StardewModdingAPI.exe` is gone; detection flags it as `smapiRemoved` on
Windows). The farm step probes the game process and, after 15 s of a
running game with a silent helper, shows the start-through-SMAPI hint.

**Discovery has no setting (260909).** Main binds the first free port of
`DST_DISCOVERY_PORTS` (27424..27428, `src/shared/dstIpc.ts`) and the mod
probes the same list every beat until one answers `app: "sei"`, then sticks
to it (three misses = probe again). The M2 build had one fixed port with a
Settings row and a mod option that had to agree, which is a setup step a
player cannot be asked for; `UserConfig.dst_port` survives as a dead field so
old configs parse. The other two player steps the game itself forces are
written into `DstSteps` (shown after the tile AND in the setup modal): the
helper must be in the game BEFORE it starts (mods are indexed once, at game
start, so `install.ts` reports `needsRestart` when the running game predates
the helper files, from `ps`/CIM start times; a live heartbeat clears it), and
a world must be hosted.

**macOS: the DST helper installs with one in-app click (260925, measured).**
The game's mods folder is `dontstarve_steam.app/Contents/mods/`, inside the
app bundle, and it holds both `mods/sei/` and `modsettings.lua`. Since macOS
13 writing into another app's bundle is gated: without a grant every write
there from Sei is EPERM (the folder itself is owner-writable; the refusal is
TCC). The binary hard-codes `../mods/` relative to its executable, so there is
no other folder (research: `~/suisei/research/dst-mod-install-no-appmgmt-2026-09-25.md`).
What works, measured on a signed v0.6.5-beta.2 with App Management OFF
(`~/suisei/reports/dst-grant-test-260925/`):
- **The Open panel grants the folder.** `dialog.showOpenDialog(win,
  {defaultPath: modsDir, properties: ['openDirectory','treatPackageAsDirectory',
  'createDirectory'], buttonLabel: 'Install helper', message})`; once the
  player clicks the button with `mods` selected (it opens there, so one click),
  macOS writes a `com.apple.macl` grant and Sei can mkdir, copy, delete,
  rewrite `modsettings.lua` and write-temp-then-rename inside `mods`.
  Choosing `dontstarve_steam.app` itself grants the whole bundle. Writes
  outside the chosen folder stay EPERM. The grant survived a full quit and
  relaunch of Sei; across a REBOOT or a DST UPDATE it is untested, which is
  why the write is always tried first and the panel shown only on EPERM.
- **Finder is exempt.** `tell application "Finder" to duplicate ... with
  replacing`, sent through `/usr/bin/osascript` from Sei, shows one "Sei wants
  access to control Finder" prompt and then works. A replaced file comes back
  0644 with a fresh mtime. No automation entitlement: the event is sent by
  osascript, and the test build had none. `NSAppleEventsUsageDescription` in
  `mac.extendInfo` is only the prompt's explanation line.
The flow (`installMod` + `grantAndInstall` + `finderInstall` in `install.ts`,
the Electron half in `macGrant.ts`): a CLICK ("Add Sei's helper", "Try
again", "Update helper", "Turn the helper back on"; `dst:install` passes a
`MacGrant`) tries the plain install; on a darwin EPERM it shows the Open panel
as a sheet on the Sei window, accepts only a realpath equal to `modsDir` or the
`.app` (case-insensitive), re-shows it once with a hint for any other folder,
and retries. Cancel means no: the one line plus "Try again", no Finder. A
second wrong folder, a retry that still EPERMs, or a panel that threw goes
to Finder: the mod and the new `modsettings.lua` are staged in a temp dir and
duplicated in with replacing (a replaced folder is replaced whole, so an
upgrade drops stale scripts), source file modes are put back where macOS
allows (best effort), everything is read back, and the staging is removed.
Only when both fail does `DstSteps` show the one App Management line plus
"Try again". **Nothing without a click ever shows a dialog.** A game launch
(`install.launch`) and the setup poll's re-enable run with no grant: a
refused write counts as success when the helper is already current and
enabled (the every-launch recopy is a refresh), otherwise the launch goes
ahead with whatever helper is there and the module sets `grantNeeded` on the
found state, so the helper step comes back with the button (cleared again
when a later detection sees the helper current and enabled) (a disabled
`modsettings.lua` shows as "Turn the helper back on" straight from detection).
The error still PERSISTS as before: `useDstStore` skips the poll while an
install is in flight and `mergeDetected` keeps an error until the helper is in
the game. `dst:open-app-management` still exists, unused. Windows and Linux
never take the grant path (their mods folder sits beside the exe; an EPERM
there is a plain error). Unverified on a Mac as built: the whole flow end to
end in a packaged build, the Finder "replace a folder whole" semantics, and
grant persistence across a reboot or a DST update.

**First live DST session (260909), and what it broke.** The end-to-end run
(tile, helper, restart, Host Game, Launch, greeting, come, follow) works, and
five things were wrong on the way that are worth knowing before the next
adapter. (1) `composeSeedBlocks` sent an EMPTY `seed_cuboid_grammar` text
block for any adapter without a cuboid grammar (DST, Stardew); Anthropic
answers an empty text block with 400 and the cloud proxy surfaced it as a
502, so the body spawned and every brain call failed. The block is now
omitted and the cache breakpoint moves to `seed_player`. Suspect this shape
first when a new surface's calls all fail while the same prompt works for
Minecraft. (2) Goals were per character, not per game: the first DST turn
read "reach stone pickaxe tier" out of `HEARTBEAT.md` and was told to pursue
it. Non-Minecraft games now use `HEARTBEAT.<game>.md` (`src/bot/index.js`);
Minecraft keeps the bare name so existing goals survive. (3) `come`/`follow`
resolved the player only inside the 24-unit perception sweep, and "come here"
is asked exactly when the body has wandered out of it (measured: 75 units,
"no player nearby"). Both now fall back to the pinned player's USERID
(`goto`/`follow` with `userid` in the mod, resolved against `AllPlayers`;
`""` means nearest). (4) The mod's heartbeat rode `DoPeriodicTask`, which
is sim time and stops on every server autopause (the survivor lobby, the
pause menu), so Sei flapped the world open/closed; it is `DoStaticPeriodicTask`
now. (5) `DisableLocalModWarning()` does NOT suppress the "Mods Installed"
force-enable notice, which shows on EVERY launch until the player ticks
"Don't show this again"; the step copy says to press "I understand". Also
measured: the real menu path is Host Game (not Play, then Host), a saved
world resumes through the survivor lobby, and DST DROPS all input while it
is not the frontmost app (background computer-use clicks worked for the
menus only because the game had focus; keystrokes never reached it), so a
computer-use test has to `open` the app bundle first and can only talk to
the companion through the Sei chat, which the brain frames as "NOT in the
game with you" by design (the Minecraft framing; a player who IS the host
gets the same wording).

**Second live DST round (260909, later): pause, crash, second companion.**
Verified: Pause holds the body still (a creature walked past a frozen
Wickerbottom for 20 s), Resume and the Reactive/Proactive switch take,
chop / pickup / goTo / come / gather / build (with a correct
missing-ingredient result) all ran from one chat instruction, killing the
game process stopped the bot inside 10 s with GAME_WORLD_NOT_OPEN and the
"Try again" re-summoned into the resumed save, and a bot killed with SIGKILL
raised the app's Connection lost modal. Left overnight, host AFK, the body
DIED: dusk in the dark (Charlie), sanity to zero, then starvation; the
death path itself worked (death event, memory write, DST_BODY_DIED, clean
stop, play row written). ONE COMPANION PER WORLD is now enforced: the helper
runs a single body and a second character's offer replaced the first
through a link-reset race (Despawn posts "despawned" then drops the link;
with `Net.Configure` called BEFORE `Companion.Summon` both landed on the new
runtime, which quit, while the old one starved of heartbeats and quit too,
leaving a brainless survivor). `GameModule.maxBodies = 1` +
`DST_ONE_COMPANION` in the supervisor, and `DstLaunchPanel` names the
occupant instead of offering Launch. The mod also gained a DEAD-RUNTIME
WATCHDOG (`Net.DEAD_AFTER` consecutive transport failures -> `Net.onDead` ->
Despawn "runtime gone", measured 4 s after a SIGKILL) and every Despawn step
is pcall-guarded and logged, because the first watchdog despawn logged and
still left a body standing (cause under investigation with the new logging).
Computer-use notes for the next round: DST needs to be the frontmost app
(`open` the bundle; Chrome steals focus back whenever the user browses), the
first click on a DST widget only HOVERS it and the second fires (send single
clicks twice, not a double-click), background screenshots of an unfocused
DST are STALE frames, keystrokes never reach the game, offline mode cannot
resume an online-created world (create a new one), and `client_log.txt` is
rewritten per launch.

**Every launch panel is a one-step setup window in the game's register
(260909).** The three bot-backed games' pre-launch surfaces (`McLaunchPanel`,
`StardewLaunchPanel`, `DstLaunchPanel`) share one shape, centered on the
game art: title, pack card, an OPTIONAL setup window, the big button, the
help link. The window is `components/games/SetupStepper.tsx`: it shows ONE
step at a time (Step n of m, the step's copy and its one button, Back /
Next, dots), so it is never taller than its tallest step and the big button
stays in view under it. The first cut drew every step as a numbered list on
the panel (McSteps, DstSteps) and the list pushed Launch below the fold of
the game aside. The steps are DATA from a per-game hook
(`useMcSetupSteps`, `useStardewSetupSteps`, `useDstSetupSteps`), each step
carrying its live `done` flag, so the window always shows the current state
rather than instructions, and the SAME hook feeds the token-styled setup
MODAL (DstSetupBody still renders the whole list there). Two window modes:
`setup` opens on the first step that is not done, FOLLOWS progress (a step
completing moves it on) and closes itself once everything is done; `help`
opens on step 1 for reading through. The panel's big button reads "Set up"
until the ONE-TIME part is done (`complete`: Minecraft = Java found and a
Sei-ready install or "Do not show again"; Stardew = `install.ready`; DST =
the helper in the game), then "Launch"; under an open window on an
unfinished setup it is a disabled "Launch", the goal. "How do I set up
launch?" shows only once the setup is complete and reopens the same window
in help mode. The per-session steps (a world open to LAN, a farm open, a
hosted world) are the last step of each list; a Launch pressed without one
still goes through the summon flow's own setup modal. Each panel paints the
window and buttons in its game's register through `StepperSkin` +
`StepSkin` (class maps + the game's button component): the vanilla
Minecraft dialog and raised gray button in Monocraft (OFL, a face drawn
after the game's typeface; Press Start 2P only works at label sizes), the
Stardew wooden frame with the cream face in Pixelify Sans, the Don't Starve
parchment sheet in Fredericka + Metamorphous, all as documented token
exceptions in their own CSS modules. `.content` uses `justify-content: safe
center` so a stack taller than the aside scrolls instead of clipping the
title. Verify with `?dashshot=mclaunch|dstlaunch|stardewlaunch` (+`&ready=1`
for the set-up state) on the dev server.

**Minecraft's setup step, and the detection bug (260909).** Step 2 of the
Minecraft list is what changed the product: the skin wizard used to be
offered once at onboarding and once on the first Minecraft open, and a
player who clicked past it had no way back but Settings. Now the step is
offered on every open until an install is ready or the player presses "Do
not show again" (`UserConfig.mc_setup_dismissed`; a ready install shows as
done even after a dismissal). "Ready" is `shared/mcSetup.ts`
`mcInstallReadyVersion`: a `versions/fabric-loader-<loader>-<mc>` profile
for a version Sei's networking stack can join AND the companion-skin mod,
so the scanner reports every Fabric profile's version
(`McInstall.fabric_mc_versions`) and Fabric for a snapshot no longer counts.
The VERSION half is what the wizard used to get wrong: it installed Fabric
for whatever the launcher last ran (snapshots included) and fell back to a
pinned 1.21.4 only when the version was unreadable, so once 26.2 shipped any
machine that had played it got a Sei profile the bot could not join (the
260914 support case: 6 of the 13 users who tried a summon that week hit the
version popup on 26.2). **Since 260916 the launcher's last-played version is
not an input at all.** `selectTargetMcVersion` (shared/mcSetup.ts, the only
place the rule lives) takes the version the player picked in the setup
list's row picker when Sei can join it, else the newest entry of
minecraft-protocol's supported table; the hand-kept VERIFIED list is gone.
**One "Sei <version>" profile per version**, each with its own game dir at
`<.minecraft>/sei/<version>/` (the pre-260916 single profile used
`<.minecraft>/sei/` and is left alone), because Fabric loads every jar in
mods/ and the skin mod is built per version, so two versions cannot share
one folder. Link manifests are keyed `installId@version` for the same
reason. Readiness is per PROFILE: the scanner reads launcher_profiles.json
and reports `McInstall.sei_ready_versions` (Fabric profiles whose own mods
folder has the skin mod), falling back to the old whole-install rule only
when that file is unreadable. The picker rides `runWizardInstall.mcVersions`
(named in the main/ipc.ts zod or it is stripped). The bug: the
first cut of `useMcSetupStore.scan` read `detectMcInstalls()` as a bare
array while the bridge answers `{ installs }`, so every scan came back as
"no Minecraft found" on a machine with a vanilla install and a Sei profile.
The tests had stubbed the bridge with an array, which is why they passed;
the harness stub and `McSteps.test.tsx` now use the real shape.

**Stardew live test on this Mac (260910), and what it changed.** Run from
the app with computer use on the dev Electron only (the game window was
never granted, so a `DevCommands` gate in the mod's config.json unlocks
developer frames: `newFarm` starts a game through the character menu with
the intro skipped, `loadFarm` reloads a save from the title, `devSleep`
ends the day through the bed path, `devTime` sets the clock, `devState` /
`devDebris` / `devTiles` report state; the app never sets the flag). The
game's `startup_preferences` was switched to windowed for the session (its
borderless-fullscreen default put the Sei window on an unreachable Space).
Findings, all fixed on `feat/game-adapters`:
- SMAPI "installed" was `StardewModdingAPI.dll` alone; this Mac had the dll
  (unpacked to compile the mod) with the vanilla launcher and no deps.json,
  so the installer was skipped and the game started without SMAPI forever.
  `smapiInstalledIn` requires the dll + `StardewModdingAPI.deps.json` + the
  launch hook (`StardewModdingAPI.exe`; on macOS/Linux the `StardewValley`
  script replaced by SMAPI's unix-launcher.sh, which runs
  `./StardewModdingAPI`). `spawnGame` sets `SMAPI_NO_TERMINAL` so the
  launcher does not open a Terminal window. A `require('../../paths')` in
  the installer's temp-dir resolver broke inside the electron-vite bundle
  ("Cannot find module"); it is a dynamic import now. The zip is 42 MB.
- Every map exit carries the `NPCBarrier` tile property and both the NPC
  pathfinder and the NPC's step collision honor it: the companion could not
  leave the farm. `TryPath` searches as a farmer (the shadow) and drives
  the NPC controller with that path; `BarrierHop` in Tick steps a stalled
  body across (or off) an NPC-only tile. `IsWalkable` uses the same farmer
  collision (the occupancy mask counted tilled soil as an obstacle).
  `Router.Exits` adds buildings with an inside, or nothing routed home.
- `Farmer.addItemToInventoryBool` refused every drop for the shadow (25
  pieces of debris, nothing in the bag) and `Debris.collect` threw on the
  cosmetic chunks: `TakeItem` manages the bag itself and `CollectDebris`
  lifts the item out of OBJECT/RESOURCE/ARCHAEOLOGY debris.
- A felled tree only finishes falling in the map's current-location update,
  which runs for the host's map alone; with the host indoors the chop loop
  swung to its cap (80 energy a tree, no wood). `ChopAt` ticks a falling
  tree itself. This is the general shape of "the companion works on a map
  the host is not on"; anything else that needs the location update
  (debris landing, machines are fine, they run on the clock) owes the same.
- Following undid every commanded door warp (the follow tick routed the
  body back to the host inside); a commanded map change now clears the
  follow target and says so. The observation is refreshed after every verb
  so the turn after a warp reads the new map's coordinates. The owner line
  names the host farmer, not the account's pinned name. Big stumps and
  boulders are marked as needing an upgraded tool in the snapshot.
- The heartbeat's "reachable next" list was EMPTY for Stardew, so the
  companion asked the player what the move was three ways in a minute and
  never acted. `observers/progression.json` is the first fortnight of a new
  farm (patch, the chest seeds, 50 wood, forage, town, seeds at Pierre's, a
  fish, the mines on spring 5, copper), each label an invitation with a part
  for the player; predicates read the mod's new `farm` (whole-Farm counts)
  and `host` blocks plus one-way latches from verb results. Latches live in
  the adapter instance, so they reset on re-summon (owed: persist them
  beside HEARTBEAT.stardew.md). The Stardew prompt gained a new-player rule
  (one concrete step and your half of it, mechanics when relevant, controls
  on request, stakes around the day's one big thing), a following rule, the
  shipping bin, the player's crafting recipes and the first-spring calendar.
- An app-typed line that lands mid-action was framed "NOT in the game with
  you" (the Minecraft assumption) and its say() answer stayed in the game:
  the framing is game-aware now and a loop that absorbed an app line
  mirrors its lines to the app (`loop._seiChatFolded`).
- The search branch is merged: every game bot also asks its own wiki
  (contract v2 `wikiHosts`: stardewvalleywiki.com, dontstarve.wiki.gg).
Verified live with the model: greeting, a committed project from the
frontier, leaving the house, 45 pieces of debris cleared with drops, the
dashboard strip; and by hand with a test body on the socket (the fastest
loop, no model): debris, wood, forage lookup, farm to Pierre's and back with
a purchase, till, plant, water, fish, chest take/put, sleep, a day end. Not
yet verified: in-game typed chat and voice (no game window), pause/mode on
Stardew, combat, a second companion, a farmhand.

**Stardew follow + pathing (260925, mod 0.1.2, unverified in game).** From
the v0.6.5-beta.2 playtest log (`~/suisei/reports/playtest-v065b2/`):
- **Walks stalled INTO the player.** All six "stuck" results in the SMAPI log
  had the next path tile equal to the player's tile with both collision
  checks false. The game's path search (`PathFindController.findPath`, run
  as the shadow farmer) never looks at farmers, while the NPC's step
  collision refuses to walk into one, so any path across the player stalled
  on the tile before it; `goTo` to the player's own coordinates could never
  arrive. Now: `TryPath` detours with the mod's own 4-connected A*
  (`Body/GridPath.cs`, pure, tested by `native/stardew-mod/GridPathTests`,
  `dotnet run` with no game) when the game's path crosses a farmer tile,
  keeping the game's path when no detour exists; `BarrierHop` steps THROUGH
  a farmer after 1 s stalled (the doorway case); `WalkTo` treats a
  farmer-occupied target as "next to it", drops farmer tiles from its goal
  ring, re-paths (max 2) on a stall, and reports "arrived" when a stall
  leaves it beside an adjacent-ok target; `come` takes one more leg when the
  player walked on; the follow tick picks the free tile beside the player on
  the body's side and counts stalls every tick (it counted 1 tick in 6-16).
- **Follow was cleared for good by any commanded map change** (and by
  bedtime/sleep), so "follow me, we're heading outside" died the moment the
  model walked out first. Now a commanded trip to a map the player is not on
  puts following ON HOLD (`SeiBody.FollowHoldAt`, obs `followHold`, snapshot
  `follow_target: X (on hold ...)`), released when the player leaves that
  map or reaches the body, which keeps the 260910 fix (no dragging back
  through the door). Following survives the night (`Sleeping` pauses it).
  The Stardew Following/Stuck rules in `prompts.js` say so, but ONLY when
  the connected mod reports 0.1.2+ in its welcome/hello
  (`adapter/stardew/modVersion.js`, `actionRules(modVersion)`,
  `composeSnapshot({ modVersion })`); an older mod still ends follow on a
  trip, so it gets `ACTION_RULES_LEGACY` and the bare follow name. Gate any
  future prompt text that describes new mod behavior the same way: the app
  ships before the Mac-built DLL.
- Review follow-ups (same PR): a command aborts a background follow-travel
  (it used to warp the body mid-purchase); stall counters (follow tick,
  BarrierHop, WalkTo) skip ticks where `!Game1.shouldTimePass()` (a chest
  menu teleported the body); follow-side `FreeTileNear(..., reachable: true)`
  needs the tile within 2 x radius steps of the player (`GridPath.WithinSteps`,
  never across a fence corner); detours are capped at
  `GridPath.DetourBudget` (4x the game's path, 16..400 nodes); follow never
  travels or warps into a festival, an event or a temporary map (`Temp`,
  `IsTemporary` by reflection), it waits.
- The mod source is at 0.1.2 but `assets/stardew-mod/` is still the OLD
  build (its DLL even reports assembly 0.1.0): rebuild on a machine with the
  game (`scripts/build-stardew-mod.sh`) and commit the output, which also
  carries the 0.1.2 manifest. Do not bump the asset manifest by hand without
  the DLL, or installs would record 0.1.2 with old code and never update.

**Stardew chores + hand-off (260926, mod 0.1.3, unverified in game).** From
the same playtest (goal: parsnips; she had no seeds, the host had 16, a 15-tile
field was 15 till calls, and "water the crops" reached 20 tiles while the
snapshot counted the whole farm). Audit: `~/suisei/reports/stardew-capability-audit-2026-09-26.md`.
- **till a patch in one call** (every mod version): `till({x, y, width,
  height})` up to `MAX_TILL_TILES` (40) is composed APP-side in
  `registry.js` `tillPatch` from single-tile tills, serpentine order, stones
  and grass skipped and named, energy / no hoe / abort / 4 unreachable tiles
  in a row stop it, progress via `onProgress` ("- 6/15" in in_flight). The
  mod's own interrupts (bedtime, retreating, knocked out, interrupted,
  superseded, paused, aborted) also stop it: sending the next tile would
  start a new command on top of the retreat or the walk home. The mod's
  till refuses any tile with a terrain feature, bush or clump (0.1.3).
- **Timeouts:** a farm-scope water/harvest gets a 15 min cap plus a 240 s
  no-progress timeout (`commandTimeouts` in `client.js`, reset by each
  `progress` frame); any `cmd` that times out is also CANCELLED in the mod.
- **water / harvest `scope: "farm"`** (0.1.3): walk to the Farm and cover the
  whole map (default 120, max 200). With no tile, water refills the can at
  the nearest water (`Tools.NearestWater`, up to 3 refills) instead of
  stopping at 40, and both step over up to 5 crops they cannot walk to.
  Harvest stops at a full bag and leaves the crop in the ground
  (`SeiBody.HasRoomFor`). An older mod gets `scope` dropped by the registry
  and the chores line says its calls reach 20 tiles.
- **ship / give** (0.1.3, `Actions/Shipping.cs`): ship walks to the farm's
  shipping bin and drops produce (crops/forage/fish by default, or a named
  item); give walks to the HOST and puts an item in their bag
  (`addItemToInventoryBool`, host only: a farmhand's inventory lives on
  their machine; nothing leaves her bag until the add has landed). Before these a harvest sat in the companion's bag.
  `CHORES_VERBS` are hidden from `listActions` and refused by the registry
  on an older mod.
- **Proactive layer:** the snapshot gains a `chores:` line
  (`farmChores`: dry / ready crops with the farm-wide call, ready machines,
  produce to ship), the player line says what the host is holding and when
  they are in a menu or cutscene (`host.holding/menu/inEvent`), the date line
  carries tomorrow's forecast (`tomorrow`). The new-day notice now waits
  (max `DAY_OBS_WAIT_MS`) for the new day's first observation and names the
  morning's chores. `fsmWires` raises `onIdleNudge({reason:
  'player_activity'})` when the host keeps a tool out for 3 s (once per
  60 s, same activity once per 5 min, proactive mode only (tier 2, read
  live from `config.persona.proactiveness`), never in a menu/event, off-map
  or while the body is busy) and the idle addendum pitches "your half" of that
  job (`ACTIVITY_SUGGESTIONS`).
- Prompt text for all of it is gated on 0.1.3 (`ACTION_RULES_CHORES`,
  `CAPABILITY_PARAGRAPH_CHORES`, `describeAction`); 0.1.2 keeps
  `ACTION_RULES` (plus the till patch, which is app-side). Same rule as
  0.1.2: `assets/stardew-mod/` is NOT rebuilt here; rebuild on the Mac and
  commit, which also ships the 0.1.3 manifest. New game APIs used (compile
  and verify on the Mac): `Item.canBeShipped`, `Object.sellToStorePrice`,
  `Farm.buildings` + `ShippingBin`, `Farm.getShippingBin(..).Add`,
  `Farmer.addItemToInventoryBool` on the host, `Farmer.CurrentItem`,
  `Game1.eventUp`, `Game1.weatherForTomorrow`,
  `GameLocation.getLargeTerrainFeatureAt`.

**Stardew companions look like themselves (260921).** Every Stardew body used
to be the one shared placeholder NPC sprite. It is now drawn as a FARMER
dressed with the game's own character creator knobs: gender, skin, hairstyle,
hair color, eye color, shirt, pants, pants color, accessory. No hat (not a
creator knob, and it hides the hair).
- **One LLM call per character, in main.**
  `src/main/games/stardew/appearance.ts` follows `chessProfile.ts` (forced
  tool call `set_stardew_appearance`, through `buildLlmProvider`, so cloud and
  BYOK both work) and `survivorPick.ts` (injectable deps, persisted SPARSE in
  `UserConfig.stardew_appearance[characterId]`, not in `character.metadata`,
  which cloud-syncs verbatim and is not editable on a default such as Lyra).
  Input is `gatherAppearanceText`: the soulcaster sheet's appearance block and
  image prompt first, then the description, then the persona source (the
  expanded persona only as a last resort). The character text sits between
  `<character>` tags and the system prompt says it is data. Two deliberate
  differences from the two precedents: a FAILED derivation is never persisted
  (a stored fallback would make the character generic forever because of one
  network error; the cost is at most one retry per summon), and the result is
  salvaged FIELD BY FIELD (`coerceStardewAppearance`: a model that gets eight
  knobs right and invents a shirt number still produced a usable look; fewer
  than 5 valid fields counts as a failure).
- **The legend is the feature.** The model cannot see the sprite sheets, so
  `src/shared/stardewAppearance.ts` lists every ALLOWED index with a short
  description of what it looks like, and the schema admits nothing else (42
  hairstyles, 70 shirts, 24 skins, 4 pants, 13 accessories). Tool properties
  are plain `integer` with the legend in the description, not JSON-schema
  number enums, because not every provider accepts those; the Zod schema is
  the gate. Ranges and the legend come from the game itself, not from a wiki:
  the 1.6.15 assemblies were read with Mono.Cecil (`changeSkinColor` wraps at
  0..23, `changeAccessory` at -1..29, shirts and pants are STRING item ids in
  1.6), `Data/Shirts` and `Data/Pants` were unpacked and parsed (the creator's
  own set is the rows with `CanChooseDuringCharacterCustomization`: shirts
  "1000".."1111", pants "0".."3"), `Data/HairData` adds hairstyles 100..122 to
  the sheet's 0..55, and the hair, shirt, accessory and pants sheets were
  unpacked (the game's MonoGame LZX decoder, run from a scratch tool) and
  looked at composited on the farmer body. The config row is deliberately
  LOOSE in `characterSchema.ts`; the strict legend check runs in the reader,
  so removing an index from a legend re-derives one character instead of
  failing the whole config parse.
- **Plumbing.** `GameModule.prepareJoin({characterId, character})` is a new
  optional async seam. The supervisor awaits it beside `ensurePack`, BEFORE
  `startedAtMs`, so it never comes out of the 30 s summon deadline, and merges
  what it returns into the join target (`getJoinTarget` is synchronous and
  does not know the character). Stardew's returns `{appearance}` from
  `appearanceForSummon`: a stored look at once, else a first derivation
  awaited for at most `APPEARANCE_SUMMON_WAIT_MS` (6 s), then the summon goes
  ahead WITHOUT the field while the single-flight derivation finishes and
  persists for next time. `adapterConfigFrom` copies it into `adapter.stardew`
  (loose schema with `.catch(undefined)` in `src/bot/config.js`: looks must
  never fail a bot config) and `runtime.js` adds it to the `spawn` frame, on
  reconnect spawns too. The field is optional end to end and
  `STARDEW_PROTOCOL_VERSION` is unchanged: an old mod ignores it, an old app
  never sends it.
- **The mod draws the shadow Farmer in the NPC's place, and the NPC stays the
  body.** `Body/Appearance.cs` clamps the frame field by field against what
  THE RUNNING GAME accepts (`Farmer.GetAllHairstyleIndices()`,
  `Game1.shirtData` / `pantsData`), not against the app's legend, so the
  legend can grow without a mod rebuild; then applies it through the game's
  own `change*` methods, gender first (it swaps the base texture and re-applies
  the shirt). `Body/BodyDraw.cs` is a Harmony PREFIX on
  `NPC.draw(SpriteBatch, float)` that, for a registered body, calls
  `FarmerRenderer.draw` with the shadow and skips the NPC's own draw. A prefix
  rather than an SMAPI `Rendered*` event because the farmer has to be inside
  the world's depth-sorted batch to pass behind trees; rather than an NPC
  subclass because `location.characters` is a NetCollection of NPC. Rendering
  the 16 walk frames into a sprite sheet was the fallback and was not needed.
  The decompile facts above still hold: the shadow is in neither
  `Game1.otherFarmers` nor `location.farmers`, and `BotFarmer.draw` stays a
  no-op so there is one draw path. Load-bearing details: the farmer is drawn
  16 px LOWER than the NPC position (an NPC's box is y+16..y+48, a farmer's
  y..y+32, both draw feet at the box bottom, so without it the feet float
  above the ground shadow and the collision box); depth is the NPC's own rule
  (`StandingPixel.Y / 10000`); the ground shadow needs nothing because
  `Game1.DrawWorld` draws character shadows separately from `NPC.draw`; the
  tool-use hop still shows because `getLocalPosition` carries `yJumpOffset`;
  emotes are kept by calling `npc.DrawEmote`. The shadow's `Update` never
  runs, so `SeiBody.AnimateShadow` advances the walk cycle each tick from
  whether the NPC moved (`FarmerSprite.animate(walkUp|Right|Down|Left, 16)`,
  else `StopAnimation` + `faceDirection`), only on the host's current map
  (FarmerSprite's footstep dust and sound are written for the map on screen),
  and the paused branch of `Tick` refreshes `_lastPos` or the walk cycle would
  run on the spot for the whole pause. Any failure (apply, animate, draw)
  flips that body back to the placeholder sprite for good and logs once;
  `FarmerLook: false` in the mod's config.json turns the whole thing off.
  No appearance in the frame means the mod's neutral default farmer, which is
  the ONLY default (main sends no field rather than a second copy of it).
- **Dev frame:** `devAppearance` (same `DevCommands` gate) returns the clamped
  request, the rejected fields, the values read back from the shadow farmer
  and the sprite frame / facing / base texture. `scripts/fake-stardew-mod.mjs`
  records the field and answers the same frame.
- **Unverified (the game was not launched for this change):** that the farmer
  actually draws in place and at the right height, the walk cycle in four
  directions, depth sorting against trees and buildings, the look of each
  legend entry on a dressed body in motion (the legend was written from the
  sheets, some hair entries from silhouettes only), what a farmhand sees
  (their game has no registry entry, so it should be the placeholder), and the
  quality of the model's picks for real characters. Tool-use animations are
  not implemented: a swing is still the NPC hop. Owed: a user override in the
  launch panel (`source: 'user'` is already in the stored row and is kept
  as is), and re-deriving when a character's description changes
  (`clearAppearance` exists; nothing calls it yet).
- **260925: the model sees the portrait, and the look is shared (v2).** The
  v0.6.5-beta.2 playtest drew Sui with wild blue spikes and a bright purple
  shirt. Root cause: the defaults have no description and no sheet, so the
  model got the personality blurb ("tomboy gremlin") and invented a look; it
  never saw the character. Now:
  - The portrait goes in as an IMAGE when the active backend can see
    (`activeLlmVision() === 'yes'`: cloud proxy, Anthropic BYOK, vision local
    models), read from `paths.portraitPath(id)` (cache-on-demand puts a cloud
    character's art there) or its https URL, and the prompt makes the picture
    the truth. The options are one labelled MENU in the message
    (`renderStardewAppearanceMenu`, hair grouped by length), and the tool call
    starts with an `observed` sentence. `scripts/stardew-appearance-probe.ts`
    runs v1 against v2 on the fixture portraits with the dev key. Measured
    (Haiku 4.5, 3 runs each): Sui's hair went from 8 (wild spikes) every run to
    a long style (115/24/110) in lavender every run; Lyra from a chin-length bob
    to long brown hair and a black top with a white collar; Marv from grey skin
    to red skin and bald, every run.
  - **The look lives in the CLOUD** (`src/main/cloud/gameProfileClient.ts`,
    table `character_game_profiles` + `POST /games/profile` in sei-proxy):
    read under RLS, written only through the proxy, FIRST WRITE WINS, and the
    response carries the stored row so a race loser adopts the winner's look.
    Every user then gets the same Sui. Resolution: local `user` row (this
    user's override) > cloud row at the current version (or the owner's cloud
    `user` edit) > local `auto` row at the current version > a new derivation.
    The config row is only a cache for when the cloud has no answer.
  - A derivation is offered to the cloud only when it SAW the portrait, or the
    character has no art at all: a blind text guess by a BYOK model without
    vision stays local, so it cannot become everyone's look.
  - `STARDEW_APPEARANCE_VERSION` (2) tags every row; older `auto` rows (every
    v1 look already in a config) are ignored and redone, and the proxy lets a
    higher version replace an `auto` row but never a `user` one.

**Dashboards in the games' own registers (260909).** Both bot-backed
dashboards are now DELIBERATE, CONTAINED EXCEPTIONS to the design tokens,
under the same contract as `McDashboardPanel` (which the Stardew panel used
to borrow wholesale, vanilla-gray windows and all): a game's live view
should read like that game's HUD, not like a settings page. Each panel's
CSS module declares its own palette on `.panel` and nothing outside the
component references it.
- `DstDashboardPanel` (+ `dstDashboard.ts`, pure + tested): ink ground,
  aged-parchment sheets with burnt edges and hand-cut corners, the three
  vitals as the HUD BADGES (dark ring, parchment face, the meter as coloured
  liquid rising from the bottom, the organ icon on top, pulsing when low),
  the CLOCK as the 16-segment day ring split day/dusk/night per season
  (`DST_PHASE_SPLIT`; the mod reports the phase, not the segment, so the
  whole phase is lit), body temperature with the game's freezing (<=0) and
  overheating (>=70) bands, and the inventory bar as dark slots in rows of
  15 with the equipped hand item in its own slot. Prefabs map to in-game
  names (`dstItemLabel`). Fonts: Fredericka the Great for figures,
  Metamorphous for labels (both OFL, DST-only).
- `StardewDashboardPanel` (+ `stardewDashboard.ts`, pure + tested): the
  wooden menu frame drawn in CSS (outline, wood band with highlight, inner
  line, cream face), dark-plum text with the tan drop shadow in Pixelify
  Sans (OFL, Stardew-only), ENERGY/HEALTH as the vertical HUD bars (green ->
  yellow under a quarter -> red under a tenth), the DATE BOX (weekday from
  the day number since day 1 is always Monday, weather + season icons, the
  day dial from 6 AM to 2 AM, HUD-cased time, gold in its own box), and the
  12 x 3 inventory with the held slot framed red.
- **Several companions in one game share the dashboard (260909).** A
  dashboard is mounted for ONE character, but Minecraft and Stardew run a
  body per character, so the status strip became a STATUS ROW: this
  companion's window first (titled with their name once there is company),
  then one window per other companion online in the same game, each a
  button that opens that companion's chat. Membership comes from
  `useDataStore.summons` (same `game`, kind `online`), not from what is on
  screen; the activity line needs that companion's telemetry, which main
  samples only while WATCHED, so `useGameCompanions`
  (`components/games/useGameCompanions.ts`) arms the watch flag for every
  sibling while the dashboard is mounted and shows an ellipsis until the
  first snapshot lands. All three dashboards use it (the Minecraft strip
  grew `name` + `companions` props). DST is one body per world, so its row
  never grows, but it rides the same code.
- **The width is spent (260909).** Both game-styled bodies are CSS grids:
  status row, then instruments, then inventory, with a PORTRAIT CARD in
  the fourth column spanning rows 2-3 (the companion's own art via
  `DashPortrait`, same seed + palette as the Home wall; name, survivor or
  location, held item). Whatever width the fixed windows leave goes to the
  face. The art is absolutely positioned inside its box so its canvas adds
  no intrinsic height (otherwise the spanning card GREW the rows it spans:
  measured, the first cut was a 700 px portrait). Under a container query
  (`.panel` is `container-type: inline-size`; 1000 px DST, 900 px Stardew)
  the card drops to a full-width row with the art on the left.
- **The controls are ONE hook, `components/games/useGameControls.ts`**
  (paused/mode/disconnect/hover hint + `GAME_CONTROL_DESCRIPTIONS`); each
  game paints its own buttons. `GameControlsWindow` (the token-styled
  generic version) rides the same hook and is now unused by any registered
  game; keep it for a future game that has no register of its own.
- **Verify in a browser tab, not a summon:** `?dashshot=1` (or
  `?dashshot=dontstarve|stardew`) on the dev server renders both panels
  over fixture snapshots (`components/games/DevDashShot.tsx`).
  `lib/ipcClient.ts` captures `window.sei` at module evaluation, and
  main.tsx's static import of App reaches it first, so the harness stubs
  live in `devHarnessStubs.ts`, which MUST stay main.tsx's first import.
  Render tests (`*DashboardPanel.test.tsx`) pin the meters, the clock, the
  slots and the zh coverage; CSS-module class names are hashed under vitest,
  so the tests count `data-slot` attributes rather than class names.

**Don't Starve Together (M2)** `native/dst-mod/sei/` (Lua, MIT, server-only,
`all_clients_require_mod = false`, luacheck clean; `PROTOCOL.md`, mirrored in
`src/shared/dstIpc.ts`). Body = a vanilla survivor prefab spawned on the
master sim with `scripts/brains/seibrain.lua` (FAtiMA-DST skeleton): safety
layer first (run away under 35% health, find light at dusk, fight back when
told, eat under 25% hunger), then the command slot. **Transport direction is
inverted**: a mod can only reach out through `TheSim:QueryServer` to
127.0.0.1 (Klei blocked third-party URLs in Jan 2025, hotfix 653007 carved
localhost back out; no headers, bodies under ~20 KB), so main's watcher hosts
a discovery port and answers the mod's 2 s heartbeat with a summon offer `{token, botPort, ...}` after the bot's
runtime reports its ephemeral `node:http` port over a `dst-listen` port
message; the mod then POSTs `/obs` at 3 Hz (delta-compressed, <= 8 KB) and
polls `GET /cmd` with a 400 ms bounded hold (measure it against the
undocumented QueryServer timeout on day one). 21 verbs. **The character picks
her survivor** (user decision 3): `src/main/games/dontstarve/survivorPick.ts`
is a one-off LLM call over the persona + the roster brief in
`src/shared/dstSurvivors.ts` (15 eligible; Wes, Wonkey, Woodie, Wanda
excluded, reasons in the brief), persisted sparse in
`UserConfig.dst_survivor[characterId]`, user-overridable in the launch panel;
the chosen survivor's perks ride the world primer, and each survivor's
special needs (meat-only, vegetarian, souls, wetness, fire, frailty) are DATA
read by both the BT and the primer, never branches. Install = mod copy into
`<install>/mods/sei/` + `modsettings.lua` (`ForceEnableMod("sei")`,
`DisableLocalModWarning()`), re-applied on every launch because game updates
rewrite that file; the mod copy also runs on every launch, and when the
pack's `modinfo.lua` version is newer the old `mods/sei/` is removed first
(260925); launch = `steam://rungameid/322330`. Four spikes wait for
the live checklist: a joiner with `all_clients_require_mod = false`,
ownerless `inst:Remove()`, a caves-enabled host, the QueryServer hold.

**DST helper 0.3.0: habits, alerts, frontier (260926).** Audit and headless
results: `~/suisei/reports/dst-capability-audit-2026-09-26.md`. Three things
worth knowing before touching the DST body:
- **Combat never landed a hit before this.** `ChaseAndAttack` calls
  `combat:TryAttack`, which only pushes `doattack`, and survivor stategraphs
  have no handler for it (players swing through the ATTACK action).
  `companion.lua` now translates `doattack` into a buffered ATTACK.
- **Survival chores are habits in the mod** (`scripts/sei/reflexes.lua`):
  dusk torch, night light, fire tending, gear-up, defending the player,
  healing, food choice. They report `survival` events that do NOT wake the
  brain (`fsmWires.js`); they surface as the snapshot's `your_habits` line.
  The brain is woken by `observers/alerts.js` (starving with no food,
  freezing, low health with nothing hostile near) and nudged at P3 (dusk with
  no way to make light, low sanity, player hungry, season turning) only when
  `persona.proactiveness` >= 1; passive characters see them in `heads_up`. The
  prompt tells the model the habits cannot plan: keeping the makings on hand
  is its job. `observers/progression.js` gives the heartbeat a frontier.
- **Everything new gates on the helper's reported version**
  (`modVersion.js`, `CAPS_MIN_MOD`). A world keeps the helper it started
  with, so an older helper gets the old prompts, verbs and wake routing.
  Bump `modinfo.lua` and `scripts/sei/version.lua` together (a test checks).
- **"Am I lit" is ONE test**, `Reflexes.LitByOthers`: the engine light
  (`TheSim:GetLightAtPoint`) at the body's feet with its own held lights
  switched off for the reading, with hysteresis (0.2 in, 0.1 out). Light,
  tool and gear habits all use it, so the torch and the axe cannot swap
  every tick. In the dark a work command walks there with the torch and
  refuses ("too dark to chop here") unless something else lights the spot.
- **Sleeping lights light nothing.** Entities away from a real client sleep
  (also in real play when the body is far from the host). `SetCanSleep(false)`
  does not wake an entity that is already asleep, only one set in the frame
  it spawns. So the equip listener keeps held lights awake, and
  `Reflexes.KeepFiresAwake` respawns the flame of a burning fire near the
  body awake (released at day or when she leaves). No light on the body.
- **Habits never undo an explicit `equip`** (`Reflexes.Hold`/`CommandHeld`)
  except dark with no light. Defend needs a `hostile` tag or a hit on the
  player in the last 6 s, never shadow creatures. `give` needs an exact name.
Headless testing (Linux dedicated server + `scripts/dst-headless-harness.mjs`)
is in `native/dst-mod/sei/README.md`.

**A world with caves runs two shards (261104, helper 0.3.1).** The helper
heartbeats from BOTH server shards (`ismastersim` is true on each), and each
beat lists only that shard's players. The watcher used to hand the summon to
whichever beat first, so about half the summons in a caves world spawned the
body in the dark caves with no player near, and Charlie killed it ~16 s
later: the 31% of DST sessions ending DST_BODY_DIED ~24 s after the summon
(proven on a headless two-shard server; the caves setting of real users is
not in analytics). `watcher.ts` now keeps one beat per shard, merges them
for the world state, and hands an offer only to the shard listing the
player (`dstOfferShard`; else the master; never a cave shard alone), and a
0.3.1 helper on a secondary shard refuses an offer for a player it does not
have. The body still cannot follow the host between shards.

**A death respawns the body (261104, app side, any helper).** An ownerless
survivor cannot be revived, so a death used to end every DST session. Now
`runtime.js` (decision in `respawn.js`, pure) waits `RESPAWN_DELAY_MS`
(4 s), despawns the corpse, ROTATES the link token (`link.rotateToken()`:
the mod's Despawn drops the link a second later only while its token is
unchanged, so a reused token cuts the new body) and posts a second
`dst-listen` with `respawn: true, nearUserid`. Main's
`setSummonOffer` queues it for the shard listing that host (else any
player, `pickRespawnHost`), or answers `dst-respawn-offer {ok:false,
reason: no_world|no_host}` and the session ends as `DST_BODY_DIED`, as does
no `spawned` within 15 s. Same brain, same prefab, no second greeting; the
inventory stays where she fell and stats are fresh. The brain's death turn
comes AFTER the respawn: fsmWires maps the mod's `death` to `onDying`
(orchestrator `noteDeath`, drops turns planned by the dead body) and the
runtime's own `bodydied` event to `onDeath`, whose `detail` (outcome,
cause, respawns left, player) feeds `DEATH_RESPAWNED_ADDENDUM` /
`DEATH_FINAL_ADDENDUM`: one say() line in her voice plus a remember() of
what killed her. Limits: `MAX_RESPAWNS` 3 per session, and a death within
`QUICK_DEATH_MS` (20 s) of a respawn twice in a row is a bad spot; either
gives a final death turn, then `DST_DIED_TOO_OFTEN` / `DST_DANGEROUS_SPOT`
(ERROR_COPY says "3 times", pinned to MAX_RESPAWNS by `respawn.test.js`).
`bot_session_ended` for DST carries `respawns`, `deaths` and
`last_death_cause` (a game id such as `darkness`, never the afflicter label,
which can be a player name), from the bot's `dst-lives` port messages
(`sessionLives.ts`). Test overrides: `dst.respawn_delay_ms`,
`respawn_timeout_ms`, `max_respawns`, `quick_death_ms`, `death_grace_ms`.

**DST quality pass 1 (261104, helper 0.3.2).** A headless eval with the real
brain lives in `scripts/quality-eval/dst/` (night, hostiles, follow, errands,
hunger, a chat question mid-errand; pass or fail from game state, one small
judge call for the chat line; usage in `native/dst-mod/sei/README.md`). What
it found and what changed:
- **A darkness hit is Charlie, not a monster.** The grue's hit reached the
  brain as an ordinary attack, and the monster text told her to flee, which
  does nothing in the dark and cancelled the gather that would have made her
  torch. `events.lua` names the hit, `darkness.js` / `fsmWires.js` route it
  to `DARK_HIT_ADDENDUM` (prompts.js): only light stops it, plus what the
  torch still needs from what she carries.
- **The light habit picks the torch makings** (`makingsAction` in
  `reflexes.lua`): dark, no light and nothing to craft one from means grass
  and twigs within 12 units are picked by the habit itself, retried every
  0.5 s, so the torch exists before the second hit. A body summoned or
  respawned into the dark with an empty bag used to die before the brain's
  gather landed.
- **The follow line says how far the target is once out of sight**
  (`followd` in the self block, `followFar` in `snapshot.js`). A command
  outranks Follow in the behaviour tree, so a long gather leaves her behind;
  she now sees that. She still often chooses to keep working.
- **A command whose action is invalid from the start ends at once**
  (`actionFor`). `PushBufferedAction` refuses it with only an `actionfailed`
  event and no fail callback, so a pick on an already-picked plant was
  rebuilt every tick until the 90 s deadline.
- **A blocked walk ends the command** (`superviseWalk` in `commands.lua`).
  The DoAction slot only asks for the next action when the current one ends,
  and a walk into water or a wall never ends, so the command and every one
  after it sat until the app's timeout, with gather's deadline never read.
  Three seconds without moving clears the walk: gather skips that target for
  60 s and says how many it could not reach, other commands end with
  `cant_reach`. Gather's deadline is also checked from the brain tick.
- **A replaced command lets go of the old action** (`cancelCurrent`). While
  the body walks to a target the action sits on the LOCOMOTOR, so
  `ClearBufferedAction` missed it and `locomotor:Stop()` kept it; the
  DoAction node stayed on the old action and the new command never started
  (the body stood until the app's timeout). Most eval timeouts followed a
  "cancelled" result. `locomotor:Clear()` fails it and ends the node. Any
  code that cancels mid-walk owes the same.

**Credits:** every reused project is in `CREDITS.md` (linked from the README
License section) with its license (user decision 7); copied code carries a header
credit and `native/<mod>/THIRD_PARTY_NOTICES.md`.
