/**
 * Plexus — point/line networks (the Rowbyte Plexus / Stardust class).
 *
 * Two homes for one renderer:
 *  · `drawPlexusLinks` connects ANY point set: every pair closer than
 *    `maxDistance` gets a line whose opacity falls with distance, and,
 *    optionally, every mutually-close triple a translucent triangle. The
 *    particle field calls it over its live sprites (a Particular-style
 *    "connect the particles"), the `plexus` effect over its own points.
 *  · The `plexus` EFFECT (Generate, Canvas2D-only like Lightning) draws a
 *    deterministic point cloud — `pointCount` points hashed into the layer
 *    box, each drifting on its own value-noise path as Evolution advances —
 *    or, with a mask path assigned, the path's vertices, so the network can
 *    follow a tracked object.
 *
 * Determinism: points come from `hash01u` (the u32 family the GPU noise
 * shares) and the drift from `vnoiseU`; the pair loop runs in index order
 * with a hard cap on the points considered (`PLEXUS_MAX_POINTS`), so the
 * same (params, time) is the same picture and the cost is bounded — a
 * network is O(n²) in its points, which is why the cap exists rather than a
 * spatial hash: at these counts the hash would cost more than it saves.
 */

import { effectNumber, effectParam, paramsOf, type Effect } from './effects';
import { hash01u, vnoiseU } from './noiseHash';

/** Points beyond this are not linked — the O(n²) guard. */
export const PLEXUS_MAX_POINTS = 700;

export interface PlexusLinkOptions {
  /** Link two points closer than this, px. */
  maxDistance: number;
  lineWidth: number;
  /** Opacity of a zero-length link; a link at maxDistance is invisible. */
  lineOpacity: number;
  /** `#rrggbb`. */
  color: string;
  triangles: boolean;
  triangleOpacity: number;
}

function hexRgb(hex: string): [number, number, number] {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const v = Number.parseInt(h.slice(0, 6), 16);
  return Number.isFinite(v) ? [(v >> 16) & 255, (v >> 8) & 255, v & 255] : [255, 255, 255];
}

/**
 * The links of a point set: index pairs with their distance-weighted opacity,
 * and the mutually-close triples. Pure, so it is what the tests measure and
 * what the painter draws.
 */
export function plexusLinks(
  pts: ReadonlyArray<{ x: number; y: number }>,
  maxDistance: number,
  triangles: boolean,
): { lines: Array<[number, number, number]>; tris: Array<[number, number, number]> } {
  const n = Math.min(pts.length, PLEXUS_MAX_POINTS);
  const d2max = maxDistance * maxDistance;
  const lines: Array<[number, number, number]> = [];
  const tris: Array<[number, number, number]> = [];
  if (!(maxDistance > 0)) return { lines, tris };
  // Adjacency by index, only the pairs that link — triangles read it.
  const near: number[][] = triangles ? Array.from({ length: n }, () => []) : [];
  for (let i = 0; i < n; i++) {
    const a = pts[i]!;
    for (let j = i + 1; j < n; j++) {
      const b = pts[j]!;
      const dx = b.x - a.x; const dy = b.y - a.y;
      const d2 = dx * dx + dy * dy;
      if (d2 >= d2max) continue;
      lines.push([i, j, 1 - Math.sqrt(d2) / maxDistance]);
      if (triangles) near[i]!.push(j);
    }
  }
  if (triangles) {
    for (let i = 0; i < n; i++) {
      const ni = near[i]!;
      for (let p = 0; p < ni.length; p++) {
        const j = ni[p]!;
        const nj = near[j]!;
        for (let q = p + 1; q < ni.length; q++) {
          const k = ni[q]!;
          // j < k always (both came from i's ascending list), so k ∈ near[j] is the third edge.
          if (nj.includes(k)) tris.push([i, j, k]);
        }
      }
    }
  }
  return { lines, tris };
}

