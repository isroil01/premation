/**
 * Data tracks — keyframes whose values are NOT single numbers.
 *
 * The scalar engine (`interpolate.ts`) stays untouched: these tracks carry
 * typed values with per-kind interpolation and live beside the number tracks
 * in the AnimationEngine. Kinds:
 *
 *   • `text`          — strings. HOLD interpolation, exactly like AE's Source
 *                       Text keyframes (a string cannot tween).
 *   • `points`        — vector outlines (mask/shape paths): arrays of anchor
 *                       points with optional bezier handles. Pairwise-lerped;
 *                       a vertex-count mismatch snaps (holds) — morphing
 *                       mismatched outlines needs correspondence we don't have.
 *   • `gradientStops` — gradient stop lists ({ pos, color }). Pairwise lerp of
 *                       position and RGBA; count mismatch snaps.
 */

export type DataKind = 'text' | 'points' | 'gradientStops' | 'number';

export interface DataPoint {
  x: number;
  y: number;
  inX?: number;
  inY?: number;
  outX?: number;
  outY?: number;
}

export interface GradientStop {
  /** 0..1 position along the gradient axis. */
  pos: number;
  /** CSS color (#rgb, #rrggbb, #rrggbbaa or rgba()). */
  color: string;
}

export type DataValue = string | DataPoint[] | GradientStop[] | number;

export interface DataKeyframe {
  t: number;
  value: DataValue;
}

export interface DataTrack {
  nodeId: string;
  prop: string;
  kind: DataKind;
  /** Sorted by t ascending. */
  keyframes: DataKeyframe[];
}

/** Insert/replace a keyframe keeping the array sorted by t. */
export function upsertDataKeyframe(keyframes: DataKeyframe[], kf: DataKeyframe): DataKeyframe[] {
  const without = keyframes.filter((k) => k.t !== kf.t);
  without.push(kf);
  without.sort((a, b) => a.t - b.t);
  return without;
}

// ── Color helpers (self-contained; no DOM) ─────────────────────────

function parseColor(c: string): [number, number, number, number] {
  const s = c.trim();
  if (s.startsWith('#')) {
    const hex = s.slice(1);
    const n = (i: number, len: number): number => parseInt(hex.slice(i, i + len).padEnd(2, hex[i] ?? '0'), 16);
    if (hex.length === 3 || hex.length === 4) {
      const r = parseInt(hex[0]! + hex[0]!, 16);
      const g = parseInt(hex[1]! + hex[1]!, 16);
      const b = parseInt(hex[2]! + hex[2]!, 16);
      const a = hex.length === 4 ? parseInt(hex[3]! + hex[3]!, 16) / 255 : 1;
      return [r, g, b, a];
    }
    if (hex.length === 6 || hex.length === 8) {
      return [n(0, 2), n(2, 2), n(4, 2), hex.length === 8 ? n(6, 2) / 255 : 1];
    }
    return [0, 0, 0, 1];
  }
  const m = s.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)/i);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] !== undefined ? Number(m[4]) : 1];
  return [0, 0, 0, 1];
}

function toColor([r, g, b, a]: [number, number, number, number]): string {
  const h = (v: number): string => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');
  const base = `#${h(r)}${h(g)}${h(b)}`;
  return a >= 1 ? base : `${base}${h(a * 255)}`;
}

function lerp(a: number, b: number, u: number): number {
  return a + (b - a) * u;
}

function lerpColor(a: string, b: string, u: number): string {
  const ca = parseColor(a);
  const cb = parseColor(b);
  return toColor([lerp(ca[0], cb[0], u), lerp(ca[1], cb[1], u), lerp(ca[2], cb[2], u), lerp(ca[3], cb[3], u)]);
}

// ── Per-kind interpolation ─────────────────────────────────────────

// ── Outline count-matching (free-count morph) ──────────────────────
//
// To morph two outlines with different vertex counts we bring the shorter one
// up to the longer count by SUBDIVIDING its segments. Subdivision uses exact
// cubic de Casteljau splitting, so the outline's shape is preserved to the
// pixel — only the vertex *count* changes. Handles are absolute coordinates,
// matching the renderer (`ctx.bezierCurveTo(curr.outX, curr.outY, next.inX,
// next.inY, next.x, next.y)` in Canvas2DBackend / AppTextureProvider).
//
// What this does NOT solve: vertex *correspondence*. Index i on outline A is
// paired with index i on B; if their feature ordering differs the morph can
// twist. Minimal-distortion correspondence is a hard problem the engine still
// punts on — this only guarantees a smooth, shape-preserving, count-stable
// tween, which is what baked path animation and shape-to-shape morphs need.

/** A point's outgoing control coordinate (absolute), defaulting to the vertex. */
function outC(p: DataPoint): { x: number; y: number } {
  return { x: p.outX ?? p.x, y: p.outY ?? p.y };
}
/** A point's incoming control coordinate (absolute), defaulting to the vertex. */
function inC(p: DataPoint): { x: number; y: number } {
  return { x: p.inX ?? p.x, y: p.inY ?? p.y };
}
function mid(a: { x: number; y: number }, b: { x: number; y: number }, t: number) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/**
 * Split the cubic segment between `p0` and `p1` at parameter `t`, returning the
 * updated endpoints and the inserted midpoint (all handles absolute). Exact —
 * the union of the two sub-curves is identical to the original.
 */
