/**
 * ARAP local step — DIRECTIONAL guards (F33).
 *
 * ## Why this file exists separately
 *
 * A mutation sweep of `src/core/rig` (`scripts/symmetrySweep.mjs`) mirrored the
 * ARAP local step's fitted rotation and **all 188 tests stayed green**. The same
 * sweep caught a mirrored LBS pin rotation (3 tests), a transposed global step
 * (2), a swapped displacement axis (6) and an inverted draw order (2) — so the
 * directory is not uniformly blind, and the gap is specific: the rotation ARAP
 * fits *internally* had no assertion that a mirror would fail. Its ARAP tests
 * compare ARAP against LBS on **area preservation** and **rigidity**, and both
 * of those are invariant under a mirrored rotation.
 *
 * ## What "directional" has to mean here
 *
 * Not "the mesh moved", not "ARAP differs from LBS", not "|displacement| is
 * large" — each of those is satisfied by a rotation that goes the wrong way.
 * Every assertion below names a SIGNED coordinate, and the expected value is
 * derived from the rotation matrix on paper rather than recorded from a run.
 *
 * ## What the clean values would exclude (rule 3a)
 *
 * Deliberately avoided, because in each the sign cannot show:
 *   • **θ = 0 or 180°** — sin θ = 0, so R(+θ) and R(−θ) are the same matrix.
 *   • **a mirror-symmetric pin layout** — a configuration symmetric about an
 *     axis maps onto itself under the mirror, so the wrong sign reproduces the
 *     right picture. Pins here are at (−80, −20) and (60, 25): symmetric about
 *     neither axis nor the origin.
 *   • **a single pin** — `deformArap` returns the LBS warm start verbatim below
 *     two distinct handles (`distinct < 2`), so the local step never runs and a
 *     one-pin fixture tests nothing about ARAP at all.
 *   • **a pure uniform scale** — the best-fit rotation of a conformal field is
 *     0, so θ stays at the one value its own sign cannot distinguish.
 */

import { buildRestMesh, deform, type DeformPin, type PuppetRig } from './puppet';

const W = 200;
const H = 60;
const PAD = 0;

/**
 * Pin positions taken from the mesh's OWN grid, not chosen by hand.
 *
 * A pin is constrained at the vertex its weight column peaks on
 * (`resolvePinnedVertices` takes the argmax), but the target it is pulled to is
 * the PIN's position. Put a pin between two vertices and those differ by the
 * snap offset, so "rotate every handle rigidly" no longer has an exactly rigid
 * solution and the mesh cannot reach one however well the solver works. Pins at
 * (−80,−20) and (60,25) left a ~2.4px floor that looked like slow convergence
 * and was not: it did not shrink with more outer iterations, it grew and
 * plateaued (2.00 at 2 iterations, 2.22 at 8, 2.37 at 32).
 *
 * Landing both pins exactly on grid vertices removes the floor and lets the
 * fixture assert what it means to assert.
 */
function gridAxes(): { xs: number[]; ys: number[] } {
  const probe = buildRestMesh(W, H, PAD, {
    meshDensity: 10, meshExpansion: PAD, solver: 'arap',
    pins: [{ id: 'probe', name: 'probe', x: 0, y: 0 }],
  });
  const xs = new Set<number>();
  const ys = new Set<number>();
  for (let i = 0; i < probe.vertices.length / 4; i++) {
    xs.add(probe.vertices[i * 4 + 0]!);
    ys.add(probe.vertices[i * 4 + 1]!);
  }
  return {
    xs: [...xs].sort((a, b) => a - b),
    ys: [...ys].sort((a, b) => a - b),
  };
}

const AXES = gridAxes();
/** Asymmetric about both axes and about the origin — see the header. */
const PIN_A = { x: AXES.xs[1]!, y: AXES.ys[2]! };
const PIN_B = { x: AXES.xs[8]!, y: AXES.ys[9]! };

function rigAt(): PuppetRig {
  return {
    meshDensity: 10,
    meshExpansion: PAD,
    solver: 'arap',
    pins: [
      { id: 'a', name: 'a', x: PIN_A.x, y: PIN_A.y },
      { id: 'b', name: 'b', x: PIN_B.x, y: PIN_B.y },
    ],
  };
}

function rot(p: { x: number; y: number }, deg: number): { x: number; y: number } {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: c * p.x - s * p.y, y: s * p.x + c * p.y };
}

function vertexAt(v: Float32Array, i: number): { x: number; y: number } {
  return { x: v[i * 4 + 0]!, y: v[i * 4 + 1]! };
}

