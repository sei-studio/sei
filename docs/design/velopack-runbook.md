# Velopack on Windows: release and incident runbook

Windows Sei moves from the NSIS installer + electron-updater to Velopack
starting with v0.7.0. macOS stays on electron-updater. Through v0.7.x both
exist side by side:

- the NSIS installer (`Sei-win-x64.exe`) is still the download on sei.gg and
  the electron-updater feed on GitHub Releases;
- every Windows release also carries Velopack files, mirrored to
  `https://dl.sei.gg/velopack/` (R2 bucket `sei-dl`, prefix `velopack`);
- NSIS installs move themselves to Velopack only when
  `migration.<channel>.json` says so (none do by default).

Channels: `win` (stable) and `beta`. Code: `src/main/velopack*.ts`,
`scripts/velopack-*.mjs`, `scripts/lib/velopack*.mjs`. Workflows:
`release.yml` (pack, verify, smoke), `mirror-release.yml` (R2),
`velopack-rollout.yml` (rollout and migration switches),
`velopack-update.yml` (the Windows CI scenarios).

## Before the first Velopack release (once)

1. **Get the workflows onto `main`.** `mirror-release.yml` (with its
   separate `velopack` job) and `velopack-rollout.yml` only exist on `dev` and
   this branch. GitHub only lets you dispatch a workflow it knows from the
   default branch, and `velopack-rollout.yml` has never run, so today the kill
   switch below cannot even be started. Cherry-pick to `main`:
   `.github/workflows/mirror-release.yml`, `.github/workflows/velopack-rollout.yml`,
   `scripts/velopack-mirror.mjs`, `scripts/velopack-rollout.mjs` and
   `scripts/lib/velopack{Feed,Mirror,Rollout,Store}.mjs` (both workflows
   check out their scripts from the ref they run on). Then confirm
   `gh workflow list` shows "Velopack rollout", and run one dry run of each:
   `gh workflow run velopack-rollout.yml -f channel=beta -f kind=migration -f percent=0`
   (dry_run defaults to true).
2. **Signing.** Set the `WIN_PUBLISHER_NAME` repo variable ONLY together with
   working Azure Trusted Signing (all `AZURE_*`). The build bakes it into the
   app as `SEI_WIN_PUBLISHER` (`electron.vite.config.ts`), and from then on
   that build refuses any Velopack package or migration Setup whose
   `Sei.exe`/`Squirrel.exe`/Setup is not Authenticode `Valid` and signed by
   that publisher (same rule as electron-updater: a plain name must equal the
   certificate CN, a DN must match every part it names). An unsigned build
   bakes nothing and skips the check. release.yml fails a signed build whose
   bundle lacks the publisher.

## Releasing

Follow the normal release steps in the workspace CLAUDE.md (bump, tag, watch
`release.yml`, publish the draft). What is different:

1. `release.yml` on Windows packs the app with vpk (`velopack` step), checks
   the Setup and each Full package's `Sei.exe` / `Squirrel.exe` signatures
   with the client's publisher rule (`velopack_verify`), installs the Setup on
   the runner and launches it once (`velopack_smoke`: Velopack boot + main
   window within 180 s). Only when all three pass do the Velopack files join
   the release. On a real release any of them failing is a warning, and the
   release ships WITHOUT Velopack files (NSIS keeps working); the job summary
   says so. Do not publish a release that should carry Velopack files when it
   does not: fix and re-tag.
2. **Asset count for "publish the draft".** Before Velopack the full draft
   had 18 assets (the partial duplicate about 10). Velopack adds per channel
   the Full package, a Delta package when the feed had an earlier version,
   the Setup (`Sei-win-Setup.exe` or `Sei-beta-Setup.exe`),
   `releases.<channel>.json` and `setup.<channel>.json`:
   - a beta: +4 (first Velopack beta, no delta) or +5, so 22 or 23;
   - a stable: the `win` channel's 4-5 plus the `beta` channel's 4-5 (unless
     beta is already at or past it), up to +10, so up to 28.
   The `Collect release assets` log prints "Velopack files: N" and the job
   summary carries the same line. Publish the draft whose count is 18 + N.
3. Publishing the release runs `mirror-release.yml`: the `mirror` job writes
   the electron-updater mirror (`updates/`), then the `velopack` job merges
   the Velopack files into `velopack/` (packages first, then the channel
   index, then `setup.<channel>.json`). Check that both jobs succeeded:
   `gh run list --workflow mirror-release.yml -L 3`.
