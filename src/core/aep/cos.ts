/**
 * COS — the object notation a text layer's source is written in.
 *
 * After Effects stores a text layer's document (the string, its fonts, its
 * per-character styling) not as chunks but as a blob inside a `btdk` list,
 * written in Adobe's COS: the same `<< /key value >>` dictionaries, `[ … ]`
 * arrays and `( … )` strings that PostScript and PDF use. Photoshop's
 * "EngineData" is the same notation, which is a useful sanity check when
 * something here looks strange.
 *
 * Three things about it are not obvious and cost real debugging time:
 *
 *  • **Keys are numbers, not words.** A dictionary reads `<< /0 2 /1 12.0 >>`.
 *    The names are ordinals into a schema Adobe never published, so the only
 *    way to know that `/1` is the font size is to change it in AE and diff —
 *    which is why `aepText.ts` reads a deliberately small set of them and says
 *    so, rather than pretending to a full decode.
 *
 *  • **Strings are UTF-16BE with a byte-order mark**, inside byte-oriented
 *    parentheses. `(\xfe\xff\0S\0a\0m…)` is `"Sam…"`. A reader that treats
 *    them as ASCII gets every other byte and produces `"Sml et"`.
 *
 *  • **Parentheses nest and escape.** `\)` is a literal paren and does not
 *    close the string, and an unescaped `(` inside opens a nested one. Both
 *    appear in real documents (kinsoku character sets are full of brackets),
 *    so the scanner tracks depth instead of looking for the next `)`.
 *
 * The parser is deliberately total: it never throws on malformed input, it
 * stops at the end of the buffer, and it has a node budget. A text layer that
 * cannot be decoded should cost the user a warning, not the import.
 */

export type CosValue =
  | { kind: 'dict'; entries: Map<string, CosValue> }
  | { kind: 'array'; items: CosValue[] }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'name'; value: string }
  | { kind: 'null' };

/** Deeper than any text document; a runaway `<<` cannot outlast it. */
const MAX_DEPTH = 96;
/** A 100 KB blob of `true`s would stop here long before it mattered. */
const MAX_NODES = 400_000;

const SPACE = new Set([0x20, 0x09, 0x0a, 0x0d, 0x00, 0x0c]);

const isDigit = (b: number): boolean => b >= 0x30 && b <= 0x39;

class CosScanner {
  pos = 0;
  nodes = 0;

  constructor(private readonly bytes: Uint8Array) {}

  atEnd(): boolean {
    return this.pos >= this.bytes.length;
  }

  skipSpace(): void {
    while (this.pos < this.bytes.length) {
      const b = this.bytes[this.pos]!;
      if (SPACE.has(b)) {
        this.pos += 1;
        continue;
      }
      // `%` runs to end of line — PostScript's comment, and AE does emit them.
      if (b === 0x25) {
        while (this.pos < this.bytes.length && this.bytes[this.pos] !== 0x0a) this.pos += 1;
        continue;
      }
      return;
    }
  }

  /** A `( … )` string: depth-tracked, escape-aware, UTF-16BE when marked. */
  readString(): string {
    this.pos += 1; // consume '('
    const out: number[] = [];
    let depth = 1;
    while (this.pos < this.bytes.length) {
      const b = this.bytes[this.pos]!;
      if (b === 0x5c) {
        // A backslash escape. COS also uses `\ddd` octal and `\n`-style
        // shorthands, but AE writes UTF-16 code units raw and only ever escapes
        // the delimiters, so passing the next byte through verbatim is both
        // correct for what AE emits and safe for what it does not.
        const next = this.bytes[this.pos + 1];
        if (next !== undefined) out.push(next);
        this.pos += 2;
        continue;
      }
      if (b === 0x28) depth += 1;
      if (b === 0x29) {
        depth -= 1;
        if (depth === 0) {
          this.pos += 1;
          break;
        }
      }
      out.push(b);
      this.pos += 1;
    }
    return decodeCosString(Uint8Array.from(out));
  }

  readValue(depth: number): CosValue {
    if ((this.nodes += 1) > MAX_NODES || depth > MAX_DEPTH) return { kind: 'null' };
    this.skipSpace();
    if (this.atEnd()) return { kind: 'null' };
    const b = this.bytes[this.pos]!;

    if (b === 0x3c && this.bytes[this.pos + 1] === 0x3c) return this.readDict(depth);
    if (b === 0x5b) return this.readArray(depth);
    if (b === 0x28) return { kind: 'string', value: this.readString() };
    if (b === 0x2f) return { kind: 'name', value: this.readNameToken() };
    if (isDigit(b) || b === 0x2d || b === 0x2b || b === 0x2e) return this.readNumber();

    const word = this.readBareToken();
    if (word === 'true') return { kind: 'bool', value: true };
    if (word === 'false') return { kind: 'bool', value: false };
    if (word === 'null' || word === 'nil' || word === '') return { kind: 'null' };
    return { kind: 'name', value: word };
  }

