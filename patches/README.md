# Dependency patches (patch-package)

`scripts/postinstall.mjs` runs `patch-package --error-on-fail` on every `npm install` / `npm ci`,
so local dev, CI, the packaged app and the Minecraft game pack all get these edits. If a dep is
bumped and a patch stops applying, the install fails on purpose.

## Minecraft 26.2 and 26.3 (added 2026-09-26)

No npm release of the Minecraft stack supports 26.2 or 26.3 yet. These patches backport the
upstream work onto the versions pinned in `package-lock.json`:

| Patch | 26.2 source | 26.3 source |
|---|---|---|
| `minecraft-data+3.114.0` | PrismarineJS/minecraft-data #1298 (merged into branch `pc_26_2` @ 68ea7b59, not released). Only the `pc/26.2` data, `pc/1.20.3/windows.json`, and the `dataPaths.json` / `versions.json` entries; `proto` points at `pc/26.2` instead of `pc/latest`. | minecraft-data #1300 / #1301 (DallasCarraher `pc-26.3-support` @ 924e26d, unmerged): `pc/26.3` data, protocolVersions entry (777), features `clientTickEndPacket` and `playerActionHasChangeDestroyDirection` (both `26.3`+ only). `data.js` regenerated with `bin/generate_data.js`. |
| `minecraft-protocol+1.68.0` | `supportedVersions` += `26.2` (node-minecraft-protocol #1496) | nmp #1538 (`entityDelta` type), `supportedVersions` += `26.3` |
| `mineflayer+4.38.0` | `testedVersions` += `26.2` (mineflayer #4121) | #4125 (teleport_confirm echoes position), #4128 (tick_end every client tick, gated on `clientTickEndPacket`), #4144 (stepped entity movement), #4146 (shifted player-action ids). All gated on a feature flag or packet shape, so older versions keep their old code path. |
| `prismarine-chunk+1.41.0` | `26.2` chunk implementation (prismarine-chunk #333) | #334 (26.3 light masks), `26.3` chunk implementation |
| `prismarine-physics+1.11.1` | `26.2` in `proportionalLiquidGravity` / `climbUsingJump` (prismarine-physics #143) | same for `26.3` |

Live-verified against vanilla 26.1, 26.2, 26.3 and 1.21.1 servers with
`scripts/mc-version-smoke.mjs` (spawn, chat, pathfinding, dig, inventory, craft, place, follow).

### Moving back to releases

Once minecraft-data, minecraft-protocol, mineflayer, prismarine-chunk and prismarine-physics
publish versions listing 26.2 and 26.3, bump them in `packs/minecraft/package.json`, delete the
matching `*.patch` files here, run `npm install`, and re-run the smoke script against a 26.2 and
a 26.3 server. `patch-package` can be dropped from devDependencies when this folder is empty.

### Related: wizard profile cap

The bot joins 26.2 / 26.3, but the setup wizard still builds its Fabric + CustomSkinLoader profile
for 26.1 (`WIZARD_MAX_MC` in `src/shared/mcSetup.ts`): no CustomSkinLoader build lists 26.3 yet,
and 26.2 only has the 15.x line. Raise the cap separately, after testing a CSL build in game.
