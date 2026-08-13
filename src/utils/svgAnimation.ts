/**
 * SMIL (`<animate>` / `<animateTransform>` / `<set>`) → keyframes.
 *
 * An animated SVG used to import as a flat image: the parser could read its
 * shapes but nothing read its animation, so a file that visibly moved in the
 * Assets grid froze on frame 0 in the scene and could not be edited.
 *
 * The translation is done by SAMPLING, not by mapping each SMIL element onto a
 * property one-for-one. At a given time the element's full matrix is rebuilt
 * with the animated values substituted in, and compared against the STATIC
 * matrix the parser already baked into the points:
 *
 *     D(t) = A(t) · S⁻¹
 *
 * `D` maps baked coordinates to animated ones, so decomposing it gives the
 * node's position, rotation and scale directly. Doing it this way is what makes
 * `rotate(a, cx, cy)` (rotation about a point, not the node's anchor), stacked
 * `animateTransform`s, and animation inherited from an ancestor `<g>` all fall
 * out for free instead of each needing a special case.
 *
 * Deliberately NOT supported, because they have no honest mapping onto a
 * transform + opacity model: `animateMotion` along a path, colour/paint
 * animation, geometry morphs (`r`, `d`), and `begin` values that depend on
 * events or on other animations (`click`, syncbase). `unsupported` names what
 * was skipped so the importer can say so out loud rather than quietly dropping
 * half a file.
 */

import { type Mat, type MatrixFactor, matMul, matInvert, applyMat, parseTransform } from './svgParser';
import { readCssAnimations, type CssAnimation } from './svgCss';

/** One sampled keyframe: comp seconds → value. */
export interface SvgKeyframe {
  time: number;
  value: number;
  /** Step (SMIL `calcMode="discrete"` and `<set>`) rather than interpolated. */
  hold?: boolean;
}

/** Keyframe tracks for one shape, in the node's own property space. */
export interface SvgShapeAnimation {
  /** Offsets from the shape's static position, in SVG user units. */
  x?: SvgKeyframe[];
  y?: SvgKeyframe[];
  /** Degrees. */
  rotation?: SvgKeyframe[];
  /** Multipliers on the shape's baked size (1 = unchanged). */
  scaleX?: SvgKeyframe[];
  scaleY?: SvgKeyframe[];
  /** Percent (0-100), matching the Style component. */
  opacity?: SvgKeyframe[];
  /**
   * Draw-on progress as a trim-path END percent (0 = nothing drawn).
   *
   * `stroke-dashoffset` sliding against an equal `stroke-dasharray` is how
   * nearly every "line draws itself" SVG works, and it maps EXACTLY onto the
   * engine's trim path (AE's Trim Paths): visible fraction = 1 − offset/dash.
   * Translating it as opacity or position would be a lie; translating it as
   * trim is the same effect by construction.
   */
  trimEnd?: SvgKeyframe[];
  /** End of the last animation on this shape, in seconds. */
  duration: number;
  /**
   * The tracks hold ONE cycle and repeat forever via a `loopOut` expression.
   *
   * `'cycle'` replays the baked cycle unchanged, which is exactly what SMIL and
   * CSS repeats do — every iteration restarts from the first value. `'pingpong'`
   * reflects, matching CSS `animation-direction: alternate`.
   *
   * NOT `'offset'`, which accumulates each cycle's delta. That is tempting
   * because it makes a spin's angle climb monotonically, but it is only right
   * for a spin: applied to the same file's opacity or position it would ramp
   * past the authored range forever instead of restarting. `'cycle'` needs no
   * such exception — a rotation is periodic, so replaying 0°→360° reads as one
   * continuous turn anyway.
   */
  loop?: 'cycle' | 'pingpong';
}

const SMIL_TAGS = new Set(['animate', 'animatetransform', 'set', 'animatemotion']);

/** Times finer than this are the same keyframe. */
const TIME_EPS = 1e-4;
/** Samples per segment when a spline eases between two values. */
const SPLINE_SAMPLES = 6;
/**
 * How far before a repeat boundary the iteration's final value is captured.
 *
 * A whole millisecond, because in the UNROLLED path this becomes its own
 * keyframe and has to stay clear of the boundary keyframe next to it — the two
 * together are what make a repeat read as a sawtooth instead of a slow ramp.
 */
const RESTART_EPS = 1 / 1000;

/**
 * How far before the end of a BAKED cycle its final value is read.
 *
 * Far smaller than `RESTART_EPS` because nothing here needs to be visible as a
 * separate keyframe — it only has to dodge the instant the loop restarts. The
 * size matters: `loopOut('offset')` multiplies the cycle's delta by the loop
 * count, so a shortfall does not stay small, it accumulates. Reading a
 * millisecond early cost a 360° spin 0.7° per cycle, which is 14° adrift after
 * ten seconds and reads as a spinner running slow.
 */
const CYCLE_END_EPS = 1e-6;
/**
 * How long an `indefinite`/large repeat is unrolled for when the caller does
 * not say. Callers that know the composition duration should pass it — sixty
 * seconds of a one-second loop is sixty times more keyframes than a ten-second
 * comp can ever play.
 */
const MAX_UNROLL_SECONDS = 60;

