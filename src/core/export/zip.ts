/**
 * Minimal STORE (uncompressed) ZIP writer — enough to package a
 * deterministic PNG/JPEG frame sequence into one downloadable archive without
 * pulling in a dependency. Uses the standard local-file-header + central-
 * directory + end-of-central-directory layout with CRC-32 checksums.
 *
 * CRC-32 is pure and unit-tested against known vectors; the archive builder is
 * straightforward byte assembly.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (IEEE) of a byte array. */
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = (CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

function writeUint32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, true);
}
function writeUint16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value & 0xffff, true);
}

/** Build a STORE-method ZIP as a Blob (browser download). */
export function createStoreZip(entries: ReadonlyArray<ZipEntry>): Blob {
  return new Blob([zipBytes(entries) as BlobPart], { type: 'application/zip' });
}

/**
 * Build a STORE-method ZIP as raw bytes. No compression — fast, correct,
 * dependency-free; frame PNGs are already compressed so this loses little.
 */
export function zipBytes(entries: ReadonlyArray<ZipEntry>): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = enc.encode(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;

    // Local file header (30 bytes) + name + data.
    const local = new Uint8Array(30 + nameBytes.length + size);
    const lv = new DataView(local.buffer);
    writeUint32(lv, 0, 0x04034b50); // signature
    writeUint16(lv, 4, 20); // version needed
    writeUint16(lv, 6, 0); // flags
    writeUint16(lv, 8, 0); // method = store
    writeUint16(lv, 10, 0); // mod time
    writeUint16(lv, 12, 0); // mod date
    writeUint32(lv, 14, crc);
    writeUint32(lv, 18, size); // compressed
    writeUint32(lv, 22, size); // uncompressed
    writeUint16(lv, 26, nameBytes.length);
    writeUint16(lv, 28, 0); // extra length
    local.set(nameBytes, 30);
    local.set(entry.data, 30 + nameBytes.length);
    locals.push(local);

    // Central directory record (46 bytes) + name.
    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    writeUint32(cv, 0, 0x02014b50); // signature
    writeUint16(cv, 4, 20); // version made by
    writeUint16(cv, 6, 20); // version needed
    writeUint16(cv, 8, 0);
    writeUint16(cv, 10, 0); // method
    writeUint16(cv, 12, 0);
    writeUint16(cv, 14, 0);
    writeUint32(cv, 16, crc);
    writeUint32(cv, 20, size);
    writeUint32(cv, 24, size);
    writeUint16(cv, 28, nameBytes.length);
    writeUint16(cv, 30, 0); // extra
    writeUint16(cv, 32, 0); // comment
    writeUint16(cv, 34, 0); // disk
    writeUint16(cv, 36, 0); // internal attrs
    writeUint32(cv, 38, 0); // external attrs
    writeUint32(cv, 42, offset); // local header offset
    central.set(nameBytes, 46);
    centrals.push(central);

    offset += local.length;
  }

  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const centralOffset = offset;

  // End of central directory (22 bytes).
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  writeUint32(ev, 0, 0x06054b50);
  writeUint16(ev, 4, 0);
  writeUint16(ev, 6, 0);
  writeUint16(ev, 8, entries.length);
  writeUint16(ev, 10, entries.length);
  writeUint32(ev, 12, centralSize);
  writeUint32(ev, 16, centralOffset);
  writeUint16(ev, 20, 0); // comment length

  // Concatenate all chunks into one buffer.
  const totalLen = locals.reduce((n, c) => n + c.length, 0) + centralSize + end.length;
  const outBuf = new Uint8Array(totalLen);
  let p = 0;
  for (const c of locals) { outBuf.set(c, p); p += c.length; }
  for (const c of centrals) { outBuf.set(c, p); p += c.length; }
  outBuf.set(end, p);
  return outBuf;
}
