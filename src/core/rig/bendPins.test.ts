/**
 * Bend pins — a pin whose position is derived from the pins around it.
 *
 * ## What these guards are shaped against
 *
 * The failure this feature invites is shipping a second advanced pin. Both have
 * a rotation and a scale; both bend a mesh; a screenshot of either looks
 * plausible. So almost every test here is DIFFERENTIAL — it compares a bend pin
 * against an advanced pin in the same place with the same numbers, and fails if
 * they agree. A test that only asserted "the mesh moved" would pass just as
 * happily on a bend pin that quietly behaved like an advanced one.
 *
 * The two properties that separate them:
 *   • the centre TRAVELS — it is wherever the drivers carried that point;
 *   • at identity it contributes NOTHING — byte-identical to deleting the pin.
 *
 * The second is what the re-normalisation in `driverRestMesh` buys, and it is
 * asserted on a bend pin placed where it holds real weight — a bend pin off in
 * the corner would satisfy it for free and prove nothing.
 */

import {
  buildRestMesh,
  deform,
  type DeformPin,
  type PuppetRig,
  type DeformedMesh,
} from './puppet';
import { splitBendPins, driverRestMesh, applyBendPins, solveDeform } from './bendPins';

const W = 120;
const H = 90;
const PAD = 6;

/** Rig with two drivers at the ends and one pin in the middle. */
function rigWith(middleKind: 'advanced' | 'bend' | 'absent'): PuppetRig {
  const pins: PuppetRig['pins'] = [
    { id: 'L', name: 'L', x: -40, y: 0 },
    { id: 'R', name: 'R', x: 40, y: 0 },
  ];
  if (middleKind !== 'absent') {
    pins.push({ id: 'M', name: 'M', x: 0, y: 0, ...(middleKind === 'bend' ? { kind: 'bend' as const } : {}) });
  }
  return { pins, meshDensity: 12, meshExpansion: PAD, solver: 'lbs' };
}

function meshFor(rig: PuppetRig): DeformedMesh {
  return buildRestMesh(W, H, PAD, rig);
}

/** Drivers displaced; the middle pin carries whatever `over` says. */
function livePins(rig: PuppetRig, over: Partial<DeformPin> = {}): DeformPin[] {
  return rig.pins.map((p) => {
    if (p.id === 'L') return { id: 'L', x: -40, y: -30 }; // driver moved UP
    if (p.id === 'R') return { id: 'R', x: 40, y: 0 };
    return { id: p.id, x: p.x, y: p.y, ...(p.kind ? { kind: p.kind } : {}), ...over };
  });
}

function identical(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

function vertexAt(v: Float32Array, i: number): { x: number; y: number } {
  return { x: v[i * 4 + 0]!, y: v[i * 4 + 1]! };
}

describe('splitBendPins', () => {
  it('returns null when no pin is a bend pin, so the old path is reached untouched', () => {
    expect(splitBendPins([{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 1, y: 1 }])).toBeNull();
  });

  it('returns null when EVERY pin is a bend pin — nothing to derive a position from', () => {
    // Not an empty split: a rig of nothing but bend pins must fall through to the
    // ordinary solve rather than deforming with zero constraints. Returning a
    // split with an empty driver list here would solve an unpinned mesh and
    // collapse the layer.
    expect(splitBendPins([
      { id: 'a', x: 0, y: 0, kind: 'bend' },
      { id: 'b', x: 1, y: 1, kind: 'bend' },
    ])).toBeNull();
  });

  it('separates drivers from bends, preserving order within each', () => {
    const split = splitBendPins([
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 1, y: 1, kind: 'bend' },
      { id: 'c', x: 2, y: 2, kind: 'advanced' },
      { id: 'd', x: 3, y: 3, kind: 'bend' },
    ]);
    expect(split).not.toBeNull();
    expect(split!.drivers.map((p) => p.id)).toEqual(['a', 'c']);
    expect(split!.bends.map((p) => p.id)).toEqual(['b', 'd']);
  });
});

