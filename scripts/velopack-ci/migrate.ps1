# NSIS -> Velopack migration scenarios for .github/workflows/velopack-update.yml (261030).
#
# Runs ONE case on a clean windows-latest runner, end to end through the app's
# own migration code (src/main/velopackMigration.ts), the way a user gets it:
#   1. a real old NSIS release from GitHub (v0.6.10, or v0.6.4 /allusers for a
#      per-machine install), then this branch's 0.6.90 NSIS installer run the
#      way electron-updater runs it (--updated /S);
#   2. the CI-built feed served on 127.0.0.1 with migration.win.json written by
#      scripts/velopack-rollout.mjs (the same script velopack-rollout.yml runs);
#   3. the 0.6.90 NSIS app launched; it downloads the 0.6.91 Velopack Setup,
#      installs it beside itself, retargets the shortcuts, hands off, and the
#      Velopack copy removes the NSIS one.
#
#   peruser-default  default per-user folder; the app restarts into Velopack
#   peruser-custom   a folder the user picked (C:\Games\My Sei); first with the
#                    switch at 0% (nothing happens), then 100% with no restart:
#                    the user closes Sei and starts the OLD exe, which hands over
#   permachine       v0.6.4 "Anyone who uses this computer"; the per-user copy
#                    migrates, the per-machine leftover stays (HKLM, no UAC)
#   peruser-unicode  a folder with Chinese characters and a space
#                    (C:\游戏\Sei 测试), migrated like peruser-default
#   setup-killed     the Velopack Setup is killed mid-install: the NSIS copy
#                    keeps working, and the next launch migrates
#   sig-reject       the Setup is not signed by the publisher Sei expects: it
#                    is never run, and the NSIS copy keeps working
#   nsis-newer       after a full migration, an NSIS build newer than the
#                    Velopack copy is installed: it runs instead of handing
#                    off, and the Velopack copy leaves it alone
param(
  [Parameter(Mandatory = $true)][string]$Case,
  [string]$Feed = 'feed',
  [string]$Old = 'old',
  [string]$Out = 'out'
)
$ErrorActionPreference = 'Stop'

New-Item -ItemType Directory -Force -Path $Out | Out-Null
$Out = (Resolve-Path $Out).Path
$Feed = (Resolve-Path $Feed).Path
$Old = (Resolve-Path $Old).Path
$From = '0.6.90'
$Target = '0.6.91'
$root = Join-Path $env:LOCALAPPDATA 'Sei'
$userData = Join-Path $env:APPDATA 'Sei'
$marks = Join-Path $userData 'velopack-ci.jsonl'
$stateFile = Join-Path $userData 'velopack-migration.json'
$failures = [System.Collections.Generic.List[string]]::new()
$results = [ordered]@{ case = $Case }
# Shortcuts through IShellLinkW, the Unicode shell API Explorer and Electron's
# shell.readShortcutLink use. WScript.Shell goes through the ANSI code page and
# throws "Value does not fall within the expected range" on C:\游戏\Sei 测试.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;
public static class SeiCiLnk {
  [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellLinkW {
    void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszFile, int cch, IntPtr pfd, uint fFlags);
    void GetIDList(out IntPtr ppidl);
    void SetIDList(IntPtr pidl);
    void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszName, int cch);
    void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszDir, int cch);
    void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string pszDir);
    void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszArgs, int cch);
    void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string pszArgs);
    void GetHotkey(out short pwHotkey);
    void SetHotkey(short wHotkey);
    void GetShowCmd(out int piShowCmd);
    void SetShowCmd(int iShowCmd);
    void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszIconPath, int cch, out int piIcon);
    void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string pszIconPath, int iIcon);
    void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pszPathRel, uint dwReserved);
    void Resolve(IntPtr hwnd, uint fFlags);
    void SetPath([MarshalAs(UnmanagedType.LPWStr)] string pszFile);
  }
  [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
  class ShellLink { }
  public static void Write(string lnk, string target, string wd) {
    var l = (IShellLinkW)new ShellLink();
    l.SetPath(target);
    l.SetWorkingDirectory(wd);
    ((IPersistFile)l).Save(lnk, true);
  }
  // "" for a missing or unreadable shortcut, as WScript.Shell's TargetPath was.
  public static string Target(string lnk) {
    if (!System.IO.File.Exists(lnk)) return "";
    var l = (IShellLinkW)new ShellLink();
    ((IPersistFile)l).Load(lnk, 0);
    var sb = new StringBuilder(32768);
    l.GetPath(sb, sb.Capacity, IntPtr.Zero, 0);
    return sb.ToString();
  }
}
'@
$pinDir = Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar'
# C:\游戏\Sei 测试, spelled with char codes so the file's encoding cannot matter
$unicodeDir = 'C:\' + [char]0x6E38 + [char]0x620F + '\Sei ' + [char]0x6D4B + [char]0x8BD5
# A publisher the CI packages are not signed by (they are unsigned)
$wrongPublisher = 'CN=Sei CI Not The Signer'

