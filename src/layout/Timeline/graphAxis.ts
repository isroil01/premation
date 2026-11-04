/**
 * Where the graph editor's grid lines go: round numbers at a spacing that
 * suits the zoom, so the labels read 100, 110, 120 and not quarters of whatever
 * range the curve happens to fit. And the frame steps taken out of its curves.
 */

const NICE = [1, 2, 5, 10];
/** Nice steps of a time axis, seconds. */
const TIME_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];

/** Round values inside [min, max], no closer together than `minGapPx` on an axis `heightPx` tall. */
export function valueTicks(min: number, max: number, heightPx: number, minGapPx = 44): number[] {
  const span = max - min;
  if (!(span > 0) || !Number.isFinite(span) || !(heightPx > 0)) return [];
  const most = Math.max(2, Math.floor(heightPx / minGapPx));
  const pow = 10 ** Math.floor(Math.log10(span / most));
  const step = (NICE.find((m) => span / (m * pow) <= most) ?? 10) * pow;
  const out: number[] = [];
  for (let k = Math.ceil(min / step); k * step <= max + step * 1e-9; k++) {
    // toPrecision drops the float noise a multiple of 0.1 picks up (0.30000000000000004).
    out.push(Number((k * step).toPrecision(12)));
  }
  return out;
}

/** The smallest time step that keeps vertical grid lines `minGapPx` apart. */
export function timeStep(pixelsPerSecond: number, minGapPx = 72): number {
  return TIME_STEPS.find((s) => s * pixelsPerSecond >= minGapPx) ?? TIME_STEPS[TIME_STEPS.length - 1]!;
}

/** The multiples of `step` inside [t0, t1]. */
export function timeTicks(t0: number, t1: number, step: number): number[] {
  const out: number[] = [];
  for (let k = Math.ceil(t0 / step - 1e-9); k * step <= t1 + 1e-9; k++) {
    out.push(Number((k * step).toPrecision(12)));
  }
  return out;
}

/**
 * Take the frame staircase out of a curve's samples.
 *
 * The engine evaluates a key's curve on the frame grid (`comp_to_keyframe_time`
 * rounds to a frame), which is right for rendering, but samples closer together
 * than a frame come back as flat treads that draw a smooth ease as steps.
 * Rounding makes a frame's value hold for the half frame either side of it, so
 * the middle of a tread is that frame's time exactly, and joining the middles
 * gives the real curve. A flat run longer than a frame really is flat (a
 * posterized expression), so it keeps both ends and its corners.
 */
export function smoothFrameSteps(
  points: ReadonlyArray<readonly [number, number]>,
  frameSeconds: number,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < points.length;) {
    const [start, value] = points[i]!;
    let j = i;
    while (j + 1 < points.length && Math.abs(points[j + 1]![1] - value) < 1e-9) j++;
    const end = points[j]![0];
    if (frameSeconds > 0 && end - start <= frameSeconds * 1.5) {
      out.push([(start + end) / 2, value]);
    } else {
      out.push([start, value]);
      if (j > i) out.push([end, value]);
    }
    i = j + 1;
  }
  return out;
}
