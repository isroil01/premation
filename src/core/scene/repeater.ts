/**
 * Shape Repeater — duplicate a layer into N copies,
 * each offset from the previous by a transform. Composed iteratively (AE-style)
 * so a rotation offset makes the copies sweep an arc/circle/spiral rather than
 * a straight line — the core of generative motion graphics.
 *
 * This module is the LADDER and nothing else: pure, and the single definition
 * of where a repeater's copies go. Since document version 1.5.0 the repeater is
 * an entry in the `fx.pathOps` chain, so its config, its keyframe paths
 * (`pathop.<id>.<param>`) and its scene writers all live in `pathOps.ts`
 * alongside every other operator's. See the note at the foot of this file.
 */


export interface Repeater {
  /** Number of copies (includes the original). */
  copies: number;
  /** Per-copy position offset, layer-local px (comp px before 1.5.0). */
  offsetX: number;
  offsetY: number;
  /** Per-copy rotation offset, degrees (drives arcs/spirals). */
  offsetRotation: number;
  /** Per-copy scale multiplier (1 = no change). */
  offsetScale: number;
  /** Per-copy opacity multiplier (1 = no change). */
  offsetOpacity: number;
  /**
   * AE's Repeater "Offset" — shift the whole transform ladder by this many
   * copies, so copy 0 starts part-way along it. Fractional and negative values
   * are allowed (a fractional offset interpolates between rungs), which is what
   * lets a repeater be animated to march along its own path.
   */
  offset?: number;
  /**
   * Pivot for the per-copy rotation and scale, in layer-local px. Zero (the
   * default, and everything authored before this existed) pivots each copy
   * about its own origin — which is why a rotation offset used to trace a
   * circle of one fixed radius and nothing else.
   */
  anchorX?: number;
  anchorY?: number;
  /**
   * Whether the copies stack above or below the original.
   *
   * Defaults to `'above'`, which is what this renderer has always done — NOT
   * AE's default of `'below'`. Matching AE here would silently restack every
   * existing repeater, so the AE default is offered, not imposed.
   */
  composite?: RepeaterComposite;
}

export type RepeaterComposite = 'above' | 'below';

export interface RepeaterCopy {
  index: number;
  /** Cumulative offset from the base layer, in the geometry's own space. */
  dx: number;
  dy: number;
  /** Cumulative rotation offset, degrees. */
  drot: number;
  /** Cumulative scale / opacity multipliers. */
  scaleMul: number;
  opacityMul: number;
}

export function defaultRepeater(): Repeater {
  return {
    copies: 6, offsetX: 80, offsetY: 0, offsetRotation: 0, offsetScale: 1, offsetOpacity: 1,
    offset: 0, anchorX: 0, anchorY: 0, composite: 'above',
  };
}

const DEG = Math.PI / 180;

/**
 * One rung of the transform ladder, at an INTEGER rung number (which may be
 * negative — a negative Offset walks the ladder backwards). Each step adds the
 * offset *in its accumulated rotation frame*, so a pure rotation offset traces
 * a regular polygon / circle. Pure.
 */
function ladderAtInteger(rep: Repeater, k: number): RepeaterCopy {
  let x = 0;
  let y = 0;
  let rot = 0;
  let scale = 1;
  let op = 1;
  const steps = Math.abs(k);
  const dir = k < 0 ? -1 : 1;
  for (let i = 0; i < steps; i++) {
    if (dir > 0) {
      rot += rep.offsetRotation;
      const rad = rot * DEG;
      x += rep.offsetX * Math.cos(rad) - rep.offsetY * Math.sin(rad);
      y += rep.offsetX * Math.sin(rad) + rep.offsetY * Math.cos(rad);
      scale *= rep.offsetScale;
      op *= rep.offsetOpacity;
    } else {
      // Exact inverse of a forward step, so ladderAtInteger(-1) undoes
      // ladderAtInteger(1) rather than approximating it.
      const rad = rot * DEG;
      x -= rep.offsetX * Math.cos(rad) - rep.offsetY * Math.sin(rad);
      y -= rep.offsetX * Math.sin(rad) + rep.offsetY * Math.cos(rad);
      rot -= rep.offsetRotation;
      scale = rep.offsetScale === 0 ? 0 : scale / rep.offsetScale;
      op = rep.offsetOpacity === 0 ? 0 : op / rep.offsetOpacity;
    }
  }
  return { index: k, dx: x, dy: y, drot: rot, scaleMul: scale, opacityMul: op };
}

/**
 * The ladder at any real rung. Between rungs it interpolates, so an animated
 * Offset slides the copies smoothly along the ladder instead of stepping.
 */
function ladderAt(rep: Repeater, k: number): RepeaterCopy {
  const lo = Math.floor(k);
  const f = k - lo;
  const a = ladderAtInteger(rep, lo);
  if (f === 0) return a;
  const b = ladderAtInteger(rep, lo + 1);
  const mix = (u: number, v: number): number => u + (v - u) * f;
  return {
    index: k,
    dx: mix(a.dx, b.dx),
    dy: mix(a.dy, b.dy),
    drot: mix(a.drot, b.drot),
    scaleMul: mix(a.scaleMul, b.scaleMul),
    opacityMul: mix(a.opacityMul, b.opacityMul),
  };
}

/**
 * Cumulative per-copy transforms, in PAINT ORDER — index 0 first.
 *
 * With `composite: 'below'` the list is reversed, so the ladder still runs
 * 0..n-1 but the original ends up painted last (on top). The caller emits in
 * list order and does not need to know which mode is active: one reader.
 */
export function repeaterCopies(rep: Repeater): RepeaterCopy[] {
  const n = Math.max(1, Math.floor(rep.copies));
  const start = rep.offset ?? 0;
  const ax = rep.anchorX ?? 0;
  const ay = rep.anchorY ?? 0;
  const out: RepeaterCopy[] = [];
  for (let i = 0; i < n; i++) {
    const rung = ladderAt(rep, i + start);
    // Pivot the copy's rotation/scale about the repeater anchor instead of the
    // layer origin. Rotating a point about A is A + R(p − A); the layer origin
    // is p = 0, so the whole correction is the translation A − R·s·A. It
    // vanishes at A = 0, which is why an existing repeater is untouched.
    if (ax !== 0 || ay !== 0) {
      const rad = rung.drot * DEG;
      const c = Math.cos(rad) * rung.scaleMul;
      const s = Math.sin(rad) * rung.scaleMul;
      rung.dx += ax - (c * ax - s * ay);
      rung.dy += ay - (s * ax + c * ay);
    }
    rung.index = i;
    out.push(rung);
  }
  if (rep.composite === 'below') out.reverse();
  return out;
}

// ── Scene integration: NONE, deliberately ────────────────────────────
//
// This module used to own `readRepeaterConfig` / `resolveRepeater` /
// `setRepeater` / `updateRepeater` / `repeaterPropPath`, all reading and
// writing the `fx.repeater` key with keyframes under `rep.<param>`. Document
// version 1.5.0 folded the repeater into the `fx.pathOps` chain, so all of
// that lives in `pathOps.ts` alongside every other operator's — one place
// where "what an operator is" is written down.
//
// They are DELETED rather than left as thin forwarders. A reader of a key
// nothing writes any more is not a compatibility shim, it is a function that
// silently returns null: `updateRepeater` would have read its base config as
// absent, fallen back to `defaultRepeater()` and reset every parameter the
// caller did not name.
//
// What stays here is the LADDER — pure, tested, and the single definition of
// what a repeater's copies are — plus the config shape the chain entry carries
// and the migration converts into.