function Fail([string]$m) { Write-Host "::error::${Case}: $m"; $failures.Add($m) }
function Now { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
function SeiProcs { @(Get-Process -Name 'Sei' -ErrorAction SilentlyContinue) }
function Stop-Sei { SeiProcs | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 2 }
function ProcPath($p) { try { $p.Path } catch { '' } }
function Under([string]$path, [string]$dir) { $path -and $path.StartsWith($dir.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) }

function Entries {
  foreach ($r in 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall') {
    if (Test-Path $r) {
      Get-ChildItem $r | ForEach-Object {
        $q = Get-ItemProperty $_.PSPath
        if ($q.DisplayName -like 'Sei*') { [pscustomobject]@{ Root = $r.Substring(0, 4); Key = $_.PSChildName; Name = $q.DisplayName; Version = $q.DisplayVersion; Uninstall = $q.UninstallString; Location = $q.InstallLocation } }
      }
    }
  }
}
$userLinkDirs = @([Environment]::GetFolderPath('Desktop'), (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'), $pinDir)
$commonLinkDirs = @([Environment]::GetFolderPath('CommonDesktopDirectory'), (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs'))
function Links([string[]]$dirs) {
  foreach ($d in $dirs) {
    Get-ChildItem -Path $d -Filter 'Sei*.lnk' -Recurse -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ Path = $_.FullName; Target = [SeiCiLnk]::Target($_.FullName) } }
  }
}
function State([string]$label) {
  Write-Host "===== $label ====="
  Write-Host (Entries | Format-Table -AutoSize | Out-String -Width 400)
  Write-Host (Links ($userLinkDirs + $commonLinkDirs) | Format-Table -AutoSize | Out-String -Width 400)
  Write-Host "  Sei processes: $((SeiProcs | ForEach-Object { "$($_.Id) $(ProcPath $_)" }) -join '; ')"
  if (Test-Path $stateFile) { Write-Host "  migration state: $((Get-Content $stateFile -Raw) -replace '\s+', ' ')" }
}

# ------------------------------------------------------------------ marks
# Read without locking the writer out: ReadAllLines opens with FileShare.Read,
# and the app's append landing in that window failed (a lost mark, 261030).
function Read-Shared([string]$file) {
  $fs = [System.IO.File]::Open($file, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]'ReadWrite, Delete')
  try { $sr = New-Object System.IO.StreamReader($fs); $sr.ReadToEnd() -split "`r?`n" } finally { $fs.Dispose() }
}
function Events {
  if (-not (Test-Path $marks)) { return @() }
  $lines = $null
  for ($i = 0; $i -lt 5 -and $null -eq $lines; $i++) { try { $lines = Read-Shared $marks } catch { Start-Sleep -Milliseconds 50 } }
  @($lines | Where-Object { $_.Trim() } | ForEach-Object { try { $_ | ConvertFrom-Json } catch { } })
}
function Mark([string]$ev, [scriptblock]$where = $null) {
  Events | Where-Object { $_.ev -eq $ev -and (-not $where -or (& $where $_)) } | Select-Object -First 1
}
function WaitMark([string]$ev, [int]$timeoutS, [scriptblock]$where = $null) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.Elapsed.TotalSeconds -lt $timeoutS) {
    $m = Mark $ev $where
    if ($m) { return $m }
    Start-Sleep -Milliseconds 200
  }
  $null
}
function Need([string]$ev, [int]$timeoutS, [scriptblock]$where = $null) {
  $m = WaitMark $ev $timeoutS $where
  if (-not $m) { Fail "no '$ev' mark within ${timeoutS}s"; Finish }
  $m
}
function Timeline {
  Write-Host '----- marks -----'
  $t0 = (Events | Select-Object -First 1).t
  foreach ($e in Events) {
    $extra = $e | Select-Object * -ExcludeProperty ev, t, pid, version | ConvertTo-Json -Compress -Depth 5
    Write-Host ('  {0,8} {1,-26} pid={2,-6} v={3} {4}' -f ($e.t - $t0), $e.ev, $e.pid, $e.version, $extra)
  }
}
function MigState { if (Test-Path $stateFile) { Get-Content $stateFile -Raw | ConvertFrom-Json } else { $null } }

