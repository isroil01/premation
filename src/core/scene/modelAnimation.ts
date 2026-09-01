/**
 * glTF animation clips → ORDINARY engine keyframes.
 *
 * Because an imported model is plain layers (a 3D null per glTF node), a clip
 * doesn't need a playback runtime at all: each channel bakes onto the node's
 * own x/y/z / rotationX/rotationY/rotation / scaleX/Y/Z tracks at import.
 * The payoff is that a walk cycle is immediately a first-class citizen of the
 * editor — visible in the timeline, editable in the graph editor, retimable
 * with speed ramps, smoothable with The Smoother.
 *
 * The two conversions that can silently ruin a clip:
 *
 *   • ROTATION — glTF interpolates quaternions by slerp; euler tracks
 *     interpolate per-axis linearly. Baking only at the file's key times
 *     would cut slerp arcs into straight euler chords, so sparse rotation
 *     spans DENSIFY at ~15 samples/s (exports baked per-frame, like Mixamo,
 *     pass through untouched — their gaps are already smaller).
 *   • UNWRAPPING — quat→euler lands in (−180, 180], so a rotation crossing
 *     ±180° would snap back 360° between two keyframes. Every baked euler is
 *     unwrapped per axis toward its predecessor (nearest multiple of 360°).
 *
 * CUBICSPLINE channels use their value elements with linear easing between
 * keys — the in/out tangents are dropped for now (a visible simplification
 * only on hand-authored sparse spline curves; baked exports are unaffected).
 */

import type { GltfAnimation, GltfChannel } from '@core/media/gltf';
import type { Keyframe } from '@motion/animation';
import { gltfRotationToEulerDeg, gltfTranslationToLocal } from './modelMesh';

export interface BakedTrack {
  prop: string;
  keyframes: Keyframe[];
}

/** Max gap between rotation samples before the slerp arc is densified. */
const ROTATION_SAMPLE_STEP = 1 / 15;

type Quat = [number, number, number, number];

function slerp(a: Quat, b: Quat, t: number): Quat {
  let bx = b[0], by = b[1], bz = b[2], bw = b[3];
  let dot = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  // Shortest arc: q and −q are the same rotation.
  if (dot < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; dot = -dot; }
  if (dot > 0.9995) {
    // Nearly parallel — lerp + normalise.
    const out: Quat = [
      a[0] + (bx - a[0]) * t, a[1] + (by - a[1]) * t,
      a[2] + (bz - a[2]) * t, a[3] + (bw - a[3]) * t,
    ];
    const n = Math.hypot(...out) || 1;
    return [out[0] / n, out[1] / n, out[2] / n, out[3] / n];
  }
  const theta = Math.acos(Math.min(1, dot));
  const s = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / s;
  const wb = Math.sin(t * theta) / s;
  return [
    a[0] * wa + bx * wb, a[1] * wa + by * wb,
    a[2] * wa + bz * wb, a[3] * wa + bw * wb,
  ];
}

/** Nearest representative of `deg` in the winding of `prev` (unwrap ±360·k). */
function unwrapToward(deg: number, prev: number): number {
  let d = deg;
  while (d - prev > 180) d -= 360;
  while (prev - d > 180) d += 360;
  return d;
}

/** Value stride per key: CUBICSPLINE stores inTangent/value/outTangent. */
function valueAt(ch: GltfChannel, comps: number, key: number): number[] {
  const stride = ch.interpolation === 'CUBICSPLINE' ? comps * 3 : comps;
  const base = key * stride + (ch.interpolation === 'CUBICSPLINE' ? comps : 0);
  const out: number[] = [];
  for (let c = 0; c < comps; c++) out.push(ch.values[base + c] ?? 0);
  return out;
}

/** Bake one channel into engine tracks (times pass through in seconds).
 *  'weights' channels are baked by `bakeWeightTracks` (they need the target
 *  count, which lives on the mesh, not the channel) — skipped here. */