/**
 * Largest angular step between rotation samples, in degrees.
 *
 * These samples do not approximate a curve — a constant-rate spin is exactly
 * linear in the unwrapped angle, and simplification collapses it back to two
 * keyframes afterwards. They exist ONLY so `decompose`'s `atan2` readback can
 * be unwrapped, which needs consecutive samples under half a turn. 90° keeps a
 * wide margin at a quarter of the sample count 45° produced.
 */
const MAX_ROTATION_STEP_DEG = 90;

/**
 * Rotation step when only ONE cycle is being baked.
 *
 * A rotation about a distant point orbits the shape, and the orbit is carried
 * by the x/y tracks, which interpolate in straight lines — sample every 90° and
 * a circular orbit plays back as a square. Baking a single cycle makes accuracy
 * affordable: 15° is a 0.9% chord error at half the artboard's radius, and
 * simplification deletes the extra samples again wherever the shape sits on the
 * rotation centre and does not actually travel.
 */
const CYCLE_ROTATION_STEP_DEG = 15;

/**
 * How closely a simplified track must follow the sampled one.
 *
 * Per property, in that property's own units: SVG user units for position
 * (which are then multiplied by the group's scale factor), degrees, scale
 * multipliers, and opacity percent.
 */
const SIMPLIFY_TOLERANCE = {
  x: 0.05,
  y: 0.05,
  rotation: 0.2,
  scaleX: 0.002,
  scaleY: 0.002,
  opacity: 0.2,
} as const;

interface SmilAnim {
  el: Element;
  /**
   * The element this animation drives.
   *
   * For SMIL that is the animation element's parent; CSS animations have no
   * element of their own, so the two kinds are only interchangeable once the
   * link is explicit rather than read back through `parentElement`.
   */
  target: Element;
  /** 'transform' for animateTransform, else the attributeName. */
  attr: string;
  /** translate | scale | rotate | skewX | skewY, or 'css' for a CSS transform list. */
  transformType: string;
  begin: number;
  /** One iteration, seconds. */
  dur: number;
  /** Total active duration (dur × repeat), seconds. */
  active: number;
  /** Value lists — numbers per keyframe (2-3 wide for transforms). */
  values: number[][];
  /** Normalised 0..1 times, same length as `values`. */
  keyTimes: number[];
  discrete: boolean;
  spline: boolean;
  /** Value keeps its final value after the animation ends. */
  freeze: boolean;
  additive: boolean;
  /**
   * The animation never ends; `active` is only how far it was unrolled.
   *
   * Without this the unroll boundary reads as a genuine end, so the very last
   * sample snaps back to the base value — a spinner that jerks to a stop.
   */
  infinite?: boolean;
  /** CSS `animation-direction` (SMIL has no equivalent). */
  alternate?: boolean;
  reverse?: boolean;
  /** Rotation/scale centre for a CSS transform, in the element's user space. */
  origin?: { x: number; y: number };
  /** CSS `animation-timing-function`, as a 0..1 → 0..1 progress map. */
  ease?: (f: number) => number;
}

/** Where the rotation angle sits in an animation's value tuple, or -1. */
function rotationIndex(a: SmilAnim): number {
  if (a.transformType === 'rotate') return 0;
  if (a.transformType === 'css') return 2;
  return -1;
}

function parseClock(v: string | null | undefined): number | null {
  if (!v) return null;
  const s = v.trim();
  if (s === 'indefinite') return null;
  // h:mm:ss / mm:ss forms.
  if (s.includes(':')) {
    const parts = s.split(':').map(Number);
    if (parts.some((n) => !Number.isFinite(n))) return null;
    return parts.reduce((acc, n) => acc * 60 + n, 0);
  }
  const m = /^(-?[\d.]+)\s*(ms|s|min|h)?$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  switch (m[2]) {
    case 'ms': return n / 1000;
    case 'min': return n * 60;
    case 'h': return n * 3600;
    default: return n;
  }
}

function numberList(v: string | null): number[] {
  if (!v) return [];
  return (v.match(/-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) ?? []).map(Number).filter((n) => Number.isFinite(n));
}

/** Split a `values="a; b; c"` list into per-keyframe number tuples. */
function valueTuples(v: string | null): number[][] {
  if (!v) return [];
  return v.split(';').map((part) => numberList(part)).filter((t) => t.length > 0);
}

/**
 * Read one SMIL element into a normalised form, or null when it is something we
 * do not translate (its name is reported through `unsupported` instead).
 */
