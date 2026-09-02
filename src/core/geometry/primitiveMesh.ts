/**
 * Parametric primitive → triangle mesh.
 *
 * Pure generators for the shapes an extruded 2D outline cannot be: a sphere is
 * not an extruded circle (that is a capsule), a torus has a hole through an
 * axis the extrusion sweep does not have, and a cone tapers along the sweep.
 * `extrudeMesh.ts` sweeps an OUTLINE along z; this file writes surfaces of
 * revolution and boxes directly, with smooth per-vertex normals so a
 * tessellated curve lights as a curve instead of as its facets.
 *
 * Frame: the compositor's — layer-centred pixels, **y down**, **+z away** from
 * the viewer (the default camera looks down +z; see project3d.ts). It is a
 * right-handed basis (x × y = z), so "counter-clockwise seen from outside"
 * means a positive signed volume, which is what the tests pin. Nothing in the
 * renderer culls back faces today; consistent winding is a correctness
 * property of these generators, not a requirement of the draw.
 *
 * Every generator returns DE-INTERLEAVED arrays (positions / normals / uvs /
 * indices) — the scene layer interleaves them into the 8-float vertex the
 * `extrudedMesh` carrier wants. Keeping them apart here makes the maths (and
 * the tests) readable, and costs one copy at registration time, once per
 * distinct parameter set.
 *
 * Seams: every generator that wraps duplicates the wrap column so u can reach
 * 1.0 rather than jumping 0.97 → 0. A shared seam vertex would smear the whole
 * texture backwards across the last column.
 *
 * All shapes are centred on the origin, so the layer's anchor, gizmo and
 * rotation pivot sit in the middle of the object.
 */

/** One generated surface. Positions/normals are xyz triples, uvs uv pairs. */
export interface PrimitiveGeometry {
  /** x y z per vertex. */
  positions: Float32Array;
  /** Unit normal per vertex, xyz. */
  normals: Float32Array;
  /** u v per vertex. */
  uvs: Float32Array;
  /** Triangle list, CCW seen from outside. */
  indices: Uint32Array;
}

const TAU = Math.PI * 2;

/** Segment counts are geometry, not taste: clamp rather than emit a degenerate
 *  surface a downstream buffer upload would reject. */
function segs(n: number, min: number, max = 512): number {
  return Math.max(min, Math.min(max, Math.floor(Number.isFinite(n) ? n : min)));
}

