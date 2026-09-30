/**
 * Minimal in-repo bzip2 decompressor (260816, china-compat W3+W4).
 *
 * Node has zlib but no bzip2, and the canonical k2-fsa speech model archives
 * are .tar.bz2 — origin-only downloads must work, so the decoder lives here
 * rather than behind a dependency. It is a straight implementation of the
 * classic bzip2 block format (Huffman groups + MTF/RLE2 + inverse BWT + RLE1),
 * decoding only what our known archives use:
 *
 *   - the deprecated "randomized" block flag is REJECTED (no encoder has
 *     emitted it since the 1990s);
 *   - block and stream CRCs are computed and VERIFIED (the download layer also
 *     size-checks, but a corrupt archive must fail here, not at model load).
 *
 * Pure function over bytes; tested against fixtures produced by the system
 * `bzip2` binary (bzip2.test.ts).
 */

class BitReader {
  private readonly data: Uint8Array;
  private pos = 0; // bit position
  constructor(data: Uint8Array) {
    this.data = data;
  }
  /** Read `n` bits (n <= 24 for exactness in the hot paths; 32-bit reads are
   * composed from two halves by callers). */
  read(n: number): number {
    let out = 0;
    let pos = this.pos;
    const data = this.data;
    for (let i = 0; i < n; i += 1) {
      const byte = data[pos >> 3];
      if (byte === undefined) throw new Error('bzip2: unexpected end of stream');
      out = (out << 1) | ((byte >> (7 - (pos & 7))) & 1);
      pos += 1;
    }
    this.pos = pos;
    return out >>> 0;
  }
  read32(): number {
    return (this.read(16) * 65536 + this.read(16)) >>> 0;
  }
  bitsLeft(): number {
    return this.data.length * 8 - this.pos;
  }
}

const CRC32_TABLE = (() => {
  // bzip2 uses the "big-endian" CRC-32 (poly 0x04c11db7, MSB-first).
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i << 24;
    for (let k = 0; k < 8; k += 1) {
      c = c & 0x80000000 ? ((c << 1) ^ 0x04c11db7) >>> 0 : (c << 1) >>> 0;
    }
    t[i] = c >>> 0;
  }
  return t;
})();

const MAX_HUFCODE_BITS = 20;
const GROUP_RUN = 50;

/** Decode one bzip2 block's payload into bytes (pre-RLE1). */
function decodeBlock(br: BitReader, blockSizeBytes: number): Uint8Array {
  if (br.read(1) !== 0) throw new Error('bzip2: randomized blocks are not supported');
  const origPtr = br.read(24);

  // Symbol map: 16-bit coarse map, then a 16-bit fine map per set bit.
  const used: number[] = [];
  const map16 = br.read(16);
  for (let i = 0; i < 16; i += 1) {
    if (map16 & (0x8000 >> i)) {
      const fine = br.read(16);
      for (let j = 0; j < 16; j += 1) {
        if (fine & (0x8000 >> j)) used.push(i * 16 + j);
      }
    }
  }
  const symCount = used.length + 2; // RUNA, RUNB, MTFV 1..n-1, EOB

  const nGroups = br.read(3);
  if (nGroups < 2 || nGroups > 6) throw new Error('bzip2: bad group count');
  const nSelectors = br.read(15);
  if (nSelectors === 0) throw new Error('bzip2: no selectors');

  // Selectors, MTF-decoded over the group indices.
  const selectors = new Uint8Array(nSelectors);
  {
    const mtf = [0, 1, 2, 3, 4, 5].slice(0, nGroups);
    for (let i = 0; i < nSelectors; i += 1) {
      let j = 0;
      while (br.read(1)) {
        j += 1;
        if (j >= nGroups) throw new Error('bzip2: bad selector');
      }
      const v = mtf[j];
      mtf.splice(j, 1);
      mtf.unshift(v);
      selectors[i] = v;
    }
  }

  // Per-group delta-encoded Huffman code lengths → decode tables.
  type Table = { limit: Int32Array; base: Int32Array; permute: Int32Array; minLen: number; maxLen: number };
  const tables: Table[] = [];
  for (let g = 0; g < nGroups; g += 1) {
    const lengths = new Uint8Array(symCount);
    let len = br.read(5);
    for (let s = 0; s < symCount; s += 1) {
      for (;;) {
        if (len < 1 || len > MAX_HUFCODE_BITS) throw new Error('bzip2: bad code length');
        if (!br.read(1)) break;
        if (br.read(1)) len -= 1;
        else len += 1;
      }
      lengths[s] = len;
    }
    // Canonical Huffman decode tables (limit/base/permute, per bit length).
    let minLen = 32;
    let maxLen = 0;
    for (let s = 0; s < symCount; s += 1) {
      if (lengths[s] > maxLen) maxLen = lengths[s];
      if (lengths[s] < minLen) minLen = lengths[s];
    }
    const permute = new Int32Array(symCount);
    const limit = new Int32Array(maxLen + 2);
    const base = new Int32Array(maxLen + 2);
    let pp = 0;
    for (let l = minLen; l <= maxLen; l += 1) {
      for (let s = 0; s < symCount; s += 1) {
        if (lengths[s] === l) permute[pp++] = s;
      }
    }
    const count = new Int32Array(maxLen + 1);
    for (let s = 0; s < symCount; s += 1) count[lengths[s]] += 1;
    let vec = 0;
    let total = 0;
    for (let l = minLen; l <= maxLen; l += 1) {
      vec += count[l];
      limit[l] = vec - 1;
      vec <<= 1;
      total += count[l];
      base[l + 1] = vec - total;
    }
    tables.push({ limit, base, permute, minLen, maxLen });
  }

  // MTF + RLE2 decode into the BWT buffer.
  const bwt = new Uint8Array(blockSizeBytes);
  const byteCounts = new Uint32Array(256);
  const mtfSyms = used.slice();
  let bwtLen = 0;
  let groupPos = 0;
  let selectorIdx = 0;
  let table: Table | null = null;
  let run = 0;
  let runBit = 0;
  const eob = symCount - 1;
  for (;;) {
    if (groupPos === 0) {
      if (selectorIdx >= nSelectors) throw new Error('bzip2: ran out of selectors');
      table = tables[selectors[selectorIdx++]];
      groupPos = GROUP_RUN;
    }
    groupPos -= 1;
    const t = table as Table;
    // Read one Huffman symbol.
    let l = t.minLen;
    let code = br.read(l);
    while (l <= t.maxLen && code > t.limit[l]) {
      code = (code << 1) | br.read(1);
      l += 1;
    }
    if (l > t.maxLen) throw new Error('bzip2: bad huffman code');
    const sym = t.permute[code - t.base[l]];

    if (sym <= 1) {
      // RUNA / RUNB: bijective base-2 run length.
      run += (sym + 1) << runBit;
      runBit += 1;
      continue;
    }
    if (run > 0) {
      const b = mtfSyms[0];
      if (bwtLen + run > blockSizeBytes) throw new Error('bzip2: block overflow');
      bwt.fill(b, bwtLen, bwtLen + run);
      byteCounts[b] += run;
      bwtLen += run;
      run = 0;
      runBit = 0;
    }
    if (sym === eob) break;
    // MTF value: move symbol at index sym-1 to front, emit it.
    const idx = sym - 1;
    const b = mtfSyms[idx];
    mtfSyms.splice(idx, 1);
    mtfSyms.unshift(b);
    if (bwtLen >= blockSizeBytes) throw new Error('bzip2: block overflow');
    bwt[bwtLen++] = b;
    byteCounts[b] += 1;
  }
  if (origPtr >= bwtLen) throw new Error('bzip2: bad origPtr');

  // Inverse BWT: standard T-vector walk.
  const tt = new Uint32Array(bwtLen);
  {
    const starts = new Uint32Array(256);
    let sum = 0;
    for (let b = 0; b < 256; b += 1) {
      starts[b] = sum;
      sum += byteCounts[b];
    }
    for (let i = 0; i < bwtLen; i += 1) {
      const b = bwt[i];
      tt[starts[b]] = i;
      starts[b] += 1;
    }
  }
  const out = new Uint8Array(bwtLen);
  let p = tt[origPtr];
  for (let i = 0; i < bwtLen; i += 1) {
    out[i] = bwt[p];
    p = tt[p];
  }
  return out;
}

