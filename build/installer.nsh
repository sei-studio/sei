; build/installer.nsh: electron-builder NSIS include (nsis.include).
;
; 260929 one-click installer migration.
;
; Until v0.6.5 Sei shipped electron-builder's ASSISTED installer. Its
; install-mode page offered "Anyone who uses this computer (all users)", which
; installs PER-MACHINE: Program Files, keys under HKLM. The one-click installer
; that replaced it is per-user only (perMachine: false). It upgrades a per-user
; install in place, including one the user put in a custom folder (multiUser.nsh
; reuses HKCU "Software\<APP_GUID>" InstallLocation), but it never reads HKLM.
; Without this hook, an upgrade from a per-machine install would leave a second
; Sei in Program Files and a second entry in Apps & features.
;
; So after the per-user install has landed, look for that per-machine copy and
; run ITS uninstaller, silently, the same way electron-builder's own
; uninstallOldVersion does it (copy the uninstaller out first, run it with
; _?=<dir>). /allusers makes the old assisted uninstaller elevate itself, so a
; per-machine user sees ONE admin prompt, once. --updated plus /KEEP_APP_DATA
; guarantee it never deletes app data; userData is %APPDATA%\Sei for both
; install modes anyway, so the user's characters, settings and session stay.
; If the prompt is declined the old copy stays (the new one still works).
;
; The old uninstaller elevates, so every attempt is a UAC prompt. Two limits
; keep that prompt from nagging (260929 review):
;
;   Try once per Windows user. Before the attempt we write
;   HKCU "Software\Sei\Installer" LegacyAllUsersCleanupTried=1, and we skip
;   when it is already set. A declined prompt therefore never comes back on
;   later updates. The marker lives in its own key on purpose: the per-user
;   uninstaller that every update runs first (uninstallOldVersion) deletes
;   HKCU "Software\<APP_GUID>", so a value there would be wiped each time.
;
;   Never on the update-on-quit run. electron-updater runs the installer with
;   `--updated /S` when an update is applied on app quit
;   (autoInstallOnAppQuit), and a UAC prompt after the user closed Sei would
;   come out of nowhere. That run leaves the marker unset, so the one attempt
;   happens on the next run the user started on purpose:
;     - the in-app "Update Sei" restart. Since 261030 it runs under Sei's
;       own progress window, silent (`--updated /S --force-run`, see
;       src/main/windowsUpdateInstall.ts), or, when that window cannot start,
;       with the stock one-click banner (`--updated --force-run`). Either way
;       `--force-run` is what tells it apart from the quit run: the user just
;       clicked, and Sei reopens after. The admin prompt appears over it.
;     - a manual install from sei.gg (not silent).
;   So: silent AND no --force-run means skip.
;
; The registry keys are the same ones the old installer wrote: APP_GUID is
; derived from the appId (com.sei.app, LOCKED), not from the installer mode.

; 261030: no "verifying installer: N%" dialog. NSIS shows it while it CRCs a
; large installer (Sei's is about 220 MB, 1-2 s), even under /S, so it popped up
; in the middle of the screen during the silent in-app update, the one run that
; must show only Sei's progress window (measured on windows-latest by
; nsis-upgrade-check.yml progress-upgrade). The check is redundant for every
; signed build: electron-updater verifies the update's sha512 and Authenticode
; signature before running it, and Windows checks the signature, which covers
; the whole file, before a downloaded installer runs.
CRCCheck off

!define SEI_MIGRATION_KEY "Software\Sei\Installer"
; FileFunc (GetParameters / GetOptions) is already included by electron-builder's
; multiUser.nsh; including it again is harmless (it is include-guarded).
!include FileFunc.nsh

!macro customInstall
  Push $R5
  Push $R6
  Push $R7
  Push $R8
  Push $R9

  ; $R5 = "1" when this run should stay hands-off (the update-on-quit run).
  StrCpy $R5 ""
  ${if} ${Silent}
    ${GetParameters} $R7
    ClearErrors
    ${GetOptions} $R7 "--force-run" $R8
    ${if} ${Errors}
      StrCpy $R5 "1"
    ${endIf}
    ClearErrors
  ${endIf}

  ReadRegStr $R8 HKLM "${UNINSTALL_REGISTRY_KEY}" UninstallString
  ReadRegStr $R9 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  ReadRegStr $R6 HKCU "${SEI_MIGRATION_KEY}" LegacyAllUsersCleanupTried
  ${if} $R8 != ""
  ${andIf} $R9 != ""
  ${andIf} $R9 != $INSTDIR
    ${if} $R6 != ""
      DetailPrint `An earlier all-users install is still in $R9. Removal was already tried once; it can be uninstalled from Apps & features.`
    ${elseIf} $R5 == "1"
      DetailPrint `An earlier all-users install is in $R9. Update-on-quit run, so its removal waits for an in-app restart or a manual install.`
    ${else}
      !insertmacro GetInQuotes $R7 "$R8"
      ${if} ${FileExists} "$R7"
        ; Mark first: whatever happens next (declined UAC, error, crash),
        ; this user is not asked again.
        WriteRegStr HKCU "${SEI_MIGRATION_KEY}" LegacyAllUsersCleanupTried "1"
        DetailPrint `Removing the earlier all-users install in $R9`
        CopyFiles /SILENT /FILESONLY "$R7" "$PLUGINSDIR\sei-allusers-uninstaller.exe"
        ClearErrors
        ExecWait '"$PLUGINSDIR\sei-allusers-uninstaller.exe" /S /KEEP_APP_DATA /allusers --updated _?=$R9' $R6
        ${if} ${Errors}
        ${orIf} $R6 != 0
          DetailPrint `The earlier all-users install was not removed (code $R6). It can be uninstalled from Apps & features.`
        ${endIf}
        ClearErrors
      ${endIf}
    ${endIf}
  ${endIf}

  Pop $R9
  Pop $R8
  Pop $R7
  Pop $R6
  Pop $R5
!macroend
