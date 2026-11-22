/**
 * The PowerShell runner a Velopack self-repair hands off to (velopackRepair.ts).
 *
 * Velopack's Setup stops every process running from the install folder before
 * it renames the folder aside, so it cannot be started by Sei and waited on:
 * the waiter has to live outside the install and outside Sei's process tree.
 * Sei writes this script and runner.json into the repair's %TEMP% folder and
 * starts it as an ordinary child. Node puts its children in a kill-on-close
 * job, and powershell.exe started as a DETACHED_PROCESS exits at once without
 * running anything (measured for update-progress.ps1), so the first stage
 * only starts the real runner as a grandchild (which leaves the job) and
 * exits 0. The runner then:
 *
 *   1. writes `started` (its pid) so Sei knows it may quit,
 *   2. waits for Sei to exit (60 s cap; Setup stops a Sei that is stuck),
 *      and leaves if Sei wrote `cancel` or runner.json is gone (Sei gave up
 *      waiting and stays open),
 *   3. checks the Setup's sha256 again,
 *   4. runs `Setup.exe --silent --installto <root> --log <dir>\setup.log`
 *      and waits for it (20 min cap),
 *   5. writes `result.txt` (`setup-exit <code>`, or why it did not run),
 *      BEFORE it starts Sei, so the started Sei reads the result instead of
 *      seeing a repair still running,
 *   6. starts <root>\current\Sei.exe without SEI_SAFE_MODE: the repaired
 *      copy, or the old one when Setup failed and renamed it back.
 *
 * ASCII only and cmdlets rather than .NET calls where it can (Windows
 * PowerShell 5.1 reads a BOM-less script as ANSI; a locked-down machine may
 * run it in ConstrainedLanguage mode). runner.json is pure ASCII too
 * (runnerConfigJson escapes everything else as \uXXXX) and is read as UTF-8,
 * so a user name like JosÃ© or æµ‹è¯• in the paths survives either way.
 */

export const RUNNER_SCRIPT = 'sei-repair-runner.ps1';
export const RUNNER_CONFIG = 'runner.json';
/** The Setup's file name in the repair folder; the progress window watches its process name. */
export const REPAIR_SETUP_FILE = 'sei-repair-setup.exe';

export interface RunnerConfig {
  setup: string;
  sha256: string;
  root: string;
  waitPid: number;
}

/** runner.json's text: JSON with every non-ASCII character escaped, so any decoding reads the same paths. */
export function runnerConfigJson(cfg: RunnerConfig): string {
  return JSON.stringify(cfg).replace(/[\u007f-\uffff]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export const REPAIR_RUNNER_PS1 = String.raw`# Sei Velopack self-repair runner (src/main/velopackRepairRunner.ts).
param([Parameter(Mandatory = $true)][string]$Dir, [switch]$Detached)
$ErrorActionPreference = 'Continue'
$logFile = Join-Path $Dir 'runner.log'
function Log([string]$m) { try { Add-Content -LiteralPath $logFile -Value ((Get-Date -Format o) + ' ' + $m) -Encoding ascii } catch { } }
function Put([string]$name, [string]$text) { try { Set-Content -LiteralPath (Join-Path $Dir $name) -Value $text -Encoding ascii } catch { Log ('could not write ' + $name + ': ' + $_.Exception.Message) } }

if (-not $Detached) {
  $exe = Join-Path $PSHOME 'powershell.exe'
  $argv = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -Dir "{1}" -Detached' -f $PSCommandPath, $Dir
  try {
    Start-Process -FilePath $exe -ArgumentList $argv -WindowStyle Hidden -WorkingDirectory $Dir -ErrorAction Stop
    Log 'stage 1: started the runner'
    exit 0
  } catch {
    Log ('stage 1 failed: ' + $_.Exception.Message)
    exit 1
  }
}

Put 'started' ([string]$PID)
Log ('runner pid ' + $PID)
$cfgFile = Join-Path $Dir 'runner.json'
$cancel = Join-Path $Dir 'cancel'
# Sei gave up on this runner (cancel written, or its folder emptied): do nothing.
function Cancelled { (Test-Path -LiteralPath $cancel) -or -not (Test-Path -LiteralPath $cfgFile) }
if (Cancelled) { Log 'cancelled before start'; exit 0 }
$raw = $null
try { $raw = [System.IO.File]::ReadAllText($cfgFile, [System.Text.Encoding]::UTF8) } catch { }
if ($null -eq $raw) { try { $raw = Get-Content -LiteralPath $cfgFile -Raw -Encoding UTF8 -ErrorAction Stop } catch { Log ('runner.json unreadable: ' + $_.Exception.Message); exit 0 } }
$cfg = $raw | ConvertFrom-Json
$exe = Join-Path ([string]$cfg.root) 'current\Sei.exe'

function Relaunch {
  Remove-Item Env:SEI_SAFE_MODE -ErrorAction SilentlyContinue
  if (-not (Test-Path -LiteralPath $exe)) { Log ('nothing to start at ' + $exe); return }
  try {
    Start-Process -FilePath $exe -WorkingDirectory (Split-Path -Parent $exe) -ErrorAction Stop
    Log ('started ' + $exe)
  } catch {
    Log ('could not start Sei: ' + $_.Exception.Message)
  }
}

$waited = 0
while ($waited -lt 600) {
  if (Cancelled) { Log 'cancelled by Sei'; exit 0 }
  if (-not (Get-Process -Id ([int]$cfg.waitPid) -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Milliseconds 100
  $waited++
}
if (Cancelled) { Log 'cancelled by Sei'; exit 0 }
Log ('Sei gone after ' + ($waited * 100) + ' ms')
Start-Sleep -Milliseconds 500
if (Cancelled) { Log 'cancelled by Sei'; exit 0 }

$hash = ''
try { $hash = (Get-FileHash -LiteralPath ([string]$cfg.setup) -Algorithm SHA256 -ErrorAction Stop).Hash } catch { Log ('hash failed: ' + $_.Exception.Message) }
if ($hash -ne [string]$cfg.sha256) {
  Log ('sha256 mismatch: ' + $hash)
  Put 'result.txt' 'hash-mismatch'
  Relaunch
  exit 0
}

$argList = '--silent --installto "{0}" --log "{1}"' -f ([string]$cfg.root), (Join-Path $Dir 'setup.log')
$p = $null
for ($i = 0; $i -lt 6 -and -not $p; $i++) {
  try {
    $p = Start-Process -FilePath ([string]$cfg.setup) -ArgumentList $argList -WorkingDirectory $Dir -PassThru -ErrorAction Stop
  } catch {
    Log ('Setup did not start: ' + $_.Exception.Message)
    Start-Sleep -Seconds 2
  }
}
if (-not $p) {
  Put 'result.txt' 'setup-start-failed'
  Relaunch
  exit 0
}
$null = $p.Handle
Log ('Setup pid ' + $p.Id + ': ' + $argList)
try { Wait-Process -Id $p.Id -Timeout 1200 -ErrorAction Stop } catch { Log ('wait: ' + $_.Exception.Message) }
if (-not $p.HasExited) {
  # Still installing: starting Sei now would fight Setup for the folder.
  Log 'Setup still running after 20 min'
  Put 'result.txt' 'setup-timeout'
  exit 0
}
Log ('Setup exit ' + $p.ExitCode)
Put 'result.txt' ('setup-exit ' + $p.ExitCode)
Relaunch
`;

/** Arguments for the first stage (Windows PowerShell 5.1). */
export function runnerArgs(scriptPath: string, dir: string): string[] {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Dir', dir];
}




