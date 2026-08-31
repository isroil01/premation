/**
 * Track Motion's driver: comp frames in, tracked comp-time samples out.
 *
 * The tracker core (tracker.ts) walks SOURCE frames; the timeline thinks in
 * COMP frames; and one comp frame maps to one source frame through the
 * layer's clip (trim/slip), stretch and remap. This module owns that seam:
 *
 *   comp frame → compToKeyframeTime(videoNode) → media seconds
 *             → ExactVideoSource.frameIndexAt  → presentation frame index
 *
 * `compToKeyframeTime` is the SAME axis every keyframe write in the app uses
 * (moveNodes, expression bake), so the frame the tracker matched is the frame
 * the renderer shows at that comp time — the whole point of tracking on the
 * exact decoder rather than a seeked <video> element.
 *
 * A comp range can hit each source frame more than once (freeze frames, slow
 * stretch) — the walk runs over the DISTINCT source-frame span once, and comp
 * samples are read out of it, so a 50%-stretched clip does not decode (or
 * match) every frame twice.
 *
 * Decoding pulls frames strictly one at a time through ExactVideoSource, so
 * its GOP cache absorbs the sequential access and memory stays flat on long
 * clips. Luma extraction goes through ONE reused canvas.
 *
 * ── It decodes the ANALYSIS proxy when there is one ─────────────────────────
 *
 * A tracker does not need 4K pixels, and the repo's own table says why it must
 * not ask for them: a 4K random seek costs 171.8ms against 17.4ms at 540p, and
 * seek is 97.6% of the cost at 4K. A feature matcher works on a downsampled
 * pyramid; AE's does, and this app's auto-reframe has analysed at 160px wide
 * since it was written.
 *
 * This used to read the ORIGINAL unconditionally, with a comment arguing that a
 * quarter-resolution tracker returning quarter-precision positions would be the
 * "proxy silently in use" bug again. The premise is right and the conclusion did
 * not follow: positions are reported in the DISPLAY grid, and the display↔coded
 * conversion this module already owns (`toCodedX`/`toCodedY`) is exactly the
 * factor between them. Decoding a 960px stand-in changes `codedWidth`, and every
 * number in and out goes through that same conversion — so precision is a
 * property of the MATCHER, which refines sub-pixel, not of the file it read.
 *
 * What would have made the old comment true is measuring in one grid and
 * reporting in another. That is precisely what the window sizes did: `points`
 * were converted and `featureHalf`/`searchHalf` were not, which was invisible
 * while coded == display and would have made every window four times too large
 * on a proxy. They are converted now, and pinned by test.
 *
 * Falls back analysis → viewport → original (`resolveMediaSrc`), because an
 * analysis walk cares about decode cost and nothing else: a 1920px stand-in
 * beats a 3840px one when no 960px one exists. Slower than it could be always
 * beats wrong — `proxyManager`'s failure philosophy, unchanged.
 *
 * Two entry points share all of that through `openLayerFrames`:
 * `trackVideoLayerPoints` (explicit points, playhead onwards — the classic
 * Track Motion panel) and `autoTrackVideoLayer` (one click: pick the feature,
 * size the windows, walk both ways — see autoTrack.ts).
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { assetIdOf } from '@core/source/sourceInfo';
import { useAssetStore } from '@stores/assetStore';
import { resolveMediaSrc, servedProxy } from '@core/assets/proxy';
import {
  isLocalBlobRef,
  resolveLocalBlobObjectUrl,
  releaseLocalBlobObjectUrl,
} from '@core/rendering/localBlobSource';
import { compToKeyframeTime, getTimelineController } from '@core/timeline/TimelineController';
import type { DemuxedVideo } from '@core/video/mp4Demuxer';
import { demuxFile } from '@core/video/demuxClient';
import { ExactVideoSource, SequentialFrameReader, webCodecsAvailable } from '@core/video/exactVideoSource';
import type { VideoFrameIndex } from '@core/video/frameIndex';
import type { LumaPlane } from './patchMatch';
import { lumaFromDecodedFrame, makeCanvasLumaReader } from './lumaExtract';
import { trackPoints, type TrackSample } from './tracker';
import { sourceDisplaySize } from './trackerSource';
import { createReverseFrameWalk } from './reverseFrameWalk';
import { runAutoTrack, type TrackPlan } from './autoTrack';

export interface CompTrackSample {
  /** Comp seconds — where the playhead is when this sample applies. */
  compTime: number;
  /** Feature centre in source DISPLAY pixels (see trackerSource.ts). */
  x: number;
  y: number;
  confidence: number;
  coasted: boolean;
}

