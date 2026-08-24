/**
 * Scene Edit Detection — find the cuts in already-edited footage.
 *
 * After Effects' version (Layer ▸ Scene Edit Detection) turns each detected cut
 * into a marker or a split. This is the algorithm half: frames in, cut frame
 * indices out. It is deliberately classical — a luma-histogram distance with an
 * adaptive threshold — because on hard cuts that is what works, it runs at
 * decode speed, and it is inspectable when it is wrong. Neural shot detectors
 * earn their keep on dissolves; a dissolve is not what "find where the editor
 * cut" means.
 *
 * ## How a cut is scored
 *
 * Every frame is reduced to a 64-bin luma histogram, normalised to sum to 1.
 * The distance between consecutive frames is the L1 (sum of absolute bin
 * differences), in 0..2. A hard cut scores ~0.6–1.6; ordinary motion ~0.02–0.2;
 * a flash frame or fast pan can reach 0.4.
 *
 * A single global threshold mis-fires on both ends — dark scenes cut at lower
 * distances than bright ones, and a handheld clip has a higher floor than a
 * locked-off one. So the threshold is ADAPTIVE: a frame is a cut when its
 * distance exceeds `sensitivity × the local median` over a window of
 * neighbouring distances AND exceeds an absolute floor. The median ignores the
 * spike itself (that is the point of a median), so one real cut does not raise
 * the bar for the next.
 *
 * `minShotFrames` suppresses anything closer than that to the previous cut —
 * a flash-frame pair (two cuts two frames apart) is one cut, and the editor's
 * cuts are never 3 frames apart.
 *
 * Pure: no decoder, no scene graph. The video driver in `sceneEditDetectLayer`
 * feeds it and turns the frame indices into markers or splits.
 */

import type { LumaPlane } from './patchMatch';

export interface SceneEditOptions {
  /** Multiple of the local median a distance must exceed to be a cut. Default 5. */
  sensitivity?: number;
  /** Absolute L1 floor below which nothing is a cut, whatever the median. Default 0.3. */
  floor?: number;
  /** Frames on each side used for the local median. Default 12. */
  window?: number;
  /** Cuts closer than this to the previous one are dropped. Default 6. */
  minShotFrames?: number;
  /**
   * Also find DISSOLVES (cross-fades). Default true. A dissolve never spikes
   * — each frame differs from its neighbour by a little — so it is found on
   * the SUM of distances over a window: a run of small steady changes that
   * adds up to what a cut would be in one frame. Reported at the dissolve's
   * midpoint, which is where an editor would split it.
   */
  dissolves?: boolean;
  /** Longest dissolve to look for, in frames. Default 30 (≈1 s at 30 fps). */
  maxDissolveFrames?: number;
}

const BINS = 64;

/** Normalised 64-bin luma histogram. Accepts 0..255 bytes or 0..1 / 0..255 floats. */
export function lumaHistogram(plane: LumaPlane): Float32Array {
  const h = new Float32Array(BINS);
  const d = plane.data;
  const n = d.length;
  if (n === 0) return h;
  // Float planes from the canvas reader are 0..255; from synthetic tests they
  // may be 0..1. Sniff the range once rather than demand a contract.
  let scale = 1;
  if (d instanceof Float32Array) {
    let max = 0;
    for (let i = 0; i < n; i += 97) if (d[i]! > max) max = d[i]!;
    scale = max <= 1.0001 ? 255 : 1;
  }
  for (let i = 0; i < n; i++) {
    let v = d[i]! * scale;
    if (v < 0) v = 0;
    else if (v > 255) v = 255;
    h[(v * (BINS / 256)) | 0]! += 1;
  }
  const inv = 1 / n;
  for (let b = 0; b < BINS; b++) h[b]! *= inv;
  return h;
}

