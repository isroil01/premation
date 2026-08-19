/**
 * Point tracking — the orchestration half. patchMatch.ts decides where a
 * feature went between two frames; this walks a whole clip, one frame at a
 * time, and owns the POLICY decisions a tracker lives or dies by:
 *
 * REFERENCE STRATEGY — two templates, because each fails differently:
 * a CHAINED reference (re-extracted from each matched frame) tracks features
 * that rotate, scale and relight gradually — which is all real footage — but
 * integrates ~0.05px/frame of resampling bias into a visible walk-off; a
 * frame-0 ANCHOR has zero drift but loses the feature the moment it evolves.
 * So: the chained match finds the feature, then the anchor template
 * re-registers the position (drift correction). When the anchor no longer
 * matches there (appearance genuinely changed, not drifted), the anchor is
 * RE-SET to the current appearance — the standard answer to the template
 * update problem, and the reason a static shot tracks to a standstill while
 * a slowly turning face keeps tracking.
 *
 * LOST HANDLING — when confidence falls below `minConfidence` the tracker
 * COASTS: it predicts the next centre from the last confident velocity and
 * keeps matching against the last confident reference patch. A feature that
 * ducks behind a lamppost for four frames comes out the other side still
 * tracked; a feature that genuinely leaves stays lost and the walk stops
 * after `maxCoastFrames`. Coasted samples are emitted (the playhead needs a
 * position for every frame) but flagged, so applying keyframes can skip or
 * a UI can colour them.
 *
 * The frame source is a plain async callback (`frameAt`), NOT ExactVideoSource
 * — the tests hand it synthetic planes, and the app hands it decoded frames.
 * Frames are pulled strictly one at a time, in order, so the decoder's GOP
 * cache does its job and memory stays flat on long clips.
 */

import {
  extractPatch,
  matchPatch,
  type LumaPlane,
} from './patchMatch';

export interface TrackerOptions {
  /** Decoded luma for a presentation frame index. */
  frameAt: (frameIndex: number) => Promise<LumaPlane>;
  /** First and last frame of the walk, inclusive. `to < from` tracks backwards. */
  fromFrame: number;
  toFrame: number;
  /** Feature centre in SOURCE pixels at `fromFrame`. */
  startX: number;
  startY: number;
  /** Half-size of the feature patch (patch is (2h+1)²). Default 10 → 21×21. */
  featureHalf?: number;
  /** Half-size of the search window around the predicted centre. Default 20. */
  searchHalf?: number;
  /** NCC below this is a lost frame (coast). Default 0.55. */
  minConfidence?: number;
  /** Consecutive coasted frames before giving up. Default 8. */
  maxCoastFrames?: number;
  /** Progress callback; return false to cancel the walk. */
  onProgress?: (done: number, total: number) => boolean | void;
}

export interface TrackSample {
  frame: number;
  /** Feature centre in SOURCE pixels, sub-pixel. */
  x: number;
  y: number;
  /** Peak NCC in [-1, 1]; the start frame reports 1. */
  confidence: number;
  /** True when this sample is a velocity prediction, not a real match. */
  coasted: boolean;
}

export interface TrackResult {
  samples: TrackSample[];
  /** 'completed' walked the whole range; 'lost' gave up mid-way (samples
   *  still hold everything up to the loss); 'cancelled' via onProgress. */
  status: 'completed' | 'lost' | 'cancelled';
}

const DEFAULT_FEATURE_HALF = 10;
const DEFAULT_SEARCH_HALF = 20;
const DEFAULT_MIN_CONFIDENCE = 0.55;
const DEFAULT_MAX_COAST = 8;

/**
 * The per-point stepping state — one feature's whole life across the walk.
 * Extracted so one decoded frame serves EVERY point (the multi-point walk
 * exists to decode each frame exactly once, not once per point).
 */
class PointTrack {
  samples: TrackSample[] = [];
  dead = false;
  private refPatch: Float32Array;
  private anchorPatch: Float32Array | null;
  private x: number;
  private y: number;
  private vx = 0;
  private vy = 0;
  private coastRun = 0;

  constructor(
    first: LumaPlane,
    startFrame: number,
    startX: number,
    startY: number,
    private readonly featureHalf: number,
    private readonly searchHalf: number,
    private readonly minConfidence: number,
    private readonly maxCoast: number,
  ) {
    this.x = startX;
    this.y = startY;
    const ref = extractPatch(first, startX, startY, featureHalf);
    if (!ref) {
      // Off the frame — nothing to track. One honest sample, born dead.
      this.refPatch = new Float32Array(0);
      this.anchorPatch = null;
      this.samples.push({ frame: startFrame, x: startX, y: startY, confidence: 0, coasted: true });
      this.dead = true;
      return;
    }
    this.refPatch = ref;
    this.anchorPatch = ref;
    this.samples.push({ frame: startFrame, x: startX, y: startY, confidence: 1, coasted: false });
  }

