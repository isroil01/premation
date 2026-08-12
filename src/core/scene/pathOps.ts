/**
 * Path operations — procedural shape deformation. A
 * shape's outline (or drawn path) is transformed into a new polyline before
 * rendering: Zig-Zag ruffles the edges, Round Corners softens the vertices.
 * The amount/detail are keyframeable, so an animated zig-zag amplitude gives a
 * wobbling squiggle — classic generative motion graphics.
 *
 * Every operator is a pure point→point function (unit-tested); buildSnapshot
 * generates the base outline, applies the op, and hands the result to the
 * renderer as a path.
 *
 * One operator is temporal: Roughen (AE's Wiggle Paths) takes a time and
 * re-randomizes at `wigglesPerSecond`, cross-fading between whole-numbered
 * noise fields so the outline travels rather than snaps. Its noise is a pure
 * hash of (point, time bucket, seed) — no Math.random — so preview, export and
 * a scrub back to the same frame all produce the same shape.
 */

import { trimSegments, trimPolyline, type Pt } from './trimPath';
import type { SceneNode } from '@core/types';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { bumpScene } from '@stores/sceneStore';
import { repeaterCopies, defaultRepeater, type Repeater, type RepeaterComposite } from '@core/scene/repeater';

export type PathOpType =
  | 'none' | 'zigzag' | 'roundCorners' | 'pucker' | 'twist' | 'offset' | 'roughen' | 'trim' | 'repeater';

/**
 * One continuous run of geometry flowing through the chain.
 *
 * The chain's currency used to be a single `Pt[]` with one `closed` flag, which
 * is why Trim could not live in it: trimming produces a LIST of open arcs, and
 * a single polyline has nowhere to put the second one. `closed` is per-run
 * because a trim makes its outputs open while leaving nothing else about the
 * shape open.
 */
export interface PolyRun {
  pts: Pt[];
  closed: boolean;
  /**
   * Cumulative paint opacity for this run, 0..1, MULTIPLYING the layer's own.
   *
   * Written only by the repeater, which is the only operator that produces runs
   * meant to be painted differently from one another (`offsetOpacity`). Absent
   * means "paint exactly like the layer", so every other operator leaves it
   * alone and every chain without a repeater emits geometry with no paint at
   * all — which is what keeps those layers on the unbatched draw path.
   */
  opacity?: number;
  /**
   * Cumulative scale applied to this run's geometry, so a downstream consumer
   * can scale things measured in px that are NOT geometry — the stroke width.
   *
   * The repeater's `offsetScale` used to be part of the copy's layer transform,
   * which scaled its stroke along with it. Baked into geometry it no longer
   * does, and a repeater that shrinks its copies would draw every one of them
   * with the original stroke width. This carries the factor to where the stroke
   * is resolved.
   */
  strokeScale?: number;
}

export interface PathOp {
  /**
   * Stable identity, unique within the node.
   *
   * Exists so keyframes can be scoped to an OPERATOR rather than to a position
   * in the chain — see `pathOpPropPath`. Without it, reordering the stack would
   * hand each operator its neighbour's animation.
   */
  id: string;
  type: PathOpType;
  /** Zig-Zag amplitude (px) or Round-Corners radius (px). */
  amount: number;
  /** Zig-Zag ridges per edge, or Round-Corners arc steps. */
  detail: number;
  /**
   * Roughen only — how many times per second the displacement re-randomizes
   * (AE's Wiggles/Second). 0 freezes the noise, which is what every operator
   * did before this existed, so an old project loads pixel-identical.
   */
  wigglesPerSecond?: number;
  /** Roughen only — decorrelates two layers that would otherwise wiggle alike. */
  seed?: number;
  /**
   * Roughen only — AE's Wiggle Paths **Correlation**, percent 0..100.
   *
   * How alike NEIGHBOURING points move. At 0 every point is independent and the
   * outline shreds; at 100 every point shares one displacement magnitude and
   * one direction, each still measured against its OWN normal — so a closed
   * outline swells and slides as a whole rather than shredding, though it is
   * not a rigid translation, since the normals differ around the path. The
   * interesting range is the middle, where the outline behaves like something
   * with stiffness — a rope, a flag, a hand-drawn line.
   *
   * This operator is surfaced to users as "Wiggle Paths" (see
   * `PathOpControls`), and Correlation is the parameter that *defines* AE's
   * Wiggle Paths — without it the operator was AE's **Roughen** wearing the
   * other one's name. Adding it here rather than adding a second operator is
   * deliberate: two entries both called Wiggle Paths would be the duplication,
   * not the fix.
   *
   * **Defaults to 0**, which is exactly the previous behaviour, so every
   * existing project renders identically. AE's own default is 50, but a default
   * that re-shapes shipped work is not a default worth matching.
   */
  correlation?: number;
  /** Trim only — start of the visible range, percent 0..100. */
  start?: number;
  /** Trim only — end of the visible range, percent 0..100. */
  end?: number;
  /**
   * Trim: rotate the window around the path, percent (wraps).
   * Repeater: AE's Repeater Offset — shift the whole ladder by this many rungs,
   * fractional and negative allowed.
   *
   * SHARED between the two on purpose. They are the same word for the same idea
   * — "slide the effect along its own axis" — and an operator is exactly one
   * type, so `pathop.<id>.offset` can never be ambiguous. A second param name
   * would be a second row in `PATHOP_PARAMS` sampling the same slot.
   */
  offset?: number;