function readAnim(el: Element, unsupported: Set<string>, unrollSeconds: number): SmilAnim | null {
  const tag = el.tagName.toLowerCase().replace(/^svg:/, '');
  if (tag === 'animatemotion') {
    unsupported.add('animateMotion');
    return null;
  }

  const beginRaw = el.getAttribute('begin');
  // `begin="click"` / `begin="other.end"` are interactive or dependent timing,
  // not a clock we can bake into keyframes.
  if (beginRaw && parseClock(beginRaw) === null && beginRaw.trim() !== 'indefinite') {
    unsupported.add(`begin="${beginRaw.trim()}"`);
    return null;
  }
  const begin = parseClock(beginRaw) ?? 0;

  const isTransform = tag === 'animatetransform';
  const attr = isTransform ? 'transform' : (el.getAttribute('attributeName') ?? '').trim();
  const transformType = isTransform ? (el.getAttribute('type') ?? 'translate').trim().toLowerCase() : '';

  const SCALAR_ATTRS = new Set(['opacity', 'fill-opacity', 'stroke-dashoffset']);
  if (!isTransform && tag !== 'set' && !SCALAR_ATTRS.has(attr)) {
    unsupported.add(attr || tag);
    return null;
  }
  if (tag === 'set' && !SCALAR_ATTRS.has(attr)) {
    unsupported.add(attr || 'set');
    return null;
  }

  // `<set>` is a single held value for its whole duration.
  if (tag === 'set') {
    const to = numberList(el.getAttribute('to'));
    if (to.length === 0) return null;
    const d = parseClock(el.getAttribute('dur')) ?? 0;
    return {
      el, target: el.parentElement as Element, attr, transformType,
      begin, dur: Math.max(d, 0), active: Math.max(d, 0),
      values: [to, to], keyTimes: [0, 1], discrete: true, spline: false,
      freeze: (el.getAttribute('fill') ?? 'remove') === 'freeze', additive: false,
    };
  }

  const dur = parseClock(el.getAttribute('dur'));
  if (dur === null || dur <= 0) {
    unsupported.add(`dur="${el.getAttribute('dur') ?? 'indefinite'}"`);
    return null;
  }

  let values = valueTuples(el.getAttribute('values'));
  if (values.length === 0) {
    const from = numberList(el.getAttribute('from'));
    const to = numberList(el.getAttribute('to'));
    const by = numberList(el.getAttribute('by'));
    if (to.length > 0) {
      values = [from.length > 0 ? from : to.map(() => 0), to];
      // A bare `to` with no `from` animates from the element's current value.
      // The static transform IS that value, and D(t) is measured against it, so
      // starting from the identity delta is the correct baseline here.
      if (from.length === 0) values[0] = identityFor(transformType, to.length);
    } else if (by.length > 0) {
      values = [identityFor(transformType, by.length), by.map((n, i) => n + (identityFor(transformType, by.length)[i] ?? 0))];
    } else {
      return null;
    }
  }
  if (values.length < 2) return null;

  const rawKeyTimes = numberList(el.getAttribute('keyTimes'));
  const keyTimes = rawKeyTimes.length === values.length
    ? rawKeyTimes
    : values.map((_, i) => i / (values.length - 1));

  const calcMode = (el.getAttribute('calcMode') ?? 'linear').trim().toLowerCase();
  const repeatRaw = (el.getAttribute('repeatCount') ?? '').trim();
  const repeatDur = parseClock(el.getAttribute('repeatDur'));
  let active = dur;
  const infinite = repeatRaw === 'indefinite';
  if (infinite) active = unrollSeconds;
  else if (repeatRaw && Number.isFinite(Number(repeatRaw))) active = dur * Number(repeatRaw);
  if (repeatDur !== null) active = repeatDur;
  // The unroll budget is measured from t=0, so a delayed animation gets less of
  // it: keyframes past the end of the composition can never play.
  const budget = Math.max(0, unrollSeconds - Math.max(0, begin));
  // A FINITE animation that runs past the composition is genuinely cut short,
  // and re-importing into a longer comp is the only way to get the rest — an
  // endless one hitting the same ceiling is just the loop being baked, which is
  // by design and must not be reported as a loss.
  if (!infinite && active > budget + TIME_EPS) {
    unsupported.add('the end of an animation longer than the composition');
  }
  active = Math.min(active, budget);

  return {
    el, target: el.parentElement as Element, attr, transformType, begin, dur, active, values, keyTimes,
    discrete: calcMode === 'discrete',
    spline: calcMode === 'spline',
    freeze: (el.getAttribute('fill') ?? 'remove') === 'freeze',
    additive: (el.getAttribute('additive') ?? 'replace').trim() === 'sum',
    ...(infinite ? { infinite } : {}),
  };
}

/** The no-op value for a transform type, used as the implicit `from`. */
function identityFor(type: string, width: number): number[] {
  if (type === 'scale') return width > 1 ? [1, 1] : [1];
  return new Array(Math.max(1, width)).fill(0);
}

/** Interpolate an animation's value tuple at absolute time `t`. */
function valueAt(a: SmilAnim, t: number): number[] | null {
  let rel = t - a.begin;
  if (rel < 0) return null;
  if (rel >= a.active) {
    // An unrolled `indefinite`/`infinite` animation has not actually finished —
    // hold it just inside the window so the final sample continues the motion
    // instead of snapping back to the base value.
    if (a.infinite) rel = Math.max(0, a.active - RESTART_EPS);
    else if (!a.freeze) return null;
    else return a.values[a.values.length - 1]!;
  }
  let local = a.dur > 0 ? (rel % a.dur) / a.dur : 0;
  // CSS `animation-direction`. `alternate` runs odd iterations backwards, and
  // `reverse` flips every one — without this an alternating pulse imports as a
  // saw-tooth that snaps back instead of easing out.
  if (a.alternate || a.reverse) {
    const iteration = a.dur > 0 ? Math.floor(rel / a.dur) : 0;
    const flipped = (a.alternate === true && iteration % 2 === 1) !== (a.reverse === true);
    if (flipped) local = 1 - local;
  }

  let i = 0;
  while (i < a.keyTimes.length - 2 && a.keyTimes[i + 1]! <= local) i++;
  const t0 = a.keyTimes[i]!;
  const t1 = a.keyTimes[i + 1]!;
  const v0 = a.values[i]!;
  const v1 = a.values[i + 1]!;
  if (a.discrete) return v0;
  const span = t1 - t0;
  let f = span > TIME_EPS ? (local - t0) / span : 0;
  // A CSS timing function eases each keyframe SEGMENT, not the animation as a
  // whole, so it is applied to the segment fraction rather than to `local`.
  if (a.ease) f = Math.max(0, Math.min(1, a.ease(f)));
  const width = Math.max(v0.length, v1.length);
  const out: number[] = [];
  for (let k = 0; k < width; k++) {
    const p = v0[k] ?? v0[v0.length - 1] ?? 0;
    const q = v1[k] ?? v1[v1.length - 1] ?? 0;
    out.push(p + (q - p) * f);
  }
  return out;
}

