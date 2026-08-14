import {
  buildRestMesh,
  deform,
  coverageMaskFromImageData,
  silhouetteFromCoverage,
  silhouetteFromPathPoints,
  resolvePuppetSilhouette,
  PuppetRig,
  PuppetSilhouette,
} from './puppet';

/** Build a synthetic RGBA bitmap. `alphaAt(x, y)` returns 0-255 per pixel. */
function makeBitmap(
  width: number,
  height: number,
  alphaAt: (x: number, y: number) => number,
): { data: Uint8ClampedArray; width: number; height: number } {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = alphaAt(x, y);
    }
  }
  return { data, width, height };
}

describe('Puppet Rigging Engine', () => {
  it('should build a rest mesh and auto-weight deterministically', () => {
    const rig: PuppetRig = {
      meshExpansion: 10,
      meshDensity: 10,
      pins: [
        { id: 'pin_1', name: 'Pin 1', x: -25, y: -25 },
        { id: 'pin_2', name: 'Pin 2', x: 25, y: 25 },
      ],
    };

    const mesh = buildRestMesh(100, 100, 5, rig);
    expect(mesh.vertices.length).toBeGreaterThan(0);
    expect(mesh.triangles.length).toBeGreaterThan(0);

    // Weights check
    expect(mesh.weights['pin_1']).toBeDefined();
    expect(mesh.weights['pin_2']).toBeDefined();

    const numVerts = mesh.vertices.length / 4;
    for (let i = 0; i < numVerts; i++) {
      const w1 = mesh.weights['pin_1']![i]!;
      const w2 = mesh.weights['pin_2']![i]!;
      expect(w1 + w2).toBeCloseTo(1.0, 5);
      expect(w1).toBeGreaterThanOrEqual(0.0);
      expect(w2).toBeGreaterThanOrEqual(0.0);
    }
  });

  it('should deform mesh vertices using Linear Blend Skinning', () => {
    const rig: PuppetRig = {
      meshExpansion: 10,
      meshDensity: 5,
      pins: [
        { id: 'pin_1', name: 'Pin 1', x: -25, y: -25 },
        { id: 'pin_2', name: 'Pin 2', x: 25, y: 25 },
      ],
    };

    const mesh = buildRestMesh(100, 100, 5, rig);

    // Translate pin 1 by (+10, +5), keep pin 2 stationary
    const animatedPins = [
      { id: 'pin_1', x: -15, y: -20 },
      { id: 'pin_2', x: 25, y: 25 },
    ];

    // LBS-specific closed-form assertions → pin to the 'lbs' solver explicitly
    // (deform now defaults to ARAP, which is a different algorithm).
    const deformed = deform(animatedPins, mesh, 'lbs');
    expect(deformed.length).toBe(mesh.vertices.length);

    // Vertices near pin 1 should move close to (+10, +5)
    // Vertices near pin 2 should stay close to their rest positions
    const numVerts = mesh.vertices.length / 4;
    for (let i = 0; i < numVerts; i++) {
      const restX = mesh.vertices[i * 4 + 0]!;
      const restY = mesh.vertices[i * 4 + 1]!;
      const defX = deformed[i * 4 + 0]!;
      const defY = deformed[i * 4 + 1]!;

      const w1 = mesh.weights['pin_1']![i]!;

      const expectedX = restX + w1 * 10;
      const expectedY = restY + w1 * 5;

      expect(defX).toBeCloseTo(expectedX, 2);
      expect(defY).toBeCloseTo(expectedY, 2);
    }
  });

  it('deform is bit-identical across repeated calls (rotation + stiffness)', () => {
    const rig: PuppetRig = {
      meshExpansion: 10,
      meshDensity: 12,
      pins: [
        { id: 'a', name: 'A', x: -30, y: 0 },
        { id: 'b', name: 'B', x: 30, y: 0 },
      ],
    };
    const mesh = buildRestMesh(120, 80, 4, rig);
    const pins = [
      { id: 'a', x: -30, y: 0, rotation: 33.7, stiffness: 1.4 },
      { id: 'b', x: 42, y: -11, rotation: -12.25, stiffness: 0.6 },
    ];
    const d1 = deform(pins, mesh);
    const d2 = deform(pins, mesh);
    expect(d1.length).toBe(d2.length);
    for (let i = 0; i < d1.length; i++) {
      // Bit-identical, not just approximately equal.
      expect(Object.is(d1[i], d2[i])).toBe(true);
    }
    // Rebuilding the rest mesh must also be deterministic end-to-end.
    const mesh2 = buildRestMesh(120, 80, 4, rig);
    const d3 = deform(pins, mesh2);
    for (let i = 0; i < d1.length; i++) {
      expect(Object.is(d1[i], d3[i])).toBe(true);
    }
  });

  it('rotation on a single pin rotates the mesh rigidly around it', () => {
    const rig: PuppetRig = {
      meshExpansion: 5,
      meshDensity: 6,
      pins: [{ id: 'p', name: 'P', x: 0, y: 0 }],
    };
    const mesh = buildRestMesh(100, 100, 0, rig);
    // Single pin → normalized weight 1 everywhere → pure rigid rotation.
    const deformed = deform([{ id: 'p', x: 0, y: 0, rotation: 90 }], mesh);
    const n = mesh.vertices.length / 4;
    for (let i = 0; i < n; i++) {
      const rx = mesh.vertices[i * 4 + 0]!;
      const ry = mesh.vertices[i * 4 + 1]!;
      // 90° CCW-in-math-terms rotation about the origin: (x, y) -> (-y, x)
      expect(deformed[i * 4 + 0]!).toBeCloseTo(-ry, 3);
      expect(deformed[i * 4 + 1]!).toBeCloseTo(rx, 3);
      // UVs untouched
      expect(deformed[i * 4 + 2]).toBe(mesh.vertices[i * 4 + 2]);
      expect(deformed[i * 4 + 3]).toBe(mesh.vertices[i * 4 + 3]);
    }
  });

  it('zero rotation and zero stiffness match the translate-only path exactly', () => {
    const rig: PuppetRig = {
      meshExpansion: 10,
      meshDensity: 8,
      pins: [
        { id: 'a', name: 'A', x: -25, y: -25 },
        { id: 'b', name: 'B', x: 25, y: 25 },
      ],
    };
    const mesh = buildRestMesh(100, 100, 5, rig);
    const plain = deform(
      [
        { id: 'a', x: -15, y: -20 },
        { id: 'b', x: 25, y: 25 },
      ],
      mesh,
    );
    const decorated = deform(
      [
        { id: 'a', x: -15, y: -20, rotation: 0, stiffness: 0 },
        { id: 'b', x: 25, y: 25, rotation: 0, stiffness: 0 },
      ],
      mesh,
    );
    for (let i = 0; i < plain.length; i++) {
      expect(Object.is(plain[i], decorated[i])).toBe(true);
    }
  });

  it('stiffness sharpens a pin\'s falloff (less influence away from the pin)', () => {
    const rig: PuppetRig = {
      meshExpansion: 10,
      meshDensity: 10,
      pins: [
        { id: 'a', name: 'A', x: -25, y: -25 },
        { id: 'b', name: 'B', x: 25, y: 25 },
      ],
    };
    const mesh = buildRestMesh(100, 100, 5, rig);
    // Move only pin A. With stiffness on A its effective weight w' at any
    // interior vertex (0 < w < 1) strictly decreases, so the displacement
    // magnitude decreases there.
    //
    // NOTE — pinned to 'lbs' ON PURPOSE. "Stiffness" means two DIFFERENT things
    // per solver, so this falloff assertion is LBS-specific:
    //   • LBS: stiffness SHARPENS a pin's harmonic weight column (exponentiate +
    //     renormalize) → LESS influence away from the pin → smaller displacement
    //     at interior vertices (what this test checks).
    //   • ARAP: stiffness is "starch" — it scales the cotangent EDGE weights in
    //     the rigidity energy so the region resists deformation and moves more
    //     rigidly WITH its pin → interior displacement typically INCREASES, the
    //     opposite sign. (Verified: under ARAP this exact assertion fails at every
    //     interior vertex.) ARAP stiffness has its own coverage in arap.test.ts
    //     ("ARAP stiffness (first-class energy term)"). Hence: keep this on 'lbs'.
    const soft = deform(
      [
        { id: 'a', x: -15, y: -25 },
        { id: 'b', x: 25, y: 25 },
      ],
      mesh,
      'lbs',
    );
    const stiff = deform(
      [
        { id: 'a', x: -15, y: -25, stiffness: 2 },
        { id: 'b', x: 25, y: 25 },
      ],
      mesh,
      'lbs',
    );
    const n = mesh.vertices.length / 4;
    let interiorChecked = 0;
    for (let i = 0; i < n; i++) {
      const w = mesh.weights['a']![i]!;
      const softDx = soft[i * 4 + 0]! - mesh.vertices[i * 4 + 0]!;
      const stiffDx = stiff[i * 4 + 0]! - mesh.vertices[i * 4 + 0]!;
      if (w > 0.05 && w < 0.95) {
        expect(Math.abs(stiffDx)).toBeLessThan(Math.abs(softDx) + 1e-9);
        interiorChecked++;
      }
    }
    expect(interiorChecked).toBeGreaterThan(0);
  });
});

