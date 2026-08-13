import type { BezierPoint } from '@motion/workspace';
import { scanSvgAnimations, buildShapeAnimation, type SvgShapeAnimation, type SvgAnimationOptions } from './svgAnimation';
import { readCssPresentation } from './svgCss';

export interface ParsedShape {
  name: string;
  points: BezierPoint[];
  fill: string;
  strokeColor?: string;
  strokeWidth?: number;
  /** false for open outlines (polyline / line / paths without Z). */
  closed: boolean;
  /**
   * The path's runs, centred like `points`, when there is more than one.
   *
   * A `d` with several `M` commands is several outlines — the hole in a donut,
   * the counter in an "o". Flattening them into `points` filled the hole and
   * drew a stray segment from one ring to the next, so the shape came out as a
   * blob that did not resemble the file.
   */
  subpaths?: SubPath[];
  // Bounding box centering offsets
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  textContent?: string;
  fontSize?: number;
  /**
   * `<image>` source — this shape is an embedded bitmap.
   *
   * It used to be dropped outright, so any animated SVG built around a photo
   * imported with a hole where the photo was.
   */
  imageHref?: string;
  /** Resolved (inherited) text style — undefined for non-text shapes. */
  fontFamily?: string;
  fontWeight?: string;
  fontStyle?: string;
  /**
   * The element's own `opacity`, times every ancestor group's (0..1).
   *
   * Groups are flattened into independent layers, so a `<g opacity="0.5">` has
   * nowhere else to go — dropping it, which is what used to happen, rendered
   * every faded element at full strength.
   */
  opacity: number;
  /** Inherited `fill-opacity` / `stroke-opacity` (0..1). */
  fillOpacity: number;
  strokeOpacity: number;
  /**
   * Keyframes translated from the element's SMIL animation, if any. Present
   * only when the SVG actually animates — see `svgAnimation.ts`.
   */
  animation?: SvgShapeAnimation;
}

// ---------------------------------------------------------------------------
// 2x3 affine matrix helpers.  A matrix [a,b,c,d,e,f] maps a point (x,y) to
//   x' = a*x + c*y + e
//   y' = b*x + d*y + f
// ---------------------------------------------------------------------------
export type Mat = readonly [number, number, number, number, number, number];
const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

/**
 * One factor of a shape's baked matrix, in composition order (outermost first).
 *
 * The animation translator has to rebuild the shape's matrix at time `t` and
 * compare it against the baked one (`D = A(t)·S⁻¹`). It used to do that from
 * the chain's `transform` ATTRIBUTES alone — but `S` also contains coordinate
 * systems that are not attributes: the root `viewBox`→pixel-box mapping,
 * `<use x/y>` offsets, and nested `<svg>`/`<symbol>` viewports. Every one of
 * those survived into `D` as a residual `R⁻¹`, i.e. a CONSTANT offset and scale
 * welded onto every animated shape.
 *
 * It cancels exactly when the root matrix is the identity, which is why files
 * whose `width`/`height` match their `viewBox` always looked right and
 * everything else did not: a `width="200" viewBox="0 0 50 50"` file gave every
 * animated part `scaleX = scaleY = 0.25` and a hundred-unit jump, while its
 * un-animated siblings stayed put. Recording the fixed factors alongside the
 * animatable ones is what lets `A(t)` be assembled in the SAME space as `S`.
 */
/** The style a text run is measured with — SVG units, not scene units. */
export interface SvgTextStyle {
  content: string;
  fontSize: number;
  fontFamily?: string;
  fontWeight?: string;
  fontStyle?: string;
}

/** What a measurer must report about a text run. */
export interface SvgTextMetrics {
  /** Advance width of the widest line — what `text-anchor` is measured against. */
  advance: number;
  /** The layer's render box, centred on the draw origin. */
  width: number;
  height: number;
  /**
   * How far the run's alphabetic BASELINE sits below its block centre.
   *
   * SVG pins text by its baseline and the scene positions a layer by its
   * centre, so this is the whole of the vertical correction. It is NOT the
   * font box's offset from the draw origin — that is ~0, because the origin is
   * the `middle` baseline, and using it applied 1.88px where 9.62px was needed
   * on 32px Inter.
   */
  baselineOffset: number;
}

/**
 * Measures a text run, or null when it cannot.
 *
 * Injected rather than imported: measuring needs a canvas, which lives in
 * `@core/text/measureText`, and nothing else in `src/utils` reaches into
 * `@core`. It also makes the geometry testable with exact numbers instead of
 * whatever the test runner's canvas stub happens to return.
 */
export type SvgTextMeasurer = (style: SvgTextStyle) => SvgTextMetrics | null;

/**
 * Intersects a shape's runs with a clip region, or null when it cannot.
 *
 * `clip-path` has no representation in the scene — the shape layer cannot clip
 * at draw time — so the only faithful translation is to CUT THE GEOMETRY at
 * import, which is exactly a boolean intersect. That lives in `@core` (it needs
 * `polygon-clipping`), hence the injection, same as the text measurer.
 *
 * Curves are flattened by the intersect, which is the honest cost: a clipped
 * circle becomes a fine polygon. Merge Paths already makes that trade for the
 * same reason.
 */
export type SvgPathIntersector = (
  subject: readonly SubPath[],
  clip: readonly SubPath[],
) => SubPath[] | null;

/**
 * Where a run's visual CENTRE sits relative to its `text-anchor` point.
 *
 * SVG pins the run at `x` by its anchor; the scene positions a layer by its
 * centre. `start` (the default) therefore has to move RIGHT by half the run —
 * not doing so drew every left-aligned label half its own width too far left.
 */
export function textAnchorOffsetX(anchor: 'start' | 'middle' | 'end', advance: number): number {
  if (anchor === 'middle') return 0;
  return anchor === 'end' ? -advance / 2 : advance / 2;
}

export type MatrixFactor =
  /** A coordinate system: root viewBox map, `<use>` offset, nested viewport. */
  | { readonly fixed: Mat }
  /** An element whose `transform` attribute may be animated. */
  | { readonly el: Element };

/** Compose two matrices: result applies `n` first, then `m` (m * n). */
export function matMul(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function applyMat(m: Mat, x: number, y: number): { x: number; y: number } {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

/** Inverse of a 2x3 affine matrix, or null when it is degenerate. */
export function matInvert(m: Mat): Mat | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const a = m[3] / det;
  const b = -m[1] / det;
  const c = -m[2] / det;
  const d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

const DEG = Math.PI / 180;

/** Parse an SVG `transform` attribute into a single composed matrix. */
export function parseTransform(str: string | null): Mat {
  if (!str) return IDENTITY;
  let result: Mat = IDENTITY;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(str)) !== null) {
    const name = m[1]!;
    const args = (m[2]!.match(/-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) || []).map(Number);
    let t: Mat = IDENTITY;
    switch (name) {
      case 'matrix':
        if (args.length === 6) t = [args[0]!, args[1]!, args[2]!, args[3]!, args[4]!, args[5]!];
        break;
      case 'translate':
        t = [1, 0, 0, 1, args[0] ?? 0, args[1] ?? 0];
        break;
      case 'scale': {
        const sx = args[0] ?? 1;
        const sy = args.length > 1 ? args[1]! : sx;
        t = [sx, 0, 0, sy, 0, 0];
        break;
      }
      case 'rotate': {
        const a = (args[0] ?? 0) * DEG;
        const cos = Math.cos(a);
        const sin = Math.sin(a);
        const rot: Mat = [cos, sin, -sin, cos, 0, 0];
        if (args.length >= 3) {
          const cx = args[1]!;
          const cy = args[2]!;
          // translate(cx,cy) * rotate * translate(-cx,-cy)
          t = matMul(matMul([1, 0, 0, 1, cx, cy], rot), [1, 0, 0, 1, -cx, -cy]);
        } else {
          t = rot;
        }
        break;
      }
      case 'skewX':
        t = [1, 0, Math.tan((args[0] ?? 0) * DEG), 1, 0, 0];
        break;
      case 'skewY':
        t = [1, Math.tan((args[0] ?? 0) * DEG), 0, 1, 0, 0];
        break;
    }
    result = matMul(result, t);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Path command tokenizer + geometry builders (user space, no transform yet).
// ---------------------------------------------------------------------------

/** Parse path `d` string into command tokens. */
function parsePathTokens(d: string): { cmd: string; args: number[] }[] {
  // Explicitly enumerate command letters so an exponent 'e'/'E' inside a number
  // is never mistaken for a command (and every command — incl. uppercase A/C — matches).
  const regex = /([MmLlHhVvCcSsQqTtAaZz])|(-?\d*\.?\d+(?:[eE][-+]?\d+)?)/g;
  const tokens: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(d)) !== null) {
    tokens.push(match[0]);
  }

  const out: { cmd: string; args: number[] }[] = [];
  let currentCmd = '';
  let currentArgs: number[] = [];

  for (const token of tokens) {
    if (/^[MmLlHhVvCcSsQqTtAaZz]$/.test(token)) {
      if (currentCmd) out.push({ cmd: currentCmd, args: currentArgs });
      currentCmd = token;
      currentArgs = [];
    } else {
      currentArgs.push(parseFloat(token));
    }
  }
  if (currentCmd) out.push({ cmd: currentCmd, args: currentArgs });
  return out;
}