/** A transform animation's value expressed as a matrix. */
function animMatrix(a: SmilAnim, t: number): Mat | null {
  const v = valueAt(a, t);
  if (!v) return null;
  switch (a.transformType) {
    case 'translate':
      return [1, 0, 0, 1, v[0] ?? 0, v[1] ?? 0];
    case 'scale': {
      const sx = v[0] ?? 1;
      return [sx, 0, 0, v.length > 1 ? v[1]! : sx, 0, 0];
    }
    case 'rotate': {
      const rad = (v[0] ?? 0) * (Math.PI / 180);
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const rot: Mat = [cos, sin, -sin, cos, 0, 0];
      if (v.length >= 3) {
        const cx = v[1]!;
        const cy = v[2]!;
        return matMul(matMul([1, 0, 0, 1, cx, cy], rot), [1, 0, 0, 1, -cx, -cy]);
      }
      return rot;
    }
    case 'css': {
      // [tx, ty, rotationDeg, sx, sy] about `origin`:
      //   T(origin) · T(tx,ty) · R · S · T(-origin)
      const ox = a.origin?.x ?? 0;
      const oy = a.origin?.y ?? 0;
      const rad = (v[2] ?? 0) * (Math.PI / 180);
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const rs: Mat = [cos * (v[3] ?? 1), sin * (v[3] ?? 1), -sin * (v[4] ?? 1), cos * (v[4] ?? 1), 0, 0];
      return matMul(
        matMul([1, 0, 0, 1, ox + (v[0] ?? 0), oy + (v[1] ?? 0)], rs),
        [1, 0, 0, 1, -ox, -oy],
      );
    }
    case 'skewx':
      return [1, 0, Math.tan((v[0] ?? 0) * (Math.PI / 180)), 1, 0, 0];
    case 'skewy':
      return [1, Math.tan((v[0] ?? 0) * (Math.PI / 180)), 0, 1, 0, 0];
    default:
      return null;
  }
}

/**
 * The element's transform at `t` — animated where an animation overrides it.
 *
 * `statics` is passed in rather than re-parsed: it is fixed for the element but
 * this runs once per element per sample time, and re-parsing the `transform`
 * attribute hundreds of times per shape was pure waste.
 */
function elementMatrixAt(own: readonly SmilAnim[], statics: Mat, t: number): Mat {
  if (own.length === 0) return statics;

  let out: Mat | null = null;
  for (const a of own) {
    const m = animMatrix(a, t);
    if (!m) continue;
    // additive="sum" composes onto the static transform; the default replaces it.
    const composed = a.additive ? matMul(statics, m) : m;
    out = out ? matMul(out, composed) : composed;
  }
  // Before an animation begins (and after a non-freezing one ends) the element
  // simply shows its own static transform.
  return out ?? statics;
}

/** Opacity multiplier from every opacity animation on the element, or null. */
function opacityAt(own: readonly SmilAnim[], t: number): number | null {
  let v: number | null = null;
  for (const a of own) {
    const val = valueAt(a, t);
    if (val && val.length > 0) v = (v ?? 1) * val[0]!;
  }
  return v;
}

/**
 * The reference length a `stroke-dashoffset` animation slides against.
 *
 * Draw-on markup sets `stroke-dasharray` to (at least) the path length so one
 * dash covers the whole stroke; the offset then hides `offset/dash` of it.
 * `pathLength` is the author's own override of the path's nominal length and
 * takes precedence when present, because dashes are measured in that unit.
 */