describe('Silhouette-conforming rest mesh', () => {
  const circle = (radius: number, steps = 32): PuppetSilhouette => ({
    points: Array.from({ length: steps }, (_, i) => {
      const a = (i / steps) * Math.PI * 2;
      return { x: Math.cos(a) * radius, y: Math.sin(a) * radius };
    }),
  });

  const rig: PuppetRig = {
    meshExpansion: 0,
    meshDensity: 20,
    pins: [
      { id: 'p1', name: 'P1', x: -10, y: 0 },
      { id: 'p2', name: 'P2', x: 10, y: 0 },
    ],
  };

  it('culls grid cells fully outside the silhouette (fewer vertices than bbox grid)', () => {
    const full = buildRestMesh(100, 100, 0, rig);
    const sil = buildRestMesh(100, 100, 0, rig, circle(20));
    expect(sil.vertices.length).toBeGreaterThan(0);
    expect(sil.vertices.length).toBeLessThan(full.vertices.length);
    expect(sil.triangles.length).toBeLessThan(full.triangles.length);

    // Every kept vertex sits within the silhouette plus the one-ring margin
    // (cell size = 100/20 = 5px; margin ring + corner diag ≈ 3 cells worst case).
    const n = sil.vertices.length / 4;
    const maxR = 20 + 3 * Math.hypot(5, 5);
    for (let i = 0; i < n; i++) {
      const x = sil.vertices[i * 4 + 0]!;
      const y = sil.vertices[i * 4 + 1]!;
      expect(Math.hypot(x, y)).toBeLessThanOrEqual(maxR);
    }

    // The bbox corner vertex must be gone.
    let hasCorner = false;
    for (let i = 0; i < n; i++) {
      if (sil.vertices[i * 4 + 0]! === -50 && sil.vertices[i * 4 + 1]! === -50) hasCorner = true;
    }
    expect(hasCorner).toBe(false);
  });

  it('keeps interior vertices, valid triangles, and normalized weights', () => {
    const sil = buildRestMesh(100, 100, 0, rig, circle(20));
    const n = sil.vertices.length / 4;

    // Interior vertices survive (the origin region is inside the circle).
    let interior = 0;
    for (let i = 0; i < n; i++) {
      if (Math.hypot(sil.vertices[i * 4 + 0]!, sil.vertices[i * 4 + 1]!) < 10) interior++;
    }
    expect(interior).toBeGreaterThan(0);

    // Triangles index valid, compacted vertices.
    for (let i = 0; i < sil.triangles.length; i++) {
      expect(sil.triangles[i]!).toBeLessThan(n);
    }

    // Harmonic weights still normalize per vertex.
    for (let i = 0; i < n; i++) {
      const w = (sil.weights['p1']![i] ?? 0) + (sil.weights['p2']![i] ?? 0);
      expect(w).toBeCloseTo(1.0, 5);
    }
  });

  it('degenerate silhouettes fall back to the full bbox grid', () => {
    const full = buildRestMesh(100, 100, 0, rig);
    const twoPts = buildRestMesh(100, 100, 0, rig, { points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] });
    expect(twoPts.vertices.length).toBe(full.vertices.length);
    // A silhouette entirely off-grid keeps the bbox grid rather than an empty mesh.
    const offGrid = buildRestMesh(100, 100, 0, rig, {
      points: [
        { x: 1000, y: 1000 },
        { x: 1001, y: 1000 },
        { x: 1000, y: 1001 },
      ],
    });
    expect(offGrid.vertices.length).toBe(full.vertices.length);
  });
});

