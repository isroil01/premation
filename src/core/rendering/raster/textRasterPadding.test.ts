/**
 * Text raster padding.
 *
 * A text layer rasterizes into a texture the size of its own box, so anything
 * drawn outside that box is sliced at the texture edge. That was invisible
 * while text just sat there — but a text animator's entire job is to move
 * glyphs off their baseline, so the moment animators started rendering, a
 * preset that lifted a character or scaled it up had the character cut off by
 * an invisible border.
 *
 * These pin the box growing to fit what the animators are actually doing.
 */

import { rasterPadding } from './vectorDraw';
import { identityGlyphTransform } from '@core/text/textAnimators';
import type { RenderLayer } from '../RenderBackend';

const textLayer = (over: Partial<RenderLayer> = {}): RenderLayer =>
  ({
    id: 't',
    kind: 'text',
    name: 'Text',
    x: 0,
    y: 0,
    rotation: 0,
    opacity: 1,
    width: 400,
    height: 100,
    fontSize: 40,
    visible: true,
    ...over,
  }) as unknown as RenderLayer;

describe('text raster padding', () => {
  it('is zero for plain text — the common case must not allocate more texture', () => {
    expect(rasterPadding(textLayer())).toBe(0);
  });

  it('is zero when animators are present but doing nothing', () => {
    const glyphs = [identityGlyphTransform('A'), identityGlyphTransform('B')];
    expect(rasterPadding(textLayer({ glyphs }))).toBe(0);
  });

  it('grows to fit a vertical offset', () => {
    const glyphs = [identityGlyphTransform('A', { dy: -34 })];
    expect(rasterPadding(textLayer({ glyphs }))).toBeGreaterThanOrEqual(34);
  });

  it('grows to fit a horizontal offset', () => {
    const glyphs = [identityGlyphTransform('A', { dx: 120 })];
    expect(rasterPadding(textLayer({ glyphs }))).toBeGreaterThanOrEqual(120);
  });

  it('grows for scale, proportionally to the font size', () => {
    // 220% on a 40px font grows the glyph by 0.6 em each side = 24px.
    const glyphs = [identityGlyphTransform('A', { scale: 2.2, scaleY: 2.2 })];
    const pad = rasterPadding(textLayer({ glyphs, fontSize: 40 }));
    expect(pad).toBeGreaterThanOrEqual(24);
    // A larger font at the same scale must reserve more room.
    const bigger = rasterPadding(textLayer({ glyphs, fontSize: 120 }));
    expect(bigger).toBeGreaterThan(pad);
  });

  it('grows for per-glyph blur and stroke', () => {
    expect(rasterPadding(textLayer({ glyphs: [identityGlyphTransform('A', { blur: 12 })] })))
      .toBeGreaterThanOrEqual(24);
    expect(rasterPadding(textLayer({ glyphs: [identityGlyphTransform('A', { strokeWidth: 20 })] })))
      .toBeGreaterThanOrEqual(10);
  });

  it('grows for skew, which shears the glyph sideways', () => {
    const glyphs = [identityGlyphTransform('A', { skew: 45 })];
    // tan(45°) = 1, over half an em of a 40px font = 20px.
    expect(rasterPadding(textLayer({ glyphs, fontSize: 40 }))).toBeGreaterThanOrEqual(20);
  });

  it('takes the largest escape across all glyphs, not the first', () => {
    const glyphs = [
      identityGlyphTransform('A'),
      identityGlyphTransform('B', { dy: -80 }),
      identityGlyphTransform('C', { dy: -10 }),
    ];
    expect(rasterPadding(textLayer({ glyphs }))).toBeGreaterThanOrEqual(80);
  });

  it('grows to fit a text path that leaves the box', () => {
    // An ellipse the text orbits, far outside a 400×100 box: without this the
    // orbit is cropped to the box and only the crossing arc survives.
    const points = [
      { x: -360, y: 0 }, { x: 0, y: -150 }, { x: 360, y: 0 }, { x: 0, y: 150 },
    ];
    const pad = rasterPadding(
      textLayer({ textPath: { points, closed: true, firstMargin: 0, reversed: false, perpendicular: true } } as Partial<RenderLayer>),
    );
    // 360 out on x against a half-width of 200 → 160 of escape, plus glyph room.
    expect(pad).toBeGreaterThanOrEqual(160);
  });

  it('is capped so an absurd offset cannot allocate without bound', () => {
    const glyphs = [identityGlyphTransform('A', { dx: 100000 })];
    expect(rasterPadding(textLayer({ glyphs }))).toBeLessThanOrEqual(513);
  });
});