  /**
   * A dictionary.
   *
   * `implicit` reads one that has no `<<` … `>>` around it, which is how the
   * DOCUMENT itself is written: a `btdk` body opens straight onto `/98 << … >>
   * /0 << … >>` with no wrapper, so a reader that demands the delimiters sees a
   * bare name, returns it, and finds no text anywhere in the layer.
   */
  readDict(depth: number, implicit = false): CosValue {
    if (!implicit) this.pos += 2; // '<<'
    const entries = new Map<string, CosValue>();
    for (;;) {
      this.skipSpace();
      if (this.atEnd()) break;
      if (this.bytes[this.pos] === 0x3e && this.bytes[this.pos + 1] === 0x3e) {
        if (implicit) break; // a stray close is not ours to consume
        this.pos += 2;
        break;
      }
      if (this.bytes[this.pos] !== 0x2f) {
        // Not a key where one was due. Skip a value and try again rather than
        // abandon the dictionary — one unreadable entry should not cost the
        // string sitting next to it.
        const before = this.pos;
        this.readValue(depth + 1);
        if (this.pos === before) this.pos += 1;
        continue;
      }
      const key = this.readNameToken();
      const value = this.readValue(depth + 1);
      entries.set(key, value);
    }
    return { kind: 'dict', entries };
  }

  private readArray(depth: number): CosValue {
    this.pos += 1; // '['
    const items: CosValue[] = [];
    for (;;) {
      this.skipSpace();
      if (this.atEnd()) break;
      if (this.bytes[this.pos] === 0x5d) {
        this.pos += 1;
        break;
      }
      const before = this.pos;
      items.push(this.readValue(depth + 1));
      if (this.pos === before) {
        this.pos += 1; // never spin on a byte we cannot classify
      }
    }
    return { kind: 'array', items };
  }

  private readNameToken(): string {
    this.pos += 1; // '/'
    return this.readBareToken();
  }

  private readBareToken(): string {
    let out = '';
    while (this.pos < this.bytes.length) {
      const b = this.bytes[this.pos]!;
      if (SPACE.has(b) || b === 0x2f || b === 0x5b || b === 0x5d || b === 0x3c || b === 0x3e || b === 0x28 || b === 0x29) break;
      out += String.fromCharCode(b);
      this.pos += 1;
    }
    return out;
  }

  private readNumber(): CosValue {
    const token = this.readBareToken();
    const value = Number.parseFloat(token);
    return Number.isFinite(value) ? { kind: 'number', value } : { kind: 'null' };
  }
}

/**
 * A COS string's bytes as text.
 *
 * AE marks UTF-16BE with the usual BOM. Anything else is a short ASCII token
 * (a font's PostScript name in some files, a paint class name), so latin-1 is
 * both correct for those and lossless for round-tripping unknown bytes.
 */
export function decodeCosString(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let out = '';
    for (let i = 2; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i]! << 8) | bytes[i + 1]!);
    return out;
  }
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}

/**
 * Parse a `btdk` body. Returns the top-level value, always.
 *
 * The body is an unwrapped dictionary — it starts on a key, not on `<<` — so
 * that case is detected and read as one. A body that does start with a real
 * value is read as that value, which keeps the function usable on the nested
 * blobs (paint descriptors, kinsoku sets) that ARE wrapped.
 */
export function parseCos(bytes: Uint8Array): CosValue {
  const scanner = new CosScanner(bytes);
  scanner.skipSpace();
  if (!scanner.atEnd() && bytes[scanner.pos] === 0x2f) return scanner.readDict(0, true);
  return scanner.readValue(0);
}

// ── Navigation ──────────────────────────────────────────────────────
//
// Reading a document means walking a path of numeric keys, and `value.kind ===
// 'dict' && value.entries.get('0')` at every step is unreadable. These say the
// same thing in one call and return undefined rather than throwing, because a
// path that is not there is the normal case for an older file.

export function cosGet(value: CosValue | undefined, ...path: (string | number)[]): CosValue | undefined {
  let cur = value;
  for (const step of path) {
    if (!cur) return undefined;
    if (typeof step === 'number') {
      if (cur.kind !== 'array') return undefined;
      cur = cur.items[step];
    } else {
      if (cur.kind !== 'dict') return undefined;
      cur = cur.entries.get(step);
    }
  }
  return cur;
}

export const cosString = (value: CosValue | undefined): string | undefined =>
  value?.kind === 'string' ? value.value : undefined;

export const cosNumber = (value: CosValue | undefined): number | undefined =>
  value?.kind === 'number' ? value.value : undefined;

export const cosBool = (value: CosValue | undefined): boolean | undefined =>
  value?.kind === 'bool' ? value.value : undefined;

export const cosArray = (value: CosValue | undefined): CosValue[] | undefined =>
  value?.kind === 'array' ? value.items : undefined;

/**
 * Every dictionary in the tree, depth-first.
 *
 * The fallbacks in `aepText.ts` need "find the dictionary that looks like a
 * style run" when the expected path is missing, and this is how they look.
 */
export function* cosWalk(value: CosValue | undefined): Generator<CosValue> {
  if (!value) return;
  yield value;
  if (value.kind === 'dict') for (const child of value.entries.values()) yield* cosWalk(child);
  else if (value.kind === 'array') for (const child of value.items) yield* cosWalk(child);
}
