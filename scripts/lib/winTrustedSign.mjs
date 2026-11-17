// Sign files with our Azure Trusted Signing cert outside electron-builder
// (261118): the Windows game packs (scripts/build-game-pack.mjs) are built
// after the app, by our own script, so electron-builder's signing never sees
// them. The Minecraft win32 pack carries canvas.node, gl's webgl.node and
// about 40 mingw/ANGLE DLLs, all unsigned until now, which Smart App Control
// blocks the same way it blocked sherpa-onnx in the app.
//
// One Invoke-TrustedSigning call for the whole list (-FileList), so a pack
// costs one PowerShell start and one token instead of ~50. The credentials
// are the same AZURE_* variables release.yml gives electron-builder; the
// TrustedSigning module reads AZURE_TENANT_ID / AZURE_CLIENT_ID /
// AZURE_CLIENT_SECRET from the environment itself. Values reach PowerShell
// through the environment, never the command line.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
if (-not (Get-Module -ListAvailable -Name TrustedSigning | Where-Object { $_.Version -ge [version]'0.5.0' })) {
  Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Force -Scope CurrentUser | Out-Null
  Install-Module -Name TrustedSigning -MinimumVersion 0.5.0 -Force -Repository PSGallery -Scope CurrentUser
}
Invoke-TrustedSigning \`
  -Endpoint $env:AZURE_ENDPOINT \`
  -CodeSigningAccountName $env:AZURE_CODE_SIGNING_ACCOUNT \`
  -CertificateProfileName $env:AZURE_CERT_PROFILE \`
  -FileList $env:SEI_SIGN_FILE_LIST \`
  -FileDigest SHA256 \`
  -TimestampRfc3161 'http://timestamp.acs.microsoft.com' \`
  -TimestampDigest SHA256
`;

/** The PowerShell this module runs (exported for the test). */
export const TRUSTED_SIGN_SCRIPT = PS_SCRIPT;

/**
 * Sign `files` (absolute paths) in place. Windows only. Throws on any
 * failure; the caller re-checks the files on disk.
 */
export function trustedSignFiles(files, { env = process.env, spawn = spawnSync, log = console.log } = {}) {
  if (files.length === 0) return;
  if (process.platform !== 'win32' && spawn === spawnSync) {
    throw new Error('Trusted Signing runs on Windows only (Invoke-TrustedSigning needs the Windows SignTool)');
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'sei-sign-'));
  const list = path.join(dir, 'files.txt');
  try {
    writeFileSync(list, files.join('\r\n') + '\r\n');
    const encoded = Buffer.from(PS_SCRIPT, 'utf16le').toString('base64');
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded];
    const opts = { env: { ...env, SEI_SIGN_FILE_LIST: list }, stdio: 'inherit', timeout: 20 * 60 * 1000 };
    const t0 = Date.now();
    let res = spawn('pwsh', args, opts);
    if (res.error && res.error.code === 'ENOENT') res = spawn('powershell.exe', args, opts);
    if (res.error) throw new Error(`Invoke-TrustedSigning could not run: ${res.error.message}`);
    if (res.status !== 0) throw new Error(`Invoke-TrustedSigning exited ${res.status}`);
    log(`signed ${files.length} file(s) with Trusted Signing in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
