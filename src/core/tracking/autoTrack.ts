/**
 * One-click tracking: the decisions a user would otherwise have to make, made
 * from measurements of the actual footage.
 *
 * Placing a track point in After Effects means answering four questions
 * before you are allowed to press Analyze — WHAT to track, how BIG the
 * feature box should be, how big the SEARCH box should be, and which
 * DIRECTION to analyse. Every one of them has a right answer that is visible
 * in the first two frames of the shot, and getting them wrong is why tracking
 * has a reputation for being fiddly. So:
 *
 *   WHAT    → `autoFeature.pickFeature`, biased toward where the user
 *             clicked. Measured, and allowed to answer "nothing here".
 *   FEATURE → the smallest window that still resolves the feature.
 *   SEARCH  → sized from the feature's OWN measured displacement between the
 *             first two frames, not from a default. A default is wrong in
 *             both directions at once: too small loses a whipping pan on
 *             frame two, too large spends ~4× the arithmetic per frame AND
 *             invites a rival peak in from across the window.
 *   WHERE   → both ways from the playhead. The playhead sits in the middle of
 *             the shot far more often than at its head, and "track this" has
 *             never meant "track the second half of this".
 *
 * The module is split so the judgement is testable without a decoder:
 * `planTrack` is pure (two planes in, a plan out), `mergeBidirectional` is
 * pure, and `runAutoTrack` is the walk that glues them to injected frame
 * readers. `trackVideoLayer.ts` supplies the real ones.
 */

import { extractPatch, matchPatch, type LumaPlane } from './patchMatch';
import { pickFeature, pickFeatures, suggestFeatureHalf, type FeatureCandidate } from './autoFeature';
import { trackPoints, type TrackSample } from './tracker';

/** Search half-size used only to MEASURE frame-to-frame motion. Generous —
 *  it runs once, and under-measuring here mis-sizes every later frame. */
const PROBE_SEARCH_HALF = 96;

/** Probe radius for an ambiguous feature — small enough to exclude the rivals
 *  that made it ambiguous in the first place. */
const AMBIGUOUS_PROBE_HALF = 24;

/**
 * How far the two probes' implied VELOCITIES may differ before the
 * measurement is thrown out, as a fraction of the first.
 *
 * Comparing velocities rather than raw displacements is the whole point: a
 * rival sits at a fixed OFFSET, so it reports the same displacement at one
 * frame and at two — which halves its implied velocity and is exactly what
 * this catches. Comparing displacements instead makes a stationary rival look
 * like a merely-decelerating feature, and it slips through.
 */
const CORROBORATION_TOLERANCE = 0.4;

/**
 * Velocity disagreement below this many px/frame is never a rival, just
 * sub-pixel noise on a nearly-still feature — and at those speeds the window
 * is small either way, so a false accept costs nothing.
 */
const CORROBORATION_FLOOR_PX = 1;

/** Clamps for the derived search window, in source px. */
const MIN_SEARCH_HALF = 8;
const MAX_SEARCH_HALF = 64;

/** Search half-size when motion could not be measured at all. */
const FALLBACK_SEARCH_HALF = 20;

/** Below this, `pickFeature`'s answer is a rival-ridden feature (periodic
 *  texture) and the search window is tightened to keep rivals outside it. */
const AMBIGUOUS_BELOW = 0.5;

/**
 * The companion feature's search box, as a fraction of the frame's short side.
 *
 * Rotation and scale are read from the ANGLE and LENGTH of the line between
 * two points, so the two must plausibly sit on the same rigid surface — a
 * companion picked from across the frame is as likely to be on the background
 * as on the subject, and would report the parallax between them as rotation.
 * Keeping it local is the only cheap way to make that likely.
 */
const COMPANION_REACH = 0.18;

/**
 * Minimum separation between the two points, as a fraction of the reach.
 *
 * A short baseline makes the angle noisy: a half-pixel of match error on a
 * 10 px vector is 3° of phantom rotation, and on a 100 px vector it is 0.3°.
 */
const COMPANION_MIN_SEPARATION = 0.4;

