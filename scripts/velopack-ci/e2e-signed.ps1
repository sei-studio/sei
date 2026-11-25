# End-to-end proof of the Windows fast-update path on SIGNED release builds
# (product call (261126)), for .github/workflows/velopack-update.yml, job
# e2e-signed. Unlike scenario.ps1 and migrate.ps1 (this branch, unsigned
# 0.6.90/0.6.91) everything here is a real release as built, signed and
# packed by release.yml, so the Authenticode checks run against the real
# publisher baked into the build (SEI_WIN_PUBLISHER), never a CI override.
#
# One run, the way a beta user on Windows gets it:
#   1. NSIS install of the base release (the stable most users have).
#   2. Optional: the NSIS update to a newer beta, run the way electron-updater
#      runs it (--updated /S). The player is on the beta channel
#      (advanced_updates in the profile config).
#   3. Migration ON for the beta channel (migration.beta.json 100%) on a
#      local copy of the feed: the NSIS app downloads the From Setup, checks
#      sha256 + signature, installs it beside itself, restarts into it, and
#      the Velopack copy removes the NSIS copy.
#   4. A Velopack update to Target (the Full package, or the release's own
#      Delta with -UseDelta when its base is From), signature checked, staged,
#      restarted.
#   5. A forced self-repair: Update.exe deleted, the next launch downloads the
#      Target Setup, checks it, reinstalls, and the repaired Sei reports it.
#
# -Rel holds the downloaded release assets:
#   base\Sei-win-x64.exe                    NSIS installer to start from
#   nsis\Sei-win-x64.exe                    (optional) NSIS update to apply
#   from\{Sei-beta-Setup.exe,setup.beta.json}
#   target\{Sei-beta-Setup.exe,setup.beta.json,releases.beta.json,*-beta-full.nupkg[,*-beta-delta.nupkg]}
# The machine must not reach github.com or dl.sei.gg while this runs (the
# workflow blocks them), so the live feeds cannot change what the app does.
param(
  [Parameter(Mandatory = $true)][string]$Rel,
  [string]$Out = 'out',
  [switch]$UseDelta
)
$ErrorActionPreference = 'Stop'

New-Item -ItemType Directory -Force -Path $Out | Out-Null
$Out = (Resolve-Path $Out).Path
$Rel = (Resolve-Path $Rel).Path
$root = Join-Path $env:LOCALAPPDATA 'Sei'
$userData = Join-Path $env:APPDATA 'Sei'
$marks = Join-Path $userData 'velopack-ci.jsonl'
$stateFile = Join-Path $userData 'velopack-migration.json'
$feedDir = Join-Path $env:RUNNER_TEMP 'e2e-feed'
$failures = [System.Collections.Generic.List[string]]::new()
$results = [ordered]@{ case = 'e2e-signed'; use_delta = [bool]$UseDelta }
$fromManifest = Get-Content (Join-Path $Rel 'from\setup.beta.json') -Raw | ConvertFrom-Json
$targetManifest = Get-Content (Join-Path $Rel 'target\setup.beta.json') -Raw | ConvertFrom-Json
$From = $fromManifest.version
$Target = $targetManifest.version
$results.from = $From
$results.target = $Target