/** L1 distance between two normalised histograms, 0..2. */
export function histogramDistance(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < BINS; i++) s += Math.abs(a[i]! - b[i]!);
  return s;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = values.slice().sort((x, y) => x - y);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * Cut frame indices from a list of consecutive-frame distances.
 *
 * `distances[i]` is the distance between frame i and frame i+1, so a cut at
 * `distances[i]` means frame i+1 is the FIRST frame of the new shot — which is
 * where the marker goes and where the split lands. Returned indices are those
 * first-of-shot frames, relative to the start of `distances`.
 */
export function cutsFromDistances(distances: ReadonlyArray<number>, opts: SceneEditOptions = {}): number[] {
  const sensitivity = opts.sensitivity ?? 5;
  const floor = opts.floor ?? 0.3;
  const window = opts.window ?? 12;
  const minShot = opts.minShotFrames ?? 6;
  const cuts: number[] = [];
  let lastCut = -Infinity;

  for (let i = 0; i < distances.length; i++) {
    const d = distances[i]!;
    if (d < floor) continue;
    // Local median, excluding i itself. Near the ends the window is simply
    // shorter; a two-frame clip has nothing to compare to and finds no cuts.
    const lo = Math.max(0, i - window);
    const hi = Math.min(distances.length - 1, i + window);
    const neighbours: number[] = [];
    for (let j = lo; j <= hi; j++) if (j !== i) neighbours.push(distances[j]!);
    const base = median(neighbours);
    // A perfectly static shot has a median of 0; any floor-passing spike is a
    // cut there. Guard the multiply with a small epsilon so it is not 0 × ∞.
    if (d < sensitivity * Math.max(base, 0.01)) continue;
    const frame = i + 1;
    if (frame - lastCut < minShot) {
      // Two spikes inside one minimum shot: keep the stronger. A flash frame
      // is two spikes a frame apart, and the second is usually the real cut.
      if (cuts.length && d > distances[cuts[cuts.length - 1]! - 1]!) cuts[cuts.length - 1] = frame;
      lastCut = cuts[cuts.length - 1] ?? frame;
      continue;
    }
    cuts.push(frame);
    lastCut = frame;
  }
  return cuts;
}

/**
 * Dissolves from the same distance curve.
 *
 * A hard cut is one large step. A dissolve is a run of SMALL steps that are
 * all in the same direction — the histogram drifts steadily from shot A's to
 * shot B's. So: over every window of `maxLen` pairs, the accumulated L1
 * distance must reach `floor` (the same "this is a different picture"
 * threshold a cut must pass) while no single step exceeds `stepCap` (else it
 * is a cut, already reported) and the steps are CONSISTENT — the distance
 * from the window's first frame to its last is close to the sum of the
 * steps, which a pan (that drifts and comes back) fails and a fade passes.
 *
 * Consistency is measured on the histograms themselves: the caller passes a
 * `directDistance(i, j)` for that. Kept out of `cutsFromDistances` so the
 * pure cut detector's contract does not change.
 */
export function dissolvesFromDistances(
  distances: ReadonlyArray<number>,
  directDistance: (i: number, j: number) => number,
  opts: { floor?: number; maxLen?: number; stepCap?: number; minShotFrames?: number; knownCuts?: ReadonlyArray<number> } = {},
): number[] {
  const floor = opts.floor ?? 0.3;
  const maxLen = opts.maxLen ?? 30;
  const stepCap = opts.stepCap ?? floor * 0.8;
  const minShot = opts.minShotFrames ?? 6;
  const cutSet = new Set(opts.knownCuts ?? []);
  const out: number[] = [];
  const n = distances.length;
  let i = 0;
  while (i < n) {
    let sum = 0;
    let found = false;
    for (let j = i; j < n && j - i < maxLen; j++) {
      const d = distances[j]!;
      // A step this big is a cut, and a cut already reported ends any window.
      if (d >= stepCap || cutSet.has(j + 1)) break;
      sum += d;
      if (sum >= floor) {
        // Enough total change. Steady drift (dissolve) or a wander (pan)?
        // For a true cross-fade the histogram moves along the line between
        // the two shots' histograms, so the direct distance equals the sum;
        // a pan that drifts out and back has a sum far above its direct.
        const direct = directDistance(i, j + 1);
        if (direct >= floor * 0.85 && direct >= sum * 0.7) {
          // The onset is confirmed; now find the END. Keep extending while the
          // picture is still drifting the same way — steps above the still
          // floor, no cut-sized step, and the straight-line check holding —
          // so a 20-frame fade is one event at its middle, not several at
          // every point the running sum crossed the threshold.
          const still = floor / maxLen;
          let end = j + 1;
          let total = sum;
          while (end < n && end - i < maxLen) {
            const step = distances[end]!;
            if (step >= stepCap || step < still || cutSet.has(end + 1)) break;
            const tryTotal = total + step;
            if (directDistance(i, end + 1) < tryTotal * 0.7) break;
            total = tryTotal;
            end++;
          }
          const mid = i + Math.round((end - i) / 2);
          if (!out.length || mid - out[out.length - 1]! >= minShot) out.push(mid);
          i = end;
          found = true;
        }
        break;
      }
    }
    if (!found) i++;
  }
  return out;
}

