/**
 * The OpenType outline reader.
 *
 * Two layers of evidence. A hand-built TrueType face always runs and pins the
 * byte-level contract (directory, cmap 4, loca/glyf, quadratic → cubic). The
 * real-font cases run when the OS has the faces and pin what matters to the
 * feature: a T is eight corners, an O is an outer ring plus a counter with
 * opposite winding, an `e` has its counter. They are skipped, not failed,
 * where the files are absent — a CI box has no Arial.
 */

import { existsSync, readFileSync } from 'fs';
import { parseFont } from './openType';

const signedArea = (pts: ReadonlyArray<{ x: number; y: number }>): number => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!, q = pts[(i + 1) % pts.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
};

// ── A minimal TrueType face: one glyph, a square with one curved corner ──

function u16(v: number): number[] { return [(v >> 8) & 255, v & 255]; }
function u32(v: number): number[] { return [(v >>> 24) & 255, (v >> 16) & 255, (v >> 8) & 255, v & 255]; }
function i16(v: number): number[] { return u16(v & 0xffff); }

function buildTtf(): ArrayBuffer {
  // glyf: gid 0 = .notdef (empty), gid 1 = the square: (0,0) (100,0) (100,100) off(50,150) (0,100)
  const glyph1 = [
    ...i16(1), ...i16(0), ...i16(0), ...i16(100), ...i16(150), // numberOfContours, bbox
    ...u16(4),              // endPtsOfContours[0] = 4 (5 points)
    ...u16(0),              // instructionLength
    // flags: on-curve(1) + x-short/y-short unset so we use int16 deltas. Point 3 is off-curve (flag 0).
    1, 1, 1, 0, 1,
    // x deltas: 0, +100, 0, -50, -50
    ...i16(0), ...i16(100), ...i16(0), ...i16(-50), ...i16(-50),
    // y deltas: 0, 0, +100, +50, -50
    ...i16(0), ...i16(0), ...i16(100), ...i16(50), ...i16(-50),
  ];
  const glyf = [...glyph1];
  const loca = [...u16(0), ...u16(0), ...u16(glyf.length / 2)]; // short offsets ×2: gid0 empty, gid1 = whole
  const head = new Array(54).fill(0); head.splice(18, 2, ...u16(1000)); // unitsPerEm; indexToLocFormat stays 0 (short)
  const hhea = new Array(36).fill(0); hhea.splice(4, 2, ...i16(800)); hhea.splice(6, 2, ...i16(-200)); hhea.splice(34, 2, ...u16(2));
  const hmtx = [...u16(500), ...u16(0), ...u16(600), ...u16(0)];
  const maxp = [...u32(0x00010000), ...u16(2)];
  // cmap: one format-4 subtable mapping 'A' (65) → gid 1.
  const sub4 = [
    ...u16(4), ...u16(32), ...u16(0), ...u16(4), ...u16(4), ...u16(1), ...u16(0),
    ...u16(65), ...u16(0xffff),           // endCode
    ...u16(0),                            // reservedPad
    ...u16(65), ...u16(0xffff),           // startCode
    ...i16(1 - 65), ...i16(1),            // idDelta
    ...u16(0), ...u16(0),                 // idRangeOffset
  ];
  const cmap = [...u16(0), ...u16(1), ...u16(3), ...u16(1), ...u32(12), ...sub4];
  const tables: Array<[string, number[]]> = [['cmap', cmap], ['glyf', glyf], ['head', head], ['hhea', hhea], ['hmtx', hmtx], ['loca', loca], ['maxp', maxp]];
  const dirLen = 12 + tables.length * 16;
  let offset = dirLen;
  const dir: number[] = [...u32(0x00010000), ...u16(tables.length), ...u16(0), ...u16(0), ...u16(0)];
  const body: number[] = [];
  for (const [tag, data] of tables) {
    dir.push(...tag.split('').map((c) => c.charCodeAt(0)), ...u32(0), ...u32(offset), ...u32(data.length));
    const padded = [...data]; while (padded.length % 4) padded.push(0);
    body.push(...padded);
    offset += padded.length;
  }
  return new Uint8Array([...dir, ...body]).buffer;
}

