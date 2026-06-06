---
name: 260517-frz-CONTEXT
quick_id: 260517-frz
description: Give bots custom skins in offline play without buying a second Mojang account
gathered: 2026-05-17
status: Ready for planning
---

# Quick Task 260517-frz: Bot custom skins (offline play) — Context

**Gathered:** 2026-05-17
**Status:** Ready for planning

<domain>
## Task Boundary

Give Sei bots a visible custom skin when connecting in offline mode. Currently
the bot shows "some sort of default NPC skin" (per the user — not steve and not
alex), which strongly suggests the LAN host's client cannot resolve the bot's
offline UUID against Mojang's session server. Solve this **without requiring a
second purchased Mojang account** for the bot.

Out of scope:
- Online-mode (Microsoft auth) flow — auth: 'offline' only
- Mid-session skin hot-swap UI (skins applied at bot connect; persona edit
  takes effect on next spawn)
- Skins for the human owner; this is bot-only
</domain>

<decisions>
## Implementation Decisions

### Server type — both vanilla LAN and modded
The skin solution **must work against vanilla "Open to LAN"**, which has no
plugin support. That eliminates server-side approaches (SkinsRestorer plugin,
LuckPerms hooks, etc.) as the *primary* path. If the bot also happens to be
connecting to a Paper/Spigot server, the solution should still work — but the
implementation must not *depend* on plugins.

Implication for research: prioritize client-side approaches that survive on
vanilla LAN — primarily **signed-texture profile-property injection** during
the mineflayer login handshake (mineskin.org-style flow).

### Skin source — custom PNG preferred, username lookup as fallback
- **Primary:** the user supplies a 64×64 PNG per persona (bundled or
  user-provided). The app signs the PNG once via a third-party signing
  service (mineskin.org or similar) and caches the signed `value` +
  `signature` blob alongside the persona.
- **Fallback:** if no PNG is provided, look up an existing public Mojang
  username's skin (e.g., the bot's display username) and cache its signed
  texture. This gives "free" personas a real-looking skin without requiring
  art assets.

The persona's runtime skin field stores the signed texture blob, not the raw
PNG, so the bot can re-inject on every reconnect without re-hitting the
signing service.

### Persistence — per persona, in persona.json
Skin lives on the persona record (skin source + cached signed-texture blob).
This means:
- The renderer's persona editor needs a skin upload/URL/username input
- The persona-expansion main-process step needs a skin-resolve step that
  hits the signing service if signed-texture cache is missing or stale
- The bot, on connect, reads the persona's cached signed-texture and injects
  it into the mineflayer client's profile properties before login completes
- Sharing/exporting a persona ships the cached skin with it (the signed blob
  is plain text, safe to embed)

### Research focus — confirm what the "default NPC skin" actually is
User reports the rendered fallback is **not** steve and **not** alex. This
contradicts standard vanilla offline behavior (which always falls back to
steve/alex based on UUID parity). Possible explanations to verify:
- A LAN client mod is intercepting and substituting (OptiFine? Iris?)
- Resource pack on the host is overriding the player model
- A specific Minecraft version handles offline UUIDs differently (1.19.3+
  signature changes)
- The user is describing the steve skin under unusual lighting or a custom
  model and mislabeling it
Confirming the actual fallback informs whether texture injection will
*visibly replace it* — if a resource pack is forcing a model, the bot's skin
properties may be ignored regardless.

### Claude's Discretion
- Choice of signing service (mineskin.org is the canonical one but research
  agent should survey alternatives and call out ToS / rate-limit constraints)
- Exact persona.json schema field names for the skin sub-object
- Renderer UI affordance shape (file picker vs URL input vs both)
- Caching strategy for signed-texture blobs (TTL, invalidation, error
  handling when signing service is offline)
- Whether to ship a default "Sei" custom skin as a baseline
</decisions>

<specifics>
## Specific Ideas

- Three default personas already exist (per commit e5ef2af "ship 3 default
  personas"). They should get bundled custom skins as part of this work so the
  feature is visible out-of-the-box.
- mineskin.org has a documented JSON API: POST a PNG (or URL), receive back
  `{ value, signature }` — these are the two strings injected into the
  mineflayer client's `profileProperties[0]`.
</specifics>

<canonical_refs>
## Canonical References

- `src/bot/adapter/minecraft/connect.js` — single entry point that wraps
  `mineflayer.createBot`; skin injection hooks live here (or in a sibling
  module called from here)
- `src/main/botSupervisor.ts` — orchestrates persona expansion → bot start;
  may need an additional "resolve skin" step in the expansion phase
- `.planning/quick/260516-x62-*` — recent personas commit, shows the persona
  schema/IPC shape the skin field will piggyback on
- mineflayer issue tracker / `node-minecraft-protocol` docs — for the
  exact protocol-property injection API surface
</canonical_refs>
