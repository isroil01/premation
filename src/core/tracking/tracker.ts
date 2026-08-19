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

export async function trackPoint(opts: TrackerOptions): Promise<TrackResult> {
  const featureHalf = opts.featureHalf ?? DEFAULT_FEATURE_HALF;
  const searchHalf = opts.searchHalf ?? DEFAULT_SEARCH_HALF;
  const minConfidence = opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const maxCoast = opts.maxCoastFrames ?? DEFAULT_MAX_COAST;
  const step = opts.toFrame >= opts.fromFrame ? 1 : -1;
  const total = Math.abs(opts.toFrame - opts.fromFrame) + 1;

  const first = await opts.frameAt(opts.fromFrame);
  let refPatch = extractPatch(first, opts.startX, opts.startY, featureHalf);
  let anchorPatch = refPatch;
  if (!refPatch) {
    // The start point is off the frame — nothing to track. One honest sample.
    return {
      samples: [{ frame: opts.fromFrame, x: opts.startX, y: opts.startY, confidence: 0, coasted: true }],
      status: 'lost',
    };
  }

  const samples: TrackSample[] = [
    { frame: opts.fromFrame, x: opts.startX, y: opts.startY, confidence: 1, coasted: false },
  ];

  // Velocity in px/frame from the last two confident samples — the motion
  // prediction that both centres the search window (so `searchHalf` bounds
  // ACCELERATION, not speed) and carries the point through occlusions.
  let vx = 0;
  let vy = 0;
  let x = opts.startX;
  let y = opts.startY;
  let coastRun = 0;

  for (let frame = opts.fromFrame + step, done = 1; frame !== opts.toFrame + step; frame += step, done++) {
    if (opts.onProgress?.(done, total) === false) {
      return { samples, status: 'cancelled' };
    }
    const plane = await opts.frameAt(frame);
    // Velocity is ROUNDED before prediction so every candidate centre shares
    // the reference patch's fractional phase. Bilinear extraction blurs a
    // patch by an amount that depends on that phase; when ref and candidate
    // phases differ, the asymmetric blur biases the NCC peak and the chain
    // drifts ~0.1px/frame. Equal phases blur identically, the bias cancels
    // in the correlation, and the sub-pixel answer comes from the parabolic
    // fit — where it belongs. Rounding costs at most half a pixel of window
    // centring, which searchHalf already covers.
    const predictX = x + Math.round(vx);
    const predictY = y + Math.round(vy);
    const match = matchPatch(refPatch, featureHalf, plane, predictX, predictY, searchHalf);

    if (match && match.confidence >= minConfidence) {
      let mx = match.x;
      let my = match.y;
      let conf = match.confidence;
      // Drift correction: re-register against the anchor template near the
      // chained answer. Accept only a nearby, confident re-registration —
      // an anchor that matches far away or badly is not correcting drift,
      // it is disagreeing about what the feature looks like now.
      if (anchorPatch) {
        const anchored = matchPatch(anchorPatch, featureHalf, plane, mx, my, 2);
        if (
          anchored &&
          anchored.confidence >= minConfidence &&
          Math.hypot(anchored.x - mx, anchored.y - my) <= 1.5
        ) {
          mx = anchored.x;
          my = anchored.y;
          conf = anchored.confidence;
        } else {
          // Appearance changed: the current look becomes the new anchor.
          anchorPatch = extractPatch(plane, mx, my, featureHalf);
        }
      }
      vx = mx - x;
      vy = my - y;
      x = mx;
      y = my;
      coastRun = 0;
      samples.push({ frame, x, y, confidence: conf, coasted: false });
      // Chained reference: re-extract from the frame we just matched.
      const next = extractPatch(plane, x, y, featureHalf);
      if (next) refPatch = next;
    } else {
      // Coast on the last confident velocity, reference unchanged — the next
      // confident match must beat the patch from BEFORE the occlusion.
      coastRun += 1;
      x = predictX;
      y = predictY;
      samples.push({ frame, x, y, confidence: match?.confidence ?? 0, coasted: true });
      if (coastRun > maxCoast) {
        return { samples, status: 'lost' };
      }
    }
  }
  return { samples, status: 'completed' };
}