function splitSegment(p0: DataPoint, p1: DataPoint, t: number): { p0: DataPoint; mid: DataPoint; p1: DataPoint } {
  const c0 = outC(p0), c1 = inC(p1);
  const a = mid({ x: p0.x, y: p0.y }, c0, t);
  const b = mid(c0, c1, t);
  const c = mid(c1, { x: p1.x, y: p1.y }, t);
  const d = mid(a, b, t);
  const e = mid(b, c, t);
  const f = mid(d, e, t); // point on the curve
  return {
    p0: { ...p0, outX: a.x, outY: a.y },
    mid: { x: f.x, y: f.y, inX: d.x, inY: d.y, outX: e.x, outY: e.y },
    p1: { ...p1, inX: c.x, inY: c.y },
  };
}

/** Chord length of the segment starting at index `i` (to the next vertex). */
function segLen(pts: DataPoint[], i: number): number {
  const a = pts[i]!, b = pts[i + 1]!;
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * Return a copy of `pts` grown to exactly `target` vertices by repeatedly
 * subdividing its currently-longest interior segment. `pts` is not mutated.
 * Requires `pts.length >= 2` and `target >= pts.length`.
 */
export function growOutline(pts: DataPoint[], target: number): DataPoint[] {
  const out = pts.map((p) => ({ ...p }));
  while (out.length < target && out.length >= 2) {
    let best = 0, bestLen = -1;
    for (let i = 0; i < out.length - 1; i++) {
      const l = segLen(out, i);
      if (l > bestLen) { bestLen = l; best = i; }
    }
    const s = splitSegment(out[best]!, out[best + 1]!, 0.5);
    out[best] = s.p0;
    out[best + 1] = s.p1;
    out.splice(best + 1, 0, s.mid);
  }
  return out;
}

function lerpPoints(a: DataPoint[], b: DataPoint[], u: number): DataPoint[] {
  if (a.length !== b.length) {
    // Grow the shorter outline to match the longer, preserving its shape.
    if (a.length >= 2 && b.length >= 2) {
      const n = Math.max(a.length, b.length);
      if (a.length < n) a = growOutline(a, n);
      if (b.length < n) b = growOutline(b, n);
    } else {
      return u < 1 ? a : b; // degenerate (single point / empty) — still snap
    }
  }
  return a.map((p, i) => {
    const q = b[i]!;
    const out: DataPoint = { x: lerp(p.x, q.x, u), y: lerp(p.y, q.y, u) };
    const opt = (ka: number | undefined, kb: number | undefined): number | undefined =>
      ka !== undefined && kb !== undefined ? lerp(ka, kb, u) : (u < 1 ? ka : kb);
    const inX = opt(p.inX, q.inX); if (inX !== undefined) out.inX = inX;
    const inY = opt(p.inY, q.inY); if (inY !== undefined) out.inY = inY;
    const outX = opt(p.outX, q.outX); if (outX !== undefined) out.outX = outX;
    const outY = opt(p.outY, q.outY); if (outY !== undefined) out.outY = outY;
    return out;
  });
}

function lerpStops(a: GradientStop[], b: GradientStop[], u: number): GradientStop[] {
  if (a.length !== b.length) return u < 1 ? a : b; // snap on mismatch
  return a.map((s, i) => ({
    pos: lerp(s.pos, b[i]!.pos, u),
    color: lerpColor(s.color, b[i]!.color, u),
  }));
}

/**
 * Sample a data track at time `t`. Before the first keyframe → first value;
 * after the last → last value; between two → per-kind interpolation (`text`
 * always holds). Returns undefined for an empty track.
 */
export function sampleDataTrack(track: DataTrack, t: number): DataValue | undefined {
  const kfs = track.keyframes;
  if (kfs.length === 0) return undefined;
  if (t <= kfs[0]!.t) return kfs[0]!.value;
  const last = kfs[kfs.length - 1]!;
  if (t >= last.t) return last.value;
  let i = 0;
  while (i + 1 < kfs.length && kfs[i + 1]!.t <= t) i++;
  const a = kfs[i]!;
  const b = kfs[i + 1]!;
  if (track.kind === 'text') return a.value; // hold — strings cannot tween
  const u = (t - a.t) / (b.t - a.t);
  if (track.kind === 'number') return lerp(a.value as number, b.value as number, u);
  if (track.kind === 'points') return lerpPoints(a.value as DataPoint[], b.value as DataPoint[], u);
  return lerpStops(a.value as GradientStop[], b.value as GradientStop[], u);
}

/** Deep copy of a data value (values are plain JSON-safe structures). */
export function cloneDataValue<T extends DataValue>(v: T): T {
  return typeof v === 'string' ? v : (JSON.parse(JSON.stringify(v)) as T);
}