describe('driverRestMesh', () => {
  it('re-normalises the driver columns to a partition of unity', () => {
    const rig = rigWith('bend');
    const mesh = meshFor(rig);
    const view = driverRestMesh(mesh, [{ id: 'M', x: 0, y: 0, kind: 'bend' }]);
    expect(Object.keys(view.weights).sort()).toEqual(['L', 'R']);
    const n = mesh.vertices.length / 4;
    for (let i = 0; i < n; i++) {
      const sum = (view.weights.L![i] ?? 0) + (view.weights.R![i] ?? 0);
      expect(sum).toBeCloseTo(1, 5);
    }
  });

  it('leaves the shared rest mesh unmutated', () => {
    const mesh = meshFor(rigWith('bend'));
    const before = Float32Array.from(mesh.weights.L!);
    driverRestMesh(mesh, [{ id: 'M', x: 0, y: 0, kind: 'bend' }]);
    expect(identical(mesh.weights.L!, before)).toBe(true);
  });

  it('returns the same object for the same bend set, so ARAP does not re-factorise every frame', () => {
    const mesh = meshFor(rigWith('bend'));
    const bends: DeformPin[] = [{ id: 'M', x: 0, y: 0, kind: 'bend' }];
    expect(driverRestMesh(mesh, bends)).toBe(driverRestMesh(mesh, bends));
  });
});

