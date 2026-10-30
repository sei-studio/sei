/**
 * Authenticode checks for Windows updates on Velopack (261031). Pure, with no
 * imports, so it unit-tests anywhere and CI can load it with plain node
 * (velopack-update.yml, the authenticode job).
 *
 * The feed (dl.sei.gg, an R2 bucket) carries each package's sha256 in the same
 * bucket as the package, so the hash check only proves the download matches
 * the bucket. Before Sei runs a downloaded Setup (the NSIS -> Velopack
 * migration) or applies a downloaded package, it asks Windows whether the
 * binaries are Authenticode signed by the publisher this build was built for
 * (WIN_PUBLISHER_NAME, baked in at build time). A leaked bucket key can then
 * replace the files, but not make Sei run them.
 *
 * What it covers: the Setup.exe itself, and inside a package the Sei.exe and
 * Squirrel.exe (Velopack copies it over Update.exe) that release.yml signs and
 * verifies. What it does not: the unsigned files beside them (app.asar, the
 * bot sources, DLLs and .node files), which the signed Sei.exe loads.
 */

/** One file's result, as the PowerShell script reports it. */
export interface SignatureRow {
  /** File name: the entry name inside a package, `file<i>` for a plain file. */
  name: string;
  /** Get-AuthenticodeSignature's Status: Valid, NotSigned, HashMismatch, UnknownError, ... */
  status: string;
  /** SignerCertificate.Subject ("CN=..., O=..., C=US"), empty when unsigned. */
  subject: string;
}

export type SignatureVerdict = { ok: true } | { ok: false; reason: string };

/** Entries a Velopack package must carry, and that must be signed. */
export const PACKAGE_SIGNED_ENTRIES = ['Sei.exe', 'Squirrel.exe'] as const;

/**
 * The PowerShell that does the check. Its inputs are environment variables,
 * never text pasted into the script, so a path with spaces, quotes or Chinese
 * characters cannot break it:
 *   SEI_SIG_FILES    newline-separated files to check (may be empty)
 *   SEI_SIG_PACKAGE  a .nupkg whose Sei.exe and Squirrel.exe are extracted to
 *                    a temp folder and checked (optional)
 * It prints one JSON object per file ({name, status, subject}) and exits 0, or
 * prints {"error": ...} when it could not look.
 */
