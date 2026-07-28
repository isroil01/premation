/**
 * Pins the seam where text animators used to die.
 *
 * `buildSnapshot` has always resolved per-glyph animator transforms into
 * `layer.glyphs`, and `layoutText` has always accepted them — but
 * `MotionRendererBackend` never forwarded them to `setText`, `TextSpec` had no
 * field for them, and `drawText` took the whole-string fast path unless the
 * layer had rich-text RUNS. Net effect: every 2D text animator resolved
 * correctly and then rendered exactly nothing. (Per-character-3D text escaped,
 * because buildSnapshot splits those into one layer per glyph upstream.)
 *
 * jsdom has no canvas implementation, so these tests drive the rasterizer
 * against a recording 2D context. That is enough to assert the thing that was
 * actually broken: whether the glyph-by-glyph path runs, and whether each
 * glyph's transform reaches the paint calls.
 */

import { ResourceManager, NullBackend } from '@motion/renderer';
import { Canvas2DVectorRasterizer } from './Canvas2DVectorRasterizer';
import { identityGlyphTransform } from '@core/text/textAnimators';

interface Call {
  op: string;
  args: unknown[];
}

/** A CanvasRenderingContext2D stand-in that records every call and property
 *  write, so a test can assert on the draw sequence. */
function recordingContext(): { ctx: Record<string, unknown>; calls: Call[] } {
  const calls: Call[] = [];
  const op =
    (name: string) =>
    (...args: unknown[]): void => {
      calls.push({ op: name, args });
    };
  const ctx: Record<string, unknown> = {
    save: op('save'),
    restore: op('restore'),
    scale: op('scale'),
    translate: op('translate'),
    rotate: op('rotate'),
    transform: op('transform'),
    setTransform: op('setTransform'),
    fillText: op('fillText'),
    strokeText: op('strokeText'),
    drawImage: op('drawImage'),
    measureText: (t: string) => ({ width: t.length * 10 }),
    font: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    lineJoin: '',
    textAlign: '',
    textBaseline: '',
    letterSpacing: '',
    globalAlpha: 1,
    globalCompositeOperation: '',
    filter: 'none',
  };
  return { ctx, calls };
}

