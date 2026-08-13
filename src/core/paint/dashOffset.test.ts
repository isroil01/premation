/**
 * Stroke dash OFFSET — the animating half of dashes.
 *
 * ## What these guards are shaped against
 *
 * Dashes are PERIODIC. Offset 0 and offset `sum(dash)` draw the same picture,
 * pixel for pixel, so a fixture at either value is satisfied by a build that
 * ignores the offset completely (rule 3a). Every assertion below that cares
 * about a specific offset uses a value that is neither — a quarter period —
 * and the periodicity itself is asserted separately, as a property, rather than
 * being allowed to hide a bug.
 *
 * The second failure this invites is plumbing: the value has to survive
 * normalisation, the animated-value fold in `buildSnapshot`, the raster cache
 * key, and the canvas call. Each hop is guarded, because a green unit test on
 * either side of a dropped hop looks exactly like a working feature.
 */

import { normalizeStroke, defaultStroke, type Stroke } from './stroke';
import { applyStrokeStyle } from '@core/rendering/raster/vectorDraw';
import { contentHashOf } from '@core/rendering/contentHash';
import type { RenderLayer } from '@core/rendering/RenderBackend';

/** The pattern used throughout: period = 24 + 12 = 36. */
const DASH = [24, 12];
const PERIOD = DASH[0]! + DASH[1]!;
const QUARTER = PERIOD / 4; // 9 — neither 0 nor a whole period

function strokeWith(over: Partial<Stroke> = {}): Stroke {
  return { ...defaultStroke('#33e0a0'), width: 14, dash: [...DASH], ...over };
}

/**
 * A recording stand-in for CanvasRenderingContext2D.
 *
 * Only the members `applyStrokeStyle` touches, and each keeps the real API's
 * shape: `setLineDash` is a METHOD taking an array, `lineDashOffset` is a
 * writable NUMBER property. That distinction is the assertion — if the real
 * context exposed the offset as a method and this faked it as a field, every
 * test here would pass against code that never moved a dash.
 */
function recordingCtx(): CanvasRenderingContext2D & { dashes: number[][] } {
  const dashes: number[][] = [];
  return {
    dashes,
    globalAlpha: 1,
    strokeStyle: '',
    lineWidth: 0,
    lineCap: 'butt',
    lineJoin: 'miter',
    lineDashOffset: 0,
    setLineDash(d: number[]) { dashes.push([...d]); },
  } as unknown as CanvasRenderingContext2D & { dashes: number[][] };
}

describe('the model', () => {
  it('carries a finite offset through normalisation', () => {
    expect(normalizeStroke(strokeWith({ dashOffset: QUARTER })).dashOffset).toBe(QUARTER);
  });

  it('accepts a NEGATIVE offset — it slides the pattern the other way', () => {
    expect(normalizeStroke(strokeWith({ dashOffset: -QUARTER })).dashOffset).toBe(-QUARTER);
  });

  it('drops a non-finite offset rather than passing NaN to the canvas', () => {
    expect(normalizeStroke(strokeWith({ dashOffset: NaN as number })).dashOffset).toBeUndefined();
    expect(normalizeStroke(strokeWith({ dashOffset: Infinity })).dashOffset).toBeUndefined();
  });

  it('OMITS the key entirely when absent, rather than defaulting it to 0', () => {
    // Not cosmetic. `contentHashOf` serialises the whole stroke object as the
    // raster cache key, so writing `dashOffset: 0` into every normalised stroke
    // would change the key of every layer in every existing project and throw
    // away every cached raster on first open — for a value meaning "unchanged".
    const s = normalizeStroke(strokeWith());
    expect('dashOffset' in s).toBe(false);
  });

  it('an absent offset hashes identically to the pre-feature stroke', () => {
    const layer = (stroke: Stroke) =>
      ({ id: 'L', kind: 'shape', primitive: 'rect', width: 100, height: 100, stroke } as unknown as RenderLayer);
    const before = { ...strokeWith() };
    delete (before as { dashOffset?: number }).dashOffset;
    expect(contentHashOf(layer(normalizeStroke(strokeWith()))))
      .toBe(contentHashOf(layer(before)));
  });
});

describe('the raster cache key', () => {
  // The seam that would make an ANIMATED offset render exactly one frame and
  // then freeze: the rasterizer caches by content hash, so if the hash did not
  // move with the offset the first rasterised phase would be reused forever.
  // `AppTextureProvider`'s own `strokeSig` covers only width/colour/align, so
  // this is carried entirely by the content hash.
  const layerWith = (dashOffset?: number): RenderLayer =>
    ({
      id: 'L', kind: 'shape', primitive: 'rect', width: 100, height: 100,
      stroke: normalizeStroke(strokeWith(dashOffset === undefined ? {} : { dashOffset })),
    } as unknown as RenderLayer);

  it('changes when the offset changes', () => {
    expect(contentHashOf(layerWith(QUARTER))).not.toBe(contentHashOf(layerWith(0)));
  });

  it('distinguishes successive frames of a drawing-on animation', () => {
    // The real risk is not "0 vs something" but "frame N vs frame N+1".
    const hashes = [0, 3, 6, 9, 12].map((o) => contentHashOf(layerWith(o)));
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it('DIFFERS at 0 and at one whole period — the hash tracks the value, not the picture', () => {
    // Stated so the next reader does not "fix" it: these two draw the same
    // picture, so a differing hash would only cost a needless re-raster. This
    // pins that the key is the authored number, and it is also the reason the
    // golden scene uses a quarter period rather than a whole one.
    expect(contentHashOf(layerWith(0))).not.toBe(contentHashOf(layerWith(PERIOD)));
  });
});

describe('applyStrokeStyle — the single place stroke state reaches the canvas', () => {
  it('writes the offset onto the context', () => {
    const ctx = recordingCtx();
    applyStrokeStyle(ctx, normalizeStroke(strokeWith({ dashOffset: QUARTER })));
    expect(ctx.lineDashOffset).toBe(QUARTER);
  });

  it('RESETS the offset to 0 when the stroke has none', () => {
    // The context is shared across every layer in a frame. Skipping the write
    // when there is no offset would inherit the previous layer's phase — a bug
    // that only appears when two layers are stroked in the same frame, which no
    // single-layer fixture would ever show.
    const ctx = recordingCtx();
    ctx.lineDashOffset = 17;
    applyStrokeStyle(ctx, normalizeStroke(strokeWith()));
    expect(ctx.lineDashOffset).toBe(0);
  });

  it('still applies the dash pattern itself', () => {
    const ctx = recordingCtx();
    applyStrokeStyle(ctx, normalizeStroke(strokeWith({ dashOffset: QUARTER })));
    expect(ctx.dashes.at(-1)).toEqual(DASH);
  });

  it('a solid stroke gets an empty pattern and a zero offset', () => {
    const ctx = recordingCtx();
    applyStrokeStyle(ctx, normalizeStroke({ ...strokeWith(), dash: [] }));
    expect(ctx.dashes.at(-1)).toEqual([]);
    expect(ctx.lineDashOffset).toBe(0);
  });
});
