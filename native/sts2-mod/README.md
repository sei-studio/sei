# Sei Slay the Spire 2 mod (`sei-sts2`)

The game-side half of Sei's Slay the Spire 2 companion. One mod, two roles:

- **host**: the player's own game window. Adds a "Play with <companion>" button to
  the main menu that opens a localhost co-op lobby, reports its state to Sei in a
  status file, and shows the companion's speech bubbles. It never plays.
- **seat**: the companion's window, started by Sei with
  `--windowed --force-steam off --clientId 1001 -fastmp join`. It joins the
  player's lobby, and the bot plays it through the Neuro SDK protocol, plus Sei's
  structured state and events. The window is kept small and muted.

The wire and file contract is [PROTOCOL.md](PROTOCOL.md).

## Provenance

A fork of [VedalAI/neuro-sts2](https://github.com/VedalAI/neuro-sts2) (MIT) at
commit `21f9a34`. Sei's code lives in `SeiSts2/Sei/`; every change to an
upstream file is marked with a `// Sei:` comment, so `grep -rn "Sei:" SeiSts2`
lists the whole diff against upstream. Licenses: [LICENSE](LICENSE) (MIT, upstream
copyright plus Sei's line) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Changes to upstream behaviour, in short:

- connects to the bot via `link.json` (re-read before every attempt, retry every 2 s forever); `NEURO_SDK_WS_URL` still wins;
- handshake on every (re)connect: `startup` + `sei/hello`, stale queue dropped, seat re-registers and re-forces;
- game name sent as `Slay the Spire 2` (upstream: `Slay The Spire 2`);
- no writes to the player's settings (upstream disabled tutorials and saved settings at startup);
- host role applies none of upstream's gameplay patches (treasure auto-open, FTUE skipping, the decision loop);
- the seat never starts a singleplayer run from the main menu (env `SEI_STS2_SOLO=1` restores that, for testing);
- `use_potion`'s explicit `ally_index` excludes yourself, like `play_card`'s;
- log at `<linkDir>/sei-sts2-<role>.log`, capped at 5 MB (upstream: `~/sts2agent.log`);
- upstream's PostBuild copy into the game folder is gone.

## Build

Needs the **.NET 9 SDK** and the game installed: the mod compiles against the
game's `sts2.dll`, `GodotSharp.dll` and `0Harmony.dll` from its data folder.

```bash
npm run build:sts2-mod   # same as:
scripts/build-sts2-mod.sh --data-path "<data folder>"
```

The data folder (`SlayTheSpireDataPath`):

- Windows: `<game>/data_sts2_windows_x86_64`
- macOS: `SlayTheSpire2.app/Contents/Resources/data_sts2_macos_arm64`

The script auto-detects the default Steam locations, and also reads
`STS2_DATA_PATH`. For IDE builds put `SlayTheSpireDataPath` in
`SeiSts2/Directory.Build.props.user` (ignored by git).

Output: `assets/sts2-mod/sei-sts2/{sei-sts2.dll, sei-sts2.json}`. That folder is
**tracked in git**, like `assets/stardew-mod`: rebuild on a machine with the
game and commit the result whenever `native/sts2-mod` changes. The game pack
packs it: `node scripts/build-game-pack.mjs sts2`.

**Never commit the game's DLLs** (`sts2.dll`, `GodotSharp.dll`, `0Harmony.dll`).
The csproj references them with `Private=false` and the build script refuses to
finish if one lands in the output.

CI does not build the mod (no game there); it only packs the checked-in build.

## Install (what Sei main does)

Copy `sei-sts2.dll` and `sei-sts2.json` into the game's mods folder, then the
player enables the mod once in the game (Settings, Mods).

- Windows: `<game>/mods/`
- macOS: `SlayTheSpire2.app/Contents/MacOS/mods/`, as community mod docs say
  (STS2MCP's README gives exactly this path) and where Sei installs. Upstream's
  build copied into `Contents/Resources/mods/` (`$(SlayTheSpireDataPath)/../mods/`)
  instead, so the first Mac test checks that the game lists the mod from
  `Contents/MacOS/mods/`; if it does not, `modsDirFor` in
  `src/main/games/sts2/install.ts` changes to the Resources path.

## Dev without Sei

- `NEURO_SDK_WS_URL=ws://127.0.0.1:8000` points the mod at any Neuro SDK server (upstream behaviour).
- `SEI_STS2_ROLE=seat|host` forces the role; `SEI_STS2_LINK_DIR` moves the link folder.
- `SEI_STS2_SOLO=1` lets a seat window play singleplayer from the main menu.
- `src/bot/adapter/sts2/fixtures/fakeMod.js` is the bot-side stand-in for this mod.

## Unverified game API

Everything below compiles without the game (reflection or Godot API) but has
not been checked against a real build. Each is marked `TODO(game)` in code.

| What | Where |
|---|---|
| Floor and ascension member names on `RunState` | `Sei/SeiState.cs` (run) |
| Max energy member name | `Sei/SeiState.cs` (Me) |
| `CardModel.Type` for the card type | `Sei/SeiState.cs` (Hand) |
| `TalkCmd.Play(string, Creature, ...)` for speech bubbles | `Sei/SeiIncoming.cs` (SeiBubble) |
| `CommandLineHelper._args` + `fastmp=host_standard` making the Host path use ENet | `Sei/SeiHostLobby.cs` |
| Net service class names (ENet vs Steam) for `lobby` | `Sei/SeiHostLobby.cs` (LobbyKind) |
| Lobby player list before embark | `Sei/SeiHostLobby.cs` (LobbyPlayers) |
| Local player name outside a run | `Sei/SeiRuntime.cs` (LocalPlayerName) |
| Game build string (falls back to Godot's project version) | `Sei/SeiRuntime.cs` (GameVersion) |
| Seat retry of `-fastmp join` from the main menu | `Sei/SeiRuntime.cs` (SeatAtMainMenu) |
| Early-access disclaimer on a fresh seat profile | `Plugin.cs` |
| In-game chat hook for `sei/chat` | not implemented |

The rest of the game API the Sei code uses is the same the upstream mod already
uses (`RunManager`, `CombatManager`, `LocalContext`, `Player`, `Creature`,
`CardModel`, `PotionModel`, map points, main menu node paths).
