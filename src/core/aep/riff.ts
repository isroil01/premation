/**
 * RIFX — the container an After Effects project is written in.
 *
 * An `.aep` is a big-endian RIFF file: the four bytes `RIFX`, a u32 body size,
 * the form type `Egg!`, and then a tree of chunks. Every chunk is a 4-char id,
 * a u32 big-endian body size, the body, and a pad byte when that size is odd.
 * A chunk whose id is `LIST` carries a further 4-char *list type* at the front
 * of its body and holds child chunks after it; everything else is a leaf whose
 * meaning is decided by its id and its position in the tree.
 *
 * This module is ONLY the container. It does not know what `cdta` or `ldta`
 * mean — that is `aepRead.ts`. Keeping the split lets the same tree come from
 * two very different files: a binary `.aep` (here) and an XML `.aepx`
 * (`aepx.ts`), which is the same chunk tree with hex bodies in attributes.
 *
 * ## Bodies are views, not copies
 *
 * A real project is tens of megabytes and most of it is footage metadata and
 * keyframe blobs we read once. Every leaf body is a `subarray` of the caller's
 * buffer, so parsing a 40 MB project allocates a tree of descriptors rather
 * than a second 40 MB of slices.
 *
 * ## A malformed file must fail, not hang
 *
 * This parses a file the user picked, which may be truncated, may be some other
 * format that happens to start with `RIFX`, or may be hostile. Sizes are
 * checked against the remaining bytes at every step, recursion is depth-capped,
 * and the total number of chunks is capped — so a crafted header cannot make
 * the reader loop forever or allocate without bound. The failure mode is a
 * thrown `AepParseError` the import surface turns into a message.
 */

/** Thrown when the bytes are not a readable RIFX tree. */
export class AepParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AepParseError';
  }
}

export interface AepChunk {
  /** The chunk's 4-character id — `LIST` for containers, else e.g. `ldta`. */
  id: string;
  /** For `LIST`/`RIFX`: the 4-character list type (`Fold`, `Layr`, `Egg!`, …). */
  listType?: string;
  /** Leaf payload. A view into the source buffer — never mutate it. */
  body?: Uint8Array;
  /** Child chunks, for lists that were descended into. */
  children?: AepChunk[];
}

/**
 * `btdk` is a list by shape but an opaque blob by content: it holds AE's COS
 * (text-document) data, which is not a chunk tree at all. Descending into it
 * produces garbage chunks, so it is kept whole and handed to the text decoder.
 */
const OPAQUE_LIST_TYPES = new Set(['btdk']);

/**
 * Chunks that hold child chunks WITHOUT being a `LIST`.
 *
 * AE has a handful of these wrappers — an effect's display name (`fnam`), a
 * property's (`tdsn`), a variable-font axis's (`vfdn`) — whose body is simply
 * "some chunks", with no 4-char list type in front. They read as leaves unless
 * they are named, and their `Utf8` payload is how an effect gets the name the
 * user actually typed, so they are named here.
 */
export const CONTAINER_CHUNK_IDS = new Set(['fnam', 'pdnm', 'RCom', 'tdsn', 'vfdn']);

/** Deeper than any real project; a cycle-free file cannot need more. */
const MAX_DEPTH = 64;
/** A 500 MB project of nothing but empty chunks would still stop here. */
const MAX_CHUNKS = 4_000_000;

const ascii = (bytes: Uint8Array, at: number): string =>
  String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);

const u32 = (bytes: Uint8Array, at: number): number =>
  ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;

interface Budget {
  chunks: number;
}

/**
 * Read the chunks packed into `[start, end)`.
 *
 * Stops cleanly at the first header that cannot fit — a truncated tail is
 * common in half-copied project files, and losing the last chunk beats losing
 * the whole project.
 */
