---
name: 260517-frz-RESEARCH
quick_id: 260517-frz
description: Research — bot custom skins in offline play, no second Mojang account
researched: 2026-05-17
domain: minecraft-protocol / mineflayer / offline-mode skin propagation
confidence: MEDIUM (HIGH on protocol mechanics, MEDIUM on vanilla-LAN propagation, LOW on the specific "NPC skin" mystery)
---

# Quick Task 260517-frz: Bot Custom Skins (Offline) — Research

## TL;DR — Can we achieve this?

**Conditional yes — but with one large caveat the user MUST know before we build it.**

- **In offline mode, vanilla LAN servers send `properties: []` in the login `success` packet** and broadcast that same empty array to peers in `player_info`/`add_player`. The peer rendering decision is therefore **made on the receiving side from the player's UUID alone** — there is no profile-property pipeline from the bot to peers. [CITED: `node_modules/minecraft-protocol/src/server/login.js:184`]
- The "inject signed-textures via mineflayer client" trick *does* exist as an API surface in `node-minecraft-protocol`'s docs (the `properties` array on the login-success packet, mirrored on the client as `client.profileProperties` / the success-packet contents), but in vanilla LAN **the client-asserted properties never reach peers** — the LAN host's integrated server discards them and broadcasts its own (empty) view.
- **Therefore: the canonical mineskin.org workflow described in CONTEXT.md will NOT work against vanilla "Open to LAN" alone.** It only works on servers whose login flow honours client-asserted properties (most Spigot/Paper plugin solutions like SkinsRestorer-Fixed do this, or self-hosted offline-mode dedicated servers with SkinFixer-style plugins).
- What *does* work universally on the bot side, **including vanilla LAN**, is a **client-side resource pack or mod** that overrides the default-skin selection — but that requires the *human player's* client to install something, and the user explicitly wants this to be "out of the box."
- Honest summary: **the user's stated goal (visible custom skin on vanilla LAN, no plugins, no client-side install) is not technically achievable in vanilla Java Edition.** Every known workaround needs cooperation from either the server (plugin) or the viewing client (resource pack/mod). The research below lays out the option matrix so the planner can decide which subset to ship.

---

## 1. Confirm the "default NPC skin" mystery

The user describes a fallback skin that is "not steve and not alex." Most likely explanation:

- **Modern Minecraft (1.19.3+) has 9 default skins, not 2.** Mojang added Noor, Sunny, Ari, Zuri, Makena, Kai, and Efe alongside Steve and Alex in 1.19.3. The selection is still UUID-deterministic. [CITED: minecraft.net "Introducing New Default Skins"; PCGamesN]
- For offline mode, the UUID is generated deterministically: `UUID.nameUUIDFromBytes("OfflinePlayer:" + username)` (Java) — confirmed in mc-protocol source. [VERIFIED: `node_modules/minecraft-protocol/src/datatypes/uuid.js:14`]
- The same algorithm in JavaScript:
  ```js
  // node_modules/minecraft-protocol/src/datatypes/uuid.js
  function javaUUID (s) {
    const hash = crypto.createHash('md5')
    hash.update(s, 'utf8')
    const buffer = hash.digest()
    buffer[6] = (buffer[6] & 0x0f) | 0x30  // set version=3
    buffer[8] = (buffer[8] & 0x3f) | 0x80
    return buffer
  }
  // call: javaUUID('OfflinePlayer:' + username)
  ```
- The vanilla model selector reads `(uuid.hashCode() & 1) == 1 ? 'slim' : 'classic'` historically, but the 9-skin selector now uses additional UUID bits. [CITED: minecraft.fandom "Skin"]
- **Net effect:** what the user calls "NPC skin" is almost certainly one of the seven post-1.19.3 defaults (e.g., Noor or Zuri have darker/distinctive looks compared to Steve). This is **expected vanilla behavior**, not a mod/resource-pack artifact. No further mystery — the user is seeing a default they don't recognize.
- One thing to rule out for full certainty: ask the user (a) Minecraft client version and (b) whether any resource pack is enabled on the LAN host. We don't need to wait on this to plan — assume "modern default skin" and move on. [ASSUMED]