export interface VideoTrackRequest {
  nodeId: string;
  /** Comp-time range to track, inclusive, in seconds. */
  startCompTime: number;
  endCompTime: number;
  fps: number;
  /** Feature centre in source DISPLAY px at the START comp time (the grid
   *  `sourceDisplaySize` reports — see trackerSource.ts). */
  startX: number;
  startY: number;
  featureHalf: number;
  searchHalf: number;
  /** Return false to cancel. */
  onProgress?: (fraction: number) => boolean | void;
}

export interface VideoTrackResult {
  samples: CompTrackSample[];
  sourceWidth: number;
  sourceHeight: number;
  status: 'completed' | 'lost' | 'cancelled';
}

export interface MultiVideoTrackRequest extends Omit<VideoTrackRequest, 'startX' | 'startY'> {
  /** Feature centres in source DISPLAY px at the START comp time. */
  points: ReadonlyArray<{ x: number; y: number }>;
}

export interface MultiVideoTrackResult {
  /** One comp-sample list per input point, same order. */
  tracks: CompTrackSample[][];
  sourceWidth: number;
  sourceHeight: number;
  status: 'completed' | 'lost' | 'cancelled';
}

// Luma extraction lives in lumaExtract.ts: Y-plane copyTo fast path for raw
// VideoFrames (the streaming reader hands those over), canvas readback for
// everything else.

/**
 * Everything both drivers need to turn a layer into decodable, measurable
 * frames — opened once, closed once.
 *
 * Extracted because the alternative is two copies of the asset lookup, the
 * demux, the display↔coded conversion and the software-decoder probe, and the
 * first time one copy is fixed and the other is not, tracking silently starts
 * measuring in a different pixel grid depending on which button was pressed.
 */
interface LayerFrames {
  source: ExactVideoSource;
  /** Kept alongside the source because `SequentialFrameReader` is constructed
   *  from the demuxed track, and `ExactVideoSource` holds its copy privately. */
  demuxed: DemuxedVideo;
  codedWidth: number;
  codedHeight: number;
  /** The grid every point, sample and UI number speaks (trackerSource.ts). */
  display: { width: number; height: number };
  /** display px → coded px. */
  toCodedX: number;
  toCodedY: number;
  /** Luma for a decoded frame, through the shared canvas fallback. */
  toLuma: (frame: unknown) => Promise<LumaPlane>;
  /** Decoder options carrying the software-decode preference, if supported. */
  decoderOpts: { hardwareAcceleration?: 'prefer-software' };
  /** Comp frame → source presentation index, through the layer's time chain. */
  srcIndexAt: (compFrame: number) => number;
  /** Bytes one luma plane occupies — the reverse walk budgets on it. */
  planeBytes: number;
  /** Presentation index of the keyframe starting `index`'s GOP. */
  keyframeAtOrBefore: (index: number) => number;
  /** Which tier actually served, for diagnostics and tests. */
  servedTier: 'analysis' | 'viewport' | 'original';
  close: () => void;
}

/**
 * Presentation index of each frame's GOP keyframe.
 *
 * The index stores `keyDecodeIndex` in DECODE order, which is the order the
 * decoder is fed and NOT the order the walk counts in — B-frames make the two
 * disagree. Inverting decode→presentation once here is what lets the reverse
 * walk start a chunk exactly on a keyframe instead of guessing.
 */
function keyframeLookup(index: VideoFrameIndex): (presIndex: number) => number {
  const presOfDecode = new Map<number, number>();
  for (let p = 0; p < index.frames.length; p++) presOfDecode.set(index.frames[p]!.decodeIndex, p);
  return (presIndex) => {
    const entry = index.frames[presIndex];
    if (!entry) return 0;
    return presOfDecode.get(entry.keyDecodeIndex) ?? 0;
  };
}

