/**
 * A footage layer's subject TRACKING — the Subjects panel's lanes (the
 * approved Subjects Pro design, board 4). Each subject's stored matte frames
 * come from the engine (`getSubjectTracks`): when they are, how sure the
 * tracker was of each (0–1) and which are FIXES (the user's own selection or
 * edit, or a frame a walk was prompted on).
 *
 * From them: the spans worth a second look ("Frames to review": consecutive
 * frames under the confidence threshold), and the fixes either side of a time
 * (a fix re-tracks the frames between its neighbours, nothing else).
 */

import { flicksToSeconds } from '@motion/engine-api';
import { engine } from '@core/engine/engineInstance';

/** One stored matte frame of a subject, composition seconds. `confidence` absent = not measured. */
export interface TrackFrame {
  time: number;
  confidence?: number;
  fix: boolean;
}

export interface SubjectTrack {
  subject: string;
  frames: TrackFrame[];
}

/** A run of consecutive frames the tracker was unsure of: first and last frame times, and the lowest confidence in it. */
export interface ReviewSpan {
  start: number;
  end: number;
  lowest: number;
}

/** Under this a tracked frame is flagged for review. */
export const REVIEW_BELOW = 0.5;

/** The layer's subjects with their frames, in panel order (empty when the layer has none). */
export async function fetchSubjectTracks(nodeId: string): Promise<SubjectTrack[]> {
  const res = await engine().query({ type: 'getSubjectTracks', layer: nodeId });
  if (!res.ok) return [];
  return res.value.subjects.map((s) => ({
    subject: s.subject,
    frames: s.frames.map((f) => ({
      time: flicksToSeconds(f.time),
      fix: f.fix,
      ...(f.confidence !== undefined ? { confidence: f.confidence } : {}),
    })),
  }));
}

/** Whether the subject was tracked (frames about every frame), not selected on one or a few frames. */
export function isTracked(frames: readonly TrackFrame[], fps: number): boolean {
  if (frames.length < 3) return false;
  const span = frames[frames.length - 1]!.time - frames[0]!.time;
  return span / (frames.length - 1) <= 1.5 / Math.max(1, fps);
}

/**
 * The low-confidence runs, in time order. Frames closer than 1.5 frames are
 * one run; a fix is never flagged (the user made it).
 */
export function reviewSpans(frames: readonly TrackFrame[], fps: number, below = REVIEW_BELOW): ReviewSpan[] {
  const gap = 1.5 / Math.max(1, fps);
  const out: ReviewSpan[] = [];
  let run: ReviewSpan | null = null;
  for (const f of frames) {
    const low = !f.fix && f.confidence !== undefined && f.confidence < below;
    if (low && run && f.time - run.end <= gap) {
      run.end = f.time;
      run.lowest = Math.min(run.lowest, f.confidence!);
      continue;
    }
    if (run) out.push(run);
    run = low ? { start: f.time, end: f.time, lowest: f.confidence! } : null;
  }
  if (run) out.push(run);
  return out;
}

/**
 * The fixes either side of `time` (half a frame counts as "at" it): what a
 * re-track from `time` is bounded by. Null = none that way.
 */
export function neighbourFixes(frames: readonly TrackFrame[], time: number, fps: number): { before: number | null; after: number | null } {
  const half = 0.5 / Math.max(1, fps);
  let before: number | null = null;
  let after: number | null = null;
  for (const f of frames) {
    if (!f.fix) continue;
    if (f.time < time - half) before = before === null ? f.time : Math.max(before, f.time);
    else if (f.time > time + half) after = after === null ? f.time : Math.min(after, f.time);
  }
  return { before, after };
}

/** The stored frame at `time` (within half a frame), if any. */
export function frameAt(frames: readonly TrackFrame[], time: number, fps: number): TrackFrame | undefined {
  const half = 0.5 / Math.max(1, fps);
  return frames.find((f) => Math.abs(f.time - time) <= half);
}

/**
 * The range a re-track from `time` walks: from the frame after the previous
 * fix to the frame before the next one, inside the tracked frames' span — so
 * every other fix, and every frame beyond them, stays as it is.
 */
export function retrackRange(frames: readonly TrackFrame[], time: number, fps: number): { start: number; end: number } | null {
  if (frames.length === 0) return null;
  const dt = 1 / Math.max(1, fps);
  const { before, after } = neighbourFixes(frames, time, fps);
  const start = Math.max(frames[0]!.time, before === null ? -Infinity : before + dt);
  const end = Math.min(frames[frames.length - 1]!.time, after === null ? Infinity : after - dt);
  if (end < start || time < start - dt / 2 || time > end + dt / 2) return null;
  return { start, end };
}