function Finish {
  Stop-Sei
  if ($script:srv) { $script:srv | Stop-Process -Force -ErrorAction SilentlyContinue }
  Timeline
  State 'end'
  foreach ($n in 'velopack.log', 'updater.log', 'main.log') {
    $f = Join-Path $userData "logs\$n"
    if (Test-Path $f) { Write-Host "### $f"; Get-Content $f -Tail 120 | ForEach-Object { Write-Host $_ }; Copy-Item $f (Join-Path $Out "app-$n") -ErrorAction SilentlyContinue }
  }
  Get-ChildItem (Join-Path $env:LOCALAPPDATA 'velopack') -Filter '*.log' -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "### $($_.FullName)"; Get-Content $_.FullName -Tail 80 | ForEach-Object { Write-Host $_ }; Copy-Item $_.FullName $Out -ErrorAction SilentlyContinue }
  if (Test-Path $marks) { Copy-Item $marks (Join-Path $Out 'marks.jsonl') }
  if (Test-Path $stateFile) { Copy-Item $stateFile (Join-Path $Out 'velopack-migration.json') }
  $results.failures = @($failures)
  $results | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $Out 'result.json') -Encoding utf8
  if ($failures.Count -gt 0) { exit 1 }
  Write-Host "PASS: $Case"
  exit 0
}

# ------------------------------------------------------------------ 1. the NSIS install
$oldExe = Join-Path $Old 'Sei-win-x64.exe'
$instArgs = switch ($Case) { 'peruser-custom' { @('/S', '/D=C:\Games\My Sei') } 'peruser-unicode' { @('/S', "/D=$unicodeDir") } 'permachine' { @('/S', '/allusers') } default { @('/S') } }
$p = Start-Process -FilePath $oldExe -ArgumentList $instArgs -PassThru
if (-not $p.WaitForExit(300000)) { throw 'old NSIS install timed out' }
Stop-Sei
$first = @(Entries)
if ($first.Count -lt 1) { throw 'no NSIS uninstall entry after the old install' }
Write-Host "old install: $(($first | ForEach-Object { "$($_.Root) $($_.Key) $($_.Version) $($_.Location)" }) -join '; ')"
$oldDir = Split-Path -Parent ([regex]::Match($first[0].Uninstall, '^"([^"]+)"').Groups[1].Value)
$p = Start-Process -FilePath "$oldDir\Sei.exe" -PassThru; Start-Sleep -Seconds 20; Stop-Sei
New-Item -ItemType Directory -Force -Path $userData | Out-Null
$marker = Join-Path $userData 'migration-marker.txt'; $token = [guid]::NewGuid().ToString(); Set-Content $marker $token

