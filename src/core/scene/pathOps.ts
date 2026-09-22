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

import polygonClipping from 'polygon-clipping';
import { trimSegments, trimPolyline, type Pt } from './trimPath';
import { rectOutline } from '@core/geometry/extrudeMesh';
import type { SceneNode } from '@core/types';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { bumpScene } from '@stores/sceneStore';
import { repeaterCopies, defaultRepeater, type Repeater, type RepeaterComposite } from '@core/scene/repeater';
import { renderComponentsOf } from '@core/scene/SceneGraph';

export type PathOpType =
  | 'none' | 'zigzag' | 'roundCorners' | 'pucker' | 'twist' | 'offset' | 'roughen' | 'trim' | 'repeater'
  | 'wiggleTransform';

/** Offset Paths' corner treatment — the same three joins a stroke has. */
export type OffsetLineJoin = 'miter' | 'round' | 'bevel';

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
   * Roughen and Wiggle Transform — how many times per second the noise
   * re-randomizes (AE's Wiggles/Second). 0 freezes it, which is what every
   * operator did before this existed, so an old project loads pixel-identical.
   */
  wigglesPerSecond?: number;
  /** Roughen and Wiggle Transform — decorrelates two layers that would
   *  otherwise wiggle alike. */
  seed?: number;
  /**
   * Wiggle Transform only — maximum rotation wiggle, degrees. The noise is
   * signed, so this is an amplitude: ±this many degrees at the extremes.
   * `amount` carries the position amplitude (px per axis) for this operator,
   * the same slot every deformer's primary knob lives in.
   */
  wiggleRotation?: number;
  /**
   * Wiggle Transform only — maximum scale wiggle, PERCENT. ±20 swings each
   * run between 0.8× and 1.2×, pivoting on `anchorX`/`anchorY` — the same
   * pivot fields the repeater uses, and the same idea: "turn and grow about
   * this point", so sharing the slot is the honest spelling, not a collision
   * (an operator is exactly one type; `pathop.<id>.anchorX` cannot be
   * ambiguous).
   */
  wiggleScale?: number;
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
   *
   * On **Wiggle Transform** the same field answers the same question one level
   * up: how alike the RUNS move — which downstream of a Repeater means how
   * alike the COPIES wiggle. 0 gives every copy its own independent transform
   * (the swarm), 100 moves them as one body. Same word, same idea, same slot;
   * a second `copyCorrelation` param would be the drift this file keeps
   * refusing to start.
   */
  correlation?: number;
  /**
   * Offset Paths only — how the gap at an outer corner is filled: AE's Line
   * Join. `miter` (the default, AE's too) extends the two offset edges to
   * their intersection, falling back to a bevel past `miterLimit`; `round`
   * sweeps an arc; `bevel` cuts straight across. Discrete (not keyframeable) —
   * interpolating a join style has no meaning between the stops.
   */
  lineJoin?: OffsetLineJoin;
  /**
   * Offset Paths only — AE's Miter Limit: an outer miter longer than
   * `miterLimit × |amount|` is cut to a bevel. Keyframeable, like AE's.
   * Absent means 4 (the Canvas2D convention), which on ordinary corners is
   * indistinguishable from the unbounded miter the old naive offset produced.
   */
  miterLimit?: number;

  /** Trim only — start of the visible range, percent 0..100. */
  start?: number;
  /** Trim only — end of the visible range, percent 0..100. */
  end?: number;
  /**
   * Trim only — AE's "Trim Multiple Shapes", with AE's (and lottie-web's)
   * meaning of the two words.
   *
   * `simultaneously` (AE's default): every run is trimmed by the SAME
   * percentages at once, so three bars grow together. `individually`: the runs
   * are trimmed one after another as a single concatenated length — the window
   * walks the first shape, then the second, then the third.
   *
   * Discrete (not keyframeable). Absent means `simultaneously`.
   *
   * RENAMED from `trimMultiple` in document 1.7.0, whose two values meant the
   * OPPOSITE (see `v1_6_0_to_v1_7_0`). A new key rather than swapped values
   * because `captureDocument` stamps every save '1.1.0' and re-walks the whole
   * chain on each load: a value swap would flip back and forth per reopen,
   * while a key rename converts once.
   */
  trimMultipleShapes?: 'simultaneously' | 'individually';
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
  'wiggleRotation', 'wiggleScale',
  // Offset Paths' miter cap — animatable in AE, so animatable here. The JOIN
  // is deliberately absent: it is discrete, like `composite` and
  // `trimMultiple`, and interpolating a corner style has no meaning.
  'miterLimit',
  'start', 'end', 'offset',
  'copies', 'offsetX', 'offsetY', 'offsetRotation', 'offsetScale', 'offsetOpacity',
  'anchorX', 'anchorY',
] as const;
export type PathOpParam = (typeof PATHOP_PARAMS)[number];

/**
 * One editable parameter of an operator: which param, and how to present it.
 *
 * `PATHOP_PARAMS` above is the SAMPLING vocabulary — every param every operator
 * could have, read for all of them because `resolveOne` is type-blind. This is
 * the per-type view: which of those a `twist` actually has, in which order, and
 * under what name. Both are needed and they are not the same list.
 */
export interface PathOpParamSpec {
  param: PathOpParam;
  label: string;
  unit?: string;
  /** Explicit bounds/granularity, when the type alone does not imply them. */
  min?: number;
  max?: number;
  step?: number;
  /** Signed parameter — suppresses the default non-negative floor. */
  signed?: boolean;
}

