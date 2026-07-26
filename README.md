<div align="center">

[<img src="docs/sei-logo-blue.png" alt="Sei" width="240" />](https://sei.gg)

Play games with AI gamers.
An omni-game AI player mod.

<img src="docs/app-home.png" alt="Sei launcher" width="720" />

<br />

[<img src="docs/btn-macos.svg" alt="Download for macOS (Apple Silicon)" height="46" />](https://github.com/sei-studio/sei/releases/latest/download/Sei-mac-arm64.zip)
&nbsp;
[<img src="docs/btn-windows.svg" alt="Download for Windows" height="46" />](https://github.com/sei-studio/sei/releases/latest/download/Sei-win-x64.exe)

<sub>On an Intel Mac? [Download the Intel build](https://github.com/sei-studio/sei/releases/latest/download/Sei-mac-x64.zip).</sub>

</div>

---

Sei is an AI companion platform ([sei.gg](https://sei.gg)) that lets you chat, call, and play games with AI powered gamers all in one place. Users can match with unique companions, create from scratch, import from other platforms, or explore shared companions. The app currently supports existing titles (Minecraft) as well as in-app minigames, with future plans to enable AI gamers to play every game in some capacity. Through gaming, Sei aims to create AI companions that help humans flourish.

<div align="center">

<table>
<tr>
<td><img src="docs/shot-voice.png" alt="A group voice call in Sei" width="240" /></td>
<td><img src="docs/shot-minecraft.png" alt="A Sei character playing Minecraft" width="240" /></td>
<td><img src="docs/shot-chess.png" alt="A Sei character playing chess" width="240" /></td>
</tr>
<tr>
<td align="center"><sub>Voice call</sub></td>
<td align="center"><sub>Existing games</sub></td>
<td align="center"><sub>In-app minigames</sub></td>
</tr>
</table>

</div>

## Current Capabilities

- Minecraft: companions join a LAN world as a second player
- In-app minigames: chess, with more on the way
- Voice calls, solo or group, in 70+ languages
- Unique companions matched to each player
- Custom Minecraft skins and in-game vision
- Autonomously managed long-term memory
- Knowledge upload for importing existing companions
- Bring your own API key or sign in for cloud-hosted AI

## Upcoming

**v0.5 releases**

- More minigames!
- Backseat (beta): watch you play games or do anything on your computer

**v0.6**

- Backseat (full): watch you play games, and intervene when they feel like it

**v1.0**

- Omni-game adapter: summon characters into any multiplayer game

## Development

```bash
git clone https://github.com/sei-studio/sei.git
cd sei
npm install
npm run dev
```

No `.env` needed. Cloud traffic routes through the Sei proxy, so sign-in, cloud characters, and cloud AI work from a plain clone. Use `.env.example` only to point at your own proxy or Supabase project.

To run local mode instead, open Settings, pick a provider, and paste your own LLM API key.

Help is welcome with any part of the repo, for example:

- Improving the Minecraft experience
- Adding support for new games
- Better personality and memory

To get more involved with the product side, reach out at [ouen@sei.gg](mailto:ouen@sei.gg).

## Acknowledgements

- [mineflayer](https://github.com/PrismarineJS/mineflayer): the Minecraft bot framework Sei's game adapter is built on
- [Project AIRI](https://github.com/moeru-ai/airi): open-sourced digital "embodied" AI companion
- [Character.AI](https://character.ai): demonstrated personalized AI characters
- [Neuro-sama](https://vedal.ai/): showed that AI can make people happy
- [PrismarineJS](https://github.com/PrismarineJS): the broader Minecraft protocol tooling that makes this possible
- Hoshimachi Suisei: the GOAT
