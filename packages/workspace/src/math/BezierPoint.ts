/**
 * A single anchor with absolute in/out bezier handles (local space).
 */
export interface BezierPoint {
  x: number;
  y: number;
  /** Incoming handle (absolute). Equal to (x,y) for a corner. */
  inX: number;
  inY: number;
  /** Outgoing handle (absolute). Equal to (x,y) for a corner. */
  outX: number;
  outY: number;
}

export function corner(x: number, y: number): BezierPoint {
  return { x, y, inX: x, inY: y, outX: x, outY: y };
}

export function smooth(x: number, y: number, inX: number, inY: number, outX: number, outY: number): BezierPoint {
  return { x, y, inX, inY, outX, outY };
}