# The update to this branch's NSIS build, as electron-updater runs it.
$p = Start-Process -FilePath (Join-Path $Feed "nsis\Sei-$From-nsis.exe") -ArgumentList @('--updated', '/S') -PassThru
if (-not $p.WaitForExit(300000)) { throw "$From NSIS install timed out" }
Start-Sleep -Seconds 3
Stop-Sei
$entry = @(Entries | Where-Object { $_.Root -eq 'HKCU' -and $_.Version -eq $From }) | Select-Object -First 1
if (-not $entry) { State 'after the NSIS update'; throw "no per-user $From NSIS entry" }
$nsisDir = Split-Path -Parent ([regex]::Match($entry.Uninstall, '^"([^"]+)"').Groups[1].Value)
$nsisExe = Join-Path $nsisDir 'Sei.exe'
$results.nsis_dir = $nsisDir
Write-Host "NSIS $From at $nsisDir (exe $((Get-Item $nsisExe).VersionInfo.ProductVersion))"
if ($Case -eq 'peruser-custom' -and $nsisDir -ne 'C:\Games\My Sei') { Fail "custom folder not kept: $nsisDir" }
if ($Case -eq 'peruser-unicode' -and $nsisDir -ne $unicodeDir) { Fail "Chinese folder not kept: $nsisDir" }
# A taskbar pin, as the file Explorer writes for one.
New-Item -ItemType Directory -Force -Path $pinDir | Out-Null
[SeiCiLnk]::Write((Join-Path $pinDir 'Sei.lnk'), $nsisExe, $nsisDir)
State "NSIS $From installed"

# ------------------------------------------------------------------ 2. the feed
$vp = Join-Path $Feed 'vp'
function Switch-Migration([int]$percent) {
  & node scripts/velopack-rollout.mjs --store "dir:$vp" --channel win --kind migration --percent $percent
  if ($LASTEXITCODE -ne 0) { throw 'velopack-rollout.mjs failed' }
}
$script:srv = Start-Process -FilePath python -ArgumentList '-m', 'http.server', '8765', '--bind', '127.0.0.1', '--directory', $vp -PassThru -WindowStyle Hidden
# Wait until it answers: a fixed sleep lost the race on a busy runner once
# (the client's first check was refused and the scenario never updated).
$up = $false
for ($i = 0; $i -lt 60 -and -not $up; $i++) {
  if ($script:srv.HasExited) { throw "the feed server exited ($($script:srv.ExitCode))" }
  try { $null = Invoke-WebRequest -Uri 'http://127.0.0.1:8765/' -UseBasicParsing -TimeoutSec 2; $up = $true } catch { Start-Sleep -Milliseconds 500 }
}
if (-not $up) { throw 'the feed server did not answer within 30s' }
Write-Host "setup.win.json: $((Get-Content (Join-Path $vp 'setup.win.json') -Raw) -replace '\s+', ' ')"

function Launch([string]$exe, [string]$action, [string]$publisher = '') {
  $env:SEI_VELOPACK_CI = '1'
  # Empty removes it: the CI build is unsigned, so the check is off by default.
  $env:SEI_VELOPACK_CI_PUBLISHER = $publisher
  $env:SEI_VELOPACK_CI_MODE = 'none'
  $env:SEI_MIGRATION_FEED = 'http://127.0.0.1:8765'
  $env:SEI_MIGRATION_DELAY_MS = '3000'
  $env:SEI_MIGRATION_CI_ACTION = $action
  $p = Start-Process -FilePath $exe -PassThru
  $null = $p.Handle
  $p
}
function Velopack-Boot([int]$timeoutS, [long]$after) {
  Need 'boot' $timeoutS ([scriptblock]::Create("param(`$e) `$e.velopackInstalled -and `$e.t -gt $after"))
}

