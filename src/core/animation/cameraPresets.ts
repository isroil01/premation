/**
 * CAMERA moves — presets that animate the composition's 3D camera.
 *
 * Same shape as the other shipped arrays, with one gate the library did not
 * need before: `requires: 'camera'`. A camera preset keyframes props only a
 * camera layer reads (`orbitYaw`, `focalLength`, camera-space `z`), so applied
 * to a rectangle it would either do nothing or — worse, since `z` is in
 * `THREE_D_PROPS` — flip the layer's 3D switch and shove it through depth.
 * `applyPreset` refuses non-camera targets outright, and the panel greys the
 * row out with the reason, exactly as text presets do on a shape.
 *
 * ## How the values stay right on any rig
 *
 * Every track is `relative` — offsets from wherever the camera already is —
 * because a camera, unlike a fresh layer, is never at a neutral origin: it sits
 * at `z = -focalLength` (comp plane 1:1; see camera3d.ts), and its focal length
 * scales with the comp width (`defaultCamera` derives it from a ~40° FOV, so
 * f ≈ 1.39 × compW). Absolute values would teleport the rig; offsets nudge it.
 *
 * Dolly DISTANCES are measured in `compW` for the same reason the focal length
 * is: the default viewing distance is proportional to the comp width, so a push
 * authored as a fraction of it covers the same fraction of the distance to the
 * subject in a 720p comp and a 4K one. (`compMin` — `z`'s capture default — is
 * the right reference for a LAYER travelling through depth, but a CAMERA's
 * geometry is set by its lens, and the lens is set by the width.)
 *
 * Orbit and orientation stay `abs`: 8° of yaw is 8° in any comp.
 */

import {  type Keyframe } from '@motion/animation';
import type { AnimationPreset } from './animationPresets';

const FOLDER = 'Camera';

/** Same curve as the main library's SMOOTH_EASE — a camera move should feel
 *  operated, and an un-eased dolly reads as a zoom scrub. */
const SMOOTH: [number, number, number, number] = [0.4, 0, 0.2, 1];

const kfb = (t: number, value: number, bezier?: [number, number, number, number]): Keyframe => ({
  t,
  value,
  ...(bezier ? { easing: 'bezier' as const, bezier } : {}),
});

/**
 * A deterministic wiggle, SAMPLED into keyframes rather than installed as an
 * expression. Handheld is a texture the editor will want to retime, trim and
 * lay other keyframes over; ordinary keyframes give them that, where a
 * `wiggle()` behaviour never ends and never lands back at rest.
 *
 * Two incommensurate sine frequencies so the motion never visibly repeats
 * inside its window, and an envelope that tapers both ends to zero — the
 * offsets are relative, so a wiggle that ended off-axis would leave the camera
 * permanently askew after its last keyframe.
 */
function wiggleKeyframes(amp: number, f1: number, f2: number, phase: number): Keyframe[] {
  const T = 4;
  const STEP = 0.4;
  const out: Keyframe[] = [];
  for (let i = 0; i * STEP <= T + 1e-9; i++) {
    const t = i * STEP;
    const env = Math.min(1, t / 0.6, (T - t) / 0.6);
    const v = amp * env * (Math.sin(t * f1 + phase) + 0.5 * Math.sin(t * f2 + phase * 2.7));
    out.push(kfb(Number(t.toFixed(2)), Number(v.toFixed(4)), t < T ? SMOOTH : undefined));
  }
  return out;
}

export const CAMERA_PRESETS: ReadonlyArray<AnimationPreset> = [
  {
    name: 'Push In',
    builtin: true,
    folder: FOLDER,
    category: FOLDER,
    requires: 'camera',
    description: 'Slow dolly toward the scene — a quarter of the way in, eased.',
    tracks: [
      // z increases toward 0 (toward the plane). 0.33 compW ≈ 24% of the
      // default viewing distance (f ≈ 1.39 compW) — committed, not violent.
      { prop: 'z', relative: true, unit: 'compW', keyframes: [kfb(0, 0, SMOOTH), kfb(3, 0.33)] },
    ],
  },
  {
    name: 'Pull Out',
    builtin: true,
    folder: FOLDER,
    category: FOLDER,
    requires: 'camera',
    description: 'The reveal — dolly back away from the scene.',
    tracks: [
      { prop: 'z', relative: true, unit: 'compW', keyframes: [kfb(0, 0, SMOOTH), kfb(3, -0.33)] },
    ],
  },
  {
    name: 'Orbit Sweep',
    builtin: true,
    folder: FOLDER,
    category: FOLDER,
    requires: 'camera',
    description: 'A gentle arc around the point of interest, with a slight rise.',
    tracks: [
      // Orbit props are degrees about the POI — absolute units, relative
      // offsets, so a camera already parked at 20° sweeps 12° through 28°.
      { prop: 'orbitYaw', relative: true, keyframes: [kfb(0, -8, SMOOTH), kfb(4, 8)] },
      // The pitch peaks mid-sweep and settles — a crane breathing through the
      // arc rather than a second, competing move.
      { prop: 'orbitPitch', relative: true, keyframes: [kfb(0, 0, SMOOTH), kfb(2, 2.5, SMOOTH), kfb(4, 0)] },
    ],
  },
  {
    name: 'Drift Parallax',
    builtin: true,
    folder: FOLDER,
    category: FOLDER,
    requires: 'camera',
    description: 'Small lateral drift with a slight push — the move that shows layer depth.',
    tracks: [
      // Lateral travel is what separates the depth planes; the shallow push
      // keeps it from reading as a flat pan. Both fractions of the comp width,
      // both offsets from wherever the camera stands.
      { prop: 'x', relative: true, unit: 'compW', keyframes: [kfb(0, -0.03, SMOOTH), kfb(4, 0.03)] },
      { prop: 'z', relative: true, unit: 'compW', keyframes: [kfb(0, 0, SMOOTH), kfb(4, 0.1)] },
    ],
  },
  {
    name: 'Dolly Zoom (Vertigo)',
    builtin: true,
    folder: FOLDER,
    category: FOLDER,
    requires: 'camera',
    description: 'Dolly in while the lens zooms out — framing holds, the background falls away.',
    // Everything is computed from the camera's live z / focalLength inside the
    // applier (see above) — after applying, both tracks are ordinary keyframes.
    tracks: [],
    applier: 'dollyZoom',
  },
  {
    name: 'Handheld',
    builtin: true,
    folder: FOLDER,
    category: FOLDER,
    requires: 'camera',
    description: 'Subtle operator wobble — pan, tilt and a breath of dolly, baked as keyframes.',
    tracks: [
      // Orientation is the in-place pan/tilt (camera3d.ts) — the tripod head,
      // which is where handheld shake actually lives. Sub-degree amplitudes:
      // at the default lens 1° of pan is ~2.4% of the frame width.
      { prop: 'orientationX', relative: true, keyframes: wiggleKeyframes(0.55, 1.3, 2.9, 0.7) },
      { prop: 'orientationY', relative: true, keyframes: wiggleKeyframes(0.8, 0.9, 2.3, 2.1) },
      // A hair of dolly so the wobble has a third axis — 0.004 compW is ~8px
      // of travel in a 1080p comp's viewing distance.
      { prop: 'z', relative: true, unit: 'compW', keyframes: wiggleKeyframes(0.004, 1.1, 2.6, 4.2) },
    ],
  },
];

export default CAMERA_PRESETS;