/** Per-operator labels for the two generic numeric params (some have no detail). */
function paramLabels(type: PathOpType): { amount: string; detail: string | null } {
  switch (type) {
    case 'roundCorners':
      return { amount: 'Radius', detail: 'Steps' };
    case 'pucker':
      return { amount: 'Amount', detail: null };
    case 'twist':
      return { amount: 'Angle', detail: null };
    case 'offset':
      return { amount: 'Offset', detail: null };
    case 'roughen':
      return { amount: 'Size', detail: 'Detail' };
    default:
      return { amount: 'Amount', detail: 'Ridges' };
  }
}

/**
 * The rows a given operator actually has.
 *
 * Lives here rather than in the inspector card that used to own it because it
 * is a fact about the operator, and the card stopped being its only reader: the
 * timeline's property tree lists the same parameters under Contents, and two
 * lists of "which params does a Repeater have" would drift the moment one grew
 * a row.
 */
export function pathOpParamSpecs(type: PathOpType): ReadonlyArray<PathOpParamSpec> {
  if (type === 'trim') {
    return [
      { param: 'start', label: 'Start', unit: '%' },
      { param: 'end', label: 'End', unit: '%' },
      { param: 'offset', label: 'Offset', unit: '%' },
    ];
  }
  if (type === 'repeater') {
    // Same rows, same labels and the same order the Repeater section had, so
    // the fold is a move rather than a redesign. `offset` is the ladder Offset
    // — AE's, shifting which rung copy 0 starts on — sharing the param slot
    // with Trim's, which is safe because an operator is exactly one type.
    // Bounds and steps carried over verbatim: a ladder that cannot be nudged in
    // hundredths is a scale field that jumps from 1 to 2, and the positions,
    // rotation and anchors are all signed — a repeater marching left is as
    // ordinary as one marching right.
    return [
      { param: 'copies', label: 'Copies', min: 1, max: 200, step: 1 },
      { param: 'offset', label: 'Offset', step: 0.1, signed: true },
      { param: 'anchorX', label: 'Anchor X', unit: 'px', signed: true },
      { param: 'anchorY', label: 'Anchor Y', unit: 'px', signed: true },
      { param: 'offsetX', label: 'Position X', unit: 'px', signed: true },
      { param: 'offsetY', label: 'Position Y', unit: 'px', signed: true },
      { param: 'offsetRotation', label: 'Rotation', unit: '°', signed: true },
      { param: 'offsetScale', label: 'Scale', min: 0, step: 0.02 },
      { param: 'offsetOpacity', label: 'Opacity', min: 0, max: 1, step: 0.02 },
    ];
  }
  if (type === 'wiggleTransform') {
    // AE's Wiggle Transform rows: three amplitudes and the pivot. The
    // amplitudes are magnitudes (the noise is signed), so their floor is 0;
    // the pivot is a position and goes both ways.
    return [
      { param: 'amount', label: 'Position', unit: 'px', min: 0 },
      { param: 'wiggleRotation', label: 'Rotation', unit: '°', min: 0 },
      { param: 'wiggleScale', label: 'Scale', unit: '%', min: 0 },
      { param: 'anchorX', label: 'Anchor X', unit: 'px', signed: true },
      { param: 'anchorY', label: 'Anchor Y', unit: 'px', signed: true },
    ];
  }
  if (type === 'offset') {
    // AE's Offset Paths rows: Amount and Miter Limit (both animatable there,
    // both here). Line Join is a discrete picker on the card, not a row.
    return [
      { param: 'amount', label: 'Amount', unit: 'px', signed: true },
      { param: 'miterLimit', label: 'Miter Limit', min: 1, step: 0.1 },
    ];
  }
  const { amount, detail } = paramLabels(type);
  const rows: PathOpParamSpec[] = [{ param: 'amount', label: amount }];
  if (detail) rows.push({ param: 'detail', label: detail });
  return rows;
}

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
  return {
    id: newPathOpId(), type: 'trim', amount: 0, detail: 0,
    start: 0, end: 100, offset: 0, trimMultipleShapes: 'simultaneously',
  };
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

/**
 * A freshly added Wiggle Transform. Visible immediately — 10 px of position
 * wiggle at AE's 2 wiggles/second — for the same reason `defaultPathOp`'s
 * zigzag ships with amplitude 20: an operator that appears to do nothing reads
 * as broken, not as awaiting input. Correlation matches AE's 50 here because
 * this operator is NEW — there is no shipped work for the default to re-shape,
 * which was the whole argument for Roughen keeping 0.
 */
export function defaultWiggleTransformOp(): PathOp {
  return {
    id: newPathOpId(), type: 'wiggleTransform', amount: 10, detail: 0,
    wigglesPerSecond: 2, seed: 0, correlation: 50,
    wiggleRotation: 0, wiggleScale: 0, anchorX: 0, anchorY: 0,
  };
}

/** Fresh operator of `type` — what the Effects & Presets browser adds. */
export function defaultPathOpOf(type: PathOpType): PathOp {
  if (type === 'trim') return defaultTrimOp();
  if (type === 'repeater') return defaultRepeaterOp();
  if (type === 'wiggleTransform') return defaultWiggleTransformOp();
  if (type === 'none') return { id: newPathOpId(), type: 'none', amount: 0, detail: 0 };
  return { ...defaultPathOp(), type };
}

