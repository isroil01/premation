/**
 * "I added puppet pins to a PNG character and moving a pin tears the image."
 *
 * A synthetic character bitmap — torso blob plus a thin arm — is meshed exactly
 * the way the app meshes an image layer (alpha coverage mask → `buildRestMesh`),
 * a hand pin is dragged 40px, and the result is held to the four properties a
 * puppet deformation must have:
 *
 *   a) no triangle flips its winding — a flip IS the visible shatter;
 *   b) the hand travels the full drag while the torso stays put, with a smooth
 *      falloff along the arm between them (AE: pin a hand, the arm bends);
 *   c) UVs are untouched, so the texture cannot slide across the mesh;
 *   d) the mesh follows the silhouette instead of the transparent bounding box.
 *
 * The grid mode is measured in the same terms, because it is the mode every
 * pre-existing document is stored in and it must not regress. It is also why
 * the bug was reported: a lattice over the bounding box drags a SQUARE
 * neighbourhood, so a hand pin pulls the torso with it.
 */

import {
  buildRestMesh,
  coverageMaskFromImageData,
  deform,
  silhouetteFromCoverage,
  type DeformPin,
  type DeformedMesh,
  type PuppetPin,
  type PuppetRig,
} from './puppet';
import { alphaOutlineRegions, densityToSpacing } from './alphaMesh';

const W = 200;
const H = 200;
const DRAG = 40;

/** Body blob + thin arm, in IMAGE pixel coordinates (origin top-left). */
function characterAlpha(x: number, y: number): number {
  if (x >= 60 && x < 140 && y >= 40 && y < 170) return 255; // torso
  if (x >= 140 && x < 190 && y >= 70 && y < 82) return 255; // thin arm
  return 0;
}

function makeBitmap(): { data: Uint8ClampedArray; width: number; height: number } {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      data[i] = 255;
      data[i + 1] = 200;
      data[i + 2] = 180;
      data[i + 3] = characterAlpha(x, y);
    }
  }
  return { data, width: W, height: H };
}

/** image px → layer-local (centred) coords, the space pins and the mesh live in. */
const lx = (px: number): number => px - W / 2;
const ly = (py: number): number => py - H / 2;

const BODY = { id: 'body', x: lx(100), y: ly(120) };
const HAND = { id: 'hand', x: lx(182), y: ly(76) };

const mask = coverageMaskFromImageData(makeBitmap(), { maxSamples: 64, alphaThreshold: 12 });

function rigFor(meshMode: PuppetRig['meshMode'], density = 22, expansion = 0): PuppetRig {
  const pins: PuppetPin[] = [
    { id: BODY.id, name: 'Body', x: BODY.x, y: BODY.y },
    { id: HAND.id, name: 'Hand', x: HAND.x, y: HAND.y },
  ];
  return { pins, meshDensity: density, meshExpansion: expansion, meshMode, solver: 'arap' };
}

function meshFor(meshMode: PuppetRig['meshMode'], density = 22, expansion = 0): DeformedMesh {
  return buildRestMesh(W, H, 0, rigFor(meshMode, density, expansion), undefined, mask);
}

/** Live pins with the hand dragged `dy` px down. */
function draggedPins(dy = DRAG): DeformPin[] {
  return [
    { id: BODY.id, x: BODY.x, y: BODY.y },
    { id: HAND.id, x: HAND.x, y: HAND.y + dy },
  ];
}

function signedArea(v: Float32Array, a: number, b: number, c: number): number {
  return (
    (v[b * 4]! - v[a * 4]!) * (v[c * 4 + 1]! - v[a * 4 + 1]!) -
    (v[c * 4]! - v[a * 4]!) * (v[b * 4 + 1]! - v[a * 4 + 1]!)
  ) / 2;
}

/** Triangles whose winding reverses between rest and deformed. */
function flippedTriangles(mesh: DeformedMesh, out: Float32Array): number {
  let flipped = 0;
  for (let t = 0; t < mesh.triangles.length; t += 3) {
    const a = mesh.triangles[t]!;
    const b = mesh.triangles[t + 1]!;
    const c = mesh.triangles[t + 2]!;
    const rest = signedArea(mesh.vertices, a, b, c);
    if (Math.abs(rest) < 1e-6) continue; // degenerate at rest — checked separately
    if (Math.sign(rest) !== Math.sign(signedArea(out, a, b, c))) flipped++;
  }
  return flipped;
}

/** Largest displacement among vertices inside `box` (local coords). */
function maxMoveIn(
  mesh: DeformedMesh,
  out: Float32Array,
  box: { x0: number; x1: number; y0: number; y1: number },
): number {
  let max = 0;
  for (let i = 0; i < mesh.vertices.length / 4; i++) {
    const x = mesh.vertices[i * 4]!;
    const y = mesh.vertices[i * 4 + 1]!;
    if (x < box.x0 || x > box.x1 || y < box.y0 || y > box.y1) continue;
    max = Math.max(max, Math.hypot(out[i * 4]! - x, out[i * 4 + 1]! - y));
  }
  return max;
}