/** Paint the network of `pts` (already in the context's pixel space). */
export function drawPlexusLinks(
  ctx: CanvasRenderingContext2D,
  pts: ReadonlyArray<{ x: number; y: number }>,
  o: PlexusLinkOptions,
): void {
  const { lines, tris } = plexusLinks(pts, o.maxDistance, o.triangles);
  const [r, g, b] = hexRgb(o.color);
  if (o.triangles && o.triangleOpacity > 0) {
    for (const [i, j, k] of tris) {
      const a = pts[i]!; const c = pts[j]!; const d = pts[k]!;
      // A triangle is as faint as its longest edge's link.
      const w = Math.min(
        1 - Math.hypot(c.x - a.x, c.y - a.y) / o.maxDistance,
        1 - Math.hypot(d.x - a.x, d.y - a.y) / o.maxDistance,
        1 - Math.hypot(d.x - c.x, d.y - c.y) / o.maxDistance,
      );
      ctx.fillStyle = `rgba(${r},${g},${b},${Math.max(0, w) * o.triangleOpacity})`;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y); ctx.lineTo(c.x, c.y); ctx.lineTo(d.x, d.y);
      ctx.closePath();
      ctx.fill();
    }
  }
  if (o.lineOpacity > 0 && o.lineWidth > 0) {
    ctx.lineWidth = o.lineWidth;
    ctx.lineCap = 'round';
    for (const [i, j, w] of lines) {
      const a = pts[i]!; const c = pts[j]!;
      ctx.strokeStyle = `rgba(${r},${g},${b},${w * o.lineOpacity})`;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y); ctx.lineTo(c.x, c.y);
      ctx.stroke();
    }
  }
}

// ── The effect ───────────────────────────────────────────────────────────────

export interface PlexusCloudSettings {
  pointCount: number;
  /** 0..1 of the layer box the cloud spans, centred. */
  spread: number;
  /** Drift radius, px. */
  drift: number;
  evolution: number;
  seed: number;
}

/**
 * The effect's own point cloud in layer px (top-left origin): each point
 * hashed into the spread box, then displaced by two value-noise channels
 * sampled along Evolution — a closed form in (index, evolution), so scrubbing
 * is free and two renders at one Evolution are identical.
 */
export function plexusPointCloud(w: number, h: number, s: PlexusCloudSettings): Array<{ x: number; y: number }> {
  const n = Math.max(0, Math.min(PLEXUS_MAX_POINTS, Math.floor(s.pointCount)));
  const sw = w * s.spread; const sh = h * s.spread;
  const x0 = (w - sw) / 2; const y0 = (h - sh) / 2;
  const out: Array<{ x: number; y: number }> = [];
  const ev = s.evolution * 0.05;
  for (let i = 0; i < n; i++) {
    const bx = x0 + hash01u(i, 1, s.seed) * sw;
    const by = y0 + hash01u(i, 2, s.seed) * sh;
    const dx = (vnoiseU(ev + i * 7.13, 0.5, s.seed + 11) * 2 - 1) * s.drift;
    const dy = (vnoiseU(ev + i * 7.13, 9.5, s.seed + 23) * 2 - 1) * s.drift;
    out.push({ x: bx + dx, y: by + dy });
  }
  return out;
}

const COMPOSITE: Record<number, GlobalCompositeOperation> = { 0: 'source-over', 1: 'lighter', 2: 'screen', 3: 'multiply', 4: 'source-atop' };

/** The `plexus` effect's Canvas2D pass. */
/**
 * A float16 2D canvas the size of the effect, or null where the browser has
 * none (jsdom, Chromium before `colorType` landed).
 *
 * Why plexus needs it: a triangle mesh is hundreds of faint primitives stacked
 * on each other, each blended into the destination. On an 8-bit canvas every
 * blend rounds, and the error compounds: filling black 30× with
 * rgba(159,208,255,0.004) gives 30 on Chromium 128, 1 on Chromium 140+, and
 * ~18 is correct. The golden `effect-plexus` went from passing to 37 %
 * divergent on the Electron 32 → 44 upgrade for exactly this reason — neither
 * reference was right. Blending in float16 and rounding once gives 18,23,28.
 */
