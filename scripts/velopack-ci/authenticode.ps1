# Authenticode checks for Windows updates (261031), run by the authenticode job
# in velopack-update.yml under Windows PowerShell 5.1, the PowerShell Sei
# itself runs the check in.
#
# Makes signed, unsigned, tampered and someone-else-signed executables and
# packages in a folder with Chinese characters and a space in its name, then
# runs scripts/velopack-ci/authenticode-check.mjs, which puts each case through
# the app's own code (src/main/velopackSignature.ts + winPowerShell.ts) and
# compares the verdict with the expected one. With -Feed it also checks the
# real CI-built package: as built (unsigned, so both entries must be found and
# rejected) and re-signed with the test certificate (accepted).
param([string]$Feed = '')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$publisher = 'Sei CI Test Signer'
$publisherDn = 'CN=Sei CI Test Signer, O=Sei CI'
# C:\...\sig 测试: a space and two Chinese characters
$work = Join-Path $env:RUNNER_TEMP ('sig ' + [char]0x6D4B + [char]0x8BD5)
New-Item -ItemType Directory -Force -Path $work | Out-Null
$testsign = Join-Path $PSScriptRoot 'testsign.ps1'

function TestSign([string[]]$files, [string]$package = '') {
  $env:SEI_TESTSIGN_FILES = ($files -join "`n")
  $env:SEI_TESTSIGN_PACKAGE = $package
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $testsign
  if ($LASTEXITCODE -ne 0) { throw "testsign.ps1 failed ($LASTEXITCODE)" }
  $env:SEI_TESTSIGN_FILES = ''; $env:SEI_TESTSIGN_PACKAGE = ''
}

# ---------------------------------------------------------------- executables
$plain = Join-Path $work 'plain.exe'
Add-Type -TypeDefinition 'public static class SeiCiPlain { public static void Main() { } }' -OutputAssembly $plain -OutputType ConsoleApplication
$signed = Join-Path $work 'signed.exe'; Copy-Item -LiteralPath $plain $signed
$signed2 = Join-Path $work 'signed-squirrel.exe'; Copy-Item -LiteralPath $plain $signed2
$unsigned = Join-Path $work 'unsigned.exe'; Copy-Item -LiteralPath $plain $unsigned
$tampered = Join-Path $work 'tampered.exe'; Copy-Item -LiteralPath $plain $tampered
TestSign @($signed, $signed2, $tampered)
# One byte inside the code section after signing: the signature no longer covers the file.
$bytes = [System.IO.File]::ReadAllBytes($tampered)
$bytes[0x300] = $bytes[0x300] -bxor 0xFF
[System.IO.File]::WriteAllBytes($tampered, $bytes)
# Validly signed, by someone else (node.exe is signed by the OpenJS Foundation).
$other = Join-Path $work 'other.exe'
Copy-Item -LiteralPath (Get-Command node).Source $other

foreach ($f in $signed, $unsigned, $tampered, $other) {
  $s = Get-AuthenticodeSignature -LiteralPath $f
  Write-Host ('{0,-20} {1,-14} {2}' -f (Split-Path -Leaf $f), $s.Status, $s.SignerCertificate.Subject)
}

# ---------------------------------------------------------------- packages
function New-Package([string]$name, [hashtable]$entries) {
  $path = Join-Path $work $name
  if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path }
  $zip = [System.IO.Compression.ZipFile]::Open($path, [System.IO.Compression.ZipArchiveMode]::Create)
  try {
    foreach ($k in $entries.Keys) { [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $entries[$k], $k) | Out-Null }
  } finally { $zip.Dispose() }
  $path
}
$nuspec = Join-Path $work 'Sei.nuspec'; Set-Content -LiteralPath $nuspec '<package />'
$good = New-Package 'good.nupkg' @{ 'Sei.nuspec' = $nuspec; 'lib/app/Sei.exe' = $signed; 'lib/app/Squirrel.exe' = $signed2 }
$noSquirrel = New-Package 'no-squirrel.nupkg' @{ 'lib/app/Sei.exe' = $signed }
$badSquirrel = New-Package 'unsigned-squirrel.nupkg' @{ 'lib/app/Sei.exe' = $signed; 'lib/app/Squirrel.exe' = $unsigned }
# A signed decoy beside an unsigned real one: every match must pass.
$decoy = New-Package 'decoy.nupkg' @{ 'lib/app/Sei.exe' = $unsigned; 'lib/app/extra/Sei.exe' = $signed; 'lib/app/Squirrel.exe' = $signed2 }
$notZip = Join-Path $work 'not-a-zip.nupkg'; Copy-Item -LiteralPath $plain $notZip
$cjkTemp = Join-Path $work ([string][char]0x4E34 + [char]0x65F6)  # 临时
New-Item -ItemType Directory -Force -Path $cjkTemp | Out-Null