  // ── Repeater only ──────────────────────────────────────────────────
  // Defaults here are the INERT ones (one copy, no offset, unit scale and
  // opacity), not `defaultRepeater()`'s. A malformed stored entry should do
  // nothing rather than silently start repeating; the authored defaults live in
  // `defaultRepeaterOp`.

  /** Number of copies, INCLUDING the original. 1 or less is inert. */
  copies?: number;
  /** Per-copy position offset, in the layer's own units. */
  offsetX?: number;
  offsetY?: number;
  /** Per-copy rotation offset, degrees — this is what draws arcs and spirals. */
  offsetRotation?: number;
  /** Per-copy scale multiplier (1 = no change). */
  offsetScale?: number;
  /** Per-copy opacity multiplier (1 = no change). */
  offsetOpacity?: number;
  /** Pivot for the per-copy rotation and scale, layer-local px. */
  anchorX?: number;
  anchorY?: number;
  /**
   * Whether the copies stack above or below the original. Discrete, so it is
   * NOT keyframeable — interpolating it would mean a frame where the copies are
   * halfway between in front of and behind.
   */
  composite?: RepeaterComposite;
}

/**
 * The keyframeable parameters. `wigglesPerSecond` is here so the wiggle can
 * spin up and settle; `seed` deliberately is NOT — interpolating a seed
 * scrubs through unrelated noise fields instead of animating anything.
 *
 * `start`/`end`/`offset` belong to Trim. They are in the SHARED list rather
 * than a per-type one because the sampling path (`resolveOne`) reads every
 * param for every operator and the inspector only renders the rows a type
 * declares — a type-specific list would be a second place for "which params
 * exist" to be stated, and the two would drift.
 */
export const PATHOP_PARAMS = [
  // `correlation` IS keyframeable — unlike `seed`. Animating it is meaningful:
  // a path can start rigid and shred as it moves, which is a real effect.
  // Animating a seed just scrubs through unrelated noise fields.
  'amount', 'detail', 'wigglesPerSecond', 'correlation',
  'start', 'end', 'offset',
  'copies', 'offsetX', 'offsetY', 'offsetRotation', 'offsetScale', 'offsetOpacity',
  'anchorX', 'anchorY',
] as const;
export type PathOpParam = (typeof PATHOP_PARAMS)[number];

/**
 * The keyframe path for one operator's parameter.
 *
 * Scoped by the operator's ID, not by its index. That is the whole reason
 * `PathOp.id` exists: with `pathop.0.amount`, dragging an operator up the list
 * would hand its keyframes to whichever operator landed on index 0 — an
 * animation silently jumping to a different operator, which reads as corruption
 * rather than as a reorder.
 */
export function pathOpPropPath(opId: string, param: PathOpParam): string {
  return `pathop.${opId}.${param}`;
}

/** Unique within a node, and stable across saves. */
let opIdCounter = 0;
export function newPathOpId(): string {
  opIdCounter += 1;
  return `op${opIdCounter}_${Math.random().toString(36).slice(2, 7)}`;
}

export function defaultPathOp(): PathOp {
  return { id: newPathOpId(), type: 'zigzag', amount: 20, detail: 4, wigglesPerSecond: 0, seed: 0 };
}

/**
 * Trim defaults: the full range, i.e. a no-op until the user moves something.
 *
 * `amount`/`detail` are zeroed rather than inherited from `defaultPathOp`, so a
 * freshly added Trim and one produced by the 1.3.0 → 1.4.0 migration are byte
 * identical. Two ways to spell the same operator is how a round-trip starts
 * showing spurious diffs.
 */
export function defaultTrimOp(): PathOp {
  return { id: newPathOpId(), type: 'trim', amount: 0, detail: 0, start: 0, end: 100, offset: 0 };
}

/**
 * A freshly added Repeater. The ladder defaults come from `defaultRepeater()`
 * rather than being restated, so the operator and the migration that converts
 * old `fx.repeater` configs cannot disagree about what a default repeater is.
 *
 * `amount`/`detail` are zeroed for the same reason `defaultTrimOp` zeroes them:
 * one spelling per operator, so a round-trip shows no spurious diff.
 */
export function defaultRepeaterOp(): PathOp {
  const d = defaultRepeater();
  return {
    id: newPathOpId(), type: 'repeater', amount: 0, detail: 0,
    copies: d.copies, offsetX: d.offsetX, offsetY: d.offsetY,
    offsetRotation: d.offsetRotation, offsetScale: d.offsetScale,
    offsetOpacity: d.offsetOpacity, offset: d.offset ?? 0,
    anchorX: d.anchorX ?? 0, anchorY: d.anchorY ?? 0, composite: d.composite ?? 'above',
  };
}

/** The chain's repeater entry for a node, or null. AE allows one; so do we. */
export function readRepeaterOp(node: SceneNode): PathOp | null {
  return readPathOps(node).find((o) => o.type === 'repeater') ?? null;
}

