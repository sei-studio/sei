# Windows update scenarios for .github/workflows/velopack-update.yml (261030).
#
# Runs ONE scenario on a clean windows-latest runner: installs Sei 0.6.90 from
# the CI-built Velopack Setup.exe, serves 0.6.91 from a local feed, drives the
# app through the CI harness in src/main/updater.ts + velopackUpdater.ts
# (SEI_VELOPACK_CI=1: marks in <userData>\velopack-ci.jsonl, a trigger file in
# place of the "Update Sei" click), and records what the user would see.
#
#   restart            in-app restart, staged copy, Defender real-time protection on
#   restart-defender-off   the same with Defender real-time protection off
#   restart-norec      the same without video, to size the recording's overhead
#   restart-unstaged   in-app restart without a staged copy (stock extraction)
#   rollback-swap1     a file in current\ is held open: the first rename fails
#   rollback-swap2     a file in the staged copy is held open: the second rename
#                      fails and upstream's rollback restores current\
#   launch-during-apply  Sei started by the user while an update-on-quit applies
#   quit               update on quit (no relaunch)
#   next-launch        downloaded + staged, Sei killed; the next launch applies
#   low-disk           too little disk to stage: skipped, the restart still works
#   rollout            rollout.win.json holds the version back, then releases it
#   sig-reject         Sei expects a publisher the package is not signed by: the
#                      download is thrown away and never offered; with the check
#                      off (an unsigned build) the same package installs
#   sig-accept         the package re-signed with a certificate this runner
#                      trusts (testsign.ps1): checked, accepted, applied
#   restart-spawn-fail Update.exe cannot be started at the restart: Sei stays
#                      open with its windows back, and the next launch applies
#   session-end        Windows ends the session (WM_QUERYENDSESSION and
#                      WM_ENDSESSION sent to Sei's windows): the quit does not
#                      start an apply, and the next launch applies
param(
  [Parameter(Mandatory = $true)][string]$Scenario,
  [string]$Feed = 'feed',
  [string]$Out = 'out'
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

New-Item -ItemType Directory -Force -Path $Out, (Join-Path $Out 'shots') | Out-Null
$Out = (Resolve-Path $Out).Path
$Feed = (Resolve-Path $Feed).Path
$From = '0.6.90'
$Target = '0.6.91'
$root = Join-Path $env:LOCALAPPDATA 'Sei'
$userData = Join-Path $env:APPDATA 'Sei'
$marks = Join-Path $userData 'velopack-ci.jsonl'
$trigger = Join-Path $env:RUNNER_TEMP 'sei-ci-trigger'
$failures = [System.Collections.Generic.List[string]]::new()
$results = [ordered]@{ scenario = $Scenario }
$ffmpeg = (Get-Command ffmpeg -ErrorAction SilentlyContinue).Source

function Fail([string]$m) { Write-Host "::error::${Scenario}: $m"; $failures.Add($m) }
function Now { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
function FreeMB { [math]::Round((Get-PSDrive C).Free / 1MB) }
function DirMB([string]$p) { if (Test-Path $p) { [math]::Round(((Get-ChildItem $p -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum) / 1MB, 1) } else { 0 } }
function SeiProcs { @(Get-Process -Name 'Sei' -ErrorAction SilentlyContinue) }
function Stop-Sei { SeiProcs | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 2 }
function CurrentVersion { if (Test-Path "$root\current\sq.version") { ([xml](Get-Content "$root\current\sq.version")).package.metadata.version } else { '(none)' } }

function Shot([string]$name) {
  # ffmpeg's gdigrab copies with CAPTUREBLT, so layered windows (the splash,
  # Update.exe's overlay) are in the picture. No ffmpeg (restart-norec): none.
  if (-not $ffmpeg) { return }
  & $ffmpeg -hide_banner -loglevel error -y -f gdigrab -i desktop -frames:v 1 (Join-Path $Out "shots\$name.png")
}

function Layout([string]$label) {
  Write-Host "===== layout: $label ====="
  if (Test-Path $root) { Get-ChildItem $root -Force | ForEach-Object { Write-Host ('  {0,-40} {1,10} MB' -f $_.Name, $(if ($_.PSIsContainer) { DirMB $_.FullName } else { [math]::Round($_.Length / 1MB, 1) })) } }
  if (Test-Path "$root\packages") { Get-ChildItem "$root\packages" -Force | ForEach-Object { Write-Host ('  packages\{0,-38} {1,10} MB' -f $_.Name, $(if ($_.PSIsContainer) { DirMB $_.FullName } else { [math]::Round($_.Length / 1MB, 1) })) } }
  if (Test-Path "$root\packages\SeiStaged") { Get-ChildItem "$root\packages\SeiStaged" -Force | ForEach-Object { Write-Host "  SeiStaged\$($_.Name)" } }
  Write-Host "  current version: $(CurrentVersion)   free disk: $(FreeMB) MB"
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
function Mark([string]$ev, [string]$ver = '', [scriptblock]$where = $null) {
  Events | Where-Object { $_.ev -eq $ev -and (-not $ver -or $_.version -eq $ver) -and (-not $where -or (& $where $_)) } | Select-Object -First 1
}
function WaitMark([string]$ev, [string]$ver, [int]$timeoutS, [scriptblock]$where = $null) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.Elapsed.TotalSeconds -lt $timeoutS) {
    $m = Mark $ev $ver $where
    if ($m) { return $m }
    Start-Sleep -Milliseconds 100
  }
  $null
}
$isMain = { param($e) $e.w -gt 400 }
$isApp = { param($e) $e.url -and -not ($e.url -like 'data:*') }

function Timeline([long]$t0) {
  Write-Host "----- marks (ms from t0) -----"
  foreach ($e in Events) {
    $extra = $e | Select-Object * -ExcludeProperty ev, t, pid, version | ConvertTo-Json -Compress -Depth 4
    Write-Host ('  {0,8} {1,-24} pid={2,-6} v={3} {4}' -f ($e.t - $t0), $e.ev, $e.pid, $e.version, $extra)
  }
}

# ------------------------------------------------------------------ video
function Start-Rec([string]$name, [int]$seconds) {
  if ($Scenario -eq 'restart-norec' -or -not $ffmpeg) { return $null }
  $file = Join-Path $Out "$name.raw.mp4"
  $a = @('-hide_banner', '-loglevel', 'error', '-y', '-f', 'gdigrab', '-framerate', '30', '-t', "$seconds", '-i', 'desktop',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', "`"$file`"")
  $p = Start-Process -FilePath $ffmpeg -ArgumentList $a -PassThru -WindowStyle Hidden
  $null = $p.Handle
  Start-Sleep -Milliseconds 1000
  $rec = @{ proc = $p; file = $file; name = $name; at = (Now) }
  $results["video_$name`_start_ms"] = $rec.at
  $rec
}
function Stop-Rec($rec) {
  if (-not $rec) { return }
  if (-not $rec.proc.WaitForExit(180000)) { $rec.proc | Stop-Process -Force }
  $final = Join-Path $Out "$($rec.name).mp4"
  # every delivered video carries a silent AAC track
  & $ffmpeg -hide_banner -loglevel error -y -i $rec.file -f lavfi -i 'anullsrc=r=44100:cl=stereo' -shortest -c:v copy -c:a aac $final
  if (Test-Path $final) { Remove-Item $rec.file -ErrorAction SilentlyContinue }
}

# ------------------------------------------------------------------ setup
function Install-Sei {
  $setup = Join-Path $Feed "vp\setup\v$From\Sei-win-Setup.exe"
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $p = Start-Process -FilePath $setup -ArgumentList '--silent' -PassThru
  if (-not $p.WaitForExit(300000)) { throw 'Setup.exe timed out' }
  Write-Host "INSTALL $From`: exit=$($p.ExitCode) in $([math]::Round($sw.Elapsed.TotalSeconds, 1))s"
  Start-Sleep -Seconds 3
  Stop-Sei
  if (-not (Test-Path "$root\current\Sei.exe")) { throw 'current\Sei.exe missing after install' }
  New-Item -ItemType Directory -Force -Path $userData | Out-Null
}

$steps = Join-Path $env:RUNNER_TEMP 'feedsteps'
function Start-Feed {
  # One feed per target, listing releases only up to it, so an update is one version step.
  $all = Get-Content (Join-Path $Feed 'vp\releases.win.json') -Raw | ConvertFrom-Json
  $d = Join-Path $steps $Target
  New-Item -ItemType Directory -Force -Path $d | Out-Null
  $keep = @($all.Assets | Where-Object { [version]$_.Version -le [version]$Target })
  foreach ($a in $keep) { New-Item -ItemType HardLink -Path (Join-Path $d $a.FileName) -Target (Join-Path $Feed "vp\$($a.FileName)") | Out-Null }
  $copy = $all.PSObject.Copy(); $copy.Assets = $keep
  $copy | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $d 'releases.win.json') -Encoding utf8
  Write-Host "feed $Target -> $(($keep | ForEach-Object { "$($_.Version)/$($_.Type) $([math]::Round($_.Size / 1MB, 1)) MB" }) -join ', ')"
  $script:srv = Start-Process -FilePath python -ArgumentList '-m', 'http.server', '8765', '--bind', '127.0.0.1', '--directory', $steps -PassThru -WindowStyle Hidden
  # Wait until it answers: a fixed sleep lost the race on a busy runner once
  # (the client's first check was refused and the scenario never updated).
  $up = $false
  for ($i = 0; $i -lt 60 -and -not $up; $i++) {
    if ($script:srv.HasExited) { throw "the feed server exited ($($script:srv.ExitCode))" }
    try { $null = Invoke-WebRequest -Uri 'http://127.0.0.1:8765/' -UseBasicParsing -TimeoutSec 2; $up = $true } catch { Start-Sleep -Milliseconds 500 }
  }
  if (-not $up) { throw 'the feed server did not answer within 30s' }
  $script:fullMB = [math]::Round((($keep | Where-Object { $_.Version -eq $Target -and $_.Type -eq 'Full' }).Size) / 1MB)
}

function Prepare([string]$mode, [switch]$NoStage, [string]$Publisher = '') {
  Stop-Sei
  Remove-Item $marks, $trigger -Force -ErrorAction SilentlyContinue
  $env:SEI_VELOPACK_CI = '1'
  $env:SEI_VELOPACK_CI_MODE = $mode
  $env:SEI_VELOPACK_CI_TRIGGER = $trigger
  $env:SEI_VELOPACK_FEED = "http://127.0.0.1:8765/$Target"
  $env:SEI_VELOPACK_CI_NOSTAGE = if ($NoStage) { '1' } else { '' }
  # Empty removes it: the CI build is unsigned, so the signature check is off.
  $env:SEI_VELOPACK_CI_PUBLISHER = $Publisher
}

# sig-accept: sign the target's Full package with the runner's test
# certificate, then fix its size and hashes in the feed. The delta was made
# from the unsigned package, so it is dropped and the client takes the Full.
function Sign-FeedPackage {
  $relFile = Join-Path $Feed 'vp\releases.win.json'
  $all = Get-Content $relFile -Raw | ConvertFrom-Json
  $full = @($all.Assets | Where-Object { $_.Version -eq $Target -and $_.Type -eq 'Full' })[0]
  $pkg = Join-Path $Feed "vp\$($full.FileName)"
  $env:SEI_TESTSIGN_FILES = ''
  $env:SEI_TESTSIGN_PACKAGE = $pkg
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'testsign.ps1')
  if ($LASTEXITCODE -ne 0) { throw "testsign.ps1 failed ($LASTEXITCODE)" }
  $env:SEI_TESTSIGN_PACKAGE = ''
  $full.Size = (Get-Item $pkg).Length
  foreach ($alg in 'SHA1', 'SHA256') {
    $old = $full.PSObject.Properties[$alg]
    if (-not $old) { continue }
    $h = (Get-FileHash $pkg -Algorithm $alg).Hash
    if ([string]$old.Value -cmatch '^[0-9a-f]+$') { $h = $h.ToLowerInvariant() }
    $full.$alg = $h
  }
  $all.Assets = @($all.Assets | Where-Object { -not ($_.Version -eq $Target -and $_.Type -eq 'Delta') })
  $all | ConvertTo-Json -Depth 6 | Set-Content $relFile -Encoding utf8
  Write-Host "signed $($full.FileName): $([math]::Round($full.Size / 1MB, 1)) MB"
}

# session-end: what Windows sends every top-level window of the app at log off
# or shut down. Only the browser process's windows (no --type= switch).
function Send-EndSession([int]$appPid) {
  if (-not ('SeiCiEndSession' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class SeiCiEndSession {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr h, uint msg, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);
  public static int Send(uint pid) {
    var hs = new List<IntPtr>();
    EnumProc f = (h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (p == pid) hs.Add(h); return true; };
    EnumWindows(f, IntPtr.Zero);
    GC.KeepAlive(f);
    IntPtr r;
    IntPtr logoff = new IntPtr(unchecked((int)0x80000000));
    foreach (var h in hs) SendMessageTimeout(h, 0x0011, IntPtr.Zero, logoff, 2, 5000, out r);
    foreach (var h in hs) SendMessageTimeout(h, 0x0016, new IntPtr(1), logoff, 2, 5000, out r);
    return hs.Count;
  }
}
'@
  }
  [SeiCiEndSession]::Send([uint32]$appPid)
}

function Start-Sei {
  $p = Start-Process -FilePath "$root\current\Sei.exe" -PassThru
  $null = $p.Handle
  $p
}

function Wait-Downloaded {
  $d = WaitMark 'downloaded' $From 480
  if (-not $d) { Fail 'no update downloaded within 8 min'; Finish }
  $s = Mark 'stage-done' $From
  $results.stage_result = if ($s) { $s.result } else { 'not run' }
  $results.stage_ms = if ($s) { $s.ms } else { $null }
  $d0 = Mark 'download-start' $From; $d1 = Mark 'download-done' $From
  $results.download_ms = if ($d0 -and $d1) { $d1.t - $d0.t } else { $null }
  Write-Host "downloaded; stage: $($results.stage_result)"
  Layout 'downloaded'
  $d
}

function Pull {
  # Fire the "Update Sei" click (or the quit) the harness is waiting for.
  Set-Content $trigger '1'
  $m = WaitMark 'triggered' $From 15
  if (-not $m) { Fail 'the app never saw the trigger' }
  $m
}

# Waits until `version`'s main window has loaded (or timeout); returns the old process's exit time.
function Wait-AppLoaded([string]$version, [int]$timeoutS, $oldProc) {
  $sw = [Diagnostics.Stopwatch]::StartNew(); $oldExit = $null
  while ($sw.Elapsed.TotalSeconds -lt $timeoutS) {
    if ($oldProc -and $null -eq $oldExit -and $oldProc.HasExited) { $oldExit = Now }
    if (Mark 'window-loaded' $version $isApp) { break }
    Start-Sleep -Milliseconds 100
  }
  if ($oldProc -and $null -eq $oldExit -and $oldProc.HasExited) { $oldExit = Now }
  $oldExit
}

function Restart-Metrics([long]$click, [string]$version, $oldExit) {
  function Rel($m) { if ($m) { $m.t - $click } else { $null } }
  $r = [ordered]@{
    update_screen_ms   = Rel (Mark 'update-screen-shown' $From)
    overlay_shown_ms   = Rel (Mark 'overlay-shown' $From)
    old_quit_ms        = Rel (Mark 'quit' $From)
    old_exit_ms        = if ($oldExit) { $oldExit - $click } else { $null }
    new_boot_ms        = Rel (Mark 'boot' $version)
    new_splash_ms      = Rel (Mark 'window-shown' $version)
    new_main_shown_ms  = Rel (Mark 'window-shown' $version $isMain)
    new_main_loaded_ms = Rel (Mark 'window-loaded' $version $isApp)
  }
  foreach ($k in $r.Keys) { $results[$k] = $r[$k] }
  $o = Mark 'overlay-shown' $From
  $results.overlay_reported = if ($o) { [bool]$o.shown } else { $null }
  Write-Host ("RESTART " + ($r | ConvertTo-Json -Compress))
}

$veloLogs = Join-Path $env:LOCALAPPDATA 'velopack'
function VeloLogFiles {
  @(Get-ChildItem $veloLogs -Filter '*.log' -Force -ErrorAction SilentlyContinue) +
  @(Get-ChildItem $root -Filter '*.log' -Recurse -Force -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notlike '*\current\*' })
}
function Dump-Logs {
  Write-Host '----- Update.exe / Velopack logs -----'
  VeloLogFiles | ForEach-Object {
    Write-Host "### $($_.FullName)"
    Get-Content $_.FullName -Tail 250 | ForEach-Object { Write-Host $_ }
    Copy-Item $_.FullName (Join-Path $Out $_.Name) -ErrorAction SilentlyContinue
  }
  foreach ($n in 'velopack.log', 'updater.log', 'main.log') {
    $f = Join-Path $userData "logs\$n"
    if (Test-Path $f) { Write-Host "### $f"; Get-Content $f -Tail 120 | ForEach-Object { Write-Host $_ }; Copy-Item $f (Join-Path $Out "app-$n") -ErrorAction SilentlyContinue }
  }
  if (Test-Path $marks) { Copy-Item $marks (Join-Path $Out 'marks.jsonl') }
  $ov = Join-Path $root 'packages\SeiOverlay'
  if (Test-Path $ov) { New-Item -ItemType Directory -Force -Path (Join-Path $Out 'overlay') | Out-Null; Copy-Item "$ov\*" (Join-Path $Out 'overlay') -ErrorAction SilentlyContinue }
}

