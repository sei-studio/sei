# Third-party notices: Sei Slay the Spire 2 mod

This mod (`sei-sts2`) is a fork. What it contains and under which terms:

| Part | Origin | License |
|---|---|---|
| Everything in `SeiSts2/` except `SeiSts2/Sei/` (game integration: contexts, actions, patches, stability detector) | [VedalAI/neuro-sts2](https://github.com/VedalAI/neuro-sts2) at commit `21f9a34` | MIT, see `LICENSE` (copyright NeuroSlayTheSpire2Integration Contributors, Ningdong Wang) |
| `SeiSts2/NeuroSdk/` (Neuro SDK client: websocket, actions, messages) | Ported in neuro-sts2 from [VedalAI/neuro-sdk](https://github.com/VedalAI/neuro-sdk) | MIT |
| `SeiSts2/NeuroSdk/External/NativeWebSocket/` | [endel/NativeWebSocket](https://github.com/endel/NativeWebSocket) (Endel Dreyer, Jiri Hybek) | Apache-2.0, see `SeiSts2/NeuroSdk/External/NativeWebSocket/LICENSE.txt` |
| `SeiSts2/NeuroSdk/External/ModuleInitializerAttribute.cs` | .NET Foundation | MIT |
| `SeiSts2/Sei/` and every edit marked `// Sei:` in the upstream files | Sei | MIT (same `LICENSE`) |

Upstream's README is kept as `SeiSts2/UPSTREAM_README.md`.

## Not included

The mod compiles against, and at runtime uses, assemblies that ship with the
game: `sts2.dll` (Mega Crit), `GodotSharp.dll` (Godot Engine, MIT) and
`0Harmony.dll` (Harmony by Andreas Pardeike, MIT). They are referenced with
`Private=false`, never copied into this repository, the build output, or the
Sei game pack.

No code was taken from other Slay the Spire 2 mods. Two other projects were
read for how the game behaves (command-line flags, co-op save rules) only:
one is AGPL-3.0 and one has no license, so none of their code is used here.