/**
 * The keyframe path for a node's repeater parameter, or null when it has none.
 *
 * The replacement for `rep.<param>`, which was a per-LAYER namespace that worked
 * only while a layer could have exactly one repeater in exactly one place.
 */
export function repeaterOpPropPath(node: SceneNode, param: PathOpParam): string | null {
  const op = readRepeaterOp(node);
  return op ? pathOpPropPath(op.id, param) : null;
}

/** The ladder config carried by a repeater operator. */
function repeaterFromOp(op: PathOp): Repeater {
  return {
    copies: op.copies ?? 1,
    offsetX: op.offsetX ?? 0,
    offsetY: op.offsetY ?? 0,
    offsetRotation: op.offsetRotation ?? 0,
    offsetScale: op.offsetScale ?? 1,
    offsetOpacity: op.offsetOpacity ?? 1,
    offset: op.offset ?? 0,
    anchorX: op.anchorX ?? 0,
    anchorY: op.anchorY ?? 0,
    composite: op.composite ?? 'above',
  };
}

/** The chain's trim entry for a node, or null. AE allows only one; so do we. */
export function readTrimOp(node: SceneNode): PathOp | null {
  return readPathOps(node).find((o) => o.type === 'trim') ?? null;
}

/**
 * The keyframe path for a node's trim parameter, or null when it has no trim.
 *
 * Callers outside the inspector (AI tools, seeds, the caster) used to write
 * `trim.<param>`, a per-layer namespace that worked only because there could be
 * exactly one trim. Now that trim is a chain entry the path is id-scoped like
 * every other operator's, and this is how a caller that knows only the node
 * finds it.
 */
export function trimOpPropPath(node: SceneNode, param: 'start' | 'end' | 'offset'): string | null {
  const op = readTrimOp(node);
  return op ? pathOpPropPath(op.id, param) : null;
}

const DEG = Math.PI / 180;

// ── Pure geometry (tested) ───────────────────────────────────────────

/**
 * A shape's outline as a closed polyline in local space (centred at 0,0).
 * `subdivide` inserts extra points along rect edges (0 = plain corners) so
 * pucker/twist deform smoothly rather than just moving the four corners.
 */
export function shapeOutline(
  primitive: string | undefined,
  w: number,
  h: number,
  ellipseSteps = 48,
  subdivide = 0,
): Pt[] {
  if (primitive === 'ellipse') {
    const pts: Pt[] = [];
    for (let i = 0; i < ellipseSteps; i++) {
      const a = (i / ellipseSteps) * Math.PI * 2;
      pts.push({ x: Math.cos(a) * (w / 2), y: Math.sin(a) * (h / 2) });
    }
    return pts;
  }
  const corners: Pt[] = [
    { x: -w / 2, y: -h / 2 },
    { x: w / 2, y: -h / 2 },
    { x: w / 2, y: h / 2 },
    { x: -w / 2, y: h / 2 },
  ];
  if (subdivide <= 0) return corners;
  const out: Pt[] = [];
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i]!;
    const b = corners[(i + 1) % corners.length]!;
    for (let s = 0; s < subdivide + 1; s++) {
      const t = s / (subdivide + 1);
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return out;
}

/**
 * Ruffle each edge into `segments` sub-steps, offsetting the interior points
 * alternately ±amplitude perpendicular to the edge. Original vertices stay.
 */
export function zigzag(pts: readonly Pt[], closed: boolean, amplitude: number, segments: number): Pt[] {
  const seg = Math.max(1, Math.floor(segments));
  const n = pts.length;
  if (n < 2) return [...pts];
  const count = closed ? n : n - 1;
  const out: Pt[] = [];
  for (let i = 0; i < count; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len; // perpendicular unit
    const ny = dx / len;
    out.push({ x: a.x, y: a.y }); // keep the vertex
    for (let s = 1; s < seg; s++) {
      const t = s / seg;
      const off = amplitude * (s % 2 === 1 ? 1 : -1);
      out.push({ x: a.x + dx * t + nx * off, y: a.y + dy * t + ny * off });
    }
  }
  if (!closed) out.push({ x: pts[n - 1]!.x, y: pts[n - 1]!.y });
  return out;
}

/**
 * Replace each vertex with a rounded corner: cut back along both edges by
 * `radius` (clamped to half the shorter edge) and fill with a quadratic arc.
 */
export function roundCorners(pts: readonly Pt[], closed: boolean, radius: number, steps = 4): Pt[] {
  const n = pts.length;
  if (n < 3 || radius <= 0) return [...pts];
  const st = Math.max(1, Math.floor(steps));
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const cur = pts[i]!;
    if (!closed && (i === 0 || i === n - 1)) {
      out.push({ x: cur.x, y: cur.y });
      continue;
    }
    const prev = pts[(i - 1 + n) % n]!;
    const next = pts[(i + 1) % n]!;
    const v1x = prev.x - cur.x;
    const v1y = prev.y - cur.y;
    const v2x = next.x - cur.x;
    const v2y = next.y - cur.y;
    const l1 = Math.hypot(v1x, v1y) || 1;
    const l2 = Math.hypot(v2x, v2y) || 1;
    const d = Math.min(radius, l1 / 2, l2 / 2);
    const p1 = { x: cur.x + (v1x / l1) * d, y: cur.y + (v1y / l1) * d };
    const p2 = { x: cur.x + (v2x / l2) * d, y: cur.y + (v2y / l2) * d };
    out.push(p1);
    for (let s = 1; s < st; s++) {
      const t = s / st;
      const mt = 1 - t;
      out.push({
        x: mt * mt * p1.x + 2 * mt * t * cur.x + t * t * p2.x,
        y: mt * mt * p1.y + 2 * mt * t * cur.y + t * t * p2.y,
      });
    }
    out.push(p2);
  }
  return out;
}