function Fail([string]$m) { Write-Host "::error::e2e-signed: $m"; $failures.Add($m) }
function Now { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
function SeiProcs { @(Get-Process -Name 'Sei' -ErrorAction SilentlyContinue) }
function Stop-Sei { SeiProcs | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 2 }
function CurrentVersion { if (Test-Path "$root\current\sq.version") { ([xml](Get-Content "$root\current\sq.version")).package.metadata.version } else { '(none)' } }
function Entries {
  foreach ($r in 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall') {
    if (Test-Path $r) {
      Get-ChildItem $r | ForEach-Object {
        $q = Get-ItemProperty $_.PSPath
        if ($q.DisplayName -like 'Sei*') { [pscustomobject]@{ Root = $r.Substring(0, 4); Key = $_.PSChildName; Name = $q.DisplayName; Version = $q.DisplayVersion; Uninstall = $q.UninstallString } }
      }
    }
  }
}
function State([string]$label) {
  Write-Host "===== $label ====="
  Write-Host (Entries | Format-Table -AutoSize | Out-String -Width 400)
  Write-Host "  Sei processes: $((SeiProcs | ForEach-Object { "$($_.Id) $(try { $_.Path } catch { '' })" }) -join '; ')"
  Write-Host "  Velopack copy: $(CurrentVersion)"
  if (Test-Path $stateFile) { Write-Host "  migration state: $((Get-Content $stateFile -Raw) -replace '\s+', ' ')" }
}

# ------------------------------------------------------------------ marks (as in scenario.ps1)
function Read-Shared([string]$file) {
  $fs = [System.IO.File]::Open($file, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]'ReadWrite, Delete')
  try { $sr = New-Object System.IO.StreamReader($fs); $sr.ReadToEnd() -split "`r?`n" } finally { $fs.Dispose() }
}
$allEvents = [System.Collections.Generic.List[object]]::new()
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
    Start-Sleep -Milliseconds 200
  }
  $null
}
function Need([string]$step, [string]$ev, [string]$ver, [int]$timeoutS, [scriptblock]$where = $null) {
  $m = WaitMark $ev $ver $timeoutS $where
  if (-not $m) { Fail "${step}: no '$ev' mark (version '$ver') within ${timeoutS}s"; Finish }
  $m
}
$isApp = { param($e) $e.url -and -not ($e.url -like 'data:*') }
function Timeline([string]$label) {
  Write-Host "----- marks: $label -----"
  $ev = @(Events)
  if ($ev.Count -eq 0) { return }
  $t0 = $ev[0].t
  foreach ($e in $ev) {
    $extra = $e | Select-Object * -ExcludeProperty ev, t, pid, version | ConvertTo-Json -Compress -Depth 5
    Write-Host ('  {0,8} {1,-26} pid={2,-6} v={3} {4}' -f ($e.t - $t0), $e.ev, $e.pid, $e.version, $extra)
  }
}
# Each step starts with an empty marks file; keep the old ones for the artifact.
function Next-Step([string]$label) {
  Timeline $label
  if (Test-Path $marks) {
    Get-Content $marks | Add-Content (Join-Path $Out 'marks.jsonl')
    Remove-Item $marks -Force
  }
}

function Finish {
  Stop-Sei
  if ($script:srv) { $script:srv | Stop-Process -Force -ErrorAction SilentlyContinue }
  Next-Step 'last step'
  State 'end'
  foreach ($n in 'velopack.log', 'updater.log', 'main.log') {
    $f = Join-Path $userData "logs\$n"
    if (Test-Path $f) { Write-Host "### $f"; Get-Content $f -Tail 150 | ForEach-Object { Write-Host $_ }; Copy-Item $f (Join-Path $Out "app-$n") -ErrorAction SilentlyContinue }
  }
  Get-ChildItem (Join-Path $env:LOCALAPPDATA 'velopack') -Filter '*.log' -ErrorAction SilentlyContinue | ForEach-Object { Copy-Item $_.FullName $Out -ErrorAction SilentlyContinue }
  Get-ChildItem (Join-Path $env:TEMP 'sei-repair-*') -Recurse -Include 'runner.log', 'setup.log' -ErrorAction SilentlyContinue | ForEach-Object { Copy-Item $_.FullName (Join-Path $Out "repair-$($_.Name)") -ErrorAction SilentlyContinue }
  if (Test-Path $stateFile) { Copy-Item $stateFile (Join-Path $Out 'velopack-migration.json') }
  $results.failures = @($failures)
  $results | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $Out 'result.json') -Encoding utf8
  Write-Host ($results | ConvertTo-Json -Depth 6)
  if ($env:GITHUB_STEP_SUMMARY) {
    $rows = @('| step | value |', '|---|---|')
    foreach ($k in $results.Keys) { if ($k -ne 'failures') { $rows += "| $k | $($results[$k] | ConvertTo-Json -Compress -Depth 4) |" } }
    $head = if ($failures.Count -gt 0) { "### e2e-signed FAILED ($From -> $Target)`n`n$($failures -join '; ')" } else { "### e2e-signed PASS ($From -> $Target)" }
    Add-Content $env:GITHUB_STEP_SUMMARY ("$head`n`n" + ($rows -join "`n"))
  }
  if ($failures.Count -gt 0) { exit 1 }
  Write-Host "PASS: e2e-signed $From -> $Target"
  exit 0
}

