import {
  rectangleMask,
  ellipseMask,
  maskSegments,
  readNodeMask,
  type LayerMask,
  type MaskMode,
  type MaskPath,
  maskModeToComposite,
  maskModeStartsFull,
  activeMaskPaths,
  hasActiveMaskPaths,
  paintMaskMatte,
} from './mask';
import type { SceneNode } from '@core/types';

function nodeWithFx(props?: Record<string, unknown>): SceneNode {
  const components = props ? [{ type: 'fx', props }] : [];
  return { components } as unknown as SceneNode;
}

describe('mask presets', () => {
  test('rectangleMask spans the layer bounds as 4 corner anchors', () => {
    const m = rectangleMask(200, 100);
    expect(m.closed).toBe(true);
    expect(m.mode).toBe('add');
    expect(m.inverted).toBe(false);
    expect(m.expansion).toBe(0);
    expect(m.points).toHaveLength(4);
    expect(m.points.map((p) => [p.x, p.y])).toEqual([
      [-100, -50], [100, -50], [100, 50], [-100, 50],
    ]);
    // Corners: handles coincide with the anchor (straight edges).
    for (const p of m.points) {
      expect([p.inX, p.inY, p.outX, p.outY]).toEqual([p.x, p.y, p.x, p.y]);
    }
  });

  test('ellipseMask is a 4-point cubic circle with offset handles', () => {
    const m = ellipseMask(200, 100);
    expect(m.points).toHaveLength(4);
    const top = m.points[0]!;
    expect([top.x, top.y]).toEqual([0, -50]);
    // Handles are offset horizontally by the cubic-circle constant.
    const k = 0.5522847498307936;
    expect(top.outX).toBeCloseTo(100 * k);
    expect(top.inX).toBeCloseTo(-100 * k);
  });
});

describe('maskSegments and expansion', () => {
  test('a closed 4-point path yields 4 segments (wraps to the start)', () => {
    const segs = maskSegments(rectangleMask(200, 100));
    expect(segs).toHaveLength(4);
    // Last segment returns to the first anchor.
    expect([segs[3]!.x1, segs[3]!.y1]).toEqual([-100, -50]);
  });

  test('an open path yields one fewer segment', () => {
    const m = rectangleMask(200, 100);
    m.closed = false;
    expect(maskSegments(m)).toHaveLength(3);
  });

  test('straight edges have control points at the endpoints', () => {
    const [s] = maskSegments(rectangleMask(200, 100));
    expect([s!.cx1, s!.cy1]).toEqual([s!.x0, s!.y0]);
    expect([s!.cx2, s!.cy2]).toEqual([s!.x1, s!.y1]);
  });

  test('degenerate paths produce no segments', () => {
    expect(maskSegments({ ...rectangleMask(10, 10), points: [] })).toEqual([]);
  });

  test('maskSegments applies expansion to dilate bounds outward', () => {
    const m = rectangleMask(200, 100); // [-100, -50] to [100, 50]
    m.expansion = 10;
    const segs = maskSegments(m);
    // Top-left corner expands outward and upward by expansion * bisector factor
    expect(segs[0]!.x0).toBeLessThan(-100);
    expect(segs[0]!.y0).toBeLessThan(-50);
  });
});

describe('readNodeMask', () => {
  test('returns undefined with no fx / empty mask', () => {
    expect(readNodeMask(nodeWithFx())).toBeUndefined();
    expect(readNodeMask(nodeWithFx({ mask: { paths: [] } }))).toBeUndefined();
  });

  test('returns a stored non-empty mask', () => {
    const mask: LayerMask = { paths: [rectangleMask(50, 50)] };
    expect(readNodeMask(nodeWithFx({ mask }))).toBe(mask);
  });
});

describe('mask modes — lighten / darken / difference', () => {
  it('maps each mode to its compositing operation', () => {
    expect(maskModeToComposite('add')).toBe('source-over');
    expect(maskModeToComposite('subtract')).toBe('destination-out');
    expect(maskModeToComposite('intersect')).toBe('destination-in');
    expect(maskModeToComposite('lighten')).toBe('lighten');
    expect(maskModeToComposite('darken')).toBe('darken');
    expect(maskModeToComposite('difference')).toBe('difference');
  });

  it('only the additive modes start from an EMPTY matte', () => {
    // A leading subtractive mode against nothing would erase from nothing and
    // the layer would vanish — AE starts those from a full frame instead.
    expect(maskModeStartsFull('add')).toBe(false);
    expect(maskModeStartsFull('lighten')).toBe(false);
    for (const m of ['subtract', 'intersect', 'darken', 'difference'] as const) {
      expect(maskModeStartsFull(m)).toBe(true);
    }
  });

  it('every mode has a composite op — no silent fallthrough to Add', () => {
    const modes = ['add', 'subtract', 'intersect', 'lighten', 'darken', 'difference'] as const;
    const ops = modes.map(maskModeToComposite);
    // Six distinct modes must not collapse onto fewer than five operations
    // (add/source-over is the only default, and nothing else may share it).
    expect(new Set(ops).size).toBe(modes.length);
  });
});

