/**
 * Turning per-frame attention points into a camera move a person would accept.
 *
 * This is the half of auto-reframe that decides whether the result looks
 * professional or seasick, and almost none of it is about finding the subject.
 * Three rules do the work:
 *
 *  1. **A dead zone.** The frame does not move until the subject has drifted
 *     meaningfully off centre. Without this the crop jitters continuously
 *     against a centroid that wobbles by a pixel a frame, which reads as a
 *     handheld camera nobody asked for. Operators call this "slop"; every
 *     shoulder rig has it deliberately.
 *  2. **Lag.** Once it does move, it eases toward the target rather than
 *     snapping. An exponential follow is the standard cheap version and is what
 *     a whip-pan-free result needs.
 *  3. **Cuts are walls.** At a shot change the frame JUMPS. Smoothing across a
 *     cut produces the single worst artefact this feature can have — the crop
 *     visibly sliding to catch up during the first half-second of every new
 *     shot, which no editor would ever leave in.
 *
 * Low-confidence frames (a fade, a flat graphic, an empty sky) do not move the
 * target at all; the frame holds where it was. Acting on the centroid of
 * nothing is how a reframe drifts during a dip to black.
 *
 * Pure and unit-tested end to end: the whole feature's quality lives here, and
 * none of it needs a GPU to check.
 */

/** The source composition and the frame being cut out of it. */
export interface ReframeGeometry {
  sourceWidth: number;
  sourceHeight: number;
  targetWidth: number;
  targetHeight: number;
}

/**
 * The scale at which the source covers the target frame with no gaps.
 *
 * Cover, never contain: a reframe that letterboxes has not reframed anything.
 * Always at least 1 — scaling a source DOWN to fit a narrower target would
 * shrink the picture inside its own crop, which is the one result nobody wants.
 */
export function coverScale(geometry: ReframeGeometry): number {
  const { sourceWidth, sourceHeight, targetWidth, targetHeight } = geometry;
  return Math.max(targetWidth / sourceWidth, targetHeight / sourceHeight);
}

/**
 * How far the source's CENTRE may travel, in target-frame pixels.
 *
 * Zero on the axis that has no slack: a 16:9 source in a 9:16 target can pan
 * horizontally and has nothing to give vertically, so the vertical path must be
 * pinned rather than smoothed around a range of zero.
 */
export function panRange(geometry: ReframeGeometry): { x: number; y: number } {
  const scale = coverScale(geometry);
  const scaledW = geometry.sourceWidth * scale;
  const scaledH = geometry.sourceHeight * scale;
  return {
    x: Math.max(0, (scaledW - geometry.targetWidth) / 2),
    y: Math.max(0, (scaledH - geometry.targetHeight) / 2),
  };
}

export interface AttentionSample {
  /** Normalised 0..1 within the SOURCE frame. */
  x: number;
  y: number;
  /** 0..1 — below `confidenceFloor` the sample does not move the target. */
  confidence: number;
}

export interface PathOptions {
  /**
   * Fraction of the available pan range the subject may drift before the frame
   * follows. 0.12 ≈ a comfortable slop; 0 makes the frame track every wobble.
   */
  deadZone?: number;
  /**
   * Seconds for the frame to cover ~63% of the distance to its target. Larger
   * is lazier. 0.5s is roughly a considered operator.
   */
  lagSeconds?: number;
  /** Samples per second of the incoming attention series. */
  sampleRate: number;
  /** Below this, a sample is treated as "no subject here" and ignored. */
  confidenceFloor?: number;
}

const PATH_DEFAULTS = {
  deadZone: 0.12,
  lagSeconds: 0.5,
  confidenceFloor: 0.05,
};

/**
 * Positions of the source's centre, in target-frame pixels, one per sample.
 *
 * `cuts` are sample indices that BEGIN a shot. At each one the follower is
 * reset to the incoming target rather than easing toward it.
 */
