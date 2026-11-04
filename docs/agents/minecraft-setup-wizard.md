# Minecraft setup wizard: the target version (260916)

> Superseded in part by the games branch (260916, same day): the wizard now builds
> ONE "Sei <version>" profile PER version with a picker in the setup list, and
> readiness is per profile (`sei_ready_versions`). The version rule below
> (newest supported, never last-played) still holds; see "Minecraft's setup
> step, and the detection bug" in the Game adapters section for the current shape.

The skin-setup wizard builds a "Sei" Fabric profile in the vanilla launcher,
and **the version it builds it for is the newest one in minecraft-protocol's
`supportedVersions`**, never the launcher's last-played version
(`selectTargetMcVersion` in `src/shared/mcSetup.ts`, the only place the rule
lives; `src/shared/minecraft-protocol-version.d.ts` types the CJS table for
main and renderer alike). It used to take the last-played version with a
pinned 1.21.4 fallback only when that was unreadable, so once Minecraft 26.2
shipped (June 2026) any machine that had played it got a Sei profile the bot
could not join, and the version-not-supported popup pointed the player at the
profile Sei had just made for them. Measured on the 260914 support case (a
new user who spent 30 minutes on it and gave up), and on 6 of the 13 users
who tried a summon that week. CurseForge instances keep their own version:
they carry their own loader and cannot be moved. The scanner now reports
every Fabric profile's version (`McInstall.fabric_mc_versions`) so readiness
means Fabric for a JOINABLE version plus the skin mod, not "Fabric exists".
When the protocol bump lands, the wizard follows it with no change here.

Two more things from the same case, since they are why he never got in:

- **The Anthropic key is required only when Anthropic is the provider.** The
  bot's `ConfigSchema` used to refine the `anthropic` sub-object alone
  ("api_key required unless cloudMode"), which cannot see `llm.provider`, so
  the one keyless provider (Ollama) shipped an empty key and died on config
  validation before pinging the world, on every summon and every Minecraft
  version. Every other provider passed by accident (its vendor key was copied
  into `anthropic.api_key`). Now a top-level `superRefine`, pinned in
  `src/bot/llmInit.test.js` with the production shape (empty key). If a
  provider ever goes quiet at fork time, check this first.
- **"I've been here before" + a login with no account resumes the scene.**
  Google sign-in creates the account on the spot, so the returning branch used
  to complete a brand-new player as returning: no config written, no name, no
  companion, and the first summon refused with "your name is missing".
  260917: the route is decided by whether the profile HAS A NAME
  (`accountHasProfile` reads `preferred_name` off `sei.getConfig()`; main
  backfills it from the cloud profile before the scope flips, and only the
  app's own setup ever writes that column), so a veteran on a second machine
  reads as onboarded and a minutes-old Google sign-in does not. The two age
  heuristics (`signedIntoFreshAccount` under 10 minutes, `signedIntoExistingAccount`
  over 48 h) survive only as the fallback when that read fails. A returning
  login with no profile sends the scene
  to the `no-account` phase: Sui walks back in, says so, and re-asks the
  new-here question. The boot sign-in variant has no scene to resume and
  replays the full one. A password sign-in cannot tell "no account" from
  "wrong password" (same server error), so that panel names the way out.