/** Mean displacement among vertices inside `box`, or NaN when the box is empty. */
function meanMoveIn(
  mesh: DeformedMesh,
  out: Float32Array,
  box: { x0: number; x1: number; y0: number; y1: number },
): number {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < mesh.vertices.length / 4; i++) {
    const x = mesh.vertices[i * 4]!;
    const y = mesh.vertices[i * 4 + 1]!;
    if (x < box.x0 || x > box.x1 || y < box.y0 || y > box.y1) continue;
    sum += Math.hypot(out[i * 4]! - x, out[i * 4 + 1]! - y);
    count++;
  }
  return count === 0 ? NaN : sum / count;
}

/** Torso, well clear of the shoulder. */
const TORSO = { x0: lx(62), x1: lx(110), y0: ly(100), y1: ly(168) };
/** The outer third of the arm. */
const HAND_BAND = { x0: lx(170), x1: lx(195), y0: ly(60), y1: ly(95) };
/** Mid-arm, between shoulder and hand. */
const MID_ARM = { x0: lx(150), x1: lx(168), y0: ly(60), y1: ly(95) };

describe('puppet mesh for a PNG character (outline mode)', () => {
  it('meshes the artwork, not the bounding box', () => {
    const mesh = meshFor('silhouette');
    const n = mesh.vertices.length / 4;
    expect(n).toBeGreaterThan(20);

    // (d) every vertex sits on (or within a cell of) the artwork, and nothing
    // lives in the big empty rectangle below the arm / right of the torso.
    // A vertex may overhang the drawn pixels by the coverage mask's own
    // quantisation (one cell) plus the outline simplification tolerance (half a
    // cell) — call it two cells — but never by more. That overhang is the reason
    // Mesh Expansion exists; what must not happen is the vertex landing out in
    // the transparent bounding box, which the second check below pins down.
    const cell = 2 * Math.ceil(W / mask.cols);
    let offArtwork = 0;
    for (let i = 0; i < n; i++) {
      const px = Math.round(mesh.vertices[i * 4]! + W / 2);
      const py = Math.round(mesh.vertices[i * 4 + 1]! + H / 2);
      let near = false;
      for (let dy = -cell; dy <= cell && !near; dy++) {
        for (let dx = -cell; dx <= cell; dx++) {
          if (characterAlpha(px + dx, py + dy) > 0) { near = true; break; }
        }
      }
      if (!near) offArtwork++;
    }
    expect(offArtwork).toBe(0);

    // The empty region right of the torso and below the arm holds nothing.
    let inEmptyRegion = 0;
    for (let i = 0; i < n; i++) {
      const px = mesh.vertices[i * 4]! + W / 2;
      const py = mesh.vertices[i * 4 + 1]! + H / 2;
      if (px > 145 && py > 95) inEmptyRegion++;
    }
    expect(inEmptyRegion).toBe(0);
  });

  it('(a) no triangle flips its winding, for a drag OR a fold', () => {
    const mesh = meshFor('silhouette');
    expect(flippedTriangles(mesh, deform(draggedPins(), mesh, 'arap'))).toBe(0);
    // Fold the arm back over the shoulder — the hardest case for a 2D solver.
    const folded: DeformPin[] = [
      { id: BODY.id, x: BODY.x, y: BODY.y },
      { id: HAND.id, x: lx(150), y: ly(30) },
    ];
    expect(flippedTriangles(mesh, deform(folded, mesh, 'arap'))).toBe(0);
  });

  it('(a) no degenerate triangles at rest', () => {
    const mesh = meshFor('silhouette');
    const spacing = densityToSpacing(W, H, 22);
    let degenerate = 0;
    for (let t = 0; t < mesh.triangles.length; t += 3) {
      const area = Math.abs(
        signedArea(mesh.vertices, mesh.triangles[t]!, mesh.triangles[t + 1]!, mesh.triangles[t + 2]!),
      );
      if (area < spacing * spacing * 1e-3) degenerate++;
    }
    expect(degenerate).toBe(0);
  });

  it('(b) the hand travels the full drag and the torso stays put', () => {
    const mesh = meshFor('silhouette');
    const out = deform(draggedPins(), mesh, 'arap');

    const handIdx = mesh.pinVertexIndices[HAND.id]!;
    const handMove = Math.hypot(
      out[handIdx * 4]! - mesh.vertices[handIdx * 4]!,
      out[handIdx * 4 + 1]! - mesh.vertices[handIdx * 4 + 1]!,
    );
    expect(handMove).toBeGreaterThan(DRAG - 0.5);
    expect(maxMoveIn(mesh, out, TORSO)).toBeLessThan(2);
  });

  it('(b) the arm BENDS — displacement falls off along the limb', () => {
    const mesh = meshFor('silhouette');
    const out = deform(draggedPins(), mesh, 'arap');
    const hand = meanMoveIn(mesh, out, HAND_BAND);
    const mid = meanMoveIn(mesh, out, MID_ARM);
    const torso = meanMoveIn(mesh, out, TORSO);
    expect(hand).toBeGreaterThan(DRAG * 0.85);
    // Mid-arm follows, but not rigidly: that gradient IS the bend.
    expect(mid).toBeLessThan(hand * 0.9);
    expect(mid).toBeGreaterThan(torso * 2);
    expect(torso).toBeLessThan(2);
  });

  it('(c) UVs are untouched by the deformation', () => {
    const mesh = meshFor('silhouette');
    const out = deform(draggedPins(), mesh, 'arap');
    for (let i = 0; i < mesh.vertices.length; i += 4) {
      expect(out[i + 2]).toBe(mesh.vertices[i + 2]);
      expect(out[i + 3]).toBe(mesh.vertices[i + 3]);
    }
  });

  it('solves from REST every frame — no accumulation, no drift', () => {
    const mesh = meshFor('silhouette');
    // Pins at their authored positions ⇒ the rest mesh, exactly.
    const identity = deform(
      [{ id: BODY.id, x: BODY.x, y: BODY.y }, { id: HAND.id, x: HAND.x, y: HAND.y }],
      mesh,
      'arap',
    );
    for (let i = 0; i < mesh.vertices.length; i++) {
      expect(identity[i]).toBeCloseTo(mesh.vertices[i]!, 4);
    }
    // Re-solving the same drag is bit-identical however many solves precede it.
    const a = deform(draggedPins(), mesh, 'arap');
    deform(draggedPins(17), mesh, 'arap');
    const b = deform(draggedPins(), mesh, 'arap');
    expect(Array.from(b)).toEqual(Array.from(a));
  });

  it('is deterministic: same mask + settings → bit-identical mesh', () => {
    const a = buildRestMesh(W, H, 0, rigFor('silhouette'), undefined, mask);
    const b = buildRestMesh(W, H, 0, rigFor('silhouette'), undefined, mask);
    expect(Array.from(b.vertices)).toEqual(Array.from(a.vertices));
    expect(Array.from(b.triangles)).toEqual(Array.from(a.triangles));
  });

  it('beats the grid at holding the torso still', () => {
    const outline = meshFor('silhouette');
    const grid = meshFor('grid');
    const bboxRig = rigFor('grid');
    const bbox = buildRestMesh(W, H, 0, bboxRig, undefined, undefined);

    const move = (m: DeformedMesh): number => maxMoveIn(m, deform(draggedPins(), m, 'arap'), TORSO);
    const outlineMove = move(outline);
    const gridMove = move(grid);
    const bboxMove = move(bbox);
    // Documented ordering: bbox grid (~11.9px) worse than alpha-culled grid
    // (~4.1px) worse than the outline mesh (~1.4px), per 40px of hand travel.
    expect(outlineMove).toBeLessThan(gridMove);
    expect(gridMove).toBeLessThan(bboxMove);
  });

  it('Mesh Expansion grows the mesh past the artwork', () => {
    const tight = meshFor('silhouette', 22, 0);
    const grown = meshFor('silhouette', 22, 8);
    const extentX = (m: DeformedMesh): number => {
      let max = -Infinity;
      for (let i = 0; i < m.vertices.length; i += 4) max = Math.max(max, m.vertices[i]!);
      return max;
    };
    expect(extentX(grown)).toBeGreaterThan(extentX(tight) + 4);
    // Still no self-intersection introduced by the offset.
    expect(flippedTriangles(grown, deform(draggedPins(), grown, 'arap'))).toBe(0);
  });

  it('density controls triangle count monotonically', () => {
    const counts = [8, 16, 24, 32].map((d) => meshFor('silhouette', d).triangles.length / 3);
    for (let i = 1; i < counts.length; i++) expect(counts[i]!).toBeGreaterThan(counts[i - 1]!);
  });

  it('binds the drag to the pin\'s OWN vertex when the weight column saturates', () => {
    // Beyond a pin near a limb tip the harmonic solve saturates to 1 for a whole
    // cluster of vertices, so "argmax of the weight column" no longer names one
    // vertex. ARAP must then constrain the vertex `finishRestMesh` bound the pin
    // to, not whichever tied vertex is compacted first — otherwise the artwork
    // slides out from under the handle (measured: 37.3px of a 40px drag).
    const mesh = meshFor('silhouette');
    const col = mesh.weights[HAND.id]!;
    const n = mesh.vertices.length / 4;
    let max = -Infinity;
    for (let i = 0; i < n; i++) if (col[i]! > max) max = col[i]!;
    let ties = 0;
    for (let i = 0; i < n; i++) if (col[i]! === max) ties++;
    expect(ties).toBeGreaterThan(1); // the degenerate case really does occur here

    const bound = mesh.pinVertexIndices[HAND.id]!;
    const out = deform(draggedPins(), mesh, 'arap');
    expect(out[bound * 4]! - mesh.vertices[bound * 4]!).toBeCloseTo(0, 6);
    expect(out[bound * 4 + 1]! - mesh.vertices[bound * 4 + 1]!).toBeCloseTo(DRAG, 6);
  });

  it('grid rigs keep a unique argmax, so the tie-break changes nothing there', () => {
    // The golden render scenes are grid rigs on a 240x60 bar. If their weight
    // columns ever start saturating, the tie-break above stops being a no-op for
    // them and their goldens move — this is the tripwire for that.
    const grid = buildRestMesh(240, 60, 0, {
      meshDensity: 12,
      meshExpansion: 0,
      pins: [
        { id: 'a', name: 'a', x: -100, y: 0 },
        { id: 'b', name: 'b', x: 100, y: 0 },
      ],
    });
    const n = grid.vertices.length / 4;
    for (const id of ['a', 'b']) {
      const col = grid.weights[id]!;
      let max = -Infinity;
      for (let i = 0; i < n; i++) if (col[i]! > max) max = col[i]!;
      let ties = 0;
      for (let i = 0; i < n; i++) if (col[i]! === max) ties++;
      expect(ties).toBe(1);
    }
  });

  it('falls back to the grid when there is nothing to trace', () => {
    const empty = coverageMaskFromImageData(
      { data: new Uint8ClampedArray(16 * 16 * 4), width: 16, height: 16 },
      { maxSamples: 16 },
    );
    const mesh = buildRestMesh(W, H, 0, rigFor('silhouette'), undefined, empty);
    // Grid fallback: a full (density+1)² bbox lattice, not an outline mesh.
    expect(mesh.vertices.length / 4).toBe(23 * 23);
  });
});

