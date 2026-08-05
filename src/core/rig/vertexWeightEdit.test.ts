/**
 * Per-vertex numeric weight editing — `setVertexWeight`.
 *
 * ## Rule 3a — why every weight in the fixture is different
 *
 * The clean fixture is three bones at 1/3 each, and it hides the one class of
 * bug this function can plausibly have: a swap. With equal weights, writing to
 * the wrong bone, redistributing to the wrong bone, or transposing two entries
 * all produce a byte-identical result, and every assertion below would pass on
 * all three.
 *
 * So the fixture is 0.6 / 0.3 / 0.1 — pairwise distinct, and distinct in their
 * RATIOS too (6:3:1, so no two pairs share a proportion). `a swap is visible`
 * is the positive control that says so rather than trusting it.
 *
 * ## The single-influence boundary
 *
 * A multi-influence fixture cannot reach it, and it is the one input where the
 * function must decline: one bone on a vertex means weight 1 by definition,
 * there is nothing to redistribute to, and any typed value renormalises back.
 * Covered explicitly below because the main fixture excludes it by construction.
 *
 * ## What is asserted is the READ-BACK, not the write
 *
 * Every expectation goes through `applyWeightPaint` — the function the renderer
 * uses to turn overrides into the weights it actually skins with. Asserting the
 * stored map instead would guard a private representation and could hold while
 * the deformation disagreed.
 */

import {
  setVertexWeight, applyWeightPaint, emptyWeightPaint, isWeightPaintEmpty,
} from './weightPaint';
import type { VertexWeight } from './skinning';

const V = 7;
const VERTS = 40;

/** Pairwise-distinct, and no two pairs sharing a ratio. See the header. */
const AUTO: VertexWeight[] = [
  { boneId: 'upper', weight: 0.6 },
  { boneId: 'fore', weight: 0.3 },
  { boneId: 'hand', weight: 0.1 },
];

const weightsAfter = (map = emptyWeightPaint(VERTS)): VertexWeight[] =>
  applyWeightPaint(AUTO, V, map);

const weightOf = (ws: readonly VertexWeight[], boneId: string): number =>
  ws.find((w) => w.boneId === boneId)?.weight ?? 0;

const sum = (ws: readonly VertexWeight[]): number => ws.reduce((a, w) => a + w.weight, 0);

const edit = (boneId: string, weight: number, from = emptyWeightPaint(VERTS)) =>
  setVertexWeight(from, V, boneId, weight, applyWeightPaint(AUTO, V, from));

describe('the fixture is unclean, as rule 3a requires', () => {
  it('POSITIVE CONTROL: no two bones share a weight', () => {
    const ws = AUTO.map((w) => w.weight);
    expect(new Set(ws).size).toBe(ws.length);
  });

  it('POSITIVE CONTROL: a swap between two bones IS visible', () => {
    // The claim the fixture exists to support. If this ever reports equal, every
    // assertion in this file has stopped being able to see a transposition.
    const swapped: VertexWeight[] = [
      { boneId: 'upper', weight: 0.3 },
      { boneId: 'fore', weight: 0.6 },
      { boneId: 'hand', weight: 0.1 },
    ];
    expect(applyWeightPaint(swapped, V, emptyWeightPaint(VERTS)))
      .not.toEqual(applyWeightPaint(AUTO, V, emptyWeightPaint(VERTS)));
  });
});

describe('an edit lands EXACTLY, and that is the point of writing the whole vertex', () => {
  it('the typed weight is what reads back', () => {
    const after = weightsAfter(edit('fore', 0.5));
    expect(weightOf(after, 'fore')).toBeCloseTo(0.5, 6);
  });

  it('a SECOND edit is also exact — the failure partial writes would cause', () => {
    // Storing only the edited bone would leave `fore` painted at 0.5, so a
    // later `upper: 0.8` would push the painted total to 1.3, drive the
    // unpainted bones to zero and renormalise 0.8 down to ~0.61. This is the
    // assertion the design decision was made for.
    const once = edit('fore', 0.5);
    const twice = edit('upper', 0.8, once);
    expect(weightOf(weightsAfter(twice), 'upper')).toBeCloseTo(0.8, 6);
  });

  it('and a third, after the others have been squeezed to near zero', () => {
    let map = edit('upper', 0.95);
    map = edit('fore', 0.9, map);
    map = edit('hand', 0.25, map);
    expect(weightOf(weightsAfter(map), 'hand')).toBeCloseTo(0.25, 6);
  });
});

