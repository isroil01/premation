import type { BezierPoint } from '@motion/workspace';
import { scanSvgAnimations, buildShapeAnimation, type SvgShapeAnimation, type SvgAnimationOptions } from './svgAnimation';

export interface ParsedShape {
  name: string;
  points: BezierPoint[];
  fill: string;
  strokeColor?: string;
  strokeWidth?: number;
  /** false for open outlines (polyline / line / paths without Z). */
  closed: boolean;
  // Bounding box centering offsets
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  textContent?: string;
  fontSize?: number;
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

/**
 * Parse an SVG path `d` attribute into BezierPoints (user space).
 * Supports M/L/H/V/C/S/Q/T/A/Z in absolute and relative forms.
 * Returns the points plus whether the path contained a close command.
 */
export function parseSvgPathEx(d: string): { points: BezierPoint[]; closed: boolean } {
  const tokens = parsePathTokens(d);
  const points: BezierPoint[] = [];

  let cx = 0;
  let cy = 0;
  let startX = 0;
  let startY = 0;
  let closed = false;

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
      cx = startX;
      cy = startY;
      prevType = 'Z';
      continue;
    }

    // Per-command handling (relative args accumulate against the running point).
    let i = 0;
    if (upperCmd === 'M') {
      // First pair = moveto, subsequent pairs = lineto.
      let first = true;
      while (i + 1 < args.length) {
        const x = args[i++]! + (isRelative ? cx : 0);
        const y = args[i++]! + (isRelative ? cy : 0);
        cx = x;
        cy = y;
        if (first) {
          startX = x;
          startY = y;
          first = false;
        }
        points.push({ x, y, inX: x, inY: y, outX: x, outY: y });
      }
      prevType = 'M';
    } else if (upperCmd === 'L') {
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

  return { points, closed };
}

/** Back-compat: parse a path `d` attribute into BezierPoints. */
export function parseSvgPath(d: string): BezierPoint[] {
  return parseSvgPathEx(d).points;
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
}

function parseInlineStyle(style: string | null): Partial<StyleCtx> {
  const out: Partial<StyleCtx> = {};
  if (!style) return out;
  for (const decl of style.split(';')) {
    const idx = decl.indexOf(':');
    if (idx < 0) continue;
    const key = decl.slice(0, idx).trim();
    const val = decl.slice(idx + 1).trim();
    if (key === 'fill') out.fill = val;
    else if (key === 'stroke') out.stroke = val;
    else if (key === 'stroke-width') out.strokeWidth = parseFloat(val);
  }
  return out;
}

/** Merge presentation attributes + inline style over an inherited style. */
function resolveStyle(el: Element, inherited: StyleCtx): StyleCtx {
  const styleAttr = parseInlineStyle(el.getAttribute('style'));
  const attrFill = el.getAttribute('fill');
  const attrStroke = el.getAttribute('stroke');
  const attrStrokeW = el.getAttribute('stroke-width');
  const next: StyleCtx = { ...inherited };
  if (styleAttr.fill != null) next.fill = styleAttr.fill;
  else if (attrFill != null) next.fill = attrFill;
  if (styleAttr.stroke != null) next.stroke = styleAttr.stroke;
  else if (attrStroke != null) next.stroke = attrStroke;
  if (styleAttr.strokeWidth != null && Number.isFinite(styleAttr.strokeWidth)) next.strokeWidth = styleAttr.strokeWidth;
  else if (attrStrokeW != null) next.strokeWidth = parseFloat(attrStrokeW);
  return next;
}

interface RawShape {
  name: string;
  points: BezierPoint[];
  closed: boolean;
  style: StyleCtx;
  textContent?: string;
  fontSize?: number;
  /** This element and its ancestors (root last) — SMIL on a <g> affects it too. */
  chain: Element[];
  /** The fully composed static matrix baked into `points`. */
  matrix: Mat;
}

/** Extract user-space geometry for a single shape element (null if none). */
function elementGeometry(el: Element): { points: BezierPoint[]; closed: boolean; textContent?: string; fontSize?: number } | null {
  const tag = el.tagName.toLowerCase().replace(/^svg:/, '');
  switch (tag) {
    case 'path': {
      const d = el.getAttribute('d');
      if (!d) return null;
      const { points, closed } = parseSvgPathEx(d);
      return points.length ? { points, closed } : null;
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
    case 'text':
    case 'tspan': {
      const txt = (el.textContent || '').trim();
      if (!txt) return null;
      const x = num(el, 'x');
      const y = num(el, 'y');
      const fs = num(el, 'font-size', 14);
      return {
        points: [{ x, y, inX: x, inY: y, outX: x, outY: y }],
        closed: false,
        textContent: txt,
        fontSize: fs,
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

const SHAPE_TAGS = new Set(['path', 'rect', 'circle', 'ellipse', 'polygon', 'polyline', 'line', 'text', 'tspan']);
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
function useTarget(el: Element): Element | null {
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

/** Recursively collect shapes with accumulated transform + inherited style. */
function traverse(
  el: Element,
  matrix: Mat,
  style: StyleCtx,
  out: RawShape[],
  ancestors: Element[] = [],
  useDepth = 0,
): void {
  const tag = el.tagName.toLowerCase().replace(/^svg:/, '');
  if (SKIP_TAGS.has(tag)) return;

  const localMatrix = matMul(matrix, parseTransform(el.getAttribute('transform')));
  const localStyle = resolveStyle(el, style);
  const chain = [el, ...ancestors];

  // <use>: instantiate the referenced element here. Icon sets, sprite sheets and
  // most "one artboard, many copies" exports are built entirely out of these, so
  // dropping them silently meant whole parts of the file simply never appeared.
  if (tag === 'use') {
    if (useDepth >= MAX_USE_DEPTH) return;
    const target = useTarget(el);
    if (!target) return;
    // A <use> may not reference itself or an ancestor — that is an infinite
    // expansion, and a hostile or merely broken file should not hang the import.
    if (chain.includes(target)) return;
    const ux = Number.parseFloat(el.getAttribute('x') ?? '0') || 0;
    const uy = Number.parseFloat(el.getAttribute('y') ?? '0') || 0;
    const placed = ux !== 0 || uy !== 0 ? matMul(localMatrix, [1, 0, 0, 1, ux, uy]) : localMatrix;
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
      for (let i = 0; i < target.children.length; i++) {
        traverse(target.children[i]!, inner, localStyle, out, chain, useDepth + 1);
      }
    } else {
      traverse(target, placed, localStyle, out, chain, useDepth + 1);
    }
    return;
  }

  // A nested <svg> establishes a new viewport; the ROOT one is handled by
  // `rootMatrixFromSvg` before traversal, so only descendants apply it here.
  if (tag === 'svg' && ancestors.length > 0) {
    const inner = matMul(localMatrix, nestedViewportMatrix(el));
    for (let i = 0; i < el.children.length; i++) {
      traverse(el.children[i]!, inner, localStyle, out, chain, useDepth);
    }
    return;
  }

  if (SHAPE_TAGS.has(tag)) {
    const geom = elementGeometry(el);
    if (geom) {
      out.push({
        name: el.getAttribute('id') || (geom.textContent ? `Text: ${geom.textContent.slice(0, 15)}` : `SVG ${tag} ${out.length + 1}`),
        points: transformPoints(geom.points, localMatrix),
        closed: geom.closed,
        style: localStyle,
        textContent: geom.textContent,
        fontSize: geom.fontSize,
        chain,
        matrix: localMatrix,
      });
    }
    return;
  }

  // Containers (svg, g, a, switch,...) — recurse into children.
  for (let i = 0; i < el.children.length; i++) {
    traverse(el.children[i]!, localMatrix, localStyle, out, chain, useDepth);
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

/** Parses XML string of SVG and returns list of parsed shapes with centered bounding boxes. */
export function parseSvgToShapes(svgContent: string, opts?: SvgAnimationOptions): ParsedShape[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgContent, 'image/svg+xml');
  const svg = doc.documentElement;

  // Malformed XML → let the caller fall back to image insert.
  if (!svg || svg.tagName.toLowerCase() === 'parsererror' || doc.getElementsByTagName('parsererror').length > 0) {
    return [];
  }

  const rootMatrix = rootMatrixFromSvg(svg);
  const rootStyle: StyleCtx = { fill: '#000000' };

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
  traverse(svg, rootMatrix, rootStyle, raw);

  // Animation, read once for the whole document and attached per shape.
  const scan = scanSvgAnimations(doc, opts);

  let keyframeBudget = MAX_IMPORT_KEYFRAMES;

  const shapes: ParsedShape[] = [];
  for (const r of raw) {
    const points = r.points;
    if (points.length === 0) continue;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of points) {
      minX = Math.min(minX, p.x, p.inX, p.outX);
      minY = Math.min(minY, p.y, p.inY, p.outY);
      maxX = Math.max(maxX, p.x, p.inX, p.outX);
      maxY = Math.max(maxY, p.y, p.inY, p.outY);
    }

    const width = Math.max(10, maxX - minX);
    const height = Math.max(10, maxY - minY);
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;

    const centeredPoints = points.map((p) => ({
      x: p.x - centerX,
      y: p.y - centerY,
      inX: p.inX - centerX,
      inY: p.inY - centerY,
      outX: p.outX - centerX,
      outY: p.outY - centerY,
    }));

    const fillRaw = resolvePaint(r.style.fill);
    const fill = fillRaw && fillRaw !== 'none' ? fillRaw : fillRaw === 'none' ? 'none' : '#000000';
    const strokeRaw = resolvePaint(r.style.stroke);
    const strokeColor = strokeRaw && strokeRaw !== 'none' ? strokeRaw : undefined;
    const strokeWidth = r.style.strokeWidth != null && Number.isFinite(r.style.strokeWidth) ? r.style.strokeWidth : undefined;

    // Budget is spent across the whole file, not per shape: one pathological
    // artwork must not be able to generate work the app cannot absorb. Past the
    // ceiling the remaining shapes still import — they just import static.
    const animation = scan.anims.length > 0 && keyframeBudget > 0
      ? buildShapeAnimation(r.chain, scan, r.matrix, { x: centerX, y: centerY }) ?? undefined
      : undefined;
    if (animation) keyframeBudget -= countKeyframes(animation);

    shapes.push({
      name: r.name,
      points: centeredPoints,
      fill,
      strokeColor,
      strokeWidth,
      closed: r.closed,
      width,
      height,
      centerX,
      centerY,
      textContent: r.textContent,
      fontSize: r.fontSize,
      ...(animation ? { animation } : {}),
    });
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