describe('Image-alpha coverage meshing', () => {
  const rig: PuppetRig = {
    meshExpansion: 0,
    meshDensity: 20,
    pins: [
      { id: 'p1', name: 'P1', x: -10, y: 0 },
      { id: 'p2', name: 'P2', x: 10, y: 0 },
    ],
  };

  // A centered opaque disc (radius 30) in a transparent 100×100 field.
  const disc = makeBitmap(100, 100, (x, y) =>
    Math.hypot(x - 50, y - 50) <= 30 ? 255 : 0,
  );

  it('culls fully-transparent corner cells but keeps the opaque center', () => {
    const cov = coverageMaskFromImageData(disc);
    const full = buildRestMesh(100, 100, 0, rig);
    const meshed = buildRestMesh(100, 100, 0, rig, undefined, cov);

    expect(meshed.vertices.length).toBeGreaterThan(0);
    expect(meshed.vertices.length).toBeLessThan(full.vertices.length);
    expect(meshed.triangles.length).toBeLessThan(full.triangles.length);

    const n = meshed.vertices.length / 4;
    // Interior (disc) vertices survive.
    let interior = 0;
    for (let i = 0; i < n; i++) {
      if (Math.hypot(meshed.vertices[i * 4 + 0]!, meshed.vertices[i * 4 + 1]!) < 10) interior++;
    }
    expect(interior).toBeGreaterThan(0);

    // The transparent bbox corner vertex must be gone (disc radius 30 «« 50).
    let hasCorner = false;
    for (let i = 0; i < n; i++) {
      if (meshed.vertices[i * 4 + 0]! === -50 && meshed.vertices[i * 4 + 1]! === -50) hasCorner = true;
    }
    expect(hasCorner).toBe(false);

    // Weights still normalize per vertex.
    for (let i = 0; i < n; i++) {
      const w = (meshed.weights['p1']![i] ?? 0) + (meshed.weights['p2']![i] ?? 0);
      expect(w).toBeCloseTo(1.0, 5);
    }
  });

  it('a fully-opaque image keeps the full bbox grid', () => {
    const opaque = makeBitmap(32, 32, () => 255);
    const cov = coverageMaskFromImageData(opaque);
    const full = buildRestMesh(100, 100, 0, rig);
    const meshed = buildRestMesh(100, 100, 0, rig, undefined, cov);
    expect(meshed.vertices.length).toBe(full.vertices.length);
    expect(meshed.triangles.length).toBe(full.triangles.length);
  });

  it('a fully-transparent image falls back to the bbox grid (never empty)', () => {
    const empty = makeBitmap(32, 32, () => 0);
    const cov = coverageMaskFromImageData(empty);
    const full = buildRestMesh(100, 100, 0, rig);
    const meshed = buildRestMesh(100, 100, 0, rig, undefined, cov);
    expect(meshed.vertices.length).toBe(full.vertices.length);
  });

  it('coverage derivation and meshing are deterministic (repeat = identical)', () => {
    const a = coverageMaskFromImageData(disc);
    const b = coverageMaskFromImageData(disc);
    expect(a.key).toBe(b.key);
    expect(Array.from(a.cells)).toEqual(Array.from(b.cells));

    const m1 = buildRestMesh(100, 100, 0, rig, undefined, a);
    const m2 = buildRestMesh(100, 100, 0, rig, undefined, b);
    expect(m1.vertices.length).toBe(m2.vertices.length);
    for (let i = 0; i < m1.vertices.length; i++) {
      expect(Object.is(m1.vertices[i], m2.vertices[i])).toBe(true);
    }
  });

  it('traces a closed silhouette from a coverage disc (no bbox corners)', () => {
    const cov = coverageMaskFromImageData(disc);
    const sil = silhouetteFromCoverage(cov, 100, 100);
    expect(sil).toBeDefined();
    expect(sil!.points.length).toBeGreaterThanOrEqual(3);
    // Every outline vertex sits on the disc, not out at the transparent corners.
    for (const p of sil!.points) {
      expect(Math.hypot(p.x, p.y)).toBeLessThan(50);
    }
    const meshed = buildRestMesh(100, 100, 0, { ...rig, meshMode: 'silhouette' }, sil);
    const n = meshed.vertices.length / 4;
    let hasCorner = false;
    for (let i = 0; i < n; i++) {
      if (meshed.vertices[i * 4 + 0]! === -50 && meshed.vertices[i * 4 + 1]! === -50) hasCorner = true;
    }
    expect(hasCorner).toBe(false);
  });

  it('expansion 0 does not dilate a ring of empty cells around the artwork', () => {
    const cov = coverageMaskFromImageData(disc);
    const tight = buildRestMesh(100, 100, 0, { ...rig, meshExpansion: 0 }, undefined, cov);
    const padded = buildRestMesh(100, 100, 0, { ...rig, meshExpansion: 1 }, undefined, cov);
    expect(padded.vertices.length).toBeGreaterThan(tight.vertices.length);
  });

  it('does not ear-clip an alpha mask — PNG characters stay a culled grid', () => {
    const cov = coverageMaskFromImageData(disc);
    expect(resolvePuppetSilhouette(undefined, cov, 100, 100, 'silhouette')).toBeUndefined();
    expect(resolvePuppetSilhouette(undefined, cov, 100, 100, 'grid')).toBeUndefined();
    const path = silhouetteFromPathPoints(
      [{ x: -10, y: -10 }, { x: 10, y: -10 }, { x: 10, y: 10 }, { x: -10, y: 10 }],
      false,
    );
    expect(resolvePuppetSilhouette(path, cov, 100, 100, 'silhouette')).toBe(path);
  });
});