# ------------------------------------------------------------------ 3. the migration
$t0 = Now
switch ($Case) {
  'peruser-custom' {
    Switch-Migration 0
    $p = Launch $nsisExe 'none'
    $c = Need 'migration-check' 60
    if ($c.decision.ok -or $c.decision.reason -ne 'disabled') { Fail "at 0% the check said $($c.decision | ConvertTo-Json -Compress)" }
    Stop-Sei
    if (Test-Path "$root\current\Sei.exe") { Fail 'a Velopack copy appeared at 0%' }
    Remove-Item $marks -Force

    Switch-Migration 100
    $p = Launch $nsisExe 'none'
    $c = Need 'migration-check' 60
    if (-not $c.decision.ok) { Fail "at 100% the check said $($c.decision | ConvertTo-Json -Compress)" }
    $inst = Need 'migration-installed' 300
    $results.install_ms = $inst.t - $c.t
    Start-Sleep -Seconds 2
    State 'installed, no restart'
    if ($p.HasExited) { Fail 'the NSIS copy exited after installing the Velopack copy' }
    if (@(SeiProcs | Where-Object { Under (ProcPath $_) $root }).Count -gt 0) { Fail 'a Velopack copy started without a restart' }
    $pinNow = [SeiCiLnk]::Target((Join-Path $pinDir 'Sei.lnk'))
    if (-not (Under $pinNow $root)) { Fail "the pin still points at $pinNow after the install" }
    # The user closes Sei.
    $null = $p.CloseMainWindow()
    if (-not $p.WaitForExit(30000)) { Write-Host 'Sei did not close on its window; stopping it'; Stop-Sei }
    $results.closed_exit_code = $p.ExitCode
    if (Test-Path "$root\packages\*.nupkg") { Write-Host "packages: $((Get-ChildItem "$root\packages").Name -join ', ')" }
    # ...and later starts the OLD exe (a shortcut Sei could not retarget).
    $tRedirect = Now
    $oldProc = Launch $nsisExe 'none'  # not $old: [string]$Old would coerce it
    $r = Need 'migration-redirect' 60
    if (-not $oldProc.WaitForExit(30000)) { Fail 'the NSIS launch did not exit after redirecting' }
    $b = Velopack-Boot 90 $tRedirect
    $results.redirect_to_boot_ms = $b.t - $r.t
  }
  'setup-killed' {
    Switch-Migration 100
    $p = Launch $nsisExe 'restart'
    $null = Need 'migration-check' 60
    $null = Need 'migration-installing' 300
    # The process can appear seconds after the mark: Defender scans the 300 MB
    # Setup before it starts (measured 3 s). Wait for it, then let it get into
    # the install (it takes about 30 s) before killing it.
    $killed = @()
    for ($i = 0; $i -lt 120 -and $killed.Count -eq 0; $i++) {
      if (Mark 'migration-installed') { break }
      $killed = @(Get-Process -Name 'sei-velopack-setup' -ErrorAction SilentlyContinue)
      if ($killed.Count -eq 0) { Start-Sleep -Milliseconds 250 }
    }
    if ($killed.Count -eq 0) { Fail 'the Setup never showed up, or finished before it could be killed' }
    Start-Sleep -Seconds 3
    $killed = @(Get-Process -Name 'sei-velopack-setup', 'Update' -ErrorAction SilentlyContinue)
    if ($killed.Count -eq 0) { Fail 'the Setup was already gone 3s into the install' }
    $killed | Stop-Process -Force -ErrorAction SilentlyContinue
    Write-Host "killed: $(($killed | ForEach-Object { "$($_.Name) $($_.Id)" }) -join ', ')"
    $f = Need 'migration-failed' 120
    Write-Host "failed mark: $($f | ConvertTo-Json -Compress)"
    Start-Sleep -Seconds 2
    if ($p.HasExited) { Fail 'the NSIS copy exited after the failed install' }
    if ((MigState).phase -ne 'failed') { Fail "state after the kill is $((MigState).phase)" }
    State 'after the killed Setup'
    if (Mark 'migration-installed') { Fail 'installed despite the kill' }
    Stop-Sei
    # The next launch tries again.
    $p = Launch $nsisExe 'restart'
    $c = Need 'migration-check' 60 { param($e) $e.decision.ok -and $e.decision.attempt -eq 2 }
    $null = Need 'migration-installed' 300
    $null = Velopack-Boot 90 $c.t
  }
  'sig-reject' {
    Switch-Migration 100
    $p = Launch $nsisExe 'restart' $wrongPublisher
    $c = Need 'migration-check' 60
    if (-not $c.decision.ok) { Fail "the check said $($c.decision | ConvertTo-Json -Compress)" }
    $sig = Need 'migration-signature' 300
    $results.signature = $sig
    if ($sig.ok) { Fail 'a Setup not signed by the expected publisher passed the check' }
    if ($sig.skipped) { Fail 'the signature check was skipped' }
    if (-not $sig.ok -and $sig.reason -notmatch 'NotSigned') { Fail "rejected for another reason: $($sig.reason)" }
    $f = Need 'migration-failed' 30
    $results.failed_error = $f.error
    if ($f.error -notlike 'setup signature:*') { Fail "failed for another reason: $($f.error)" }
    Start-Sleep -Seconds 5
    if (Mark 'migration-installing') { Fail 'the Setup was started despite the rejection' }
    if (@(Get-Process -Name 'sei-velopack-setup' -ErrorAction SilentlyContinue).Count -gt 0) { Fail 'the Setup is running' }
    if (Test-Path "$root\current\Sei.exe") { Fail 'a Velopack copy was installed' }
    if ($p.HasExited) { Fail 'the NSIS copy exited after the rejection' }
    if ((MigState).phase -ne 'failed') { Fail "state after the rejection is $((MigState).phase)" }
    $pinNow = [SeiCiLnk]::Target((Join-Path $pinDir 'Sei.lnk'))
    if ($pinNow -ne $nsisExe) { Fail "the pin was moved to $pinNow" }
    State 'after the rejected Setup'
    Finish
  }
  default {
    Switch-Migration 100
    $p = Launch $nsisExe 'restart'
    $c = Need 'migration-check' 60
    if (-not $c.decision.ok) { Fail "the check said $($c.decision | ConvertTo-Json -Compress)" }
    $inst = Need 'migration-installed' 300
    $results.install_ms = $inst.t - $c.t
    $rs = Need 'migration-restart' 30
    $b = Velopack-Boot 90 $rs.t
    $results.restart_to_boot_ms = $b.t - $rs.t
  }
}