function floatScratch(w: number, h: number): { canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D } | null {
  if (typeof OffscreenCanvas === 'undefined' || w <= 0 || h <= 0) return null;
  try {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d', { colorType: 'float16' } as CanvasRenderingContext2DSettings) as OffscreenCanvasRenderingContext2D | null;
    if (!ctx) return null;
    const attrs = (ctx as unknown as { getContextAttributes?: () => { colorType?: string } }).getContextAttributes?.();
    if (attrs?.colorType !== 'float16') return null;
    return { canvas, ctx };
  } catch {
    return null;
  }
}

export function drawPlexus(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  // Blend in float, round once (see floatScratch). The destination is copied
  // in first and the chosen composite op still applies per primitive, so every
  // blend mode means exactly what it did — only the rounding moves to the end.
  const scratch = floatScratch(w, h);
  if (!scratch) {
    drawPlexusInto(oc, w, h, e);
    return;
  }
  const { canvas, ctx } = scratch;
  ctx.drawImage(oc.canvas as CanvasImageSource, 0, 0);
  drawPlexusInto(ctx as unknown as CanvasRenderingContext2D, w, h, e);
  const prevOp = oc.globalCompositeOperation;
  oc.save();
  oc.setTransform(1, 0, 0, 1, 0, 0);
  oc.globalCompositeOperation = 'copy';
  oc.drawImage(canvas, 0, 0);
  oc.restore();
  oc.globalCompositeOperation = prevOp;
}

function drawPlexusInto(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  const n = (k: string): number => effectNumber(e, k);
  const opacity = Math.max(0, Math.min(1, n('opacity') / 100));
  if (opacity <= 0) return;
  // A resolved mask-path polyline (centred px) is the point set; otherwise the cloud.
  const flat = paramsOf(e).pathPoints;
  let pts: Array<{ x: number; y: number }>;
  if (Array.isArray(flat) && flat.length >= 4) {
    pts = [];
    // The polyline samples 16 points per segment; every `pathStep`-th keeps a
    // network readable on a dense outline rather than a solid rope.
    const step = Math.max(1, Math.round(n('pathStep')));
    for (let i = 0, k = 0; i + 1 < flat.length; i += 2, k++) {
      const x = flat[i]; const y = flat[i + 1];
      if (typeof x !== 'number' || typeof y !== 'number' || x >= 1e9) continue;
      if (k % step === 0) pts.push({ x: w / 2 + x, y: h / 2 + y });
    }
  } else {
    pts = plexusPointCloud(w, h, {
      pointCount: n('pointCount'),
      spread: Math.max(0, Math.min(1, n('spread') / 100)),
      drift: Math.max(0, n('drift')),
      evolution: n('evolution'),
      seed: Math.round(n('seed')),
    });
  }
  const prev = oc.globalCompositeOperation;
  oc.globalCompositeOperation = COMPOSITE[Math.round(n('composite'))] ?? 'source-over';
  try {
    oc.save();
    oc.setTransform(1, 0, 0, 1, 0, 0);
    drawPlexusLinks(oc, pts, {
      maxDistance: Math.max(0, n('maxDistance')),
      lineWidth: Math.max(0, n('lineWidth')),
      lineOpacity: Math.max(0, Math.min(1, n('lineOpacity') / 100)) * opacity,
      color: String(effectParam(e, 'lineColor') ?? '#9fd0ff'),
      triangles: effectParam(e, 'triangles') === true,
      triangleOpacity: Math.max(0, Math.min(1, n('triangleOpacity') / 100)) * opacity,
    });
    const ps = Math.max(0, n('pointSize'));
    if (ps > 0) {
      const [r, g, b] = hexRgb(String(effectParam(e, 'pointColor') ?? '#ffffff'));
      oc.fillStyle = `rgba(${r},${g},${b},${opacity})`;
      for (const p of pts) {
        oc.beginPath();
        oc.arc(p.x, p.y, ps / 2, 0, Math.PI * 2);
        oc.fill();
      }
    }
    oc.restore();
  } finally {
    oc.globalCompositeOperation = prev;
  }
}
