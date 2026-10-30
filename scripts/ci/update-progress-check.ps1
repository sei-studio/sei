# CI check + recording for the Windows update progress window (261030).
#
# Run by .github/workflows/nsis-upgrade-check.yml under Windows PowerShell 5.1
# on windows-latest. Records the desktop with ffmpeg gdigrab, takes stills,
# and asserts the window's contract:
#   - it is up (first frame) within the app's ready budget: 12 s (READY_TIMEOUT_MS),
#     20 s once WPF has loaded (READY_LOADED_CAP_MS); past 12 s is noted,
#   - it closes itself once the new Sei shows a window (outcome 'reopened'),
#   - its fonts resolved to the bundled Oswald / Rajdhani files,
#   - no runtime errors in its timers,
#   - in upgrade mode: the real one-click installer run silently under it
#     shows no window, and Sei comes back.
#
# Modes:
#   preview  stand-in installer + stand-in Sei (compiled here), quick, used
#            for the theme/language stills. -Blocked sets a machine
#            ExecutionPolicy (what a Group Policy does) and expects the
#            launcher to report not-ready, i.e. the stock installer fallback.
#   upgrade  the real stable release installed per-user, the real old Sei
#            running, and the new installer started exactly as
#            electron-updater does on quitAndInstall(true, true).
#
# Keep it ASCII (5.1 reads BOM-less scripts in the ANSI code page).
param(
  [ValidateSet('preview', 'upgrade')][string]$Mode = 'preview',
  [string]$Theme = 'midnight',
  [string]$Lang = 'en',
  [int]$FakeInstallSeconds = 60,
  [string]$History = '',
  [switch]$ReducedMotion,
  [switch]$Blocked,
  [string]$Driver = 'upl.cjs',
  [string]$Resources = 'resources\update-progress',
  [string]$NewInstaller = '',
  [string]$OldInstaller = '',
  [string]$OutDir = 'progress-out'
)

$ErrorActionPreference = 'Stop'
$failures = New-Object 'System.Collections.Generic.List[string]'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$OutDir = (Resolve-Path $OutDir).Path
$shots = Join-Path $OutDir 'shots'
New-Item -ItemType Directory -Force -Path $shots | Out-Null
$Driver = (Resolve-Path $Driver).Path
$Resources = (Resolve-Path $Resources).Path
$timeline = Join-Path $OutDir 'timeline.txt'
function Note([string]$m) { Write-Host $m; Add-Content -Path $timeline -Value $m }
function Fail([string]$m) { $failures.Add($m); Write-Host "FAIL: $m" }

Add-Type -AssemblyName System.Windows.Forms, System.Drawing

