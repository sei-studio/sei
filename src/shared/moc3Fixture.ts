/**
 * Test fixture (261122): a minimal moc3 holding only the parts
 * `readMoc3Parameters` reads (header, section offset table, count table,
 * parameter ids, max, min and default values). Not a model the Cubism Core
 * could load; used by the live2dParams and avatarStore tests.
 */
export function fakeMoc3(
  params: ReadonlyArray<{ id: string; min?: number; max?: number; def?: number }>,
  opts: { bigEndian?: boolean; version?: number } = {},
): Uint8Array {
  const n = params.length;
  const le = !opts.bigEndian;
  const header = 64;
  const table = header;
  const tableSize = 160 * 4;
  const counts = table + tableSize;
  const countsSize = 23 * 4;
  const ids = counts + countsSize;
  const maxAt = ids + n * 64;
  const minAt = maxAt + n * 4;
  const defAt = minAt + n * 4;
  const size = defAt + n * 4;
  const buf = new Uint8Array(size);
  const view = new DataView(buf.buffer);
  buf.set([0x4d, 0x4f, 0x43, 0x33], 0); // "MOC3"
  buf[4] = opts.version ?? 3;
  buf[5] = le ? 0 : 1;
  view.setUint32(table + 0 * 4, counts, le);
  view.setUint32(table + 50 * 4, ids, le);
  view.setUint32(table + 51 * 4, maxAt, le);
  view.setUint32(table + 52 * 4, minAt, le);
  view.setUint32(table + 53 * 4, defAt, le);
  view.setUint32(counts + 5 * 4, n, le);
  const enc = new TextEncoder();
  params.forEach((p, i) => {
    buf.set(enc.encode(p.id).subarray(0, 63), ids + i * 64);
    view.setFloat32(maxAt + i * 4, p.max ?? 1, le);
    view.setFloat32(minAt + i * 4, p.min ?? 0, le);
    view.setFloat32(defAt + i * 4, p.def ?? 0, le);
  });
  return buf;
}