function Feed-Server {
  New-Item -ItemType Directory -Force -Path $feedDir | Out-Null
  $script:srv = Start-Process -FilePath python -ArgumentList '-m', 'http.server', '8765', '--bind', '127.0.0.1', '--directory', $feedDir -PassThru -WindowStyle Hidden
  $up = $false
  for ($i = 0; $i -lt 60 -and -not $up; $i++) {
    if ($script:srv.HasExited) { throw "the feed server exited ($($script:srv.ExitCode))" }
    try { $null = Invoke-WebRequest -Uri 'http://127.0.0.1:8765/' -UseBasicParsing -TimeoutSec 2; $up = $true } catch { Start-Sleep -Milliseconds 500 }
  }
  if (-not $up) { throw 'the feed server did not answer within 30s' }
}
function Put-Json([string]$name, $obj) {
  $obj | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $feedDir $name) -Encoding utf8
  Write-Host "feed $name = $((Get-Content (Join-Path $feedDir $name) -Raw) -replace '\s+', ' ')"
}
# setup.beta.json and the Setup behind it, at setup/<tag>/<file> as the mirror lays it out.
function Put-Setup([string]$which, $manifest) {
  $d = Join-Path $feedDir "setup\$($manifest.tag)"
  New-Item -ItemType Directory -Force -Path $d | Out-Null
  Copy-Item (Join-Path $Rel "$which\$($manifest.file)") (Join-Path $d $manifest.file) -Force
  $actual = (Get-FileHash (Join-Path $d $manifest.file) -Algorithm SHA256).Hash.ToLower()
  if ($actual -ne $manifest.sha256.ToLower()) { throw "$which Setup sha256 $actual does not match its setup.beta.json" }
  Copy-Item (Join-Path $Rel "$which\setup.beta.json") (Join-Path $feedDir 'setup.beta.json') -Force
}
function Set-Env([string]$mode) {
  $env:SEI_VELOPACK_CI = '1'
  $env:SEI_VELOPACK_CI_MODE = $mode
  $env:SEI_VELOPACK_CI_TRIGGER = ''
  # Empty = the publisher baked into the release build: the real check.
  $env:SEI_VELOPACK_CI_PUBLISHER = ''
  $env:SEI_VELOPACK_CI_NOSTAGE = ''
  $env:SEI_VELOPACK_FEED = 'http://127.0.0.1:8765'
  $env:SEI_MIGRATION_FEED = 'http://127.0.0.1:8765'
  $env:SEI_MIGRATION_DELAY_MS = '3000'
  $env:SEI_MIGRATION_CI_ACTION = 'restart'
  $env:SEI_REPAIR_DELAY_MS = '3000'
  Remove-Item Env:SEI_SAFE_MODE -ErrorAction SilentlyContinue
}
function Launch([string]$exe) { $p = Start-Process -FilePath $exe -PassThru; $null = $p.Handle; $p }

# ------------------------------------------------------------------ 1. NSIS install of the base release
Stop-Sei
$sw = [Diagnostics.Stopwatch]::StartNew()
$p = Start-Process -FilePath (Join-Path $Rel 'base\Sei-win-x64.exe') -ArgumentList '/S' -PassThru
if (-not $p.WaitForExit(300000)) { throw 'base NSIS install timed out' }
$results.base_install_s = [math]::Round($sw.Elapsed.TotalSeconds, 1)
Start-Sleep -Seconds 3
Stop-Sei
$base = @(Entries | Where-Object { $_.Root -eq 'HKCU' }) | Select-Object -First 1
if (-not $base) { State 'after the base install'; throw 'no per-user NSIS entry after the base install' }
$results.base_version = $base.Version
$nsisDir = Split-Path -Parent ([regex]::Match($base.Uninstall, '^"([^"]+)"').Groups[1].Value)
$nsisExe = Join-Path $nsisDir 'Sei.exe'
$sig = Get-AuthenticodeSignature $nsisExe
$results.nsis_signature = "$($sig.Status) $($sig.SignerCertificate.Subject -replace ',.*$', '')"
if ($sig.Status -ne 'Valid') { Fail "the base NSIS Sei.exe is not validly signed ($($sig.Status)); this job needs signed releases" }
# First run, as a player would: creates userData.
$p = Launch $nsisExe; Start-Sleep -Seconds 25; Stop-Sei
New-Item -ItemType Directory -Force -Path $userData | Out-Null
$marker = Join-Path $userData 'e2e-marker.txt'; $token = [guid]::NewGuid().ToString(); Set-Content $marker $token
# The player opts into betas (Settings > Updates); that is advanced_updates in the profile config.
$cfgFile = Join-Path $userData 'profiles\local\config.json'
New-Item -ItemType Directory -Force -Path (Split-Path $cfgFile) | Out-Null
$cfg = if (Test-Path $cfgFile) { Get-Content $cfgFile -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }
$cfg | Add-Member -NotePropertyName advanced_updates -NotePropertyValue $true -Force
$cfg | ConvertTo-Json -Depth 20 | Set-Content $cfgFile -Encoding utf8
State "NSIS $($base.Version) installed (beta channel)"

