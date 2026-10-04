/**
 * Effect handles — the shared on-canvas control-point mechanism.
 *
 * Interaction code resists assertions, so the split here is deliberate: every
 * decision that can be made pure IS pure and tested here (where a handle sits,
 * which one a click picks, what a drag writes, whether a write keyframes), and
 * only the pointer plumbing is left to the runtime check.
 *
 * ── The transform chain, derived once ───────────────────────────────────
 *
 * A handle's screen position is three conversions:
 *
 *   effect space (0..w, 0..h)  --effectToLayer-->  layer-local (centred)
 *   layer-local                --layerSpaceAt-->   composition
 *   composition                --camera-->         screen
 *
 * The camera is `(p − centre)·zoom + view/2` (Camera.ts:203). Fixtures below use
 * centre (0,0) and view 0×0, so screen = comp · zoom and the arithmetic stays
 * checkable.
 *
 * ── What the clean values exclude (rule 3a) ─────────────────────────────
 *
 * The main rig is rotation 90°, scale (2,3), zoom 2. Each of those was chosen to
 * make the numbers exact, and each makes something unreachable:
 *
 *   rotation 90  → the composed matrix has a ZERO DIAGONAL, so an error in the
 *                  a/d terms contributes nothing   → identity + 180° fixtures
 *   scale (2,3)  → non-uniform, so a scale read from one axis twice still
 *                  differs                          → uniform-scale fixture
 *   no parent    → the parent chain is never walked  → parented fixture
 *   zoom 2       → a zoom of 1 is where "forgot to apply zoom" hides
 *                                                    → zoom-1 fixture
 *   handle ≠ centre → the half-box offset is only visible off-centre
 *                                                    → identity fixture pins it
 */


import {
  EFFECT_HANDLES,
  collectEffectHandles,
  handleDragValues,
  effectToLayer,
  layerToEffect,
  hasEffectHandles,
} from './effectHandles';

describe('collecting handles', () => {
  it('rests where the spec says and moves by the param offset', () => {
    const none = collectEffectHandles('corner-pin', {}, 200, 100);
    expect(none.map((x) => [x.pos.x, x.pos.y]))
      .toEqual([[0, 0], [200, 0], [200, 100], [0, 100]]);
    // Offsets ADD to rest; a param the caller never set reads as 0, not NaN.
    const moved = collectEffectHandles('corner-pin', { topLeftX: 30, bottomRightY: -12 }, 200, 100);
    expect(moved[0]!.pos).toEqual({ x: 30, y: 0 });
    expect(moved[2]!.pos).toEqual({ x: 200, y: 88 });
    // `rest` survives alongside `pos`, because a drag needs it to invert.
    expect(moved[0]!.rest).toEqual({ x: 0, y: 0 });
  });

  it('reports nothing for an effect with no handles', () => {
    expect(collectEffectHandles('blur', { amount: 5 }, 100, 100)).toEqual([]);
    expect(hasEffectHandles('blur')).toBe(false);
    expect(hasEffectHandles('bezier-warp')).toBe(true);
  });

  it('corner-pin rests on the untransformed rectangle, in the effect’s order', () => {
    // `defaultCorners(w,h)` is [0,0, w,0, w,h, 0,h] — TL, TR, BR, BL.
    const handles = collectEffectHandles('corner-pin', {}, 240, 160);
    expect(handles.map((x) => x.spec.id)).toEqual(['topLeft', 'topRight', 'bottomRight', 'bottomLeft']);
    expect(handles.map((x) => [x.pos.x, x.pos.y])).toEqual([[0, 0], [240, 0], [240, 160], [0, 160]]);
  });

  it('every spec names params the effect actually declares', () => {
    // Catches a typo'd key, which would otherwise read 0 forever and write to a
    // param nothing renders — a dead handle that looks alive.
    const { EFFECT_DEFS } = jest.requireActual<typeof import('./effects')>('./effects');
    for (const [type, specs] of Object.entries(EFFECT_HANDLES)) {
      const def = EFFECT_DEFS.find((d) => d.type === type)!;
      const keys = new Set(def.params.map((p) => p.key));
      for (const s of specs!) {
        expect({ type, key: s.xKey, known: keys.has(s.xKey) }).toEqual({ type, key: s.xKey, known: true });
        expect({ type, key: s.yKey, known: keys.has(s.yKey) }).toEqual({ type, key: s.yKey, known: true });
      }
    }
  });
});

