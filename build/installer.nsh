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
;   Never in silent mode. electron-updater runs the installer with /S when an
;   update is applied on app quit (autoInstallOnAppQuit), and a UAC prompt
;   after the user closed Sei would come out of nowhere. A silent run leaves
;   the marker unset, so the one attempt happens on the next non-silent run:
;   the in-app "restart to update" (quitAndInstall() without isSilent, the
;   one-click banner is on screen) or a manual install from sei.gg.
;
; The registry keys are the same ones the old installer wrote: APP_GUID is
; derived from the appId (com.sei.app, LOCKED), not from the installer mode.

!define SEI_MIGRATION_KEY "Software\Sei\Installer"

!macro customInstall
  Push $R6
  Push $R7
  Push $R8
  Push $R9

  ReadRegStr $R8 HKLM "${UNINSTALL_REGISTRY_KEY}" UninstallString
  ReadRegStr $R9 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  ReadRegStr $R6 HKCU "${SEI_MIGRATION_KEY}" LegacyAllUsersCleanupTried
  ${if} $R8 != ""
  ${andIf} $R9 != ""
  ${andIf} $R9 != $INSTDIR
    ${if} $R6 != ""
      DetailPrint `An earlier all-users install is still in $R9. Removal was already tried once; it can be uninstalled from Apps & features.`
    ${elseIf} ${Silent}
      DetailPrint `An earlier all-users install is in $R9. Silent run, so its removal waits for the next interactive install.`
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
!macroend