/** Browser entries for path operators (Trim Paths, Zig-Zag, …). */
export const PATH_OP_CATALOG: ReadonlyArray<{ type: PathOpType; label: string }> = [
  { type: 'trim', label: 'Trim Paths' },
  { type: 'zigzag', label: 'Zig-Zag' },
  { type: 'roundCorners', label: 'Round Corners' },
  { type: 'pucker', label: 'Pucker & Bloat' },
  { type: 'twist', label: 'Twist' },
  { type: 'offset', label: 'Offset Paths' },
  { type: 'roughen', label: 'Wiggle Paths' },
  { type: 'wiggleTransform', label: 'Wiggle Transform' },
  { type: 'repeater', label: 'Repeater' },
];

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
 * Longest chord a flattened corner arc may span, in layer px — the same budget
 * `flattenOutline(…, ADAPTIVE)` gives the rest of the chain's input, so a
 * rounded corner is exactly as smooth as the drawn curve beside it. Restated
 * here rather than imported because `mergePaths` (where ADAPTIVE lives)
 * imports THIS module.
 */
const CORNER_ARC_MAX_CHORD_PX = 2.5;

/**
 * A shape's outline as a closed polyline in local space (centred at 0,0).
 * `subdivide` inserts extra points along rect edges (0 = plain corners) so
 * pucker/twist deform smoothly rather than just moving the four corners.
 *
 * `cornerRadii` (uniform, or per-corner TL→TR→BR→BL) rounds a rect's corners
 * INTO the polyline as flattened quarter arcs. This is how a rounded rect
 * keeps its corners under the operator chain: the chain converts the
 * primitive to an explicit path, and the rasterizer's `cornerRadii` honouring
 * lives in the rect branch it no longer takes — so without this, adding ANY
 * operator squared the corners off as a side effect. Absent or all-zero radii
 * emit the four sharp corners byte-identically to before the parameter
 * existed.
 *
 * `cornerAxisScale` is `RenderLayer.cornerRadiusScale`: the |scaleX|,|scaleY|
 * the compositor will draw this geometry at. The radii are authored in
 * COMPOSITION pixels (see `roundRect` in vectorDraw), so the outline is built
 * in comp space and mapped back — which makes the corner an ellipse HERE that
 * comes out a circle THERE, exactly as the no-operator raster draws it.
 */