# ---- display: 1920x1080 when the virtual adapter allows it ------------------------
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SeiCiDisplay {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
  public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
    public short dmSpecVersion; public short dmDriverVersion; public short dmSize; public short dmDriverExtra; public int dmFields;
    public int dmPositionX; public int dmPositionY; public int dmDisplayOrientation; public int dmDisplayFixedOutput;
    public short dmColor; public short dmDuplex; public short dmYResolution; public short dmTTOption; public short dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
    public short dmLogPixels; public int dmBitsPerPel; public int dmPelsWidth; public int dmPelsHeight; public int dmDisplayFlags; public int dmDisplayFrequency;
    public int dmICMMethod; public int dmICMIntent; public int dmMediaType; public int dmDitherType; public int dmReserved1; public int dmReserved2; public int dmPanningWidth; public int dmPanningHeight;
  }
  [DllImport("user32.dll", CharSet = CharSet.Ansi)] static extern bool EnumDisplaySettings(string d, int mode, ref DEVMODE dm);
  [DllImport("user32.dll", CharSet = CharSet.Ansi)] static extern int ChangeDisplaySettings(ref DEVMODE dm, int flags);
  [DllImport("user32.dll")] static extern bool SystemParametersInfo(uint action, uint ui, IntPtr pv, uint winIni);
  public static int Set(int w, int h) {
    DEVMODE dm = new DEVMODE(); dm.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
    if (!EnumDisplaySettings(null, -1, ref dm)) return -99;
    dm.dmPelsWidth = w; dm.dmPelsHeight = h; dm.dmFields = 0x80000 | 0x100000;
    return ChangeDisplaySettings(ref dm, 0);
  }
  // SPI_SETCLIENTAREAANIMATION: Settings > Accessibility > Animation effects.
  public static bool SetAnimations(bool on) { return SystemParametersInfo(0x1043, 0, on ? (IntPtr)1 : IntPtr.Zero, 3); }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, System.Text.StringBuilder sb, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, System.Text.StringBuilder sb, int n);
  // Visible with a real on-screen area: what a user would actually see.
  public static bool Shows(IntPtr h) {
    if (h == IntPtr.Zero || !IsWindowVisible(h)) return false;
    RECT r; if (!GetWindowRect(h, out r)) return false;
    return (r.Right - r.Left) > 4 && (r.Bottom - r.Top) > 4 && r.Right > 0 && r.Bottom > 0;
  }
  public static int[] Rect(IntPtr h) {
    RECT r; if (h == IntPtr.Zero || !GetWindowRect(h, out r)) return null;
    return new int[] { r.Left, r.Top, r.Right, r.Bottom };
  }
  public static string Describe(IntPtr h) {
    if (h == IntPtr.Zero) return "none";
    var c = new System.Text.StringBuilder(256); GetClassName(h, c, 256);
    var t = new System.Text.StringBuilder(256); GetWindowText(h, t, 256);
    RECT r; GetWindowRect(h, out r);
    return string.Format("class={0} title='{1}' visible={2} rect={3},{4} {5}x{6}", c, t, IsWindowVisible(h), r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top);
  }
}
'@
try { Note "display change result: $([SeiCiDisplay]::Set(1920, 1080))" } catch { Note "display change failed: $($_.Exception.Message)" }
Start-Sleep -Seconds 2
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
Note "screen: $($bounds.Width)x$($bounds.Height)"
# Runner VMs ship with client-area animations OFF, which reads as reduced
# motion; set it explicitly either way so the video shows what was meant.
Note "client-area animations $(if ($ReducedMotion) { 'off' } else { 'on' }): $([SeiCiDisplay]::SetAnimations(-not $ReducedMotion))"

