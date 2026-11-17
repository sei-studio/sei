// Windows native binaries and whether they carry an Authenticode signature
// (261118, Smart App Control).
//
// Smart App Control (and any WDAC policy like it) refuses to load a DLL or
// .node file that has neither a signature nor cloud reputation. Sei.exe is
// signed, but until 261118 the native modules it loads were not: SAC blocked
// sherpa-onnx (local voices and SenseVoice), and the Minecraft pack's canvas
// and gl (the bot's vision). electron-builder signs only .exe files unless
// `win.signExts` is set, and with signExts it re-signs every match, Microsoft's
// own onnxruntime.dll included, one Trusted Signing request per file. So the
// build signs just the natives that have no signature yet:
// scripts/win-sign-natives.mjs (the app, electron-builder afterPack) and
// scripts/build-game-pack.mjs (game packs). Both find them here.
//
// "Signed" below means the PE optional header's security directory (data
// directory 4, the WIN_CERTIFICATE table) is non-empty. That says a signature
// is PRESENT, not that it is valid: release.yml checks validity on the runner
// with Get-AuthenticodeSignature.
import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import path from 'node:path';

/** Extensions of the native code the app and its packs load. .exe files are
 * electron-builder's own job (it signs every .exe it ships). */
export const NATIVE_EXTS = ['.dll', '.node'];

/**
 * 'signed' | 'unsigned' | 'not-pe' for the first bytes of a file. Only the
 * headers are needed: `buf` may be just the start of the file as long as it
 * reaches the end of the optional header's data directories (1 KB covers any
 * normal image; peSignatureStateOfFile reads 4 KB).
 */
export function peSignatureState(buf) {
  if (!buf || buf.length < 0x40 || buf[0] !== 0x4d || buf[1] !== 0x5a) return 'not-pe';
  const pe = buf.readUInt32LE(0x3c);
  if (pe + 24 > buf.length || buf.readUInt32LE(pe) !== 0x00004550) return 'not-pe';
  const opt = pe + 24;
  if (opt + 2 > buf.length) return 'not-pe';
  const magic = buf.readUInt16LE(opt);
  // PE32 (0x10b) data directories start at +96, PE32+ (0x20b) at +112.
  const dirs = magic === 0x10b ? opt + 96 : magic === 0x20b ? opt + 112 : -1;
  if (dirs < 0) return 'not-pe';
  const numDirsAt = dirs - 4; // NumberOfRvaAndSizes, the field before them
  if (numDirsAt + 4 > buf.length || buf.readUInt32LE(numDirsAt) < 5) return 'unsigned';
  const sec = dirs + 4 * 8;
  if (sec + 8 > buf.length) return 'not-pe';
  const offset = buf.readUInt32LE(sec);
  const size = buf.readUInt32LE(sec + 4);
  return offset !== 0 && size !== 0 ? 'signed' : 'unsigned';
}

/** peSignatureState for a file on disk (reads its first 4 KB). */
export function peSignatureStateOfFile(file) {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(4096);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return peSignatureState(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
}

/**
 * Every native binary under `root` with its signature state, sorted by path.
 * `rel` is relative to root with forward slashes. Symlinks are not followed.
 */
export function listNatives(root, exts = NATIVE_EXTS) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && exts.some((x) => e.name.toLowerCase().endsWith(x))) {
        out.push({
          file: p,
          rel: path.relative(root, p).split(path.sep).join('/'),
          bytes: statSync(p).size,
          state: peSignatureStateOfFile(p),
        });
      }
    }
  };
  walk(root);
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/** The natives under `root` that are PE images with no signature. */
export function unsignedNatives(root, exts = NATIVE_EXTS) {
  return listNatives(root, exts).filter((n) => n.state === 'unsigned');
}

/** Every Azure Trusted Signing setting the build reads; signing is all or nothing. */
export const AZURE_SIGN_VARS = [
  'AZURE_TENANT_ID',
  'AZURE_CLIENT_ID',
  'AZURE_CLIENT_SECRET',
  'AZURE_ENDPOINT',
  'AZURE_CODE_SIGNING_ACCOUNT',
  'AZURE_CERT_PROFILE',
];

/**
 * 'on' when every AZURE_* signing variable is set, 'off' when none is, and an
 * Error for a partial set (a half-configured release must fail, never ship a
 * quietly unsigned pack next to a signed app).
 */
export function azureSigningMode(env = process.env) {
  const set = AZURE_SIGN_VARS.filter((k) => env[k]);
  if (set.length === 0) return 'off';
  if (set.length === AZURE_SIGN_VARS.length) return 'on';
  throw new Error(`partial Azure Trusted Signing config (${set.join(', ')} set); set all of ${AZURE_SIGN_VARS.join(', ')} or none`);
}
