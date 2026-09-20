/**
 * `.aepx` — the XML form of the same project.
 *
 * After Effects can save any project as XML ("Save As ▸ Save a Copy as XML"),
 * and what it writes is not a different document: it is the SAME chunk tree,
 * transcribed. A leaf chunk becomes `<idta bdata="0004…"/>` with its body in
 * hex, a `LIST` becomes an element named after its list type, and a `Utf8`
 * chunk becomes `<string>Comp 1</string>`. The root `Egg!` form is the
 * `<AfterEffectsProject>` element.
 *
 * So this module is a second FRONT END onto `aepRead.ts`, not a second
 * importer: it produces the identical `AepChunk` tree the binary reader
 * produces, and everything downstream is unaware of which one ran.
 *
 * ## Why a hand-rolled scanner and not DOMParser
 *
 * Two reasons, and neither is performance. `DOMParser` does not exist in the
 * CLI/main-process paths that also need to read a project, so a DOM-based
 * reader would work in the editor and throw in `premation render`. And an XML
 * parser handed a user's file is an XXE surface — a `<!DOCTYPE>` with an
 * external entity is a real attack on a desktop app that reads files people
 * were emailed. This scanner knows five constructs (element, attribute,
 * CDATA, comment, processing instruction), resolves no entities beyond the
 * five predefined ones, and never opens anything.
 */

import { AepParseError, CONTAINER_CHUNK_IDS, type AepChunk } from './riff';

/** The XML root element name AE writes for the `Egg!` form. */
const ROOT_ELEMENT = 'AfterEffectsProject';

/**
 * Elements that are not chunks.
 *
 * The XMP packet rides along as its own element rather than as a chunk (in the
 * binary file it is appended AFTER the tree), so it is dropped here for the
 * same reason the binary reader stops at the declared size.
 */
const NOT_A_CHUNK = new Set(['ProjectXMPMetadata']);

/** Same guards as the binary reader — see `riff.ts`. */
const MAX_DEPTH = 64;
const MAX_CHUNKS = 4_000_000;

/**
 * A chunk id is always four bytes. XML drops the padding, so `Pin ` is written
 * `<Pin>` and `list` stays `list`; restoring the space is what lets the
 * semantic layer match one set of names against both readers.
 */
const fourcc = (name: string): string => (name.length >= 4 ? name.slice(0, 4) : name.padEnd(4, ' '));

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Resolve the five predefined entities and numeric character references. */
function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, ref: string) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[ref] ?? whole;
  });
}

const utf8Encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

function encodeUtf8(text: string): Uint8Array {
  if (utf8Encoder) return utf8Encoder.encode(text);
  const out: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  }
  return Uint8Array.from(out);
}

/** `"0a1b2c"` → bytes. Whitespace is tolerated; anything else is a bad file. */
function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, '');
  if (clean.length % 2 !== 0) throw new AepParseError('bdata has an odd number of hex digits');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(clean.substr(i * 2, 2), 16);
    if (Number.isNaN(byte)) throw new AepParseError('bdata contains a non-hexadecimal character');
    out[i] = byte;
  }
  return out;
}

// ── The scanner ─────────────────────────────────────────────────────

interface Tag {
  name: string;
  attrs: Record<string, string>;
  /** `<x/>` — opens and closes in one token. */
  selfClosing: boolean;
  /** `</x>`. */
  closing: boolean;
}

interface ScanState {
  text: string;
  pos: number;
}

const ATTR_RE = /([A-Za-z_:][-.\w:]*)\s*=\s*"([^"]*)"|([A-Za-z_:][-.\w:]*)\s*=\s*'([^']*)'/g;

/**
 * The next tag at or after `state.pos`, skipping text, comments, CDATA and
 * processing instructions. Returns null at end of document.
 *
 * Character data between tags is returned through `pendingText` on the caller's
 * side rather than here, because only `<string>` elements care about it.
 */
