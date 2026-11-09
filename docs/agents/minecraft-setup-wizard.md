# Minecraft setup wizard: the target version (260916)

> Superseded in part by the games branch (260916, same day): the wizard now builds
> ONE "Sei <version>" profile PER version with a picker in the setup list, and
> readiness is per profile (`sei_ready_versions`). The version rule below
> (newest supported, never last-played) still holds; see "Minecraft's setup
> step, and the detection bug" in the Game adapters section for the current shape.

The skin-setup wizard builds a "Sei" Fabric profile in the vanilla launcher,
and **the version it builds it for is the newest one in minecraft-protocol's
`supportedVersions`**, never the launcher's last-played version
(`selectTargetMcVersion` in `src/shared/mcSetup.ts`, the only place the rule
lives; `src/shared/minecraft-protocol-version.d.ts` types the CJS table for
main and renderer alike). It used to take the last-played version with a
pinned 1.21.4 fallback only when that was unreadable, so once Minecraft 26.2
shipped (June 2026) any machine that had played it got a Sei profile the bot
could not join, and the version-not-supported popup pointed the player at the
profile Sei had just made for them. Measured on the 260914 support case (a
new user who spent 30 minutes on it and gave up), and on 6 of the 13 users
who tried a summon that week. CurseForge instances keep their own version:
they carry their own loader and cannot be moved. The scanner now reports
every Fabric profile's version (`McInstall.fabric_mc_versions`) so readiness
means Fabric for a JOINABLE version plus the skin mod, not "Fabric exists".
When the protocol bump lands, the wizard follows it with no change here.

Two more things from the same case, since they are why he never got in:

- **The Anthropic key is required only when Anthropic is the provider.** The
  bot's `ConfigSchema` used to refine the `anthropic` sub-object alone
  ("api_key required unless cloudMode"), which cannot see `llm.provider`, so
  the one keyless provider (Ollama) shipped an empty key and died on config
  validation before pinging the world, on every summon and every Minecraft
  version. Every other provider passed by accident (its vendor key was copied
  into `anthropic.api_key`). Now a top-level `superRefine`, pinned in
  `src/bot/llmInit.test.js` with the production shape (empty key). If a
  provider ever goes quiet at fork time, check this first.
- **"I've been here before" + a login with no account resumes the scene.**
  Google sign-in creates the account on the spot, so the returning branch used
  to complete a brand-new player as returning: no config written, no name, no
  companion, and the first summon refused with "your name is missing".
  260917: the route is decided by whether the profile HAS A NAME
  (`accountHasProfile` reads `preferred_name` off `sei.getConfig()`; main
  backfills it from the cloud profile before the scope flips, and only the
  app's own setup ever writes that column), so a veteran on a second machine
  reads as onboarded and a minutes-old Google sign-in does not. The two age
  heuristics (`signedIntoFreshAccount` under 10 minutes, `signedIntoExistingAccount`
  over 48 h) survive only as the fallback when that read fails. A returning
  login with no profile sends the scene
  to the `no-account` phase: Sui walks back in, says so, and re-asks the
  new-here question. The boot sign-in variant has no scene to resume and
  replays the full one. A password sign-in cannot tell "no account" from
  "wrong password" (same server error), so that panel names the way out.

## No Java install found (261104)

`wizard:detect-installs` also returns `extras` (`src/main/mcOtherInstalls.ts`,
read-only): third-party launcher instances (Prism, MultiMC, Modrinth App,
ATLauncher), a Bedrock install (Store package, `%APPDATA%\Minecraft Bedrock`,
`<drive>:\XboxGames\Minecraft for Windows`) and whether the official
launcher is installed. McSteps uses it for the "game" step: Bedrock only and
launcher-without-`.minecraft` get Open Minecraft Launcher
(`wizard:open-launcher`, no profile), and Java in another launcher is
DETECTION ONLY: Sei cannot write its Fabric profile there, so the step says
so, offers Launch (the bot joins any LAN world on a supported version) and
points skins at the official launcher.


## LAN world detection (lanWatcher, 260624 / 261107)

Main finds the open world every 2s without multicast on macOS (signed apps
cannot receive it there): list local listening TCP ports (`lsof`, or
`netstat -ano` on Windows), then status-ping each over loopback
(`mcPing.ts`). Only a port that answers the ping is ever reported.

Issue #52 (Windows 11 26300.x with KB5127936): the TCP table reports
listeners with state 0, so netstat leaves Minecraft's port out while it
still accepts connections, and Sei sat on "No open world". When the netstat
pass finds nothing, Windows adds two sources (`winLanFallback.ts`):
- `stateless_enum`: `Get-NetTCPConnection -OwningProcess <java pids>`
  through PowerShell, reading the raw CIM state. Rows with an empty / 0
  state that look like listeners become candidates. Background refresh
  every 10s (30s after six empty runs or once it found the world), only
  while tasklist shows a Java process, and off for the session once netstat
  itself has found a world. Never on the 2s poll.
- `multicast`: Minecraft's `[MOTD]..[/MOTD][AD]port[/AD]` announcement on
  224.0.2.60:4445 (`lanBeacon.ts`). Binding UDP can raise the Windows
  Firewall prompt, so it starts only on evidence that the table is broken
  (the state-0 signature, PowerShell or tasklist failing, netstat failing
  or listing no listeners). Not on macOS / Linux.
Ping order: Java-owned ports, then fallback hints, then the rest
(`lanSources.ts`). Analytics, shape only: `lan_world_found {source,
sources, java_owned, win_state0, beacon_active}` once per world, and a
failed `game_setup_step` `lan_wait` carries main's `discovery` class
(`enum_failed`, `no_java`, `pending`, `stateless_failed`,
`no_java_listener`, `unverified`) and `win_state0`. There is no manual port
entry; the bot CLI copy (`src/bot/adapter/minecraft/lanDiscovery.js`) has
no fallback.
