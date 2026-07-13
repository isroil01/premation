import type { BezierPoint } from '@motion/workspace';

export interface ParsedShape {
  name: string;
  points: BezierPoint[];
  fill: string;
  strokeColor?: string;
  strokeWidth?: number;
  // Bounding box centering offsets
  width: number;
  height: number;
  centerX: number;
  centerY: number;
}

/** Parse path d string command tokens. */
function parsePathTokens(d: string): { cmd: string; args: number[] }[] {
  const regex = /([a-df-zDF-Z])|(-?\d*\.?\d+(?:[eE][-+]?\d+)?)/g;
  const tokens: string[] = [];
  let match;
  while ((match = regex.exec(d)) !== null) {
    tokens.push(match[0]);
  }

  const out: { cmd: string; args: number[] }[] = [];
  let currentCmd = '';
  let currentArgs: number[] = [];

  for (const token of tokens) {
    if (/^[a-df-zDF-Z]$/.test(token)) {
      if (currentCmd) {
        out.push({ cmd: currentCmd, args: currentArgs });
      }
      currentCmd = token;
      currentArgs = [];
    } else {
      currentArgs.push(parseFloat(token));
    }
  }
  if (currentCmd) {
    out.push({ cmd: currentCmd, args: currentArgs });
  }
  return out;
}

/** Parses SVG path d attribute into BezierPoints. */
export function parseSvgPath(d: string): BezierPoint[] {
  const tokens = parsePathTokens(d);
  const points: BezierPoint[] = [];

  let cx = 0;
  let cy = 0;
  let startX = 0;
  let startY = 0;

  for (const { cmd, args } of tokens) {
    const isRelative = cmd === cmd.toLowerCase();
    const upperCmd = cmd.toUpperCase();

    let argIdx = 0;
    while (argIdx < args.length || (upperCmd === 'Z' && argIdx === 0)) {
      if (upperCmd === 'M') {
        const x = args[argIdx++]! + (isRelative ? cx : 0);
        const y = args[argIdx++]! + (isRelative ? cy : 0);
        cx = x;
        cy = y;
        startX = x;
        startY = y;
        points.push({ x, y, inX: x, inY: y, outX: x, outY: y });
      } else if (upperCmd === 'L') {
        const x = args[argIdx++]! + (isRelative ? cx : 0);
        const y = args[argIdx++]! + (isRelative ? cy : 0);
        cx = x;
        cy = y;
        points.push({ x, y, inX: x, inY: y, outX: x, outY: y });
      } else if (upperCmd === 'H') {
        const x = args[argIdx++]! + (isRelative ? cx : 0);
        cx = x;
        points.push({ x, y: cy, inX: x, inY: cy, outX: x, outY: cy });
      } else if (upperCmd === 'V') {
        const y = args[argIdx++]! + (isRelative ? cy : 0);
        cy = y;
        points.push({ x: cx, y, inX: cx, inY: y, outX: cx, outY: y });
      } else if (upperCmd === 'C') {
        const cp1x = args[argIdx++]! + (isRelative ? cx : 0);
        const cp1y = args[argIdx++]! + (isRelative ? cy : 0);
        const cp2x = args[argIdx++]! + (isRelative ? cx : 0);
        const cp2y = args[argIdx++]! + (isRelative ? cy : 0);
        const x = args[argIdx++]! + (isRelative ? cx : 0);
        const y = args[argIdx++]! + (isRelative ? cy : 0);

        // Update the outgoing handle of the previous point
        const prev = points[points.length - 1];
        if (prev) {
          prev.outX = cp1x;
          prev.outY = cp1y;
        }

        // Add the new point with incoming handle
        points.push({ x, y, inX: cp2x, inY: cp2y, outX: x, outY: y });
        cx = x;
        cy = y;
      } else if (upperCmd === 'Z') {
        cx = startX;
        cy = startY;
        break;
      } else {
        // Fallback for unsupported path types (A, Q, S, T)
        break;
      }
    }
  }

  return points;
}

/** Parses XML string of SVG and returns list of parsed shapes with centered bounding boxes. */
export function parseSvgToShapes(svgContent: string): ParsedShape[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgContent, 'image/svg+xml');
  const paths = doc.querySelectorAll('path');
  const shapes: ParsedShape[] = [];

  paths.forEach((path, index) => {
    const d = path.getAttribute('d');
    if (!d) return;

    const points = parseSvgPath(d);
    if (points.length === 0) return;

    // Compute bounding box
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

    // Center coordinates around (0,0)
    const centeredPoints = points.map((p) => ({
      x: p.x - centerX,
      y: p.y - centerY,
      inX: p.inX - centerX,
      inY: p.inY - centerY,
      outX: p.outX - centerX,
      outY: p.outY - centerY,
    }));

    const name = path.getAttribute('id') || `SVG Path ${index + 1}`;
    const fill = path.getAttribute('fill') || '#ffffff';
    const strokeColor = path.getAttribute('stroke') || undefined;
    const strokeWidth = path.getAttribute('stroke-width')
      ? parseFloat(path.getAttribute('stroke-width')!)
      : undefined;

    shapes.push({
      name,
      points: centeredPoints,
      fill,
      strokeColor,
      strokeWidth,
      width,
      height,
      centerX,
      centerY,
    });
  });

  return shapes;
}