export function shapeOutline(
  primitive: string | undefined,
  w: number,
  h: number,
  ellipseSteps = 48,
  subdivide = 0,
  cornerRadii?: number | readonly [number, number, number, number],
  cornerAxisScale?: readonly [number, number],
): Pt[] {
  if (primitive === 'ellipse') {
    const pts: Pt[] = [];
    for (let i = 0; i < ellipseSteps; i++) {
      const a = (i / ellipseSteps) * Math.PI * 2;
      pts.push({ x: Math.cos(a) * (w / 2), y: Math.sin(a) * (h / 2) });
    }
    return pts;
  }
  const rr = typeof cornerRadii === 'number'
    ? ([cornerRadii, cornerRadii, cornerRadii, cornerRadii] as const)
    : cornerRadii;
  if (rr && (rr[0] > 0 || rr[1] > 0 || rr[2] > 0 || rr[3] > 0)) {
    // A degenerate scale falls back to 1 rather than dividing by zero — the
    // same guard `roundRect` applies to the same pair.
    const kx = cornerAxisScale && cornerAxisScale[0] > 1e-6 ? cornerAxisScale[0] : 1;
    const ky = cornerAxisScale && cornerAxisScale[1] > 1e-6 ? cornerAxisScale[1] : 1;
    // Reuse the extrusion pipeline's exact rounded-rect polygon (per-corner
    // radii + clamping) rather than flattening a rounded rect a third way.
    // Arc density is adaptive on the largest radius so a corner arc's chords
    // stay within the chain's own ~2.5px budget (never below 12 segments per
    // 90°, matching the ellipse default's 48 per circle).
    const maxR = Math.max(rr[0], rr[1], rr[2], rr[3]);
    const arcSteps = Math.max(12, Math.min(96, Math.ceil((maxR * Math.PI * 0.5) / CORNER_ARC_MAX_CHORD_PX)));
    const ring = rectOutline(w * kx, h * ky, rr, arcSteps)[0]!;
    const pts: Pt[] = [];
    for (const p of ring.points) {
      const q = { x: p.x / kx, y: p.y / ky };
      const prev = pts[pts.length - 1];
      // Full-radius corners (a capsule, a squircle at the clamp) meet at a
      // shared arc endpoint; downstream operators divide by segment length.
      if (!prev || Math.hypot(q.x - prev.x, q.y - prev.y) > 1e-6) pts.push(q);
    }
    if (pts.length > 1) {
      const first = pts[0]!;
      const last = pts[pts.length - 1]!;
      if (Math.hypot(first.x - last.x, first.y - last.y) <= 1e-6) pts.pop();
    }
    if (subdivide <= 0) return pts;
    // The arcs are already dense; it is the straight edges between them that
    // would starve pucker/twist. Same budget as the sharp rect: `subdivide`
    // extra points across a full edge, applied here as a max segment length.
    return densifyClosed(pts, Math.max(w, h) / (subdivide + 1));
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

/** Split any segment of a closed ring longer than `maxLen` into equal pieces. */
function densifyClosed(pts: readonly Pt[], maxLen: number): Pt[] {
  if (!(maxLen > 0)) return [...pts];
  const out: Pt[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / maxLen));
    for (let s = 0; s < n; s++) {
      const t = s / n;
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
 * Offset Paths — true polygon/polyline offsetting with corner joins.
 *
 * Replaces the naive averaged-normal offset (every point slid along its vertex
 * normal, no joins, no cleanup), which had two visible failures AE's operator
 * does not: an outer corner was pulled to a fixed bisector point regardless of
 * its angle — a sharp spike offset outward stayed blunt — and a concave corner
 * offset far enough crossed itself and painted a bow-tie.
 *
 * Model, per edge rather than per vertex: every EDGE is translated along its
 * own left normal by `amount`, and each vertex between two edges is closed
 * with join geometry —
 *
 *   • outer corner (the offset edges diverge): `miter` extends both edges to
 *     their intersection, cut to a bevel when the miter length exceeds
 *     `miterLimit × |amount|` (exactly Canvas2D's rule, and AE's); `round`
 *     sweeps a flattened arc of radius |amount| about the vertex; `bevel`
 *     connects the two edge ends directly.
 *   • inner corner (the offset edges cross): the intersection of the two
 *     offset lines, falling back to both endpoints — the crossed loop that
 *     fallback can leave is exactly what the cleanup below removes.
 *
 * Self-intersection removal (closed runs): a convex ring cannot self-intersect
 * going outward, and going inward it can only COLLAPSE — detected by its
 * signed area flipping against the source's, in which case the run vanishes
 * (AE: a shape offset past its own inradius disappears). A non-convex ring is
 * cleaned by union-with-itself through the same Martinez machinery Merge Paths
 * uses: the crossed loops at pinched corners wind the opposite way and fall
 * out of the union.
 *
 * Sign flips expand vs contract exactly as before (which is which depends on
 * the outline's winding). Pure.
 */
export function offsetPath(
  pts: readonly Pt[],
  closed: boolean,
  amount: number,
  join: OffsetLineJoin = 'miter',
  miterLimit = 4,
): Pt[] {
  const runs = offsetPathRuns(pts, closed, amount, join, miterLimit);
  if (runs.length === 0) return [];
  if (runs.length === 1) return runs[0]!;
  // Single-outline contract (applyPathOp's shape): keep the largest ring.
  let best = runs[0]!;
  let bestArea = Math.abs(signedArea(best));
  for (let i = 1; i < runs.length; i++) {
    const a = Math.abs(signedArea(runs[i]!));
    if (a > bestArea) {
      best = runs[i]!;
      bestArea = a;
    }
  }
  return best;
}

/**
 * The full offset result as a LIST of outlines — a concave shape offset inward
 * legitimately splits into islands, and the chain's currency (multiple runs)
 * can carry them. `applyPathOpChain` routes Offset Paths through this; the
 * single-ring `offsetPath` above remains for callers wanting one outline.
 */
export function offsetPathRuns(
  pts: readonly Pt[],
  closed: boolean,
  amount: number,
  join: OffsetLineJoin = 'miter',
  miterLimit = 4,
): Pt[][] {
  if (pts.length < 2 || amount === 0) return [[...pts]];
  const src = dedupePoints(pts, closed);
  if (src.length < 2) return [[...pts]];
  const ring = offsetWithJoins(src, closed, amount, join, Math.max(1, miterLimit));
  if (!closed || ring.length < 3) return ring.length > 1 ? [ring] : [];
  return cleanClosedOffset(ring, src);
}

/** Consecutive-duplicate removal (and the closing duplicate of a closed run),
 *  so zero-length edges cannot produce NaN normals or phantom joins. */
function dedupePoints(pts: readonly Pt[], closed: boolean): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 1e-9 && Math.abs(last.y - p.y) < 1e-9) continue;
    out.push({ x: p.x, y: p.y });
  }
  if (closed && out.length > 1) {
    const a = out[0]!;
    const b = out[out.length - 1]!;
    if (Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9) out.pop();
  }
  return out;
}

function signedArea(ring: readonly Pt[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!;
    const q = ring[(i + 1) % ring.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** Intersection of two lines given as point + direction, or null when
 *  (near-)parallel. */
function lineIntersect(p1: Pt, d1: Pt, p2: Pt, d2: Pt): Pt | null {
  const denom = d1.x * d2.y - d1.y * d2.x;
  if (Math.abs(denom) < 1e-12) return null;
  const t = ((p2.x - p1.x) * d2.y - (p2.y - p1.y) * d2.x) / denom;
  return { x: p1.x + d1.x * t, y: p1.y + d1.y * t };
}

/** Longest chord a flattened ROUND join arc may span — the corner-arc budget. */
const JOIN_ARC_MAX_CHORD_PX = 2.5;

/** Edge-offset with join geometry at every interior vertex. No cleanup. */
function offsetWithJoins(
  src: readonly Pt[],
  closed: boolean,
  amount: number,
  join: OffsetLineJoin,
  miterLimit: number,
): Pt[] {
  const n = src.length;
  const edgeCount = closed ? n : n - 1;
  const dirs: Pt[] = [];
  const norms: Pt[] = [];
  for (let i = 0; i < edgeCount; i++) {
    const a = src[i]!;
    const b = src[(i + 1) % n]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    dirs.push({ x: dx / len, y: dy / len });
    norms.push({ x: -dy / len, y: dx / len });
  }
  const out: Pt[] = [];
  const joinAt = (v: Pt, e0: number, e1: number): void => {
    const n0 = norms[e0]!;
    const n1 = norms[e1]!;
    const d0 = dirs[e0]!;
    const d1 = dirs[e1]!;
    const p1: Pt = { x: v.x + n0.x * amount, y: v.y + n0.y * amount };
    const p2: Pt = { x: v.x + n1.x * amount, y: v.y + n1.y * amount };
    const cross = d0.x * d1.y - d0.y * d1.x;
    if (Math.abs(cross) < 1e-12) {
      // Collinear continuation (p1 == p2) or an exact 180° spike — either way
      // both candidate points say everything there is to say.
      out.push(p1);
      if (Math.hypot(p2.x - p1.x, p2.y - p1.y) > 1e-9) out.push(p2);
      return;
    }
    // The offset edges DIVERGE (a gap to fill with a join) when the path turns
    // away from the offset side; they CROSS (inner corner) when it turns into
    // it. Left-normal offset ⇒ the side is the sign of `amount`.
    const gap = cross * amount < 0;
    if (!gap) {
      // Inner corner: the natural vertex is where the two offset lines meet.
      // The fallback leaves both ends; the crossed loop that creates is what
      // the closed-run cleanup removes.
      const ix = lineIntersect(p1, d0, p2, d1);
      if (ix) out.push(ix);
      else out.push(p1, p2);
      return;
    }
    if (join === 'miter') {
      const ix = lineIntersect(p1, d0, p2, d1);
      // Canvas2D's rule verbatim: miter length (vertex → apex) over the offset
      // distance, cut to a bevel past the limit.
      if (ix && Math.hypot(ix.x - v.x, ix.y - v.y) <= miterLimit * Math.abs(amount)) {
        out.push(ix);
        return;
      }
      out.push(p1, p2); // bevel fallback
      return;
    }
    if (join === 'round') {
      const r = Math.abs(amount);
      const a1 = Math.atan2(p1.y - v.y, p1.x - v.x);
      const a2 = Math.atan2(p2.y - v.y, p2.x - v.x);
      // Shortest sweep — an outer join's gap is always under 180°.
      let delta = a2 - a1;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      const steps = Math.max(2, Math.min(64, Math.ceil((Math.abs(delta) * r) / JOIN_ARC_MAX_CHORD_PX)));
      for (let s = 0; s <= steps; s++) {
        const a = a1 + (delta * s) / steps;
        out.push({ x: v.x + Math.cos(a) * r, y: v.y + Math.sin(a) * r });
      }
      return;
    }
    out.push(p1, p2); // bevel
  };
  if (closed) {
    for (let i = 0; i < n; i++) joinAt(src[i]!, (i - 1 + edgeCount) % edgeCount, i);
  } else {
    out.push({ x: src[0]!.x + norms[0]!.x * amount, y: src[0]!.y + norms[0]!.y * amount });
    for (let i = 1; i < n - 1; i++) joinAt(src[i]!, i - 1, i);
    const lastN = norms[edgeCount - 1]!;
    out.push({ x: src[n - 1]!.x + lastN.x * amount, y: src[n - 1]!.y + lastN.y * amount });
  }
  return out;
}

/**
 * Closed-run cleanup. Convex sources need none going outward and can only
 * collapse going inward (area sign flip ⇒ gone). Non-convex ones go through a
 * union-with-self, which resolves the crossed loops a pinched inner corner
 * leaves — the loops wind the other way, so the nonzero union drops them —
 * and splits a shape offset past a waist into its real islands.
 */
function cleanClosedOffset(ring: Pt[], src: readonly Pt[]): Pt[][] {
  const n = src.length;
  let sawPos = false;
  let sawNeg = false;
  for (let i = 0; i < n; i++) {
    const a = src[i]!;
    const b = src[(i + 1) % n]!;
    const c = src[(i + 2) % n]!;
    const cr = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (cr > 1e-9) sawPos = true;
    else if (cr < -1e-9) sawNeg = true;
  }
  if (!(sawPos && sawNeg)) {
    // Convex. Collapsed ⇒ nothing survives (AE: a shape offset past its own
    // inradius disappears). The tell is an EDGE REVERSING against its source
    // — an area-sign test alone misses the square shrunk past centre, whose
    // ring inverts through BOTH axes and comes back positively wound.
    const a1 = signedArea(ring);
    if (Math.abs(a1) < 1e-6) return [];
    if (ring.length === n) {
      for (let i = 0; i < n; i++) {
        const sa = src[i]!;
        const sb = src[(i + 1) % n]!;
        const ra = ring[i]!;
        const rb = ring[(i + 1) % n]!;
        if ((sb.x - sa.x) * (rb.x - ra.x) + (sb.y - sa.y) * (rb.y - ra.y) < 0) return [];
      }
    } else if (signedArea(src) * a1 < 0) {
      return [];
    }
    return [ring];
  }
  // Split the ring at its own crossings and keep only the loops wound like
  // the SOURCE. This is the honest version of "offset then clean": the loops
  // a pinched corner or a vanished limb leave behind are traversed the other
  // way round, so winding is exactly the property that separates real area
  // from inverted residue. (polygon-clipping's union cannot be handed the
  // crossed ring directly — it resolves self-intersections even-odd, which
  // KEEPS the flipped loop as an island.)
  const want = signedArea(src) >= 0 ? 1 : -1;
  const kept = splitRingAtSelfIntersections(ring).filter((l) => {
    const a = signedArea(l);
    return Math.abs(a) > 1e-6 && (a >= 0 ? 1 : -1) === want;
  });
  if (kept.length <= 1) return kept;
  try {
    // Several surviving loops can overlap (two limbs offset outward into each
    // other); each is simple now, so the clipper's input contract holds.
    const polys = kept.map((l) => {
      const r: Array<[number, number]> = l.map((p) => [p.x, p.y]);
      r.push([l[0]!.x, l[0]!.y]);
      return [r];
    });
    const result = polygonClipping.union(polys[0]!, ...polys.slice(1));
    const out: Pt[][] = [];
    for (const poly of result) {
      for (const r of poly) {
        const pts: Pt[] = r.map((pair) => ({ x: pair[0]!, y: pair[1]! }));
        // polygon-clipping closes its rings explicitly; the chain's runs do not.
        const first = pts[0];
        const last = pts[pts.length - 1];
        if (first && last && Math.abs(first.x - last.x) < 1e-9 && Math.abs(first.y - last.y) < 1e-9) pts.pop();
        if (pts.length >= 3 && Math.abs(signedArea(pts)) > 1e-6) out.push(pts);
      }
    }
    return out.length > 0 ? out : kept;
  } catch {
    // Degenerate geometry the clipper refuses: hand back the kept loops
    // rather than losing the shape.
    return kept;
  }
}

/**
 * Split a (possibly self-crossing) ring into SIMPLE loops at its own
 * intersection points: every proper segment crossing is inserted into the
 * point sequence, then a stack walk pops a loop each time a point repeats.
 * Pure; O(n²) pair scan with a bbox reject, which offset rings (hundreds of
 * points) absorb comfortably.
 */
function splitRingAtSelfIntersections(ring: readonly Pt[]): Pt[][] {
  const n = ring.length;
  const inserts: Array<Array<{ t: number; x: number; y: number }>> = Array.from({ length: n }, () => []);
  let any = false;
  for (let i = 0; i < n; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % n]!;
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // adjacent around the wrap
      const c = ring[j]!;
      const d = ring[(j + 1) % n]!;
      if (
        Math.max(a.x, b.x) < Math.min(c.x, d.x) || Math.max(c.x, d.x) < Math.min(a.x, b.x)
        || Math.max(a.y, b.y) < Math.min(c.y, d.y) || Math.max(c.y, d.y) < Math.min(a.y, b.y)
      ) continue;
      const hit = properSegIntersect(a, b, c, d);
      if (!hit) continue;
      inserts[i]!.push({ t: hit.t, x: hit.x, y: hit.y });
      inserts[j]!.push({ t: hit.u, x: hit.x, y: hit.y });
      any = true;
    }
  }
  if (!any) return [[...ring]];
  const seq: Pt[] = [];
  for (let i = 0; i < n; i++) {
    seq.push(ring[i]!);
    const ins = inserts[i]!;
    ins.sort((p, q) => p.t - q.t);
    for (const e of ins) seq.push({ x: e.x, y: e.y });
  }
  const loops: Pt[][] = [];
  const stack: Pt[] = [];
  const index = new Map<string, number>();
  const key = (p: Pt): string => `${Math.round(p.x * 1e6)}:${Math.round(p.y * 1e6)}`;
  for (const p of seq) {
    const k = key(p);
    const at = index.get(k);
    if (at !== undefined) {
      const loop = stack.splice(at);
      for (const q of loop) index.delete(key(q));
      if (loop.length >= 3) loops.push(loop);
    }
    index.set(k, stack.length);
    stack.push(p);
  }
  if (stack.length >= 3) loops.push(stack);
  return loops;
}

/** Proper (interior) crossing of segments ab × cd, with both parameters. */
function properSegIntersect(
  a: Pt, b: Pt, c: Pt, d: Pt,
): { x: number; y: number; t: number; u: number } | null {
  const rx = b.x - a.x;
  const ry = b.y - a.y;
  const sx = d.x - c.x;
  const sy = d.y - c.y;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-12) return null;
  const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / denom;
  const u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / denom;
  const e = 1e-9;
  if (t <= e || t >= 1 - e || u <= e || u >= 1 - e) return null;
  return { x: a.x + rx * t, y: a.y + ry * t, t, u };
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
/**
 * The temporal noise both wiggling operators sample — Roughen per point,
 * Wiggle Transform per run. Extracted verbatim from `roughen` (the constants
 * and the smoothstep are byte-identical, which its determinism tests pin), so
 * "what a wiggle sounds like" is written down exactly once.
 *
 * Deterministic hash — no Math.random, so preview and export agree and a
 * scrub back to the same frame redraws the same shape. Mixing the time bucket
 * `k` and `seed` into the hash (rather than perturbing the index) keeps
 * neighbouring indices uncorrelated at every instant. `ch` selects a CHANNEL
 * of the same field, so every channel inherits the seed and the cross-fade
 * with no second copy of this machinery.
 *
 * The returned sampler cross-fades between whole-numbered noise fields so a
 * value travels between random configurations instead of snapping. `phase` is
 * already time × wiggles-per-second, so phase 0 collapses to a static hash.
 * Outputs stay in [-1, 1]: a lerp between two bounded values is bounded, which
 * is what lets callers promise "amplitude is the most it can move".
 */
function temporalNoise(phase: number, seed: number): (i: number, ch?: number) => number {
  const hash = (i: number, k: number, ch = 0): number => {
    let h = (i + 1) * 374761393 + k * 668265263 + seed * 2246822519 + ch * 2654435761;
    h = (h ^ (h >>> 13)) * 1274126177;
    return (((h ^ (h >>> 16)) >>> 0) / 4294967296) * 2 - 1;
  };
  const k0 = Math.floor(phase);
  const frac = phase - k0;
  const smooth = frac * frac * (3 - 2 * frac);
  return (i: number, ch = 0): number => {
    if (smooth === 0) return hash(i, k0, ch);
    return hash(i, k0, ch) + (hash(i, k0 + 1, ch) - hash(i, k0, ch)) * smooth;
  };
}

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
  const rnd = temporalNoise(phase, seed);
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
      return offsetPath(pts, closed, op.amount, op.lineJoin ?? 'miter', op.miterLimit ?? 4);
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
  return renderComponentsOf(node).find((c) => c.type === 'fx')?.props as Record<string, unknown> | undefined;
}

const PATH_OP_TYPES: readonly PathOpType[] = ['none', 'zigzag', 'roundCorners', 'pucker', 'twist', 'offset', 'roughen', 'trim', 'repeater', 'wiggleTransform'];

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
    // Wiggle Transform's two amplitudes. 0 = no wiggle on that channel, which
    // makes a malformed stored entry inert rather than jittery.
    wiggleRotation: Math.max(0, num(o.wiggleRotation, 0)),
    wiggleScale: Math.max(0, num(o.wiggleScale, 0)),
    // Offset Paths' joins. Miter/4 are the defaults AE uses, and on ordinary
    // corners they are indistinguishable from the pre-join naive offset, so a
    // stored op without the fields renders as it did.
    lineJoin: o.lineJoin === 'round' || o.lineJoin === 'bevel' ? o.lineJoin : 'miter',
    miterLimit: Math.max(1, num(o.miterLimit, 4)),
    start: num(o.start, 0),
    end: num(o.end, 100),
    offset: num(o.offset, 0),
    trimMultipleShapes: o.trimMultipleShapes === 'individually' ? 'individually' : 'simultaneously',
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
    correlation: Math.max(0, Math.min(100, v('correlation', op.correlation ?? 0))),
    // Amplitudes cannot be negative — a keyframe dipping below zero would
    // double back on itself rather than mean anything.
    wiggleRotation: Math.max(0, v('wiggleRotation', op.wiggleRotation ?? 0)),
    wiggleScale: Math.max(0, v('wiggleScale', op.wiggleScale ?? 0)),
    // Discrete — never sampled. The miter cap IS sampled (AE animates it) and
    // floored at 1, below which a miter join cannot exist.
    lineJoin: op.lineJoin === 'round' || op.lineJoin === 'bevel' ? op.lineJoin : 'miter',
    miterLimit: Math.max(1, v('miterLimit', op.miterLimit ?? 4)),
    // Trim's three, sampled the same way. NOT clamped: `offset` wraps by
    // design, and start/end past 0..100 is how a draw-on overshoots and
    // settles — `trimSegments` already normalizes the window.
    start: v('start', op.start ?? 0),
    end: v('end', op.end ?? 100),
    offset: v('offset', op.offset ?? 0),
    // Discrete — never sampled. Absent means AE's default, simultaneously.
    trimMultipleShapes: op.trimMultipleShapes === 'individually' ? 'individually' : 'simultaneously',
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
    .filter((op) => op.type !== 'none' && !isInertTrim(op) && !isInertRepeater(op) && !isInertWiggleTransform(op));
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
 * A Wiggle Transform with every amplitude at zero. Dropped for the reason the
 * other inert forms are: a live chain converts the layer's primitive to an
 * explicit path, and an operator moving nothing must not square off a rounded
 * rect as its only visible effect.
 */
function isInertWiggleTransform(op: PathOp): boolean {
  return op.type === 'wiggleTransform'
    && op.amount <= 0 && (op.wiggleRotation ?? 0) <= 0 && (op.wiggleScale ?? 0) <= 0;
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

function polylineLength(pts: readonly Pt[], closed: boolean): number {
  const n = pts.length;
  if (n < 2) return 0;
  const count = closed ? n : n - 1;
  let total = 0;
  for (let i = 0; i < count; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return total;
}

/**
 * Cut every run down to a trim's visible arcs.
 *
 * `simultaneously` (AE's default): each run is trimmed by the same
 * percentages at once. Three bars then grow together.
 *
 * `individually`: the runs are trimmed one after another as one concatenated
 * length, so the window walks the first shape, then the second — lottie-web's
 * `m: 2`, and what a staggered reveal of several outlines wants.
 *
 * Outputs of a partial cut are always OPEN: a cut arc closed by the stroke
 * would draw a chord back to its own start. A run that lands fully inside
 * the window keeps its own `closed`, so a finished bar stays a filled
 * rectangle rather than gaining a chord.
 */
function applyTrim(runs: readonly PolyRun[], op: PathOp): PolyRun[] {
  const segs = trimSegments(op.start ?? 0, op.end ?? 100, op.offset ?? 0);
  // The full range is a no-op, and must stay one: it has to leave a closed
  // outline closed, or adding an untouched Trim card would visibly open the
  // shape's stroke.
  if (segs.length === 1 && segs[0]![0] === 0 && segs[0]![1] === 1) return [...runs];
  if (op.trimMultipleShapes === 'individually' && runs.length > 1) {
    return applyTrimIndividually(runs, segs);
  }
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
 * Trim the concatenation: each run occupies a slice of the combined
 * arc-length, so a 0→100 end on three equal bars reveals them one after
 * another instead of all three at once — AE's "Individually".
 */
function applyTrimIndividually(
  runs: readonly PolyRun[],
  segs: ReadonlyArray<readonly [number, number]>,
): PolyRun[] {
  const lens = runs.map((r) => polylineLength(r.pts, r.closed));
  const total = lens.reduce((a, b) => a + b, 0);
  if (total <= 0) return [];
  const out: PolyRun[] = [];
  for (const [lo, hi] of segs) {
    const startLen = lo * total;
    const endLen = hi * total;
    if (endLen <= startLen) continue;
    let acc = 0;
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i]!;
      const runLen = lens[i]!;
      const runStart = acc;
      const runEnd = acc + runLen;
      acc = runEnd;
      if (runLen <= 0) continue;
      const a = Math.max(startLen, runStart);
      const b = Math.min(endLen, runEnd);
      if (b <= a) continue;
      const localLo = (a - runStart) / runLen;
      const localHi = (b - runStart) / runLen;
      if (localLo <= 1e-9 && localHi >= 1 - 1e-9) {
        // This run sits entirely inside the window — keep it closed so a
        // finished bar stays a filled rectangle.
        out.push({ ...run, pts: [...run.pts] });
        continue;
      }
      for (const cut of trimPolyline(run.pts, run.closed, [[localLo, localHi]])) {
        out.push({ pts: cut, closed: false, opacity: run.opacity, strokeScale: run.strokeScale });
      }
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
 * Wiggle Transform — AE's shape operator of the same name. Each RUN gets one
 * smoothly-varying random affine transform: translate by up to ±`amount` px
 * per axis, rotate by up to ±`wiggleRotation`°, scale by up to ±`wiggleScale`%
 * — rotation and scale pivoting on (`anchorX`, `anchorY`).
 *
 * Chain-level (like Trim and the Repeater) rather than per-point, because the
 * run index IS the identity the noise hashes on — which is what makes the
 * classic AE combo work here with the orders reversed from a deformer's
 * indifference: Repeater THEN Wiggle Transform gives every copy its own
 * independent wander (each copy is its own run); Wiggle Transform then
 * Repeater moves the ladder as one body (one run wiggles, then is copied).
 *
 * `correlation` blends each run's noise toward one shared value (index -1,
 * per channel — the same construction Roughen uses per point), so the swarm
 * can be dialed continuously into a school of fish.
 *
 * The transform is baked into geometry, so `strokeScale` carries the scale
 * factor exactly as the Repeater's does — a wiggled-small copy must not draw
 * with its original stroke width.
 */
function applyWiggleTransform(runs: readonly PolyRun[], op: PathOp, timeSec: number): PolyRun[] {
  const pos = Math.max(0, op.amount);
  const rotAmp = Math.max(0, op.wiggleRotation ?? 0);
  const sclAmp = Math.max(0, op.wiggleScale ?? 0);
  const rnd = temporalNoise(timeSec * (op.wigglesPerSecond ?? 0), op.seed ?? 0);
  const c = Math.max(0, Math.min(100, op.correlation ?? 0)) / 100;
  const n = (i: number, ch: number): number => {
    const own = rnd(i, ch);
    return c === 0 ? own : own + (rnd(-1, ch) - own) * c;
  };
  const ax = op.anchorX ?? 0;
  const ay = op.anchorY ?? 0;
  return runs.map((r, i) => {
    const dx = pos * n(i, 0);
    const dy = pos * n(i, 1);
    const ang = rotAmp * n(i, 2) * DEG;
    // Scale is clamped at 0 rather than allowed to mirror: an amplitude past
    // 100% flipping copies inside-out reads as a glitch, not as more wiggle.
    const s = Math.max(0, 1 + (sclAmp / 100) * n(i, 3));
    const cos = Math.cos(ang) * s;
    const sin = Math.sin(ang) * s;
    return {
      closed: r.closed,
      pts: r.pts.map((p): Pt => ({
        x: (p.x - ax) * cos - (p.y - ay) * sin + ax + dx,
        y: (p.x - ax) * sin + (p.y - ay) * cos + ay + dy,
      })),
      opacity: r.opacity,
      strokeScale: (r.strokeScale ?? 1) * s,
    };
  });
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
    if (op.type === 'wiggleTransform') {
      out = applyWiggleTransform(out, op, timeSec);
      continue;
    }
    if (op.type === 'offset') {
      // Chain-level rather than per-run-in-place because an offset can change
      // the RUN COUNT: a concave shape offset past a waist splits into
      // islands, and a convex one offset past its inradius vanishes. Paint
      // (`opacity`/`strokeScale`) rides onto every piece of its source run.
      out = out.flatMap((r) =>
        offsetPathRuns(r.pts, r.closed, op.amount, op.lineJoin ?? 'miter', op.miterLimit ?? 4)
          .filter((pts) => pts.length > 1)
          .map((pts) => ({ ...r, pts })),
      );
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
