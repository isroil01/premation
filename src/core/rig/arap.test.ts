/**
 * ARAP (As-Rigid-As-Possible) puppet-solver tests.
 *
 * Covers: determinism (bit-identical across repeats and fresh inputs); the
 * defining rigidity property (a two-pin bent bar keeps triangle area under ARAP
 * while LBS candy-wrapper-collapses it); graceful fallback on degenerate meshes;
 * and single-pin = rigid translate (ARAP defers to the exact LBS path).
 */


import {
  
  maxExactMeshDensity,
  ARAP_DENSE_MAX,
  ARAP_STIFF_DENSE_MAX,
} from './arap';

/**
 * §12.11 — the exact/approximate boundary is now disclosed in the inspector, so
 * the threshold it reports has to be right.
 */
describe('ARAP solver-quality threshold disclosure', () => {
  it('reports the density where the exact dense solve stops fitting', () => {
    expect(maxExactMeshDensity(false)).toBe(33); // (33+1)^2 = 1156 <= 1200
    expect(maxExactMeshDensity(true)).toBe(21);  // (21+1)^2 = 484  <= 512
  });

  it('the reported density really does fit the cap, and the next one does not', () => {
    for (const stiff of [false, true]) {
      const cap = stiff ? ARAP_STIFF_DENSE_MAX : ARAP_DENSE_MAX;
      const d = maxExactMeshDensity(stiff);
      expect((d + 1) ** 2).toBeLessThanOrEqual(cap);
      expect((d + 2) ** 2).toBeGreaterThan(cap);
    }
  });

  it('stiffness lowers the threshold (the animated-refactor guard)', () => {
    expect(maxExactMeshDensity(true)).toBeLessThan(maxExactMeshDensity(false));
  });
});