describe('ARAP local step fits the rotation its global step applies', () => {
  const THETA = 40; // not 0, not 180 — see the header

  it('the fixture is asymmetric and its pins sit exactly on mesh vertices', () => {
    // Both are preconditions for everything below, so they are asserted rather
    // than assumed. A layout symmetric about either axis or about the origin
    // maps onto itself under the mirror, and a pin off-vertex reintroduces the
    // snap floor described above.
    expect(PIN_A.y).not.toBeCloseTo(-PIN_B.y, 6);   // not mirror-symmetric in x
    expect(PIN_A.x).not.toBeCloseTo(-PIN_B.x, 6);   // not mirror-symmetric in y
    expect(PIN_A.x).not.toBeCloseTo(-PIN_B.x, 6);
    expect(AXES.xs).toContain(PIN_A.x);
    expect(AXES.ys).toContain(PIN_A.y);
    expect(AXES.xs).toContain(PIN_B.x);
    expect(AXES.ys).toContain(PIN_B.y);
  });

  it('a rigidly rotated pin set produces a rigidly rotated MESH, the correct way round', () => {
    // Derivation, before any code was run: if both handles are moved to
    // R(θ)·rest and both are given local frame R(θ), then p' = R(θ)·p with
    // R_i = R(θ) everywhere makes the ARAP energy
    //     Σ w ‖(p'_i − p'_j) − R_i(p_i − p_j)‖²
    // exactly ZERO. The energy is non-negative, so that is the global minimum
    // and the solved mesh must be the rigid rotation of the rest mesh.
    //
    // With the fitted rotation mirrored, the global step assembles its RHS from
    // R(−θ)·e for every free vertex while the handles pull toward R(+θ), and
    // the interior cannot be the rigid rotation.
    const rig = rigAt();
    const mesh = buildRestMesh(W, H, PAD, rig);
    const pins: DeformPin[] = [
      { id: 'a', ...rot(PIN_A, THETA), rotation: THETA },
      { id: 'b', ...rot(PIN_B, THETA), rotation: THETA },
    ];
    const out = deform(pins, mesh, 'arap');

    const n = mesh.vertices.length / 4;
    let worst = 0;
    for (let i = 0; i < n; i++) {
      const want = rot(vertexAt(mesh.vertices, i), THETA);
      const got = vertexAt(out, i);
      worst = Math.max(worst, Math.hypot(got.x - want.x, got.y - want.y));
    }
    // Generous: this is a shape claim, not a convergence benchmark. The mirrored
    // build misses by more than an order of magnitude more than this.
    expect(worst).toBeLessThan(1.5);
  });

  it('the mirrored rotation is NOT a rigid rotation — the tolerance above is discriminating', () => {
    // Guards the guard. If R(−θ) also landed within 1.5px of R(+θ) for this
    // mesh, the assertion above would be satisfied by either sign and would be
    // measuring nothing. Computed from the matrices, no solver involved.
    const rig = rigAt();
    const mesh = buildRestMesh(W, H, PAD, rig);
    const n = mesh.vertices.length / 4;
    let worst = 0;
    for (let i = 0; i < n; i++) {
      const v = vertexAt(mesh.vertices, i);
      const plus = rot(v, THETA);
      const minus = rot(v, -THETA);
      worst = Math.max(worst, Math.hypot(plus.x - minus.x, plus.y - minus.y));
    }
    expect(worst).toBeGreaterThan(15);
  });

  it('one named interior vertex lands on R(+40°)·v, not on R(−40°)·v', () => {
    // The same configuration as above reduced to a single hand-checkable point,
    // so a reader can verify the claim with a calculator instead of a loop.
    // Subject derived from the mesh (its +x extreme), expectation derived from
    // the rotation matrix.
    const rig = rigAt();
    const mesh = buildRestMesh(W, H, PAD, rig);
    let probe = -1;
    let best = -Infinity;
    for (let i = 0; i < mesh.vertices.length / 4; i++) {
      const v = vertexAt(mesh.vertices, i);
      const score = v.x - Math.abs(v.y) * 0.01;
      if (score > best) { best = score; probe = i; }
    }
    expect(probe).toBeGreaterThanOrEqual(0);
    const rest = vertexAt(mesh.vertices, probe);
    expect(rest.x).toBeGreaterThan(50); // genuinely out on +x, where sin θ shows

    const out = deform(
      [
        { id: 'a', ...rot(PIN_A, THETA), rotation: THETA },
        { id: 'b', ...rot(PIN_B, THETA), rotation: THETA },
      ],
      mesh, 'arap',
    );
    const got = vertexAt(out, probe);
    const want = rot(rest, THETA);
    const wrong = rot(rest, -THETA);

    // The signed statement, stated before the measurement: +40° about the origin
    // RAISES a vertex out on +x (sin 40° > 0); −40° lowers it.
    expect(want.y).toBeGreaterThan(rest.y);
    expect(wrong.y).toBeLessThan(rest.y);

    expect(got.x).toBeCloseTo(want.x, 0);
    expect(got.y).toBeCloseTo(want.y, 0);
    expect(Math.hypot(got.x - wrong.x, got.y - wrong.y)).toBeGreaterThan(20);
  });

  it('holds at −40° too, so the fix is not a sign hard-coded for positive angles', () => {
    // Same rigid-rotation argument mirrored. Both this and the +40° case fail on
    // the un-fixed build; together they say the solver TRACKS the input sign
    // rather than having had one direction special-cased into agreement.
    //
    // Note what this deliberately is NOT: "negating the input negates the
    // output". That property is true of the mirrored implementation as well —
    // it is self-consistent — so it would have passed at HEAD and measured
    // nothing. The claim has to be anchored to R(−θ) computed independently.
    const rig = rigAt();
    const mesh = buildRestMesh(W, H, PAD, rig);
    const out = deform(
      [
        { id: 'a', ...rot(PIN_A, -THETA), rotation: -THETA },
        { id: 'b', ...rot(PIN_B, -THETA), rotation: -THETA },
      ],
      mesh, 'arap',
    );
    const n = mesh.vertices.length / 4;
    let worst = 0;
    for (let i = 0; i < n; i++) {
      const want = rot(vertexAt(mesh.vertices, i), -THETA);
      const got = vertexAt(out, i);
      worst = Math.max(worst, Math.hypot(got.x - want.x, got.y - want.y));
    }
    expect(worst).toBeLessThan(1.5);
  });
});