function positive(v: number, fallback: number): number {
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** Non-negative (a cone's top radius, a capsule's mid-section, may be 0). */
function nonNegative(v: number, fallback: number): number {
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

/**
 * A quad of a wrapped grid whose rows run DOWN (+y) and columns run around.
 * Both triangles come out CCW-from-outside for a surface whose normal is the
 * outward radial direction — derived once here so every surface of revolution
 * below shares one winding decision instead of four.
 *
 * `a` top-left, `b` top-right, `c` bottom-right, `d` bottom-left.
 */
function pushRevolutionQuad(
  out: number[],
  a: number, b: number, c: number, d: number,
  skipUpper: boolean, skipLower: boolean,
): void {
  if (!skipUpper) out.push(a, d, b);
  if (!skipLower) out.push(b, d, c);
}

/**
 * UV sphere. `widthSegments` columns around, `heightSegments` rows pole to
 * pole. v = 0 is the −y pole (the TOP of the screen: y is down).
 */
export function sphereMesh(radius: number, widthSegments = 32, heightSegments = 16): PrimitiveGeometry {
  const r = positive(radius, 1);
  const W = segs(widthSegments, 3);
  const H = segs(heightSegments, 2);
  const cols = W + 1;
  const rows = H + 1;
  const count = cols * rows;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);

  for (let iy = 0; iy < rows; iy++) {
    const v = iy / H;
    const theta = v * Math.PI;
    const sinT = Math.sin(theta);
    // −cos so the pole at theta = 0 sits at −y, i.e. up on screen.
    const cosT = Math.cos(theta);
    for (let ix = 0; ix < cols; ix++) {
      const u = ix / W;
      const phi = u * TAU;
      const nx = sinT * Math.cos(phi);
      const ny = 0 - cosT;
      const nz = sinT * Math.sin(phi);
      const i = iy * cols + ix;
      positions[i * 3] = nx * r;
      positions[i * 3 + 1] = ny * r;
      positions[i * 3 + 2] = nz * r;
      normals[i * 3] = nx;
      normals[i * 3 + 1] = ny;
      normals[i * 3 + 2] = nz;
      uvs[i * 2] = u;
      uvs[i * 2 + 1] = v;
    }
  }

  const idx: number[] = [];
  for (let iy = 0; iy < H; iy++) {
    for (let ix = 0; ix < W; ix++) {
      const a = iy * cols + ix;
      pushRevolutionQuad(
        idx, a, a + 1, a + cols + 1, a + cols,
        // The row touching a pole collapses one of its two triangles.
        iy === 0, iy === H - 1,
      );
    }
  }
  return { positions, normals, uvs, indices: Uint32Array.from(idx) };
}

/**
 * Cylinder / frustum / cone about the y axis, centred on the origin. The top
 * ring (radius `radiusTop`) sits at −height/2, the bottom at +height/2.
 * `radiusTop = 0` gives a cone; both radii 0 is refused (nothing to draw).
 *
 * Side normals are exact for the tapered wall — a cone's wall normal tilts
 * toward the apex by its own slope, which is why a cone shaded with a
 * cylinder's horizontal normals looks like a lampshade rather than a solid.
 */
export function cylinderMesh(
  radiusTop: number,
  radiusBottom: number,
  height: number,
  radialSegments = 32,
  capped = true,
): PrimitiveGeometry {
  const rt = nonNegative(radiusTop, 0);
  const rb = nonNegative(radiusBottom, 1);
  const h = positive(height, 1);
  const R = segs(radialSegments, 3);
  const cols = R + 1;
  const halfH = h / 2;

  // Wall normal: perpendicular to the profile line, so it carries the taper.
  const dr = rb - rt;
  const slopeLen = Math.hypot(h, dr) || 1;
  const nRadial = h / slopeLen;
  const nY = (0 - dr) / slopeLen;

  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];

  const pushVertex = (
    px: number, py: number, pz: number,
    nx: number, ny: number, nz: number,
    u: number, v: number,
  ): number => {
    const i = pos.length / 3;
    pos.push(px, py, pz);
    nrm.push(nx, ny, nz);
    uv.push(u, v);
    return i;
  };

  // ── Wall: two rings, seam column duplicated.
  for (let iy = 0; iy < 2; iy++) {
    const ringR = iy === 0 ? rt : rb;
    const y = iy === 0 ? 0 - halfH : halfH;
    for (let ix = 0; ix < cols; ix++) {
      const u = ix / R;
      const phi = u * TAU;
      const cp = Math.cos(phi);
      const sp = Math.sin(phi);
      pushVertex(cp * ringR, y, sp * ringR, cp * nRadial, nY, sp * nRadial, u, iy);
    }
  }
  for (let ix = 0; ix < R; ix++) {
    pushRevolutionQuad(idx, ix, ix + 1, ix + cols + 1, ix + cols, rt === 0, rb === 0);
  }

  // ── Caps: a fan per end, its own centre vertex so the cap normal is flat.
  //    A degenerate end (radius 0 — a cone's apex) has no cap to draw.
  if (capped) {
    for (const end of [0, 1] as const) {
      const ringR = end === 0 ? rt : rb;
      if (ringR <= 0) continue;
      const y = end === 0 ? 0 - halfH : halfH;
      const ny = end === 0 ? -1 : 1;
      const centre = pushVertex(0, y, 0, 0, ny, 0, 0.5, 0.5);
      const ring: number[] = [];
      for (let ix = 0; ix < cols; ix++) {
        const phi = (ix / R) * TAU;
        const cp = Math.cos(phi);
        const sp = Math.sin(phi);
        ring.push(pushVertex(cp * ringR, y, sp * ringR, 0, ny, 0, 0.5 + cp * 0.5, 0.5 + sp * 0.5));
      }
      for (let ix = 0; ix < R; ix++) {
        const p0 = ring[ix]!;
        const p1 = ring[ix + 1]!;
        // −y cap winds one way, +y the other, so both face outward.
        if (end === 0) idx.push(centre, p0, p1);
        else idx.push(centre, p1, p0);
      }
    }
  }

  return {
    positions: Float32Array.from(pos),
    normals: Float32Array.from(nrm),
    uvs: Float32Array.from(uv),
    indices: Uint32Array.from(idx),
  };
}