# ------------------------------------------------------------------ 2. the NSIS update, as electron-updater runs it
$nsisUpdate = Join-Path $Rel 'nsis\Sei-win-x64.exe'
if (Test-Path $nsisUpdate) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $p = Start-Process -FilePath $nsisUpdate -ArgumentList '--updated', '/S' -PassThru
  if (-not $p.WaitForExit(300000)) { throw 'NSIS update timed out' }
  $results.nsis_update_s = [math]::Round($sw.Elapsed.TotalSeconds, 1)
  Start-Sleep -Seconds 3
  Stop-Sei
  $e = @(Entries | Where-Object { $_.Root -eq 'HKCU' }) | Select-Object -First 1
  $results.nsis_version = $e.Version
  if ($e.Version -eq $base.Version) { Fail "the NSIS update left the install at $($e.Version)" }
  $nsisDir = Split-Path -Parent ([regex]::Match($e.Uninstall, '^"([^"]+)"').Groups[1].Value)
  $nsisExe = Join-Path $nsisDir 'Sei.exe'
  State "NSIS updated to $($e.Version)"
} else {
  $results.nsis_version = $base.Version
}

# ------------------------------------------------------------------ 3. migration on for beta
Feed-Server
Put-Json 'releases.beta.json' ([pscustomobject]@{ Assets = @() })
Put-Setup 'from' $fromManifest
Put-Json 'migration.beta.json' ([pscustomobject]@{ percent = 100; epoch = 0 })
Set-Env 'none'
$t0 = Now
$p = Launch $nsisExe
$c = Need 'migration' 'migration-check' '' 120
$results.migration_check = $c.decision
if (-not $c.decision.ok) { Fail "the migration check said $($c.decision | ConvertTo-Json -Compress)"; Finish }
if ($c.channel -ne 'beta') { Fail "the migration read channel '$($c.channel)', expected beta" }
$s = Need 'migration' 'migration-signature' '' 400
$results.migration_signature = $s
if (-not $s.ok) { Fail "the signed Setup failed its signature check: $($s.reason)" }
if ($s.skipped) { Fail 'the Setup signature check was skipped: this build has no publisher baked in' }
$inst = Need 'migration' 'migration-installed' '' 400
$results.migration_install_ms = $inst.t - $c.t
$rs = Need 'migration' 'migration-restart' '' 60
$b = Need 'migration' 'boot' '' 120 ([scriptblock]::Create("param(`$e) `$e.velopackInstalled -and `$e.t -gt $($rs.t)"))
$results.migration_restart_to_boot_ms = $b.t - $rs.t
$done = Need 'migration' 'migration-done' '' 300
$results.migration_total_ms = $done.t - $t0
Start-Sleep -Seconds 3
State 'migrated'
if ((CurrentVersion) -ne $From) { Fail "the Velopack copy is $(CurrentVersion), expected $From" }
if (Test-Path $nsisExe) { Fail "the NSIS copy is still at $nsisDir" }
$hkcu = @(Entries | Where-Object { $_.Root -eq 'HKCU' })
if ($hkcu.Count -ne 1 -or $hkcu[0].Key -ne 'Sei') { Fail "expected only the Velopack entry, got: $(($hkcu | ForEach-Object { "$($_.Key) $($_.Version)" }) -join ', ')" }
if ((Get-Content $marker -Raw).Trim() -ne $token) { Fail 'userData marker lost in the migration' }
$sig = Get-AuthenticodeSignature "$root\current\Sei.exe"
$results.velopack_signature = "$($sig.Status)"
if ($sig.Status -ne 'Valid') { Fail "the installed Velopack Sei.exe is $($sig.Status)" }
Stop-Sei
Next-Step 'migration'