export interface TrackPlan {
  /** Feature centre in plane px — where tracking will actually start. */
  x: number;
  y: number;
  featureHalf: number;
  searchHalf: number;
  /** Measured displacement between the anchor and probe frames, in px.
   *  Null when there was no probe frame (the anchor is the last frame). */
  motionPerFrame: number | null;
  /** The measurement behind the pick, surfaced so the UI can warn. */
  feature: FeatureCandidate;
  /**
   * A second feature near the first, tracked in the SAME walk so that
   * rotation and scale are available without a second pass over the clip.
   * Null when nothing nearby is worth tracking — position still works.
   */
  companion: FeatureCandidate | null;
}

export interface PlanTrackOptions {
  /** Where the user pointed, in plane px. Defaults to the frame centre. */
  hint?: { x: number; y: number };
  /** Search radius around the hint. See `autoFeature.pickFeature`. */
  radius?: number;
}

/**
 * Choose a feature and size both windows for it. Returns null when the
 * region holds nothing a correlation tracker can lock onto — the caller must
 * say so rather than tracking a flat wall and producing a smooth, confident,
 * meaningless curve.
 */
export function planTrack(
  anchor: LumaPlane,
  probes: readonly LumaPlane[],
  opts: PlanTrackOptions = {},
): TrackPlan | null {
  const feature = pickFeature(anchor, {
    ...(opts.hint ? { hint: opts.hint } : {}),
    ...(opts.radius !== undefined ? { radius: opts.radius } : {}),
  });
  if (!feature) return null;

  const featureHalf = suggestFeatureHalf(anchor, feature.x, feature.y);
  // Ambiguous features get a tighter window: with periodic texture the way to
  // avoid locking onto the wrong instance is to keep the wrong instance out
  // of the search window entirely. It costs robustness against sudden
  // acceleration, which is the better trade — a lost track is visible, a
  // track that hopped one brick over is not.
  const ambiguous = feature.distinctness < AMBIGUOUS_BELOW;
  // The probe is a match like any other, so it is fooled by the same rivals
  // the track would be — and a probe that locks onto the next brick along
  // reports 40 px/frame of motion that never happened, then sizes the search
  // window to guarantee the real track makes the same mistake. Narrowing the
  // probe on an ambiguous feature keeps that feedback loop shut.
  const motionPerFrame = measureMotion(
    anchor, probes, feature, featureHalf,
    ambiguous ? AMBIGUOUS_PROBE_HALF : PROBE_SEARCH_HALF,
  );

  const searchHalf =
    motionPerFrame === null
      ? FALLBACK_SEARCH_HALF
      : Math.round(motionPerFrame * (ambiguous ? 1.5 : 2.5)) + (ambiguous ? 4 : 8);

  return {
    x: feature.x,
    y: feature.y,
    featureHalf,
    searchHalf: Math.max(MIN_SEARCH_HALF, Math.min(MAX_SEARCH_HALF, searchHalf)),
    motionPerFrame,
    feature,
    companion: pickCompanion(anchor, feature),
  };
}

/**
 * The best feature near the primary, far enough away to make a usable
 * baseline. Costs one extra local sweep and nothing at all at track time —
 * multi-point walks decode each frame once, so a second point adds matching
 * work only, which is a fraction of the decode it rides along with.
 */
function pickCompanion(plane: LumaPlane, primary: FeatureCandidate): FeatureCandidate | null {
  const reach = Math.max(60, Math.round(Math.min(plane.width, plane.height) * COMPANION_REACH));
  const minSeparation = reach * COMPANION_MIN_SEPARATION;
  const candidates = pickFeatures(plane, 6, {
    tile: Math.max(48, Math.round(reach / 2)),
    within: {
      x0: primary.x - reach, y0: primary.y - reach,
      x1: primary.x + reach, y1: primary.y + reach,
    },
  });
  for (const c of candidates) {
    if (Math.hypot(c.x - primary.x, c.y - primary.y) >= minSeparation) return c;
  }
  return null;
}