function addCubic(
  points: BezierPoint[],
  cp1x: number,
  cp1y: number,
  cp2x: number,
  cp2y: number,
  x: number,
  y: number,
): void {
  const prev = points[points.length - 1];
  if (prev) {
    prev.outX = cp1x;
    prev.outY = cp1y;
  }
  points.push({ x, y, inX: cp2x, inY: cp2y, outX: x, outY: y });
}

/**
 * Convert an elliptical arc (endpoint parameterization) to a list of cubic
 * bezier segments using the standard endpoint-to-center conversion, then
 * split the arc sweep into <=90deg pieces approximated by cubics.
 */
function arcToCubics(
  x1: number,
  y1: number,
  rxIn: number,
  ryIn: number,
  phiDeg: number,
  largeArc: boolean,
  sweep: boolean,
  x2: number,
  y2: number,
): { cp1x: number; cp1y: number; cp2x: number; cp2y: number; x: number; y: number }[] {
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx === 0 || ry === 0 || (x1 === x2 && y1 === y2)) {
    return [{ cp1x: x1, cp1y: y1, cp2x: x2, cp2y: y2, x: x2, y: y2 }];
  }
  const phi = phiDeg * DEG;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);

  // Step 1: compute (x1', y1')
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cosPhi * dx + sinPhi * dy;
  const y1p = -sinPhi * dx + cosPhi * dy;

  // Correct out-of-range radii
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }

  // Step 2: compute center (cx', cy')
  const rx2 = rx * rx;
  const ry2 = ry * ry;
  const x1p2 = x1p * x1p;
  const y1p2 = y1p * y1p;
  let num = rx2 * ry2 - rx2 * y1p2 - ry2 * x1p2;
  if (num < 0) num = 0;
  const denom = rx2 * y1p2 + ry2 * x1p2;
  let coef = denom === 0 ? 0 : Math.sqrt(num / denom);
  if (largeArc === sweep) coef = -coef;
  const cxp = (coef * (rx * y1p)) / ry;
  const cyp = (coef * -(ry * x1p)) / rx;

  // Step 3: center (cx, cy)
  const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;

  // Step 4: start/sweep angles
  const angle = (ux: number, uy: number, vx: number, vy: number): number => {
    const dot = ux * vx + uy * vy;
    const len = Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy));
    let a = Math.acos(Math.min(1, Math.max(-1, len === 0 ? 1 : dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let deltaTheta = angle(
    (x1p - cxp) / rx,
    (y1p - cyp) / ry,
    (-x1p - cxp) / rx,
    (-y1p - cyp) / ry,
  );
  if (!sweep && deltaTheta > 0) deltaTheta -= 2 * Math.PI;
  else if (sweep && deltaTheta < 0) deltaTheta += 2 * Math.PI;

  // Split into <=90deg segments
  const segCount = Math.max(1, Math.ceil(Math.abs(deltaTheta) / (Math.PI / 2)));
  const delta = deltaTheta / segCount;
  const t = (4 / 3) * Math.tan(delta / 4);

  const segments: { cp1x: number; cp1y: number; cp2x: number; cp2y: number; x: number; y: number }[] = [];
  let ang = theta1;
  for (let i = 0; i < segCount; i++) {
    const cosA = Math.cos(ang);
    const sinA = Math.sin(ang);
    const cosB = Math.cos(ang + delta);
    const sinB = Math.sin(ang + delta);

    // Point on ellipse (before rotation/translation) at ang and ang+delta
    const map = (ca: number, sa: number): { x: number; y: number } => ({
      x: cx + cosPhi * (rx * ca) - sinPhi * (ry * sa),
      y: cy + sinPhi * (rx * ca) + cosPhi * (ry * sa),
    });
    const p1 = map(cosA, sinA);
    const p2 = map(cosB, sinB);
    // Derivatives for control points
    const d1x = -rx * sinA;
    const d1y = ry * cosA;
    const d2x = -rx * sinB;
    const d2y = ry * cosB;
    const rot = (vx: number, vy: number): { x: number; y: number } => ({
      x: cosPhi * vx - sinPhi * vy,
      y: sinPhi * vx + cosPhi * vy,
    });
    const rd1 = rot(d1x, d1y);
    const rd2 = rot(d2x, d2y);
    segments.push({
      cp1x: p1.x + t * rd1.x,
      cp1y: p1.y + t * rd1.y,
      cp2x: p2.x - t * rd2.x,
      cp2y: p2.y - t * rd2.y,
      x: p2.x,
      y: p2.y,
    });
    ang += delta;
  }
  return segments;
}

/** One run of a path — everything between two `M` commands. */
export interface SubPath {
  points: BezierPoint[];
  closed: boolean;
}

/**
 * Parse an SVG path `d` attribute into BezierPoints (user space).
 * Supports M/L/H/V/C/S/Q/T/A/Z in absolute and relative forms.
 *
 * Returns the runs (`subpaths`) as well as the flat point list, because a `d`
 * with more than one `M` is not one outline: a donut, a letter with a counter
 * and every icon with a hole in it are two runs, and flattening them into a
 * single array both fills the hole and draws a stray segment between the rings.
 * `points`/`closed` stay for callers that only ever want a rough outline.
 */
export function parseSvgPathEx(d: string): { points: BezierPoint[]; closed: boolean; subpaths: SubPath[] } {
  const tokens = parsePathTokens(d);
  const subpaths: SubPath[] = [];
  let points: BezierPoint[] = [];
  let closedRun = false;

  let cx = 0;
  let cy = 0;
  let startX = 0;
  let startY = 0;
  let closed = false;

  /** Bank the run in progress. */
  const flushRun = (): void => {
    if (points.length > 0) subpaths.push({ points, closed: closedRun });
    points = [];
    closedRun = false;
  };
  /**
   * A drawing command AFTER a `Z` with no `M` between starts a fresh subpath at
   * the closed one's initial point (SVG 1.1 §8.3.1) — it does not reopen it.
   */
  const breakAfterClose = (): void => {
    if (!closedRun) return;
    flushRun();
    points.push({ x: cx, y: cy, inX: cx, inY: cy, outX: cx, outY: cy });
  };

  // Reflection state for S / T smoothing.
  let lastCubicCtrlX = 0;
  let lastCubicCtrlY = 0;
  let lastQuadCtrlX = 0;
  let lastQuadCtrlY = 0;
  let prevType = '';

  for (const { cmd, args } of tokens) {
    const isRelative = cmd === cmd.toLowerCase();
    const upperCmd = cmd.toUpperCase();

    // Z takes no args but must run once.
    if (upperCmd === 'Z') {
      closed = true;
      closedRun = true;
      cx = startX;
      cy = startY;
      prevType = 'Z';
      continue;
    }

    // Per-command handling (relative args accumulate against the running point).
    let i = 0;
    if (upperCmd === 'M') {
      // First pair = moveto (a NEW subpath), subsequent pairs = lineto.
      let first = true;
      while (i + 1 < args.length) {
        const x = args[i++]! + (isRelative ? cx : 0);
        const y = args[i++]! + (isRelative ? cy : 0);
        cx = x;
        cy = y;
        if (first) {
          flushRun();
          startX = x;
          startY = y;
          first = false;
        }
        points.push({ x, y, inX: x, inY: y, outX: x, outY: y });
      }
      prevType = 'M';
      continue;
    }

    breakAfterClose();

    if (upperCmd === 'L') {
      while (i + 1 < args.length) {
        const x = args[i++]! + (isRelative ? cx : 0);
        const y = args[i++]! + (isRelative ? cy : 0);
        cx = x;
        cy = y;
        points.push({ x, y, inX: x, inY: y, outX: x, outY: y });
      }
      prevType = 'L';
    } else if (upperCmd === 'H') {
      while (i < args.length) {
        const x = args[i++]! + (isRelative ? cx : 0);
        cx = x;
        points.push({ x, y: cy, inX: x, inY: cy, outX: x, outY: cy });
      }
      prevType = 'H';
    } else if (upperCmd === 'V') {
      while (i < args.length) {
        const y = args[i++]! + (isRelative ? cy : 0);
        cy = y;
        points.push({ x: cx, y, inX: cx, inY: y, outX: cx, outY: y });
      }
      prevType = 'V';
    } else if (upperCmd === 'C') {
      while (i + 5 < args.length) {
        const cp1x = args[i++]! + (isRelative ? cx : 0);
        const cp1y = args[i++]! + (isRelative ? cy : 0);
        const cp2x = args[i++]! + (isRelative ? cx : 0);
        const cp2y = args[i++]! + (isRelative ? cy : 0);
        const x = args[i++]! + (isRelative ? cx : 0);
        const y = args[i++]! + (isRelative ? cy : 0);
        addCubic(points, cp1x, cp1y, cp2x, cp2y, x, y);
        lastCubicCtrlX = cp2x;
        lastCubicCtrlY = cp2y;
        cx = x;
        cy = y;
      }
      prevType = 'C';
    } else if (upperCmd === 'S') {
      while (i + 3 < args.length) {
        const cp2x = args[i++]! + (isRelative ? cx : 0);
        const cp2y = args[i++]! + (isRelative ? cy : 0);
        const x = args[i++]! + (isRelative ? cx : 0);
        const y = args[i++]! + (isRelative ? cy : 0);
        // Reflect previous cubic control point.
        const reflect = prevType === 'C' || prevType === 'S';
        const cp1x = reflect ? 2 * cx - lastCubicCtrlX : cx;
        const cp1y = reflect ? 2 * cy - lastCubicCtrlY : cy;
        addCubic(points, cp1x, cp1y, cp2x, cp2y, x, y);
        lastCubicCtrlX = cp2x;
        lastCubicCtrlY = cp2y;
        cx = x;
        cy = y;
        prevType = 'S';
      }
      prevType = 'S';
    } else if (upperCmd === 'Q') {
      while (i + 3 < args.length) {
        const qx = args[i++]! + (isRelative ? cx : 0);
        const qy = args[i++]! + (isRelative ? cy : 0);
        const x = args[i++]! + (isRelative ? cx : 0);
        const y = args[i++]! + (isRelative ? cy : 0);
        // Quadratic -> cubic elevation.
        const cp1x = cx + (2 / 3) * (qx - cx);
        const cp1y = cy + (2 / 3) * (qy - cy);
        const cp2x = x + (2 / 3) * (qx - x);
        const cp2y = y + (2 / 3) * (qy - y);
        addCubic(points, cp1x, cp1y, cp2x, cp2y, x, y);
        lastQuadCtrlX = qx;
        lastQuadCtrlY = qy;
        cx = x;
        cy = y;
        prevType = 'Q';
      }
      prevType = 'Q';
    } else if (upperCmd === 'T') {
      while (i + 1 < args.length) {
        const x = args[i++]! + (isRelative ? cx : 0);
        const y = args[i++]! + (isRelative ? cy : 0);
        const reflect = prevType === 'Q' || prevType === 'T';
        const qx = reflect ? 2 * cx - lastQuadCtrlX : cx;
        const qy = reflect ? 2 * cy - lastQuadCtrlY : cy;
        const cp1x = cx + (2 / 3) * (qx - cx);
        const cp1y = cy + (2 / 3) * (qy - cy);
        const cp2x = x + (2 / 3) * (qx - x);
        const cp2y = y + (2 / 3) * (qy - y);
        addCubic(points, cp1x, cp1y, cp2x, cp2y, x, y);
        lastQuadCtrlX = qx;
        lastQuadCtrlY = qy;
        cx = x;
        cy = y;
        prevType = 'T';
      }
      prevType = 'T';
    } else if (upperCmd === 'A') {
      while (i + 6 < args.length) {
        const arx = args[i++]!;
        const ary = args[i++]!;
        const xRot = args[i++]!;
        const largeArc = args[i++]! !== 0;
        const sweep = args[i++]! !== 0;
        const x = args[i++]! + (isRelative ? cx : 0);
        const y = args[i++]! + (isRelative ? cy : 0);
        const segs = arcToCubics(cx, cy, arx, ary, xRot, largeArc, sweep, x, y);
        for (const seg of segs) {
          addCubic(points, seg.cp1x, seg.cp1y, seg.cp2x, seg.cp2y, seg.x, seg.y);
        }
        cx = x;
        cy = y;
      }
      prevType = 'A';
    } else {
      // Unknown command — skip its args rather than truncating the whole path.
      prevType = upperCmd;
    }
  }
  flushRun();

  return { points: subpaths.flatMap((s) => s.points), closed, subpaths };
}

/** Back-compat: parse a path `d` attribute into BezierPoints. */
export function parseSvgPath(d: string): BezierPoint[] {
  return parseSvgPathEx(d).points;
}

/** Twice the signed area of a run — sign gives its winding direction. */
function signedArea(pts: readonly BezierPoint[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % pts.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return a;
}

/**
 * Is `p` inside the ring `pts`? Ray casting on the anchors.
 *
 * Containment used to be tested with bounding boxes, which is only a proxy: two
 * runs can nest by bbox without nesting at all (an L-shape's box swallows a
 * neighbour), and a hole placed so its box escapes its parent's is missed
 * entirely. The anchors alone are a coarse polygon, but a hole's anchors are
 * unambiguously inside or outside the outline that contains it.
 */
function pointInRing(pts: readonly BezierPoint[], px: number, py: number): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i]!;
    const b = pts[j]!;
    if ((a.y > py) !== (b.y > py)
      && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** A point on the ring's interior side, for the containment test. */
function representativePoint(pts: readonly BezierPoint[]): { x: number; y: number } {
  let x = 0;
  let y = 0;
  for (const p of pts) { x += p.x; y += p.y; }
  return { x: x / pts.length, y: y / pts.length };
}

/**
 * Re-wind the inner runs of an `fill-rule="evenodd"` path so NONZERO cuts the
 * same holes.
 *
 * The renderer fills every run as one nonzero region — a hole only appears when
 * the inner run winds against the outer one, which is what design tools emit
 * and what `evenodd` files do NOT bother to do (the rule already handles it).
 * Reversing a contained run is the whole translation: the picture is identical
 * under evenodd and now correct under nonzero, so no fill rule has to be
 * plumbed through the renderer to get a donut with a hole in it.
 */
function windForNonZero(subpaths: readonly SubPath[]): SubPath[] {
  if (subpaths.length < 2) return [...subpaths];
  const areas = subpaths.map((s) => signedArea(s.points));
  const centres = subpaths.map((s) => representativePoint(s.points));
  return subpaths.map((s, i) => {
    const c = centres[i]!;
    // Nesting depth by real containment. Odd depth = a hole under even-odd.
    let depth = 0;
    let container = -1;
    let containerArea = Infinity;
    for (let j = 0; j < subpaths.length; j++) {
      if (j === i) continue;
      if (!pointInRing(subpaths[j]!.points, c.x, c.y)) continue;
      depth += 1;
      // The IMMEDIATE container is the smallest ring that contains this one —
      // with three nested rings, winding against the outermost would leave the
      // middle one and this one turning the same way.
      const a = Math.abs(areas[j]!);
      if (a < containerArea) {
        containerArea = a;
        container = j;
      }
    }
    if (depth % 2 === 0 || container < 0) return s;
    const outer = areas[container]!;
    const own = areas[i]!;
    // Already wound against its container — nonzero cuts the hole as it stands.
    if (outer === 0 || own === 0 || Math.sign(own) !== Math.sign(outer)) return s;
    return { closed: s.closed, points: reversePoints(s.points) };
  });
}

/** Reverse a run, swapping each point's in/out handles with it. */
function reversePoints(pts: readonly BezierPoint[]): BezierPoint[] {
  return pts.map((p) => ({ x: p.x, y: p.y, inX: p.outX, inY: p.outY, outX: p.inX, outY: p.inY })).reverse();
}

// ---------------------------------------------------------------------------
// Basic shape elements → bezier points (user space).
// ---------------------------------------------------------------------------

/** Kappa constant for approximating a quarter circle with a cubic bezier. */
const KAPPA = 0.5522847498307936;

function num(el: Element, attr: string, dflt = 0): number {
  const v = el.getAttribute(attr);
  if (v == null || v === '') return dflt;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : dflt;
}

/** Ellipse (or circle) centered at (cx,cy) with radii rx,ry as 4 cubic arcs. */
function ellipsePoints(cx: number, cy: number, rx: number, ry: number): BezierPoint[] {
  const ox = rx * KAPPA;
  const oy = ry * KAPPA;
  // Anchors at right, bottom, left, top (clockwise).
  const pts: BezierPoint[] = [
    { x: cx + rx, y: cy, inX: cx + rx, inY: cy - oy, outX: cx + rx, outY: cy + oy },
    { x: cx, y: cy + ry, inX: cx + ox, inY: cy + ry, outX: cx - ox, outY: cy + ry },
    { x: cx - rx, y: cy, inX: cx - rx, inY: cy + oy, outX: cx - rx, outY: cy - oy },
    { x: cx, y: cy - ry, inX: cx - ox, inY: cy - ry, outX: cx + ox, outY: cy - ry },
  ];
  return pts;
}

function rectPoints(x: number, y: number, w: number, h: number, rx: number, ry: number): BezierPoint[] {
  const corner = (px: number, py: number): BezierPoint => ({ x: px, y: py, inX: px, inY: py, outX: px, outY: py });
  if (rx <= 0 && ry <= 0) {
    return [corner(x, y), corner(x + w, y), corner(x + w, y + h), corner(x, y + h)];
  }
  rx = Math.min(rx, w / 2);
  ry = Math.min(ry, h / 2);
  const ox = rx * KAPPA;
  const oy = ry * KAPPA;
  // 8 anchors, corners rounded (clockwise from top-left after the round).
  return [
    // top edge, after top-left corner
    { x: x + rx, y, inX: x + rx, inY: y, outX: x + w - rx, outY: y },
    { x: x + w - rx, y, inX: x + w - rx, inY: y, outX: x + w - rx + ox, outY: y },
    // top-right corner -> right edge
    { x: x + w, y: y + ry, inX: x + w, inY: y + ry - oy, outX: x + w, outY: y + h - ry },
    // right edge -> bottom-right corner
    { x: x + w - rx, y: y + h, inX: x + w - rx + ox, inY: y + h, outX: x + w - rx, outY: y + h },
    // bottom edge
    { x: x + rx, y: y + h, inX: x + rx, inY: y + h, outX: x + rx - ox, outY: y + h },
    // bottom-left corner -> left edge
    { x: x, y: y + h - ry, inX: x, inY: y + h - ry + oy, outX: x, outY: y + ry },
    // left edge -> top-left corner
    { x: x, y: y + ry, inX: x, inY: y + ry, outX: x, outY: y + ry - oy },
    // close toward first anchor
    { x: x + rx, y, inX: x + rx - ox, inY: y, outX: x + rx, outY: y },
  ];
}

function pointsListToBezier(list: string | null): BezierPoint[] {
  if (!list) return [];
  const nums = (list.match(/-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) || []).map(Number);
  const pts: BezierPoint[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    const x = nums[i]!;
    const y = nums[i + 1]!;
    pts.push({ x, y, inX: x, inY: y, outX: x, outY: y });
  }
  return pts;
}

// ---------------------------------------------------------------------------
// Style resolution + traversal.
// ---------------------------------------------------------------------------

interface StyleCtx {
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  /** The `color` property, so `currentColor` resolves the way a browser does. */
  color?: string;
  /**
   * Group and element `opacity`, already multiplied down the tree (0..1).
   *
   * `opacity` is NOT an inherited property — it applies to the element (or the
   * group's whole rendered result) as one unit. Flattening a group into
   * independent shape layers is exactly the case where multiplying it down is
   * the faithful translation.
   */
  opacity: number;
  /** Inherited `fill-opacity` / `stroke-opacity` (0..1). */
  fillOpacity: number;
  strokeOpacity: number;
  /** `visibility` — inherited, and a descendant may turn it back on. */
  visible: boolean;
  /**
   * Inherited text properties.
   *
   * All of these are ordinary inherited CSS properties, so a `<g font-family>`
   * around a label is the normal way to author one — reading them off the
   * `<text>` element alone (which is what this used to do for `font-size`, and
   * not at all for the rest) rendered every imported label in the app's default
   * face at a guessed size.
   */
  fontSize: number;
  fontFamily?: string;
  fontWeight?: string;
  fontStyle?: string;
  textAnchor: 'start' | 'middle' | 'end';
}

/** Declarations from an element's inline `style` attribute. */
function parseInlineStyle(style: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!style) return out;
  for (const decl of style.split(';')) {
    const idx = decl.indexOf(':');
    if (idx < 0) continue;
    out.set(decl.slice(0, idx).trim().toLowerCase(), decl.slice(idx + 1).trim());
  }
  return out;
}

/** Presentation properties read off an element, in cascade order. */
const PRESENTATION_ATTRS = [
  'fill', 'stroke', 'stroke-width', 'opacity', 'fill-opacity', 'stroke-opacity',
  'color', 'display', 'visibility',
  'font-size', 'font-family', 'font-weight', 'font-style', 'text-anchor',
] as const;

/** The root font size `rem` resolves against — CSS's initial value. */
const ROOT_FONT_SIZE = 16;

/**
 * A `font-size` declaration in user units, or undefined to keep the inherited
 * one.
 *
 * `em` and `%` are relative to the PARENT's computed size and `rem` to the
 * root's, which is the entire font-size cascade and cheap to run here. Treating
 * them as unresolvable (which is what `absoluteLength` does) left `1.5em`
 * labels at the inherited size — a common way for an exported icon to declare
 * type, and a silent one to get wrong.
 */
function fontSizeOf(raw: string | undefined, inherited: number): number | undefined {
  if (!raw) return undefined;
  const s = raw.trim();
  const rel = /^(-?\d*\.?\d+(?:[eE][-+]?\d+)?)\s*(em|rem|%)$/i.exec(s);
  if (rel) {
    const n = Number.parseFloat(rel[1]!);
    if (!Number.isFinite(n)) return undefined;
    const unit = rel[2]!.toLowerCase();
    if (unit === '%') return (inherited * n) / 100;
    return unit === 'rem' ? ROOT_FONT_SIZE * n : inherited * n;
  }
  return absoluteLength(s);
}

/** An alpha-ish declaration as 0..1, or null when it isn't a number. */
function parseAlpha(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const s = raw.trim();
  const pct = /^(-?[\d.]+)%$/.exec(s);
  const n = pct ? Number(pct[1]) / 100 : Number(s);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : null;
}

/**
 * Everything declared on an element, in CSS cascade order.
 *
 * Presentation attributes sit BELOW any stylesheet rule (they behave like an
 * author rule of specificity zero), and inline `style` sits above both. Reading
 * only the attributes and the inline style — which is all this did — meant a
 * `<style>`-driven file imported with none of its colours.
 */
function declaredOn(el: Element, css: ReadonlyMap<string, string> | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const name of PRESENTATION_ATTRS) {
    const v = el.getAttribute(name);
    if (v != null) out.set(name, v);
  }
  if (css) for (const [k, v] of css) out.set(k, v);
  for (const [k, v] of parseInlineStyle(el.getAttribute('style'))) out.set(k, v);
  return out;
}

/** Merge an element's declarations over an inherited style. */
function resolveStyle(
  el: Element,
  inherited: StyleCtx,
  cssFor?: ReadonlyMap<Element, ReadonlyMap<string, string>>,
): StyleCtx {
  const d = declaredOn(el, cssFor?.get(el));
  const next: StyleCtx = { ...inherited };

  // `color` first: `currentColor` on the SAME element resolves against it.
  const color = d.get('color');
  if (color && color !== 'inherit' && color !== 'currentColor') next.color = color;

  const paint = (raw: string | undefined): string | undefined => {
    if (raw === undefined || raw === 'inherit') return undefined;
    // `currentColor` used to reach the renderer verbatim, where it is not a
    // valid `fillStyle`/`strokeStyle` — Canvas2D IGNORES an invalid assignment,
    // so the shape was painted with whatever colour happened to be set last
    // (black, for a fresh context). Resolving it here makes the outcome the
    // one the browser would give: the inherited `color`, black by default.
    if (raw.trim() === 'currentColor') return next.color ?? '#000000';
    return raw;
  };
  const f = paint(d.get('fill'));
  if (f !== undefined) next.fill = f;
  const s = paint(d.get('stroke'));
  if (s !== undefined) next.stroke = s;

  const sw = d.get('stroke-width');
  if (sw != null) {
    const n = parseFloat(sw);
    if (Number.isFinite(n)) next.strokeWidth = n;
  }

  // Group opacity MULTIPLIES down; fill/stroke opacity are inherited outright.
  const op = parseAlpha(d.get('opacity'));
  if (op !== null) next.opacity = inherited.opacity * op;
  const fo = parseAlpha(d.get('fill-opacity'));
  if (fo !== null) next.fillOpacity = fo;
  const so = parseAlpha(d.get('stroke-opacity'));
  if (so !== null) next.strokeOpacity = so;

  // `visibility` is inherited and a descendant may set it back to `visible`.
  const vis = d.get('visibility')?.trim().toLowerCase();
  if (vis === 'hidden' || vis === 'collapse') next.visible = false;
  else if (vis === 'visible') next.visible = true;

  // Text properties, all inherited. `em`/`%` resolve against the INHERITED
  // size, which is the whole of the font-size cascade — `rem` against the root,
  // for which 16 is the initial value this parser starts from.
  const fs = fontSizeOf(d.get('font-size'), inherited.fontSize);
  if (fs !== undefined && fs > 0) next.fontSize = fs;
  const ff = d.get('font-family');
  if (ff && ff !== 'inherit') next.fontFamily = ff.trim();
  const fw = d.get('font-weight');
  if (fw && fw !== 'inherit') next.fontWeight = fw.trim();
  const fst = d.get('font-style');
  if (fst && fst !== 'inherit') next.fontStyle = fst.trim();
  const anchor = d.get('text-anchor')?.trim().toLowerCase();
  if (anchor === 'start' || anchor === 'middle' || anchor === 'end') next.textAnchor = anchor;

  return next;
}

/** One styled span of a `<text>` — a `<tspan>`, or the text between them. */
export interface TextRun {
  content: string;
  style: StyleCtx;
}

/**
 * Split a `<text>` into its styled runs, or null when it is all one style.
 *
 * A `<tspan>` exists to restyle part of a label — usually to recolour a word —
 * and the parser used to take `textContent` of the whole element, so a
 * two-colour label imported in one colour. Returning null for the ordinary case
 * keeps every single-style label on exactly the path it took before.
 */
function textRunsOf(
  el: Element,
  base: StyleCtx,
  css?: ReadonlyMap<Element, ReadonlyMap<string, string>>,
): TextRun[] | null {
  const runs: TextRun[] = [];
  let styled = false;
  const walk = (node: Node, style: StyleCtx): void => {
    for (let i = 0; i < node.childNodes.length; i++) {
      const child = node.childNodes[i]!;
      if (child.nodeType === 3 /* text */) {
        const text = child.nodeValue ?? '';
        if (text.trim()) runs.push({ content: text, style });
        continue;
      }
      if (child.nodeType !== 1 /* element */) continue;
      const childEl = child as Element;
      const tag = childEl.tagName.toLowerCase().replace(/^svg:/, '');
      // A nested <textPath> is reported separately; its text still counts.
      if (tag !== 'tspan' && tag !== 'textpath') continue;
      const childStyle = resolveStyle(childEl, style, css);
      if (childStyle.fill !== style.fill || childStyle.fontWeight !== style.fontWeight
        || childStyle.fontSize !== style.fontSize || childStyle.fontStyle !== style.fontStyle) {
        styled = true;
      }
      walk(childEl, childStyle);
    }
  };
  walk(el, base);
  return styled && runs.length > 1 ? runs : null;
}

/** The initial style — CSS initial values, and the root of every cascade. */
const DEFAULT_STYLE: StyleCtx = {
  fill: '#000000',
  opacity: 1,
  fillOpacity: 1,
  strokeOpacity: 1,
  visible: true,
  fontSize: 16,
  textAnchor: 'start',
};

/** `display: none` removes the element AND its subtree from the rendering. */
function isDisplayNone(el: Element, cssFor?: ReadonlyMap<Element, ReadonlyMap<string, string>>): boolean {
  const d = declaredOn(el, cssFor?.get(el));
  return d.get('display')?.trim().toLowerCase() === 'none';
}

interface RawShape {
  name: string;
  points: BezierPoint[];
  closed: boolean;
  /** Present only for a path with more than one run — see `SubPath`. */
  subpaths?: SubPath[];
  /** Clip regions from this element and its ancestors, outermost first. */
  clips?: SubPath[][];
  style: StyleCtx;
  textContent?: string;
  fontSize?: number;
  /** `<image>` source — this shape is a bitmap, not an outline. */
  imageHref?: string;
  /** Differently-styled spans of one `<text>` — see `textRunsOf`. */
  textRuns?: TextRun[];
  /**
   * Every factor of `matrix`, outermost first — see `MatrixFactor`.
   *
   * The element factors are this element and its ancestors (SMIL on a <g>
   * affects it too); the fixed ones are the coordinate systems between them.
   */
  factors: MatrixFactor[];
  /** The fully composed static matrix baked into `points`. */
  matrix: Mat;
}

/** Extract user-space geometry for a single shape element (null if none). */
function elementGeometry(el: Element, style: StyleCtx): { points: BezierPoint[]; closed: boolean; subpaths?: SubPath[]; textContent?: string; fontSize?: number; imageHref?: string } | null {
  const tag = el.tagName.toLowerCase().replace(/^svg:/, '');
  switch (tag) {
    case 'path': {
      const d = el.getAttribute('d');
      if (!d) return null;
      const { points, closed, subpaths } = parseSvgPathEx(d);
      if (points.length === 0) return null;
      if (subpaths.length < 2) return { points, closed };
      // `fill-rule` may be a presentation attribute or a style declaration; the
      // stylesheet form is rare enough on a path that the two direct spellings
      // cover it, and getting it wrong only costs the hole a rewind it does not
      // need (`windForNonZero` leaves correctly-wound runs alone).
      const rule = (el.getAttribute('fill-rule')
        ?? /(?:^|;)\s*fill-rule\s*:\s*([^;]+)/i.exec(el.getAttribute('style') ?? '')?.[1]
        ?? '').trim().toLowerCase();
      const runs = rule === 'evenodd' ? windForNonZero(subpaths) : subpaths;
      return { points: runs.flatMap((r) => r.points), closed, subpaths: runs };
    }
    case 'rect': {
      const w = num(el, 'width');
      const h = num(el, 'height');
      if (w <= 0 || h <= 0) return null;
      const x = num(el, 'x');
      const y = num(el, 'y');
      let rx = el.getAttribute('rx') != null ? num(el, 'rx') : NaN;
      let ry = el.getAttribute('ry') != null ? num(el, 'ry') : NaN;
      if (Number.isNaN(rx) && !Number.isNaN(ry)) rx = ry;
      if (Number.isNaN(ry) && !Number.isNaN(rx)) ry = rx;
      if (Number.isNaN(rx)) rx = 0;
      if (Number.isNaN(ry)) ry = 0;
      return { points: rectPoints(x, y, w, h, rx, ry), closed: true };
    }
    case 'circle': {
      const r = num(el, 'r');
      if (r <= 0) return null;
      return { points: ellipsePoints(num(el, 'cx'), num(el, 'cy'), r, r), closed: true };
    }
    case 'ellipse': {
      const rx = num(el, 'rx');
      const ry = num(el, 'ry');
      if (rx <= 0 || ry <= 0) return null;
      return { points: ellipsePoints(num(el, 'cx'), num(el, 'cy'), rx, ry), closed: true };
    }
    case 'polygon': {
      const pts = pointsListToBezier(el.getAttribute('points'));
      return pts.length ? { points: pts, closed: true } : null;
    }
    case 'polyline': {
      const pts = pointsListToBezier(el.getAttribute('points'));
      return pts.length ? { points: pts, closed: false } : null;
    }
    case 'line': {
      const x1 = num(el, 'x1');
      const y1 = num(el, 'y1');
      const x2 = num(el, 'x2');
      const y2 = num(el, 'y2');
      return {
        points: [
          { x: x1, y: y1, inX: x1, inY: y1, outX: x1, outY: y1 },
          { x: x2, y: y2, inX: x2, inY: y2, outX: x2, outY: y2 },
        ],
        closed: false,
      };
    }
    case 'image': {
      // An embedded bitmap, which becomes a real image layer rather than being
      // dropped. Its `href` is the source: after sanitizing, a remote one is
      // already gone, so what survives is a `data:` URI the scene can hold.
      const w = num(el, 'width');
      const h = num(el, 'height');
      if (w <= 0 || h <= 0) return null;
      const href = el.getAttribute('href')
        ?? el.getAttributeNS('http://www.w3.org/1999/xlink', 'href')
        ?? el.getAttribute('xlink:href');
      if (!href) return null;
      const x = num(el, 'x');
      const y = num(el, 'y');
      return {
        points: rectPoints(x, y, w, h, 0, 0),
        closed: true,
        imageHref: href.trim(),
      };
    }
    case 'text':
    case 'tspan': {
      const txt = (el.textContent || '').trim();
      if (!txt) return null;
      const x = num(el, 'x');
      const y = num(el, 'y');
      // The single point is the ANCHOR, not the box: `x` is where `text-anchor`
      // pins the run and `y` is its BASELINE. Both are resolved into a real box
      // later, once something has measured the glyphs (see `measureText`).
      return {
        points: [{ x, y, inX: x, inY: y, outX: x, outY: y }],
        closed: false,
        textContent: txt,
        fontSize: style.fontSize,
      };
    }
    default:
      return null;
  }
}

function transformPoints(points: BezierPoint[], m: Mat): BezierPoint[] {
  if (m === IDENTITY) return points;
  return points.map((p) => {
    const a = applyMat(m, p.x, p.y);
    const inH = applyMat(m, p.inX, p.inY);
    const outH = applyMat(m, p.outX, p.outY);
    return { x: a.x, y: a.y, inX: inH.x, inY: inH.y, outX: outH.x, outY: outH.y };
  });
}

const SHAPE_TAGS = new Set(['path', 'rect', 'circle', 'ellipse', 'polygon', 'polyline', 'line', 'text', 'tspan', 'image']);
const SKIP_TAGS = new Set(['defs', 'clippath', 'mask', 'symbol', 'lineargradient', 'radialgradient', 'filter', 'metadata', 'title', 'desc', 'style', 'marker', 'pattern']);

/** How deep `<use>` may chain before we call it a reference cycle. */
const MAX_USE_DEPTH = 12;

/**
 * The element a `<use>` points at, or null.
 *
 * `href` is the SVG 2 spelling and `xlink:href` the SVG 1.1 one — exporters
 * still emit both, and `getAttribute('xlink:href')` works without namespace
 * awareness because the attribute's qualified name is literally that string.
 */
function resolveUseTarget(el: Element): Element | null {
  const raw = el.getAttribute('href')
    ?? el.getAttributeNS('http://www.w3.org/1999/xlink', 'href')
    ?? el.getAttribute('xlink:href');
  if (!raw) return null;
  const id = raw.trim().startsWith('#') ? raw.trim().slice(1) : null;
  if (!id) return null; // external file reference — not resolvable from the markup
  const doc = el.ownerDocument;
  // Not `getElementById`: ids inside <defs> resolve fine, but a document parsed
  // as image/svg+xml has no DTD, so nothing is registered as an ID type in some
  // engines. A scoped attribute query is exact and always works.
  const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(id)
    : id.replace(/["\\]/g, '\\$&');
  try {
    return doc.querySelector(`[id="${escaped}"]`);
  } catch {
    return null; // unquotable id — treat as unresolvable rather than throwing mid-parse
  }
}

/**
 * The viewport transform a nested `<svg>` (or a `<symbol>` reached through
 * `<use>`) establishes: translate to its x/y, then map its viewBox into its
 * width/height box the same way the root does.
 *
 * Without this, a nested `<svg>` was traversed as if it were a plain `<g>` — its
 * children landed in the OUTER coordinate system at their raw viewBox numbers,
 * which is exactly the "parts scattered to the wrong places" failure on files
 * that compose several icons into one artboard.
 */
function nestedViewportMatrix(el: Element, fallbackW?: number, fallbackH?: number): Mat {
  const x = Number.parseFloat(el.getAttribute('x') ?? '0') || 0;
  const y = Number.parseFloat(el.getAttribute('y') ?? '0') || 0;
  const w = absoluteLength(el.getAttribute('width')) ?? fallbackW;
  const h = absoluteLength(el.getAttribute('height')) ?? fallbackH;
  const translate: Mat = [1, 0, 0, 1, x, y];
  const vb = parseViewBox(el.getAttribute('viewBox'));
  if (!vb || w === undefined || h === undefined || w <= 0 || h <= 0) return translate;
  const [minX, minY, vbW, vbH] = vb;
  if (vbW <= 0 || vbH <= 0) return translate;
  const s = Math.min(w / vbW, h / vbH); // preserveAspectRatio xMidYMid meet
  const tx = -minX * s + (w - vbW * s) / 2;
  const ty = -minY * s + (h - vbH * s) / 2;
  return matMul(translate, [s, 0, 0, s, tx, ty]);
}

/** Everything a traversal needs that does not change as it descends. */
interface TraverseCtx {
  out: RawShape[];
  /** `<style>`-declared presentation properties, resolved per element. */
  css?: ReadonlyMap<Element, ReadonlyMap<string, string>>;
  /** Names of features that were recognised but could not be reproduced. */
  unsupported: Set<string>;
}

/** The `url(#id)` an attribute references, or null. */
function urlRef(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = /^url\(\s*['"]?#([^'")\s]+)['"]?\s*\)/i.exec(raw.trim());
  return m ? m[1]! : null;
}

/** An element by id, without relying on the document registering ID types. */
function byId(doc: Document, id: string): Element | null {
  const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(id)
    : id.replace(/["\\]/g, '\\$&');
  try {
    return doc.querySelector(`[id="${escaped}"]`);
  } catch {
    return null;
  }
}

/**
 * The runs a `<clipPath>` describes, in the referencing element's space.
 *
 * `clipPathUnits` defaults to `userSpaceOnUse`, i.e. the same coordinates the
 * clipped element is drawn in — so the caller's matrix is the right one to bake
 * with. `objectBoundingBox` resolves against the clipped element's own bounds,
 * which are not known until it has been built, and is reported instead.
 */
function clipRunsOf(
  clipEl: Element,
  matrix: Mat,
  ctx: TraverseCtx,
): SubPath[] {
  const units = (clipEl.getAttribute('clipPathUnits') ?? 'userSpaceOnUse').trim();
  if (units === 'objectBoundingBox') {
    ctx.unsupported.add('clipPathUnits="objectBoundingBox"');
    return [];
  }
  const runs: SubPath[] = [];
  const walk = (el: Element, m: Mat): void => {
    const tag = el.tagName.toLowerCase().replace(/^svg:/, '');
    const local = matMul(m, parseTransform(el.getAttribute('transform')));
    if (tag === 'use') {
      const target = resolveUseTarget(el);
      if (target) walk(target, local);
      return;
    }
    if (SHAPE_TAGS.has(tag)) {
      // A clip region is pure geometry: text inside one clips by its glyphs,
      // which this cannot reproduce, so it is reported rather than approximated
      // by the text's box.
      if (tag === 'text' || tag === 'tspan') {
        ctx.unsupported.add('text inside clip-path');
        return;
      }
      const geom = elementGeometry(el, DEFAULT_STYLE);
      if (!geom) return;
      const source = geom.subpaths ?? [{ points: geom.points, closed: geom.closed }];
      for (const r of source) runs.push({ points: transformPoints(r.points, local), closed: true });
      return;
    }
    for (let i = 0; i < el.children.length; i++) walk(el.children[i]!, local);
  };
  for (let i = 0; i < clipEl.children.length; i++) walk(clipEl.children[i]!, matrix);
  return runs;
}

/** Recursively collect shapes with accumulated transform + inherited style. */
function traverse(
  el: Element,
  matrix: Mat,
  style: StyleCtx,
  ctx: TraverseCtx,
  ancestors: Element[] = [],
  useDepth = 0,
  factors: readonly MatrixFactor[] = [],
  clips: readonly SubPath[][] = [],
): void {
  const tag = el.tagName.toLowerCase().replace(/^svg:/, '');
  if (SKIP_TAGS.has(tag)) return;
  // `display: none` takes the whole subtree out of the rendering, so an
  // exporter's hidden guide layer must not import as a visible shape.
  if (isDisplayNone(el, ctx.css)) return;

  const out = ctx.out;
  const localMatrix = matMul(matrix, parseTransform(el.getAttribute('transform')));
  const localStyle = resolveStyle(el, style, ctx.css);
  const chain = [el, ...ancestors];
  const localFactors: MatrixFactor[] = [...factors, { el }];

  // `clip-path` clips the element AND its whole subtree, and nested clips
  // compound — so they accumulate down the tree like a transform does, and a
  // shape is cut by every one of them in turn.
  let localClips = clips;
  const clipId = urlRef(el.getAttribute('clip-path')
    ?? declaredOn(el, ctx.css?.get(el)).get('clip-path'));
  if (clipId) {
    const clipEl = byId(el.ownerDocument, clipId);
    const clipTag = clipEl?.tagName.toLowerCase().replace(/^svg:/, '');
    if (clipEl && clipTag === 'clippath') {
      const runs = clipRunsOf(clipEl, localMatrix, ctx);
      // An empty clip region hides everything it is applied to — that IS the
      // rendering, so honour it rather than treating it as "no clip".
      if (runs.length > 0) localClips = [...clips, runs];
      else return;
    }
  }

  // <use>: instantiate the referenced element here. Icon sets, sprite sheets and
  // most "one artboard, many copies" exports are built entirely out of these, so
  // dropping them silently meant whole parts of the file simply never appeared.
  if (tag === 'use') {
    if (useDepth >= MAX_USE_DEPTH) return;
    const target = resolveUseTarget(el);
    if (!target) return;
    // A <use> may not reference itself or an ancestor — that is an infinite
    // expansion, and a hostile or merely broken file should not hang the import.
    if (chain.includes(target)) return;
    const ux = Number.parseFloat(el.getAttribute('x') ?? '0') || 0;
    const uy = Number.parseFloat(el.getAttribute('y') ?? '0') || 0;
    const offset: Mat = [1, 0, 0, 1, ux, uy];
    const shifted = ux !== 0 || uy !== 0;
    const placed = shifted ? matMul(localMatrix, offset) : localMatrix;
    const placedFactors = shifted ? [...localFactors, { fixed: offset }] : localFactors;
    const targetTag = target.tagName.toLowerCase().replace(/^svg:/, '');
    if (targetTag === 'symbol' || targetTag === 'svg') {
      // <symbol>/<svg> targets take their viewport from the <use>'s own
      // width/height when they don't declare one (SVG 1.1 §5.6).
      const vp = nestedViewportMatrix(
        target,
        absoluteLength(el.getAttribute('width')),
        absoluteLength(el.getAttribute('height')),
      );
      const inner = matMul(placed, vp);
      const innerFactors = [...placedFactors, { fixed: vp }];
      for (let i = 0; i < target.children.length; i++) {
        traverse(target.children[i]!, inner, localStyle, ctx, chain, useDepth + 1, innerFactors, localClips);
      }
    } else {
      traverse(target, placed, localStyle, ctx, chain, useDepth + 1, placedFactors, localClips);
    }
    return;
  }

  // A nested <svg> establishes a new viewport; the ROOT one is handled by
  // `rootMatrixFromSvg` before traversal, so only descendants apply it here.
  if (tag === 'svg' && ancestors.length > 0) {
    const vp = nestedViewportMatrix(el);
    const inner = matMul(localMatrix, vp);
    const innerFactors = [...localFactors, { fixed: vp }];
    for (let i = 0; i < el.children.length; i++) {
      traverse(el.children[i]!, inner, localStyle, ctx, chain, useDepth, innerFactors, localClips);
    }
    return;
  }

  if (SHAPE_TAGS.has(tag)) {
    // Text laid along a curve. The run still imports — as a straight baseline,
    // because that is the only kind of text layer the scene has — but the curve
    // is genuinely lost, and saying so beats letting the user discover it.
    if ((tag === 'text' || tag === 'tspan') && el.getElementsByTagName('textPath').length > 0) {
      ctx.unsupported.add('textPath (text on a curve imports straight)');
    }
    // `visibility: hidden` hides the element but keeps its box; there is no
    // "invisible but present" shape layer to import it as, and a fully
    // transparent one is the same picture with a layer the user can un-hide.
    if (!localStyle.visible) return;
    const geom = elementGeometry(el, localStyle);
    if (geom) {
      out.push({
        name: el.getAttribute('id') || (geom.textContent ? `Text: ${geom.textContent.slice(0, 15)}` : `SVG ${tag} ${out.length + 1}`),
        points: transformPoints(geom.points, localMatrix),
        closed: geom.closed,
        ...(geom.subpaths
          ? { subpaths: geom.subpaths.map((r) => ({ points: transformPoints(r.points, localMatrix), closed: r.closed })) }
          : {}),
        style: localStyle,
        textContent: geom.textContent,
        fontSize: geom.fontSize,
        imageHref: geom.imageHref,
        ...(geom.textContent !== undefined && tag === 'text'
          ? { textRuns: textRunsOf(el, localStyle, ctx.css) ?? undefined }
          : {}),
        factors: localFactors,
        matrix: localMatrix,
        ...(localClips.length > 0 ? { clips: localClips.map((c) => [...c]) } : {}),
      });
    }
    return;
  }

  // Containers (svg, g, a, switch,...) — recurse into children.
  for (let i = 0; i < el.children.length; i++) {
    traverse(el.children[i]!, localMatrix, localStyle, ctx, chain, useDepth, localFactors, localClips);
  }
}

/**
 * An SVG length attribute in user units, or undefined when it isn't one.
 *
 * `width="100%"` used to parse as `100`, which invented a 100×100 pixel box for
 * a file that declares none — the whole artwork then imported at an arbitrary
 * fraction of its viewBox scale. A percentage (or any relative unit) resolves
 * against a containing block the importer does not have, so the honest answer is
 * "no pixel box", which falls back to the viewBox's own units.
 */
function absoluteLength(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const s = raw.trim();
  const m = /^(-?\d*\.?\d+(?:[eE][-+]?\d+)?)\s*(px|pt|pc|mm|cm|in|q)?$/i.exec(s);
  if (!m) return undefined; // %, em, rem, vw, … — not resolvable here
  const n = Number.parseFloat(m[1]!);
  if (!Number.isFinite(n)) return undefined;
  // CSS absolute units, all defined against 96dpi.
  const perUnit: Record<string, number> = { px: 1, pt: 96 / 72, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96, q: 96 / 101.6 };
  return n * (perUnit[(m[2] ?? 'px').toLowerCase()] ?? 1);
}

/** `viewBox` as [minX, minY, width, height], or null. */
function parseViewBox(raw: string | null): [number, number, number, number] | null {
  if (!raw) return null;
  const parts = (raw.match(/-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) || []).map(Number);
  return parts.length === 4 ? (parts as [number, number, number, number]) : null;
}

/** Build the root matrix that maps viewBox units into the SVG's pixel box. */
function rootMatrixFromSvg(svg: Element): Mat {
  const vbAttr = svg.getAttribute('viewBox');
  const width = absoluteLength(svg.getAttribute('width')) ?? NaN;
  const height = absoluteLength(svg.getAttribute('height')) ?? NaN;

  if (vbAttr) {
    const parts = parseViewBox(vbAttr) ?? [];
    if (parts.length === 4) {
      const [minX, minY, vbW, vbH] = parts as [number, number, number, number];
      if (vbW > 0 && vbH > 0 && Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
        // preserveAspectRatio xMidYMid meet (uniform scale, centered).
        const s = Math.min(width / vbW, height / vbH);
        const tx = -minX * s + (width - vbW * s) / 2;
        const ty = -minY * s + (height - vbH * s) / 2;
        return [s, 0, 0, s, tx, ty];
      }
      // No pixel box: just offset by viewBox origin.
      return [1, 0, 0, 1, -minX, -minY];
    }
  }
  return IDENTITY;
}

export interface SvgParseOptions extends SvgAnimationOptions {
  /** Resolves a text run's real box. Without it text keeps its 10×10 stand-in. */
  measureText?: SvgTextMeasurer;
  /** Cuts geometry at `clip-path`. Without it a clipped shape draws in full. */
  intersectPaths?: SvgPathIntersector;
}

/** Parses XML string of SVG and returns list of parsed shapes with centered bounding boxes. */
export function parseSvgToShapes(svgContent: string, opts?: SvgParseOptions): ParsedShape[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgContent, 'image/svg+xml');
  const svg = doc.documentElement;

  // Malformed XML → let the caller fall back to image insert.
  if (!svg || svg.tagName.toLowerCase() === 'parsererror' || doc.getElementsByTagName('parsererror').length > 0) {
    return [];
  }

  const rootMatrix = rootMatrixFromSvg(svg);
  const rootStyle: StyleCtx = { ...DEFAULT_STYLE };
  /** Features the TRAVERSAL could not reproduce (the animation scan has its own). */
  const parseUnsupported = new Set<string>();

  // `<style>` rules, resolved onto elements BEFORE traversal — they decide what
  // the geometry looks like, and for a CSS-animated file they are usually the
  // only place the colours are declared at all.
  const cssPresentation = readCssPresentation(doc);

  // Gradients/patterns can't be reproduced as vector fills — approximate each
  // `url(#id)` paint with the referenced gradient's FIRST stop colour so a
  // vectorized shape gets a sensible solid fill instead of a broken/black one.
  const gradMap = new Map<string, string>();
  for (const g of Array.from(doc.querySelectorAll('linearGradient,radialGradient'))) {
    const id = g.getAttribute('id');
    if (!id) continue;
    const stop = g.querySelector('stop');
    const styleColor = /stop-color:\s*([^;]+)/i.exec(stop?.getAttribute('style') ?? '')?.[1]?.trim();
    const color = stop?.getAttribute('stop-color') || styleColor || '#cccccc';
    gradMap.set(id, color);
  }
  const resolvePaint = (v: string | undefined): string | undefined => {
    if (!v) return v;
    const m = /^url\(\s*#([^)\s]+)\s*\)/i.exec(v.trim());
    return m ? (gradMap.get(m[1]!) ?? '#cccccc') : v;
  };

  const raw: RawShape[] = [];
  // The <svg> element itself may carry a transform; start traversal from it.
  // The root viewBox→pixel-box mapping goes in as a FIXED factor so the
  // animation translator can rebuild the matrix in the same space (MatrixFactor).
  traverse(svg, rootMatrix, rootStyle, { out: raw, css: cssPresentation, unsupported: parseUnsupported }, [], 0, [{ fixed: rootMatrix }]);

  // Animation, read once for the whole document and attached per shape.
  const scan = scanSvgAnimations(doc, opts);

  // An element's own `opacity` still applies while an opacity animation is
  // running somewhere else on its chain, so the sampler needs to see it.
  const staticOpacityOf = (el: Element): number => {
    const raw = declaredOn(el, cssPresentation.get(el)).get('opacity');
    return parseAlpha(raw) ?? 1;
  };

  let keyframeBudget = MAX_IMPORT_KEYFRAMES;

  const shapes: ParsedShape[] = [];
  for (const r of raw) {
    // CUT THE GEOMETRY at every clip region that reaches this shape. There is
    // no draw-time clip in the scene, so the alternative is what used to
    // happen: the clip is dropped and the shape draws in full, spilling past
    // the boundary the file drew it inside.
    if (r.clips && r.clips.length > 0 && opts?.intersectPaths && r.textContent === undefined) {
      let runs: SubPath[] = r.subpaths ?? [{ points: r.points, closed: r.closed }];
      for (const clip of r.clips) {
        const cut = opts.intersectPaths(runs, clip);
        if (!cut) break; // the intersector gave up — keep the unclipped shape
        runs = cut;
        if (runs.length === 0) break;
      }
      // Clipped away entirely: the file does not draw this, so nor do we.
      if (runs.length === 0) continue;
      r.points = runs.flatMap((run) => run.points);
      r.subpaths = runs.length > 1 ? runs : undefined;
      r.closed = runs.every((run) => run.closed);
    }

    // A `<text>` whose `<tspan>`s restyle part of it becomes ONE LAYER PER RUN,
    // laid out left to right by measured advance. Taking `textContent` of the
    // whole element (which is what happens without this) renders a two-colour
    // label in one colour — the tspan exists precisely to say otherwise.
    // Needs a measurer to know where each run ends; without one it falls
    // through to the single combined run, exactly as before.
    if (r.textRuns && opts?.measureText && r.points.length > 0) {
      const measured = r.textRuns.map((run) => ({
        run,
        m: opts.measureText!({
          content: run.content,
          fontSize: run.style.fontSize,
          ...(run.style.fontFamily ? { fontFamily: run.style.fontFamily } : {}),
          ...(run.style.fontWeight ? { fontWeight: run.style.fontWeight } : {}),
          ...(run.style.fontStyle ? { fontStyle: run.style.fontStyle } : {}),
        }),
      }));
      if (measured.every((x) => x.m && x.m.width > 0)) {
        const anchor = r.points[0]!;
        const total = measured.reduce((sum, x) => sum + x.m!.advance, 0);
        // The anchor applies to the WHOLE label; the runs then divide it up.
        let cursor = anchor.x + textAnchorOffsetX(r.style.textAnchor, total) - total / 2;
        for (const { run, m } of measured) {
          const cx = cursor + m!.advance / 2;
          const cy = anchor.y - m!.baselineOffset;
          cursor += m!.advance;
          const runFill = resolvePaint(run.style.fill);
          const anim = scan.anims.length > 0 && keyframeBudget > 0
            ? buildShapeAnimation(r.factors, scan, r.matrix, { x: cx, y: cy }, { staticOpacityOf }) ?? undefined
            : undefined;
          if (anim) keyframeBudget -= countKeyframes(anim);
          shapes.push({
            name: `Text: ${run.content.trim().slice(0, 15)}`,
            points: [{ x: 0, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 }],
            fill: runFill && runFill !== 'none' ? runFill : runFill === 'none' ? 'none' : '#000000',
            closed: false,
            width: m!.width,
            height: m!.height,
            centerX: cx,
            centerY: cy,
            opacity: run.style.opacity,
            fillOpacity: run.style.fillOpacity,
            strokeOpacity: run.style.strokeOpacity,
            textContent: run.content,
            fontSize: run.style.fontSize,
            ...(run.style.fontFamily ? { fontFamily: run.style.fontFamily } : {}),
            ...(run.style.fontWeight ? { fontWeight: run.style.fontWeight } : {}),
            ...(run.style.fontStyle ? { fontStyle: run.style.fontStyle } : {}),
            ...(anim ? { animation: anim } : {}),
          });
        }
        continue;
      }
    }

    const points = r.points;
    if (points.length === 0) continue;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of points) {
      minX = Math.min(minX, p.x, p.inX, p.outX);
      minY = Math.min(minY, p.y, p.inY, p.outY);
      maxX = Math.max(maxX, p.x, p.inX, p.outX);
      maxY = Math.max(maxY, p.y, p.inY, p.outY);
    }

    let width = Math.max(10, maxX - minX);
    let height = Math.max(10, maxY - minY);
    let centerX = (minX + maxX) / 2;
    let centerY = (minY + maxY) / 2;

    // A text run has no geometry — its one point is the ANCHOR on the BASELINE,
    // which the bbox above turns into a 10×10 box sitting at the wrong place.
    // Given a measurement both resolve exactly:
    //   x  — the anchor is start/middle/end of the run, so the centre is offset
    //        by half the advance (`start` is the SVG default, and it was the
    //        case being drawn half a label too far left).
    //   y  — SVG's y is the BASELINE; the scene draws from the block's centre,
    //        and `offsetY` is precisely the distance between the two.
    // Without a measurer nothing changes, so a caller that cannot measure keeps
    // the old behaviour rather than getting invented numbers.
    if (r.textContent !== undefined && opts?.measureText) {
      const m = opts.measureText({
        content: r.textContent,
        fontSize: r.style.fontSize,
        ...(r.style.fontFamily ? { fontFamily: r.style.fontFamily } : {}),
        ...(r.style.fontWeight ? { fontWeight: r.style.fontWeight } : {}),
        ...(r.style.fontStyle ? { fontStyle: r.style.fontStyle } : {}),
      });
      if (m && m.width > 0 && m.height > 0) {
        width = m.width;
        height = m.height;
        centerX += textAnchorOffsetX(r.style.textAnchor, m.advance);
        centerY -= m.baselineOffset;
      }
    }

    const centre = (list: readonly BezierPoint[]): BezierPoint[] => list.map((p) => ({
      x: p.x - centerX,
      y: p.y - centerY,
      inX: p.inX - centerX,
      inY: p.inY - centerY,
      outX: p.outX - centerX,
      outY: p.outY - centerY,
    }));
    const centeredPoints = centre(points);
    const centeredRuns = r.subpaths?.map((run) => ({ points: centre(run.points), closed: run.closed }));

    const fillRaw = resolvePaint(r.style.fill);
    const fill = fillRaw && fillRaw !== 'none' ? fillRaw : fillRaw === 'none' ? 'none' : '#000000';
    const strokeRaw = resolvePaint(r.style.stroke);
    const strokeColor = strokeRaw && strokeRaw !== 'none' ? strokeRaw : undefined;
    const strokeWidth = r.style.strokeWidth != null && Number.isFinite(r.style.strokeWidth) ? r.style.strokeWidth : undefined;

    // Budget is spent across the whole file, not per shape: one pathological
    // artwork must not be able to generate work the app cannot absorb. Past the
    // ceiling the remaining shapes still import — they just import static.
    const animation = scan.anims.length > 0 && keyframeBudget > 0
      ? buildShapeAnimation(r.factors, scan, r.matrix, { x: centerX, y: centerY }, { staticOpacityOf }) ?? undefined
      : undefined;
    if (animation) keyframeBudget -= countKeyframes(animation);
    // Running out of budget is not a neutral outcome — the remaining shapes
    // import STATIC while the toast still says the animation converted. Say it
    // once, through the same channel every other lost feature is reported on.
    else if (scan.anims.length > 0 && keyframeBudget <= 0) {
      scan.unsupported.add('some parts (this file exceeds the keyframe budget)');
    }

    shapes.push({
      name: r.name,
      points: centeredPoints,
      fill,
      strokeColor,
      strokeWidth,
      closed: r.closed,
      ...(centeredRuns ? { subpaths: centeredRuns } : {}),
      width,
      height,
      centerX,
      centerY,
      opacity: r.style.opacity,
      fillOpacity: r.style.fillOpacity,
      strokeOpacity: r.style.strokeOpacity,
      textContent: r.textContent,
      fontSize: r.fontSize,
      ...(r.imageHref ? { imageHref: r.imageHref } : {}),
      ...(r.textContent !== undefined
        ? {
          ...(r.style.fontFamily ? { fontFamily: r.style.fontFamily } : {}),
          ...(r.style.fontWeight ? { fontWeight: r.style.fontWeight } : {}),
          ...(r.style.fontStyle ? { fontStyle: r.style.fontStyle } : {}),
        }
        : {}),
      ...(animation ? { animation } : {}),
    });
  }

  if (opts?.unsupportedOut) {
    for (const name of scan.unsupported) opts.unsupportedOut.add(name);
    for (const name of parseUnsupported) opts.unsupportedOut.add(name);
  }

  return shapes;
}

/**
 * Total keyframes one imported file may generate.
 *
 * A backstop, not a working limit: simplification keeps a real animated icon in
 * the tens, so a file that reaches this is pathological (hundreds of separately
 * animated parts). It exists because the failure mode without it is not a slow
 * import, it is a frozen application — every keyframe is an insert into a
 * sorted track and a change notification, and both are paid again by history
 * and by every frame that samples the result.
 */
export const MAX_IMPORT_KEYFRAMES = 20000;

function countKeyframes(a: SvgShapeAnimation): number {
  return (a.x?.length ?? 0) + (a.y?.length ?? 0) + (a.rotation?.length ?? 0)
    + (a.scaleX?.length ?? 0) + (a.scaleY?.length ?? 0) + (a.opacity?.length ?? 0);
}

/**
 * Most vector shapes an SVG may explode into before it is rasterized instead.
 *
 * Every parsed shape becomes its own scene layer, and the per-frame cost of a
 * layer is not free: `buildSnapshot` walks all of them every frame and each
 * path gets its own rasterized GPU texture. A 1500-path illustration measured
 * 132 ms per snapshot — the app stops responding, which is exactly the
 * "dropping an SVG freezes the whole desktop app" report. Below the ceiling the
 * user gets editable vectors; above it, one faithful image layer.
 */
export const MAX_VECTOR_SHAPES = 300;

/**
 * Features `parseSvgToShapes` cannot reproduce, so an SVG using any of them
 * must be rasterized as an image rather than silently degraded.
 *
 * This used to be `<image|use|foreignObject>` alone, which let essentially
 * every real-world SVG through: gradients collapsed to their first stop,
 * filters/masks/clip-paths/patterns were dropped outright, and the result was a
 * pile of flat shapes that did not look like the file the user imported. The
 * insert path documented this routing all along — it just never had a predicate
 * that implemented it.
 */
// `use`/`symbol` are NOT listed: `traverse` instantiates them for real now
// (geometry, nested viewport and all), so a sprite-sheet icon is reproduced
// rather than approximated, and calling it "unsupported" would push perfectly
// convertible files down the raster path.
const UNSUPPORTED_TAGS = /<(image|foreignobject|filter|mask|clippath|pattern|marker)[\s>]/;
const UNSUPPORTED_ATTRS = /\b(filter|mask|clip-path)\s*=\s*["']?[^"'\s>]*url\(/;

/**
 * True when an SVG converts LOSSLESSLY into vector shapes & text elements.
 * Anything else should be rasterized (see `insertMedia`).
 */
export function isSimpleSvg(svgContent: string): boolean {
  const s = svgContent.toLowerCase();
  if (UNSUPPORTED_TAGS.test(s)) return false;
  if (UNSUPPORTED_ATTRS.test(s)) return false;
  // Gradients survive only as their first stop — a visible downgrade on any
  // artwork that actually uses one, so hand those to the rasterizer too.
  if (/<(lineargradient|radialgradient)[\s>]/.test(s)) return false;
  return true;
}