# ------------------------------------------------------------------ 4. the clean-up and the end state
$done = Need 'migration-done' 240
$results.total_ms = $done.t - $t0
Start-Sleep -Seconds 2
State 'migrated'
$s = MigState
if ($s.phase -ne 'done') { Fail "final phase $($s.phase)" }
if (Test-Path $nsisExe) { Fail "the NSIS copy is still at $nsisDir" }
$results.nsis_dir_left = Test-Path $nsisDir
if (Test-Path $nsisDir) { Write-Host "left in ${nsisDir}: $((Get-ChildItem $nsisDir -Force -Recurse | Select-Object -First 10).FullName -join ', ')" }
$hkcu = @(Entries | Where-Object { $_.Root -eq 'HKCU' })
if ($hkcu.Count -ne 1 -or $hkcu[0].Key -ne 'Sei') { Fail "expected only the Velopack entry in HKCU, got: $(($hkcu | ForEach-Object { "$($_.Key) $($_.Version)" }) -join ', ')" }
$hklm = @(Entries | Where-Object { $_.Root -eq 'HKLM' })
if ($Case -eq 'permachine') { $results.hklm_leftover = @($hklm | ForEach-Object { "$($_.Key) $($_.Version) $($_.Location)" }) }
elseif ($hklm.Count -gt 0) { Fail "unexpected HKLM entries: $(($hklm | ForEach-Object { $_.Key }) -join ', ')" }
foreach ($l in @(Links $userLinkDirs)) { if (-not (Under $l.Target $root)) { Fail "shortcut $($l.Path) points at $($l.Target)" } }
if (@(Links @([Environment]::GetFolderPath('Desktop'))).Count -lt 1) { Fail 'no desktop shortcut after the migration' }
if ((Get-Content $marker -Raw).Trim() -ne $token) { Fail 'userData marker lost' }
$ver = ([xml](Get-Content "$root\current\sq.version")).package.metadata.version
$results.velopack_version = $ver
if ($ver -ne $Target) { Fail "Velopack copy is $ver, expected $Target" }