function readChunks(
  bytes: Uint8Array,
  start: number,
  end: number,
  depth: number,
  budget: Budget,
): AepChunk[] {
  const out: AepChunk[] = [];
  let p = start;
  while (p + 8 <= end) {
    const id = ascii(bytes, p);
    const size = u32(bytes, p + 4);
    const bodyStart = p + 8;
    // A size that runs past the parent's end means the file is damaged or this
    // is not really RIFX. Clamp rather than throw: everything read up to here
    // is still good, and the caller gets a partial project plus a warning.
    const bodyEnd = Math.min(bodyStart + size, end);
    if (bodyStart > end) break;

    if ((budget.chunks += 1) > MAX_CHUNKS) {
      throw new AepParseError('project has an implausible number of chunks — refusing to continue');
    }

    if ((id === 'LIST' || id === 'RIFX') && bodyEnd - bodyStart >= 4) {
      const listType = ascii(bytes, bodyStart);
      if (OPAQUE_LIST_TYPES.has(listType) || depth >= MAX_DEPTH) {
        out.push({ id, listType, body: bytes.subarray(bodyStart + 4, bodyEnd) });
      } else {
        out.push({
          id,
          listType,
          children: readChunks(bytes, bodyStart + 4, bodyEnd, depth + 1, budget),
        });
      }
    } else if (CONTAINER_CHUNK_IDS.has(id) && depth < MAX_DEPTH) {
      out.push({ id, children: readChunks(bytes, bodyStart, bodyEnd, depth + 1, budget) });
    } else {
      out.push({ id, body: bytes.subarray(bodyStart, bodyEnd) });
    }

    // Chunks are padded to an even boundary; the pad byte is not counted in
    // the declared size, which is why this is `size` and not `bodyEnd - bodyStart`.
    p = bodyStart + size + (size & 1);
  }
  return out;
}

/**
 * Parse an `.aep` into its chunk tree.
 *
 * Returns the root as a `RIFX` chunk with `listType: 'Egg!'`, so a caller can
 * treat it exactly like any other list.
 */
export function parseRifx(bytes: Uint8Array): AepChunk {
  if (bytes.length < 12) throw new AepParseError('file is too short to be an After Effects project');
  const magic = ascii(bytes, 0);
  if (magic !== 'RIFX') {
    // `RIFF` is the little-endian cousin — a WAV or an AVI, not a project.
    const hint = magic === 'RIFF' ? ' (this looks like a RIFF media file, not a project)' : '';
    throw new AepParseError(`not an After Effects project: expected "RIFX", found "${magic}"${hint}`);
  }
  const declared = u32(bytes, 4);
  const form = ascii(bytes, 8);
  if (form !== 'Egg!') {
    throw new AepParseError(`not an After Effects project: unexpected form type "${form}"`);
  }
  // The declared size excludes the 8-byte RIFX header. AE appends an XMP packet
  // after the tree, so the file is usually LONGER than the declared size —
  // trusting the declaration is what keeps that metadata out of the tree.
  const end = Math.min(bytes.length, 8 + declared);
  const budget: Budget = { chunks: 0 };
  return { id: 'RIFX', listType: 'Egg!', children: readChunks(bytes, 12, end, 1, budget) };
}

// ── Tree navigation ─────────────────────────────────────────────────
//
// The semantic layer spends its whole life asking "which child of this list is
// the `cdta`" and "what are the `Layr` lists in here", so those two questions
// get names instead of being re-written as loops at twenty call sites.

/** Children of a chunk, or an empty array for a leaf. */
export const childrenOf = (chunk: AepChunk | undefined): readonly AepChunk[] => chunk?.children ?? [];

/** The first child chunk with this id, or undefined. */
export function findChunk(parent: AepChunk | undefined, id: string): AepChunk | undefined {
  return parent?.children?.find((c) => c.id === id);
}

/** The first child LIST with this list type, or undefined. */
export function findList(parent: AepChunk | undefined, listType: string): AepChunk | undefined {
  return parent?.children?.find((c) => c.listType === listType);
}

/** Every child LIST with this list type, in file order. */
export function findLists(parent: AepChunk | undefined, listType: string): AepChunk[] {
  return (parent?.children ?? []).filter((c) => c.listType === listType);
}

// ── Body readers ────────────────────────────────────────────────────