/** Final RLE1 decode (4 equal bytes + count byte) with block CRC update.
 * Returns the decoded chunk and the block's computed CRC. */
function rle1Decode(data: Uint8Array): { bytes: Uint8Array; crc: number } {
  // Worst case growth is 255/4x but real archives are tame; grow geometrically.
  let cap = Math.max(1024, data.length * 2);
  let out = new Uint8Array(cap);
  let n = 0;
  let crc = 0xffffffff;
  const push = (b: number, times: number): void => {
    if (n + times > cap) {
      cap = Math.max(cap * 2, n + times);
      const next = new Uint8Array(cap);
      next.set(out.subarray(0, n));
      out = next;
    }
    for (let i = 0; i < times; i += 1) {
      out[n++] = b;
      crc = (((crc << 8) >>> 0) ^ CRC32_TABLE[((crc >>> 24) ^ b) & 0xff]) >>> 0;
    }
  };
  let i = 0;
  while (i < data.length) {
    const b = data[i];
    let runLen = 1;
    while (runLen < 4 && i + runLen < data.length && data[i + runLen] === b) runLen += 1;
    if (runLen === 4) {
      const extra = data[i + 4];
      if (extra === undefined) throw new Error('bzip2: truncated RLE run');
      push(b, 4 + extra);
      i += 5;
    } else {
      push(b, runLen);
      i += runLen;
    }
  }
  return { bytes: out.subarray(0, n), crc: ~crc >>> 0 };
}

/**
 * Decompress a complete bzip2 stream. Throws on any structural or CRC error.
 */
export function bunzip2(input: Uint8Array): Uint8Array {
  const br = new BitReader(input);
  if (br.read(8) !== 0x42 || br.read(8) !== 0x5a || br.read(8) !== 0x68) {
    throw new Error('bzip2: bad magic');
  }
  const level = br.read(8) - 0x30;
  if (level < 1 || level > 9) throw new Error('bzip2: bad block size');
  const blockSizeBytes = level * 100_000;

  const chunks: Uint8Array[] = [];
  let total = 0;
  let combinedCrc = 0;
  for (;;) {
    const magicHi = br.read(24);
    const magicLo = br.read(24);
    if (magicHi === 0x177245 && magicLo === 0x385090) {
      const streamCrc = br.read32();
      if (streamCrc !== combinedCrc) throw new Error('bzip2: stream CRC mismatch');
      break;
    }
    if (magicHi !== 0x314159 || magicLo !== 0x265359) throw new Error('bzip2: bad block magic');
    const blockCrc = br.read32();
    const raw = decodeBlock(br, blockSizeBytes);
    const { bytes, crc } = rle1Decode(raw);
    if (crc !== blockCrc) throw new Error('bzip2: block CRC mismatch');
    combinedCrc = ((((combinedCrc << 1) >>> 0) | (combinedCrc >>> 31)) ^ crc) >>> 0;
    chunks.push(bytes);
    total += bytes.length;
    if (br.bitsLeft() < 48) throw new Error('bzip2: truncated stream');
  }

  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}
