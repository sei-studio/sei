/**
 * How an explicit "restart to update" hands off to the installer (261023,
 * made visible 261030, Sei's own progress window 261030).
 *
 * Pure (no electron import) so it unit-tests on any host; updater.ts spreads
 * the result into `autoUpdater.quitAndInstall(...)`. Both the sidebar "Update
 * Sei" button and the forced apply:'now' restart use it.
 *
 * Windows (NsisUpdater, electron-updater 6.8.3): BaseUpdater.quitAndInstall(
 * isSilent, isForceRunAfter) calls `install(isSilent, isSilent ?
 * isForceRunAfter : this.autoRunAppAfterInstall)`, and NsisUpdater.doInstall
 * builds `["--updated", "/S"?, "--force-run"?]`.
 *   - (true, true) = `--updated /S --force-run`: no installer window. From
 *     261023 to 261030 nothing else was on screen either. The install takes
 *     a median ~104 s for real users (IQR 77-173 s: the whole app is
 *     re-unpacked), so Sei vanished for a minute and a half and looked
 *     crashed; people relaunched it mid-install. Since 261030 it runs under
 *     Sei's own progress window (see `progressWindow` below).
 *   - (false, true), the fallback = `--updated --force-run` (isForceRunAfter
 *     is ignored when not silent; autoRunAppAfterInstall, pinned true in
 *     updater.ts, supplies the --force-run). The one-click installer shows
 *     its small SpiderBanner "Installing, please wait..." window with the
 *     Sei header icon, then reopens Sei. From app-builder-lib 26.16.1's NSIS
 *     templates:
 *       no clicks: oneClick.nsh has no pages but MUI_PAGE_INSTFILES (the
 *         license page is skipped when --updated, and Sei has none); the
 *         "Sei is running, click OK" box is skipped when --updated
 *         (_CHECK_APP_RUNNING goes straight to closing it).
 *       no UAC: perMachine: false compiles `RequestExecutionLevel user`.
 *       same folder: setInstallModePerUser reads HKCU Software\<APP_GUID>
 *         InstallLocation whether silent or not; no /D is passed.
 *       relaunch: installSection.nsh RUN_AFTER_FINISH runs doStartApp when
 *         `${ifNot} ${Silent} ${orIf} ${isForceRun}`.
 *     Message boxes remain only on failure paths (an app that cannot be
 *     closed, a failed old-version uninstall). Silent runs took the same
 *     failures with no word to the user (`/SD IDCANCEL` quits).
 *   build/installer.nsh's legacy per-machine cleanup treats this run as
 *   user-started (not silent), exactly as it treated `--force-run` before.
 *   The update-on-quit path (autoInstallOnAppQuit) stays `--updated /S` with
 *   no relaunch; electron-updater's quit handler does that, not this helper.
 *   .github/workflows/nsis-upgrade-check.yml exercises both.
 *
 * macOS (MacUpdater): quitAndInstall() takes no arguments; Squirrel.Mac swaps
 * the bundle and relaunches because autoRunAppAfterInstall defaults to true.
 * Linux is not shipped; the defaults are fine there.
 */
export type QuitAndInstallArgs = [] | [isSilent: boolean, isForceRunAfter: boolean];

/**
 * `progressWindow` (Windows): Sei's own update window is up
 * (updateProgressHelper.ts, a PowerShell/WPF process running from %TEMP%).
 * Then the installer runs SILENT, `--updated /S --force-run` (true, true), so
 * the stock NSIS banner does not show on top of it, and the window covers the
 * whole install until the new Sei is back. When that window could not start
 * (blocked PowerShell, a slow machine, anything), it stays the visible
 * (false, true) run above: the stock banner, exactly as before.
 */
export function restartInstallArgs(
  platform: NodeJS.Platform,
  opts: { progressWindow?: boolean } = {},
): QuitAndInstallArgs {
  if (platform === 'win32') return opts.progressWindow ? [true, true] : [false, true];
  return [];
}