// ── M2: mask mode `none` ─────────────────────────────────────────────
//
// A `none` mask is geometry, not coverage. The invariant under test throughout:
// adding a `none` path to a stack must not change a single pixel of the matte.
//
// SCOPE OF THESE TESTS — read before trusting a green run. They assert the
// COMPOSITING SEQUENCE (which op, which alpha, which filter, in what order),
// not pixels. `Path2D` is stubbed out because jsdom has none, so path geometry
// is never rasterized and never compared. Green here means "a `none` mask
// issues no drawing commands and does not perturb the commands around it" — it
// does NOT mean "masks are pixel-correct". Pixel correctness for masks lives in
// packages/render-tests (real Chromium, golden images); if you change mask
// GEOMETRY rather than mask sequencing, these tests will not catch you.

// jsdom has no Path2D. These tests assert the drawing SEQUENCE (which composite
// op, which alpha, which filter, in what order) rather than geometry, so a
// no-op stub is sufficient and keeps the test free of a canvas backend.
beforeAll(() => {
  if (typeof (globalThis as { Path2D?: unknown }).Path2D === 'undefined') {
    (globalThis as { Path2D?: unknown }).Path2D = class {
      rect(): void {}
      moveTo(): void {}
      bezierCurveTo(): void {}
      closePath(): void {}
    };
  }
});

/** Records the canvas calls that decide the matte, so a jsdom test can assert
 *  the drawing SEQUENCE without a real rasterizer. */
function recordingCtx(): { ctx: CanvasRenderingContext2D; calls: string[] } {
  const calls: string[] = [];
  // State in a closure rather than on the object, so the mock needs no
  // structural type of its own.
  const state = { op: 'source-over', alpha: 1, filter: 'none' };
  const ctx = {
    set globalCompositeOperation(v: string) { state.op = v; },
    get globalCompositeOperation() { return state.op; },
    set globalAlpha(v: number) { state.alpha = v; },
    get globalAlpha() { return state.alpha; },
    set filter(v: string) { state.filter = v; },
    get filter() { return state.filter; },
    fillStyle: '',
    save: () => { calls.push('save'); },
    restore: () => { calls.push('restore'); },
    fillRect: (x: number, y: number, w: number, h: number) => { calls.push(`fillRect(${x},${y},${w},${h})`); },
    fill: (_p: unknown, rule: string) => {
      calls.push(`fill[${state.op},a=${state.alpha},f=${state.filter},${rule}]`);
    },
  } as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

const pathOf = (mode: MaskMode, id: string = mode): MaskPath => ({ ...rectangleMask(100, 100), id, mode });
const paint = (paths: MaskPath[]): string[] => {
  const { ctx, calls } = recordingCtx();
  paintMaskMatte(ctx, { paths }, 100, 100);
  return calls;
};

describe('mask mode `none`', () => {
  it('is not treated as a leading subtractive mode', () => {
    // Without the explicit exclusion, `none` would fall through the
    // `!== add && !== lighten` test and fill the frame — changing the picture.
    expect(maskModeStartsFull('none')).toBe(false);
  });

  it('keeps maskModeToComposite total without inventing behaviour', () => {
    expect(maskModeToComposite('none')).toBe('source-over');
  });

  it('activeMaskPaths drops none, keeps everything else', () => {
    const paths = [pathOf('none'), pathOf('add'), pathOf('subtract')];
    expect(activeMaskPaths({ paths }).map((p) => p.mode)).toEqual(['add', 'subtract']);
  });

  it('hasActiveMaskPaths is false only when every path is none', () => {
    expect(hasActiveMaskPaths({ paths: [pathOf('none'), pathOf('none', 'n2')] })).toBe(false);
    expect(hasActiveMaskPaths({ paths: [pathOf('none'), pathOf('add')] })).toBe(true);
    expect(hasActiveMaskPaths({ paths: [] })).toBe(false);
    expect(hasActiveMaskPaths(undefined)).toBe(false);
  });

  it('an all-none stack leaves the layer UNMASKED, not invisible', () => {
    // The failure this guards: filtering none out naively leaves zero paths, the
    // matte comes out empty, and the layer vanishes — which is the one thing a
    // mode called "none" must never do.
    const calls = paint([pathOf('none'), pathOf('none', 'n2')]);
    expect(calls).toEqual(['fillRect(-50,-50,100,100)']);
    expect(calls.some((c) => c.startsWith('fill['))).toBe(false);
  });

  it('does not draw a none path sitting among active ones', () => {
    const calls = paint([pathOf('add'), pathOf('none'), pathOf('subtract')]);
    const fills = calls.filter((c) => c.startsWith('fill['));
    expect(fills).toHaveLength(2);
    expect(fills[0]).toContain('source-over');
    expect(fills[1]).toContain('destination-out');
  });

  it('a LEADING none does not change how the stack starts', () => {
    // The subtle one. `[none, add]` must start from an empty matte exactly like
    // `[add]`; if `none` were consulted for maskModeStartsFull it would prefill
    // the frame and the Add mask would stop cutting anything.
    expect(paint([pathOf('none'), pathOf('add')])).toEqual(paint([pathOf('add')]));
  });

  it('a leading none preserves the full-frame start of a following subtract', () => {
    expect(paint([pathOf('none'), pathOf('subtract')])).toEqual(paint([pathOf('subtract')]));
    expect(paint([pathOf('subtract')])[0]).toBe('fillRect(-50,-50,100,100)');
  });

  it('inserting a none path anywhere is a no-op on the matte', () => {
    const base = [pathOf('add'), pathOf('darken')];
    const baseline = paint(base);
    for (let i = 0; i <= base.length; i++) {
      const withNone = [...base.slice(0, i), pathOf('none'), ...base.slice(i)];
      expect(paint(withNone)).toEqual(baseline);
    }
  });
});
