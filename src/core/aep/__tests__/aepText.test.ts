/**
 * COS, and the text document written in it.
 *
 * The three things that cost real debugging time are all asserted directly: the
 * body is a dictionary with no `<<` around it, its strings are UTF-16BE behind
 * a byte-order mark, and its parentheses nest and escape.
 */

import { cosGet, cosNumber, cosString, parseCos } from '../cos';
import { readTextDocument } from '../aepText';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/** A COS string literal: UTF-16BE text behind a byte-order mark. */
function literal(value: string): Uint8Array {
  const chars = [0x28, 0xfe, 0xff];
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    // The delimiters have to be escaped, exactly as AE escapes them.
    for (const b of [code >> 8, code & 0xff]) {
      if (b === 0x28 || b === 0x29 || b === 0x5c) chars.push(0x5c);
      chars.push(b);
    }
  }
  chars.push(0x29);
  return Uint8Array.from(chars);
}

function concat(parts: Array<Uint8Array | string>): Uint8Array {
  const all = parts.map((p) => (typeof p === 'string' ? bytes(p) : p));
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

describe('parseCos', () => {
  it('reads the body as a dictionary even though it has no delimiters', () => {
    // A `btdk` body opens straight onto a key. A reader that demands `<<` sees
    // a bare name, returns it, and finds no text anywhere in the layer.
    const value = parseCos(bytes('/0 << /1 42 >> /2 true'));
    expect(value.kind).toBe('dict');
    expect(cosNumber(cosGet(value, '0', '1'))).toBe(42);
    expect(cosGet(value, '2')).toMatchObject({ kind: 'bool', value: true });
  });

  it('decodes a UTF-16BE string behind its byte-order mark', () => {
    const doc = parseCos(concat(['/0 ', literal('Héllo')]));
    expect(cosString(cosGet(doc, '0'))).toBe('Héllo');
  });

  it('does not end a string at an escaped parenthesis', () => {
    // Kinsoku character sets are full of brackets, so this is not a corner case
    // — it is most real text documents.
    const doc = parseCos(concat(['/0 ', literal('a)b(c')]));
    expect(cosString(cosGet(doc, '0'))).toBe('a)b(c');
  });

  it('reads arrays and the numbers in them', () => {
    const doc = parseCos(bytes('/0 [ 1.5 -2 3e0 ]'));
    expect(cosGet(doc, '0', 0)).toMatchObject({ kind: 'number', value: 1.5 });
    expect(cosGet(doc, '0', 1)).toMatchObject({ kind: 'number', value: -2 });
  });

  it('returns a value rather than throwing on a truncated blob', () => {
    // A text layer that cannot be decoded should cost a warning, not the import.
    expect(() => parseCos(bytes('/0 << /1 [ 2 3'))).not.toThrow();
  });
});

describe('readTextDocument', () => {
  /**
   * The shape AE writes, assembled rather than spelled out.
   *
   * A run list is three levels of single-key wrapper before the style itself,
   * which is AE's nesting and not a mistake — writing it as one long literal is
   * how a fixture ends up with unbalanced delimiters that the parser recovers
   * from and the test then measures.
   */
  const runs = (key: string, style: string): string => `/${key} << /0 [ << /0 << /0 << /${key} ${style} >> >> >> ] >>`;

  const document = (text: string, { font = 'MyriadPro-Regular', size = 36 } = {}): Uint8Array => {
    const paragraph = runs('5', '<< /0 0 >>');
    const character = runs(
      '6',
      `<< /0 0 /1 ${size} /53 << /99 /SimplePaint /0 << /0 1 /1 [ 1.0 0.25 0.5 0.75 ] >> >> >>`,
    );
    return concat([
      // The resource dictionary: the font table the character style indexes into.
      '/0 << /1 << /0 [ << /0 << /99 /CoolTypeFont /0 << /0 ',
      literal(font),
      ' >> >> >> ] >> >> ',
      // The document itself.
      '/1 << /1 [ << /0 << /0 ',
      literal(text),
      ` ${paragraph} ${character} >> >> ] >> >>`,
    ]);
  };

  it('finds the source text', () => {
    expect(readTextDocument(document('Sample Text'))?.text).toBe('Sample Text');
  });

  it('turns AE’s carriage returns into line feeds', () => {
    // AE ends a paragraph with CR; leaving it in shows up as a box glyph.
    expect(readTextDocument(document('one\rtwo'))?.text).toBe('one\ntwo');
  });

  it('resolves the font through the table the index points into', () => {
    expect(readTextDocument(document('x', { font: 'Helvetica' })?.slice())?.font).toBe('Helvetica');
  });

  it('reads the point size and the fill colour', () => {
    const doc = readTextDocument(document('x', { size: 48 }));
    expect(doc?.fontSize).toBe(48);
    // `SimplePaint` stores alpha first; reading it as RGB tints every layer.
    expect(doc?.fillColor).toEqual({ r: 0.25, g: 0.5, b: 0.75 });
  });

  it('counts the style runs, so a mixed layer can be reported', () => {
    expect(readTextDocument(document('x'))?.styleRuns).toBe(1);
  });

  it('returns null for a blob with no text in it', () => {
    expect(readTextDocument(bytes('/0 << /1 3 >>'))).toBeNull();
  });
});