function Shot([string]$name) {
  try {
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
    $bmp.Save((Join-Path $shots "$name.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
  } catch { Note "screenshot failed: $_" }
}

# ---- recording ---------------------------------------------------------------------
function Start-Recording([string]$file) {
  $ff = Get-Command ffmpeg -ErrorAction SilentlyContinue
  if (-not $ff) { Note 'ffmpeg missing: no video'; return $null }
  $psi = New-Object Diagnostics.ProcessStartInfo $ff.Source
  $psi.Arguments = "-hide_banner -loglevel error -y -f gdigrab -framerate 24 -draw_mouse 0 -i desktop -c:v libx264 -preset veryfast -crf 24 -pix_fmt yuv420p `"$file`""
  $psi.UseShellExecute = $false
  $psi.RedirectStandardInput = $true
  $psi.CreateNoWindow = $true
  $p = [Diagnostics.Process]::Start($psi)
  Start-Sleep -Seconds 2
  return $p
}
function Stop-Recording($p) {
  if (-not $p) { return }
  try { $p.StandardInput.Write('q'); $p.StandardInput.Flush() } catch { }
  if (-not $p.WaitForExit(30000)) { try { $p.Kill() } catch { } }
}

# ---- stand-in apps (preview) -----------------------------------------------------
$fake = 'C:\sei-ci-fake'
function Build-Fakes {
  New-Item -ItemType Directory -Force -Path $fake | Out-Null
  Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -OutputAssembly "$fake\Sei.exe" -OutputType WindowsApplication -TypeDefinition @'
using System; using System.Drawing; using System.Windows.Forms;
public static class SeiCiFakeApp {
  [STAThread] public static void Main(string[] a) {
    Form f = new Form();
    f.Text = a.Length > 0 ? a[0] : "Sei";
    f.Width = 1100; f.Height = 680; f.StartPosition = FormStartPosition.CenterScreen;
    f.BackColor = Color.FromArgb(10, 14, 24);
    Label l = new Label(); l.Text = f.Text + " (CI stand-in for the Sei window)"; l.ForeColor = Color.FromArgb(200, 210, 230);
    l.AutoSize = true; l.Font = new Font("Segoe UI", 16); l.Location = new Point(36, 32); f.Controls.Add(l);
    Application.Run(f);
  }
}
'@
  Add-Type -OutputAssembly "$fake\Sei-win-x64.exe" -OutputType WindowsApplication -TypeDefinition @'
using System; using System.Diagnostics; using System.IO; using System.Threading;
public static class SeiCiFakeInstaller {
  public static int Main(string[] a) {
    int secs = 60; int.TryParse(Environment.GetEnvironmentVariable("FAKE_INSTALL_SECONDS"), out secs);
    Process me = Process.GetCurrentProcess();
    string app = Path.Combine(Path.GetDirectoryName(me.MainModule.FileName), "Sei.exe");
    Thread.Sleep(1500);
    foreach (Process p in Process.GetProcessesByName("Sei")) { try { if (p.StartTime < me.StartTime) p.Kill(); } catch { } }
    Thread.Sleep(Math.Max(0, secs * 1000 - 1500 - 6000));
    Process.Start(app);
    Thread.Sleep(6000);
    return 0;
  }
}
'@
  Note "stand-ins built in $fake"
}

function Stop-Sei { Get-Process -Name 'Sei' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 2 }

# ---- setup per mode -------------------------------------------------------------
$version = '0.7.0'
if ($Mode -eq 'preview') {
  Build-Fakes
  $installerExe = "$fake\Sei-win-x64.exe"
  $appExe = "$fake\Sei.exe"
  $installerArgs = @()
  $env:FAKE_INSTALL_SECONDS = [string]$FakeInstallSeconds
} else {
  if (-not $OldInstaller -or -not $NewInstaller) { throw 'upgrade mode needs -OldInstaller and -NewInstaller' }
  $OldInstaller = (Resolve-Path $OldInstaller).Path
  $NewInstaller = (Resolve-Path $NewInstaller).Path
  Note "installing the stable release per-user: $OldInstaller /S"
  $p = Start-Process -FilePath $OldInstaller -ArgumentList '/S' -PassThru
  if (-not $p.WaitForExit(300000)) { $p | Stop-Process -Force; throw 'the stable installer did not finish in 5 minutes' }
  $appExe = Join-Path $env:LOCALAPPDATA 'Programs\Sei\Sei.exe'
  if (-not (Test-Path $appExe)) { $appExe = Join-Path $env:LOCALAPPDATA 'Programs\sei\Sei.exe' }
  if (-not (Test-Path $appExe)) { throw "no installed Sei.exe under $env:LOCALAPPDATA\Programs" }
  Note "installed: $appExe"
  $installerExe = $NewInstaller
  # Exactly what NsisUpdater spawns for quitAndInstall(true, true).
  $installerArgs = @('--updated', '/S', '--force-run')
  $version = '0.6.10'
}

if ($Blocked) {
  # A machine ExecutionPolicy beats -ExecutionPolicy Bypass (Group Policy).
  $polKey = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\PowerShell'
  New-Item -Path $polKey -Force | Out-Null
  New-ItemProperty -Path $polKey -Name EnableScripts -Value 1 -PropertyType DWord -Force | Out-Null
  New-ItemProperty -Path $polKey -Name ExecutionPolicy -Value 'Restricted' -PropertyType String -Force | Out-Null
  Note 'machine policy: ExecutionPolicy Restricted'
}

# ---- run -----------------------------------------------------------------------
$video = Join-Path $OutDir 'update-progress.mp4'
$rec = Start-Recording $video
Stop-Sei
$old = if ($Mode -eq 'preview') { Start-Process -FilePath $appExe -ArgumentList 'Sei' -PassThru } else { Start-Process -FilePath $appExe -PassThru }
Start-Sleep -Seconds $(if ($Mode -eq 'upgrade') { 20 } else { 4 })
Note "old Sei running: $(-not $old.HasExited)"
Shot '000-before-click'

$sw = [Diagnostics.Stopwatch]::StartNew()
$driverArgs = @($Driver, '--installer', $installerExe, '--app', $appExe, '--theme', $Theme, '--lang', $Lang,
  '--version', $version, '--resources', $Resources, '--out', (Join-Path $OutDir 'driver.json'))
if ($History) { $driverArgs += @('--history', $History) }
& node @driverArgs | Out-Host
$driverExit = $LASTEXITCODE
$drv = Get-Content (Join-Path $OutDir 'driver.json') -Raw | ConvertFrom-Json
Note ("click -> launcher answer: {0} ms, ready={1} reason='{2}' estimate={3}s" -f $drv.ms, $drv.ready, $drv.reason, $drv.estimateSec)

if ($Blocked) {
  if ($drv.ready) { Fail 'the window came up although PowerShell scripts are blocked by policy' }
  elseif ($drv.ms -gt 3000) { Fail "the blocked launch took $($drv.ms) ms to fall back" }
  elseif ($drv.reason -notmatch 'exited early') { Fail "expected the policy to stop the script outright, got '$($drv.reason)'" }
  else { Note "fallback OK: '$($drv.reason)' after $($drv.ms) ms (the app would now run the stock installer window)" }
  $left = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*update-progress.ps1*' })
  if ($left.Count -gt 0) { Fail 'a helper process is still running after the fallback' }
  Remove-Item -Path 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\PowerShell' -Recurse -Force -ErrorAction SilentlyContinue
  Shot '001-fallback'
  Stop-Sei
  Stop-Recording $rec
  if ($drv.dir -and (Test-Path $drv.dir)) { Get-ChildItem $drv.dir -File | Where-Object { $_.Name -match '\.(log|json)$' } | Copy-Item -Destination $OutDir }
  if ($failures.Count -gt 0) { $failures | ForEach-Object { "::error::$_" }; exit 1 }
  'PASS: blocked -> fallback'
  exit 0
}

if (-not $drv.ready) {
  Fail "the progress window did not come up: $($drv.reason)"
  $p = $null
  # Diagnose: run the same script attached, with its output captured.
  if ($drv.dir -and (Test-Path (Join-Path $drv.dir 'update-progress.ps1'))) {
    $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $so = Join-Path $OutDir 'direct-stdout.txt'; $se = Join-Path $OutDir 'direct-stderr.txt'
    $dp = Start-Process -FilePath $ps -PassThru -WindowStyle Hidden -RedirectStandardOutput $so -RedirectStandardError $se -ArgumentList @(
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA', '-File',
      ('"{0}"' -f (Join-Path $drv.dir 'update-progress.ps1')), '-ConfigPath', ('"{0}"' -f (Join-Path $drv.dir 'config.json')))
    $null = $dp.Handle
    if (-not $dp.WaitForExit(10000)) { Note 'direct run: still running after 10 s (killed)'; Stop-Process -Id $dp.Id -Force -ErrorAction SilentlyContinue }
    else { Note "direct run: exit $($dp.ExitCode)" }
    foreach ($f in @($so, $se)) { if (Test-Path $f) { Get-Content $f | Select-Object -First 30 | ForEach-Object { Note "  $(Split-Path -Leaf $f): $_" } } }
    if (Test-Path (Join-Path $drv.dir 'helper.log')) { Get-Content (Join-Path $drv.dir 'helper.log') | Select-Object -First 30 | ForEach-Object { Note "  helper.log: $_" } }
  }
} else {
  if ($drv.ms -gt 20000) { Fail "first frame took $($drv.ms) ms (cap 20000)" }
  elseif ($drv.ms -gt 12000) { Note "slow first frame: $($drv.ms) ms, inside the 20 s cap for a window that had loaded WPF" }
  $helper = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like "*$(Split-Path -Leaf $drv.dir)*" } | Select-Object -First 1
  $hp = if ($helper) { Get-Process -Id $helper.ProcessId -ErrorAction SilentlyContinue } else { $null }
  if (-not $hp) { Fail 'cannot find the helper process' }
  Note "helper pid: $($helper.ProcessId)"
  # Sei quitting into the installer: spawn it detached, then the app quits.
  $installStart = Get-Date
  $p = if ($installerArgs.Count -gt 0) { Start-Process -FilePath $installerExe -ArgumentList $installerArgs -PassThru } else { Start-Process -FilePath $installerExe -PassThru }
  $null = $p.Handle
  Note ("installer started at {0:n1}s with: {1}" -f $sw.Elapsed.TotalSeconds, ($installerArgs -join ' '))
  # quitAndInstall: the installer is spawned, then the app quits (about a
  # second for Sei's before-quit work). Its own one-click check would kill a
  # straggler after 1.3 s anyway.
  Start-Sleep -Milliseconds 800
  if ($Mode -eq 'upgrade') { Get-Process -Name 'Sei' -ErrorAction SilentlyContinue | Where-Object { $_.StartTime -lt $installStart } | Stop-Process -Force -ErrorAction SilentlyContinue }
}

$ev = [ordered]@{}
function Mark([string]$k) { if (-not $ev.Contains($k)) { $ev[$k] = [math]::Round($sw.Elapsed.TotalSeconds, 1); Note ("{0,7:n1}s  {1}" -f $ev[$k], $k) } }
if ($drv.ready) { $ev['window'] = [math]::Round($drv.ms / 1000.0, 1); Note ("{0,7:n1}s  window (first frame)" -f $ev['window']) }
$otherWindows = @{}
$helperRect = $null
$installerWindows = @{}; $installerShot = $false
$nextShot = 0; $i = 1
while ($p -and $sw.Elapsed.TotalSeconds -lt 600) {
  $t = $sw.Elapsed.TotalSeconds
  if ($hp) {
    $hp.Refresh()
    if (-not $hp.HasExited -and $hp.MainWindowHandle -ne [IntPtr]::Zero) {
      Mark 'helper window visible'
      if (-not $helperRect -and [SeiCiDisplay]::Shows($hp.MainWindowHandle)) { $helperRect = [SeiCiDisplay]::Rect($hp.MainWindowHandle) }
    }
    if ($hp.HasExited) { Mark 'helper exited' }
  }
  $p.Refresh()
  if (-not $p.HasExited -and $p.MainWindowHandle -ne [IntPtr]::Zero) {
    # .NET reports a handle for any unowned visible window, including NSIS's
    # zero-size/off-screen helper windows under /S. Log every one; fail only on a
    # window with real on-screen area.
    $desc = [SeiCiDisplay]::Describe($p.MainWindowHandle)
    if (-not $installerWindows.ContainsKey($desc)) { $installerWindows[$desc] = 1; Note ("{0,7:n1}s  installer window handle: {1}" -f $t, $desc) }
    if ([SeiCiDisplay]::Shows($p.MainWindowHandle)) { Mark 'INSTALLER WINDOW (should not show)'; if (-not $installerShot) { Shot 'installer-window'; $installerShot = $true } }
  }
  if ($p.HasExited) { Mark 'installer exited' }
  $new = @(Get-Process -Name 'Sei' -ErrorAction SilentlyContinue | Where-Object { try { $_.StartTime -gt $installStart } catch { $false } })
  if ($new.Count -gt 0) { Mark 'new Sei process' }
  if (@($new | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero }).Count -gt 0) { Mark 'new Sei window' }
  Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero -and $_.ProcessName -notin @('Sei', 'powershell', 'ffmpeg', 'explorer') -and $_.Id -ne $p.Id } | ForEach-Object {
    if ($_.MainWindowTitle -match 'Sei|Setup|Install|Uninstall' -and -not $otherWindows.ContainsKey("$($_.ProcessName): $($_.MainWindowTitle)")) {
      $otherWindows["$($_.ProcessName): $($_.MainWindowTitle)"] = [math]::Round($t, 1)
    }
  }
  if ($t -ge $nextShot -and -not $ev.Contains('helper exited')) {
    Shot ('{0:d3}-{1:n1}s' -f $i, $t); $i++
    $nextShot = $t + 3
  }
  if ($ev.Contains('helper exited') -and $t -gt $ev['helper exited'] + 3) { break }
  if ((-not $hp -or $hp.HasExited) -and $p.HasExited -and $t -gt 400) { break }
  Start-Sleep -Milliseconds 200
}
Shot 'zz-after'
Stop-Recording $rec

# ---- collect + assert ------------------------------------------------------------
if ($drv.dir -and (Test-Path $drv.dir)) {
  Get-ChildItem $drv.dir -File | Where-Object { $_.Name -match '\.(log|json)$' } | Copy-Item -Destination $OutDir
}
$log = Join-Path $OutDir 'helper.log'
if (Test-Path $log) { '----- helper.log -----'; Get-Content $log | Select-Object -First 200 }
$res = $null
if (Test-Path (Join-Path $OutDir 'result.json')) { $res = Get-Content (Join-Path $OutDir 'result.json') -Raw | ConvertFrom-Json; "result: $($res | ConvertTo-Json -Compress)" }

if ($drv.ready) {
  if (-not $ev.Contains('helper window visible')) { Fail 'the helper window was never visible' }
  if (-not $res) { Fail 'no result.json' } elseif ($res.outcome -ne 'reopened') { Fail "helper outcome '$($res.outcome)', expected 'reopened'" }
  if (-not $ev.Contains('new Sei window')) { Fail 'Sei did not come back with a window' }
  if ($ev.Contains('new Sei window') -and $ev.Contains('helper exited')) {
    $gap = $ev['helper exited'] - $ev['new Sei window']
    Note ("helper closed {0:n1}s after the new Sei window" -f $gap)
    if ($gap -gt 6) { Fail "the helper stayed up $gap s after Sei was back" }
  } elseif (-not $ev.Contains('helper exited')) { Fail 'the helper never exited' }
  # Placement (261031): the card (the window minus its 30 px shadow margin;
  # the runner is at 100% scale) sits in the bottom-right corner of the
  # primary work area, inside it, a small gap from the right and bottom edges.
  $wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  if (-not $helperRect) { Fail 'could not read the helper window rect' } else {
    $cardR = $helperRect[2] - 30; $cardB = $helperRect[3] - 30
    $gapR = $wa.Right - $cardR; $gapB = $wa.Bottom - $cardB
    Note ("helper window rect {0},{1}-{2},{3}; work area {4},{5}-{6},{7}; card gap right {8} bottom {9}" -f $helperRect[0], $helperRect[1], $helperRect[2], $helperRect[3], $wa.Left, $wa.Top, $wa.Right, $wa.Bottom, $gapR, $gapB)
    if ($gapR -lt 4 -or $gapR -gt 40 -or $gapB -lt 4 -or $gapB -gt 40) { Fail "the progress window is not in the bottom-right corner of the work area (card gap right $gapR, bottom $gapB)" }
  }
  if ($ev.Contains('INSTALLER WINDOW (should not show)')) { Fail 'the installer showed a window under the progress window' }
  if ($otherWindows.Count -gt 0) { $otherWindows.GetEnumerator() | ForEach-Object { Fail "another window showed: $($_.Key) at $($_.Value)s" } }
  if ($p.HasExited -and $p.ExitCode -ne 0) { Fail "installer exit code $($p.ExitCode)" }
  if (Test-Path $log) {
    $fontLines = @(Select-String -Path $log -Pattern '^\s*[\d.]+s font ')
    if ($fontLines.Count -lt 3) { Fail 'helper.log has no font lines' }
    foreach ($fl in $fontLines) { if ($fl.Line -notmatch 'sei-(oswald|rajdhani)-\d+\.ttf') { Fail "font not the bundled file: $($fl.Line.Trim())" } }
    $errs = @(Select-String -Path $log -Pattern '^\s*[\d.]+s (frame|watch|rendered|placement|run|xaml failed|init failed|icon|logo|start app): ')
    foreach ($e in $errs) { Fail "helper runtime error: $($e.Line.Trim())" }
  } else { Fail 'no helper.log' }
}

$summary = @("### update progress window: $Mode $Theme/$Lang$(if ($ReducedMotion) { ' (reduced motion)' })", '', '| event | seconds after click |', '|---|---|')
foreach ($k in $ev.Keys) { $summary += "| $k | $($ev[$k]) |" }
if ($env:GITHUB_STEP_SUMMARY) { $summary | Add-Content -Path $env:GITHUB_STEP_SUMMARY }
$summary | Add-Content -Path $timeline
Stop-Sei
if ($ReducedMotion) { $null = [SeiCiDisplay]::SetAnimations($true) }

if ($failures.Count -gt 0) {
  '::group::FAILURES'
  $failures | ForEach-Object { "::error::$_" }
  '::endgroup::'
  exit 1
}
"PASS: $Mode $Theme/$Lang"
