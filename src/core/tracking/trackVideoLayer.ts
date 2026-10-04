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
