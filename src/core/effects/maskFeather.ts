/**
 * Variable-width mask feather — AE's per-vertex feather, the tool for organic
 * matte blending that a single blur radius cannot express.
 *
 * A uniform feather is a Gaussian blur of the matte (`paintMaskMatte`), and
 * blur has ONE radius. Per-vertex feather needs the softness to vary along the
 * outline, so this renders the matte a different way entirely:
 *
 *   1. rasterize HARD coverage of the path (same Path2D the uniform painter
 *      fills, so the geometry cannot drift between the two renderers);
 *   2. a signed distance to the outline per pixel — two-pass 3-4 chamfer,
 *      integer weights, deterministic;
 *   3. the local feather width — the outline flattened to samples that carry
 *      their vertex-interpolated feather; each edge-band pixel takes the width
 *      of its NEAREST outline sample (grid-bucketed, so the band costs O(band)
 *      not O(band × outline));
 *   4. alpha = smoothstep of distance / local width, a ramp straddling the
 *      edge exactly where the blur's ramp sat — a vertex whose feather equals
 *      the path's uniform value renders closely to the blur it replaces.
 *
 * Pixels outside the band keep their hard coverage untouched, so the cost
 * scales with edge length × max feather, not with layer area.
 *
 * The distance/width/ramp core is pure (`computeVariableFeatherAlpha`) and
 * unit-tested without a canvas; `paintVariableFeatherPath` is the Canvas2D
 * wrapper `paintMaskMatte` calls for paths that opt in.
 */

import type { MaskPath } from './mask';
import { maskPathToPath2D, maskSegments } from './mask';

/** One outline sample: pixel-space position + local feather DIAMETER. */
export interface FeatherSample {
  x: number;
  y: number;
  /** Feather diameter at this point along the outline, px. */
  f: number;
}

/** True when any vertex carries its own feather — the opt-in for this path. */
export function hasVariableFeather(path: MaskPath): boolean {
  return path.points.some((p) => typeof p.feather === 'number');
}

/**
 * Flatten the outline to samples carrying vertex-interpolated feather.
 *
 * Segment `i` runs vertex `i` → `i+1`; feather lerps across it, matching how
 * every other per-vertex quantity (position, handles) interpolates. Uses the
 * SAME `maskSegments` the painters build their Path2D from, so the samples lie
 * on the exact painted outline — expansion included.
 */
export function featherSamples(path: MaskPath, stepsPerSegment = 12): FeatherSample[] {
  const segs = maskSegments(path);
  const n = path.points.length;
  if (segs.length === 0 || n === 0) return [];
  const base = path.feather;
  const featherAt = (i: number): number => {
    const v = path.points[i % n]?.feather;
    return typeof v === 'number' && v >= 0 ? v : base;
  };
  const out: FeatherSample[] = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    const f0 = featherAt(i);
    const f1 = featherAt(i + 1);
    for (let k = 0; k < stepsPerSegment; k++) {
      const t = k / stepsPerSegment;
      const mt = 1 - t;
      // Cubic bezier point.
      const x =
        mt * mt * mt * s.x0 + 3 * mt * mt * t * s.cx1 + 3 * mt * t * t * s.cx2 + t * t * t * s.x1;
      const y =
        mt * mt * mt * s.y0 + 3 * mt * mt * t * s.cy1 + 3 * mt * t * t * s.cy2 + t * t * t * s.y1;
      out.push({ x, y, f: f0 + (f1 - f0) * t });
    }
  }
  return out;
}

/**
 * The pure core: hard coverage in, feathered alpha out.
 *
 * `coverage` is one byte per pixel (0 or 255; anti-aliased values threshold at
 * 128 for the distance seed). `samples` are in the same pixel space. Returns a
 * new alpha buffer; pixels beyond the feather band are the input coverage
 * verbatim.
 */