# ------------------------------------------------------------------ 4. a Velopack update to Target
$idx = Get-Content (Join-Path $Rel 'target\releases.beta.json') -Raw | ConvertFrom-Json
$assets = @($idx.Assets | Where-Object { $_.Version -eq $Target -and ($_.Type -eq 'Full' -or ($UseDelta -and $_.Type -eq 'Delta')) })
if (-not ($assets | Where-Object { $_.Type -eq 'Full' })) { throw "no $Target Full package in target\releases.beta.json" }
foreach ($a in $assets) {
  $src = Join-Path $Rel "target\$($a.FileName)"
  if (-not (Test-Path $src)) { throw "missing $($a.FileName)" }
  New-Item -ItemType HardLink -Path (Join-Path $feedDir $a.FileName) -Target $src | Out-Null
}
$results.feed_packages = @($assets | ForEach-Object { "$($_.Type) $([math]::Round($_.Size / 1MB, 1)) MB" })
Put-Json 'releases.beta.json' ([pscustomobject]@{ Assets = $assets })
# The release's publish moves setup.beta.json forward too; the repair below reads it.
Put-Setup 'target' $targetManifest
Set-Env 'restart'
$t1 = Now
$p = Launch "$root\current\Sei.exe"
$f = Need 'update' 'check-found' $From 180
$d = Need 'update' 'downloaded' $From 900
$sc = Mark 'signature-check' $From
$results.update_signature = $sc
if (-not $sc -or -not $sc.ok -or $sc.skipped) { Fail "the update's signature check did not pass for real: $($sc | ConvertTo-Json -Compress)" }
$d0 = Mark 'download-start' $From; $d1 = Mark 'download-done' $From; $st = Mark 'stage-done' $From
$results.update_download_ms = if ($d0 -and $d1) { $d1.t - $d0.t } else { $null }
$results.update_stage = if ($st) { "$($st.result) in $($st.ms) ms" } else { 'not run' }
$l = Need 'update' 'window-loaded' $Target 240 $isApp
$results.update_restart_to_loaded_ms = $l.t - $d.t
$results.update_check_to_loaded_ms = $l.t - $f.t
Start-Sleep -Seconds 3
if ((CurrentVersion) -ne $Target) { Fail "after the update the Velopack copy is $(CurrentVersion), expected $Target" }
State "updated to $Target"
Stop-Sei
Next-Step 'update'

# ------------------------------------------------------------------ 5. a forced self-repair (Update.exe deleted)
Remove-Item -LiteralPath (Join-Path $root 'Update.exe') -Force
Set-Env 'restart'
$t2 = Now
$p = Launch "$root\current\Sei.exe"
$i = Need 'repair' 'repair-init' $Target 120
if ($i.broken -ne 'update-exe-missing') { Fail "repair-init saw '$($i.broken)', expected update-exe-missing" }
$h = Need 'repair' 'repair-handoff' $Target 600
$rsig = Mark 'repair-signature' $Target
$results.repair_signature = $rsig
if (-not $rsig -or -not $rsig.ok -or $rsig.skipped) { Fail "the repair Setup's signature check did not pass for real: $($rsig | ConvertTo-Json -Compress)" }
$r = Need 'repair' 'repair-result' $Target 600 { param($e) $e.pid -ne $h.pid }
$results.repair_result = $r.result
$results.repair_report = $r.reports
if ($r.result -ne 'setup-exit 0') { Fail "the repair Setup ended: $($r.result)" }
elseif (-not $r.reports -or @($r.reports)[0].phase -ne 'repaired') { Fail "no repaired report: $($r.reports | ConvertTo-Json -Compress -Depth 4)" }
$l2 = Need 'repair' 'window-loaded' $Target 240 ([scriptblock]::Create("param(`$e) `$e.pid -ne $($h.pid) -and `$e.url -and -not (`$e.url -like 'data:*')"))
$results.repair_handoff_ms = $h.t - $t2
$results.repair_handoff_to_loaded_ms = $l2.t - $h.t
Start-Sleep -Seconds 3
if (-not (Test-Path (Join-Path $root 'Update.exe'))) { Fail 'Update.exe still missing after the repair' }
if ((CurrentVersion) -ne $Target) { Fail "after the repair the Velopack copy is $(CurrentVersion), expected $Target" }
if ((Get-Content $marker -Raw).Trim() -ne $token) { Fail 'userData marker lost in the repair' }
if ((SeiProcs).Count -lt 1) { Fail 'no Sei running after the repair' }
Finish