/** Centroid of a point set. */
function centroid(pts: readonly Pt[]): Pt {
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p.x;
    y += p.y;
  }
  const n = pts.length || 1;
  return { x: x / n, y: y / n };
}

/**
 * Pucker & Bloat — push points out from (bloat, amount > 0) or pull them in
 * toward (pucker, amount < 0) the centroid, as a percentage of their radius.
 */
export function puckerBloat(pts: readonly Pt[], amountPct: number): Pt[] {
  if (pts.length < 3) return [...pts];
  const c = centroid(pts);
  const f = 1 + amountPct / 100;
  return pts.map((p) => ({ x: c.x + (p.x - c.x) * f, y: c.y + (p.y - c.y) * f }));
}

/**
 * Twist — rotate each point around the centroid by an angle proportional to its
 * distance from the centre, spiralling the outline. Pure.
 */
export function twist(pts: readonly Pt[], angleDeg: number): Pt[] {
  if (pts.length < 3) return [...pts];
  const c = centroid(pts);
  let maxD = 0;
  for (const p of pts) {
    const d = Math.hypot(p.x - c.x, p.y - c.y);
    if (d > maxD) maxD = d;
  }
  if (maxD === 0) return [...pts];
  return pts.map((p) => {
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    const a = (angleDeg * DEG) * (Math.hypot(dx, dy) / maxD);
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos };
  });
}

/**
 * Offset Paths — move every point along its averaged-edge normal. Sign flips
 * expand vs contract (which is which depends on the outline's winding). Naive
 * normal offset with no self-intersection cleanup — AE's is fancier, but this
 * covers the classic "grow/shrink the shape" use. Pure.
 */
export function offsetPath(pts: readonly Pt[], closed: boolean, amount: number): Pt[] {
  const n = pts.length;
  if (n < 2 || amount === 0) return [...pts];
  const normalOf = (a: Pt, b: Pt): Pt => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: -dy / len, y: dx / len };
  };
  return pts.map((p, i) => {
    const hasPrev = closed || i > 0;
    const hasNext = closed || i < n - 1;
    const np = hasPrev ? normalOf(pts[(i - 1 + n) % n]!, p) : null;
    const nn = hasNext ? normalOf(p, pts[(i + 1) % n]!) : null;
    let nx = (np?.x ?? 0) + (nn?.x ?? 0);
    let ny = (np?.y ?? 0) + (nn?.y ?? 0);
    const len = Math.hypot(nx, ny) || 1;
    nx /= len;
    ny /= len;
    return { x: p.x + nx * amount, y: p.y + ny * amount };
  });
}

/**
 * Roughen — subdivide each edge `detail` times, then displace every point by a
 * DETERMINISTIC per-index hash scaled by `amount` (stable across frames, so
 * animating amount wobbles smoothly instead of boiling). Surfaced as AE's
 * Wiggle Paths. Pure.
 *
 * ── The displacement is 2D, and used not to be ──────────────────────────────
 *
 * Every point used to move along its NORMAL only: one scalar, one direction
 * perpendicular to the outline. That is a legible operator but it is not what
 * AE does, and the difference is visible rather than academic — a normal-only
 * wiggle can only make an outline bulge and pinch, so its vertices stay at the
 * same arc positions and the shape breathes in and out. AE's vertices also
 * slide ALONG the path, which is what makes a wiggled outline read as hand-drawn
 * rather than as a rippling membrane.
 *
 * So each point now takes TWO noise values: channel 0 is the signed MAGNITUDE,
 * exactly as before, and channel 1 rotates the direction away from the normal.
 * Separate channels of the same hash rather than two hashes, so `seed`, the
 * time cross-fade and `correlation` all apply to both with no second copy of
 * that machinery.
 *
 * ── Direction × magnitude, NOT two independent components ───────────────────
 *
 * The obvious construction — one noise value along the normal and another along
 * the tangent — is wrong, and the suite already said so. Two independent
 * components each bounded by `amount` put the corner of a square at
 * `amount · √2`, which broke `never displaces further than Size, at any phase`:
 * a user asking for 6 px of wiggle got 7.6. "Size is the most it can move" is a
 * real contract and the more important one.
 *
 * Sampling a direction and a magnitude keeps it exactly: |displacement| is
 * `|amount · channel0|`, which is the same bound — and the same per-point
 * magnitude — the normal-only version had. What changed is only where that
 * displacement points.
 */