function nextTag(state: ScanState, textOut: { value: string }): Tag | null {
  const { text } = state;
  textOut.value = '';
  for (;;) {
    const lt = text.indexOf('<', state.pos);
    if (lt < 0) {
      state.pos = text.length;
      return null;
    }
    textOut.value += text.slice(state.pos, lt);

    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      state.pos = end < 0 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      const stop = end < 0 ? text.length : end;
      // CDATA is character data, so it belongs to the element's text — this is
      // how an expression containing `<` survives the round trip.
      textOut.value += text.slice(lt + 9, stop);
      state.pos = end < 0 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt + 2);
      state.pos = end < 0 ? text.length : end + 2;
      continue;
    }
    if (text.startsWith('<!', lt)) {
      // A DOCTYPE or other declaration. Skipped whole, and deliberately never
      // interpreted — an entity declared here is exactly the XXE we refuse.
      const end = text.indexOf('>', lt + 2);
      state.pos = end < 0 ? text.length : end + 1;
      continue;
    }

    const gt = text.indexOf('>', lt);
    if (gt < 0) {
      state.pos = text.length;
      return null;
    }
    const raw = text.slice(lt + 1, gt);
    state.pos = gt + 1;

    const closing = raw.startsWith('/');
    const selfClosing = raw.endsWith('/');
    const inner = raw.slice(closing ? 1 : 0, selfClosing ? -1 : undefined).trim();
    const nameMatch = /^[^\s/>]+/.exec(inner);
    if (!nameMatch) continue;
    const name = nameMatch[0];

    const attrs: Record<string, string> = {};
    if (!closing) {
      const rest = inner.slice(name.length);
      ATTR_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = ATTR_RE.exec(rest)) !== null) {
        const key = m[1] ?? m[3]!;
        const value = m[2] ?? m[4]!;
        attrs[key] = decodeEntities(value);
      }
    }
    return { name, attrs, selfClosing, closing };
  }
}

// ── XML → chunk tree ────────────────────────────────────────────────

interface Frame {
  /** The element name, before FourCC padding. */
  name: string;
  children: AepChunk[];
  /** Character data collected inside the element (only `<string>` uses it). */
  text: string;
  /** A leaf whose body came from `bdata`. */
  bdata?: Uint8Array;
}

/**
 * Turn one finished element into the chunk it stands for, or null when it is
 * not a chunk at all.
 */
function frameToChunk(frame: Frame): AepChunk | null {
  if (NOT_A_CHUNK.has(frame.name)) return null;

  // `<string>` is how AE writes a `Utf8` chunk in XML.
  if (frame.name === 'string') {
    return { id: 'Utf8', body: encodeUtf8(decodeEntities(frame.text)) };
  }

  const id = fourcc(frame.name);

  // A leaf: its body travelled as hex in the attribute.
  if (frame.bdata) return { id, body: frame.bdata };

  // Children present (or an element that is simply empty, like `<CPPl></CPPl>`
  // — an empty list is still a list). The wrapper chunks carry their children
  // without a list type, exactly as in the binary file, so the two readers
  // hand the semantic layer the same shape.
  if (CONTAINER_CHUNK_IDS.has(id)) return { id, children: frame.children };
  return { id: 'LIST', listType: id, children: frame.children };
}

/**
 * Parse an `.aepx` document into the chunk tree `aepRead.ts` consumes.
 *
 * Returns the root as `RIFX` / `Egg!`, matching `parseRifx`.
 */
export function parseAepx(xml: string): AepChunk {
  if (!xml.includes(ROOT_ELEMENT)) {
    throw new AepParseError(`not an After Effects XML project: no <${ROOT_ELEMENT}> element`);
  }
  const state: ScanState = { text: xml, pos: 0 };
  const textOut = { value: '' };
  const stack: Frame[] = [];
  let root: AepChunk | null = null;
  let chunks = 0;

  for (;;) {
    const tag = nextTag(state, textOut);
    if (textOut.value && stack.length > 0) stack[stack.length - 1]!.text += textOut.value;
    if (!tag) break;

    if (tag.closing) {
      const frame = stack.pop();
      if (!frame) continue; // stray close tag — ignore rather than abort the import
      const chunk = frameToChunk(frame);
      if (!chunk) continue;
      if (stack.length === 0) {
        if (frame.name === ROOT_ELEMENT) root = { id: 'RIFX', listType: 'Egg!', children: frame.children };
      } else {
        stack[stack.length - 1]!.children.push(chunk);
      }
      continue;
    }

    if ((chunks += 1) > MAX_CHUNKS) {
      throw new AepParseError('project has an implausible number of elements — refusing to continue');
    }

    const frame: Frame = { name: tag.name, children: [], text: '' };
    if (typeof tag.attrs.bdata === 'string') frame.bdata = hexToBytes(tag.attrs.bdata);

    if (tag.selfClosing) {
      const chunk = frameToChunk(frame);
      if (chunk && stack.length > 0) stack[stack.length - 1]!.children.push(chunk);
      continue;
    }

    if (stack.length >= MAX_DEPTH) {
      throw new AepParseError('project is nested more deeply than any real project — refusing to continue');
    }
    stack.push(frame);
  }

  if (!root) throw new AepParseError(`not an After Effects XML project: <${ROOT_ELEMENT}> never closed`);
  return root;
}

/** True when a file name looks like the XML project form. */
export const isAepxName = (name: string): boolean => /\.aepx$/i.test(name);
