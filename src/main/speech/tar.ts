/**
 * Minimal tar reader (260816, china-compat W3+W4) — just enough to unpack the
 * known k2-fsa model archives: ustar/pax regular files and directories, with
 * pax `path` extended headers and GNU longname (type 'L') honored because the
 * archives are produced by modern GNU/BSD tar. Symlinks, hardlinks and devices
 * are SKIPPED (the model archives contain none; extracting links from a
 * downloaded archive would be a path-traversal surface).
 *
 * Pure function over bytes → entry list; the caller owns writing to disk (and
 * the traversal check on entry names).
 */

export interface TarEntry {
  name: string;
  type: 'file' | 'dir';
  data: Uint8Array;
}

function readString(buf: Uint8Array, off: number, len: number): string {
  let end = off;
  const stop = off + len;
  while (end < stop && buf[end] !== 0) end += 1;
  return new TextDecoder().decode(buf.subarray(off, end));
}

function readOctal(buf: Uint8Array, off: number, len: number): number {
  // GNU base-256 extension for big sizes: high bit of first byte set.
  if (buf[off] & 0x80) {
    let v = buf[off] & 0x7f;
    for (let i = 1; i < len; i += 1) v = v * 256 + buf[off + i];
    return v;
  }
  const s = readString(buf, off, len).trim();
  return s ? parseInt(s, 8) : 0;
}

function isZeroBlock(buf: Uint8Array, off: number): boolean {
  for (let i = 0; i < 512; i += 1) {
    if (buf[off + i] !== 0) return false;
  }
  return true;
}

/** Parse pax extended header records ("<len> key=value\n"). */
function parsePax(data: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  const text = new TextDecoder().decode(data);
  let i = 0;
  while (i < text.length) {
    const sp = text.indexOf(' ', i);
    if (sp < 0) break;
    const len = parseInt(text.slice(i, sp), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const record = text.slice(sp + 1, i + len - 1); // drop trailing \n
    const eq = record.indexOf('=');
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    i += len;
  }
  return out;
}

export function parseTar(buf: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = [];
  let off = 0;
  let pendingLongName: string | null = null;
  let pendingPax: Record<string, string> | null = null;
  while (off + 512 <= buf.length) {
    if (isZeroBlock(buf, off)) break; // end-of-archive marker
    const size = readOctal(buf, off + 124, 12);
    const typeByte = buf[off + 156];
    const type = String.fromCharCode(typeByte === 0 ? 0x30 : typeByte);
    let name = readString(buf, off, 100);
    const prefix = readString(buf, off + 345, 155);
    if (prefix && readString(buf, off + 257, 6).startsWith('ustar')) {
      name = `${prefix}/${name}`;
    }
    const dataStart = off + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > buf.length) throw new Error('tar: truncated entry');
    const data = buf.subarray(dataStart, dataEnd);
    off = dataStart + (size % 512 === 0 ? size : size + (512 - (size % 512)));

    if (type === 'L') {
      pendingLongName = new TextDecoder().decode(data).replace(/\0+$/, '');
      continue;
    }
    if (type === 'x' || type === 'g') {
      pendingPax = { ...(pendingPax ?? {}), ...parsePax(data) };
      continue;
    }
    if (pendingPax?.path) name = pendingPax.path;
    else if (pendingLongName) name = pendingLongName;
    pendingLongName = null;
    pendingPax = null;

    if (type === '0' || type === '\0') {
      entries.push({ name, type: 'file', data });
    } else if (type === '5') {
      entries.push({ name, type: 'dir', data: new Uint8Array(0) });
    }
    // Everything else (links, devices, GNU extensions) is skipped by design.
  }
  return entries;
}