function dashReferenceLength(el: Element): number | null {
  const pathLength = Number(el.getAttribute('pathLength'));
  if (Number.isFinite(pathLength) && pathLength > 0) return pathLength;
  const dash = el.getAttribute('stroke-dasharray')
    ?? /(?:^|;)\s*stroke-dasharray\s*:\s*([^;]+)/i.exec(el.getAttribute('style') ?? '')?.[1]
    ?? null;
  const nums = (dash?.match(/-?\d*\.?\d+/g) ?? []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  if (nums.length === 0) return null;
  // A multi-value dasharray repeats over its SUM; that is the period the
  // offset slides across.
  return nums.reduce((a, b) => a + b, 0);
}

/** Decompose a 2×3 matrix into translation, rotation (deg) and scale. */
function decompose(m: Mat): { tx: number; ty: number; rotation: number; sx: number; sy: number } {
  const [a, b, c, d, e, f] = m;
  const sx = Math.hypot(a, b);
  // Signed second scale: a mirrored matrix has a negative determinant.
  const det = a * d - b * c;
  const sy = sx > 1e-9 ? det / sx : Math.hypot(c, d);
  return {
    tx: e,
    ty: f,
    rotation: Math.atan2(b, a) * (180 / Math.PI),
    sx: sx || 1,
    sy: sy || 1,
  };
}

function pushKf(list: SvgKeyframe[], time: number, value: number, hold?: boolean): void {
  const last = list[list.length - 1];
  if (last && Math.abs(last.time - time) < TIME_EPS) {
    last.value = value;
    return;
  }
  list.push(hold ? { time, value, hold } : { time, value });
}

/** Drop a track whose value never actually changes. */
function meaningful(list: SvgKeyframe[], base: number): SvgKeyframe[] | undefined {
  if (list.length < 2) return undefined;
  return list.some((k) => Math.abs(k.value - base) > 1e-6) ? list : undefined;
}

/**
 * Discard sampled keyframes that linear interpolation already reproduces.
 *
 * THIS IS WHAT MAKES A GENERATED TRACK USABLE. Sampling is dense because the
 * sampler cannot know in advance where the interesting times are: a rotation
 * has to be sampled every 90° just to keep the angle unwrappable, so one second
 * of a spin arrives as hundreds of points that all sit exactly on a straight
 * line. Keeping them costs quadratic insert time, a keyframe diamond every
 * pixel of timeline, and a per-frame sampling bill — for zero fidelity.
 *
 * Douglas–Peucker over (time, value): keep the point furthest from the chord
 * between the endpoints while it exceeds `tolerance`, recurse on both halves,
 * drop everything else. Endpoints always survive, so a track's start and end
 * values are exact. A constant-rate spin collapses to two keyframes; an eased
 * move keeps only the knots its curve actually needs.
 *
 * Iterative rather than recursive: a 30,000-sample track would blow the stack.
 */
function simplifyTrack(list: SvgKeyframe[], tolerance: number): SvgKeyframe[] {
  if (list.length <= 2) return list;
  // A held/discrete track is a staircase, not a curve — every step is a real
  // edge and chord distance would happily erase it.
  if (list.some((k) => k.hold)) return list;

  const keep = new Uint8Array(list.length);
  keep[0] = 1;
  keep[list.length - 1] = 1;

  const stack: Array<[number, number]> = [[0, list.length - 1]];
  while (stack.length > 0) {
    const [lo, hi] = stack.pop()!;
    if (hi - lo < 2) continue;
    const a = list[lo]!;
    const b = list[hi]!;
    const span = b.time - a.time;
    const slope = span > TIME_EPS ? (b.value - a.value) / span : 0;

    let worst = -1;
    let worstDist = tolerance;
    for (let i = lo + 1; i < hi; i++) {
      const k = list[i]!;
      const predicted = a.value + slope * (k.time - a.time);
      const dist = Math.abs(k.value - predicted);
      if (dist > worstDist) {
        worstDist = dist;
        worst = i;
      }
    }
    if (worst < 0) continue; // the chord already covers this whole span

    keep[worst] = 1;
    stack.push([lo, worst], [worst, hi]);
  }

  const out: SvgKeyframe[] = [];
  for (let i = 0; i < list.length; i++) if (keep[i]) out.push(list[i]!);
  return out;
}

export interface SvgAnimationScan {
  /** Every animation in the document, SMIL and CSS alike. */
  anims: SmilAnim[];
  /** Human-readable names of animation features that were not translated. */
  unsupported: Set<string>;
  /**
   * Animations that drive each element, indexed once.
   *
   * The sampler asks this question for every element of every shape's ancestor
   * chain at every sample time. Answering it with `anims.filter(…)` is a full
   * scan of the document's animations per question — quadratic in the file, and
   * measurably the difference between an import that lands and one that hangs.
   */
  byTarget: Map<Element, SmilAnim[]>;
}

export interface SvgAnimationOptions {
  /**
   * How far a looping animation is unrolled, in seconds.
   *
   * Keyframes past the end of the composition can never play, so generating
   * them is pure cost. Callers that know the comp duration should pass it.
   */
  maxDurationSeconds?: number;
  /**
   * Filled with everything about the file's animation that did NOT convert.
   *
   * The importer used to re-parse the whole document to build its toast, which
   * meant the toast could only ever report what a fresh SCAN can see — not what
   * the translation itself discovered (a keyframe budget it ran out of, a
   * `translateX(100%)` that resolved to nothing). Handing the set in is what
   * lets one parse answer both questions.
   */
  unsupportedOut?: Set<string>;
}

function indexByTarget(anims: readonly SmilAnim[]): Map<Element, SmilAnim[]> {
  const out = new Map<Element, SmilAnim[]>();
  for (const a of anims) {
    const list = out.get(a.target);
    if (list) list.push(a);
    else out.set(a.target, [a]);
  }
  return out;
}

/**
 * Read every animation in the document once — SMIL elements and CSS
 * `@keyframes` alike.
 *
 * Both kinds end up in one list because the sampler downstream does not care
 * where a track came from: it rebuilds the element's matrix at time `t` from
 * whatever is driving it. CSS used to be invisible here, which is why a file
 * that plainly animated in an `<img>` imported as motionless shapes.
 */
export function scanSvgAnimations(doc: Document, opts?: SvgAnimationOptions): SvgAnimationScan {
  const unroll = Math.min(Math.max(opts?.maxDurationSeconds ?? MAX_UNROLL_SECONDS, 0.1), MAX_UNROLL_SECONDS);
  const unsupported = new Set<string>();
  const anims: SmilAnim[] = [];
  const walk = (el: Element): void => {
    for (const child of Array.from(el.children)) {
      const tag = child.tagName.toLowerCase().replace(/^svg:/, '');
      if (SMIL_TAGS.has(tag)) {
        const a = readAnim(child, unsupported, unroll);
        if (a && a.target) anims.push(a);
      } else {
        walk(child);
      }
    }
  };
  walk(doc.documentElement);

  const css = readCssAnimations(doc, unroll);
  for (const name of css.unsupported) unsupported.add(name);
  for (const c of css.anims) anims.push(fromCss(c));

  return { anims, unsupported, byTarget: indexByTarget(anims) };
}

/** A CSS animation in the sampler's own terms. */
function fromCss(c: CssAnimation): SmilAnim {
  const isTransform = c.kind === 'transform';
  return {
    el: c.target,
    target: c.target,
    attr: isTransform ? 'transform' : c.kind === 'dashoffset' ? 'stroke-dashoffset' : 'opacity',
    transformType: isTransform ? 'css' : '',
    begin: c.begin,
    dur: c.dur,
    active: c.active,
    values: c.values,
    keyTimes: c.keyTimes,
    discrete: c.discrete,
    // Sub-sample every CSS segment: the timing function is a curve, and even a
    // linear one needs the extra knots when it is carrying a spin.
    spline: true,
    freeze: c.freeze,
    // CSS `transform` REPLACES the element's `transform` attribute, exactly like
    // a default-additive SMIL transform animation.
    additive: false,
    alternate: c.alternate,
    reverse: c.reverse,
    infinite: c.infinite,
    origin: c.origin,
    ...(c.ease ? { ease: c.ease } : {}),
  };
}

export interface ShapeAnimationOptions {
  /**
   * An element's static `opacity` (0..1).
   *
   * Needed because an opacity animation ANYWHERE on the chain makes the sampled
   * track authoritative for the whole chain: a `<g opacity="0.4">` around a
   * shape whose own opacity pulses must still be 40% of the pulse. Supplied by
   * the parser, which is the side that has resolved the stylesheet.
   */
  staticOpacityOf?: (el: Element) => number;
}

/**
 * Keyframe tracks for one shape element.
 *
 * `factors` is every factor of the shape's baked matrix, outermost first —
 * elements whose `transform` may animate, interleaved with the fixed coordinate
 * systems between them (root viewBox map, `<use>` offsets, nested viewports).
 * ALL of them are needed: rebuilding `A(t)` from the element transforms alone
 * left the fixed ones inside `S` only, so `D = A·S⁻¹` carried a constant `R⁻¹`
 * — a spurious offset and scale on every animated shape. See `MatrixFactor`.
 *
 * `staticMatrix` is the fully baked matrix the parser used for this shape's
 * points, and `center` is the shape's centre in that baked space.
 */
export function buildShapeAnimation(
  factors: ReadonlyArray<MatrixFactor>,
  scan: SvgAnimationScan,
  staticMatrix: Mat,
  center: { x: number; y: number },
  opts?: ShapeAnimationOptions,
): SvgShapeAnimation | null {
  // The element factors, innermost first — the shape itself, then its
  // ancestors. An animation on a <g> moves everything inside it.
  const chain: Element[] = [];
  for (let i = factors.length - 1; i >= 0; i--) {
    const f = factors[i]!;
    if ('el' in f) chain.push(f.el);
  }
  if (chain.length === 0) return null;

  // Only the chain's own elements can drive this shape — look them up rather
  // than scanning the document's whole animation list per shape.
  const relevant: SmilAnim[] = [];
  for (const el of chain) {
    const own = scan.byTarget.get(el);
    if (own) relevant.push(...own);
  }
  if (relevant.length === 0) return null;

  // A LOOP IS BAKED ONCE, NOT UNROLLED. An endless one-second spin sampled
  // across the whole composition is the same cycle copied over and over: every
  // repeat costs keyframes to build, to store, to snapshot into history and to
  // sample each frame, and buys nothing a `loopOut` expression does not give
  // for free. Baking a single cycle makes the cost independent of how long the
  // composition is.
  //
  // Only when every animation on the chain shares one period and phase, and all
  // of them are endless — a finite `repeatCount` must NOT become an eternal
  // loop, and mixed periods have a combined period this cannot express.
  const lead = relevant[0]!;
  // A POSITIVE delay is a real lead-in and is NOT part of the period: baking
  // `[0, begin + dur]` and looping it made two circles on the same 1 s
  // animation, one delayed 0.5 s, run at 1.0 s and 1.5 s and drift apart
  // forever. A NEGATIVE delay is the opposite — the animation is already
  // mid-cycle at t=0, so `[0, dur]` is still a whole period and bakes fine.
  const preRolled = relevant.every((a) => a.begin <= TIME_EPS);
  const samePhase = relevant.every((a) => Math.abs(a.begin - lead.begin) < TIME_EPS);
  const uniformCycle = preRolled
    && relevant.every((a) => a.infinite
      && a.dur > 0
      && Math.abs(a.dur - lead.dur) < TIME_EPS
      && !!a.alternate === !!lead.alternate)
    // `pingpong` reflects a HALF period, so it is only right when every
    // animation sits at the same point in its 2×dur cycle.
    && (!lead.alternate || samePhase);
  const loop: 'cycle' | 'pingpong' | undefined = uniformCycle
    ? (lead.alternate ? 'pingpong' : 'cycle')
    : undefined;

  const end = uniformCycle
    ? lead.dur
    : Math.max(...relevant.map((a) => a.begin + a.active));
  if (!(end > 0)) return null;
  const rotationStepDeg = uniformCycle ? CYCLE_ROTATION_STEP_DEG : MAX_ROTATION_STEP_DEG;

  // Sample where the animation actually has knots; subdivide eased segments so
  // a spline is followed rather than cut straight across.
  const times = new Set<number>([0]);
  // A negative `animation-delay` puts an animation's early keyTimes BEFORE the
  // composition starts. Those instants are real (they set the phase at t=0, via
  // `valueAt`) but they are not keyframes we can write.
  const addTime = (t: number): void => {
    if (t >= -TIME_EPS && t <= end + TIME_EPS) times.add(Math.max(0, t));
  };
  for (const a of relevant) {
    const iterations = a.dur > 0 ? Math.ceil(a.active / a.dur) : 1;
    for (let it = 0; it < iterations; it++) {
      const base = a.begin + it * a.dur;
      for (let i = 0; i < a.keyTimes.length; i++) {
        const t = base + a.keyTimes[i]! * a.dur;
        if (t > end + TIME_EPS) break;
        addTime(t);
        const next = a.keyTimes[i + 1];
        if (next !== undefined) {
          // Splines need intermediate samples to follow their curve. So does
          // ROTATION, for a different reason: the angle is read back out of the
          // matrix, and a 360° turn is indistinguishable from 0 at its
          // endpoints — sampling only the knots drops a full spin entirely.
          // Keep each step well under half a turn so unwrapping stays correct.
          let subdivisions = a.spline ? SPLINE_SAMPLES : 0;
          const ri = rotationIndex(a);
          if (ri >= 0) {
            const span = Math.abs((a.values[i + 1]?.[ri] ?? 0) - (a.values[i]?.[ri] ?? 0));
            subdivisions = Math.max(subdivisions, Math.ceil(span / rotationStepDeg));
          }
          for (let s = 1; s < subdivisions; s++) {
            const mid = base + (a.keyTimes[i]! + ((next - a.keyTimes[i]!) * s) / subdivisions) * a.dur;
            if (mid <= end + TIME_EPS) addTime(mid);
          }
        }
      }
    }
    // Sample just BEFORE each iteration boundary, INCLUDING THE LAST.
    //
    // At a boundary the animation has already restarted (or already ended), so
    // sampling only there reads the restart/base value and the iteration's ramp
    // is never recorded. The interior boundaries were covered; the final one
    // was not, and it is the one every animation has — a non-freezing
    // `<animate from="0" to="50" dur="1s"/>` sampled 0 at t=0 and 0 at t=1 and
    // was discarded as "never changes", so a one-shot SMIL animation imported
    // as nothing at all. `repeatCount="2"` lost its second ramp the same way.
    if (a.dur > 0) {
      for (let it = 1; it * a.dur <= a.active + TIME_EPS; it++) {
        const at = a.begin + it * a.dur - RESTART_EPS;
        if (at > a.begin) addTime(at);
      }
    }
    addTime(Math.min(a.begin + a.active, end));
  }
  times.add(end);

  const sorted = [...times].sort((p, q) => p - q);
  /**
   * Where to READ a sample, as opposed to where to WRITE it.
   *
   * The two differ only at the end of a baked cycle. `t = begin + dur` is the
   * instant the loop restarts, so reading there returns the FIRST value — which
   * would make the cycle's start and end identical, `loopOut('offset')`'s delta
   * zero, and a spin snap back instead of accumulating. Reading a millisecond
   * earlier gets the cycle's true final value while the keyframe still lands on
   * the exact period boundary, so repeats do not drift.
   */
  const readAt = (t: number): number =>
    (uniformCycle && Math.abs(t - end) < TIME_EPS ? t - CYCLE_END_EPS : t);
  const inv = matInvert(staticMatrix);
  if (!inv) return null;

  const xs: SvgKeyframe[] = [];
  const ys: SvgKeyframe[] = [];
  const rot: SvgKeyframe[] = [];
  const sxs: SvgKeyframe[] = [];
  const sys: SvgKeyframe[] = [];
  const ops: SvgKeyframe[] = [];
  const trims: SvgKeyframe[] = [];
  // Discrete animations must not be smoothed between their steps.
  const anyDiscrete = relevant.some((a) => a.discrete);
  // Outside its active window an animation contributes NOTHING — for a
  // transform that means the static matrix (handled in elementMatrixAt), but
  // for opacity it means the base value. Skipping those samples instead of
  // recording the base is what made a `<set>` produce a single keyframe and get
  // discarded: the step back to full opacity was never written.
  const hasOpacityAnim = relevant.some((a) => a.attr === 'opacity' || a.attr === 'fill-opacity');

  // Per-factor work that does NOT vary with time, hoisted out of the sample
  // loop: which animations drive the element, split by kind, its static
  // transform, and its static opacity. Inside the loop this ran
  // `factors.length × times.length` times.
  const staticOpacityOf = opts?.staticOpacityOf;
  type FactorState =
    | { fixed: Mat }
    | { transforms: SmilAnim[]; opacities: SmilAnim[]; statics: Mat; staticOpacity: number };
  const perFactor: FactorState[] = factors.map((f): FactorState => {
    if (!('el' in f)) return { fixed: f.fixed };
    const own = scan.byTarget.get(f.el) ?? [];
    return {
      transforms: own.filter((a) => a.attr === 'transform'),
      opacities: own.filter((a) => a.attr === 'opacity' || a.attr === 'fill-opacity'),
      statics: parseTransform(f.el.getAttribute('transform')),
      staticOpacity: staticOpacityOf ? staticOpacityOf(f.el) : 1,
    };
  });

  // Draw-on: `stroke-dashoffset` on the SHAPE ITSELF (chain[0]) — the dash
  // pattern belongs to the stroked element, so one inherited from a group has
  // no meaning here. Convertible only when the dash length is known.
  const shapeEl = chain[0]!;
  const dashAnims = (scan.byTarget.get(shapeEl) ?? []).filter((a) => a.attr === 'stroke-dashoffset');
  const dashLen = dashAnims.length > 0 ? dashReferenceLength(shapeEl) : null;
  if (dashAnims.length > 0 && dashLen === null) {
    scan.unsupported.add('stroke-dashoffset (no stroke-dasharray/pathLength to measure against)');
  }
  const dashActive = dashAnims.length > 0 && dashLen !== null;

  for (const t of sorted) {
    const rt = readAt(t);
    // Rebuild the matrix in COMPOSITION order (outermost first), animated
    // values substituted in and every fixed coordinate system left in place —
    // exactly the product the parser baked, so `A·S⁻¹` is a pure delta.
    let animated: Mat = [1, 0, 0, 1, 0, 0];
    let opacity = 1;
    for (let i = 0; i < perFactor.length; i++) {
      const e = perFactor[i]!;
      if ('fixed' in e) {
        animated = matMul(animated, e.fixed);
        continue;
      }
      animated = matMul(animated, elementMatrixAt(e.transforms, e.statics, rt));
      // Where an element's opacity is not animated, its STATIC opacity still
      // applies — an animated pulse inside a `<g opacity="0.4">` is 40% of the
      // pulse, not the pulse.
      const o = e.opacities.length > 0 ? opacityAt(e.opacities, rt) : null;
      opacity *= o ?? e.staticOpacity;
    }
    // D = A · S⁻¹ maps the BAKED points to where they should be at time t.
    const d = matMul(animated, inv);
    const moved = applyMat(d, center.x, center.y);
    const dec = decompose(d);

    pushKf(xs, t, moved.x - center.x, anyDiscrete);
    pushKf(ys, t, moved.y - center.y, anyDiscrete);
    // UNWRAP the angle. `decompose` reads it back through atan2, so a full spin
    // comes out 0 → 180 → −180 → 0; interpolating between +179 and −179 turns a
    // clean 360° rotation into a jerk backwards through zero. Carrying the turn
    // count forward keeps a spin monotonic — and for a repeating spin it makes
    // successive iterations continue instead of snapping back, which is what it
    // looks like in a browser.
    const prevRot = rot[rot.length - 1]?.value;
    const unwrapped = prevRot === undefined
      ? dec.rotation
      : dec.rotation + 360 * Math.round((prevRot - dec.rotation) / 360);
    pushKf(rot, t, unwrapped, anyDiscrete);
    pushKf(sxs, t, dec.sx, anyDiscrete);
    pushKf(sys, t, dec.sy, anyDiscrete);
    if (hasOpacityAnim) pushKf(ops, t, Math.max(0, Math.min(1, opacity)) * 100, anyDiscrete);
    if (dashActive) {
      // Outside the animation's window valueAt is null → the static offset,
      // which for draw-on markup means "fully hidden" only while it has not
      // begun; fall back to fully drawn (offset 0) like the browser does when
      // no static stroke-dashoffset is set.
      const staticOffset = Number(shapeEl.getAttribute('stroke-dashoffset')) || 0;
      let offset = staticOffset;
      for (const a of dashAnims) {
        const val = valueAt(a, rt);
        if (val && val.length > 0) offset = val[0]!;
      }
      const visible = Math.max(0, Math.min(1, 1 - offset / dashLen!));
      pushKf(trims, t, visible * 100, anyDiscrete);
    }
  }

  const out: SvgShapeAnimation = { duration: end };
  const reduce = (list: SvgKeyframe[], base: number, tol: number): SvgKeyframe[] | undefined => {
    const kept = meaningful(list, base);
    return kept ? simplifyTrack(kept, tol) : undefined;
  };
  const x = reduce(xs, 0, SIMPLIFY_TOLERANCE.x);
  const y = reduce(ys, 0, SIMPLIFY_TOLERANCE.y);
  const r = reduce(rot, 0, SIMPLIFY_TOLERANCE.rotation);
  const sx = reduce(sxs, 1, SIMPLIFY_TOLERANCE.scaleX);
  const sy = reduce(sys, 1, SIMPLIFY_TOLERANCE.scaleY);
  const op = reduce(ops, 100, SIMPLIFY_TOLERANCE.opacity);
  // Base 100 = fully drawn, so a track that never leaves "fully drawn" drops.
  const trim = reduce(trims, 100, SIMPLIFY_TOLERANCE.opacity);
  if (x) out.x = x;
  if (y) out.y = y;
  if (r) out.rotation = r;
  if (sx) out.scaleX = sx;
  if (sy) out.scaleY = sy;
  if (op) out.opacity = op;
  if (trim) out.trimEnd = trim;
  if (loop) out.loop = loop;

  return out.x || out.y || out.rotation || out.scaleX || out.scaleY || out.opacity || out.trimEnd ? out : null;
}