export function roughen(
  pts: readonly Pt[],
  closed: boolean,
  amount: number,
  detail: number,
  phase = 0,
  seed = 0,
  /**
   * AE's Correlation, 0..100. See `PathOp.correlation`. Defaults to 0 — the
   * behaviour before this parameter existed — so callers that never pass it are
   * unaffected.
   */
  correlation = 0,
): Pt[] {
  const n = pts.length;
  if (n < 2 || amount === 0) return [...pts];
  const sub = Math.max(1, Math.min(10, Math.round(detail)));
  const dense: Pt[] = [];
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    for (let s = 0; s < sub; s++) {
      const t = s / sub;
      dense.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  if (!closed) dense.push(pts[n - 1]!);
  const m = dense.length;
  // Deterministic hash — no Math.random, so preview and export agree and a
  // scrub back to the same frame redraws the same shape. Mixing the time
  // bucket `k` and `seed` in here (rather than perturbing the index) keeps
  // neighbouring points uncorrelated at every instant.
  //
  // `ch` selects the CHANNEL: 0 is the signed displacement magnitude, 1 the
  // rotation of its direction away from the normal. Folded into the same mix
  // rather than hashed separately, so both channels inherit the seed, the time
  // cross-fade and correlation for free.
  const hash = (i: number, k: number, ch = 0): number => {
    let h = (i + 1) * 374761393 + k * 668265263 + seed * 2246822519 + ch * 2654435761;
    h = (h ^ (h >>> 13)) * 1274126177;
    return (((h ^ (h >>> 16)) >>> 0) / 4294967296) * 2 - 1;
  };
  // Smoothly cross-fade between whole-numbered noise fields so the outline
  // travels between random configurations instead of snapping between them.
  // `phase` is already time × wiggles-per-second, so phase 0 (the default and
  // every pre-existing project) collapses to exactly the old static hash.
  const k0 = Math.floor(phase);
  const frac = phase - k0;
  const smooth = frac * frac * (3 - 2 * frac);
  const rnd = (i: number, ch = 0): number => {
    if (smooth === 0) return hash(i, k0, ch);
    return hash(i, k0, ch) + (hash(i, k0 + 1, ch) - hash(i, k0, ch)) * smooth;
  };
  /**
   * Correlation blends each point's own noise toward ONE path-wide value, so
   * neighbours stop being independent. Index -1 is reserved for that shared
   * value — it cannot collide with a real point index, and it rides the same
   * time cross-fade, so a correlated wiggle animates as smoothly as a loose one.
   *
   * Applied per CHANNEL, each with its own shared value. Correlating only the
   * magnitude would leave the direction fully random at correlation 100 — the
   * control would visibly stop short of the effect it promises.
   *
   * At c = 1 every point takes the same magnitude AND the same rotation, so
   * every displacement has the identical length while still pointing relative
   * to that point's own frame.
   */
  const c = Math.max(0, Math.min(100, correlation)) / 100;
  const sharedMag = rnd(-1, 0);
  const sharedAng = rnd(-1, 1);
  const disp = c === 0
    ? (i: number, ch: number): number => rnd(i, ch)
    : (i: number, ch: number): number => {
      const own = rnd(i, ch);
      return own + ((ch === 0 ? sharedMag : sharedAng) - own) * c;
    };
  return dense.map((p, i) => {
    const prev = dense[(i - 1 + m) % m]!;
    const next = dense[(i + 1) % m]!;
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    // How far, and which way. The magnitude keeps the whole ±amount range
    // (a signed value, so it still pushes in and out); the angle turns that
    // displacement off the normal, over a full ±180° so no direction is
    // unreachable.
    const mag = amount * disp(i, 0);
    const ang = disp(i, 1) * Math.PI;
    const cos = Math.cos(ang);
    const sin = Math.sin(ang);
    return {
      x: p.x + (nx * cos - ny * sin) * mag,
      y: p.y + (nx * sin + ny * cos) * mag,
    };
  });
}

/**
 * Apply the configured operator to an outline. Pure.
 *
 * `timeSec` is the layer's OWN time — the same axis the operator's animated
 * params were sampled on. Passing comp time here would desync the wiggle from
 * its own keyframes on any time-remapped or stretched layer.
 *
 * Wiggles-per-second is folded into a phase here and nowhere else: one reader,
 * so the inspector's number and the rendered motion cannot disagree.
 */
export function applyPathOp(pts: readonly Pt[], closed: boolean, op: PathOp, timeSec = 0): Pt[] {
  switch (op.type) {
    case 'zigzag':
      return zigzag(pts, closed, op.amount, op.detail);
    case 'roundCorners':
      return roundCorners(pts, closed, op.amount, op.detail);
    case 'pucker':
      return puckerBloat(pts, op.amount);
    case 'twist':
      return twist(pts, op.amount);
    case 'offset':
      return offsetPath(pts, closed, op.amount);
    case 'roughen':
      return roughen(
        pts, closed, op.amount, op.detail,
        timeSec * (op.wigglesPerSecond ?? 0), op.seed ?? 0,
        op.correlation ?? 0,
      );
    default:
      return [...pts];
  }
}

// ── Scene integration ────────────────────────────────────────────────

const num = (v: unknown, fb: number): number => (typeof v === 'number' ? v : fb);
function fxProps(node: SceneNode): Record<string, unknown> | undefined {
  return node.components.find((c) => c.type === 'fx')?.props as Record<string, unknown> | undefined;
}

const PATH_OP_TYPES: readonly PathOpType[] = ['none', 'zigzag', 'roundCorners', 'pucker', 'twist', 'offset', 'roughen', 'trim', 'repeater'];

function isPathOpType(v: unknown): v is PathOpType {
  return typeof v === 'string' && (PATH_OP_TYPES as readonly string[]).includes(v);
}

/**
 * Read the operator CHAIN.
 *
 * `fx.pathOps` is an ordered array — AE's shape contents list, where operators
 * stack and each one deforms the result of the last. It replaced a single
 * `fx.pathOp` slot in document version 1.3.0.
 *
 * This reads ONLY the new key. The legacy single slot is handled by the
 * migration (v1_2_0_to_v1_3_0), not by a fallback here, and that is deliberate:
 * a reader that quietly accepts both shapes means documents can stay
 * un-migrated indefinitely, the migration never gets exercised, and the two
 * shapes drift. The migration runs at `restoreDocument`, which is the single
 * point every foreign document passes through.
 */
export function readPathOps(node: SceneNode): PathOp[] {
  const raw = fxProps(node)?.pathOps;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => coercePathOp(entry))
    .filter((op): op is PathOp => op !== null);
}

