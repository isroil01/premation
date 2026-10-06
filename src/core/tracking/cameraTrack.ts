/**
 * The 3D Camera Tracker, editor side (AE parity 3.5). The solve runs in
 * premation-engine (the `cameraTrack` job: features, camera path, lens, scene
 * points) and is stored on the footage layer (`getCameraSolve`). Here: the
 * job requests and the track points' projection onto the footage for the
 * viewer — display maths only, the document is never computed here.
 */

import { flicksToSeconds, secondsToFlicks, type CameraSolveData, type EngineClient, type JobSpec, type TrackPointLayer } from '@motion/engine-api';

export type { CameraSolveData, TrackPointLayer };

export interface ProjectedTrackPoint {
  /** Index into the solve's points (what the job's `points` takes). */
  index: number;
  /** Footage (source display) px. */
  x: number;
  y: number;
  /** Reprojection error, px: the viewer sizes and colours the point by it. */
  error: number;
}

export function solveJob(layer: string, start: number, end: number, focalLength?: number): JobSpec {
  return {
    kind: 'cameraTrack',
    value: {
      layer,
      range: { start: secondsToFlicks(start), duration: secondsToFlicks(Math.max(0, end - start)) },
      action: 'solve',
      points: [],
      ...(focalLength && focalLength > 0 ? { focalLength } : {}),
    },
  };
}

export function groundPlaneJob(layer: string, points: readonly number[]): JobSpec {
  return { kind: 'cameraTrack', value: { layer, range: { start: 0, duration: 0 }, action: 'groundPlane', points: [...points] } };
}

export function trackPointLayersJob(layer: string, points: readonly number[], create: TrackPointLayer): JobSpec {
  return { kind: 'cameraTrack', value: { layer, range: { start: 0, duration: 0 }, action: 'createLayers', points: [...points], create } };
}

/** The layer's stored solve, or null. */
export async function loadCameraSolve(client: Pick<EngineClient, 'query'>, layer: string): Promise<CameraSolveData | null> {
  try {
    const res = await client.query({ type: 'getCameraSolve', layer });
    return res.ok ? res.value.solve ?? null : null;
  } catch {
    return null;
  }
}

/** The solved frame nearest `time` (composition seconds), within half a frame at 24 fps. */
function frameAt(solve: CameraSolveData, time: number): CameraSolveData['frames'][number] | null {
  let best: CameraSolveData['frames'][number] | null = null;
  let bestD = Infinity;
  for (const f of solve.frames) {
    const d = Math.abs(flicksToSeconds(f.time) - time);
    if (d < bestD) {
      bestD = d;
      best = f;
    }
  }
  return best && bestD <= 0.021 ? best : null;
}

/** The solve's points projected onto the footage at `time` (those in front of the camera and inside the frame). Pure. */
export function projectTrackPoints(solve: CameraSolveData, time: number): ProjectedTrackPoint[] {
  const f = frameAt(solve, time);
  if (!f || f.rotation.length !== 9) return [];
  const R = f.rotation;
  const cx = solve.sourceWidth / 2;
  const cy = solve.sourceHeight / 2;
  const out: ProjectedTrackPoint[] = [];
  solve.points.forEach((p, index) => {
    const dx = p.x - f.center.x;
    const dy = p.y - f.center.y;
    const dz = p.z - f.center.z;
    const xc = R[0]! * dx + R[1]! * dy + R[2]! * dz;
    const yc = R[3]! * dx + R[4]! * dy + R[5]! * dz;
    const zc = R[6]! * dx + R[7]! * dy + R[8]! * dz;
    if (zc <= 1e-9) return;
    const x = (solve.focal * xc) / zc + cx;
    const y = (solve.focal * yc) / zc + cy;
    if (x < 0 || y < 0 || x > solve.sourceWidth || y > solve.sourceHeight) return;
    out.push({ index, x, y, error: solve.pointErrors[index] ?? 0 });
  });
  return out;
}