async function openLayerFrames(nodeId: string, fps: number): Promise<LayerFrames> {
  if (!webCodecsAvailable()) {
    throw new Error('Tracking needs WebCodecs, which this runtime does not have.');
  }
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) throw new Error('Layer is gone.');
  const assetId = assetIdOf(node);
  const asset = assetId
    ? useAssetStore.getState().assets.find((a) => a.id === assetId)
    : undefined;
  if (!asset || asset.type !== 'video') throw new Error('Layer has no video source.');

  // The ANALYSIS stand-in when one exists, else the viewport one, else the
  // original — see the header for why a lower-resolution decode does not cost
  // precision here. Requested BY NAME: no render path can reach this tier, and
  // the export invariant is untouched.
  const served = servedProxy(asset, 'analysis');
  const src = resolveMediaSrc(asset, 'analysis') ?? asset.src;
  const servedTier: LayerFrames['servedTier'] =
    served === asset.analysisProxy && served ? 'analysis'
      : served ? 'viewport'
        : 'original';
  // A `motion-blob:` ref is a bundle reference, not a URL — fetching one throws.
  // Retained for the life of this walk and released with the source.
  const holder = `track:${nodeId}`;
  const url = isLocalBlobRef(src) ? await resolveLocalBlobObjectUrl(src, holder) : src;
  if (!url) throw new Error('The footage for this layer could not be resolved.');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Source unreadable (${res.status}).`);
  const buf = await res.arrayBuffer();
  // Off the main thread when one is available (see demuxClient). `buf` is
  // TRANSFERRED on that path and must not be read after this.
  const demuxed = await demuxFile(buf);
  const source = new ExactVideoSource(demuxed);

  // prefer-software: the tracker reads EVERY pixel back to the CPU, and a
  // hardware frame's copyTo pays ~60ms of GPU sync at 4K where a software
  // frame memcpys in ~2ms. Decoding is slower in software but the total is
  // ~3× faster — and the decoded pixels are spec-identical. Probed first:
  // an unsupported preference must degrade to the default, not kill the walk.
  let softwareOk = false;
  try {
    const vd = (globalThis as unknown as {
      VideoDecoder?: { isConfigSupported?: (c: object) => Promise<{ supported?: boolean }> };
    }).VideoDecoder;
    const sup = await vd?.isConfigSupported?.({
      codec: demuxed.codec,
      codedWidth: demuxed.codedWidth,
      codedHeight: demuxed.codedHeight,
      ...(demuxed.description ? { description: demuxed.description } : {}),
      hardwareAcceleration: 'prefer-software',
    });
    softwareOk = sup?.supported === true;
  } catch {
    // probe unavailable — stay on the default
  }

  // Display grid (what requests and samples speak) ↔ coded grid (what the
  // decoder hands the matcher). See trackerSource.ts.
  const display = sourceDisplaySize(nodeId) ?? {
    width: demuxed.codedWidth,
    height: demuxed.codedHeight,
  };
  const readLuma = makeCanvasLumaReader(demuxed.codedWidth, demuxed.codedHeight);

  return {
    source,
    demuxed,
    codedWidth: demuxed.codedWidth,
    codedHeight: demuxed.codedHeight,
    display,
    toCodedX: demuxed.codedWidth / display.width,
    toCodedY: demuxed.codedHeight / display.height,
    toLuma: (frame) => lumaFromDecodedFrame(frame, demuxed.codedWidth, demuxed.codedHeight, readLuma),
    decoderOpts: softwareOk ? { hardwareAcceleration: 'prefer-software' } : {},
    // +1µs for the fractional-boundary rule (see exactVideoFrames).
    srcIndexAt: (compFrame) => {
      const mediaSec = compToKeyframeTime(nodeId, compFrame / fps);
      return source.frameIndexAt(Math.max(0, Math.round(mediaSec * 1e6) + 1));
    },
    planeBytes: demuxed.codedWidth * demuxed.codedHeight,
    keyframeAtOrBefore: keyframeLookup(source.index),
    servedTier,
    close: () => {
      source.close();
      releaseLocalBlobObjectUrl(src, holder);
    },
  };
}

/**
 * Display px → decoded px for a scalar LENGTH (a window half-size, a radius).
 *
 * The inverse of `displayPlan`'s `toDisplayLength`, and the same reasoning:
 * anamorphic footage stretches the grid in x only, so one number cannot be
 * right for both axes and the geometric mean is the least wrong one — exactly
 * the per-axis scale whenever the pixels are square, which is every codec path
 * but anamorphic. Coordinates still convert per axis; only lengths use this.
 */
function toCodedLength(frames: LayerFrames): number {
  return Math.sqrt(frames.toCodedX * frames.toCodedY);
}

/** Comp frames in `[startFrame..endFrame]` paired with their source indices. */
function compToSourceMap(
  frames: LayerFrames,
  startFrame: number,
  endFrame: number,
): { compFrames: number[]; srcOfComp: number[] } {
  const compFrames: number[] = [];
  const srcOfComp: number[] = [];
  for (let f = startFrame; f <= endFrame; f++) {
    compFrames.push(f);
    srcOfComp.push(frames.srcIndexAt(f));
  }
  return { compFrames, srcOfComp };
}

/**
 * Source-frame samples → comp-time samples.
 *
 * A comp frame whose source frame the walk never reached (lost/cancelled
 * early) is DROPPED — a keyframe with no measurement behind it is not a
 * keyframe.
 */
function readOutCompSamples(
  frames: LayerFrames,
  compFrames: readonly number[],
  srcOfComp: readonly number[],
  fps: number,
  trackSamples: readonly TrackSample[],
): CompTrackSample[] {
  const byFrame = new Map<number, TrackSample>();
  for (const s of trackSamples) byFrame.set(s.frame, s);
  const out: CompTrackSample[] = [];
  for (let i = 0; i < compFrames.length; i++) {
    const s = byFrame.get(srcOfComp[i]!);
    if (!s) continue;
    out.push({
      compTime: compFrames[i]! / fps,
      x: s.x / frames.toCodedX,
      y: s.y / frames.toCodedY,
      confidence: s.confidence,
      coasted: s.coasted,
    });
  }
  return out;
}

export async function trackVideoLayerPoints(req: MultiVideoTrackRequest): Promise<MultiVideoTrackResult> {
  const frames = await openLayerFrames(req.nodeId, req.fps);
  try {
    const startFrame = Math.round(req.startCompTime * req.fps);
    const endFrame = Math.round(req.endCompTime * req.fps);
    if (endFrame <= startFrame) throw new Error('Nothing after the playhead to track.');

    const { compFrames, srcOfComp } = compToSourceMap(frames, startFrame, endFrame);
    const srcFrom = srcOfComp[0]!;
    const srcTo = srcOfComp[srcOfComp.length - 1]!;
    if (srcTo === srcFrom) {
      throw new Error('The clip does not advance over this range — nothing to track.');
    }

    // Forward walks stream through a SequentialFrameReader: each source frame
    // is decoded exactly once and closed after its luma copy. The random-
    // access frameAt path here was quadratic in GOP length AND pinned enough
    // decoder-pool frames to hang flush() — the "tracking freezes at 2–4%"
    // bug on real (long-GOP) footage. Reversed clips walk descending, which
    // `openWalk` serves by decoding forward in bounded chunks.
    const walk = openWalk(frames, srcFrom, srcTo);
    let result;
    try {
      result = await trackPoints({
        frameAt: walk.frameAt,
        fromFrame: srcFrom,
        toFrame: srcTo,
        points: req.points.map((p) => ({ x: p.x * frames.toCodedX, y: p.y * frames.toCodedY })),
        // Converted, like the points. These are DISPLAY px in the request and
        // the matcher wants decoded px — a distinction that was invisible while
        // the two grids matched and becomes a four-times-too-large search window
        // the moment a stand-in is decoded. Anamorphic footage had the same bug
        // on the original, in one axis, forever.
        //
        // By the geometric mean, which is the convention `displayPlan` already
        // established for a scalar LENGTH and states the reason for: one number
        // cannot be right for both axes, and the mean preserves area.
        featureHalf: req.featureHalf * toCodedLength(frames),
        searchHalf: req.searchHalf * toCodedLength(frames),
        onProgress: (done, total) => req.onProgress?.(done / total),
      });
    } finally {
      walk.close();
    }

    return {
      tracks: result.tracks.map((t) => readOutCompSamples(frames, compFrames, srcOfComp, req.fps, t)),
      sourceWidth: frames.display.width,
      sourceHeight: frames.display.height,
      status: result.status,
    };
  } finally {
    frames.close();
  }
}

/** One point — the multi-point drive with a party of one. */
export async function trackVideoLayer(req: VideoTrackRequest): Promise<VideoTrackResult> {
  const { startX, startY, ...rest } = req;
  const r = await trackVideoLayerPoints({ ...rest, points: [{ x: startX, y: startY }] });
  return {
    samples: r.tracks[0] ?? [],
    sourceWidth: r.sourceWidth,
    sourceHeight: r.sourceHeight,
    status: r.status,
  };
}

/**
 * A luma reader for `[from..to]` in whichever direction that range runs.
 *
 * Ascending is a straight stream. Descending goes through
 * `createReverseFrameWalk`, which decodes forward in bounded chunks and
 * serves them backwards — a decoder cannot run in reverse, and asking it to
 * seek per frame is the O(n·GOP) walk that used to make backward tracking
 * unusable on long-GOP footage.
 */
function openWalk(
  frames: LayerFrames,
  from: number,
  to: number,
): { frameAt: (index: number) => Promise<LumaPlane>; close: () => void } {
  if (to >= from) {
    const reader = new SequentialFrameReader(frames.demuxed, from, to, undefined, frames.decoderOpts);
    return {
      frameAt: async (index) => frames.toLuma(await reader.frameAt(index)),
      close: () => reader.close(),
    };
  }
  const reverse = createReverseFrameWalk({
    from,
    to,
    planeBytes: frames.planeBytes,
    keyframeAtOrBefore: frames.keyframeAtOrBefore,
    readAscending: async (lo, hi, emit) => {
      const reader = new SequentialFrameReader(frames.demuxed, lo, hi, undefined, frames.decoderOpts);
      try {
        for (let i = lo; i <= hi; i++) emit(i, await frames.toLuma(await reader.frameAt(i)));
      } finally {
        reader.close();
      }
    },
  });
  return { frameAt: reverse.frameAt, close: reverse.close };
}

export interface AutoTrackVideoRequest {
  nodeId: string;
  /** Where the playhead is — the frame the feature is chosen on. */
  anchorCompTime: number;
  /** Comp-time bounds to cover, inclusive. Defaults to the clip's own bars. */
  startCompTime?: number;
  endCompTime?: number;
  fps: number;
  /** Where the user clicked, in source DISPLAY px. Defaults to frame centre. */
  hint?: { x: number; y: number } | undefined;
  /** Search radius around the hint, in display px. */
  radius?: number | undefined;
  /** Return false to cancel. */
  onProgress?: ((fraction: number) => boolean | void) | undefined;
}

export interface AutoTrackVideoResult {
  /** One list per tracked point: [0] is the feature, [1] its companion. */
  tracks: CompTrackSample[][];
  sourceWidth: number;
  sourceHeight: number;
  /** The measured plan, in DISPLAY px — the UI reports it back to the user. */
  plan: {
    x: number;
    y: number;
    featureHalf: number;
    searchHalf: number;
    motionPerFrame: number | null;
    strength: number;
    distinctness: number;
  };
  status: 'completed' | 'partial' | 'cancelled';
}

/**
 * The whole one-click track for a video layer: choose the feature on the
 * playhead's frame, size both windows from measured motion, and walk the clip
 * in BOTH directions from there.
 *
 * Returns null when the footage under the click holds nothing trackable —
 * that is a sentence for the user, not an exception.
 */
export async function autoTrackVideoLayer(
  req: AutoTrackVideoRequest,
): Promise<AutoTrackVideoResult | null> {
  const frames = await openLayerFrames(req.nodeId, req.fps);
  try {
    const anchorFrame = Math.round(req.anchorCompTime * req.fps);
    const bounds = layerCompFrameBounds(req.nodeId, req.fps, req.startCompTime, req.endCompTime);
    const firstFrame = Math.min(anchorFrame, bounds.startFrame);
    const lastFrame = Math.max(anchorFrame, bounds.endFrame);

    const { compFrames, srcOfComp } = compToSourceMap(frames, firstFrame, lastFrame);
    // SOURCE-index space, not comp-time order. A time-reversed clip maps its
    // FIRST comp frame to its LAST source frame, and the walk cares only about
    // which source frames exist between the two ends — `readOutCompSamples`
    // puts the samples back on the comp axis by source index either way.
    const srcEnds = [srcOfComp[0]!, srcOfComp[srcOfComp.length - 1]!];
    const srcLo = Math.min(...srcEnds);
    const srcHi = Math.max(...srcEnds);
    if (srcLo === srcHi) {
      throw new Error('The clip does not advance over this range — nothing to track.');
    }
    const srcAnchor = Math.max(srcLo, Math.min(srcHi, frames.srcIndexAt(anchorFrame)));

    // The plan is measured on two randomly-accessed frames BEFORE either walk
    // opens, because both walks are single-direction streams: reading the
    // anchor and its successor through them would use up the very first
    // request in the wrong order.
    const anchorPlane = await frames.toLuma(await frames.source.frameAt(srcAnchor));
    // Two probe frames, not one: `planTrack` corroborates the displacement
    // across both before it believes either (see autoTrack.measureMotion).
    const probePlanes: LumaPlane[] = [];
    for (let i = srcAnchor + 1; i <= Math.min(srcHi, srcAnchor + 2); i++) {
      probePlanes.push(await frames.toLuma(await frames.source.frameAt(i)));
    }

    const forward = srcAnchor < srcHi ? openWalk(frames, srcAnchor, srcHi) : null;
    const backward = srcLo < srcAnchor ? openWalk(frames, srcAnchor, srcLo) : null;
    let out;
    try {
      out = await runAutoTrack({
        anchorFrame: srcAnchor,
        firstFrame: srcLo,
        lastFrame: srcHi,
        anchorPlane,
        probePlanes,
        // A walk that would be empty is never opened, so the anchor-only case
        // never constructs a decoder it will not read.
        forwardAt: forward?.frameAt ?? (async () => anchorPlane),
        backwardAt: backward?.frameAt,
        ...(req.hint
          ? { hint: { x: req.hint.x * frames.toCodedX, y: req.hint.y * frames.toCodedY } }
          : {}),
        // Same geometric-mean reasoning as `displayPlan`: a search RADIUS is a
        // length, not a coordinate.
        ...(req.radius !== undefined
          ? { radius: req.radius * Math.sqrt(frames.toCodedX * frames.toCodedY) }
          : {}),
        ...(req.onProgress ? { onProgress: req.onProgress } : {}),
      });
    } finally {
      forward?.close();
      backward?.close();
    }
    if (!out) return null;

    return {
      tracks: out.tracks.map((t) => readOutCompSamples(frames, compFrames, srcOfComp, req.fps, t)),
      sourceWidth: frames.display.width,
      sourceHeight: frames.display.height,
      plan: displayPlan(out.plan, frames),
      status: out.status,
    };
  } finally {
    frames.close();
  }
}

/**
 * A plan measured in coded px, restated in the display grid the UI speaks.
 *
 * Positions convert per axis, exactly. The SCALARS — window halves, px/frame —
 * cannot: they describe squares and lengths in the coded grid, and anamorphic
 * footage stretches that grid in x only, so a coded square is a display
 * rectangle and one number cannot be right for both axes. The geometric mean
 * preserves area, which makes it the least wrong single number, and it is
 * exactly the per-axis scale whenever the pixels are square (every codec path
 * except anamorphic). These values are shown to the user and re-seeded into
 * the manual controls; they are never used to convert a coordinate.
 */
function displayPlan(plan: TrackPlan, frames: LayerFrames): AutoTrackVideoResult['plan'] {
  const toDisplayLength = 1 / Math.sqrt(frames.toCodedX * frames.toCodedY);
  return {
    x: plan.x / frames.toCodedX,
    y: plan.y / frames.toCodedY,
    featureHalf: plan.featureHalf * toDisplayLength,
    searchHalf: plan.searchHalf * toDisplayLength,
    motionPerFrame: plan.motionPerFrame === null ? null : plan.motionPerFrame * toDisplayLength,
    strength: plan.feature.strength,
    distinctness: plan.feature.distinctness,
  };
}

/**
 * The comp span one click should cover, in comp FRAMES: the layer's own clip
 * bars.
 *
 * "Track this" means this shot, not this composition — a 3-second clip on a
 * 60-second timeline must not spend 57 seconds of decoding measuring frames
 * the layer does not show.
 *
 * FRAMES, not seconds, because `Clip.start`/`end` are frame counts (see
 * packages/timeline's Clip) while the request's optional overrides are seconds
 * like every other public time in this module. Conflating the two turned a
 * 255-frame clip into a 7651-frame walk, and it did NOT throw: every surplus
 * comp frame mapped to a source frame the walk had already visited, so the
 * only symptom was thirty times the keyframes. `Clip.end` is exclusive, so the
 * last frame the layer shows is the one before it.
 */
function layerCompFrameBounds(
  nodeId: string,
  fps: number,
  startSec: number | undefined,
  endSec: number | undefined,
): { startFrame: number; endFrame: number } {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  if (startSec === undefined || endSec === undefined) {
    try {
      for (const layer of getTimelineController().getLayersForNode(nodeId)) {
        lo = Math.min(lo, layer.start);
        hi = Math.max(hi, layer.end - 1);
      }
    } catch {
      // No timeline registry (tests, headless) — the caller's range stands.
    }
  }
  return {
    startFrame: startSec !== undefined ? Math.round(startSec * fps) : (Number.isFinite(lo) ? lo : 0),
    endFrame: endSec !== undefined ? Math.round(endSec * fps) : (Number.isFinite(hi) ? hi : 0),
  };
}