/** Validate one stored entry into a `PathOp`, or null if it is not one. */
function coercePathOp(raw: unknown): PathOp | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Partial<PathOp>;
  const d = defaultPathOp();
  return {
    // A stored op with no id is repaired rather than dropped. Losing the op
    // would lose the user's work; losing only its keyframe binding is the
    // smaller failure, and this path is unreachable for migrated documents.
    id: typeof o.id === 'string' && o.id !== '' ? o.id : newPathOpId(),
    type: isPathOpType(o.type) ? o.type : d.type,
    amount: num(o.amount, d.amount),
    detail: num(o.detail, d.detail),
    wigglesPerSecond: Math.max(0, num(o.wigglesPerSecond, 0)),
    seed: num(o.seed, 0),
    // 0 = the pre-Correlation behaviour, so a stored op without the field is
    // unchanged. AE defaults this to 50; matching that here would re-shape every
    // Wiggle Paths already in a project.
    correlation: Math.max(0, Math.min(100, num(o.correlation, 0))),
    start: num(o.start, 0),
    end: num(o.end, 100),
    offset: num(o.offset, 0),
    copies: num(o.copies, 1),
    offsetX: num(o.offsetX, 0),
    offsetY: num(o.offsetY, 0),
    offsetRotation: num(o.offsetRotation, 0),
    offsetScale: num(o.offsetScale, 1),
    offsetOpacity: num(o.offsetOpacity, 1),
    anchorX: num(o.anchorX, 0),
    anchorY: num(o.anchorY, 0),
    composite: o.composite === 'below' ? 'below' : 'above',
  };
}

/** The first operator, for the callers that only ever wanted one. */
export function readPathOpConfig(node: SceneNode): PathOp | null {
  return readPathOps(node)[0] ?? null;
}

export function hasPathOp(node: SceneNode): boolean {
  return readPathOps(node).some((o) => o.type !== 'none');
}

/** One operator with its animated values applied at the sampled time. */
function resolveOne(op: PathOp, av: Map<string, number> | undefined): PathOp {
  const v = (p: PathOpParam, fb: number): number => av?.get(pathOpPropPath(op.id, p)) ?? fb;
  return {
    id: op.id,
    type: op.type,
    amount: v('amount', op.amount),
    detail: v('detail', op.detail),
    // Animated wiggles-per-second is clamped the same way the static read is,
    // so a keyframe that dips below zero cannot run the noise backwards.
    wigglesPerSecond: Math.max(0, v('wigglesPerSecond', op.wigglesPerSecond ?? 0)),
    seed: op.seed ?? 0,
    // Trim's three, sampled the same way. NOT clamped: `offset` wraps by
    // design, and start/end past 0..100 is how a draw-on overshoots and
    // settles — `trimSegments` already normalizes the window.
    start: v('start', op.start ?? 0),
    end: v('end', op.end ?? 100),
    offset: v('offset', op.offset ?? 0),
    // The repeater's eight. Every one of them was keyframeable under `rep.*`
    // before the fold and stays keyframeable here — the migration reroutes the
    // tracks rather than dropping them.
    copies: v('copies', op.copies ?? 1),
    offsetX: v('offsetX', op.offsetX ?? 0),
    offsetY: v('offsetY', op.offsetY ?? 0),
    offsetRotation: v('offsetRotation', op.offsetRotation ?? 0),
    offsetScale: v('offsetScale', op.offsetScale ?? 1),
    offsetOpacity: v('offsetOpacity', op.offsetOpacity ?? 1),
    anchorX: v('anchorX', op.anchorX ?? 0),
    anchorY: v('anchorY', op.anchorY ?? 0),
    // Discrete, so it is read straight from the config and never sampled.
    composite: op.composite ?? 'above',
  };
}

/**
 * The resolved chain, in application order, with inert operators dropped.
 *
 * `none` entries are filtered here rather than at the call site so the renderer
 * never has to special-case them, and an all-`none` stack costs nothing.
 */
export function resolvePathOps(node: SceneNode, av: Map<string, number> | undefined): PathOp[] {
  return readPathOps(node)
    .map((op) => resolveOne(op, av))
    .filter((op) => op.type !== 'none' && !isInertTrim(op) && !isInertRepeater(op));
}

