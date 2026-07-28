import { layoutPerChar3D, MAX_PER_CHAR_GLYPHS, FALLBACK_ADVANCE_RATIO } from './perChar3D';
import { identityGlyphTransform, type GlyphTransform } from './textAnimators';

/** Deterministic metrics so placement assertions don't depend on a font. */
const measure = (char: string, style: { fontSize?: number }) =>
  (style.fontSize ?? 16) * FALLBACK_ADVANCE_RATIO * (char === ' ' ? 0.5 : 1);

const style = { fontSize: 40, fontFamily: 'Inter', align: 'center' as const, lineHeight: 1.2 };

function place(text: string, transforms?: GlyphTransform[]) {
  return layoutPerChar3D({ text, style, boxWidth: 600, transforms, measure });
}

describe('layoutPerChar3D', () => {
  it('emits one placement per non-whitespace glyph', () => {
    const g = place('AB C');
    expect(g.map((p) => p.char)).toEqual(['A', 'B', 'C']);
    // Indices stay tied to the ORIGINAL string (the space keeps its slot), so
    // animator ranges and rich-text runs still line up per character.
    expect(g.map((p) => p.index)).toEqual([0, 1, 3]);
  });

  it('empty text produces nothing', () => {
    expect(place('')).toEqual([]);
  });

  it('lays glyphs out left-to-right without overlapping', () => {
    const g = place('ABC');
    expect(g[0]!.offsetX).toBeLessThan(g[1]!.offsetX);
    expect(g[1]!.offsetX).toBeLessThan(g[2]!.offsetX);
    // Consecutive centres are one advance apart (uniform glyphs here).
    const d1 = g[1]!.offsetX - g[0]!.offsetX;
    const d2 = g[2]!.offsetX - g[1]!.offsetX;
    expect(d2).toBeCloseTo(d1, 5);
  });

  it('centre-aligned text is symmetric about the layer centre', () => {
    const g = place('AB');
    expect(g[0]!.offsetX + g[1]!.offsetX).toBeCloseTo(0, 5);
  });

  it('glyph boxes are padded so overhanging ink is not clipped', () => {
    const g = place('A');
    const advance = measure('A', style);
    expect(g[0]!.width).toBeGreaterThan(advance);
    expect(g[0]!.height).toBeGreaterThan(style.fontSize);
  });

  it('multi-line text separates glyphs vertically', () => {
    const g = place('A\nB');
    expect(g).toHaveLength(2);
    expect(g[1]!.offsetY).toBeGreaterThan(g[0]!.offsetY);
  });

  it('carries the animator 3D channels through to each glyph', () => {
    const t: GlyphTransform[] = [
      identityGlyphTransform('A', { dz: 120, rotationY: 45 }),
      identityGlyphTransform('B', { dz: -60, rotationX: 30, scale: 2, rotation: 15, opacity: 0.5 }),
    ];
    const g = place('AB', t);
    expect(g[0]!.offsetZ).toBe(120);
    expect(g[0]!.rotationY).toBe(45);
    expect(g[1]!.offsetZ).toBe(-60);
    expect(g[1]!.rotationX).toBe(30);
    expect(g[1]!.scale).toBe(2);
    expect(g[1]!.rotation).toBe(15);
    expect(g[1]!.opacity).toBe(0.5);
  });

  it('a transform-free layer yields neutral per-glyph values', () => {
    const g = place('A');
    expect(g[0]!.offsetZ).toBe(0);
    expect(g[0]!.rotationX).toBe(0);
    expect(g[0]!.rotationY).toBe(0);
    expect(g[0]!.scale).toBe(1);
    expect(g[0]!.opacity).toBe(1);
  });

  it('refuses absurd glyph counts (falls back to the single plane)', () => {
    expect(place('x'.repeat(MAX_PER_CHAR_GLYPHS + 1))).toEqual([]);
    expect(place('x'.repeat(MAX_PER_CHAR_GLYPHS))).toHaveLength(MAX_PER_CHAR_GLYPHS);
  });
});
