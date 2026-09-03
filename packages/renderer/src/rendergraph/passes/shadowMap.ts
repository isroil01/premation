/**
 * The camera a shadow map is rendered from, and the world box it has to cover.
 *
 * ## One producer, two readers
 *
 * A shadow map is correct only while the CASTER pass and the RECEIVING shader
 * measure depth the same way. That is the whole of it: every classic shadow-map
 * artefact (a surface shadowing itself, a shadow detached from its caster, a
 * shadow that appears only on one backend) is those two measures disagreeing.
 *
 * So they are computed ONCE, here, and handed to both — `ShadowCamera.matrix`
 * rasterises the map and re-projects the receiver, and `axis`/`origin`/`invFar`
 * define the linear distance both stages store and compare. Nothing downstream
 * re-derives any of it.
 *
 * ## Why the projection puts z in [0, 1] on both backends
 *
 * WebGPU's clip volume is 0 ≤ z ≤ w; WebGL2's is −w ≤ z ≤ w. A GL-style
 * projection on WebGPU silently CLIPS everything in the near half of the
 * frustum. The reverse — a 0..1 projection on WebGL2 — clips nothing (0..w is
 * inside −w..w); it merely spends half the depth buffer's range, which costs
 * nothing here because the depth buffer only has to ORDER the casters. What is
 * actually read back is the packed linear distance in the colour attachment.
 *
 * ## Why the frustum is fitted to the whole run, not to the casters
 *
 * A receiver outside [0, 1] reads as LIT, so a far plane fitted to the casters
 * would put the floor they land on past it and no shadow would appear at all —
 * which is the failure that looks exactly like "shadows are not implemented".
 */

import { Mat4 } from '../../core/math/Mat4';

/** An axis-aligned world box, built up a point at a time. */
export interface WorldBox {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
}

export function emptyBox(): WorldBox {
  return {
    minX: Infinity, minY: Infinity, minZ: Infinity,
    maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity,
  };
}

export function boxIsEmpty(b: WorldBox): boolean {
  return !(b.maxX >= b.minX && b.maxY >= b.minY && b.maxZ >= b.minZ);
}

export function addPoint(b: WorldBox, x: number, y: number, z: number): void {
  if (x < b.minX) b.minX = x;
  if (y < b.minY) b.minY = y;
  if (z < b.minZ) b.minZ = z;
  if (x > b.maxX) b.maxX = x;
  if (y > b.maxY) b.maxY = y;
  if (z > b.maxZ) b.maxZ = z;
}

/** Add the eight corners of a local box mapped through a column-major mat4. */
export function addTransformedBox(
  b: WorldBox,
  model: readonly number[],
  lo: readonly [number, number, number],
  hi: readonly [number, number, number],
): void {
  for (let i = 0; i < 8; i++) {
    const x = (i & 1) ? hi[0] : lo[0];
    const y = (i & 2) ? hi[1] : lo[1];
    const z = (i & 4) ? hi[2] : lo[2];
    const w = model[3]! * x + model[7]! * y + model[11]! * z + model[15]!;
    const iw = Math.abs(w) < 1e-9 ? 1 : 1 / w;
    addPoint(
      b,
      (model[0]! * x + model[4]! * y + model[8]! * z + model[12]!) * iw,
      (model[1]! * x + model[5]! * y + model[9]! * z + model[13]!) * iw,
      (model[2]! * x + model[6]! * y + model[10]! * z + model[14]!) * iw,
    );
  }
}

/** Everything both stages of a shadow map need, in one object. */
export interface ShadowCamera {
  /** World → light CLIP, column-major. */
  matrix: Mat4;
  /** Unit forward axis of the light — the direction depth is measured along. */
  axis: readonly [number, number, number];
  /** World point depth is measured FROM. */
  origin: readonly [number, number, number];
  /** 1 / far: turns that distance into the map's stored 0..1 value. */
  invFar: number;
}

/** The light, as much of it as a shadow map cares about. */
export interface ShadowLight {
  type: 'ambient' | 'point' | 'spot' | 'parallel';
  x: number; y: number; z: number;
  aimX: number; aimY: number; aimZ: number;
}

function normalize(x: number, y: number, z: number): [number, number, number] {
  const l = Math.hypot(x, y, z);
  return l < 1e-9 ? [0, 0, 1] : [x / l, y / l, z / l];
}

/** A basis whose third axis is `f`, picking an up vector that is not parallel
 *  to it. Which up is chosen does not matter — the map is sampled through the
 *  same matrix that drew it — only that the basis is orthonormal. */
function basis(f: readonly [number, number, number]): {
  r: [number, number, number];
  u: [number, number, number];
} {
  const up: [number, number, number] = Math.abs(f[1]) > 0.99 ? [0, 0, 1] : [0, 1, 0];
  const r = normalize(
    up[1] * f[2] - up[2] * f[1],
    up[2] * f[0] - up[0] * f[2],
    up[0] * f[1] - up[1] * f[0],
  );
  const u = normalize(
    f[1] * r[2] - f[2] * r[1],
    f[2] * r[0] - f[0] * r[2],
    f[0] * r[1] - f[1] * r[0],
  );
  return { r, u };
}