describe('a bend pin at identity contributes nothing', () => {
  // The fixture is only meaningful if the bend pin actually holds influence at
  // the vertices being compared. Asserted, not assumed: a pin whose column were
  // all zeros would make every identity test below pass for free.
  it('the middle pin holds real weight — the identity fixtures are not vacuous', () => {
    const mesh = meshFor(rigWith('bend'));
    const col = mesh.weights.M!;
    let peak = 0;
    for (let i = 0; i < col.length; i++) peak = Math.max(peak, col[i]!);
    expect(peak).toBeGreaterThan(0.5);
  });

  it('returns the driver array ITSELF — no copy, no rounding, nothing to drift', () => {
    // Reference equality, deliberately. "Deep-equal to the driver solve" would
    // also pass on an implementation that copied and rewrote every vertex with
    // an identity transform, and that version has somewhere for a rounding
    // difference to appear. This one does not.
    const rig = rigWith('bend');
    const mesh = meshFor(rig);
    const base = mesh.vertices;
    const idle: DeformPin[] = [
      { id: 'M', x: 0, y: 0, kind: 'bend' },
      { id: 'M2', x: 5, y: 5, kind: 'bend', rotation: 0, scale: 1 },
    ];
    expect(applyBendPins(base, idle, mesh)).toBe(base);
  });

  it('does NOT nail the mesh down — the drivers still carry its anchor', () => {
    // This is what the re-normalisation buys, and the number is derivable.
    //
    // Every pin's anchor vertex is a Dirichlet boundary in the harmonic solve:
    // at M's anchor, L's and R's weight columns are both exactly 0. Hand the
    // driver-only solve those raw columns and the displacement there is 0·L +
    // 0·R = 0 — an idle bend pin would behave as a STARCH pin, pinning the
    // middle of the mesh while the ends move. Re-normalising sends that vertex
    // down the equal-share branch instead: ½ each over two drivers.
    //
    // L moves (−40, 0) → (−40, −30); R does not move. So the expected
    // displacement at M's anchor is ½·(0, −30) + ½·(0, 0) = (0, −15).
    const rig = rigWith('bend');
    const mesh = meshFor(rig);
    const k = mesh.pinVertexIndices.M!;
    const rest = vertexAt(mesh.vertices, k);
    const out = vertexAt(deform(livePins(rig), mesh, 'lbs'), k);
    expect(out.x - rest.x).toBeCloseTo(0, 4);
    expect(out.y - rest.y).toBeCloseTo(-15, 4);
  });

  it('the un-renormalised solve really would have nailed it — the guard above is not free', () => {
    // The same rig solved with the raw columns, which is what dropping the
    // bend pin from the pin list without re-normalising produces. If this
    // displacement were also −15 the test above would prove nothing.
    const rig = rigWith('bend');
    const mesh = meshFor(rig);
    const k = mesh.pinVertexIndices.M!;
    const rest = vertexAt(mesh.vertices, k);
    const raw = vertexAt(solveDeform(
      [{ id: 'L', x: -40, y: -30 }, { id: 'R', x: 40, y: 0 }], mesh, 'lbs',
    ), k);
    expect(raw.y - rest.y).toBeCloseTo(0, 4);
  });

  it('away from the anchor the drivers blend by their real weights, not an equal share', () => {
    // The −15 above lands on the one vertex where the equal-share fallback and
    // a correct harmonic blend happen to COINCIDE (both columns are 0 there, and
    // the pin sits midway between two symmetric drivers). Taken alone it cannot
    // tell a working re-normalisation from a hard-coded ½. This probes a vertex
    // out on L's side instead, where the two differ.
    //
    // The expected displacements are computed from the mesh's OWN weight
    // columns rather than written down as numbers: only L moves, by −30, so
    //   re-normalised  dy = −30 · L/(L+R)
    //   raw            dy = −30 · L
    // A recorded constant here would have to be re-recorded every time the
    // meshing changed, and would stop being a derivation the moment it was.
    const rig = rigWith('bend');
    const mesh = meshFor(rig);

    // Chosen from the mesh: on the centre line, strictly between the bend pin's
    // anchor and L's, and the nearer of those to L. Every pin ANCHOR is a
    // degenerate probe — the columns there are a hard 1 and 0 by construction,
    // so re-normalising cannot change the answer and the fixture would pass
    // whatever the code did. (The first version of this test picked the vertex
    // closest to x = −30 and landed on L's anchor, which is exactly that trap.)
    const anchorL = vertexAt(mesh.vertices, mesh.pinVertexIndices.L!).x;
    const anchorM = vertexAt(mesh.vertices, mesh.pinVertexIndices.M!).x;
    let probe = -1;
    let best = Infinity;
    for (let i = 0; i < mesh.vertices.length / 4; i++) {
      const v = vertexAt(mesh.vertices, i);
      if (Math.abs(v.y) > 1e-6) continue;
      if (!(v.x > anchorL && v.x < anchorM)) continue;
      const d = Math.abs(v.x - anchorL);
      if (d < best) { best = d; probe = i; }
    }
    expect(probe).toBeGreaterThanOrEqual(0);

    const wL = mesh.weights.L![probe]!;
    const wR = mesh.weights.R![probe]!;
    const wM = mesh.weights.M![probe]!;
    // All three live, or there is nothing for re-normalisation to redistribute.
    expect(wM).toBeGreaterThan(0.05);
    expect(wL).toBeGreaterThan(0);
    expect(wR).toBeGreaterThan(0);

    const rest = vertexAt(mesh.vertices, probe);
    const out = vertexAt(deform(livePins(rig), mesh, 'lbs'), probe);
    expect(out.y - rest.y).toBeCloseTo(-30 * (wL / (wL + wR)), 3);

    // And the raw columns genuinely damp it — the half that makes the assertion
    // above mean something rather than restate the implementation.
    const raw = vertexAt(solveDeform(
      [{ id: 'L', x: -40, y: -30 }, { id: 'R', x: 40, y: 0 }], mesh, 'lbs',
    ), probe);
    expect(raw.y - rest.y).toBeCloseTo(-30 * wL, 3);
    expect(Math.abs((out.y - rest.y) - (raw.y - rest.y))).toBeGreaterThan(1);
  });

  it('scale 1 with a NON-zero rotation is not identity — the skip tests both halves', () => {
    const rig = rigWith('bend');
    const mesh = meshFor(rig);
    const idle = deform(livePins(rig), mesh, 'lbs');
    const turned = deform(livePins(rig, { rotation: 20 }), mesh, 'lbs');
    expect(identical(idle, turned)).toBe(false);
  });

  it('rotation 0 with a NON-unit scale is not identity either', () => {
    const rig = rigWith('bend');
    const mesh = meshFor(rig);
    const idle = deform(livePins(rig), mesh, 'lbs');
    const scaled = deform(livePins(rig, { scale: 1.4 }), mesh, 'lbs');
    expect(identical(idle, scaled)).toBe(false);
  });
});

