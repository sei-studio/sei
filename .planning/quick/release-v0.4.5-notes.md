# Sei v0.4.5

## Changelog

- Crash diagnostics: when a summon fails, the app now sends an automatic redacted error report so we can find and fix the problem. No chat content or personal data is included, and you can opt out with the usage analytics toggle in Settings.
- Clear guidance when a summon fails: if your world is not open to LAN, or your Minecraft version is not supported, you now get a popup with step-by-step instructions and a Try again button instead of a one-line status.
- Crash notice: if a companion disconnects unexpectedly, a popup now tells you what happened instead of the companion silently vanishing.
- Voice picker: choose a voice while creating or editing a companion, with instant voice samples for every pool voice. Samples are bundled, so they play offline and without signing in.
- The usage analytics toggle in Settings now reflects your real saved setting, and accepting the updated privacy policy re-enables analytics.
- Privacy policy updated, effective 2026-07-20, to disclose crash diagnostics.
- Old log files are now cleaned up on startup.
- The awaken button is hidden while your party is full, since a fifth companion cannot be created.

## Release checklist

1. Merge the sei-website branch `privacy-diagnostics` into `main` and deploy. The updated privacy.html MUST be live with or before the app release.
2. Bump sei-website `version.json` and the site version label per the release ritual.
3. Run the dist builds: mac arm64 + x64, and Windows via the usual path.
4. Publish the GitHub release with these notes.
5. Verify the auto-updater picks up the release from a running older build.
6. Build the PostHog insight: `summon_failed` broken down by `summon_phase` x `error_class`.
7. Rebase `feat/v0.5-games` onto the release commit.