/** Cone — the frustum with a zero top radius, apex at −y (up on screen). */
export function coneMesh(radius: number, height: number, radialSegments = 32, capped = true): PrimitiveGeometry {
  return cylinderMesh(0, radius, height, radialSegments, capped);
}

/**
 * Torus in the x/y plane (facing the default camera), tube swept about z.
 * `radius` is the ring radius (centre of the tube), `tube` the tube radius.
 * `radialSegments` divides the tube's cross-section; `tubularSegments` the
 * ring — the three.js naming, so a value copied from a reference matches.
 */
export function torusMesh(
  radius: number,
  tube: number,
  radialSegments = 16,
  tubularSegments = 48,
): PrimitiveGeometry {
  const R = positive(radius, 1);
  const t = positive(tube, R * 0.25);
  const RS = segs(radialSegments, 3);
  const TS = segs(tubularSegments, 3);
  const cols = RS + 1;
  const rows = TS + 1;
  const count = cols * rows;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);

  for (let j = 0; j < rows; j++) {
    const uu = j / TS;
    const u = uu * TAU;
    const cu = Math.cos(u);
    const su = Math.sin(u);
    for (let i = 0; i < cols; i++) {
      const vv = i / RS;
      const v = vv * TAU;
      const cv = Math.cos(v);
      const sv = Math.sin(v);
      const k = j * cols + i;
      positions[k * 3] = (R + t * cv) * cu;
      positions[k * 3 + 1] = (R + t * cv) * su;
      positions[k * 3 + 2] = t * sv;
      normals[k * 3] = cv * cu;
      normals[k * 3 + 1] = cv * su;
      normals[k * 3 + 2] = sv;
      uvs[k * 2] = uu;
      uvs[k * 2 + 1] = vv;
    }
  }

  const idx: number[] = [];
  for (let j = 0; j < TS; j++) {
    for (let i = 0; i < RS; i++) {
      const a = j * cols + i;
      const b = a + cols;      // +du (around the ring)
      const d = a + 1;         // +dv (around the tube)
      const c = b + 1;
      // cross(du, dv) is the outward normal here, so (a,b,d) and (b,c,d) wind
      // CCW from outside.
      idx.push(a, b, d, b, c, d);
    }
  }
  return { positions, normals, uvs, indices: Uint32Array.from(idx) };
}

/**
 * Axis-aligned box, FLAT shaded: each of the six faces owns its four vertices
 * so its normal is constant across the face and the edges stay crisp. Sharing
 * corners would average three perpendicular normals into a rounded blob.
 */
export function boxMesh(width: number, height: number, depth: number): PrimitiveGeometry {
  const hx = positive(width, 1) / 2;
  const hy = positive(height, 1) / 2;
  const hz = positive(depth, 1) / 2;

  // origin, tangent1, tangent2 — chosen so cross(t1, t2) is the outward normal
  // in this right-handed y-down basis.
  const faces: ReadonlyArray<{
    o: [number, number, number];
    t1: [number, number, number];
    t2: [number, number, number];
    n: [number, number, number];
  }> = [
    { o: [hx, -hy, -hz], t1: [0, 2 * hy, 0], t2: [0, 0, 2 * hz], n: [1, 0, 0] },
    { o: [-hx, -hy, -hz], t1: [0, 0, 2 * hz], t2: [0, 2 * hy, 0], n: [-1, 0, 0] },
    { o: [-hx, hy, -hz], t1: [0, 0, 2 * hz], t2: [2 * hx, 0, 0], n: [0, 1, 0] },
    { o: [-hx, -hy, -hz], t1: [2 * hx, 0, 0], t2: [0, 0, 2 * hz], n: [0, -1, 0] },
    { o: [-hx, -hy, hz], t1: [2 * hx, 0, 0], t2: [0, 2 * hy, 0], n: [0, 0, 1] },
    { o: [-hx, -hy, -hz], t1: [0, 2 * hy, 0], t2: [2 * hx, 0, 0], n: [0, 0, -1] },
  ];

  const positions = new Float32Array(24 * 3);
  const normals = new Float32Array(24 * 3);
  const uvs = new Float32Array(24 * 2);
  const indices = new Uint32Array(36);
  const CORNER_UV: ReadonlyArray<[number, number]> = [[0, 0], [1, 0], [1, 1], [0, 1]];

  faces.forEach((f, fi) => {
    const base = fi * 4;
    for (let c = 0; c < 4; c++) {
      // Quad order o, o+t1, o+t1+t2, o+t2 — see CORNER_UV.
      const a1 = c === 1 || c === 2 ? 1 : 0;
      const a2 = c === 2 || c === 3 ? 1 : 0;
      const i = base + c;
      positions[i * 3] = f.o[0] + f.t1[0] * a1 + f.t2[0] * a2;
      positions[i * 3 + 1] = f.o[1] + f.t1[1] * a1 + f.t2[1] * a2;
      positions[i * 3 + 2] = f.o[2] + f.t1[2] * a1 + f.t2[2] * a2;
      normals[i * 3] = f.n[0];
      normals[i * 3 + 1] = f.n[1];
      normals[i * 3 + 2] = f.n[2];
      uvs[i * 2] = CORNER_UV[c]![0];
      uvs[i * 2 + 1] = CORNER_UV[c]![1];
    }
    indices.set([base, base + 1, base + 2, base, base + 2, base + 3], fi * 6);
  });

  return { positions, normals, uvs, indices };
}