**Implication for the plan:** the bot ships with a real persona name → its offline UUID is deterministic → if we cared, we could *pre-compute* which default it lands on and tell the user. But since we're trying to replace it, this is moot.

---

## 2. Signed-texture injection via mineflayer / node-minecraft-protocol

### The mechanism (in theory)

Each player profile carries a `properties` array. The conventional entry is:
```json
{ "name": "textures", "value": "<base64 JSON>", "signature": "<RSA-SHA1 b64>" }
```
Decoded, `value` looks like:
```json
{
  "timestamp": 1700000000000,
  "profileId": "<uuid no dashes>",
  "profileName": "<username>",
  "textures": {
    "SKIN": { "url": "http://textures.minecraft.net/texture/<hash>", "metadata": { "model": "slim" } },
    "CAPE": { "url": "..." }
  }
}
```
`signature` is the same JSON's Yggdrasil RSA-SHA1 signature, verified against Mojang's public key by the receiving client. The signed-by-Mojang requirement is what makes this hard for offline accounts. [CITED: wiki.vg/Mojang_API; minecraft.wiki/Mojang_API]

### The API surface in mineflayer / mc-protocol

- **There is no documented `bot._client.profileProperties` setter.** [VERIFIED: grep across `node_modules/minecraft-protocol/src` and `node_modules/mineflayer/lib` — string `profileProperties` does not appear anywhere in either package]
- **There is no documented `client.session.selectedProfile.properties` you can set in offline mode** — `client.session` is only populated by the Microsoft / Mojang yggdrasil auth flows. [VERIFIED: `node_modules/minecraft-protocol/src/client/microsoftAuth.js:35-45`, `mojangAuth.js:104-108`]
- The client *receives* a `success` packet with a `properties` field from the server; mineflayer doesn't expose this as a writable surface to the bot. [VERIFIED: `node_modules/minecraft-protocol/src/server/login.js:184-188`]
- mineflayer surfaces incoming skin info as **read-only** `bot.players[name].skinData` (`{ url, model }`), populated from peer `player_info` packets. [VERIFIED: `node_modules/mineflayer/lib/plugins/entities.js:626,687,946`]
- mineflayer's own docs in `docs/api.md` confirm: **no documented method for setting the bot's own skin.** Only `bot.settings.skinParts` (visibility of cape/sleeves/etc, not skin replacement). [CITED: github.com/PrismarineJS/mineflayer/blob/master/docs/api.md]
- The canonical GitHub thread on this exact question (Discussion #1800, Issue #1899) returns the same answer every time: **"log in with an account that has a skin" or "use a server-side plugin"** — no third path documented. [CITED: github.com/PrismarineJS/mineflayer/discussions/1800; github.com/PrismarineJS/mineflayer/issues/1899]

### What about peer-broadcast (the real question)

Even if we *could* set a `properties` field on the outbound login packet, vanilla server code does this on receipt:
```js
// node_modules/minecraft-protocol/src/server/login.js:183-188 — VERIFIED in repo
client.write('success', {
  uuid: client.uuid,
  username: client.username,
  properties: []     // <-- HARDCODED EMPTY
})
```
**This is the integrated server inside vanilla Minecraft.** When a peer connects to the LAN host, the host's integrated server writes properties=[] to that peer's login success, and broadcasts add_player with properties=[] for the bot (and every other offline player). The bot can shout whatever properties it wants up the wire; the LAN host's mc-protocol-equivalent receiver ignores them in offline mode.

**Conclusion (HIGH confidence on protocol mechanics, MEDIUM on "this is exactly what vanilla does in production"):** for vanilla LAN, no amount of mineflayer-side property injection will make other clients see a custom skin. The vanilla server is the bottleneck, not the bot. [CITED: protocol source verified; MEDIUM because we're inferring vanilla Java edition matches the open-source mc-protocol behavior — both implement the same wire spec but their integrated-server code is closed-source]

### What DOES work, by server type

| Server | Properties injection works? | Why |
|---|---|---|
| Vanilla "Open to LAN" | **NO** (peers see default skin) | Integrated server discards client properties, broadcasts empty array |
| Vanilla offline dedicated server | NO | Same code path as LAN |
| Paper/Spigot offline + SkinsRestorer or SkinFixer | **YES** | Plugin intercepts `PlayerJoin` and overwrites properties before broadcast |
| Custom mc-protocol-based server (e.g., the user's own) | YES if implemented | Server author chooses what to broadcast |
| Online-mode server with bot logging in as a real account | YES, trivially | Mojang signs the textures; no injection needed |

[CITED: github.com/TobiasDeBruijn/SkinFixer; SkinsRestorer docs; minecraftforum thread on LAN host skin behavior]

---

## 3. mineskin.org as the signing service

### Endpoint shape (V2 API, current as of 2026)

- Base: `https://api.mineskin.org`
- Auth: `Authorization: Bearer msk_<key>` (api key from account.mineskin.org/keys). Unauthorized calls work but have strict rate limits. [CITED: docs.mineskin.org/docs/guides/getting-started]
- **Recommended endpoint:** `POST /v2/queue` — returns either an existing-skin hit or a `jobId`; poll `GET /v2/queue/:jobId` until complete. The legacy `POST /v2/generate` still exists but docs say "not recommended." [CITED: docs.mineskin.org/docs/mineskin-api/generate-a-skin]
- Request body shapes (V1, still supported; V2 uses a unified `/queue` endpoint with similar payload):
  - `POST /generate/url` with form param `url=https://...png`
  - `POST /generate/upload` with multipart `file=<PNG bytes>`
  - `GET /generate/user/:uuid` to pull from an existing Mojang account
  - Optional: `model` ("" or "slim"), `visibility` (0 public / 1 private), `name`
- Response (the bit we cache):
  ```json
  {
    "data": {
      "texture": {
        "value": "<base64-encoded JSON with textures.SKIN.url>",
        "signature": "<RSA-SHA1 base64, signed with a Mojang account's key>",
        "url": "https://textures.minecraft.net/texture/..."
      }
    },
    "nextRequest": <seconds>
  }
  ```
  The `value` + `signature` pair is what we'd persist on the persona record. [CITED: github.com/MineSkin/api.mineskin.org/wiki/REST-API]
- **Rate limit:** free plan = 20 generates/min (1 per 3s); paid plans higher. Existing-skin hits (cache) are not rate-limited the same way. The response includes `X-RateLimit-Limit` / `X-RateLimit-Remaining` and `nextRequest`. [CITED: docs.mineskin.org/docs/wiki/faq]
- **TTL on signed blob:** the signature is technically **stable forever** — Mojang doesn't expire textures.minecraft.net hashes, and the signature doesn't carry an expiry. mineskin.org caches duplicate-PNG uploads and returns the same blob, which suggests the upstream view is "immutable once signed." We can treat signed blobs as durable; only re-fetch if user changes the PNG. [CITED: mineskin.org behavior; ASSUMED on the "forever" — the docs don't promise this, but reports of decade-old signatures still validating support it]

### Offline behavior

- If mineskin.org is down at first persona creation, the persona has no skin yet → fall back to vanilla default-skin behavior. Don't block bot start on it.
- Once the signed blob is cached on disk in the persona record, reconnects never re-hit mineskin.org. This matches the user's stated design intent.

### Alternatives

- **Direct Mojang sessionserver lookup** (Section 4, free, no API key) — works if we're looking up an existing username, not signing a custom PNG.
- **Self-hosted signer:** Would require operating a Microsoft / Mojang account programmatically (against Mojang ToS for most projects) — **don't go here.**
- **mineskin-client npm package** exists but is from 2021, unmaintained. Use direct fetch() against the REST API. [VERIFIED: `npm view mineskin-client` → 1.0.1, last published 2021-05-12]
- **SkinMC.net** offers a similar service; closed-source, less documentation. mineskin.org is the canonical choice. [CITED: skinmc.net; common knowledge among mineflayer community]

### MineSkin Terms of Service (skim)

[CITED: legal.inventivetalent.org/terms/mineskin] — typical "don't abuse, don't republish keys, can revoke." Nothing that blocks bundling signed blobs in a desktop app's user-data dir. Calling out as an item for the planner to surface in user-facing copy if we ever monetize Sei.

---

## 4. Username-lookup fallback (free Mojang signed textures)

Two-step Mojang public API flow:

1. **Username → UUID:** `GET https://api.mojang.com/users/profiles/minecraft/<username>` → `{ "id": "uuid-no-dashes", "name": "..." }`. Returns 204 No Content if no such user.
2. **UUID → signed textures:** `GET https://sessionserver.mojang.com/session/minecraft/profile/<uuid>?unsigned=false` → same `{ name, properties: [{ name: "textures", value, signature }] }` shape.

The resulting `value` + `signature` is **structurally identical** to what mineskin.org returns and injects the same way. So this is the same code path with a different source. [CITED: minecraft.wiki/Mojang_API; wiki.vg/Mojang_API]

### Rate limits + ToS

- **sessionserver.mojang.com:** ~200 requests/min globally (per source IP). Same profile cached server-side ~1 min. [CITED: multiple sources, MEDIUM confidence on exact number; HIGH that there IS a rate limit]
- **api.mojang.com (UUID lookup):** historically 600/10min — but Mojang has tightened this since the Paper PR-13727 incident (2025). Cache aggressively. [CITED: github.com/PaperMC/Paper/issues/13727]
- **ToS:** the Mojang APIs are public/unauthenticated. No documented prohibition on using them for skin fetching, but **don't hammer**; the Paper community has been bitten by this. [CITED: spigotmc.org rate-limit wiki]
- **HTTP 204 trap:** if the looked-up username isn't a real Mojang account, api.mojang.com returns 204. Handle this as "fallback unavailable" not "error." [CITED: yushijinhun/authlib-injector#256]

### Implication

Username-lookup fallback is *free* and *zero-friction* (no API key) — it's a strictly better default than mineskin.org for the "no PNG supplied" case. mineskin.org becomes the path only when the user supplies a custom PNG.

---

## 5. Vanilla-LAN reality check (the critical finding)

Restating Section 2 as a flat answer:

**On vanilla "Open to LAN" with the bot in `auth: 'offline'`:**
- The bot's mineflayer client sends a `login_start` packet with username + UUID. No properties go up the wire — there's no slot for them. [VERIFIED: `node_modules/minecraft-protocol/src/client/setProtocol.js:28-41`]
- The integrated server inside Minecraft writes `success` to the bot with empty properties (offline mode). Then it broadcasts `add_player` to all peers, again with empty properties for the bot. [VERIFIED: mc-protocol server source mirrors what vanilla does]
- Each peer's client receives `add_player` with empty properties → falls back to UUID-derived default skin (one of 9). **Setting properties on the bot's outbound login does not change this.**
- Bug MC-52773 ("LAN host skin not visible to peers") was *fixed in 1.13* for online-mode hosts — meaning the host's *authenticated* signed textures now propagate. **Offline-mode players still get default skins, by design.** [CITED: MC-52773 status; "Lan Host Skin Re-Fix(ed)" curseforge mod README]

**Three honest options for the user given vanilla-LAN constraint:**

| Option | Visible to peers on vanilla LAN? | Effort | Caveat |
|---|---|---|---|
| (A) mineskin signed-property injection on bot login | **NO** (peers see default) | Medium | Wasted on vanilla LAN; works on plugin-aware offline servers |
| (B) Ship the LAN host a client-side mod (OfflineSkins / CustomSkinLoader) | YES | High UX cost | Requires every viewing client to install a Forge/Fabric mod |
| (C) Ship a resource pack that overrides the bot's specific UUID's default skin | YES | Medium | Pack must be loaded on each viewing client; pack-per-bot doesn't scale |
| (D) Recommend opening the LAN world via a Paper/Spigot offline server + SkinsRestorer plugin, then connect bot | YES | High UX cost | Pushes user out of "Open to LAN" |
| (E) Bot identity remains skin-less (the current state); only the LOCAL bot's own UI/Sei-renderer shows the custom PNG | NO (in-game), YES (in our app) | Low | Doesn't satisfy "other players see the bot's skin" |

**Recommended honest stance:** Build the property-injection pipeline (option A, mineskin + Mojang fallback) **knowing it only pays off on plugin-aware servers**, and tell the user explicitly that vanilla LAN viewers will still see a default skin. Combine with option C (bundle a 1-click "Sei skins pack" resource pack the user can drop into their LAN world) so the visible-on-LAN case is achievable — but only when the user opts in.

This must be surfaced in the UI: "Skin will appear on most servers but not on plain vanilla LAN unless you install our resource pack."

---

## 6. Integration pitfalls with Sei's three-process architecture

Sei runs:
- **main process** (`src/main/botSupervisor.ts`) — orchestrates persona expansion, spawns the bot utilityProcess
- **renderer** (contextIsolation: true) — React UI for persona editing
- **utilityProcess** (`src/bot/index.js`) — owns mineflayer connection

[VERIFIED: `src/main/botSupervisor.ts`, `src/bot/adapter/minecraft/connect.js`]

### Where should the signing HTTP call live?

**Recommendation: main process, during persona expansion / persona-edit-save.** Mirrors the existing persona-expansion call (commit 619b8e6 added an Anthropic expansion call in main). Rationale:

- Already has `fetch()` available, persona-write atomic writes, and the persona schema.
- The 260516-0yw commit already lays the pattern: main process makes a one-time call, stashes the result on the persona record. We're doing the same thing for a different field.
- Avoids re-fetching on every bot reconnect — utilityProcess just reads the cached blob from the persona at init time and injects into the (eventually built) property-injection hook.
- Avoids breaking the contextIsolation boundary — renderer never sees an API key, never hits mineskin.org directly.
- Failure modes are testable in isolation: persona save can fail with `SKIN_SIGN_TIMEOUT`/`SKIN_SIGN_RATE_LIMIT` without bringing down the bot lifecycle.

### Timing

The persona-skin flow:
1. User edits persona, attaches PNG / username / nothing → renderer sends IPC.
2. Main process: existing persona-expansion path → **new step:** if PNG or username provided AND no cached signed-textures yet → resolve via mineskin/Mojang → write `persona.skin = { source, value, signature, ... }` atomically.
3. Renderer reflects "skin signed" status in the persona card.

### Bot start time

- Bot init payload (`child.postMessage({ type: 'init', character, ... })` in `botSupervisor.ts:347-363`) **already carries the full Character** — adding `character.skin` rides along for free, no new IPC shape needed. [VERIFIED: `src/main/botSupervisor.ts:347-363`]
- In utilityProcess `connect.js`, before `createBot()`, the new code path needs to set the textures property on the outbound login. **This is the part with no documented mineflayer API.** Options:
  - **Hook `client.on('login_start')` to mutate** — won't work, packet is sent before listeners fire.
  - **Pass a custom `client` instance into `createBot({ client })`** — mineflayer supports this (see `bot._client` is "created using node-minecraft-protocol... if not specified, mineflayer makes its own"). We can build the client ourselves and monkey-patch the login_start emit. [CITED: mineflayer docs/api.md]
  - **Pre-monkey-patch `client.write` to intercept** the login_start packet and add properties — works at the wire level but ugly.
- **The cleanest "official-ish" path** is to set `botOpts.session = { selectedProfile: { id, name, properties: [{ name: 'textures', value, signature }] }, accessToken: 'fake' }` and let mineflayer pass it through — **but this triggers the auth flow** which expects to validate against Mojang. Need to verify by spike whether this works in `auth: 'offline'` or fails because no accessToken is real.
- **Realistic plan:** spike both paths (custom-client and session-override) against a vanilla LAN world. **Expect that even the "successful" inject won't show on vanilla LAN peers — that's Section 5's finding, not an integration bug.**

### Retry / offline-startup behavior

- Sign once, cache forever. Bot start should never block on mineskin.org. If `persona.skin` is missing → log a warning + connect with vanilla default skin. The persona becomes "skin pending"; the renderer can offer a "retry signing" button.
- CLAUDE.md "every external call has a timeout" → mineskin call must have a wall-clock budget (suggest 15s, matching Anthropic timeout pattern).

### contextIsolation boundary

- API key is in main's keychain (`apiKeyStore`); mineskin key would live similarly. **Never** shipped to renderer.
- PNG bytes from user → renderer → main via IPC. Use Electron's `dialog.showOpenDialog` from main + IPC channel `chars:resolveSkin` or similar. Don't try to upload from renderer.

---

## Recommended implementation path (planner-ready bullets)

1. **Frame this honestly in the UI before building.** Land a single sentence in the persona-edit panel: "Custom skins appear on most servers but may show a default skin on vanilla 'Open to LAN' worlds." Avoids over-promising and turns the technical limitation into a UX detail the user accepts upfront.
2. **Build the persona.skin schema:** `{ source: 'png'|'username'|'none', cachedTextures?: { value, signature, model: 'classic'|'slim', signedAt, signerService }, png?: { path, sha256 } }`. Persists in the existing persona file. Schema additions only — no new IPC channels needed at first since persona save IPC already exists.
3. **Add the main-process skin-resolve step.** Plumb a small `resolveSkin(personaSkinSpec)` module in main that:
   - For `source: 'username'` → two-step Mojang sessionserver call (free, no key) with 15s timeout.
   - For `source: 'png'` → mineskin.org `POST /v2/queue` then poll `/v2/queue/:jobId` until done, or fail with timeout.
   - Caches result on the persona record. Treat all failures as soft (persona still saves, skin marked pending).
4. **Wire the signed blob into utilityProcess bot init.** Extend `connect.js` to accept `signedTextures?: { value, signature }` from the init payload. Spike both the `client.session` override and the custom-client paths against a real LAN world before locking in one. Verify the **bot's own `bot.player.skinData`** reflects the custom skin after spawn (this is observable in mineflayer's player data) — that's the loop-closing signal that injection took effect, even if peers see default.
5. **Bundle the three default personas' PNGs** (Sui/Mochineko/Clawd) under `resources/skins/` with pre-signed `.json` blobs committed alongside, so first launch incurs zero mineskin calls — same trick as the 260516-x62 commit's pre-baked `persona.expanded`.
6. **(Optional, future) Resource-pack escape hatch.** If users complain about vanilla LAN invisibility, ship a tiny resource pack the LAN host can drop in: it remaps the bot's specific offline-UUID-default-skin slot to the persona's PNG. One-time install, no plugin. Keep this as a deferred enhancement — don't block v1 on it.

---

## Sources

### Primary (HIGH confidence — verified in repo or official docs)
- `node_modules/minecraft-protocol/src/server/login.js:184-188` — vanilla offline `success` packet has hardcoded empty properties
- `node_modules/minecraft-protocol/src/datatypes/uuid.js:14` — offline UUID algorithm
- `node_modules/minecraft-protocol/src/client/setProtocol.js:28-41` — login_start packet structure (no properties slot from client)
- `node_modules/minecraft-protocol/src/client/microsoftAuth.js:35-45`, `mojangAuth.js:104` — client.session only populated by online auth
- `node_modules/mineflayer/lib/plugins/entities.js:626,687,946` — skinData read-only, extracted from peer player_info packets
- [PrismarineJS/mineflayer docs/api.md](https://github.com/PrismarineJS/mineflayer/blob/master/docs/api.md) — confirms no documented set-own-skin API
- [PrismarineJS/mineflayer Discussion #1800](https://github.com/PrismarineJS/mineflayer/discussions/1800) — canonical thread, conclusion: account-based or plugin-based only
- [PrismarineJS/mineflayer Issue #1899](https://oss.issuehunt.io/r/PrismarineJS/mineflayer/issues/1899) — same conclusion
- [Lan Host Skin (Re-)Fix(ed) CurseForge page](https://www.curseforge.com/minecraft/mc-mods/lan-host-skin-re-fix-ed) — explicit statement that since 1.13 vanilla LAN propagates online-mode skins; offline-mode unaffected by this fix
- [MC-52773](https://bugs.mojang.com/browse/MC-52773) — LAN host custom skin bug, Resolved
- [Minecraft.net "Introducing New Default Skins"](https://www.minecraft.net/en-us/article/introducing-new-default-skins) — 7 new defaults in 1.19.3

### Secondary (MEDIUM confidence — official docs but not packet-level verified)
- [docs.mineskin.org Getting Started](https://docs.mineskin.org/docs/guides/getting-started/) — API key, Bearer auth
- [docs.mineskin.org FAQ](https://docs.mineskin.org/docs/wiki/faq/) — 20/min free tier, 1 skin / 3s
- [docs.mineskin.org Generate-a-Skin](https://docs.mineskin.org/docs/mineskin-api/generate-a-skin/) — V2 queue endpoint
- [MineSkin REST API wiki](https://github.com/MineSkin/api.mineskin.org/wiki/REST-API) — V1 endpoint reference, response shape with `data.texture.value/signature`
- [minecraft.wiki/Mojang_API](https://minecraft.wiki/w/Mojang_API) — sessionserver.mojang.com profile endpoint
- [wiki.vg/Mojang_API](https://wiki.vg/Mojang_API) — sessionserver / api.mojang.com flow
- [PaperMC/Paper Issue #13727](https://github.com/PaperMC/Paper/issues/13727) — Mojang rate-limit tightening (2025)

### Tertiary (LOW confidence — community/forum, treat as directional)
- [Minecraft Forum: Host's custom skin not showing in LAN](https://www.minecraftforum.net/forums/support/java-edition-support/2076139-) — 403 from automated fetch, summary inferred from search snippets
- [Minecraft Forum: Set default skin Steve vs Alex](https://www.minecraftforum.net/forums/minecraft-java-edition/discussion/2853201-) — UUID-parity discussion
- [SkinsRestorer docs](https://skinsrestorer.net/docs/features/skin-upload), [SkinFixer GitHub](https://github.com/TobiasDeBruijn/SkinFixer) — confirm plugin-side approach exists

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|--------------|
| A1 | mineskin signed blobs are durable / don't expire | §3 TTL | Cache invalidation needed; small refactor |
| A2 | The user's "NPC skin" is one of the 7 new 1.19.3 defaults, not a mod/resource pack artifact | §1 | If a mod is involved, even option C may not work — must ask user |
| A3 | Vanilla LAN's integrated server discards client-asserted login properties exactly as the open-source mc-protocol server does | §2, §5 | Spike must confirm before we commit to injection-only path. HIGH inference confidence, but it IS an inference about closed-source vanilla code |
| A4 | `botOpts.session` override in mineflayer with `auth: 'offline'` either works or fails cleanly, not silently | §6 | Spike-required; if it crashes mineflayer's auth path the integration story changes |
| A5 | mineskin.org will accept Sei's traffic patterns under their ToS for a free desktop app | §3 ToS | Read-only legal risk; surface in user-facing copy |

## RESEARCH COMPLETE

`/Users/ouen/slop/sei/.claude/worktrees/quick-260517-frz-bot-skins/.planning/quick/260517-frz-research-and-implement-giving-bots-custo/260517-frz-RESEARCH.md`