function Velolog([string]$pattern) {
  $hits = @()
  VeloLogFiles | ForEach-Object {
    $hits += @(Select-String -Path $_.FullName -Pattern $pattern -ErrorAction SilentlyContinue | ForEach-Object { $_.Line })
  }
  $hits
}

# Every rendered overlay frame must look like the splash: transparent corners,
# some opaque ink. A cached white first paint showed as a white box (run 41028220016).
function Check-Frames {
  $ov = Join-Path $root 'packages\SeiOverlay'
  if (-not (Test-Path $ov)) { return }
  Add-Type -AssemblyName System.Drawing
  $bad = @()
  Get-ChildItem $ov -Filter '*.png' | ForEach-Object {
    $bmp = [System.Drawing.Bitmap]::FromFile($_.FullName)
    try {
      $corner = $bmp.GetPixel(0, 0).A
      $ink = 0
      for ($y = 0; $y -lt $bmp.Height; $y += 4) { for ($x = 0; $x -lt $bmp.Width; $x += 4) { if ($bmp.GetPixel($x, $y).A -gt 200) { $ink++ } } }
      if ($corner -ge 16 -or $ink -lt 5) { $bad += "$($_.Name) (corner alpha $corner, ink $ink)" }
    } finally { $bmp.Dispose() }
  }
  $results.overlay_frames_bad = $bad
  if ($bad.Count -gt 0) { Fail "overlay frames do not look like the splash: $($bad -join ', ')" }
}