export const AUTHENTICODE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$tmp = $null
try {
  $items = @()
  $i = 0
  if ($env:SEI_SIG_FILES) {
    foreach ($f in ($env:SEI_SIG_FILES -split "\r?\n")) {
      if ($f) { $items += [pscustomobject]@{ name = "file$i"; path = $f }; $i++ }
    }
  }
  if ($env:SEI_SIG_PACKAGE) {
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('sei-sig-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tmp | Out-Null
    $zip = [System.IO.Compression.ZipFile]::OpenRead($env:SEI_SIG_PACKAGE)
    try {
      $n = 0
      foreach ($e in $zip.Entries) {
        if ($e.FullName -match '(^|/)(Sei\.exe|Squirrel\.exe)$') {
          $dest = Join-Path $tmp ([string]$n + '-' + $e.Name)
          $n++
          [System.IO.Compression.ZipFileExtensions]::ExtractToFile($e, $dest, $true)
          $items += [pscustomobject]@{ name = $e.Name; path = $dest }
        }
      }
    } finally { $zip.Dispose() }
  }
  foreach ($it in $items) {
    $s = Get-AuthenticodeSignature -LiteralPath $it.path
    $subject = ''
    if ($s.SignerCertificate) { $subject = [string]$s.SignerCertificate.Subject }
    [pscustomobject]@{ name = $it.name; status = [string]$s.Status; subject = $subject } | ConvertTo-Json -Compress
  }
} catch {
  [pscustomobject]@{ error = [string]$_.Exception.Message } | ConvertTo-Json -Compress
} finally {
  if ($tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
}
exit 0
`;

/** Environment for AUTHENTICODE_SCRIPT. */
export function authenticodeEnv(files: readonly string[], packagePath?: string): Record<string, string> {
  return { SEI_SIG_FILES: files.join('\n'), SEI_SIG_PACKAGE: packagePath ?? '' };
}

/** Parses the script's output. Throws when it reports an error or prints nothing usable. */
export function parseSignatureRows(out: string | null): SignatureRow[] {
  if (out == null) throw new Error('the signature check did not run');
  const rows: SignatureRow[] = [];
  for (const line of out.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(t) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof j.error === 'string') throw new Error(`the signature check failed: ${j.error}`);
    if (typeof j.name === 'string' && typeof j.status === 'string') {
      rows.push({ name: j.name, status: j.status, subject: typeof j.subject === 'string' ? j.subject : '' });
    }
  }
  return rows;
}

/**
 * Splits a distinguished name ("CN=Sei, O=\"Sei, Inc.\", C=US") into its
 * parts. A port of builder-util-runtime's parseDn (MIT), the parser
 * electron-updater checks NSIS updates with, so both updaters read
 * WIN_PUBLISHER_NAME the same way: keys are case-sensitive, a string with no
 * `=` parses to an empty map.
 */
export function parseDn(input: string): Map<string, string> {
  let quoted = false;
  let key: string | null = null;
  let token = '';
  let nextNonSpace = 0;
  const seq = input.trim();
  const result = new Map<string, string>();
  for (let i = 0; i <= seq.length; i++) {
    if (i === seq.length) {
      if (key !== null) result.set(key, token);
      break;
    }
    const ch = seq[i];
    if (quoted) {
      if (ch === '"') {
        quoted = false;
        continue;
      }
    } else {
      if (ch === '"') {
        quoted = true;
        continue;
      }
      if (ch === '\\') {
        i++;
        const ord = parseInt(seq.slice(i, i + 2), 16);
        if (Number.isNaN(ord)) {
          token += seq[i];
        } else {
          i++;
          token += String.fromCharCode(ord);
        }
        continue;
      }
      if (key === null && ch === '=') {
        key = token;
        token = '';
        continue;
      }
      if (ch === ',' || ch === ';' || ch === '+') {
        if (key !== null) result.set(key, token);
        key = null;
        token = '';
        continue;
      }
    }
    if (ch === ' ' && !quoted) {
      if (token.length === 0) continue;
      if (i > nextNonSpace) {
        let j = i;
        while (seq[j] === ' ') j++;
        nextNonSpace = j;
      }
      if (
        nextNonSpace >= seq.length ||
        seq[nextNonSpace] === ',' ||
        seq[nextNonSpace] === ';' ||
        (key === null && seq[nextNonSpace] === '=') ||
        (key !== null && seq[nextNonSpace] === '+')
      ) {
        i = nextNonSpace - 1;
        continue;
      }
    }
    token += ch;
  }
  return result;
}

/**
 * electron-updater's publisher rule (windowsExecutableCodeSignatureVerifier):
 * a DN ("CN=x, O=y") must match every part it names; a plain name must equal
 * the certificate's CN.
 */
export function publisherMatches(subject: string, publisher: string): boolean {
  const want = publisher.trim();
  if (!want) return false;
  const have = parseDn(subject);
  const dn = parseDn(want);
  if (dn.size > 0) return [...dn.keys()].every((k) => dn.get(k) === have.get(k));
  return have.get('CN') === want;
}

/**
 * The decision. `expectFiles` is how many plain files were asked about;
 * `package` says a package was scanned, which then must have contributed its
 * Sei.exe and Squirrel.exe.
 */
export function signatureVerdict(
  rows: readonly SignatureRow[],
  publisher: string,
  expect: { files: number; package: boolean },
): SignatureVerdict {
  const plain = rows.filter((r) => /^file\d+$/.test(r.name));
  if (plain.length !== expect.files) return { ok: false, reason: `checked ${plain.length} of ${expect.files} files` };
  if (expect.package) {
    for (const want of PACKAGE_SIGNED_ENTRIES) {
      if (!rows.some((r) => r.name.toLowerCase() === want.toLowerCase())) {
        return { ok: false, reason: `the package has no ${want}` };
      }
    }
  }
  if (rows.length === 0) return { ok: false, reason: 'nothing was checked' };
  for (const r of rows) {
    if (r.status !== 'Valid') return { ok: false, reason: `${r.name}: ${r.status}` };
    if (!publisherMatches(r.subject, publisher)) return { ok: false, reason: `${r.name}: signed by ${r.subject || 'nobody'}` };
  }
  return { ok: true };
}