# The pinned shortcut starts the Velopack copy.
Stop-Sei
$tPin = Now
Start-Process -FilePath (Join-Path $pinDir 'Sei.lnk') | Out-Null
$b = Velopack-Boot 90 $tPin
$results.pin_boot = $b.pid
if (Mark 'migration-redirect' ([scriptblock]::Create("param(`$e) `$e.t -gt $tPin"))) { Fail 'the pin started the NSIS copy' }

# ------------------------------------------------------------------ 5. nsis-newer
if ($Case -eq 'nsis-newer') {
  Stop-Sei
  # CI has one NSIS build (0.6.90) and a Velopack copy at 0.6.91, so the
  # Velopack copy is made to report an older version: what the NSIS side reads
  # is current\sq.version. In the field: Velopack 0.7.0 broken, the player
  # installs NSIS 0.7.1 from the website.
  $sq = "$root\current\sq.version"
  $x = [xml](Get-Content $sq -Raw)
  $x.package.metadata.version = '0.6.80'
  $x.Save($sq)
  $p = Start-Process -FilePath (Join-Path $Feed "nsis\Sei-$From-nsis.exe") -ArgumentList @('/S') -PassThru
  if (-not $p.WaitForExit(300000)) { throw "the $From NSIS reinstall timed out" }
  Start-Sleep -Seconds 3
  Stop-Sei
  $e2 = @(Entries | Where-Object { $_.Root -eq 'HKCU' -and $_.Version -eq $From }) | Select-Object -First 1
  if (-not $e2) { State 'after the NSIS reinstall'; Fail "no $From NSIS entry after the reinstall"; Finish }
  $nsisDir2 = Split-Path -Parent ([regex]::Match($e2.Uninstall, '^"([^"]+)"').Groups[1].Value)
  $nsisExe2 = Join-Path $nsisDir2 'Sei.exe'
  $results.nsis_newer_dir = $nsisDir2
  State 'NSIS reinstalled over an older Velopack copy'
  $tNew = Now
  $p = Launch $nsisExe2 'restart'
  $nn = Need 'migration-nsis-newer' 60 ([scriptblock]::Create("param(`$e) `$e.t -gt $tNew"))
  $results.nsis_newer_seen = $nn.velopackVersion
  Start-Sleep -Seconds 15
  if ($p.HasExited) { Fail 'the newer NSIS copy exited (handed off?)' }
  if (Mark 'migration-redirect' ([scriptblock]::Create("param(`$e) `$e.t -gt $tNew"))) { Fail 'the newer NSIS copy handed off to the older Velopack copy' }
  if (Mark 'migration-installing' ([scriptblock]::Create("param(`$e) `$e.t -gt $tNew"))) { Fail 'the newer NSIS copy started a migration again' }
  if ((MigState).phase -ne 'failed') { Fail "state after nsis-newer is $((MigState).phase)" }
  $pinNow = [SeiCiLnk]::Target((Join-Path $pinDir 'Sei.lnk'))
  if ($pinNow -ne $nsisExe2) { Fail "the pin points at $pinNow, not the newer NSIS copy" }
  State 'newer NSIS copy running'
  Stop-Sei
  # The Velopack copy, started anyway, must leave the newer NSIS copy alone.
  $tVp = Now
  $v = Launch "$root\current\Sei.exe" 'none'
  $null = Velopack-Boot 90 $tVp
  $cc = WaitMark 'migration-cleanup-check' 60 ([scriptblock]::Create("param(`$e) `$e.t -gt $tVp"))
  $results.velopack_cleanup_decision = if ($cc) { $cc.decision } else { 'no check' }
  Start-Sleep -Seconds 15
  if (-not (Test-Path $nsisExe2)) { Fail 'the Velopack copy removed the newer NSIS copy' }
  if (Mark 'migration-done' ([scriptblock]::Create("param(`$e) `$e.t -gt $tVp"))) { Fail 'the Velopack copy marked the migration done over the newer NSIS copy' }
}
Finish
