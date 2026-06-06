---
name: phase-09-context
phase: 9
description: Custom bot skins via CustomSkinLoader — locked context for planning
gathered: 2026-05-17
promoted_from: quick task 260517-frz
status: Ready for planning
---

# Phase 9: Custom Bot Skins via CustomSkinLoader — Context

**Gathered:** 2026-05-17
**Promoted from:** Quick task 260517-frz (research + discussion preserved in RESEARCH.md)
**Depends on:** Phase 8 (Windows cross-platform compatibility) — Phase 9's wizard auto-detects MC installations on both macOS and Windows; that work assumes the rest of Sei already runs on Windows.

<domain>
## Phase Boundary

Give Sei bots a visible custom skin **and** custom username when they join the
user's Minecraft world. The host (user) must see the skin in-game on their own
client. Works for vanilla MC and modded (CurseForge instances, including
Pixelmon). Zero manual user setup beyond clicking through Sei's first-launch
wizard.

**In scope:**
- First-launch setup wizard: detect MC installations, auto-install Fabric Loader
  for vanilla MC, drop CustomSkinLoader mod into the right `mods/` folder,
  write CustomSkinLoader config pointing at Sei's local skin HTTP server.
- Local skin HTTP server inside Sei: serves persona skins as PNG to
  CustomSkinLoader on demand.
- Renderer UI: skin upload (file picker) and skin search (by Minecraft username)
  on the character/persona page, with 3D preview of the skin.
- Bot connect: mineflayer uses persona's username (any string in offline mode);
  no protocol-level skin injection needed (CustomSkinLoader handles rendering).
- Cross-platform: macOS + Windows. (Linux nice-to-have, not blocking.)
- Per-persona skin and username, persisted on persona record.

**Out of scope (this phase):**
- Friends seeing the bot's skin without installing the mod themselves
  (deferred — most use cases are solo or duo; document as "advanced setup")
- Online-mode dedicated servers (this phase targets offline LAN / Direct
  Connect to offline servers; online-mode is a separate feature gate)
- Mod auto-update when MC version changes (deferred to a maintenance phase)
- Forge installer automation for users who run vanilla launcher + Forge
  manually (rare — punt to docs: "use CurseForge or install Fabric instead")
- Mid-game live skin swap (skin applies on next bot spawn/respawn)
</domain>

<decisions>
## Implementation Decisions

### Approach: CustomSkinLoader client mod, NOT protocol injection
After substantive research and discussion (see RESEARCH.md §2, §5 and the
conversation log), four alternative approaches were ruled out:

| Approach | Why ruled out |
|---|---|
| Signed-texture property injection (mineskin.org / Mojang sessionserver) via mineflayer | Vanilla integrated server hardcodes `properties: []` for offline players. Verified in `node_modules/minecraft-protocol/src/server/login.js:184`. Works for plugin-aware servers only; doesn't help vanilla LAN. |
| prismarine-proxy in front of LAN | Host's own client uses Netty `LocalChannel` (in-process), not TCP. A TCP proxy cannot intercept the host's view. Solves friends' view only, not the host's. |
| Paper sidecar (Sei manages a Paper server + SkinsRestorer plugin) | Heavy: Java runtime, EULA, world import. Incompatible with Pixelmon (Bukkit-vs-Forge ecosystem mismatch). ~2-3 weeks of work. |
| Paid Microsoft account for the bot | Doesn't solve vanilla LAN either — integrated server is offline-mode regardless of bot auth. Adds cost ($30+/persona) and 30-day username cooldown. |

CustomSkinLoader wins because it overrides skin rendering on the host's
client itself — bypassing the LocalChannel/offline-mode constraint entirely.
The host's MC client looks up skins from Sei's local HTTP server instead of
Mojang's sessionserver.

### Skin source: bundled PNG + username search
Per-persona skin has two paths in the UI:
- **Upload:** user picks a 64×64 PNG file. Sei copies it into its user-data
  dir, references it from the persona record, serves it on the local HTTP
  endpoint.
- **Search:** user types a Minecraft username; Sei queries Mojang's public
  username→UUID→skin endpoints, downloads the PNG, treats it as a local file
  from that point on. No persistent dependency on Mojang's servers.

No mineskin.org. No signed-textures pipeline. Raw PNGs only — CustomSkinLoader
doesn't need signatures because it bypasses Mojang's skin verification.

### 3D preview on the character page
The character/persona page renders a 3D preview of the selected skin so the
user can see what the bot will actually look like in-game before committing.
Existing solutions (e.g., `skinview3d` npm package) can drop into the React
renderer with minimal integration.

### Custom username: any string
Bot username is a per-persona field stored as a plain string. Mineflayer
accepts any string in offline mode. CustomSkinLoader maps username → skin via
its config; Sei writes the config dynamically to match the persona's username.