# Phase timings Update.exe logs in ms (the log's own timestamps are whole seconds).
function Apply-Timings {
  $pick = {
    param($pattern)
    $line = @(Velolog $pattern | Select-Object -Last 1)
    if ($line.Count -gt 0 -and $line[0] -match $pattern) { [int]$Matches[1] } else { $null }
  }
  $results.t_pid_wait_ms = & $pick 'exited \((\d+) ms after the wait started\)'
  $results.t_swap_ms = & $pick 'Swapped the current dir in (\d+)ms'
  $results.t_createprocess_ms = & $pick 'CreateProcess (\d+) ms'
  $results.t_prewarm_ms = & $pick 'Prewarmed \d+ images in (\d+) ms'
  $results.t_window_after_start_ms = & $pick 'shows a window after (\d+)ms'
}

function Finish {
  try { Apply-Timings } catch { Write-Host "Apply-Timings: $_" }
  Check-Frames
  Dump-Logs
  Layout 'end'
  $results.final_version = CurrentVersion
  $results.free_disk_end_mb = FreeMB
  $results.failures = @($failures)
  $results | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $Out 'result.json')
  Write-Host ("RESULT " + ($results | ConvertTo-Json -Compress -Depth 5))
  if ($script:srv) { $script:srv | Stop-Process -Force -ErrorAction SilentlyContinue }
  if ($failures.Count -gt 0) { exit 1 }
  Write-Host "PASS: $Scenario"
  exit 0
}

