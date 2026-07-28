/**
 * Weight painting (Phase 4.3) — per-vertex bone-weight overrides.
 */

import {
  emptyWeightPaint,
  isWeightPaintEmpty,
  weightPaintMatches,
  paintWeights,
  applyWeightPaint,
  clearBonePaint,
} from './weightPaint';
import type { VertexWeight } from './skinning';

/** A 3x3 grid of vertices spanning -10..10, in the [x,y,u,v] layout. */
function grid(): Float32Array {
  const v = new Float32Array(9 * 4);
  let k = 0;
  for (let y = -10; y <= 10; y += 10) {
    for (let x = -10; x <= 10; x += 10) {
      v[k * 4] = x; v[k * 4 + 1] = y; k++;
    }
  }
  return v;
}

const AUTO: VertexWeight[] = [
  { boneId: 'upper', weight: 0.7 },
  { boneId: 'fore', weight: 0.3 },
];

describe('map lifecycle', () => {
  it('starts empty and reports so', () => {
    expect(isWeightPaintEmpty(emptyWeightPaint(9))).toBe(true);
    expect(isWeightPaintEmpty(undefined)).toBe(true);
  });

  it('is only valid for the mesh resolution it was painted at', () => {
    const m = emptyWeightPaint(9);
    expect(weightPaintMatches(m, 9)).toBe(true);
    expect(weightPaintMatches(m, 25)).toBe(false);
    expect(weightPaintMatches(undefined, 9)).toBe(false);
  });

  it('refuses to paint against a mismatched mesh rather than smearing', () => {
    const stale = emptyWeightPaint(4);
    const out = paintWeights(stale, 'upper', grid(), { x: 0, y: 0 }, 50, { mode: 'add' });
    expect(out).toBe(stale);
  });
});

describe('brush', () => {
  it('add pushes weights toward 1 inside the radius only', () => {
    const m = paintWeights(emptyWeightPaint(9), 'upper', grid(), { x: -10, y: -10 }, 5, {
      mode: 'add', strength: 1, falloff: 0,
    });
    const painted = m.bones.upper!;
    expect(painted[0]).toBeCloseTo(1, 5);   // the vertex at (-10,-10)
    expect(painted[4]).toBeUndefined();      // centre vertex is outside the brush
  });

  it('subtract pushes toward 0', () => {
    const start = paintWeights(emptyWeightPaint(9), 'upper', grid(), { x: 0, y: 0 }, 100, {
      mode: 'add', strength: 1, falloff: 0,
    });
    const out = paintWeights(start, 'upper', grid(), { x: 0, y: 0 }, 5, {
      mode: 'subtract', strength: 1, falloff: 0,
    });
    expect(out.bones.upper![4]).toBeCloseTo(0, 5);
  });

  it('falloff feathers the edge (nearer vertices move further)', () => {
    const m = paintWeights(emptyWeightPaint(9), 'upper', grid(), { x: -10, y: -10 }, 15, {
      mode: 'add', strength: 1, falloff: 1,
    });
    const p = m.bones.upper!;
    expect(p[0]!).toBeGreaterThan(p[1]!); // (-10,-10) closer than (0,-10)
  });

  it('smooth pulls values toward the brush average', () => {
    let m = emptyWeightPaint(9);
    m = paintWeights(m, 'upper', grid(), { x: -10, y: -10 }, 5, { mode: 'add', strength: 1, falloff: 0 });
    const before = m.bones.upper![0]!;
    expect(before).toBeCloseTo(1, 5);
    // Smooth over the whole mesh: the painted 1 is pulled down toward the mean.
    const out = paintWeights(m, 'upper', grid(), { x: 0, y: 0 }, 100, {
      mode: 'smooth', strength: 1, falloff: 0,
    });
    expect(out.bones.upper![0]!).toBeLessThan(before);
  });

  it('never mutates the input map', () => {
    const m = emptyWeightPaint(9);
    const snapshot = JSON.stringify(m);
    paintWeights(m, 'upper', grid(), { x: 0, y: 0 }, 100, { mode: 'add' });
    expect(JSON.stringify(m)).toBe(snapshot);
  });

  it('clamps into [0,1]', () => {
    let m = emptyWeightPaint(9);
    for (let i = 0; i < 10; i++) {
      m = paintWeights(m, 'upper', grid(), { x: 0, y: 0 }, 100, { mode: 'add', strength: 1, falloff: 0 });
    }
    for (const v of Object.values(m.bones.upper!)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('is deterministic', () => {
    const a = paintWeights(emptyWeightPaint(9), 'upper', grid(), { x: 0, y: 0 }, 30, { mode: 'add' });
    const b = paintWeights(emptyWeightPaint(9), 'upper', grid(), { x: 0, y: 0 }, 30, { mode: 'add' });
    expect(a).toEqual(b);
  });
});

describe('merging overrides into the auto binding', () => {
  it('an unpainted vertex keeps its auto weights exactly', () => {
    const m = emptyWeightPaint(9);
    expect(applyWeightPaint(AUTO, 0, m)).toEqual(AUTO);
    expect(applyWeightPaint(AUTO, 0, undefined)).toEqual(AUTO);
  });

  it('a painted bone takes its painted value and the rest are redistributed', () => {
    const m = paintWeights(emptyWeightPaint(9), 'fore', grid(), { x: -10, y: -10 }, 5, {
      mode: 'add', strength: 1, falloff: 0,
    });
    const out = applyWeightPaint(AUTO, 0, m);
    const fore = out.find((w) => w.boneId === 'fore')!;
    expect(fore.weight).toBeCloseTo(1, 5);
    // `upper` is squeezed out entirely — painting `fore` to 1 saturates it.
    expect(out.find((w) => w.boneId === 'upper')?.weight ?? 0).toBeCloseTo(0, 5);
  });

  it('a partial paint leaves room for the auto bones, and sums to 1', () => {
    const m = paintWeights(emptyWeightPaint(9), 'fore', grid(), { x: -10, y: -10 }, 5, {
      mode: 'add', strength: 0.5, falloff: 0,
    });
    const out = applyWeightPaint(AUTO, 0, m);
    expect(out.reduce((s, w) => s + w.weight, 0)).toBeCloseTo(1, 5);
    expect(out.find((w) => w.boneId === 'upper')!.weight).toBeGreaterThan(0);
  });

  it('always renormalises to 1', () => {
    for (const strength of [0.1, 0.4, 0.9, 1]) {
      const m = paintWeights(emptyWeightPaint(9), 'fore', grid(), { x: -10, y: -10 }, 5, {
        mode: 'add', strength, falloff: 0,
      });
      const out = applyWeightPaint(AUTO, 0, m);
      expect(out.reduce((s, w) => s + w.weight, 0)).toBeCloseTo(1, 5);
    }
  });

  it('clearBonePaint removes just that bone', () => {
    let m = paintWeights(emptyWeightPaint(9), 'fore', grid(), { x: 0, y: 0 }, 100, { mode: 'add' });
    m = paintWeights(m, 'upper', grid(), { x: 0, y: 0 }, 100, { mode: 'add' });
    const out = clearBonePaint(m, 'fore');
    expect(out.bones.fore).toBeUndefined();
    expect(out.bones.upper).toBeDefined();
  });
});
