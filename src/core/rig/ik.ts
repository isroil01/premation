/**
 * Inverse kinematics for 2D bone chains.
 *   • solveTwoBone — analytic (law-of-cosines) two-bone solver: the common
 *     arm/leg case, exact and single-shot.
 *   • solveFabrik — FABRIK iterative solver for chains of any length.
 * Both are pure and return positions/angles the rig layer writes back onto
 * bone rotations. No engine deps.
 */

export interface Vec2 {
  x: number;
  y: number;
}

/** World angles (radians) for a two-bone chain whose end reaches `target`. */
export interface TwoBoneSolution {
  /** World rotation of the upper bone (shoulder/hip). */
  angle1: number;
  /** World rotation of the lower bone (elbow/knee). */
  angle2: number;
  /** True when the target was out of reach and the chain is fully extended. */
  clamped: boolean;
}

/**
 * Two-bone analytic IK. `bendPositive` picks the elbow side (which way the
 * joint folds). Lengths must be > 0.
 */
export function solveTwoBone(
  root: Vec2,
  length1: number,
  length2: number,
  target: Vec2,
  bendPositive = true,
): TwoBoneSolution {
  const dx = target.x - root.x;
  const dy = target.y - root.y;
  const rawDist = Math.hypot(dx, dy);

  const reach = length1 + length2;
  const minReach = Math.abs(length1 - length2);
  const clamped = rawDist > reach || rawDist < minReach;
  // Clamp into the annulus the chain can actually reach, avoiding singular acos.
  const dist = Math.max(minReach + 1e-6, Math.min(rawDist, reach - 1e-6));

  const targetAngle = Math.atan2(dy, dx);
  const cosA1 = (length1 * length1 + dist * dist - length2 * length2) / (2 * length1 * dist);
  const a1 = Math.acos(Math.max(-1, Math.min(1, cosA1)));
  const cosA2 = (length1 * length1 + length2 * length2 - dist * dist) / (2 * length1 * length2);
  const a2 = Math.acos(Math.max(-1, Math.min(1, cosA2)));

  const sign = bendPositive ? 1 : -1;
  const angle1 = targetAngle - sign * a1;
  const angle2 = angle1 + sign * (Math.PI - a2);
  return { angle1, angle2, clamped };
}

/** Move `point` to lie exactly `len` from `anchor`, along their current direction. */
function constrain(point: Vec2, anchor: Vec2, len: number): Vec2 {
  const dx = point.x - anchor.x;
  const dy = point.y - anchor.y;
  const d = Math.hypot(dx, dy) || 1e-9;
  const s = len / d;
  return { x: anchor.x + dx * s, y: anchor.y + dy * s };
}

/**
 * FABRIK (Forward And Backward Reaching Inverse Kinematics) for an N-joint
 * chain. `joints` are current world positions (root first); `lengths[i]` is the
 * link between joint i and i+1 (so `lengths.length === joints.length - 1`).
 * The root stays pinned. Returns the solved joint positions.
 */
export function solveFabrik(
  joints: readonly Vec2[],
  lengths: readonly number[],
  target: Vec2,
  iterations = 12,
  tolerance = 0.25,
): Vec2[] {
  const n = joints.length;
  if (n < 2) return joints.map((j) => ({ ...j }));
  const p: Vec2[] = joints.map((j) => ({ ...j }));
  const root: Vec2 = { x: p[0]!.x, y: p[0]!.y };

  const total = lengths.reduce((a, b) => a + b, 0);
  const rootToTarget = Math.hypot(target.x - root.x, target.y - root.y);

  if (rootToTarget > total) {
    // Unreachable — stretch straight toward the target.
    for (let i = 0; i < n - 1; i++) {
      p[i + 1] = constrain(target, p[i]!, lengths[i]!);
    }
    return p;
  }

  for (let iter = 0; iter < iterations; iter++) {
    // Backward: pull the end onto the target, propagate to the root.
    p[n - 1] = { ...target };
    for (let i = n - 2; i >= 0; i--) {
      p[i] = constrain(p[i]!, p[i + 1]!, lengths[i]!);
    }
    // Forward: re-pin the root, propagate to the end.
    p[0] = { ...root };
    for (let i = 1; i < n; i++) {
      p[i] = constrain(p[i]!, p[i - 1]!, lengths[i - 1]!);
    }
    const end = p[n - 1]!;
    if (Math.hypot(end.x - target.x, end.y - target.y) < tolerance) break;
  }
  return p;
}

/** World angle of each link, derived from solved joint positions (for writing back to bones). */
export function anglesFromJoints(joints: readonly Vec2[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < joints.length - 1; i++) {
    const a = joints[i]!;
    const b = joints[i + 1]!;
    out.push(Math.atan2(b.y - a.y, b.x - a.x));
  }
  return out;
}