describe('alpha outline tracing', () => {
  it('finds one region for a connected character', () => {
    const regions = alphaOutlineRegions(mask, W, H, 0);
    expect(regions).toHaveLength(1);
    expect(regions[0]!.holes).toHaveLength(0);
    // The staircase of 64×64 coverage cells collapses to a handful of real
    // edges — this is what stops ear clipping from producing slivers.
    expect(regions[0]!.outer.length).toBeLessThan(24);
  });

  it('finds holes', () => {
    const donut = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const r = Math.hypot(x - 100, y - 100);
        donut[(y * W + x) * 4 + 3] = r < 80 && r > 30 ? 255 : 0;
      }
    }
    const m = coverageMaskFromImageData({ data: donut, width: W, height: H });
    const regions = alphaOutlineRegions(m, W, H, 0);
    expect(regions).toHaveLength(1);
    expect(regions[0]!.holes).toHaveLength(1);

    // And the mesh keeps the hole open.
    const rig: PuppetRig = {
      pins: [{ id: 'p', name: 'P', x: 0, y: -55 }, { id: 'q', name: 'Q', x: 0, y: 55 }],
      meshDensity: 22,
      meshExpansion: 0,
      meshMode: 'silhouette',
      solver: 'arap',
    };
    const mesh = buildRestMesh(W, H, 0, rig, undefined, m);
    for (let i = 0; i < mesh.vertices.length; i += 4) {
      expect(Math.hypot(mesh.vertices[i]!, mesh.vertices[i + 1]!)).toBeGreaterThan(24);
    }
  });

  it('the OLD raw-staircase outline is what tore — kept as the counter-example', () => {
    // `silhouetteFromCoverage` hands the un-simplified cell-corner staircase to
    // ear clipping. Feeding it through the silhouette path reproduces the bug
    // report: the mesh shatters. It is not reachable from the app (image layers
    // never resolve a path silhouette) and this asserts WHY it must not be.
    const raw = silhouetteFromCoverage(mask, W, H)!;
    expect(raw.points.length).toBeGreaterThan(100); // staircase, not an outline
    const rig = rigFor('silhouette');
    const torn = buildRestMesh(W, H, 0, rig, raw, mask);
    expect(flippedTriangles(torn, deform(draggedPins(), torn, 'arap'))).toBeGreaterThan(10);

    // The traced-and-simplified outline in the same conditions: no flips.
    const good = meshFor('silhouette');
    expect(flippedTriangles(good, deform(draggedPins(), good, 'arap'))).toBe(0);
  });
});
