/**
 * `.cube` LUT parsing and sampling.
 *
 * The assertion that earns its keep is `red varies fastest`. Every other bug in
 * a LUT implementation announces itself — a wrong domain crushes the shadows, a
 * bad parse returns null. Transposing the axis order does not: the image still
 * looks graded, plausibly so, and is wrong in a way you only catch by comparing
 * against the tool that authored the file. So the axis order is pinned with a
 * LUT whose three corners are deliberately distinguishable.
 */

import { parseCubeLut, sampleCubeLut, toStoredLut, fromStoredLut } from './cubeLut';

/** Identity 2×2×2 cube, written in the spec's order (red innermost). */
const IDENTITY_2 = `
TITLE "identity"
LUT_3D_SIZE 2
0 0 0
1 0 0
0 1 0
1 1 0
0 0 1
1 0 1
0 1 1
1 1 1
`;

describe('parseCubeLut', () => {
  it('parses a 3D LUT with title and default domain', () => {
    const lut = parseCubeLut(IDENTITY_2)!;
    expect(lut).toBeTruthy();
    expect(lut.size).toBe(2);
    expect(lut.size1d).toBe(0);
    expect(lut.title).toBe('identity');
    expect(lut.domainMin).toEqual([0, 0, 0]);
    expect(lut.domainMax).toEqual([1, 1, 1]);
    expect(lut.data).toHaveLength(8 * 3);
  });

  it('honours an explicit domain', () => {
    const lut = parseCubeLut(`LUT_3D_SIZE 2\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 4 4 4\n${'0 0 0\n'.repeat(8)}`)!;
    expect(lut.domainMax).toEqual([4, 4, 4]);
  });

  it('ignores comments and blank lines', () => {
    const lut = parseCubeLut(`# a comment\n\nLUT_3D_SIZE 2 # trailing\n${'0 0 0\n'.repeat(8)}`)!;
    expect(lut.size).toBe(2);
  });

  it('parses a 1D LUT rather than rejecting the same extension', () => {
    const lut = parseCubeLut('LUT_1D_SIZE 2\n0 0 0\n1 1 1\n')!;
    expect(lut.size1d).toBe(2);
    expect(lut.size).toBe(0);
  });

  it.each([
    ['no size header', '0 0 0\n0 0 0\n'],
    ['wrong entry count', 'LUT_3D_SIZE 2\n0 0 0\n'],
    ['both 1D and 3D', `LUT_3D_SIZE 2\nLUT_1D_SIZE 2\n${'0 0 0\n'.repeat(8)}`],
    ['non-numeric data', `LUT_3D_SIZE 2\n${'0 0 0\n'.repeat(7)}a b c\n`],
    ['an unknown keyword', `LUT_3D_SIZE 2\nWEIRD_KEY 3\n${'0 0 0\n'.repeat(8)}`],
    ['a degenerate domain', `LUT_3D_SIZE 2\nDOMAIN_MAX 0 1 1\n${'0 0 0\n'.repeat(8)}`],
    ['an absurd size', `LUT_3D_SIZE 512\n0 0 0\n`],
  ])('returns null for %s', (_why, text) => {
    expect(parseCubeLut(text)).toBeNull();
  });
});