export function computeVariableFeatherAlpha(
  coverage: Uint8ClampedArray | Uint8Array,
  w: number,
  h: number,
  samples: readonly FeatherSample[],
  maxFeather: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(coverage.length);
  out.set(coverage);
  if (w < 1 || h < 1 || samples.length === 0 || maxFeather <= 0) return out;

  // ── Signed distance, 3-4 chamfer (units of 1/3 px) ─────────────────
  // One transform over the BOUNDARY: dist 0 at pixels whose 4-neighbourhood
  // crosses coverage, +INF elsewhere; the sign comes from coverage itself.
  const INF = 0x3fffffff;
  const dist = new Int32Array(w * h).fill(INF);
  const inside = (i: number): boolean => coverage[i]! >= 128;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const c = inside(i);
      if (
        (x > 0 && inside(i - 1) !== c) ||
        (x < w - 1 && inside(i + 1) !== c) ||
        (y > 0 && inside(i - w) !== c) ||
        (y < h - 1 && inside(i + w) !== c)
      ) {
        dist[i] = 0;
      }
    }
  }
  // Forward pass.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let d = dist[i]!;
      if (x > 0) d = Math.min(d, dist[i - 1]! + 3);
      if (y > 0) {
        d = Math.min(d, dist[i - w]! + 3);
        if (x > 0) d = Math.min(d, dist[i - w - 1]! + 4);
        if (x < w - 1) d = Math.min(d, dist[i - w + 1]! + 4);
      }
      dist[i] = d;
    }
  }
  // Backward pass.
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let d = dist[i]!;
      if (x < w - 1) d = Math.min(d, dist[i + 1]! + 3);
      if (y < h - 1) {
        d = Math.min(d, dist[i + w]! + 3);
        if (x < w - 1) d = Math.min(d, dist[i + w + 1]! + 4);
        if (x > 0) d = Math.min(d, dist[i + w - 1]! + 4);
      }
      dist[i] = d;
    }
  }

  // ── Nearest-sample feather width, grid-bucketed ────────────────────
  const cell = Math.max(8, Math.ceil(maxFeather / 2));
  const gw = Math.max(1, Math.ceil(w / cell));
  const gh = Math.max(1, Math.ceil(h / cell));
  const buckets: number[][] = Array.from({ length: gw * gh }, () => []);
  for (let si = 0; si < samples.length; si++) {
    const s = samples[si]!;
    const bx = Math.min(gw - 1, Math.max(0, Math.floor(s.x / cell)));
    const by = Math.min(gh - 1, Math.max(0, Math.floor(s.y / cell)));
    buckets[by * gw + bx]!.push(si);
  }
  const nearestFeather = (x: number, y: number): number => {
    const bx = Math.min(gw - 1, Math.max(0, Math.floor(x / cell)));
    const by = Math.min(gh - 1, Math.max(0, Math.floor(y / cell)));
    // Expand cell rings outward; a nearer sample can hide one ring past the
    // first hit (ring distance is Chebyshev on cells, not Euclidean on px), so
    // scan exactly one ring beyond the ring that produced the first candidate.
    let best = -1;
    let bestD = Infinity;
    let firstHitRing = -1;
    const maxRing = Math.max(gw, gh);
    for (let ring = 0; ring < maxRing; ring++) {
      if (firstHitRing >= 0 && ring > firstHitRing + 1) break;
      for (let oy = -ring; oy <= ring; oy++) {
        for (let ox = -ring; ox <= ring; ox++) {
          if (Math.max(Math.abs(ox), Math.abs(oy)) !== ring) continue;
          const cx = bx + ox;
          const cy = by + oy;
          if (cx < 0 || cx >= gw || cy < 0 || cy >= gh) continue;
          for (const si of buckets[cy * gw + cx]!) {
            if (firstHitRing < 0) firstHitRing = ring;
            const s = samples[si]!;
            const d = (s.x - x) * (s.x - x) + (s.y - y) * (s.y - y);
            if (d < bestD) {
              bestD = d;
              best = si;
            }
          }
        }
      }
    }
    return best >= 0 ? samples[best]!.f : 0;
  };

  // ── The ramp ───────────────────────────────────────────────────────
  const band = maxFeather / 2 + 1.5;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const d = dist[i]! / 3; // px
      if (d > band) continue; // far from the edge — hard coverage stands
      const wf = nearestFeather(x, y);
      if (wf < 0.5) continue; // locally hard — keep the rasterized AA edge
      const signed = inside(i) ? d : -d;
      // 0 at −wf/2, 1 at +wf/2 — the ramp straddles the outline like the
      // blur's did, smoothstepped so the band's ends land with C1 continuity.
      const u = Math.max(0, Math.min(1, signed / wf + 0.5));
      out[i] = Math.round(u * u * (3 - 2 * u) * 255);
    }
  }
  return out;
}

/**
 * Canvas wrapper: rasterize hard coverage, run the core, paint the result into
 * the matte context with the path's own composite/opacity already set by
 * `paintMaskMatte`. Returns false when a scratch context is unavailable — the
 * caller then falls back to the uniform blur, softness intact if not variable.
 */
export function paintVariableFeatherPath(
  g: CanvasRenderingContext2D,
  path: MaskPath,
  w: number,
  h: number,
): boolean {
  const p2d = maskPathToPath2D(path, w, h);
  if (!p2d) return false;
  const scratch = document.createElement('canvas');
  scratch.width = w;
  scratch.height = h;
  const sc = scratch.getContext('2d', { willReadFrequently: true });
  if (!sc) return false;
  try {
    sc.translate(w / 2, h / 2);
    sc.fillStyle = '#fff';
    sc.fill(p2d, 'evenodd');
    const image = sc.getImageData(0, 0, w, h);
    // Coverage = the alpha channel of the hard fill.
    const coverage = new Uint8Array(w * h);
    for (let i = 0; i < coverage.length; i++) coverage[i] = image.data[i * 4 + 3]!;
    const samples = featherSamples(path).map((s) => ({ x: s.x + w / 2, y: s.y + h / 2, f: s.f }));
    const maxFeather = samples.reduce((m, s) => Math.max(m, s.f), path.feather);
    const alpha = computeVariableFeatherAlpha(coverage, w, h, samples, maxFeather);
    for (let i = 0; i < alpha.length; i++) {
      const o = i * 4;
      image.data[o] = image.data[o + 1] = image.data[o + 2] = 255;
      image.data[o + 3] = alpha[i]!;
    }
    sc.setTransform(1, 0, 0, 1, 0, 0);
    sc.clearRect(0, 0, w, h);
    sc.putImageData(image, 0, 0);
    g.drawImage(scratch, -w / 2, -h / 2);
    return true;
  } catch {
    return false;
  }
}