# ------------------------------------------------------------------ runner facts
try {
  # Users run with Defender real-time protection on; the runner image ships with
  # it off. Turn it on for every scenario except the one that measures without it.
  $wantOn = $Scenario -ne 'restart-defender-off'
  try { Set-MpPreference -DisableRealtimeMonitoring (-not $wantOn) -ErrorAction Stop; Start-Sleep -Seconds 3 } catch { Write-Host "Set-MpPreference failed: $_" }
  $mp = Get-MpComputerStatus
  $results.defender_realtime = [bool]$mp.RealTimeProtectionEnabled
  $results.defender_onaccess = [bool]$mp.OnAccessProtectionEnabled
  $results.defender_antivirus = [bool]$mp.AntivirusEnabled
} catch { $results.defender_realtime = "unknown: $_" }
$results.cpus = (Get-CimInstance Win32_Processor | Measure-Object NumberOfLogicalProcessors -Sum).Sum
$results.screen = "$([System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width)x$([System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height)"
Write-Host ("RUNNER " + ($results | ConvertTo-Json -Compress))

Install-Sei
if ($Scenario -eq 'sig-accept') { Sign-FeedPackage }
Start-Feed
Layout "installed $From"

# ------------------------------------------------------------------ scenarios
switch -Regex ($Scenario) {
  '^restart(-defender-off|-norec|-unstaged)?$' {
    $unstaged = $Scenario -eq 'restart-unstaged'
    Prepare 'restart' -NoStage:$unstaged
    $old = Start-Sei
    Wait-Downloaded | Out-Null
    if (-not $unstaged -and $results.stage_result -notlike 'ok*') { Fail "stage did not finish: $($results.stage_result)" }
    Shot "$Scenario-before"
    $rec = Start-Rec $Scenario $(if ($unstaged) { 70 } else { 35 })
    $click = (Pull).t
    $oldExit = Wait-AppLoaded $Target 150 $old
    Start-Sleep -Seconds 3
    Shot "$Scenario-after"
    Stop-Rec $rec
    Restart-Metrics $click $Target $oldExit
    Timeline $click
    if (-not (Mark 'window-loaded' $Target $isApp)) { Fail "Sei $Target never loaded after the restart" }
    $used = Velolog 'Using staged copy'
    $extracted = Velolog 'Extracted the package in'
    $results.apply_path = if ($used) { 'staged' } elseif ($extracted) { 'extracted' } else { 'unknown' }
    $results.swap_log = @(Velolog 'Swapped the current dir in')
    $results.extract_log = @($extracted)
    $results.overlay_log = @(Velolog 'Overlay (shown|frame|closed)|closing the overlay')
    if (-not $unstaged -and -not $used) { Fail 'apply did not use the staged copy' }
    if ($unstaged -and -not $extracted) { Fail 'unstaged apply did not extract' }
    if ((SeiProcs).Count -lt 1) { Fail 'no Sei running after the restart' }
  }

  '^rollback-swap[12]$' {
    Prepare 'restart'
    $old = Start-Sei
    Wait-Downloaded | Out-Null
    if ($results.stage_result -notlike 'ok*') { Fail "stage did not finish: $($results.stage_result)" }
    $lockPath = if ($Scenario -eq 'rollback-swap1') { "$root\current\resources\app.asar" } else { "$root\packages\SeiStaged\v$Target\resources\app.asar" }
    # no FILE_SHARE_DELETE: the folder holding it cannot be renamed while this is open
    $lock = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
    Write-Host "holding $lockPath"
    $rec = Start-Rec $Scenario $(if ($Scenario -eq 'rollback-swap1') { 40 } else { 70 })
    $click = (Pull).t
    # Update.exe fails the swap, shows the error frame, and starts the old version again.
    $back = WaitMark 'boot' $From 150 { param($e) $e.t -gt $click }
    $results.old_back_ms = if ($back) { $back.t - $click } else { $null }
    $lock.Dispose()
    Write-Host 'released the lock'
    if (-not $back) { Fail "the old version was not started after the failed swap" }
    $loadedOld = WaitMark 'window-loaded' $From 60 { param($e) $e.t -gt $click -and $e.url -and -not ($e.url -like 'data:*') }
    $results.old_loaded_ms = if ($loadedOld) { $loadedOld.t - $click } else { $null }
    Stop-Rec $rec
    Timeline $click
    $results.version_after_failure = if ($back) { 'old version restarted' } else { 'no relaunch' }
    $results.rollback_log = @(Velolog 'restoring the previous version|Restored the previous version|Error applying package|Unable to (start|complete) the update')
    $results.overlay_log = @(Velolog 'Overlay (shown|frame|closed)|closing the overlay')
    if (-not ($results.overlay_log | Where-Object { $_ -match 'Overlay frame' })) { Write-Host 'note: no overlay frame change logged (the error frame may not have shown)' }
    # The restarted old Sei (still in CI mode) downloads, stages and restarts again: the retry must land.
    $retried = WaitMark 'window-loaded' $Target 420 $isApp
    $results.retry_landed = [bool]$retried
    if (-not $retried) { Fail "the retry after the failed swap never reached $Target" }
    Timeline $click
  }

  '^launch-during-apply$' {
    # An update on quit WITHOUT a staged copy, so the apply lasts long enough to launch into.
    Prepare 'quit' -NoStage
    $old = Start-Sei
    Wait-Downloaded | Out-Null
    $rec = Start-Rec $Scenario 60
    $click = (Pull).t
    $applying = Join-Path $root 'packages\SeiStaged\applying.pid'
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while (-not (Test-Path $applying) -and $sw.Elapsed.TotalSeconds -lt 60) { Start-Sleep -Milliseconds 50 }
    if (-not (Test-Path $applying)) { Fail 'applying.pid never appeared' } else {
      Start-Sleep -Milliseconds 1500
      Write-Host "user launches Sei during the apply ($(Get-Content $applying))"
      $env:SEI_VELOPACK_CI_MODE = 'none'
      $user = Start-Sei
      $left = WaitMark 'left-during-apply' '' 30
      $results.left_during_apply = [bool]$left
      if (-not $left) { Fail 'the launch during the apply did not leave' }
      $results.user_launch_exited = $user.WaitForExit(15000)
    }
    $loaded = WaitMark 'window-loaded' $Target 180 $isApp
    $results.relaunched_after_apply_ms = if ($loaded) { $loaded.t - $click } else { $null }
    Stop-Rec $rec
    Timeline $click
    if (-not $loaded) { Fail "Sei $Target was not started after the apply" }
    $results.relaunch_log = @(Velolog 'launched during the apply')
  }

  '^quit$' {
    Prepare 'quit'
    $old = Start-Sei
    Wait-Downloaded | Out-Null
    $rec = Start-Rec $Scenario 25
    $click = (Pull).t
    $old.WaitForExit(60000) | Out-Null
    $oldExit = Now
    $sw = [Diagnostics.Stopwatch]::StartNew(); $seen = $false; $updDone = $null
    while ($sw.Elapsed.TotalSeconds -lt 120) {
      $u = @(Get-Process -Name 'Update' -ErrorAction SilentlyContinue)
      if ($u.Count -gt 0) { $seen = $true } elseif ($seen) { $updDone = Now; break }
      Start-Sleep -Milliseconds 100
    }
    Shot 'quit-after'
    Stop-Rec $rec
    $results.old_exit_ms = $oldExit - $click
    $results.update_exe_done_ms = if ($updDone) { $updDone - $click } else { $null }
    $results.relaunched = [bool](Mark 'boot' $Target)
    if ($results.relaunched) { Fail 'update on quit reopened Sei' }
    if ((CurrentVersion) -ne $Target) { Fail "update on quit did not apply (current is $(CurrentVersion))" }
    $results.apply_path = if (Velolog 'Using staged copy') { 'staged' } else { 'extracted' }
    # the next ordinary launch runs the new version
    Prepare 'none'
    $t = Now
    Start-Sei | Out-Null
    $l = WaitMark 'window-loaded' $Target 90 $isApp
    $results.next_launch_loaded_ms = if ($l) { $l.t - $t } else { $null }
    if (-not $l) { Fail "the launch after the quit apply did not load $Target" }
    Timeline $click
  }

  '^next-launch$' {
    Prepare 'download-only'
    $old = Start-Sei
    Wait-Downloaded | Out-Null
    if ($results.stage_result -notlike 'ok*') {
      # 'downloaded' is offered after at most 3 min; the stage may still be running.
      $s = WaitMark 'stage-done' $From 600
      $results.stage_result = if ($s) { $s.result } else { 'not finished in 10 min' }
      $results.stage_ms = if ($s) { $s.ms } else { $null }
    }
    if ($results.stage_result -notlike 'ok*') { Fail "stage did not finish: $($results.stage_result)" }
    Stop-Sei   # killed: never applied
    Layout 'killed with a staged update pending'
    Prepare 'download-only'
    $rec = Start-Rec $Scenario 40
    $t = Now
    $p = Start-Sei
    $l = WaitMark 'window-loaded' $Target 120 $isApp
    Start-Sleep -Seconds 2
    Stop-Rec $rec
    $results.launch_apply_mark = [bool](Mark 'launch-apply' $From)
    $results.launch_to_new_boot_ms = if ($b = Mark 'boot' $Target) { $b.t - $t } else { $null }
    $results.launch_to_new_loaded_ms = if ($l) { $l.t - $t } else { $null }
    Timeline $t
    if (-not $results.launch_apply_mark) { Fail 'the launch did not apply the pending update' }
    if (-not $l) { Fail "the launch apply did not reach $Target" }
  }

  '^low-disk$' {
    $free = FreeMB
    $leave = $script:fullMB + 1450
    $fillMB = $free - $leave
    Write-Host "free $free MB, full package $($script:fullMB) MB: filling $fillMB MB to leave $leave MB"
    if ($fillMB -gt 0) { & fsutil file createnew C:\sei-fill.bin ([int64]$fillMB * 1MB) | Out-Null }
    $results.free_before_mb = FreeMB
    Prepare 'restart'
    $old = Start-Sei
    Wait-Downloaded | Out-Null
    $results.free_at_download_mb = FreeMB
    if ($results.stage_result -notlike 'skipped*low disk*') { Fail "expected the stage to skip for low disk, got: $($results.stage_result)" }
    $rec = Start-Rec $Scenario 70
    $click = (Pull).t
    $oldExit = Wait-AppLoaded $Target 180 $old
    Stop-Rec $rec
    Restart-Metrics $click $Target $oldExit
    Timeline $click
    if (-not (Mark 'window-loaded' $Target $isApp)) { Fail "Sei $Target never loaded after the low-disk restart" }
    Remove-Item C:\sei-fill.bin -Force -ErrorAction SilentlyContinue
  }

  '^rollout$' {
    $rf = Join-Path $steps "$Target\rollout.win.json"
    Set-Content $rf ('{"version":"' + $Target + '","percent":0}')
    Prepare 'download-only'
    $p = Start-Sei
    $held = WaitMark 'check-held-by-rollout' $From 180
    $results.held_at_0 = [bool]$held
    if (-not $held) { Fail 'percent 0 did not hold the update back' }
    Start-Sleep -Seconds 5
    if (Mark 'download-start' $From) { Fail 'downloaded despite percent 0' }
    Stop-Sei
    # The same install, the same version: its bucket decides. Find it, then 1 above it.
    $id = $null
    foreach ($f in "$root\packages\.betaId", "$userData\update-install-id") { if (-not $id -and (Test-Path $f)) { $id = (Get-Content $f -Raw).Trim() } }
    if ($id) {
      $sha = [System.Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes("$id`:$Target"))
      $bucket = ([uint32]$sha[0] * 16777216 + [uint32]$sha[1] * 65536 + [uint32]$sha[2] * 256 + [uint32]$sha[3]) % 100
      $results.bucket = $bucket
      Set-Content $rf ('{"version":"' + $Target + '","percent":' + $bucket + '}')
      Prepare 'download-only'
      Start-Sei | Out-Null
      $h2 = WaitMark 'check-held-by-rollout' $From 180
      $results.held_at_bucket = [bool]$h2
      if (-not $h2) { Fail "percent=$bucket (this install's bucket) should still hold it back" }
      Stop-Sei
      Set-Content $rf ('{"version":"' + $Target + '","percent":' + ($bucket + 1) + '}')
    } else {
      Write-Host 'note: install id not found, skipping the bucket edge check'
      Set-Content $rf ('{"version":"' + $Target + '","percent":100}')
    }
    Prepare 'download-only'
    Start-Sei | Out-Null
    $got = WaitMark 'downloaded' $From 300
    $results.offered_after_release = [bool]$got
    if (-not $got) { Fail 'the update was not offered once the rollout admitted this install' }
    Timeline 0
  }

  '^sig-reject$' {
    Prepare 'restart' -Publisher 'CN=Sei CI Not The Signer'
    $old = Start-Sei
    $sig = WaitMark 'signature-check' $From 480
    if (-not $sig) { Fail 'no signature check within 8 min'; Finish }
    $results.signature = $sig
    if ($sig.ok) { Fail 'a package not signed by the expected publisher passed' }
    # Rejected for the right reason: the CI package is unsigned. A check that
    # could not run (PowerShell failing to load its modules) rejects too.
    elseif ($sig.reason -notmatch 'NotSigned') { Fail "rejected for another reason: $($sig.reason)" }
    # Deleting the staged copy (6000+ files) takes a while under Defender.
    $gone = WaitMark 'signature-discarded' $From 180
    if (-not $gone) { Fail 'the rejected package was not discarded within 3 min' } else { $results.discard_ms = $gone.ms }
    Start-Sleep -Seconds 2
    if (Mark 'downloaded' $From) { Fail 'the rejected update was offered' }
    $leftPkg = @(Get-ChildItem "$root\packages" -Filter "*$Target*.nupkg" -ErrorAction SilentlyContinue)
    if ($leftPkg.Count -gt 0) { Fail "the rejected package was kept: $($leftPkg.Name -join ', ')" }
    if (Test-Path "$root\packages\SeiStaged\v$Target") { Fail 'the staged copy of the rejected package was kept' }
    if ($old.HasExited) { Fail 'Sei exited after the rejection' }
    Layout 'after the rejection'
    Timeline 0
    # The same package with the check off (what an unsigned build does) installs.
    Prepare 'restart'
    $old = Start-Sei
    Wait-Downloaded | Out-Null
    $click = (Pull).t
    $oldExit = Wait-AppLoaded $Target 150 $old
    Restart-Metrics $click $Target $oldExit
    if (-not (Mark 'window-loaded' $Target $isApp)) { Fail "Sei $Target never loaded once the check was off" }
  }

  '^sig-accept$' {
    Prepare 'restart' -Publisher 'CN=Sei CI Test Signer, O=Sei CI'
    $old = Start-Sei
    Wait-Downloaded | Out-Null
    $sig = Mark 'signature-check' $From
    $results.signature = $sig
    if (-not $sig -or -not $sig.ok -or $sig.skipped) { Fail "the signed package was not accepted: $($sig | ConvertTo-Json -Compress)" }
    if ($results.stage_result -notlike 'ok*') { Fail "stage did not finish: $($results.stage_result)" }
    $results.verdict_file = Test-Path "$root\packages\SeiStaged\v$Target.sig"
    $click = (Pull).t
    $oldExit = Wait-AppLoaded $Target 150 $old
    Restart-Metrics $click $Target $oldExit
    Timeline $click
    if (-not (Mark 'window-loaded' $Target $isApp)) { Fail "Sei $Target never loaded after the signed restart" }
    if (-not (Velolog 'Using staged copy')) { Fail 'apply did not use the staged copy' }
  }

  '^restart-spawn-fail$' {
    Prepare 'restart'
    $old = Start-Sei
    Wait-Downloaded | Out-Null
    $upd = Join-Path $root 'Update.exe'
    Rename-Item -LiteralPath $upd 'Update.exe.ci-moved'
    $rec = Start-Rec $Scenario 30
    $click = (Pull).t
    $failed = WaitMark 'apply-spawn-failed' $From 60
    $restored = WaitMark 'windows-restored' $From 30
    Start-Sleep -Seconds 5
    Shot "$Scenario-after"
    Stop-Rec $rec
    Timeline $click
    $results.spawn_failed_ms = if ($failed) { $failed.t - $click } else { $null }
    $results.windows_restored = if ($restored) { $restored.shown } else { $null }
    if (-not $failed) { Fail 'no apply-spawn-failed mark' }
    if (-not $restored -or $restored.shown -lt 1) { Fail 'the windows were not shown again' }
    if ($old.HasExited) { Fail 'Sei quit although Update.exe never started' }
    if (Mark 'quit' $From) { Fail 'Sei quit after the failed start' }
    Rename-Item -LiteralPath (Join-Path $root 'Update.exe.ci-moved') 'Update.exe'
    Stop-Sei
    # The update is still downloaded and staged: the next launch applies it.
    Prepare 'download-only'
    $t = Now
    Start-Sei | Out-Null
    $l = WaitMark 'window-loaded' $Target 150 $isApp
    $results.next_launch_loaded_ms = if ($l) { $l.t - $t } else { $null }
    if (-not $l) { Fail "the launch after the failed restart did not reach $Target" }
  }

  '^session-end$' {
    Prepare 'quit'
    $old = Start-Sei
    Wait-Downloaded | Out-Null
    $n = Send-EndSession $old.Id
    $results.endsession_windows = $n
    Write-Host "sent the session end to $n windows"
    $se = WaitMark 'session-end' $From 30
    if (-not $se) { Fail 'Sei never saw the session end' }
    # Windows would end the process; the CI quit runs the same quit handler.
    # (If Electron quits on its own after WM_ENDSESSION, nobody reads the trigger.)
    $click = Now
    Set-Content $trigger '1'
    if (-not $old.WaitForExit(60000)) { Fail 'Sei did not quit' }
    $q = WaitMark 'quit' $From 30
    $results.quit_session_end = if ($q) { [bool]$q.sessionEnd } else { $null }
    if (-not $q -or -not $q.sessionEnd) { Fail 'the quit did not know the session was ending' }
    Start-Sleep -Seconds 15
    if (Mark 'apply-launch' $From) { Fail 'an apply was started while the session ended' }
    if (@(Get-Process -Name 'Update' -ErrorAction SilentlyContinue).Count -gt 0) { Fail 'Update.exe is running' }
    if ((CurrentVersion) -ne $From) { Fail "the update was applied during the session end ($(CurrentVersion))" }
    Timeline $click
    Prepare 'download-only'
    $t = Now
    Start-Sei | Out-Null
    $l = WaitMark 'window-loaded' $Target 150 $isApp
    $results.launch_apply_mark = [bool](Mark 'launch-apply' $From)
    $results.next_launch_loaded_ms = if ($l) { $l.t - $t } else { $null }
    if (-not $l) { Fail "the next launch did not apply $Target" }
  }

  default { throw "unknown scenario $Scenario" }
}

Finish