export function buildReframePath(
  samples: readonly AttentionSample[],
  cuts: readonly number[],
  geometry: ReframeGeometry,
  options: PathOptions,
): { x: number[]; y: number[] } {
  const opts = { ...PATH_DEFAULTS, ...options };
  const range = panRange(geometry);
  const cutSet = new Set(cuts);

  // Per-sample follow factor for the requested lag. At lag 0 it is 1 (snap).
  const alpha =
    opts.lagSeconds <= 0 || opts.sampleRate <= 0
      ? 1
      : 1 - Math.exp(-1 / (opts.lagSeconds * opts.sampleRate));

  const xs: number[] = [];
  const ys: number[] = [];

  // The source centre offset that puts the attention point in the middle of
  // the target. Attention right of centre → the source moves LEFT.
  const desired = (normalised: number, axisRange: number): number =>
    Math.max(-axisRange, Math.min(axisRange, -(normalised - 0.5) * 2 * axisRange));

  let holdX = 0;
  let holdY = 0;
  let currentX = 0;
  let currentY = 0;
  let started = false;

  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i] as AttentionSample;
    const confident = sample.confidence >= opts.confidenceFloor;
    const isCut = cutSet.has(i) || !started;

    if (confident) {
      const targetX = desired(sample.x, range.x);
      const targetY = desired(sample.y, range.y);
      // The dead zone is applied to the HELD target, not to the follower: the
      // frame commits to a new resting place only when the subject has really
      // left the old one, and then eases there. Applying it to the follower
      // instead produces a stutter — move, stop, move — as the follower keeps
      // re-entering and leaving the zone.
      if (isCut || Math.abs(targetX - holdX) > range.x * opts.deadZone) holdX = targetX;
      if (isCut || Math.abs(targetY - holdY) > range.y * opts.deadZone) holdY = targetY;
    }

    if (isCut) {
      // A cut is a wall. Land on the new shot's framing immediately; easing
      // across it is the artefact this whole module exists to avoid.
      currentX = holdX;
      currentY = holdY;
      started = true;
    } else {
      currentX += (holdX - currentX) * alpha;
      currentY += (holdY - currentY) * alpha;
    }

    xs.push(currentX);
    ys.push(currentY);
  }

  return { x: xs, y: ys };
}

export interface PathKeyframe {
  /** Seconds from the start of the analysed range. */
  t: number;
  value: number;
  /** Cut boundaries hold, so the renderer does not interpolate across them. */
  easing: 'linear' | 'step';
}

/**
 * Thin a per-sample path down to the keyframes worth writing.
 *
 * A 30-second shot analysed at 12 Hz is 360 samples per axis; a path that
 * barely moves needs two. Keeping all of them would bury the user's timeline
 * under keyframes they cannot meaningfully edit, which is the difference
 * between a result you can adjust and one you can only accept or discard.
 *
 * Kept: the first and last sample, every cut boundary (as a hold, on both
 * sides), and any sample that deviates from the straight line between its
 * neighbours by more than `tolerance` pixels.
 */
export function pathToKeyframes(
  path: readonly number[],
  cuts: readonly number[],
  sampleRate: number,
  tolerance = 0.75,
): PathKeyframe[] {
  if (path.length === 0) return [];
  if (path.length === 1) return [{ t: 0, value: path[0] as number, easing: 'linear' }];

  const cutSet = new Set(cuts.filter((c) => c > 0 && c < path.length));
  const keep = new Set<number>([0, path.length - 1]);
  for (const c of cutSet) {
    // Both sides: the last sample of the old shot and the first of the new.
    // Without the pair, the renderer interpolates from wherever the previous
    // keyframe was, sliding through the cut.
    keep.add(c - 1);
    keep.add(c);
  }

  // Anything the straight line between its kept neighbours would misrepresent.
  // One pass is enough at these tolerances and keeps this O(n).
  let anchor = 0;
  for (let i = 1; i < path.length - 1; i++) {
    if (keep.has(i)) { anchor = i; continue; }
    const next = i + 1;
    const span = next - anchor;
    if (span <= 0) continue;
    const lerped = (path[anchor] as number) + ((path[next] as number) - (path[anchor] as number)) * ((i - anchor) / span);
    if (Math.abs((path[i] as number) - lerped) > tolerance) {
      keep.add(i);
      anchor = i;
    }
  }

  return [...keep]
    .sort((a, b) => a - b)
    .map((i) => ({
      t: i / sampleRate,
      value: path[i] as number,
      // The frame BEFORE a cut holds, so the jump happens at the cut and not
      // as a ramp through the last half-second of the outgoing shot.
      easing: cutSet.has(i + 1) ? ('step' as const) : ('linear' as const),
    }));
}