/**
 * A chunk body as UTF-8 text, stopping at the first NUL.
 *
 * AE writes both kinds of string: `Utf8` chunks are exactly as long as their
 * text, while fixed-width fields (`tdmn`'s 40 bytes, `ldta`'s 32-byte name) are
 * NUL-padded. Truncating at the NUL covers both, and decoding is tolerant so a
 * mis-identified field yields mojibake rather than an exception.
 */
export function chunkText(chunk: AepChunk | undefined): string {
  const body = chunk?.body;
  if (!body || body.length === 0) return '';
  let end = body.indexOf(0);
  if (end < 0) end = body.length;
  return decodeUtf8(body.subarray(0, end));
}

const utf8Decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8', { fatal: false }) : null;

export function decodeUtf8(bytes: Uint8Array): string {
  if (utf8Decoder) return utf8Decoder.decode(bytes);
  // Jest's older jsdom environments have no TextDecoder; a latin-1 fallback
  // keeps ASCII names (which is all the tests assert) readable.
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

/**
 * A cursor over a chunk body.
 *
 * Every AE record is "a field at byte N of a fixed-size struct", and reading
 * those with raw `DataView` arithmetic at each site is how off-by-one offsets
 * get shipped. `Reader` gives them names and, more importantly, returns 0 for a
 * field past the end of a short body instead of throwing — AE has grown these
 * structs over the years and an older file simply stops early.
 */
export class Reader {
  private readonly view: DataView;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get length(): number {
    return this.bytes.length;
  }

  has(at: number, size: number): boolean {
    return at >= 0 && at + size <= this.bytes.length;
  }

  u8(at: number): number {
    return this.has(at, 1) ? this.view.getUint8(at) : 0;
  }
  u16(at: number): number {
    return this.has(at, 2) ? this.view.getUint16(at, false) : 0;
  }
  u32(at: number): number {
    return this.has(at, 4) ? this.view.getUint32(at, false) : 0;
  }
  i32(at: number): number {
    return this.has(at, 4) ? this.view.getInt32(at, false) : 0;
  }
  f32(at: number): number {
    return this.has(at, 4) ? this.view.getFloat32(at, false) : 0;
  }
  f64(at: number, littleEndian = false): number {
    return this.has(at, 8) ? this.view.getFloat64(at, littleEndian) : 0;
  }
  /** A single bit of the byte at `at`, counting bit 0 as the least significant. */
  bit(at: number, bit: number): boolean {
    return (this.u8(at) & (1 << bit)) !== 0;
  }
  /** `count` big-endian doubles starting at `at`. */
  f64s(at: number, count: number, littleEndian = false): number[] {
    const out: number[] = [];
    for (let i = 0; i < count; i++) out.push(this.f64(at + i * 8, littleEndian));
    return out;
  }
  /** A NUL-terminated UTF-8 string occupying `size` bytes from `at`. */
  str(at: number, size: number): string {
    if (!this.has(at, 1)) return '';
    const slice = this.bytes.subarray(at, Math.min(at + size, this.bytes.length));
    let end = slice.indexOf(0);
    if (end < 0) end = slice.length;
    return decodeUtf8(slice.subarray(0, end));
  }
  /** Four ASCII characters — a nested FourCC such as `sspc`'s source format. */
  fourcc(at: number): string {
    return this.has(at, 4) ? ascii(this.bytes, at) : '';
  }
}

/** A `Reader` over a chunk's body, or over nothing when the chunk is absent. */
export const readerFor = (chunk: AepChunk | undefined): Reader => new Reader(chunk?.body ?? new Uint8Array(0));

/**
 * AE's `dividend / divisor` rationals — times, durations, aspect ratios.
 *
 * A zero divisor appears in real files (an un-set stretch, a placeholder
 * duration) and must read as zero rather than as `Infinity`, which would
 * otherwise travel all the way into a comp's duration and NaN out the timeline.
 */
export const ratio = (dividend: number, divisor: number): number => (divisor === 0 ? 0 : dividend / divisor);
