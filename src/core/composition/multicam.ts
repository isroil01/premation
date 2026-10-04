/**
 * Multicam — stack synced video angles in one comp and cut by opacity.
 *
 * What exists: N footage assets → one composition of full-frame layers, only
 * one angle at 100% opacity; a cut at the playhead writes hold keyframes;
 * `alignMulticamByAudio` cross-correlates the angles' soundtracks and shifts
 * their clip bars into sync (the Premiere "synchronize by audio" gesture);
 * the Multicam Viewer (layout/Multicam) shows every angle and cuts on click.
 *
 * Still not Premiere Multicam: no nested multicam sequence object, no
 * per-angle flattening. The cut list IS the opacity hold keyframes.
 */

export const MULTICAM_ANGLE_PROP = '__multicamAngle';

export interface MulticamSyncReport {
  /** Angles whose bars moved. */
  shifted: number;
  /** Per-angle outcome, angle order. */
  angles: Array<{ angle: number; name: string; offsetSec: number; score: number; note?: string }>;
  /** Human-readable summary for a toast. */
  note: string;
}