describe('the centre travels with the drivers', () => {
  it("the bend pin's own vertex sits where the drivers put it, whatever it rotates by", () => {
    // This IS the feature. The pin's bound vertex is the centre of its own
    // rotation, so its own rotation cannot move it — but the drivers can, and
    // do. Compare against the driver-only solve: same point, to the bit.
    const rig = rigWith('bend');
    const mesh = meshFor(rig);
    const k = mesh.pinVertexIndices.M!;
    const driverOnly = deform(livePins(rigWith('absent')), meshFor(rigWith('absent')), 'lbs');
    for (const rotation of [0, 35, -80]) {
      const bent = deform(livePins(rig, { rotation }), mesh, 'lbs');
      expect(vertexAt(bent, k)).toEqual(vertexAt(driverOnly, k));
    }
  });

  it('an ADVANCED pin at the same rest point drags that vertex back toward its rest anchor', () => {
    // The differential that names the difference. An advanced pin owns its
    // position: leaving it at rest while a driver moves PINS the middle of the
    // mesh, so the vertex lands somewhere other than where the drivers alone
    // would carry it. A bend pin has no such opinion.
    const advRig = rigWith('advanced');
    const advMesh = meshFor(advRig);
    const k = advMesh.pinVertexIndices.M!;
    const advanced = deform(livePins(advRig), advMesh, 'lbs');
    const driverOnly = deform(livePins(rigWith('absent')), meshFor(rigWith('absent')), 'lbs');
    const a = vertexAt(advanced, k);
    const d = vertexAt(driverOnly, k);
    expect(Math.hypot(a.x - d.x, a.y - d.y)).toBeGreaterThan(1);
  });

  it('rotating a bend pin turns the mesh about the MOVED centre, not the rest anchor', () => {
    // Checked against the arithmetic, both ways round. For a vertex carrying
    // weight w, `applyBendPins` must land it at
    //     base + w · ( c + R(θ)(base − c) − base )
    // and the whole question is which `c`. The derived centre and the rest
    // anchor are 15px apart here (L moves −30, the anchor takes half), so the
    // two predictions are far enough apart to tell apart — and the test asserts
    // it matches ONE and not the other. An earlier version of this test only
    // checked that the result was "not a pure translation", which break 4
    // (rotate about the rest anchor) satisfied happily: the base deformation
    // differs between the two cases regardless, so it passed while testing
    // nothing about the centre at all.
    const rig = rigWith('bend');
    const mesh = meshFor(rig);
    const k = mesh.pinVertexIndices.M!;
    const theta = 40 * (Math.PI / 180);
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);

    const base = deform(
      [{ id: 'L', x: -40, y: -30 }, { id: 'R', x: 40, y: 0 }],
      driverRestMesh(mesh, [{ id: 'M', x: 0, y: 0, kind: 'bend' }]),
      'lbs',
    );
    const bent = deform(livePins(rig, { rotation: 40 }), mesh, 'lbs');

    const derived = vertexAt(base, k);
    const restAnchor = mesh.pinRestPositions.M!;
    expect(Math.hypot(derived.x - restAnchor.x, derived.y - restAnchor.y)).toBeGreaterThan(10);

    // A vertex with real influence, away from the centre so rotation shows.
    let probe = -1;
    for (let i = 0; i < mesh.vertices.length / 4; i++) {
      const b = vertexAt(base, i);
      if ((mesh.weights.M![i] ?? 0) > 0.5 && Math.hypot(b.x - derived.x, b.y - derived.y) > 8) { probe = i; break; }
    }
    expect(probe).toBeGreaterThanOrEqual(0);

    const w = mesh.weights.M![probe]!;
    const b = vertexAt(base, probe);
    const predict = (c: { x: number; y: number }) => {
      const rx = b.x - c.x;
      const ry = b.y - c.y;
      return {
        x: b.x + w * (cos * rx - sin * ry + c.x - b.x),
        y: b.y + w * (sin * rx + cos * ry + c.y - b.y),
      };
    };
    const got = vertexAt(bent, probe);
    const viaDerived = predict(derived);
    const viaRest = predict(restAnchor);
    expect(Math.hypot(got.x - viaDerived.x, got.y - viaDerived.y)).toBeLessThan(1e-3);
    expect(Math.hypot(got.x - viaRest.x, got.y - viaRest.y)).toBeGreaterThan(1);
  });
});

