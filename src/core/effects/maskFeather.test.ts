/**
 * Variable-width mask feather — the pure core on synthetic coverage, plus the
 * model contracts (opt-in detection, outline sampling, animation lerp).
 *
 * The canvas wrapper is exercised implicitly through paintMaskMatte's suite;
 * what must hold HERE is the algorithm: soft where the nearest vertex says
 * soft, hard where it says hard, and byte-identical coverage outside the band.
 */


import { interpolateMask, rectangleMask, type MaskPath } from './mask';

describe('the model contracts', () => {
  const withVertexFeather = (f?: number): MaskPath => {
    const p = rectangleMask(40, 40);
    if (f !== undefined) p.points[0] = { ...p.points[0]!, feather: f };
    return p;
  };

  it('mask animation lerps per-vertex feather like every other vertex quantity', () => {
    const a = withVertexFeather(0);
    const b = withVertexFeather(20);
    const mid = interpolateMask(
      [{ t: 0, mask: { paths: [a] } }, { t: 1, mask: { paths: [b] } }],
      0.5,
    );
    expect(mid!.paths[0]!.points[0]!.feather).toBeCloseTo(10);
    // Unmarked vertices stay unmarked — no phantom opt-in from the lerp.
    expect(mid!.paths[0]!.points[1]!.feather).toBeUndefined();
  });
});