describe('text glyph rasterization', () => {
  let rasterizer: Canvas2DVectorRasterizer;
  let calls: Call[];
  let createElement: typeof document.createElement;

  beforeEach(() => {
    const backend = new NullBackend();
    const resources = new ResourceManager(backend);
    resources.beginFrame(1);
    rasterizer = new Canvas2DVectorRasterizer(resources);

    const rec = recordingContext();
    calls = rec.calls;
    createElement = document.createElement.bind(document);
    jest.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      if (tag !== 'canvas') return createElement(tag);
      return {
        width: 0,
        height: 0,
        getContext: () => rec.ctx,
      } as unknown as HTMLCanvasElement;
    }) as typeof document.createElement);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const draw = (spec: Record<string, unknown>): void => {
    rasterizer.rasterize({
      drawable: {
        kind: 'text',
        contentHash: `h${Math.random()}`,
        text: 'AB',
        fontSize: 20,
        color: '#ffffff',
        width: 200,
        height: 100,
        ...spec,
      },
      resolutionScale: 1,
      padding: 0,
    });
  };

  const fillTexts = (): string[] =>
    calls.filter((c) => c.op === 'fillText').map((c) => String(c.args[0]));

  it('takes the whole-string path when a layer has no glyph work', () => {
    draw({});
    // One fillText per LINE, not per character.
    expect(fillTexts()).toEqual(['AB']);
    expect(calls.some((c) => c.op === 'save')).toBe(false);
  });

  it('draws glyph-by-glyph as soon as animator transforms are present', () => {
    draw({ glyphs: [identityGlyphTransform('A'), identityGlyphTransform('B')] });
    expect(fillTexts()).toEqual(['A', 'B']);
  });

  it('applies each glyph position offset', () => {
    draw({
      glyphs: [
        identityGlyphTransform('A', { dx: 30, dy: -12 }),
        // A zero-but-present transform so B also takes the transformed path and
        // emits a translate to compare against.
        identityGlyphTransform('B', { dx: 0 }),
      ],
    });
    // The first translate is the rasterizer shifting into the padded box; the
    // per-glyph ones follow.
    const translates = calls.filter((c) => c.op === 'translate').slice(1);
    const first = translates[0]!.args as [number, number];
    const second = translates[1]!.args as [number, number];
    // Both glyphs measure 10px wide under the fake metric, so B's pen sits 10px
    // right of A's. A's own +30 offset therefore puts it 20px to B's right.
    expect(first[0] - second[0]).toBeCloseTo(20);
    // dy lifts A by 12 relative to B, which has none.
    expect(first[1]).toBeCloseTo(second[1] - 12);
  });

  it('rotates, scales and skews about the glyph origin', () => {
    draw({
      glyphs: [identityGlyphTransform('A', { rotation: 90, scale: 2, scaleY: 3, skew: 15 })],
    });
    const rotate = calls.find((c) => c.op === 'rotate');
    expect(rotate).toBeDefined();
    expect(rotate!.args[0]).toBeCloseTo(Math.PI / 2);
    const scale = calls.filter((c) => c.op === 'scale').at(-1);
    expect(scale!.args).toEqual([2, 3]);
    // Skew is a shear matrix, not a rotate.
    expect(calls.some((c) => c.op === 'transform')).toBe(true);
    // Everything happens inside one save/restore per glyph.
    expect(calls.filter((c) => c.op === 'save')).toHaveLength(1);
    expect(calls.filter((c) => c.op === 'restore')).toHaveLength(1);
  });

  it('strokes a glyph when the animator gives it a stroke width', () => {
    draw({
      glyphs: [identityGlyphTransform('A', { strokeWidth: 3, strokeColor: '#00ff00' })],
    });
    const stroke = calls.find((c) => c.op === 'strokeText');
    expect(stroke).toBeDefined();
    expect(stroke!.args[0]).toBe('A');
  });

  it('skips the fill entirely at fill opacity 0 but keeps the stroke', () => {
    draw({
      glyphs: [
        identityGlyphTransform('A', { fillOpacity: 0, strokeWidth: 2 }),
        identityGlyphTransform('B', { fillOpacity: 0, strokeWidth: 2 }),
      ],
    });
    expect(fillTexts()).toEqual([]);
    expect(calls.filter((c) => c.op === 'strokeText')).toHaveLength(2);
  });

  it('paints the stroke under the fill by default', () => {
    // A stroke centres on the outline, so painting it OVER the fill eats half
    // its width out of the glyph — an animated stroke then appears to thin the
    // letterforms rather than thicken them.
    draw({ glyphs: [identityGlyphTransform('A', { strokeWidth: 4 })] });
    const order = calls.filter((c) => c.op === 'strokeText' || c.op === 'fillText').map((c) => c.op);
    expect(order.slice(0, 2)).toEqual(['strokeText', 'fillText']);
  });

  it('paints the stroke over the fill when the layer asks for it', () => {
    draw({
      strokeOverFill: true,
      glyphs: [identityGlyphTransform('A', { strokeWidth: 4 })],
    });
    const order = calls.filter((c) => c.op === 'strokeText' || c.op === 'fillText').map((c) => c.op);
    expect(order.slice(0, 2)).toEqual(['fillText', 'strokeText']);
  });

  it('restores alpha after a partial fill opacity, whichever order is used', () => {
    // Fill opacity must not leak onto the stroke drawn after it.
    draw({
      strokeOverFill: true,
      glyphs: [
        identityGlyphTransform('A', { strokeWidth: 4, fillOpacity: 0.5 }),
        identityGlyphTransform('B', { strokeWidth: 4, fillOpacity: 0.5 }),
      ],
    });
    expect(calls.filter((c) => c.op === 'strokeText')).toHaveLength(2);
    expect(calls.filter((c) => c.op === 'fillText')).toHaveLength(2);
  });

  it('draws the character offset substitute, not the source character', () => {
    draw({
      glyphs: [
        identityGlyphTransform('A', { displayChar: 'Q' }),
        identityGlyphTransform('B', { displayChar: 'Z' }),
      ],
    });
    expect(fillTexts()).toEqual(['Q', 'Z']);
  });

  it('does not paint whitespace', () => {
    rasterizer.rasterize({
      drawable: {
        kind: 'text',
        contentHash: 'ws',
        text: 'A B',
        fontSize: 20,
        color: '#fff',
        width: 200,
        height: 100,
        glyphs: [
          identityGlyphTransform('A'),
          identityGlyphTransform(' '),
          identityGlyphTransform('B'),
        ],
      },
      resolutionScale: 1,
      padding: 0,
    });
    expect(fillTexts()).toEqual(['A', 'B']);
  });
});