/**
 * A repeater producing a single copy.
 *
 * Dropped for the same reason an untouched Trim is: a live chain converts the
 * layer's PRIMITIVE to an explicit path, so leaving a one-copy repeater in the
 * chain would square off a rounded rect's corners while changing nothing the
 * user asked for.
 *
 * `copies <= 1` and not "copies <= 1 with no offset": the pre-fold renderer
 * skipped the whole repeater block on `copies > 1`, so a single copy sitting at
 * a non-zero ladder Offset drew at the origin. Preserved deliberately — one
 * copy means "off", whatever the rest of the ladder says.
 */
function isInertRepeater(op: PathOp): boolean {
  return op.type === 'repeater' && (op.copies ?? 1) <= 1;
}

/**
 * A trim covering the whole path, which is what a freshly added Trim card is.
 *
 * Filtered out for the same reason `none` is: so the renderer never has to
 * special-case it. It is not merely an optimisation. A live chain converts the
 * layer's PRIMITIVE to an explicit path, and a rect's outline is its four hard
 * corners — so without this, dropping an untouched Trim card onto a rounded
 * rect would square off its corners while changing nothing the user asked for.
 */
function isInertTrim(op: PathOp): boolean {
  if (op.type !== 'trim') return false;
  const segs = trimSegments(op.start ?? 0, op.end ?? 100, op.offset ?? 0);
  return segs.length === 1 && segs[0]![0] === 0 && segs[0]![1] === 1;
}

/**
 * Cut every run down to a trim's visible arcs.
 *
 * Each run is trimmed INDEPENDENTLY by the same percentages — AE's "Trim
 * Multiple Shapes: Individually". Trimming the concatenation instead
 * (Simultaneously) would make a shape's arcs depend on how many runs happen to
 * precede it, so inserting an operator upstream would move a trim the user did
 * not touch. With the single closed outline that is the common case, the two
 * are identical.
 *
 * Outputs are always OPEN: a cut arc closed by the stroke would draw a chord
 * back to its own start. The fill closes it implicitly, which is the region AE
 * shades.
 */
function applyTrim(runs: readonly PolyRun[], op: PathOp): PolyRun[] {
  const segs = trimSegments(op.start ?? 0, op.end ?? 100, op.offset ?? 0);
  // The full range is a no-op, and must stay one: it has to leave a closed
  // outline closed, or adding an untouched Trim card would visibly open the
  // shape's stroke.
  if (segs.length === 1 && segs[0]![0] === 0 && segs[0]![1] === 1) return [...runs];
  const out: PolyRun[] = [];
  for (const run of runs) {
    for (const cut of trimPolyline(run.pts, run.closed, segs)) {
      // Paint rides along. A trim downstream of a repeater cuts each COPY, and
      // dropping the run's opacity here would flatten a faded ladder back to
      // full strength at the moment it was trimmed.
      out.push({ pts: cut, closed: false, opacity: run.opacity, strokeScale: run.strokeScale });
    }
  }
  return out;
}

/**
 * Replicate every run along the repeater's transform ladder.
 *
 * ── The space this happens in, which is the whole semantic change ──────
 *
 * Copies used to be emitted as separate `RenderLayer`s at `x: px + c.dx` —
 * COMP space, the delta added to the layer's comp position AFTER its own
 * rotation and scale were resolved. So a repeated layer's arrangement stayed
 * stubbornly axis-aligned however the layer was turned.
 *
 * Here the copies are baked into LAYER-LOCAL geometry, so the layer transform
 * applies to them like it applies to everything else the layer draws. That is
 * AE's model — the Repeater lives inside `contents`, below the layer's own
 * Transform — and it is why an untransformed layer renders identically while a
 * rotated or scaled one deliberately does not. See F19.
 *
 * The ladder itself is NOT re-derived here: `repeaterCopies` already composes
 * it iteratively, interpolates fractional Offsets, pivots about the anchor and
 * reverses for `composite: 'below'`. Restating any of that would be a second
 * place for "what a repeater does" to be written down.
 */
function applyRepeater(runs: readonly PolyRun[], op: PathOp): PolyRun[] {
  const out: PolyRun[] = [];
  for (const c of repeaterCopies(repeaterFromOp(op))) {
    // Scale folded into the rotation matrix: (p·s)·R == p·(s·R).
    const rad = c.drot * DEG;
    const cos = Math.cos(rad) * c.scaleMul;
    const sin = Math.sin(rad) * c.scaleMul;
    for (const r of runs) {
      out.push({
        closed: r.closed,
        pts: r.pts.map((p): Pt => ({
          x: p.x * cos - p.y * sin + c.dx,
          y: p.x * sin + p.y * cos + c.dy,
        })),
        // MULTIPLIED into whatever the run already carried, so two stacked
        // repeaters compound their fades the way two stacked ladders compound
        // their offsets.
        opacity: (r.opacity ?? 1) * c.opacityMul,
        strokeScale: (r.strokeScale ?? 1) * c.scaleMul,
      });
    }
  }
  return out;
}

