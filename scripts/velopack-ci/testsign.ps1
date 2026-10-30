# Signs files with a throwaway code-signing certificate that only this CI
# runner trusts (261031), for the Authenticode checks in velopack-update.yml.
# Windows PowerShell 5.1 (the PKI cmdlets), so pwsh callers start it as
# `powershell.exe -File`. Inputs are environment variables, so paths with
# spaces or Chinese characters pass through untouched:
#   SEI_TESTSIGN_FILES    newline-separated files to sign in place
#   SEI_TESTSIGN_PACKAGE  a .nupkg whose Sei.exe and Squirrel.exe entries are
#                         signed and written back into it
#   SEI_TESTSIGN_SUBJECT  certificate subject (default below)
# The certificate is made on the first call and reused after that; it goes
# into LocalMachine\Root and TrustedPublisher so Get-AuthenticodeSignature
# reports Valid for what it signs. Never run this on a machine you keep.
$ErrorActionPreference = 'Stop'
$subject = if ($env:SEI_TESTSIGN_SUBJECT) { $env:SEI_TESTSIGN_SUBJECT } else { 'CN=Sei CI Test Signer, O=Sei CI, C=US' }

$cert = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert | Where-Object { $_.Subject -eq $subject } | Select-Object -First 1
if (-not $cert) {
  $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject $subject -CertStoreLocation Cert:\CurrentUser\My `
    -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -NotAfter (Get-Date).AddDays(3)
  $cer = Join-Path $env:TEMP "sei-ci-signer-$($cert.Thumbprint).cer"
  Export-Certificate -Cert $cert -FilePath $cer | Out-Null
  Import-Certificate -FilePath $cer -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
  Import-Certificate -FilePath $cer -CertStoreLocation Cert:\LocalMachine\TrustedPublisher | Out-Null
  Write-Host "test signer: $($cert.Subject) ($($cert.Thumbprint)), trusted on this machine"
}

function Sign([string]$file) {
  $r = Set-AuthenticodeSignature -LiteralPath $file -Certificate $cert -HashAlgorithm SHA256
  if ($r.Status -ne 'Valid') { throw "signing $file failed: $($r.Status) $($r.StatusMessage)" }
  Write-Host "signed $file"
}

if ($env:SEI_TESTSIGN_FILES) {
  foreach ($f in ($env:SEI_TESTSIGN_FILES -split "\r?\n")) { if ($f) { Sign $f } }
}

if ($env:SEI_TESTSIGN_PACKAGE) {
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $pkg = $env:SEI_TESTSIGN_PACKAGE
  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('sei-testsign-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    $zip = [System.IO.Compression.ZipFile]::Open($pkg, [System.IO.Compression.ZipArchiveMode]::Update)
    try {
      $names = @($zip.Entries | Where-Object { $_.FullName -match '(^|/)(Sei\.exe|Squirrel\.exe)$' } | ForEach-Object { $_.FullName })
      if ($names.Count -eq 0) { throw "$pkg has no Sei.exe or Squirrel.exe" }
      $i = 0
      foreach ($name in $names) {
        $e = $zip.GetEntry($name)
        $local = Join-Path $tmp ([string]$i + '-' + $e.Name); $i++
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($e, $local, $true)
        Sign $local
        $e.Delete()
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $local, $name, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
        Write-Host "re-signed $name in $pkg"
      }
    } finally { $zip.Dispose() }
  } finally { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
}
