# Sei — Release Notes

## v0.2.0 — Custom bot skins + setup wizard

**New: per-persona custom skins and usernames.** Each character can now wear
a custom Minecraft skin and join your world under any in-game username. Two
skin sources:

- **Upload PNG:** drop a 64×64 PNG on the character page
- **Search Minecraft username:** look up any real Mojang account and use
  their current skin (legacy 64×32 skins are auto-upscaled to 64×64 — no
  Notch-skin edge case)

A 3D preview shows the skin before you apply it. Skin bytes stay on your
computer.

**New: first-launch setup wizard.** Sei detects your Minecraft installs
(vanilla launcher + CurseForge instances) and installs Fabric Loader +
CustomSkinLoader for you. Re-run from Settings → Minecraft skins setup.
Idempotent: re-running detects existing mods and only updates when needed.
The wizard uses Minecraft's own bundled Java runtime — you don't need to
install Java separately.

**Three default personas (Sui, Mochineko, Clawd)** ship with bundled
placeholder skins.

**Visibility caveat.** Custom skins are rendered client-side. Peers on
your LAN see the bot with a default Minecraft skin unless they also
install CustomSkinLoader. This is a vanilla Minecraft architecture
constraint, not a Sei limitation — full analysis in
`.planning/phases/09-implement-custom-bot-skins-via-customskinloader-mod-first-la/RESEARCH.md` §5.

**Windows notes.** Mod installation uses Minecraft's bundled Java runtime
(located automatically inside `%APPDATA%\.minecraft\runtime\` after you've
launched the vanilla profile at least once). The wizard writes to your
real Minecraft directory under `%APPDATA%\.minecraft` (vanilla) or
`%USERPROFILE%\curseforge\minecraft\Instances\` (CurseForge). Sei does
not modify `launcher_profiles.json` — you pick the Fabric profile from
the launcher dropdown each time you want to play with Sei.

### Implementation summary

- **Local HTTP skin server** at `http://127.0.0.1:<random-port>` (loopback
  only — no firewall prompts, no LAN exposure by default)
- **Port-drift detection** on bootstrap: if the OS picks a new port across
  launches, CSL configs are rewritten to stay in sync
- **Cross-platform install detection** for macOS, Windows, Linux (paths
  via Node's `path.join`, never string concatenation — Phase 8 row 1
  invariant)
- **Fabric installer** runs headless via
  `<bundled-java> -jar <installer> client -noprofile`
- **CustomSkinLoader** JAR sourced from Modrinth (with GitHub releases
  fallback); the config's `loadlist[0].type` is `Legacy`, NOT
  `CustomSkinAPI`. This was verified against upstream CSL Java source on
  branch 15-develop: `Legacy` takes a literal `{USERNAME}`-substituted
  URL template and treats the response as raw PNG bytes (which is what
  our skin server serves at `/skins/{USERNAME}.png`); `CustomSkinAPI`
  requires a JSON-returning endpoint at `{root}/{username}.json` followed
  by a second `{root}/textures/<id>` PNG fetch, which would not work
  against our server. The on-launch verifier (`npm run verify:phase9`)
  asserts the shipped loader type matches the wire-protocol-correct
  choice.
- **All external calls timeout-wrapped** per CLAUDE.md (15 s Mojang, 30 s
  meta, 60 s JAR download, 90 s `java -jar` exec)
- **Wizard cancel** crosses the IPC boundary (renderer →
  `sei.wizardCancel(sessionId)` → main aborts the
  `Map<sessionId, AbortController>` controller) so the in-flight Fabric
  installer child process is SIGTERM'd cleanly
- 4 verification harnesses + 1 master harness (`npm run verify:phase9`)
