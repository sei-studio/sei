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
; If the prompt is declined the old copy stays (the new one still works) and
; the next update tries again.
;
; The registry keys are the same ones the old installer wrote: APP_GUID is
; derived from the appId (com.sei.app, LOCKED), not from the installer mode.

!macro customInstall
  Push $R6
  Push $R7
  Push $R8
  Push $R9

  ReadRegStr $R8 HKLM "${UNINSTALL_REGISTRY_KEY}" UninstallString
  ReadRegStr $R9 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${if} $R8 != ""
  ${andIf} $R9 != ""
  ${andIf} $R9 != $INSTDIR
    !insertmacro GetInQuotes $R7 "$R8"
    ${if} ${FileExists} "$R7"
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

  Pop $R9
  Pop $R8
  Pop $R7
  Pop $R6
!macroend
