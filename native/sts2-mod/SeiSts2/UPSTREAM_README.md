# <img src="https://raw.githubusercontent.com/VedalAI/neuro-sdk/refs/heads/main/Assets/icon.png" width="29" style="vertical-align:middle;"> Slay the Spire 2 Neuro Integration

A Slay the Spire 2 mod that integrates the game with Neuro SDK.

## Overview

The mod watches the current game context, registers the actions that are valid for that decision point, and sends context updates back to Neuro. Neuro then decides which actions to take, which the mod validates and executes in-game.

## Connection setup

The websocket URL is discovered from the `NEURO_SDK_WS_URL` environment variable.

Example for overriding the URL:

```bash
export NEURO_SDK_WS_URL=ws://127.0.0.1:8000
```

## Command Line arguments

The mod has following Commandline arguments that can be passed as launch options for controlling Multiplayer behaviour:

- "--multiplayer-host" - Starts the mod as a Multiplayer Host, continues any previous runs if they exist
- "--multiplayer-host-abandon" - Starts the mod as a Multiplayer Host, abandons any previous runs if they exist. This should be run between play sessions.
- "--multiplayer-join arg1" - Starts the mod as a Multiplayer Client, Tries to join a host with the Steam user name `arg1`.
- "--multiplayer-join-any" - Starts the mod as a Multiplayer Client, Tries to join any available host. This should be preferred as its unlikely other users are in a multiplayer lobby

## Installation

1. Build the mod from this repository.
2. Copy the produced `neuro-sts2.dll` and `neuro-sts2.json` into your Slay the Spire 2 `mods/` folder if your build step did not already copy them there.
3. Set `NEURO_SDK_WS_URL` so the mod can reach Neuro.
4. Launch the game.

## Building from source

Requires .NET 9.0 and a local STS2 installation so `sts2.dll`, `GodotSharp.dll`, and `0Harmony.dll` can be resolved.

```bash
dotnet build --nologo
```

The project is configured to copy the built DLL and `neuro-sts2.json` into the STS2 mods directory after a successful build.

## Logs

The mod writes logs to `~/sts2agent.log`.
On Windows, this is typically `C:\Users\<username>\sts2agent.log`.