describe('normalisation holds after ANY edit', () => {
  // Derived from the fixture rather than a chosen bone/value pair, so a bug
  // that only shows on one bone or at one end of the range cannot hide.
  const VALUES = [0, 0.01, 0.25, 0.5, 0.75, 0.99, 1];
  const CASES = AUTO.flatMap((w) => VALUES.map((v) => [w.boneId, v] as const));

  it.each(CASES)('sums to 1 after setting %s to %f', (boneId, value) => {
    expect(sum(weightsAfter(edit(boneId, value)))).toBeCloseTo(1, 6);
  });

  it('holds through a chain of edits across different bones', () => {
    let map = emptyWeightPaint(VERTS);
    for (const [boneId, value] of CASES) {
      map = setVertexWeight(map, V, boneId, value, applyWeightPaint(AUTO, V, map));
      expect(sum(applyWeightPaint(AUTO, V, map))).toBeCloseTo(1, 6);
    }
  });
});

describe('the rest redistribute in PROPORTION, not evenly', () => {
  it('untouched bones keep their ratio to each other', () => {
    // `fore`:`hand` is 3:1 before. Editing `upper` must not flatten them — the
    // even-split bug produces 1:1 here and passes every sum assertion above.
    const after = weightsAfter(edit('upper', 0.5));
    expect(weightOf(after, 'fore') / weightOf(after, 'hand')).toBeCloseTo(3, 5);
  });

  it('and the released weight goes to the others, not nowhere', () => {
    const after = weightsAfter(edit('upper', 0.2));
    expect(weightOf(after, 'fore') + weightOf(after, 'hand')).toBeCloseTo(0.8, 6);
  });

  it('the edited bone is the one that moves — not its neighbour', () => {
    // Anchored to the bone NAMED in the call, which is what a swap breaks.
    const after = weightsAfter(edit('hand', 0.7));
    expect({ hand: weightOf(after, 'hand') > 0.6, upperFell: weightOf(after, 'upper') < 0.6 })
      .toEqual({ hand: true, upperFell: true });
  });
});

describe('the single-influence boundary the multi-influence fixture excludes', () => {
  const SOLO: VertexWeight[] = [{ boneId: 'only', weight: 1 }];

  it('declines the edit rather than storing a value that cannot survive read-back', () => {
    const map = setVertexWeight(emptyWeightPaint(VERTS), V, 'only', 0.3, SOLO);
    expect(isWeightPaintEmpty(map)).toBe(true);
  });

  it('and the weight stays 1', () => {
    const map = setVertexWeight(emptyWeightPaint(VERTS), V, 'only', 0.3, SOLO);
    expect(weightOf(applyWeightPaint(SOLO, V, map), 'only')).toBeCloseTo(1, 6);
  });

  it('a vertex with NO influence is declined too', () => {
    const map = setVertexWeight(emptyWeightPaint(VERTS), V, 'ghost', 0.5, []);
    expect(isWeightPaintEmpty(map)).toBe(true);
  });
});

describe('inputs that should not corrupt the map', () => {
  it.each([
    ['above 1', 5, 1],
    ['below 0', -3, 0],
  ])('clamps a weight %s', (_label, given, expected) => {
    expect(weightOf(weightsAfter(edit('fore', given)), 'fore')).toBeCloseTo(expected, 6);
  });

  it('refuses an index outside the mesh rather than smearing onto another vertex', () => {
    // Same rule `paintWeights` follows: positional indices from a different mesh
    // resolution address unrelated artwork.
    const map = setVertexWeight(emptyWeightPaint(VERTS), VERTS + 5, 'fore', 0.5, AUTO);
    expect(isWeightPaintEmpty(map)).toBe(true);
  });

  it('does not mutate the map it was given', () => {
    const before = emptyWeightPaint(VERTS);
    const snapshot = JSON.stringify(before);
    setVertexWeight(before, V, 'fore', 0.5, AUTO);
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it('touches only the edited VERTEX, leaving its neighbours alone', () => {
    // The failure mode that would be invisible in a one-vertex fixture.
    const map = setVertexWeight(emptyWeightPaint(VERTS), V, 'fore', 0.5, AUTO);
    for (const boneId of Object.keys(map.bones)) {
      const indices = Object.keys(map.bones[boneId]!).map(Number);
      expect({ boneId, indices }).toEqual({ boneId, indices: [V] });
    }
  });
});