  step(frame: number, plane: LumaPlane): void {
    if (this.dead) return;
    // Velocity is ROUNDED before prediction so every candidate centre shares
    // the reference patch's fractional phase. Bilinear extraction blurs a
    // patch by an amount that depends on that phase; when ref and candidate
    // phases differ, the asymmetric blur biases the NCC peak and the chain
    // drifts ~0.1px/frame. Equal phases blur identically, the bias cancels
    // in the correlation, and the sub-pixel answer comes from the LK fit —
    // where it belongs. Rounding costs at most half a pixel of window
    // centring, which searchHalf already covers.
    const predictX = this.x + Math.round(this.vx);
    const predictY = this.y + Math.round(this.vy);
    const match = matchPatch(this.refPatch, this.featureHalf, plane, predictX, predictY, this.searchHalf);

    if (match && match.confidence >= this.minConfidence) {
      let mx = match.x;
      let my = match.y;
      let conf = match.confidence;
      // Drift correction: re-register against the anchor template near the
      // chained answer. Accept only a nearby, confident re-registration —
      // an anchor that matches far away or badly is not correcting drift,
      // it is disagreeing about what the feature looks like now.
      if (this.anchorPatch) {
        const anchored = matchPatch(this.anchorPatch, this.featureHalf, plane, mx, my, 2);
        if (
          anchored &&
          anchored.confidence >= this.minConfidence &&
          Math.hypot(anchored.x - mx, anchored.y - my) <= 1.5
        ) {
          mx = anchored.x;
          my = anchored.y;
          conf = anchored.confidence;
        } else {
          // Appearance changed: the current look becomes the new anchor.
          this.anchorPatch = extractPatch(plane, mx, my, this.featureHalf);
        }
      }
      this.vx = mx - this.x;
      this.vy = my - this.y;
      this.x = mx;
      this.y = my;
      this.coastRun = 0;
      this.samples.push({ frame, x: mx, y: my, confidence: conf, coasted: false });
      // Chained reference: re-extract from the frame we just matched.
      const next = extractPatch(plane, mx, my, this.featureHalf);
      if (next) this.refPatch = next;
    } else {
      // Coast on the last confident velocity, reference unchanged — the next
      // confident match must beat the patch from BEFORE the occlusion.
      this.coastRun += 1;
      this.x = predictX;
      this.y = predictY;
      this.samples.push({ frame, x: predictX, y: predictY, confidence: match?.confidence ?? 0, coasted: true });
      if (this.coastRun > this.maxCoast) this.dead = true;
    }
  }
}

export interface MultiTrackerOptions {
  frameAt: (frameIndex: number) => Promise<LumaPlane>;
  fromFrame: number;
  toFrame: number;
  /** Feature centres in SOURCE pixels at `fromFrame`, one track each. */
  points: ReadonlyArray<{ x: number; y: number }>;
  featureHalf?: number;
  searchHalf?: number;
  minConfidence?: number;
  maxCoastFrames?: number;
  onProgress?: (done: number, total: number) => boolean | void;
}

export interface MultiTrackResult {
  /** One sample list per input point, same order. A point that got lost
   *  mid-way keeps its samples up to the loss; the others keep walking. */
  tracks: TrackSample[][];
  /** 'lost' only when EVERY point died before the end of the range. */
  status: 'completed' | 'lost' | 'cancelled';
}

/**
 * Track several points across one walk — each frame is decoded ONCE and every
 * live point matches against it. A corner pin is four of these; a mask edge
 * is one per vertex; decoding per point would make those 4× and N× the cost
 * for byte-identical planes.
 */
export async function trackPoints(opts: MultiTrackerOptions): Promise<MultiTrackResult> {
  const featureHalf = opts.featureHalf ?? DEFAULT_FEATURE_HALF;
  const searchHalf = opts.searchHalf ?? DEFAULT_SEARCH_HALF;
  const minConfidence = opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const maxCoast = opts.maxCoastFrames ?? DEFAULT_MAX_COAST;
  const step = opts.toFrame >= opts.fromFrame ? 1 : -1;
  const total = Math.abs(opts.toFrame - opts.fromFrame) + 1;

  const first = await opts.frameAt(opts.fromFrame);
  const tracks = opts.points.map(
    (p) => new PointTrack(first, opts.fromFrame, p.x, p.y, featureHalf, searchHalf, minConfidence, maxCoast),
  );
  if (tracks.every((t) => t.dead)) {
    return { tracks: tracks.map((t) => t.samples), status: 'lost' };
  }

  for (let frame = opts.fromFrame + step, done = 1; frame !== opts.toFrame + step; frame += step, done++) {
    if (opts.onProgress?.(done, total) === false) {
      return { tracks: tracks.map((t) => t.samples), status: 'cancelled' };
    }
    const plane = await opts.frameAt(frame);
    for (const t of tracks) t.step(frame, plane);
    if (tracks.every((t) => t.dead)) {
      return { tracks: tracks.map((t) => t.samples), status: 'lost' };
    }
  }
  return { tracks: tracks.map((t) => t.samples), status: 'completed' };
}

/** One point — the multi-point walk with a party of one. */
export async function trackPoint(opts: TrackerOptions): Promise<TrackResult> {
  const r = await trackPoints({
    frameAt: opts.frameAt,
    fromFrame: opts.fromFrame,
    toFrame: opts.toFrame,
    points: [{ x: opts.startX, y: opts.startY }],
    ...(opts.featureHalf !== undefined ? { featureHalf: opts.featureHalf } : {}),
    ...(opts.searchHalf !== undefined ? { searchHalf: opts.searchHalf } : {}),
    ...(opts.minConfidence !== undefined ? { minConfidence: opts.minConfidence } : {}),
    ...(opts.maxCoastFrames !== undefined ? { maxCoastFrames: opts.maxCoastFrames } : {}),
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
  });
  return { samples: r.tracks[0] ?? [], status: r.status };
}