/** World → light space, column-major (index = col·4 + row). */
function viewMatrix(
  eye: readonly [number, number, number],
  r: readonly [number, number, number],
  u: readonly [number, number, number],
  f: readonly [number, number, number],
): Mat4 {
  const dot = (a: readonly [number, number, number]) => a[0] * eye[0] + a[1] * eye[1] + a[2] * eye[2];
  return Mat4.fromArray([
    r[0], u[0], f[0], 0,
    r[1], u[1], f[1], 0,
    r[2], u[2], f[2], 0,
    -dot(r), -dot(u), -dot(f), 1,
  ]);
}

/** The eight corners of `b`, in light space. */
function cornersIn(
  b: WorldBox,
  eye: readonly [number, number, number],
  r: readonly [number, number, number],
  u: readonly [number, number, number],
  f: readonly [number, number, number],
): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  for (let i = 0; i < 8; i++) {
    const dx = ((i & 1) ? b.maxX : b.minX) - eye[0];
    const dy = ((i & 2) ? b.maxY : b.minY) - eye[1];
    const dz = ((i & 4) ? b.maxZ : b.minZ) - eye[2];
    out.push([
      r[0] * dx + r[1] * dy + r[2] * dz,
      u[0] * dx + u[1] * dy + u[2] * dz,
      f[0] * dx + f[1] * dy + f[2] * dz,
    ]);
  }
  return out;
}

/**
 * Fit a shadow camera to `box` for `light`, or null when the light cannot cast
 * a geometric shadow at all.
 *
 * Null for an AMBIENT light, which is the one honest answer: an ambient light
 * has no position and no direction, so it has no silhouette to project and no
 * axis to measure depth along. A POINT light gets the spot treatment along its
 * resolved aim — one frustum, not a cube map — so a point light shadows only
 * what lies roughly along the direction it points. Stated rather than hidden:
 * a real omni shadow needs six maps or a cube target, and neither this uniform
 * tail nor this single binding can carry one.
 */
export function shadowCameraFor(light: ShadowLight, box: WorldBox): ShadowCamera | null {
  if (light.type === 'ambient' || boxIsEmpty(box)) return null;
  const f = normalize(light.aimX, light.aimY, light.aimZ);
  const { r, u } = basis(f);
  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;
  const cz = (box.minZ + box.maxZ) / 2;
  const radius = Math.max(
    1,
    0.5 * Math.hypot(box.maxX - box.minX, box.maxY - box.minY, box.maxZ - box.minZ),
  );

  if (light.type === 'parallel') {
    // A directional light has no position, so the "eye" is placed one radius in
    // front of the run's bounding sphere along the axis. The box is then
    // entirely inside [0, 2·radius] in depth, which is the whole stored range.
    const eye: [number, number, number] = [
      cx - f[0] * radius * 1.5,
      cy - f[1] * radius * 1.5,
      cz - f[2] * radius * 1.5,
    ];
    const view = viewMatrix(eye, r, u, f);
    const pts = cornersIn(box, eye, r, u, f);
    let hw = 0;
    let hh = 0;
    for (const p of pts) {
      hw = Math.max(hw, Math.abs(p[0]));
      hh = Math.max(hh, Math.abs(p[1]));
    }
    // Square, so a rotated caster keeps the same texel density on both axes.
    const half = Math.max(1, Math.max(hw, hh) * 1.05);
    const far = radius * 3;
    const proj = Mat4.fromArray([
      1 / half, 0, 0, 0,
      0, 1 / half, 0, 0,
      0, 0, 1 / far, 0,
      0, 0, 0, 1,
    ]);
    return { matrix: Mat4.multiply(proj, view), axis: f, origin: eye, invFar: 1 / far };
  }

  // Spot and point: a perspective frustum from the light itself.
  const eye: [number, number, number] = [light.x, light.y, light.z];
  const view = viewMatrix(eye, r, u, f);
  const pts = cornersIn(box, eye, r, u, f);
  let maxTan = 0;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of pts) {
    if (p[2] < minZ) minZ = p[2];
    if (p[2] > maxZ) maxZ = p[2];
    // Corners behind the light contribute no angle — the frustum cannot reach
    // them and neither can the light.
    if (p[2] > 1e-3) maxTan = Math.max(maxTan, Math.abs(p[0]) / p[2], Math.abs(p[1]) / p[2]);
  }
  if (!(maxZ > 0)) return null; // the whole run is behind the light
  // Fitted to the run rather than to the light's CONE, deliberately: outside
  // the map the shader answers "lit", and outside the cone the light's own test
  // already answers "dark", so widening to the cone would only spend texels on
  // fragments that are black either way.
  const tan = Math.min(Math.max(maxTan * 1.05, 0.05), 12);
  const near = Math.max(1, Math.min(minZ, maxZ) * 0.5);
  const far = Math.max(near + 1, maxZ * 1.1);
  const proj = Mat4.fromArray([
    1 / tan, 0, 0, 0,
    0, 1 / tan, 0, 0,
    0, 0, far / (far - near), 1,
    0, 0, -(near * far) / (far - near), 0,
  ]);
  return { matrix: Mat4.multiply(proj, view), axis: f, origin: eye, invFar: 1 / far };
}

/** Clamp a requested shadow-map size to the three the UI offers. */
export function shadowMapSizeOf(requested: number | undefined): 512 | 1024 | 2048 {
  if (requested === undefined) return 1024;
  if (requested <= 640) return 512;
  if (requested <= 1400) return 1024;
  return 2048;
}