### First-launch wizard scope
The wizard runs on Sei's first launch (and is re-runnable from settings). It:
1. Detects MC installations (vanilla launcher, CurseForge instances)
2. For each detected install, shows the user a "Enable Sei for this profile" option
3. For vanilla MC installs: downloads Fabric Loader installer from
   `meta.fabricmc.net`, runs it headlessly, drops CustomSkinLoader (Fabric build)
   into `mods/`, writes CustomSkinLoader config
4. For CurseForge instances (already Forge): drops CustomSkinLoader (Forge build)
   into the instance's `mods/` folder, writes config
5. Confirms setup. User opens MC normally and picks the "Fabric Loader" /
   their modded profile when launching.

The wizard is **idempotent**: re-running it detects existing installs and
shows their current setup state, lets the user re-install if mod versions
have drifted.

### Cross-platform paths
- macOS: `~/Library/Application Support/minecraft/` (vanilla), `~/Library/Application Support/curseforge/minecraft/Instances/` (CF)
- Windows: `%APPDATA%\.minecraft\` (vanilla), `%USERPROFILE%\curseforge\minecraft\Instances\` (CF; can also be `Documents\curseforge\...` depending on version)
- All path handling uses Node's `path` module — never string concatenation.
- Phase 8 (Windows compat) must complete first so we know the rest of Sei
  actually runs on Windows before adding more cross-platform surface area here.

### Skin serving: local HTTP, loopback only by default
Sei runs an HTTP server on `127.0.0.1:<port>` (Node's http module, no Express
needed). Serves `GET /skins/<username>.png` from per-persona PNG storage.
CustomSkinLoader config on the host's MC points at this URL. Default binding
is loopback-only — no firewall prompts, no LAN exposure. (Friends-can-see-it
scenario would bind to LAN interface; deferred to a later phase if requested.)

### Claude's Discretion
- Specific 3D preview library (skinview3d vs. building our own three.js component)
- CustomSkinLoader vs OfflineSkins — both work; CustomSkinLoader is more
  actively maintained as of late 2025
- Exact port number / port-selection strategy
- Wizard UI flow (single page vs multi-step)
- Whether to ship a "Sei default skin" baseline for all three bundled personas
- How to handle the user picking a non-Fabric profile when launching MC
  (notification on Sei side? warning when bot fails to look right?)
- Whether to set Fabric as default in `launcher_profiles.json` automatically
  or leave the user to select it manually each time
</decisions>

<specifics>
## Specific Ideas

- Three default personas already exist (commit e5ef2af). Each should ship with
  a bundled skin PNG under `resources/skins/<persona-id>.png` so first launch
  works without the user doing anything.
- CustomSkinLoader (https://github.com/xfl03/MCCustomSkinLoader) is the
  reference mod — Fabric + Forge builds available, configurable backend URLs.
- skinview3d (https://github.com/bs-community/skinview3d) is the canonical
  in-browser 3D skin preview library; ~50KB gzipped, MIT.
- Mojang public APIs (no key needed) for the username-search path:
  - `https://api.mojang.com/users/profiles/minecraft/<name>` → UUID
  - `https://sessionserver.mojang.com/session/minecraft/profile/<uuid>` → textures URL
  - Download the texture PNG from the URL embedded in `properties[0].value`
    (base64-decoded JSON)
</specifics>

<canonical_refs>
## Canonical References

- `RESEARCH.md` (this directory) — full research output. Includes why other
  approaches don't work. Read first when planning.
- `src/bot/adapter/minecraft/connect.js` — bot connection; small change here
  to ensure persona.username is honored
- `src/main/botSupervisor.ts` — orchestrates persona expansion; new
  setup-wizard IPC endpoints live in main process
- `src/bot/adapter/minecraft/lanDiscovery.js` — already-existing LAN port
  auto-discovery; no changes expected
- Phase 8 (Windows compat) artifacts when complete — the wizard inherits any
  cross-platform helpers/patterns Phase 8 establishes
- CustomSkinLoader project: https://github.com/xfl03/MCCustomSkinLoader
- Fabric meta API: https://meta.fabricmc.net/ (installer JAR download)
- Modrinth API: https://docs.modrinth.com/ (CustomSkinLoader JAR download via signed source)
</canonical_refs>

<conversation_path>
## How we got here (for future archaeologists)

This phase was preceded by a multi-turn discussion that explored and ruled out
four approaches before landing on CustomSkinLoader. The full reasoning is in
RESEARCH.md, but the short version:

1. Initial assumption: signed-texture injection via mineflayer. Research showed
   vanilla integrated server strips properties.
2. Pivoted to prismarine-proxy. Discovered the LocalChannel issue — host's
   own view bypasses TCP.
3. Considered Paper sidecar. Heavy and Pixelmon-incompatible.
4. Considered paid Mojang account. Doesn't solve LAN either; adds cost +
   username cooldown.
5. Landed on CustomSkinLoader: attacks the gap on the host's *rendering*
   layer rather than the protocol or server side. Mod-loader install is the
   one-time cost, which Sei automates via the setup wizard.

The user's framing of the desired UX — "download Sei, open MC, summon bot,
bot joins" — drove the wizard scope. The wizard is the trade for not having
to manage a server.
</conversation_path>