4. **Re-dispatch a cancelled Velopack mirror.** The `velopack` job sits in a
   concurrency group shared with `velopack-rollout.yml`. GitHub keeps one
   running and ONE waiting run per group; a third one cancels the waiting
   one. So two publishes close together, or a rollout change during a
   mirror, can leave a release out of the Velopack feed (its `velopack` job
   shows "cancelled"). Re-run it:
   `gh workflow run mirror-release.yml -f tag=vX.Y.Z -f dry_run=false`
   (`velopack_only` defaults to true, so the electron-updater mirror is not
   touched; re-mirroring an older tag into `updates/` would roll that feed
   back). Every Velopack write is idempotent, so re-running is always safe.
5. **Staged rollout of an update.** Without a rollout file every Velopack
   install takes the new version. To stage it:
   `gh workflow run velopack-rollout.yml -f channel=win -f kind=update -f version=X.Y.Z -f percent=10 -f dry_run=false`,
   then raise the percent. Clients cache the file for 60 s. A client that
   cannot read the rollout file (network, 5xx, a file that is not a rule)
   holds the update for that check; a 404 means no rule (everyone). The
   GitHub fallback feed (used when `dl.sei.gg/velopack` itself fails) has no
   rule of its own: an update found there is offered only when dl.sei.gg
   answers for its rollout file.
6. **Migration (NSIS to Velopack).** Off until `migration.<channel>.json`
   exists:
   `gh workflow run velopack-rollout.yml -f channel=beta -f kind=migration -f percent=5 -f dry_run=false`.
   NSIS installs in the first N% of buckets download the newest
   `setup.<channel>.json` Setup, check its sha256 AND its signature, install
   it, and hand over. Three failed tries per epoch and an install stops
   trying; `-f epoch=<n+1>` gives them three more.

## Staged rollout (electron-updater)

This gates the NSIS Windows installs and every Mac, i.e. every 0.6.x client
(Velopack installs use step 5 above instead). electron-updater 6.8.3 reads
`stagingPercentage` from the release's `latest.yml` / `latest-mac.yml` and
offers the update only to devices whose bucket (from the UUID in
`<userData>/.updaterId`) is below that percent. No field = everyone, `0` =
nobody. `.github/workflows/rollout.yml` writes the field on the GitHub release
and on the mirror's flat `updates/*.yml` copies of the same version
(`scripts/set-staging.mjs`); every other byte of the ymls stays as built.
`dry_run` defaults to true: the first run of any change prints the before and
after values and the diff, untick it (`-f dry_run=false`) to write.

Default for a stable, 20 -> 50 -> 100:

1. After `release.yml`, delete the stray partial draft (rollout refuses a tag
   with two releases), then stage the DRAFT so no client ever sees it at
   100%: `gh workflow run rollout.yml -f tag=vX.Y.Z -f percent=20 -f dry_run=false`.
2. Publish the draft. `mirror-release.yml` copies the ymls, field included,
   to dl.sei.gg (it also keeps a same-version value the mirror already has).
   The run summary of each rollout run lists what both feeds now say.
3. After about a day with nothing bad in crash reports or support:
   `gh workflow run rollout.yml -f tag=vX.Y.Z -f percent=50 -f dry_run=false`.
4. Then everyone: `gh workflow run rollout.yml -f tag=vX.Y.Z -f action=promote -f dry_run=false`.

Notes:
- Prerelease tags are refused unless `-f force=true`: betas go to everyone.
- A device's bucket never changes, so raising the percent only adds devices.
- Not staged: new downloads from sei.gg, and Velopack installs.
- A stable publish also writes the mirror's `beta*.yml` names, and beta
  clients on GitHub read the stable's own `latest*.yml`, so beta-channel users
  below the stable are staged with it.
- `gh release upload --clobber` deletes the old asset before uploading the new
  one. A client that checks in that second finds no feed and reports no update.
- rollout.yml and mirror-release.yml run from `main` (dispatch and the
  `release: published` trigger both use the default branch). Keep
  `.github/workflows/rollout.yml`, `.github/workflows/mirror-release.yml`,
  `scripts/set-staging.mjs` and `scripts/lib/stagingYml.mjs` there in step
  with dev.

**Rollback = pause, then roll forward.** `gh workflow run rollout.yml -f tag=vX.Y.Z -f action=pause -f dry_run=false`
stops new installs taking the version (stagingPercentage 0) within one update
check. Installs that already have it, or already downloaded it for the next
quit, keep it: electron-updater does not downgrade. Ship the fix as the next
patch (X.Y.Z+1), staged or at 100%, and the bad installs update to it.