/**
 * How far this feature moves per frame — corroborated across two frames, not
 * measured once.
 *
 * A single probe is one correlation match, and it is fooled by exactly what
 * the track would be fooled by. On real footage this is not hypothetical: a
 * static camera pointed at a slatted bench measured 22 px/frame of motion that
 * did not exist, because the patch matched the NEXT slat along — and the only
 * consequence a user sees is that the search window inflates to its clamp,
 * which is slower per frame AND wide enough to invite the same rival in on
 * every subsequent frame.
 *
 * So the displacement is measured over one frame and over two, and believed
 * only if the two-frame answer is about twice the one-frame answer. Real
 * motion satisfies that almost by definition; a rival lock does not, because
 * the rival sits at a fixed offset rather than a fixed velocity. Failing
 * corroboration returns null — "not measurable", which lands on the same
 * conservative default as having no probe at all.
 */
function measureMotion(
  anchor: LumaPlane,
  probes: readonly LumaPlane[],
  feature: FeatureCandidate,
  featureHalf: number,
  searchHalf: number,
): number | null {
  const patch = extractPatch(anchor, feature.x, feature.y, featureHalf);
  if (!patch) return null;
  const displacementTo = (probe: LumaPlane | undefined): number | null => {
    if (!probe) return null;
    const m = matchPatch(patch, featureHalf, probe, feature.x, feature.y, searchHalf);
    if (!m || m.confidence < 0.6) return null;
    return Math.hypot(m.x - feature.x, m.y - feature.y);
  };

  const d1 = displacementTo(probes[0]);
  if (d1 === null) return null;
  const d2 = displacementTo(probes[1]);
  // One probe frame is all a clip's last-but-one frame can offer; take it
  // rather than refusing to measure at the end of every shot.
  if (d2 === null) return probes.length > 1 ? null : d1;
  const impliedVelocity = d2 / 2;
  const tolerance = Math.max(CORROBORATION_FLOOR_PX, CORROBORATION_TOLERANCE * d1);
  return Math.abs(impliedVelocity - d1) <= tolerance ? d1 : null;
}

/**
 * Backward samples (anchor-first, descending) + forward samples (anchor-first,
 * ascending) → one ascending list with the shared anchor appearing once.
 *
 * Written as its own function because getting it wrong is silent: a duplicated
 * anchor becomes two keyframes at one time, and a mis-ordered merge becomes a
 * track that jumps to the start of the clip and back on a single frame.
 */
export function mergeBidirectional(
  backward: readonly TrackSample[],
  forward: readonly TrackSample[],
): TrackSample[] {
  const seen = new Set<number>();
  const merged: TrackSample[] = [];
  // Backward is emitted anchor-first, so reverse it to get ascending frames.
  for (const s of [...backward].reverse()) {
    if (seen.has(s.frame)) continue;
    seen.add(s.frame);
    merged.push(s);
  }
  for (const s of forward) {
    if (seen.has(s.frame)) continue;
    seen.add(s.frame);
    merged.push(s);
  }
  return merged.sort((p, q) => p.frame - q.frame);
}

export interface AutoTrackRequest {
  /** The frame the user is looking at — where the feature is chosen. */
  anchorFrame: number;
  /** Walk bounds, inclusive. `firstFrame ≤ anchorFrame ≤ lastFrame`. */
  firstFrame: number;
  lastFrame: number;
  /** Luma at `anchorFrame`, already decoded — the plan is measured on it. */
  anchorPlane: LumaPlane;
  /** Luma at `anchorFrame + 1` and `+ 2` for the motion probe. Fewer is fine
   *  (the end of a clip has none); the plan degrades to a safe default. */
  probePlanes: readonly LumaPlane[];
  /** Ascending reader for `[anchorFrame..lastFrame]`. */
  forwardAt: (index: number) => Promise<LumaPlane>;
  /** Descending reader for `[anchorFrame..firstFrame]`. Omit to skip the
   *  backward half (a clip whose anchor IS its first frame, or a caller that
   *  cannot read backwards). */
  backwardAt?: ((index: number) => Promise<LumaPlane>) | undefined;
  hint?: { x: number; y: number } | undefined;
  radius?: number | undefined;
  /** 0..1 over the whole bidirectional walk. Return false to cancel. */
  onProgress?: ((fraction: number) => boolean | void) | undefined;
}

