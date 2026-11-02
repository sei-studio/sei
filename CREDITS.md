# Credits and licenses

Sei is licensed under [AGPL-3.0](LICENSE). This page lists the projects, models, fonts, and art Sei builds on, with their licenses.

## Licensing details

The Stardew Valley and Don't Starve Together helper mods (`native/stardew-mod`, `native/dst-mod/sei`) and the vendored `soulcaster` and `skin-gen` libraries are MIT. The vendored chess engine `cce-1` is AGPL-3.0.

Sei is not affiliated with Mojang, Microsoft, ConcernedApe, Klei Entertainment, or Roblox. ChatGPT is a trademark of OpenAI; Sei is not affiliated with OpenAI.

## Acknowledgements

**Code and design adapted in Sei** (details in [native/dst-mod/THIRD_PARTY_NOTICES.md](native/dst-mod/THIRD_PARTY_NOTICES.md) and [native/stardew-mod/THIRD_PARTY_NOTICES.md](native/stardew-mod/THIRD_PARTY_NOTICES.md))

- [FAtiMA-DST](https://github.com/hineios/FAtiMA-DST) (MIT): the Don't Starve Together mod skeleton Sei's helper is adapted from, a survivor prefab driven by an external agent over HTTP with a DoAction / keep-working behaviour tree and a perception encoder
- [DST-AICompanion](https://github.com/votus777/DST-AICompanion) (MIT): the Follow / RunAway wiring for a companion body in Don't Starve Together
- [Chat Announcements](https://github.com/gyroplast/mod-dont-starve-chat-announcements) (CC0-1.0): the QueryServer POST and response handling pattern Sei's helper uses to talk to localhost
- [Farmtronics](https://github.com/JoeStrout/Farmtronics) (MIT): the invisible shadow-Farmer pattern Sei's Stardew Valley companion body is built on
- [amarisaster/StardewValley-MCP](https://github.com/amarisaster/StardewValley-MCP) (Apache-2.0): the NPC + shadow-farmer pairing and tool-use design the Stardew companion follows
- [StardewWebApi](https://github.com/zunderscore/StardewWebApi) (MIT): the HttpListener + WebSocket server shape inside a SMAPI mod
- [StarDojo](https://github.com/StarDojo2025/stardojo) (MIT): game-thread marshalling and the observation exporters the Stardew snapshot is modeled on
- [JunimoServer](https://github.com/stardew-valley-dedicated-server/server) (MIT): the chat-box postfix the Stardew companion listens through
- [luy-0/StardewValley-MCP](https://github.com/luy-0/StardewValley-MCP) (Apache-2.0): the mod-as-listener transport and per-install token design, used as a reference
- [SMAPI](https://smapi.io) (LGPL-3.0): the Stardew Valley mod loader, downloaded from its official release at install time, never vendored; its game-folder detection logic is ported in TypeScript. Its build package `Pathoschild.Stardew.ModBuildConfig` and the bundled Harmony library are MIT
- [tldraw](https://github.com/tldraw/tldraw) agent template (MIT): the `PenAction` the Draw! companion's pen tool is adapted from

**Libraries, engines, and downloaded components**

- [mineflayer](https://github.com/PrismarineJS/mineflayer) (MIT): the Minecraft bot framework Sei's game adapter is built on
- [PrismarineJS](https://github.com/PrismarineJS) (MIT): the broader Minecraft protocol tooling that makes this possible, including minecraft-protocol, minecraft-data, mineflayer-pathfinder, and prismarine-viewer
- [Fabric Loader](https://github.com/FabricMC/fabric-loader) (Apache-2.0) and [CustomSkinLoader](https://github.com/xfl03/MCCustomSkinLoader) (GPL-3.0): downloaded by the Minecraft setup to give companions their skins, never bundled
- [skinview3d](https://github.com/bs-community/skinview3d) (MIT): the 3D skin preview
- [Stockfish](https://github.com/official-stockfish/Stockfish) via [stockfish.js](https://github.com/nmrugg/stockfish.js) (GPL-3.0): the chess engine bundled in cce-1
- [Maia Chess](https://www.maiachess.com) by CSSLab, University of Toronto ([CSSLab/maia3](https://github.com/CSSLab/maia3), AGPL-3.0): the Maia3-5M model behind the companion's human-like chess moves, used as our ONNX export and downloaded on first game
- [chess.js](https://github.com/jhlywa/chess.js) (BSD-2-Clause): chess rules and move validation
- [pixi-live2d-display](https://github.com/guansss/pixi-live2d-display) (MIT, via the lipsync-patch fork) and [PixiJS](https://github.com/pixijs/pixijs) (MIT): Live2D rendering
- [Live2D Cubism Core](https://www.live2d.com/en/sdk/) (Live2D Proprietary Software License): fetched at build time and shipped in the app as its license allows, never committed
- [Transformers.js](https://github.com/huggingface/transformers.js) (Apache-2.0) with [Whisper](https://github.com/openai/whisper) (MIT): on-device speech recognition
- [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) (Apache-2.0): on-device voices and speech recognition
- [Signalsmith Stretch](https://github.com/Signalsmith-Audio/signalsmith-stretch) (MIT): voice pitch shifting

**Models, voices, and data**

- [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) by hexgrad (Apache-2.0): the optional Kokoro local voice, as the sherpa-onnx int8 v1.0 pack, downloaded on first use. Integration contributed by [@Trikto7e8](https://github.com/Trikto7e8)
- [SenseVoice-Small](https://github.com/FunAudioLLM/SenseVoice) by FunAudioLLM (Alibaba) ([FunASR Model License](https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE)): on-device speech recognition
- English voice trained on [LibriTTS-R](https://www.openslr.org/141/) ([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)) with [Piper](https://github.com/rhasspy/piper) (MIT), converted to ONNX
- Chinese voice trained on [AISHELL-3](https://www.openslr.org/93/) by Beijing Shell Shell Technology (Apache-2.0) with [icefall](https://github.com/k2-fsa/icefall) (Apache-2.0)

**Fonts and art**

- [Monocraft](https://github.com/IdreesInc/Monocraft) (OFL-1.1): the pixel face the Minecraft launch panel is set in
- Oswald, Rajdhani, JetBrains Mono, Noto Sans, Press Start 2P, Architects Daughter, Pixelify Sans, Fredericka the Great, and Metamorphous (OFL-1.1), and Roboto Mono (Apache-2.0): self-hosted app fonts
- Chess pieces by Colin M.L. Burnett (the "cburnett" set from [lichess](https://github.com/lichess-org/lila)), used under the GPL
- [Kenney Impact Sounds](https://kenney.nl/assets/impact-sounds) (CC0): footstep sounds
- Minecraft artwork by Mojang Studios. Movie night photo by [American Retirement Homes](https://americanretirementhomes.org/movie-nights-and-in-house-entertainment-options/) (CC licensed)

**Inspiration**

- [Project AIRI](https://github.com/moeru-ai/airi) (MIT): open-sourced digital "embodied" AI companion, which also informed the Live2D liveliness model
- [Character.AI](https://character.ai): demonstrated personalized AI characters
- [Neuro-sama](https://vedal.ai/): showed that AI can make people happy
- Hoshimachi Suisei: the GOAT