describe('sampleCubeLut', () => {
  it('is the identity for an identity LUT', () => {
    const lut = parseCubeLut(IDENTITY_2)!;
    for (const [r, g, b] of [[0, 0, 0], [1, 1, 1], [0.25, 0.5, 0.75], [1, 0, 0.3]]) {
      const out = sampleCubeLut(lut, r!, g!, b!);
      expect(out[0]).toBeCloseTo(r!, 5);
      expect(out[1]).toBeCloseTo(g!, 5);
      expect(out[2]).toBeCloseTo(b!, 5);
    }
  });

  it('samples the corners in the documented axis order — red varies fastest', () => {
    // Entry 1 (index r=1,g=0,b=0) is tagged uniquely, as is entry 2 (g=1) and
    // entry 4 (b=1). Transposing any pair of axes moves these tags.
    const tagged = [
      '0 0 0',       // r0 g0 b0
      '0.9 0.1 0.1', // r1 g0 b0  ← red tag
      '0.1 0.9 0.1', // r0 g1 b0  ← green tag
      '0 0 0',
      '0.1 0.1 0.9', // r0 g0 b1  ← blue tag
      '0 0 0', '0 0 0', '0 0 0',
    ].join('\n');
    const lut = parseCubeLut(`LUT_3D_SIZE 2\n${tagged}\n`)!;

    expect(sampleCubeLut(lut, 1, 0, 0)[0]).toBeCloseTo(0.9, 5);
    expect(sampleCubeLut(lut, 0, 1, 0)[1]).toBeCloseTo(0.9, 5);
    expect(sampleCubeLut(lut, 0, 0, 1)[2]).toBeCloseTo(0.9, 5);
  });

  it('interpolates between entries rather than snapping', () => {
    const lut = parseCubeLut(IDENTITY_2)!;
    expect(sampleCubeLut(lut, 0.5, 0.5, 0.5)[0]).toBeCloseTo(0.5, 5);
  });

  it('clamps outside the domain instead of reading out of bounds', () => {
    const lut = parseCubeLut(IDENTITY_2)!;
    expect(sampleCubeLut(lut, -5, 0, 0)[0]).toBeCloseTo(0, 5);
    expect(sampleCubeLut(lut, 9, 0, 0)[0]).toBeCloseTo(1, 5);
    expect(sampleCubeLut(lut, NaN, 0, 0).every((n) => Number.isFinite(n))).toBe(true);
  });

  it('maps a non-default domain onto the cube', () => {
    // Domain 0..2 means an input of 2 lands on the cube's far corner.
    const lut = parseCubeLut(`LUT_3D_SIZE 2\nDOMAIN_MAX 2 2 2\n${IDENTITY_2.split('\n').filter((l) => /^[\d.]/.test(l)).join('\n')}\n`)!;
    expect(sampleCubeLut(lut, 2, 2, 2)[0]).toBeCloseTo(1, 5);
    expect(sampleCubeLut(lut, 1, 1, 1)[0]).toBeCloseTo(0.5, 5);
  });

  it('applies a 1D LUT per channel', () => {
    const lut = parseCubeLut('LUT_1D_SIZE 2\n0 0 0\n0.5 1 0.25\n')!;
    const out = sampleCubeLut(lut, 1, 1, 1);
    expect(out[0]).toBeCloseTo(0.5, 5);
    expect(out[1]).toBeCloseTo(1, 5);
    expect(out[2]).toBeCloseTo(0.25, 5);
  });

  it('writes into the caller\'s array so the per-pixel path allocates nothing', () => {
    const lut = parseCubeLut(IDENTITY_2)!;
    const out: [number, number, number] = [0, 0, 0];
    expect(sampleCubeLut(lut, 1, 1, 1, out)).toBe(out);
  });
});

describe('storage round-trip', () => {
  it('survives the JSON trip a .motion document makes', () => {
    const lut = parseCubeLut(IDENTITY_2)!;
    const revived = fromStoredLut(JSON.parse(JSON.stringify(toStoredLut(lut))))!;
    expect(revived).toBeTruthy();
    expect(revived.size).toBe(2);
    expect(revived.title).toBe('identity');
    expect(sampleCubeLut(revived, 0.25, 0.5, 0.75)[1]).toBeCloseTo(0.5, 5);
  });

  it.each([
    ['not an object', 42],
    ['no data', { size: 2 }],
    ['a truncated payload', { size: 2, size1d: 0, data: [0, 0, 0] }],
    ['a poisoned entry', { size: 2, size1d: 0, data: Array(24).fill(0).map((_, i) => (i === 3 ? 'x' : 0)) }],
  ])('rejects %s', (_why, raw) => {
    expect(fromStoredLut(raw)).toBeNull();
  });
});