$cases = @(
  @{ name = 'signed, plain name'; files = @($signed); publisher = $publisher; ok = $true },
  @{ name = 'signed, DN'; files = @($signed); publisher = $publisherDn; ok = $true },
  @{ name = 'signed, a part of the name'; files = @($signed); publisher = 'Sei CI'; ok = $false; reason = 'signed by' },
  @{ name = 'signed, wrong DN part'; files = @($signed); publisher = 'CN=Sei CI Test Signer, O=Someone Else'; ok = $false; reason = 'signed by' },
  @{ name = 'unsigned'; files = @($unsigned); publisher = $publisher; ok = $false; reason = 'NotSigned' },
  @{ name = 'tampered after signing'; files = @($tampered); publisher = $publisher; ok = $false; reason = 'HashMismatch' },
  @{ name = 'signed by someone else'; files = @($other); publisher = $publisher; ok = $false; reason = 'signed by CN=' },
  @{ name = 'two files, one unsigned'; files = @($signed, $unsigned); publisher = $publisher; ok = $false; reason = 'NotSigned' },
  @{ name = 'missing file'; files = @((Join-Path $work 'nope.exe')); publisher = $publisher; ok = $false },
  @{ name = 'package, both signed'; package = $good; publisher = $publisher; ok = $true },
  @{ name = 'package, both signed, Chinese TEMP'; package = $good; publisher = $publisher; ok = $true; env = @{ TEMP = $cjkTemp; TMP = $cjkTemp } },
  @{ name = 'package + staged exe'; files = @($signed); package = $good; publisher = $publisherDn; ok = $true },
  @{ name = 'package without Squirrel.exe'; package = $noSquirrel; publisher = $publisher; ok = $false; reason = 'no Squirrel.exe' },
  @{ name = 'package, unsigned Squirrel.exe'; package = $badSquirrel; publisher = $publisher; ok = $false; reason = 'Squirrel.exe: NotSigned' },
  @{ name = 'package, signed decoy'; package = $decoy; publisher = $publisher; ok = $false; reason = 'NotSigned' },
  @{ name = 'not a zip'; package = $notZip; publisher = $publisher; ok = $false; reason = 'signature check failed' }
)

# ---------------------------------------------------------------- the real CI package
if ($Feed) {
  $full = Get-ChildItem -LiteralPath (Join-Path $Feed 'vp') -Filter 'Sei-0.6.91-full.nupkg' | Select-Object -First 1
  if (-not $full) { throw "no Sei-0.6.91-full.nupkg in $Feed\vp" }
  $real = Join-Path $work 'real-unsigned.nupkg'; Copy-Item -LiteralPath $full.FullName $real
  $resigned = Join-Path $work 'real-resigned.nupkg'; Copy-Item -LiteralPath $full.FullName $resigned
  TestSign @() $resigned
  $cases += @{ name = 'CI package as built (unsigned)'; package = $real; publisher = $publisher; ok = $false; reason = 'NotSigned'; rows = 2 }
  $cases += @{ name = 'CI package re-signed'; package = $resigned; publisher = $publisher; ok = $true; rows = 2 }
}

$json = ConvertTo-Json -InputObject $cases -Depth 5
$casesFile = Join-Path $env:RUNNER_TEMP 'authenticode-cases.json'
[System.IO.File]::WriteAllText($casesFile, $json, (New-Object System.Text.UTF8Encoding $false))
& node --experimental-strip-types --no-warnings (Join-Path $PSScriptRoot 'authenticode-check.mjs') $casesFile
exit $LASTEXITCODE