/**
 * Fold the whole chain over a list of runs.
 *
 * Order is significant and is the point of the feature: Round Corners then
 * Zig-Zag gives soft ridges, Zig-Zag then Round Corners gives rounded spikes.
 * AE evaluates its contents list top-down and so does this.
 *
 * The currency is a LIST because Trim is in the chain now. Every other operator
 * is per-run and keeps its run's own `closed` — which matters downstream of a
 * trim, where a zigzag must ruffle an open arc without wrapping a segment from
 * its end back to its start.
 */
export function applyPathOpChain(
  runs: readonly PolyRun[],
  ops: readonly PathOp[],
  timeSec = 0,
): PolyRun[] {
  let out: PolyRun[] = runs.map((r) => ({ ...r, pts: [...r.pts] }));
  for (const op of ops) {
    if (op.type === 'none') continue;
    if (op.type === 'trim') {
      out = applyTrim(out, op);
      continue;
    }
    if (op.type === 'repeater') {
      out = applyRepeater(out, op);
      continue;
    }
    // Spread, so a per-run `opacity`/`strokeScale` set by an upstream repeater
    // survives every deformer below it. Rebuilding the run from `pts`/`closed`
    // alone silently un-fades the copies.
    out = out.map((r) => ({ ...r, pts: applyPathOp(r.pts, r.closed, op, timeSec) }));
  }
  return out;
}

/** Replace the whole chain. */
export function setPathOps(nodeId: string, ops: readonly PathOp[]): void {
  defaultSceneGraph.setPathOps(nodeId, ops.length > 0 ? [...ops] : undefined);
  bumpScene();
}

/** Append an operator to the end of the chain. */
export function addPathOp(nodeId: string, op: PathOp = defaultPathOp()): void {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return;
  setPathOps(nodeId, [...readPathOps(node), op]);
}

/**
 * Append a Trim entry and return its id.
 *
 * The id is the point: keyframes are id-scoped (`pathop.<id>.end`), so a caller
 * that wants to animate a draw-on needs it back. Seeds, `sceneInsert` and the
 * AI tools all used to write the fixed `trim.end` path, which worked only while
 * a layer could have exactly one trim in exactly one place.
 */
export function addTrimOp(nodeId: string, patch: Partial<PathOp> = {}): string {
  const op: PathOp = { ...defaultTrimOp(), ...patch, type: 'trim' };
  addPathOp(nodeId, op);
  return op.id;
}

/**
 * The node's trim entry id, adding one if it has none.
 *
 * For callers that want "the trim on this layer" without caring whether it is
 * already there — the AI's `set_trim_path` being the case that matters.
 */
export function ensureTrimOp(nodeId: string): string {
  const node = defaultSceneGraph.getNode(nodeId);
  const existing = node ? readTrimOp(node) : null;
  return existing ? existing.id : addTrimOp(nodeId);
}

/** Append a Repeater entry and return its id (keyframes are id-scoped). */
export function addRepeaterOp(nodeId: string, patch: Partial<PathOp> = {}): string {
  const op: PathOp = { ...defaultRepeaterOp(), ...patch, type: 'repeater' };
  addPathOp(nodeId, op);
  return op.id;
}

/** The node's repeater entry id, adding one if it has none. */
export function ensureRepeaterOp(nodeId: string): string {
  const node = defaultSceneGraph.getNode(nodeId);
  const existing = node ? readRepeaterOp(node) : null;
  return existing ? existing.id : addRepeaterOp(nodeId);
}

/**
 * Patch the node's repeater, adding one at the end of the chain if absent, and
 * return its id.
 *
 * The replacement for `repeater.ts`'s `updateRepeater`, for callers that want
 * "set these fields on this layer's repeater" without tracking operator ids —
 * the AI's `set_repeater` and the recipe seeds. Returns the id so an animating
 * caller can build `pathop.<id>.<param>` without a second lookup, which is the
 * whole reason `addTrimOp` returns one too.
 */
export function updateRepeaterOp(nodeId: string, patch: Partial<PathOp>): string {
  const opId = ensureRepeaterOp(nodeId);
  // `type` is pinned so a patch can never retype the repeater into a deformer,
  // which would reinterpret `copies` as an unrelated operator's parameter.
  updatePathOp(nodeId, opId, { ...patch, type: 'repeater' });
  return opId;
}

export function removePathOp(nodeId: string, opId: string): void {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return;
  setPathOps(nodeId, readPathOps(node).filter((o) => o.id !== opId));
}

/** Patch one operator, found by id. */
export function updatePathOp(nodeId: string, opId: string, patch: Partial<PathOp>): void {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return;
  setPathOps(
    nodeId,
    // `id` is spread first and then re-pinned, so a patch carrying an `id` can
    // never re-key an operator out from under its own keyframes.
    readPathOps(node).map((o) => (o.id === opId ? { ...o, ...patch, id: o.id } : o)),
  );
}

/** Move an operator to a new index. Keyframes follow it — they are id-scoped. */
export function reorderPathOp(nodeId: string, opId: string, toIndex: number): void {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return;
  const ops = readPathOps(node);
  const from = ops.findIndex((o) => o.id === opId);
  if (from < 0) return;
  const next = [...ops];
  const [moved] = next.splice(from, 1);
  if (!moved) return;
  next.splice(Math.max(0, Math.min(next.length, toIndex)), 0, moved);
  setPathOps(nodeId, next);
}