/**
 * Capsule: a cylinder of length `height` closed by two hemispheres of
 * `radius`. `height` is the CYLINDRICAL mid-section (three.js's convention),
 * so the total extent along y is `height + 2 * radius`; pass 0 for a sphere.
 *
 * Built as one continuous lat/long grid — the hemisphere rows and the two
 * cylinder rows share columns — so the tube joins the caps with no seam and
 * no duplicated ring to light differently.
 */
export function capsuleMesh(
  radius: number,
  height: number,
  radialSegments = 32,
  capSegments = 8,
): PrimitiveGeometry {
  const r = positive(radius, 1);
  const h = nonNegative(height, 0);
  const R = segs(radialSegments, 3);
  const C = segs(capSegments, 1);
  const cols = R + 1;
  const rows = 2 * (C + 1);
  const halfH = h / 2;
  const count = cols * rows;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);

  for (let iy = 0; iy < rows; iy++) {
    const top = iy <= C;
    const step = top ? iy : iy - (C + 1);
    // Top hemisphere sweeps theta 0 → π/2, bottom π/2 → π; the two rows at
    // π/2 are the cylinder's own rings, offset to ∓halfH.
    const theta = top
      ? (step / C) * (Math.PI / 2)
      : Math.PI / 2 + (step / C) * (Math.PI / 2);
    const sinT = Math.sin(theta);
    const cosT = Math.cos(theta);
    const centreY = top ? 0 - halfH : halfH;
    for (let ix = 0; ix < cols; ix++) {
      const u = ix / R;
      const phi = u * TAU;
      const nx = sinT * Math.cos(phi);
      const ny = 0 - cosT;
      const nz = sinT * Math.sin(phi);
      const i = iy * cols + ix;
      positions[i * 3] = nx * r;
      positions[i * 3 + 1] = centreY + ny * r;
      positions[i * 3 + 2] = nz * r;
      normals[i * 3] = nx;
      normals[i * 3 + 1] = ny;
      normals[i * 3 + 2] = nz;
      uvs[i * 2] = u;
      uvs[i * 2 + 1] = iy / (rows - 1);
    }
  }

  const idx: number[] = [];
  for (let iy = 0; iy < rows - 1; iy++) {
    for (let ix = 0; ix < R; ix++) {
      const a = iy * cols + ix;
      pushRevolutionQuad(idx, a, a + 1, a + cols + 1, a + cols, iy === 0, iy === rows - 2);
    }
  }
  return { positions, normals, uvs, indices: Uint32Array.from(idx) };
}

/**
 * Signed volume × 6 of a closed triangle mesh. Positive ⇔ every triangle winds
 * counter-clockwise seen from OUTSIDE, which is the one global statement that
 * catches a flipped quad anywhere in a generator.
 */
export function signedVolume6(geo: PrimitiveGeometry): number {
  const { positions, indices } = geo;
  let sum = 0;
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = indices[i]! * 3, b = indices[i + 1]! * 3, c = indices[i + 2]! * 3;
    const ax = positions[a]!, ay = positions[a + 1]!, az = positions[a + 2]!;
    const bx = positions[b]!, by = positions[b + 1]!, bz = positions[b + 2]!;
    const cx = positions[c]!, cy = positions[c + 1]!, cz = positions[c + 2]!;
    // a · (b × c)
    sum += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
  }
  return sum;
}