export interface AutoTrackResult {
  /**
   * One ascending sample list per tracked point, in the anchor plane's pixel
   * grid. `tracks[0]` is the primary feature; `tracks[1]`, when present, is
   * its companion — together they carry rotation and scale.
   */
  tracks: TrackSample[][];
  plan: TrackPlan;
  /**
   * 'completed' covered the whole range; 'partial' lost one or both
   * directions part-way (the samples that were measured are still returned);
   * 'cancelled' stopped on request.
   */
  status: 'completed' | 'partial' | 'cancelled';
}

/**
 * The whole one-click walk: plan on the anchor frame, then track outward in
 * both directions from it.
 *
 * Tracking OUTWARD from the anchor rather than forward from the clip's head
 * is what makes the result trustworthy: the reference patch is the appearance
 * the user actually looked at and clicked on, and both walks accumulate
 * their drift away from it instead of toward it.
 *
 * Throws only when there is nothing to track — a plan that cannot be made is
 * a message for the user, not an exception, so it comes back as `null`.
 */
export async function runAutoTrack(req: AutoTrackRequest): Promise<AutoTrackResult | null> {
  const plan = planTrack(req.anchorPlane, req.probePlanes, {
    ...(req.hint ? { hint: req.hint } : {}),
    ...(req.radius !== undefined ? { radius: req.radius } : {}),
  });
  if (!plan) return null;

  const forwardFrames = Math.max(0, req.lastFrame - req.anchorFrame);
  const backwardFrames = req.backwardAt ? Math.max(0, req.anchorFrame - req.firstFrame) : 0;
  const total = forwardFrames + backwardFrames;
  let done = 0;
  let cancelled = false;
  // One progress axis over both walks — two bars that each run 0→100% read
  // as a stall followed by a restart.
  const advance = (): boolean => {
    done += 1;
    if (total > 0 && req.onProgress?.(Math.min(1, done / total)) === false) {
      cancelled = true;
      return false;
    }
    return true;
  };

  // Both points ride ONE walk: the expensive half of tracking is decoding, and
  // a second point re-uses every decoded frame the first one needed.
  const points = plan.companion
    ? [{ x: plan.x, y: plan.y }, { x: plan.companion.x, y: plan.companion.y }]
    : [{ x: plan.x, y: plan.y }];
  const common = { points, featureHalf: plan.featureHalf, searchHalf: plan.searchHalf };

  let backward: TrackSample[][] = [];
  let backwardStatus: 'completed' | 'lost' | 'cancelled' = 'completed';
  if (req.backwardAt && backwardFrames > 0) {
    const r = await trackPoints({
      ...common,
      frameAt: req.backwardAt,
      fromFrame: req.anchorFrame,
      toFrame: req.firstFrame,
      onProgress: advance,
    });
    backward = r.tracks;
    backwardStatus = r.status;
  }

  let forward: TrackSample[][] = [];
  let forwardStatus: 'completed' | 'lost' | 'cancelled' = 'completed';
  if (!cancelled && forwardFrames > 0) {
    const r = await trackPoints({
      ...common,
      frameAt: req.forwardAt,
      fromFrame: req.anchorFrame,
      toFrame: req.lastFrame,
      onProgress: advance,
    });
    forward = r.tracks;
    forwardStatus = r.status;
  } else if (!cancelled && backward.length === 0) {
    // A single-frame range still owes the caller the anchor sample, so the
    // plan can be shown and the point drawn.
    forward = points.map((p) => [
      { frame: req.anchorFrame, x: p.x, y: p.y, confidence: 1, coasted: false },
    ]);
  }

  const status =
    backwardStatus === 'cancelled' || forwardStatus === 'cancelled' || cancelled
      ? 'cancelled'
      : backwardStatus === 'completed' && forwardStatus === 'completed'
        ? 'completed'
        : 'partial';

  const trackCount = Math.max(backward.length, forward.length);
  const tracks = Array.from({ length: trackCount }, (_, i) =>
    mergeBidirectional(backward[i] ?? [], forward[i] ?? []));
  return { tracks, plan, status };
}