describe('hand-built TrueType', () => {
  const font = parseFont(buildTtf())!;

  it('parses the directory, metrics and character map', () => {
    expect(font).not.toBeNull();
    expect(font.kind).toBe('glyf');
    expect(font.unitsPerEm).toBe(1000);
    expect(font.glyphFor(65)!.advance).toBe(600);
    expect(font.glyphFor(66)).toBeNull(); // unmapped → null, not .notdef
  });

  it('turns the quadratic corner into an exact cubic and keeps the corners sharp', () => {
    const [c] = font.glyphFor(65)!.contours;
    const pts = c!.points;
    expect(pts).toHaveLength(4);
    // Corners carry collapsed handles…
    expect(pts[0]).toMatchObject({ x: 0, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 });
    // …and the curved edge between (100,100) and (0,100) via Q=(50,150)
    // has handles at ⅔ of the way to Q from each end.
    const from = pts.find((p) => p.x === 100 && p.y === 100)!;
    const to = pts.find((p) => p.x === 0 && p.y === 100)!;
    expect(from.outX).toBeCloseTo(100 + (2 / 3) * (50 - 100));
    expect(from.outY).toBeCloseTo(100 + (2 / 3) * (150 - 100));
    expect(to.inX).toBeCloseTo(0 + (2 / 3) * (50 - 0));
    expect(to.inY).toBeCloseTo(100 + (2 / 3) * (150 - 100));
  });
});

describe.each([
  ['C:/Windows/Fonts/arial.ttf', 'glyf'],
  ['C:/Windows/Fonts/georgia.ttf', 'glyf'],
] as const)('real face %s', (file, kind) => {
  const present = existsSync(file);
  const load = () => {
    const b = readFileSync(file);
    return parseFont(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))!;
  };
  (present ? it : it.skip)('is the expected outline kind', () => {
    expect(load().kind).toBe(kind);
  });
  (present ? it : it.skip)('gives T one contour and O an outer ring plus a counter of opposite winding', () => {
    const f = load();
    expect(f.glyphFor('T'.charCodeAt(0))!.contours).toHaveLength(1);
    const O = f.glyphFor('O'.charCodeAt(0))!.contours;
    expect(O).toHaveLength(2);
    expect(Math.sign(signedArea(O[0]!.points))).toBe(-Math.sign(signedArea(O[1]!.points)));
    expect(f.glyphFor('e'.charCodeAt(0))!.contours).toHaveLength(2);
  });
  (present ? it : it.skip)('reports advances and an empty space glyph', () => {
    const f = load();
    expect(f.glyphFor(' '.charCodeAt(0))!.contours).toHaveLength(0);
    expect(f.glyphFor(' '.charCodeAt(0))!.advance).toBeGreaterThan(0);
  });
});

describe('real CFF face (when a copy is available)', () => {
  const file = process.env.OTF_FIXTURE ?? 'C:/Users/isroi/AppData/Local/Temp/claude/C--Users-isroi-dev-motion-editor/d313abdd-351b-4fad-8f2a-2ac5d96a63f3/scratchpad/SourceSans3-Regular.otf';
  const present = existsSync(file);
  (present ? it : it.skip)('interprets Type 2 charstrings: T is eight corners, g has two counters', () => {
    const b = readFileSync(file);
    const f = parseFont(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))!;
    expect(f.kind).toBe('cff');
    expect(f.glyphFor('T'.charCodeAt(0))!.contours[0]!.points).toHaveLength(8);
    const g = f.glyphFor('g'.charCodeAt(0))!.contours;
    expect(g).toHaveLength(3);
    const signs = g.map((c) => Math.sign(signedArea(c.points)));
    expect(signs.filter((s) => s === signs[0]).length).toBe(1); // one outer, two holes
  });
});