## The kill switch (three parts)

A bad version can reach users three ways, so stopping it takes three moves.
Do all three, in this order:

1. **Velopack update rollout to 0** (stops Velopack installs updating to it):
   `gh workflow run velopack-rollout.yml -f channel=<win|beta> -f kind=update -f version=X.Y.Z -f percent=0 -f dry_run=false`.
   For a stable, also do `channel=beta` if the stable went to beta too.
2. **electron-updater rollout to 0** (stops NSIS installs and Macs updating
   to it, on GitHub and the R2 mirror in one run):
   `gh workflow run rollout.yml -f tag=vX.Y.Z -f action=pause -f dry_run=false`
   (see "Staged rollout" above). If that cannot run, the old way: the GitHub
   release back to draft (`gh release edit vX.Y.Z --draft=true`, which also
   stops the GitHub fallback feed), and re-mirror the previous good tag into
   `updates/`
   (`gh workflow run mirror-release.yml -f tag=<previous> -f dry_run=false -f velopack_only=false`).
3. **Migration to 0** (stops NSIS installs migrating, because the migration
   always installs the newest `setup.<channel>.json`, which cannot move
   backwards):
   `gh workflow run velopack-rollout.yml -f channel=<win|beta> -f kind=migration -f percent=0 -f dry_run=false`.

Each takes effect within about a minute (client cache). Installs that already
took the version keep it.

## Rollback means roll forward

There is no downgrade. Velopack only moves forward, `setup.<channel>.json`
never moves backwards, and electron-updater does not downgrade either. To
undo a bad version: kill it (above), fix, ship X.Y.(Z+1), and open the
rollout for that. Installs on the bad version update to the fix like any
other update, provided the bad version can still start and check for
updates. If it cannot, see below.

## A broken Velopack copy: the user's way out

If a Velopack install cannot start or update:

1. **Install the newest NSIS build from sei.gg.** It writes its shortcuts
   over the Velopack ones and Sei retargets the taskbar pin. An NSIS build
   NEWER than the Velopack copy (`current\sq.version`) never hands off to it
   (`nsis-newer`), and the Velopack copy's cleanup never uninstalls an NSIS
   copy newer than itself (`keep-newer`). App data (`%APPDATA%\Sei`) is
   shared, so nothing is lost.
2. **Or uninstall the Velopack copy:** Settings > Apps > Installed apps >
   "Sei" > Uninstall (the Velopack entry; its folder is `%LOCALAPPDATA%\Sei`
   with `Update.exe` and `current\`). Then install NSIS from sei.gg.
   The uninstall removes that folder only (Sei registers no uninstall hook),
   so app data in `%APPDATA%\Sei` stays. Not yet run in CI.

Set migration to 0 first, or the NSIS copy may migrate again once its bucket
is sampled.

## CI that covers this

`velopack-update.yml` runs on pushes to `dev` and `feat/velopack-windows`
that touch the updater code (and on dispatch):

- **scenarios** (Velopack 0.6.90 to 0.6.91 on a clean runner): restart,
  restart-defender-off, restart-norec, restart-unstaged, rollback-swap1,
  rollback-swap2, launch-during-apply, quit, next-launch, low-disk, rollout,
  sig-reject, sig-accept, restart-spawn-fail, session-end (header of
  `scripts/velopack-ci/scenario.ps1`);
- **migrate** (a real older NSIS release to Velopack): peruser-default,
  peruser-custom, peruser-unicode (`C:\游戏\Sei 测试`), permachine,
  setup-killed, sig-reject, nsis-newer (`scripts/velopack-ci/migrate.ps1`);
- **authenticode**: the client's signature check against signed, unsigned,
  tampered, someone-else-signed and decoy files and packages, in a folder and
  TEMP with Chinese characters, plus the real CI package as built and
  re-signed (`scripts/velopack-ci/authenticode.ps1`).

Positive signature cases use a throwaway certificate trusted only on the
runner (`testsign.ps1`). The real Azure certificate has not been through the
in-app check end to end: the first signed release is that test. Watch its
`velopack_verify` and `velopack_smoke` steps.

`release.yml` with `-f dry_run=true` runs the Windows leg unsigned, packs
against the live feed, smoke-launches it, and dry-runs the mirror (prints
every write, makes none).
