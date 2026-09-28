/**
 * A layer's Position member tracks (`x`, `y`, `z`) as the engine reports them
 * (`getMemberKeyframes`, stored keyframe records) and the motion-path
 * arithmetic run over them on a SCRATCH animation engine (B4): the viewport's
 * motion-path edits (drag a vertex / tangent, Convert Vertex, Spatial
 * Interpolation, Smooth / Straighten) compute on a copy seeded from the
 * engine's answer, never on the TypeScript engine's live tracks, and send the
 * changed keys as commands (layout/Workspace/viewportEdits.ts).
 *
 * Pure over its arguments: every helper takes the tracks (or the scratch
 * engine built from them) explicitly.
 */

import { AnimationEngine, type Keyframe } from '@motion/animation';
import {
  isPathTangentContinuous,
  smoothMotionPath,
  spatialInterpAt,
  straightenMotionPath,
} from '@core/motion/motionPath';
import type { SpatialInterp } from '@motion/animation';

export const POSITION_TRACKS = ['x', 'y', 'z'] as const;

/** A layer's Position member tracks, deep-copied (the drag-start state). */
export type PositionTracks = Partial<Record<(typeof POSITION_TRACKS)[number], Keyframe[]>>;

/** The Position member tracks out of a getMemberKeyframes answer (parsed records). */
export function positionTracksFrom(tracks: ReadonlyArray<{ member: string; keyframes: ReadonlyArray<Keyframe> }>): PositionTracks {
  const out: PositionTracks = {};
  for (const m of POSITION_TRACKS) {
    const t = tracks.find((x) => x.member === m);
    if (t && t.keyframes.length > 0) out[m] = t.keyframes.map((k) => ({ ...k }));
  }
  return out;
}

/** A scratch animation engine holding only `start`'s tracks for `nodeId`. */
export function scratchPositionEngine(nodeId: string, start: PositionTracks): AnimationEngine {
  const scratch = new AnimationEngine();
  for (const m of POSITION_TRACKS) {
    const kfs = start[m];
    if (kfs) scratch.setTrackKeyframes(nodeId, m, kfs.map((k) => ({ ...k })));
  }
  return scratch;
}

/** The spatial interpolation of the path vertex at stored time `t`. */
export function positionSpatialInterpAt(nodeId: string, t: number, start: PositionTracks): SpatialInterp {
  return spatialInterpAt(nodeId, t, scratchPositionEngine(nodeId, start));
}

/** Whether the vertex at `t` has continuous (mirrored) tangents. */
export function positionTangentContinuous(nodeId: string, t: number, start: PositionTracks): boolean {
  return isPathTangentContinuous(nodeId, t, scratchPositionEngine(nodeId, start));
}

/** Smooth / straighten the path on the scratch engine given (the viewport's buttons). */
export function smoothPositionPath(nodeId: string, scratch: AnimationEngine): void {
  smoothMotionPath(nodeId, scratch);
}
export function straightenPositionPath(nodeId: string, scratch: AnimationEngine): void {
  straightenMotionPath(nodeId, scratch);
}
