/**
 * The camera a screen-space AO buffer is measured from, and how big that buffer
 * is.
 *
 * ## Why the depth comes from the SHADOW caster shaders
 *
 * A depth-eligible 3D run draws into a MULTISAMPLED target, and neither backend
 * hands back a sampleable depth attachment from one: WebGPU cannot bind a
 * multisampled depth texture to an ordinary `texture_2d<f32>`, and WebGL2's
 * sampleable depth texture is legal only on a non-MSAA framebuffer — the
 * completeness rule the DOF gather work already paid for once. That is the
 * whole reason there is a prepass at all, and it is stated here rather than
 * discovered again.
 *
 * What the prepass writes is the linear distance `shadow-depth` already packs
 * 24-bit across rgb; only its axis and origin change. Point them at the CAMERA
 * instead of at a light and the number stored IS camera-space z — so SSAO reuses
 * the caster shaders, the caster materials and `packShadowDepth` verbatim, and
 * there is no second depth encoding for the two to drift apart on.
 *
 * ## Why the axis is read off the view matrix rather than off `eye`
 *
 * Because an ORTHO view has no eye. `camera3d.eye` is absent for the six axis
 * views (see FrameScene), and a feature that silently did nothing there would be
 * indistinguishable from one that was never built. Row 2 of the view matrix is
 * the camera's forward axis in both families, and the matrix's own translation
 * gives the point that axis measures from — which for a perspective camera is
 * exactly the eye, so the two agree where both exist.
 */

import { boxIsEmpty, type WorldBox } from './shadowMap';

/** Everything the prepass and the AO pass need about the viewing camera. */
export interface SsaoCamera {
  /** Unit forward axis of the camera — the direction depth is measured along. */
  axis: [number, number, number];
  /** World point depth is measured FROM (the eye, for a perspective camera). */
  origin: [number, number, number];
}

/**
 * The camera's depth measure, from its view matrix alone.
 *
 * A view matrix is `R · T(−origin)` with R orthonormal, so row 2 of R is the
 * forward axis and `m[14] = −dot(origin, axis)`. Recovering the origin as
 * `−m[14] · axis` gives A point on the camera's axis — not necessarily the eye
 * itself, and it does not have to be: every consumer uses only
 * `dot(p − origin, axis)`, which is invariant to sliding the origin sideways.
 */
export function ssaoCameraFor(view: readonly number[]): SsaoCamera {
  const ax = view[2] ?? 0;
  const ay = view[6] ?? 0;
  const az = view[10] ?? 1;
  const len = Math.hypot(ax, ay, az);
  const axis: [number, number, number] = len < 1e-9 ? [0, 0, 1] : [ax / len, ay / len, az / len];
  // The stored translation is in the ROTATED frame, so it scales with the same
  // normalisation the axis just took.
  const d = -(view[14] ?? 0) / (len < 1e-9 ? 1 : len);
  return { axis, origin: [axis[0] * d, axis[1] * d, axis[2] * d] };
}

/**
 * The far plane the prepass normalises against: the run's own extent along the
 * camera axis, with headroom.
 *
 * Fitted to the RUN rather than to a fixed constant for the reason a shadow
 * frustum is: the buffer holds 24 bits, and spending them across a hardcoded
 * 100 000 px far plane when the scene occupies 800 would leave contact
 * darkening below one quantisation step. The 1.25 headroom keeps real geometry
 * clear of the clear value (white ≈ 1.0), which the AO pass reads as "no
 * geometry here" and answers unoccluded for.
 */
export function ssaoFarFor(box: WorldBox, cam: SsaoCamera): number {
  if (boxIsEmpty(box)) return 0;
  let maxD = 0;
  for (let i = 0; i < 8; i++) {
    const x = ((i & 1) ? box.maxX : box.minX) - cam.origin[0];
    const y = ((i & 2) ? box.maxY : box.minY) - cam.origin[1];
    const z = ((i & 4) ? box.maxZ : box.minZ) - cam.origin[2];
    const d = x * cam.axis[0] + y * cam.axis[1] + z * cam.axis[2];
    if (d > maxD) maxD = d;
  }
  // A run entirely BEHIND the camera has nothing to occlude; a run straddling
  // the origin still needs a positive far, and the floor supplies it.
  return Math.max(1, maxD * 1.25);
}

/** Hemisphere samples per pixel, per quality. Both inside the shader's
 *  compile-time cap of 16 (see `SSAO_SAMPLE_CAP` in builtin.ts). */
export const SSAO_SAMPLES: Record<'half' | 'full', number> = { half: 12, full: 16 };

/**
 * Buffer size for a quality setting.
 *
 * 'half' is the default for the usual reason a half-res AO buffer is: AO is a
 * low-frequency term, the shader magnifies it through a LINEAR sampler on the
 * way back, and the estimate costs sixteen dependent texture reads per pixel —
 * so quartering the pixel count is very nearly quartering the cost of the
 * feature. 'full' exists for a still frame where the contact edge is the
 * subject.
 */
export function ssaoBufferSize(
  width: number,
  height: number,
  quality: 'half' | 'full',
): { width: number; height: number } {
  const s = quality === 'full' ? 1 : 2;
  return {
    width: Math.max(1, Math.floor(width / s)),
    height: Math.max(1, Math.floor(height / s)),
  };
}

/**
 * Clamp the authored radius to something a 24-bit depth buffer can resolve.
 *
 * In comp px, like every other spatial number the 3D path carries. The upper
 * bound is generous rather than physical: past roughly the run's own extent the
 * hemisphere reaches outside the buffer on every sample and the term degrades
 * to a uniform tint, which is not AO and reads as a lowered exposure.
 */
export function ssaoRadiusOf(requested: number | undefined): number {
  const r = Number.isFinite(requested) ? (requested as number) : 40;
  return Math.max(1, Math.min(2000, r));
}

/** Clamp the authored intensity. 0 is off (and the caller skips the passes
 *  entirely); 2 lets a flat ambient-only scene read as a solid without
 *  reaching for a second light. */
export function ssaoIntensityOf(requested: number | undefined): number {
  const v = Number.isFinite(requested) ? (requested as number) : 1;
  return Math.max(0, Math.min(2, v));
}