export interface SceneEditWalkOptions extends SceneEditOptions {
  /** Decoded luma for a frame index. Pulled strictly in order. */
  frameAt: (frameIndex: number) => Promise<LumaPlane>;
  fromFrame: number;
  /** Inclusive. */
  toFrame: number;
  /** Progress 0..1; return false to cancel. */
  onProgress?: (fraction: number) => boolean | void;
}

export interface SceneEditWalkResult {
  /** First-of-shot frame indices, in source frame space, ascending. Includes
   *  dissolve midpoints when `dissolves` is on. */
  cuts: number[];
  /** Which of `cuts` are dissolve midpoints rather than hard cuts. */
  dissolveCuts: number[];
  /** Per-pair distances, for a UI that wants to show the curve or re-threshold. */
  distances: number[];
  status: 'completed' | 'cancelled';
}

/**
 * Walk a frame range once, scoring every consecutive pair.
 *
 * Holds ONE previous histogram, never a previous frame — a 4K luma plane is
 * 8 MB and a histogram is 256 bytes, so memory stays flat on an hour of
 * footage. Distances are kept (a few bytes a frame) because re-thresholding
 * without re-decoding is the whole reason to keep them.
 */
export async function walkSceneEdits(opts: SceneEditWalkOptions): Promise<SceneEditWalkResult> {
  const total = opts.toFrame - opts.fromFrame;
  const distances: number[] = [];
  if (total < 1) return { cuts: [], dissolveCuts: [], distances, status: 'completed' };

  // Histograms are kept (256 B a frame) so dissolve detection can compare a
  // window's first and last frame directly. Frames are not kept.
  const hists: Float32Array[] = [lumaHistogram(await opts.frameAt(opts.fromFrame))];
  const finish = (status: 'completed' | 'cancelled'): SceneEditWalkResult => {
    const hard = cutsFromDistances(distances, opts);
    const soft = opts.dissolves === false
      ? []
      : dissolvesFromDistances(distances, (i, j) => histogramDistance(hists[i]!, hists[j]!), {
          floor: opts.floor,
          maxLen: opts.maxDissolveFrames,
          minShotFrames: opts.minShotFrames,
          knownCuts: hard,
        });
    const all = [...new Set([...hard, ...soft])].sort((a, b) => a - b);
    return {
      cuts: all.map((c) => c + opts.fromFrame),
      dissolveCuts: soft.map((c) => c + opts.fromFrame),
      distances,
      status,
    };
  };
  for (let f = opts.fromFrame + 1; f <= opts.toFrame; f++) {
    const cur = lumaHistogram(await opts.frameAt(f));
    distances.push(histogramDistance(hists[hists.length - 1]!, cur));
    hists.push(cur);
    if (opts.onProgress?.((f - opts.fromFrame) / total) === false) return finish('cancelled');
  }
  return finish('completed');
}
