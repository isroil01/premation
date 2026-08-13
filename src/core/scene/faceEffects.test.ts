/**
 * Per-face effect policy for extrusions.
 *
 * The render-test scenes (`ext-fx-invert`, `ext-dof-wall`) prove the pixels
 * move; these pin the DECISIONS, which pixels cannot. A scene can only show
 * that some effect reached some face — it cannot show that a drop shadow was
 * withheld deliberately rather than lost, or that a layer style was excluded
 * here because the caller already placed it rather than because nobody thought
 * about it. Each case below is one of those written down.
 */

import { faceEffectsFor, EXTERIOR_FACE_EFFECTS, SPATIAL_FACE_BUDGET } from './faceEffects';
import type { Effect } from '@core/effects/effects';

const fx = (id: string, type: string, params: Record<string, unknown> = {}): Effect =>
  ({ id, type, params } as unknown as Effect);

const SMALL = { faceCount: 5 };
const ids = (r: Effect[] | undefined) => (r ?? []).map((e) => e.id);

describe('faceEffectsFor — what an extrusion face may carry', () => {
  it('carries colour and tonal effects to every face', () => {
    const r = faceEffectsFor([fx('a', 'invert', { amount: 100 }), fx('b', 'hue-saturation')], SMALL);
    expect(ids(r)).toEqual(['a', 'b']);
  });

  it('carries DEPTH OF FIELD, which arrives as an ordinary blur entry', () => {
    // The regression this exists for: `dofEffectOf` appends `{id:'dof',
    // type:'blur'}` to layer.effects fourteen lines before the extrusion block
    // discarded the list, so an extruded body never defocused. Byte-identical
    // frames with DOF on and off, across all 172,800 pixels.
    const r = faceEffectsFor([fx('dof', 'blur', { amount: 8 })], SMALL);
    expect(ids(r)).toEqual(['dof']);
  });

  it('withholds the shadow-casting effects that would stack N times', () => {
    for (const type of EXTERIOR_FACE_EFFECTS) {
      expect(faceEffectsFor([fx('x', type)], SMALL)).toBeUndefined();
    }
  });

  it('withholds the cast shadow buildSnapshot synthesizes, whatever its id', () => {
    // `shadowEffectOf` emits `{id:'cast-shadow', type:'drop-shadow'}`. The
    // deny-list is keyed on TYPE precisely so a synthesized entry cannot slip
    // past it by not being called what the user's own effect is called.
    expect(faceEffectsFor([fx('cast-shadow', 'drop-shadow')], SMALL)).toBeUndefined();
  });

  it('withholds CPU-baked effects — each carrying face is a whole rasterization', () => {
    // keylight has no shader form (CANVAS2D_ONLY), so a face carrying it costs
    // a Canvas2D bake every frame. At 45 depth slices that is 45 bakes/frame.
    expect(faceEffectsFor([fx('k', 'keylight')], SMALL)).toBeUndefined();
  });

  it('withholds a mask-scoped effect even when its type is GPU-drawable', () => {
    // Scoping is honoured only in the bake, and a face has no bake — so the
    // GPU would apply the effect to the WHOLE face, which looks like a design
    // choice rather than a bug.
    const scoped = { ...fx('s', 'blur', { amount: 4 }), maskId: 'm1' } as unknown as Effect;
    expect(faceEffectsFor([scoped], SMALL)).toBeUndefined();
  });

  it('drops one denied effect without evicting the allowed ones beside it', () => {
    const r = faceEffectsFor(
      [fx('a', 'invert'), fx('b', 'drop-shadow'), fx('c', 'blur', { amount: 3 })],
      SMALL,
    );
    expect(ids(r)).toEqual(['a', 'c']);
  });

  it('skips disabled effects', () => {
    const off = { ...fx('a', 'invert'), enabled: false } as unknown as Effect;
    expect(faceEffectsFor([off], SMALL)).toBeUndefined();
  });

  describe('layer styles are the caller’s decision, never this function’s', () => {
    // buildSnapshot picks interior styles via FACE_SURFACE_IDS and then scopes
    // them with faceFxFor; the overlays reach faces through styledSurfaceFill
    // instead. Deciding either here would undo one and double-apply the other.
    it('drops a layer-style effect that arrived in the layer list', () => {
      expect(faceEffectsFor([fx('layerstyle:stroke', 'stroke')], SMALL)).toBeUndefined();
    });

    it('drops a colour overlay rather than applying it twice', () => {
      // The overlay already repainted this face's fill via styledSurfaceFill —
      // carrying it as an effect as well would grade the graded colour.
      expect(faceEffectsFor([fx('layerstyle:colorOverlay', 'tint')], SMALL)).toBeUndefined();
    });

    it('appends the caller’s `extra` verbatim, after the layer’s own effects', () => {
      const r = faceEffectsFor([fx('a', 'invert')], {
        ...SMALL,
        extra: [fx('layerstyle:innerGlow', 'inner-glow')],
      });
      expect(ids(r)).toEqual(['a', 'layerstyle:innerGlow']);
    });

    it('carries `extra` even on a face that may carry nothing else', () => {
      const r = faceEffectsFor([fx('d', 'drop-shadow')], {
        faceCount: 45,
        extra: [fx('layerstyle:innerShadow', 'inner-shadow')],
      });
      expect(ids(r)).toEqual(['layerstyle:innerShadow']);
    });
  });

  describe('the spatial budget', () => {
    const over = { faceCount: SPATIAL_FACE_BUDGET + 1 };
    const under = { faceCount: SPATIAL_FACE_BUDGET };

    it('carries effects needing a GPU pass while the face count is in budget', () => {
      expect(ids(faceEffectsFor([fx('b', 'blur', { amount: 6 })], under))).toEqual(['b']);
    });

    it('drops them past it — a striped solid reads as a fault, a flat one as a limit', () => {
      expect(faceEffectsFor([fx('b', 'blur', { amount: 6 })], over)).toBeUndefined();
    });

    it('never withholds a free effect, however many faces there are', () => {
      // Colour effects fold into the face's fill colour (solid faces) or into a
      // shader uniform (textured ones). There is no pass to budget.
      expect(ids(faceEffectsFor([fx('a', 'invert')], { faceCount: 500 }))).toEqual(['a']);
    });

    it('applies the budget to the whole layer, not per effect', () => {
      const r = faceEffectsFor([fx('a', 'invert'), fx('b', 'blur', { amount: 6 })], over);
      expect(ids(r)).toEqual(['a']);
    });
  });
});