describe('rotation direction', () => {
  it('a positive bend rotation turns the same way an advanced pin does', () => {
    // The sign trap. `deformLbs` builds its rigid branch as
    //   (cos·relX − sin·relY, sin·relX + cos·relY)
    // and a bend pin must match it, or the two pin types would turn opposite
    // ways from the same positive number. Asserted by DIRECTION, not magnitude:
    // a test on |displacement| passes under a flipped sign.
    const mesh = meshFor(rigWith('bend'));
    const rest = mesh.vertices;
    const k = mesh.pinVertexIndices.M!;
    // No driver motion, so the only thing acting is the bend pin's rotation.
    const bent = applyBendPins(
      rest, [{ id: 'M', x: 0, y: 0, kind: 'bend', rotation: 90 }], mesh,
    );
    const c = vertexAt(rest, k);
    // Find a vertex clearly to the RIGHT of the centre with meaningful weight.
    let probe = -1;
    for (let i = 0; i < rest.length / 4; i++) {
      const v = vertexAt(rest, i);
      if (v.x - c.x > 8 && Math.abs(v.y - c.y) < 1 && (mesh.weights.M![i] ?? 0) > 0.4) { probe = i; break; }
    }
    expect(probe).toBeGreaterThanOrEqual(0);
    const before = vertexAt(rest, probe);
    const after = vertexAt(bent, probe);
    // +90° about c must carry (+x, 0) toward (0, +y): x shrinks, y grows.
    expect(after.x - c.x).toBeLessThan(before.x - c.x);
    expect(after.y - c.y).toBeGreaterThan(before.y - c.y);
  });
});

describe('composition and clamping', () => {
  it('two bend pins compose — the second reads its centre from the first', () => {
    const rig: PuppetRig = {
      pins: [
        { id: 'L', name: 'L', x: -40, y: 0 },
        { id: 'R', name: 'R', x: 40, y: 0 },
        { id: 'B1', name: 'B1', x: -10, y: 0, kind: 'bend' },
        { id: 'B2', name: 'B2', x: 10, y: 0, kind: 'bend' },
      ],
      meshDensity: 12, meshExpansion: PAD, solver: 'lbs',
    };
    const mesh = meshFor(rig);
    const base: DeformPin[] = [
      { id: 'L', x: -40, y: -30 },
      { id: 'R', x: 40, y: 0 },
      { id: 'B1', x: -10, y: 0, kind: 'bend', rotation: 25 },
      { id: 'B2', x: 10, y: 0, kind: 'bend', rotation: 25 },
    ];
    const both = deform(base, mesh, 'lbs');
    const onlyFirst = deform(
      base.map((p) => (p.id === 'B2' ? { ...p, rotation: 0 } : p)), mesh, 'lbs',
    );
    expect(identical(both, onlyFirst)).toBe(false);
  });

  it('maxRotationDeg clamps a bend pin, exactly as it clamps every other pin', () => {
    const rig = rigWith('bend');
    const mesh = meshFor(rig);
    const free = deform(livePins(rig, { rotation: 150 }), mesh, 'lbs');
    const capped = deform(livePins(rig, { rotation: 150 }), mesh, 'lbs', 20);
    expect(identical(free, capped)).toBe(false);
    const at20 = deform(livePins(rig, { rotation: 20 }), mesh, 'lbs', 20);
    expect(identical(capped, at20)).toBe(true);
  });

  it('is deterministic — same input, bit-identical output', () => {
    const rig = rigWith('bend');
    const mesh = meshFor(rig);
    const a = deform(livePins(rig, { rotation: 33, scale: 1.2 }), mesh, 'arap');
    const b = deform(livePins(rig, { rotation: 33, scale: 1.2 }), mesh, 'arap');
    expect(identical(a, b)).toBe(true);
  });
});
