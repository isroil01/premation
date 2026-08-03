/**
 * M5b / F6 — bake ownership has ONE answer.
 *
 * The defect this locks down is not a typo. It is that "is this layer baked?"
 * was answered by three predicates a caller had to choose between, where the
 * correct choice depends on the layer's KIND. Choosing wrong does not crash: it
 * makes two sides of the pipeline disagree about who owns the effect chain, and
 * the chain runs TWICE.
 *
 * That shipped. `snapshotToFrameScene` gated on `effectsNeedCpuBake` while
 * `Canvas2DVectorRasterizer` gated on `layerNeedsCpuBake`, and fill opacity alone
 * triggers a bake with no effect requiring it — so the grade, LUT, mask and
 * spatial effects were applied by both sides.
 *
 * So the assertion is not "one repro produces the right pixels". It is that the
 * predicates AGREE across the whole input space, which is what a hand-kept
 * invariant cannot promise.
 */

import {
  layerIsBaked,
  layerNeedsCpuBake,
  imageNeedsCpuBake,
  effectsNeedCpuBake,
} from './effectBake';
import type { Effect } from './effects';

/** A Canvas2D-only effect (forces a bake) and a GPU-native one (does not). */
const satin: Effect = { id: 'e1', type: 'satin', params: {} } as Effect;
const blur: Effect = { id: 'e2', type: 'blur', params: {} } as Effect;

const KINDS = ['shape', 'text', 'image', 'video'];
const EFFECT_SETS: Array<ReadonlyArray<Effect> | undefined> = [
  undefined,
  [],
  [blur],
  [satin],
  [blur, satin],
  [{ ...satin, enabled: false } as Effect],
];
const FILL_OPACITIES: Array<number | undefined> = [undefined, 1, 0.5, 0];

/** Every combination that can reach the predicate. */
function* cases(): Generator<{ kind: string; effects?: ReadonlyArray<Effect>; fillOpacity?: number }> {
  for (const kind of KINDS) {
    for (const effects of EFFECT_SETS) {
      for (const fillOpacity of FILL_OPACITIES) {
        yield { kind, ...(effects === undefined ? {} : { effects }), ...(fillOpacity === undefined ? {} : { fillOpacity }) };
      }
    }
  }
}

describe('layerIsBaked is the single source of truth', () => {
  it('covers a non-trivial input space — the sweep is not vacuous', () => {
    expect([...cases()].length).toBe(KINDS.length * EFFECT_SETS.length * FILL_OPACITIES.length);
  });

  it('agrees with the VECTOR predicate for every shape/text case', () => {
    for (const c of cases()) {
      if (c.kind !== 'shape' && c.kind !== 'text') continue;
      expect({ ...c, baked: layerIsBaked(c) })
        .toEqual({ ...c, baked: layerNeedsCpuBake(c.effects, c.fillOpacity) });
    }
  });

  it('agrees with the IMAGE predicate for every image/video case', () => {
    for (const c of cases()) {
      if (c.kind !== 'image' && c.kind !== 'video') continue;
      expect({ ...c, baked: layerIsBaked(c) })
        .toEqual({ ...c, baked: imageNeedsCpuBake(c.kind, c.effects) });
    }
  });

  it('is the ONLY predicate that answers correctly for every kind', () => {
    // The point of the milestone: no single one of the old three works
    // everywhere, which is why choosing between them was the defect.
    const wrongSomewhere = [...cases()].some(
      (c) => layerIsBaked(c) !== layerNeedsCpuBake(c.effects, c.fillOpacity),
    );
    expect(wrongSomewhere).toBe(true);
  });

  it('fill opacity triggers a bake on VECTOR layers — the case that shipped wrong', () => {
    // No effect requires a bake here; fill opacity alone does. Gating on the
    // effects term only is exactly what made both sides claim the chain.
    const v = { kind: 'shape', effects: [blur], fillOpacity: 0.5 };
    expect(layerIsBaked(v)).toBe(true);
    expect(effectsNeedCpuBake(v.effects)).toBe(false); // the narrow term disagrees
  });

  it('fill opacity does NOT trigger a bake on image/video', () => {
    // A shape-fill concept. Previously implicit in which function a caller
    // happened to reach for; now a stated rule with a test.
    expect(layerIsBaked({ kind: 'image', effects: [blur], fillOpacity: 0.5 })).toBe(false);
    expect(layerIsBaked({ kind: 'video', effects: [blur], fillOpacity: 0 })).toBe(false);
  });

  it('a disabled Canvas2D-only effect does not force a bake', () => {
    expect(layerIsBaked({ kind: 'shape', effects: [{ ...satin, enabled: false } as Effect] })).toBe(false);
  });

  it('an unknown kind falls to the vector rule rather than silently not baking', () => {
    // Failing open here would mean a new layer kind quietly loses its interior
    // styles — the exact class of silent no-op this codebase keeps deleting.
    expect(layerIsBaked({ kind: 'solid', effects: [satin] })).toBe(true);
  });
});
