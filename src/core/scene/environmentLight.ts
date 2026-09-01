/**
 * Environment Light — image-based lighting, compositor style.
 *
 * A tiny equirectangular environment (a preset gradient sky, or any image
 * downsampled to a few hundred pixels) is projected onto 9 spherical-harmonic
 * coefficients (Ramamoorthi/Hanrahan), and the SH irradiance field is then
 * EXPRESSED THROUGH THE EXISTING LIGHT PIPELINE as a derived rig:
 *
 *   • one ambient light carrying the per-channel FLOOR of the irradiance
 *     over the six axis directions (a uniform white environment therefore
 *     collapses to a single perfectly-constant ambient — no faceting), and
 *   • up to six parallel lights, one per axis whose irradiance EXCEEDS that
 *     floor, carrying only the deviation (sky-blue from above, warm ground
 *     bounce from below).
 *
 * Zero renderer changes: the rig rides the same 8-slot light array, the same
 * WGSL/GLSL shade tails, both Phong and PBR — which also means specular picks
 * up coloured environment highlights for free. The honest limitation: this is
 * a LOW-FREQUENCY approximation (an irradiance probe), not a reflection map —
 * mirror surfaces get coloured highlights, not mirrored scenery.
 *
 * Directions are in COMPOSITOR space (y down, +z away from the viewer), so
 * "up" is −y throughout. `rotationDeg` spins the environment about the
 * vertical axis and is keyframeable — an animated sky costs nothing.
 */

export interface EnvPixels {
  width: number;
  height: number;
  /** RGB triples, row-major, linear-ish 0..1+ (HDR values allowed). */
  data: Float32Array;
}

// ── Spherical harmonics (band 2, 9 coefficients × RGB) ───────────────

const Y00 = 0.282095;
const Y1 = 0.488603;
const Y2A = 1.092548; // xy, yz, xz
const Y20 = 0.315392; // (3z² − 1)
const Y22 = 0.546274; // (x² − y²)

// Cosine-lobe convolution (irradiance from radiance), ÷π folded in so the
// result is directly the Lambert multiplier for albedo.
const A0 = 1.0;
const A1 = 2.0 / 3.0;
const A2 = 0.25;

function basis(dir: { x: number; y: number; z: number }): number[] {
  const { x, y, z } = dir;
  return [
    Y00,
    Y1 * y, Y1 * z, Y1 * x,
    Y2A * x * y, Y2A * y * z, Y20 * (3 * z * z - 1), Y2A * x * z, Y22 * (x * x - y * y),
  ];
}

/**
 * Direction for an equirect pixel. φ sweeps around the VERTICAL axis
 * (compositor y); θ measures from "up" (−y). φ=0 faces +z (away from viewer).
 */
function equirectDir(u: number, v: number): { x: number; y: number; z: number } {
  const phi = u * Math.PI * 2;
  const theta = v * Math.PI;
  const s = Math.sin(theta);
  return { x: s * Math.sin(phi), y: -Math.cos(theta), z: s * Math.cos(phi) };
}

/** Project an equirect image onto SH9 (27 floats: 9 coefficients × RGB). */
export function shProject(px: EnvPixels): Float32Array {
  const sh = new Float32Array(27);
  let weightSum = 0;
  for (let j = 0; j < px.height; j++) {
    const v = (j + 0.5) / px.height;
    const sinTheta = Math.sin(v * Math.PI);
    for (let i = 0; i < px.width; i++) {
      const u = (i + 0.5) / px.width;
      const d = equirectDir(u, v);
      const b = basis(d);
      const o = (j * px.width + i) * 3;
      const r = px.data[o]!, g = px.data[o + 1]!, bl = px.data[o + 2]!;
      for (let k = 0; k < 9; k++) {
        const w = b[k]! * sinTheta;
        sh[k * 3] = sh[k * 3]! + r * w;
        sh[k * 3 + 1] = sh[k * 3 + 1]! + g * w;
        sh[k * 3 + 2] = sh[k * 3 + 2]! + bl * w;
      }
      weightSum += sinTheta;
    }
  }
  // Normalise so the projection approximates ∫ L·Y dΩ over the 4π sphere.
  const norm = (4 * Math.PI) / Math.max(1e-9, weightSum);
  for (let k = 0; k < 27; k++) sh[k] = sh[k]! * norm;
  return sh;
}

/** Irradiance ÷ π at a normal — the diffuse multiplier a Lambert surface sees. */
export function shIrradiance(sh: Float32Array, dir: { x: number; y: number; z: number }): [number, number, number] {
  const b = basis(dir);
  const a = [A0, A1, A1, A1, A2, A2, A2, A2, A2];
  const out: [number, number, number] = [0, 0, 0];
  for (let k = 0; k < 9; k++) {
    const w = a[k]! * b[k]!;
    out[0] += sh[k * 3]! * w;
    out[1] += sh[k * 3 + 1]! * w;
    out[2] += sh[k * 3 + 2]! * w;
  }
  out[0] = Math.max(0, out[0]);
  out[1] = Math.max(0, out[1]);
  out[2] = Math.max(0, out[2]);
  return out;
}

// ── Derived light rig ────────────────────────────────────────────────

export interface EnvRigLight {
  kind: 'ambient' | 'parallel';
  /** #rrggbb. */
  color: string;
  /** Percent, matching the Light.intensity convention. */
  intensity: number;
  /** Parallel only: unit vector pointing TOWARD the light source (the side
   *  the energy arrives from), compositor space. */
  from?: { x: number; y: number; z: number };
}