describe('effect space ↔ layer space', () => {
  it('differs from layer-local by exactly half the box', () => {
    expect(effectToLayer({ x: 0, y: 0 }, 200, 100)).toEqual({ x: -100, y: -50 });
    expect(effectToLayer({ x: 200, y: 100 }, 200, 100)).toEqual({ x: 100, y: 50 });
    expect(effectToLayer({ x: 100, y: 50 }, 200, 100)).toEqual({ x: 0, y: 0 });
  });

  it('round-trips', () => {
    const p = { x: 37, y: -14 };
    expect(layerToEffect(effectToLayer(p, 200, 100), 200, 100)).toEqual(p);
  });
});

describe('what a drag writes', () => {
  it('is the target MINUS the rest position, per axis', () => {
    const [tl, tr] = collectEffectHandles('corner-pin', {}, 200, 100);
    // TL rests at (0,0): dragging it to (30, −12) is offset (30, −12).
    expect(handleDragValues(tl!, { x: 30, y: -12 })).toEqual({ topLeftX: 30, topLeftY: -12 });
    // TR rests at (200,0): dragging it to (180, 25) is offset (−20, 25). An
    // implementation writing the ABSOLUTE target would put 180 here, which
    // looks right for the top-left corner and for nothing else.
    expect(handleDragValues(tr!, { x: 180, y: 25 })).toEqual({ topRightX: -20, topRightY: 25 });
  });

  it('inverts collectEffectHandles exactly', () => {
    const before = collectEffectHandles('bezier-warp', { top1X: 7, top1Y: -3 }, 240, 160);
    const h = before[1]!;
    const target = { x: 111, y: 222 };
    const vals = handleDragValues(h, target);
    const after = collectEffectHandles('bezier-warp', vals, 240, 160);
    expect(after[1]!.pos).toEqual(target);
  });
});

/**
 * THE THREE DISTORT CENTRES - Bulge, Twirl, Spherize.
 *
 * The mechanism being correct does NOT make its consumers correct. A registry
 * entry with a wrong prop name, a wrong rest position, or a centre expressed in
 * the wrong space all compile and all look plausible on canvas, so each centre
 * gets the same treatment as Corner Pin rather than being waved through.
 *
 * The rest position is derived from the DISPATCH, not the param name: all three
 * dispatchers compute `w / 2 + centerX`, `h / 2 + centerY`, so rest in effect
 * space is the middle of the box - NOT (0,0), which is what every other
 * consumer here uses. Getting that wrong puts the handle on the layer top-left
 * and writes offsets a half-box out.
 *
 * MAIN RIG, hand-derived:
 *   layer at (100, 50), rotation 90, scale (2, 3), 100x100, zoom 2
 *   W = translate(100,50).rotate(90).scale(2,3) = {a:0, b:2, c:-3, d:0, e:100, f:50}
 *   centre rests at effect (50, 50) -> layer (0, 0) -> comp (100, 50) -> screen (200, 100)
 *
 * The centre resting exactly on the origin is convenient and is also what makes
 * that rig weak: at the origin every rotation and scale term multiplies zero, so
 * the matrix contributes nothing but its translation. Every boundary fixture
 * below therefore moves the centre OFF the origin with a param offset, which is
 * the only way the transform is exercised at all.
 */
describe('the three distort centres', () => {
  const CENTRES = ['bulge', 'twirl', 'spherize'] as const;

  it('each declares exactly one handle, resting at the layer CENTRE', () => {
    for (const type of CENTRES) {
      const hs = collectEffectHandles(type, {}, 200, 100);
      expect({ type, n: hs.length }).toEqual({ type, n: 1 });
      expect({ type, pos: hs[0]!.pos }).toEqual({ type, pos: { x: 100, y: 50 } });
      expect({ type, keys: [hs[0]!.spec.xKey, hs[0]!.spec.yKey] })
        .toEqual({ type, keys: ['centerX', 'centerY'] });
    }
  });

  it('the centre rest maps to the layer ORIGIN, which is what the dispatch means', () => {
    for (const [w, h] of [[200, 100], [64, 64], [1920, 1080]] as Array<[number, number]>) {
      expect(effectToLayer({ x: w / 2, y: h / 2 }, w, h)).toEqual({ x: 0, y: 0 });
    }
  });

  it('a drag writes the offset from the CENTRE, not from the corner', () => {
    const h = collectEffectHandles('twirl', {}, 200, 100)[0]!;
    // Dragging to effect (150, 80) is (50, 30) from the centre. Measuring from
    // the corner would write (150, 80) - plausible, and wrong by half the box.
    expect(handleDragValues(h, { x: 150, y: 80 })).toEqual({ centerX: 50, centerY: 30 });
  });
});