export function bakeChannelTracks(ch: GltfChannel): BakedTrack[] {
  const keyCount = ch.times.length;
  if (keyCount === 0 || ch.path === 'weights') return [];
  const easing = ch.interpolation === 'STEP' ? ('step' as const) : ('linear' as const);

  if (ch.path === 'translation' || ch.path === 'scale') {
    const props = ch.path === 'translation' ? ['x', 'y', 'z'] : ['scaleX', 'scaleY', 'scaleZ'];
    const tracks: Keyframe[][] = [[], [], []];
    for (let k = 0; k < keyCount; k++) {
      const t = ch.times[k]!;
      const v = valueAt(ch, 3, k);
      const conv = ch.path === 'translation'
        ? gltfTranslationToLocal([v[0]!, v[1]!, v[2]!])
        : { x: v[0]!, y: v[1]!, z: v[2]! };
      tracks[0]!.push({ t, value: conv.x, easing });
      tracks[1]!.push({ t, value: conv.y, easing });
      tracks[2]!.push({ t, value: conv.z, easing });
    }
    return props.map((prop, i) => ({ prop, keyframes: tracks[i]! }));
  }

  // rotation — collect (time, quat) samples, densifying slerp spans.
  const samples: Array<{ t: number; q: Quat }> = [];
  const quatAt = (k: number): Quat => {
    const v = valueAt(ch, 4, k);
    const n = Math.hypot(v[0]!, v[1]!, v[2]!, v[3]!) || 1;
    return [v[0]! / n, v[1]! / n, v[2]! / n, v[3]! / n];
  };
  for (let k = 0; k < keyCount; k++) {
    const t0 = ch.times[k]!;
    const q0 = quatAt(k);
    samples.push({ t: t0, q: q0 });
    if (ch.interpolation === 'STEP' || k === keyCount - 1) continue;
    const t1 = ch.times[k + 1]!;
    const gap = t1 - t0;
    if (gap <= ROTATION_SAMPLE_STEP * 1.5) continue;
    const q1 = quatAt(k + 1);
    const steps = Math.floor(gap / ROTATION_SAMPLE_STEP);
    for (let s = 1; s <= steps; s++) {
      const f = s / (steps + 1);
      samples.push({ t: t0 + gap * f, q: slerp(q0, q1, f) });
    }
  }

  const rx: Keyframe[] = [];
  const ry: Keyframe[] = [];
  const rz: Keyframe[] = [];
  let prev: { x: number; y: number; z: number } | null = null;
  for (const s of samples) {
    const e = gltfRotationToEulerDeg(s.q);
    const u: { x: number; y: number; z: number } = prev
      ? { x: unwrapToward(e.x, prev.x), y: unwrapToward(e.y, prev.y), z: unwrapToward(e.z, prev.z) }
      : e;
    rx.push({ t: s.t, value: u.x, easing });
    ry.push({ t: s.t, value: u.y, easing });
    rz.push({ t: s.t, value: u.z, easing });
    prev = u;
  }
  return [
    { prop: 'rotationX', keyframes: rx },
    { prop: 'rotationY', keyframes: ry },
    { prop: 'rotation', keyframes: rz },
  ];
}

/**
 * Bake a 'weights' channel into `morph0…morphN-1` tracks. The channel's value
 * stream is targetCount floats per key (3× that for CUBICSPLINE tangent
 * triples); the caller supplies targetCount from the mesh it targets.
 */
export function bakeWeightTracks(ch: GltfChannel, targetCount: number): BakedTrack[] {
  const keyCount = ch.times.length;
  if (keyCount === 0 || targetCount === 0 || ch.path !== 'weights') return [];
  const easing = ch.interpolation === 'STEP' ? ('step' as const) : ('linear' as const);
  const stride = ch.interpolation === 'CUBICSPLINE' ? targetCount * 3 : targetCount;
  const valueOffset = ch.interpolation === 'CUBICSPLINE' ? targetCount : 0;
  const tracks: Keyframe[][] = Array.from({ length: targetCount }, () => []);
  for (let k = 0; k < keyCount; k++) {
    const t = ch.times[k]!;
    for (let w = 0; w < targetCount; w++) {
      tracks[w]!.push({ t, value: ch.values[k * stride + valueOffset + w] ?? 0, easing });
    }
  }
  return tracks.map((keyframes, i) => ({ prop: `morph${i}`, keyframes }));
}

export interface BakedClip {
  name: string;
  /** glTF node index → its baked tracks. */
  byNode: Map<number, BakedTrack[]>;
  /** Clip length, seconds (last key across channels). */
  duration: number;
}

/** Bake a whole clip, grouped by target node. */
export function bakeClip(clip: GltfAnimation): BakedClip {
  const byNode = new Map<number, BakedTrack[]>();
  let duration = 0;
  for (const ch of clip.channels) {
    // Duration counts EVERY channel — a clip that is only morph weights (a
    // talking face) still has a length, even though its tracks bake elsewhere.
    const last = ch.times[ch.times.length - 1];
    if (last !== undefined && last > duration) duration = last;
    const tracks = bakeChannelTracks(ch);
    if (tracks.length === 0) continue;
    const list = byNode.get(ch.node) ?? [];
    list.push(...tracks);
    byNode.set(ch.node, list);
  }
  return { name: clip.name, byNode, duration };
}