const AXES: ReadonlyArray<{ x: number; y: number; z: number }> = [
  { x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 },
  { x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 },
  { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 },
];

function rotateY(d: { x: number; y: number; z: number }, deg: number): { x: number; y: number; z: number } {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  return { x: d.x * c + d.z * s, y: d.y, z: -d.x * s + d.z * c };
}

function toHexColor(rgb: [number, number, number], max: number): string {
  const h = (v: number): string =>
    Math.round(Math.max(0, Math.min(1, max > 1e-6 ? v / max : 0)) * 255).toString(16).padStart(2, '0');
  return `#${h(rgb[0])}${h(rgb[1])}${h(rgb[2])}`;
}

/**
 * The ambient-floor + axis-deviation rig for an SH environment.
 * `intensityPct` is the light layer's Intensity (100 = the image as-is);
 * `rotationDeg` spins the environment about the vertical axis.
 */
export function environmentRig(sh: Float32Array, intensityPct: number, rotationDeg: number): EnvRigLight[] {
  const gain = Math.max(0, intensityPct) / 100;
  if (gain <= 0) return [];
  // Sample irradiance along the (counter-rotated) axes: rotating the WORLD by
  // +θ equals sampling the environment at −θ.
  const E = AXES.map((axis) => shIrradiance(sh, rotateY(axis, -rotationDeg)));
  const floor: [number, number, number] = [
    Math.min(...E.map((e) => e[0])),
    Math.min(...E.map((e) => e[1])),
    Math.min(...E.map((e) => e[2])),
  ];
  const out: EnvRigLight[] = [];
  const floorMax = Math.max(floor[0], floor[1], floor[2]);
  if (floorMax > 1e-4) {
    out.push({ kind: 'ambient', color: toHexColor(floor, floorMax), intensity: floorMax * 100 * gain });
  }
  // Band-2 SH reconstructs a UNIFORM sky with ~1% directional ripple; a
  // deviation has to clear a RELATIVE bar before it earns a light, or a flat
  // white environment sprouts phantom parallels (seen in the unit test).
  const devCutoff = Math.max(0.02 * floorMax, 0.01);
  AXES.forEach((axis, i) => {
    const dev: [number, number, number] = [
      Math.max(0, E[i]![0] - floor[0]),
      Math.max(0, E[i]![1] - floor[1]),
      Math.max(0, E[i]![2] - floor[2]),
    ];
    const m = Math.max(dev[0], dev[1], dev[2]);
    if (m <= devCutoff) return;
    out.push({
      kind: 'parallel',
      color: toHexColor(dev, m),
      intensity: m * 100 * gain,
      from: axis,
    });
  });
  return out;
}

// ── Presets (procedural equirects; nothing stored but the id) ────────

export type EnvironmentPresetId = 'studio' | 'sky' | 'sunset';

export const ENVIRONMENT_PRESETS: ReadonlyArray<{ id: EnvironmentPresetId; label: string }> = [
  { id: 'studio', label: 'Studio (soft top light)' },
  { id: 'sky', label: 'Day sky (blue above, warm ground)' },
  { id: 'sunset', label: 'Sunset (warm west horizon)' },
];

const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Generate a preset's equirect pixels (32×16 is plenty for SH band 2). */
export function presetPixels(id: EnvironmentPresetId): EnvPixels {
  const width = 32, height = 16;
  const data = new Float32Array(width * height * 3);
  for (let j = 0; j < height; j++) {
    const v = (j + 0.5) / height; // 0 = up, 1 = down
    for (let i = 0; i < width; i++) {
      const u = (i + 0.5) / width;
      let r = 0, g = 0, b = 0;
      if (id === 'studio') {
        // Bright soft ceiling, mid walls, dim floor.
        const up = 1 - v;
        const l = 0.15 + 0.85 * Math.pow(up, 1.6);
        r = l; g = l; b = l;
      } else if (id === 'sky') {
        if (v < 0.55) {
          const t = v / 0.55; // zenith → horizon
          r = mix(0.18, 0.75, t); g = mix(0.35, 0.85, t); b = mix(0.95, 1.0, t);
        } else {
          const t = (v - 0.55) / 0.45; // horizon → ground
          r = mix(0.55, 0.32, t); g = mix(0.48, 0.27, t); b = mix(0.38, 0.2, t);
        }
      } else {
        // Sunset: warm band on one side of the horizon, cool sky, dark ground.
        const west = Math.max(0, Math.cos((u - 0.75) * Math.PI * 2)); // peak at u=0.75
        if (v < 0.5) {
          const t = v / 0.5;
          r = mix(0.25, 0.5, t) + 0.9 * west * t;
          g = mix(0.2, 0.3, t) + 0.35 * west * t;
          b = mix(0.55, 0.45, t) + 0.05 * west * t;
        } else {
          const t = (v - 0.5) / 0.5;
          r = mix(0.5, 0.12, t) + 0.4 * west * (1 - t);
          g = mix(0.3, 0.09, t) + 0.12 * west * (1 - t);
          b = mix(0.35, 0.1, t);
        }
      }
      const o = (j * width + i) * 3;
      data[o] = r; data[o + 1] = g; data[o + 2] = b;
    }
  }
  return { width, height, data };
}

/** Memoised SH per preset — projection is cheap but per-frame is silly. */
const presetShCache = new Map<EnvironmentPresetId, Float32Array>();
export function presetSh(id: EnvironmentPresetId): Float32Array {
  let sh = presetShCache.get(id);
  if (!sh) {
    sh = shProject(presetPixels(id));
    presetShCache.set(id, sh);
  }
  return sh;
}
