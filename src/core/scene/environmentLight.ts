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

/**
 * Generate a preset's equirect pixels.
 *
 * 32×16 is plenty for SH band 2 and is the DEFAULT for exactly that reason —
 * changing it would move every existing scene's derived light rig. The
 * specular prefilter asks for a bigger one (a mirror needs real detail), and
 * every preset is an analytic function of (u, v), so it resamples exactly
 * rather than being interpolated up from the probe grid.
 */
export function presetPixels(id: EnvironmentPresetId, width = 32, height = 16): EnvPixels {
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

// ── Real images: HDRI / equirect stills ──────────────────────────────

/**
 * The largest equirect the projector ever walks.
 *
 * Band-2 SH holds 9 coefficients; a 4K HDRI carries ~8M samples to fit them,
 * which is ~500× the work for a result that differs in the fourth decimal.
 * Everything is box-averaged down to this first — and averaging is the RIGHT
 * downsample here, because the projection is an integral: a box average is
 * exactly the partial sum it would have computed over that footprint.
 */
export const ENV_PROJECT_MAX_WIDTH = 256;
export const ENV_PROJECT_MAX_HEIGHT = 128;

/** sRGB electro-optical transfer — 8-bit files are ENCODED, not linear. */
function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export interface ShProjectEquirectOptions {
  /**
   * The samples are already LINEAR light. EXR float planes are (see
   * `@core/media/floatExr`); an 8-bit PNG/JPG is sRGB-encoded and has to be
   * linearised before it can be integrated, or the sky comes out washed out
   * and the ground bounce far too bright.
   *
   * Defaults to `true` for Float32Array input and `false` for 8-bit input,
   * which is the right guess for every path in this app.
   */
  isLinear?: boolean;
}

/**
 * Box-average an arbitrary equirect down to `outW × outH` LINEAR float RGB.
 *
 * Accepts interleaved RGB or RGBA (the stride is inferred from the length), in
 * either float linear or 8-bit sRGB. Box averaging is the right downsample for
 * both consumers: the SH projection is an integral (a box average is exactly
 * the partial sum it would have computed over that footprint), and the
 * specular prefilter is a convolution that starts from band-limited samples.
 */
export function resampleEquirect(
  pixels: Float32Array | Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  outWidth: number,
  outHeight: number,
  opts: ShProjectEquirectOptions = {},
): EnvPixels {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  const eightBit = !(pixels instanceof Float32Array);
  // 3 (RGB) or 4 (RGBA); anything else is a malformed buffer and is clamped to
  // 3 rather than read out of bounds.
  const stride = Math.max(3, Math.min(4, Math.floor(pixels.length / (w * h)) || 3));
  const isLinear = opts.isLinear ?? !eightBit;
  const scale = eightBit ? 1 / 255 : 1;

  const outW = Math.max(1, Math.min(Math.floor(outWidth), w));
  const outH = Math.max(1, Math.min(Math.floor(outHeight), h));
  const data = new Float32Array(outW * outH * 3);
  for (let j = 0; j < outH; j++) {
    const y0 = Math.floor((j * h) / outH);
    const y1 = Math.max(y0 + 1, Math.floor(((j + 1) * h) / outH));
    for (let i = 0; i < outW; i++) {
      const x0 = Math.floor((i * w) / outW);
      const x1 = Math.max(x0 + 1, Math.floor(((i + 1) * w) / outW));
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const o = (y * w + x) * stride;
          let cr = (pixels[o] ?? 0) * scale;
          let cg = (pixels[o + 1] ?? 0) * scale;
          let cb = (pixels[o + 2] ?? 0) * scale;
          // Linearise BEFORE averaging: averaging encoded values and decoding
          // afterwards is a different (and wrong) number.
          if (!isLinear) { cr = srgbToLinear(cr); cg = srgbToLinear(cg); cb = srgbToLinear(cb); }
          r += cr; g += cg; b += cb; n++;
        }
      }
      const o = (j * outW + i) * 3;
      data[o] = r / n; data[o + 1] = g / n; data[o + 2] = b / n;
    }
  }
  return { width: outW, height: outH, data };
}

/**
 * Project an arbitrary equirectangular image onto SH9.
 *
 * Accepts interleaved RGB or RGBA (the stride is inferred from the length), in
 * either float linear or 8-bit sRGB, and reuses {@link shProject} for the
 * integral itself so there is exactly one projector and not two.
 */
export function shProjectEquirect(
  pixels: Float32Array | Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  opts: ShProjectEquirectOptions = {},
): Float32Array {
  return shProject(resampleEquirect(
    pixels, width, height, ENV_PROJECT_MAX_WIDTH, ENV_PROJECT_MAX_HEIGHT, opts,
  ));
}

// ── Sky selection: a preset id, or `asset:<assetId>` ─────────────────

/**
 * What an environment light's `envPreset` prop may hold.
 *
 * ONE prop rather than a second `envAssetId` beside it, because the two would
 * otherwise be able to disagree (a preset id AND an asset id both set, with
 * nothing saying which wins) and every reader would have to invent the same
 * precedence rule. A prefixed string has exactly one meaning at a time, and
 * every document written before images existed keeps a bare preset id — so old
 * scenes read back byte-identical.
 */
export const ENV_ASSET_PREFIX = 'asset:';
export type EnvironmentSky = EnvironmentPresetId | `asset:${string}`;
/** The sky an environment light falls back to: unset, unknown, or unloadable. */
export const DEFAULT_ENVIRONMENT_PRESET: EnvironmentPresetId = 'studio';

export function isEnvironmentPresetId(v: unknown): v is EnvironmentPresetId {
  return v === 'studio' || v === 'sky' || v === 'sunset';
}

export function isEnvironmentSky(v: unknown): v is EnvironmentSky {
  return isEnvironmentPresetId(v) || (typeof v === 'string' && v.startsWith(ENV_ASSET_PREFIX));
}

/**
 * The asset id a sky names, or null when it names a procedural preset.
 *
 * An EMPTY string is a real state, distinct from null: "Image… was chosen but
 * no asset has been picked yet", which the inspector has to be able to display
 * without the menu snapping back to a preset.
 */
export function environmentSkyAssetId(sky: unknown): string | null {
  return typeof sky === 'string' && sky.startsWith(ENV_ASSET_PREFIX)
    ? sky.slice(ENV_ASSET_PREFIX.length)
    : null;
}

export function environmentSkyForAsset(assetId: string): EnvironmentSky {
  return `${ENV_ASSET_PREFIX}${assetId}`;
}

// ── Derived-rig cache, keyed the way the preset SH is ────────────────

/** assetId → its projected SH. Filled by whoever decodes the image. */
const assetShCache = new Map<string, Float32Array>();
/** Bumped whenever `assetShCache` changes, so the rig cache keys go stale. */
let assetShEpoch = 0;

const RIG_CACHE_MAX = 512;
const rigCache = new Map<string, readonly EnvRigLight[]>();

type EnvironmentAssetLoader = (assetId: string) => void;
let assetLoader: EnvironmentAssetLoader | null = null;

/**
 * Register the async decoder that turns an image asset into SH.
 *
 * The projection needs a decoded image, which needs the asset library and the
 * DOM — neither of which belongs in this module, and both of which would make
 * its unit tests drag half the app in. So the seam is a callback: the loader
 * (see `environmentImage.ts`) registers itself, and this module stays pure
 * maths plus two caches. With no loader registered an image sky simply falls
 * back to the default preset — which is also what a headless test wants.
 */
export function registerEnvironmentAssetLoader(fn: EnvironmentAssetLoader | null): void {
  assetLoader = fn;
}

export function setEnvironmentAssetSh(assetId: string, sh: Float32Array): void {
  assetShCache.set(assetId, sh);
  assetShEpoch++;
  rigCache.clear();
}

export function hasEnvironmentAssetSh(assetId: string): boolean {
  return assetShCache.has(assetId);
}

/** Drop one asset's projection (or all of them) — re-import, or a test. */
export function clearEnvironmentAssetSh(assetId?: string): void {
  if (assetId === undefined) assetShCache.clear();
  else assetShCache.delete(assetId);
  assetShEpoch++;
  rigCache.clear();
}

/**
 * The SH probe for a sky, preset or image.
 *
 * An image whose projection is not in hand yet kicks the loader once and
 * returns the default preset for THIS frame; when the decode lands,
 * `setEnvironmentAssetSh` invalidates the rig cache and the next frame picks
 * the real sky up. Never throws, never blocks — a missing or broken file
 * degrades to a neutral studio sky rather than to an unlit scene.
 */
export function environmentSh(sky: unknown): Float32Array {
  const assetId = environmentSkyAssetId(sky);
  if (assetId === null) {
    return presetSh(isEnvironmentPresetId(sky) ? sky : DEFAULT_ENVIRONMENT_PRESET);
  }
  const cached = assetShCache.get(assetId);
  if (cached) return cached;
  if (assetId !== '') assetLoader?.(assetId);
  return presetSh(DEFAULT_ENVIRONMENT_PRESET);
}

/**
 * The derived rig for a sky at a rotation and intensity — memoised.
 *
 * `presetSh` already keeps the PROJECTION off the per-frame path; this keeps
 * the six irradiance evaluations and the hex encoding off it too, which is
 * what makes an image sky (whose probe a keyframed rotation re-samples every
 * frame) cost the same as a preset one. Pure function, so the cache cannot
 * change what is rendered — only how often it is computed.
 */
export function environmentRigFor(
  sky: unknown,
  intensityPct: number,
  rotationDeg: number,
): readonly EnvRigLight[] {
  const key = `${String(sky)}|${intensityPct}|${rotationDeg}|${assetShEpoch}`;
  const hit = rigCache.get(key);
  if (hit) return hit;
  const rig = environmentRig(environmentSh(sky), intensityPct, rotationDeg);
  // Bounded: a keyframed rotation mints a key per frame, so this is a memo with
  // a ceiling, not a leak.
  if (rigCache.size >= RIG_CACHE_MAX) rigCache.clear();
  rigCache.set(key, rig);
  return rig;
}

// ── Specular environment map (image-based REFLECTIONS) ───────────────

/**
 * The SH rig above is an IRRADIANCE probe: it says how much light arrives at a
 * surface, not what the room looks like. A mirror needs the second thing, so
 * this builds a small prefiltered RADIANCE map beside it.
 *
 * ── Layout ──────────────────────────────────────────────────────────
 *
 * One RGBA8 2D texture: {@link ENV_SPEC_LEVELS} equirect levels stacked
 * VERTICALLY, every level the same {@link ENV_SPEC_WIDTH} x
 * {@link ENV_SPEC_HEIGHT}. An ATLAS rather than a mip chain because the
 * renderer's `writeTexture` uploads level 0 only — there is no per-mip upload
 * on either backend — and equal-sized levels make the shader's level -> v
 * maths one multiply instead of a per-level rect it would have to be told
 * about. Level i is prefiltered for roughness i/(LEVELS-1); the shader picks a
 * fractional level from the material's roughness and lerps its two neighbours,
 * which is `textureLod` done by hand.
 *
 * ── The approximation, stated plainly ───────────────────────────────
 *
 * A correct prefilter importance-samples the GGX lobe about each reflection
 * direction. This instead runs a SEPARABLE GAUSSIAN IN THE EQUIRECT DOMAIN
 * whose angular sigma is the lobe's alpha = roughness^2. It is right in the
 * three ways that matter — the blur is measured in ANGLE (the horizontal
 * kernel widens toward the poles by 1/sin(theta), so a band of sky blurs by
 * the same solid angle everywhere), it wraps in longitude, and it is monotone
 * in roughness — and wrong in one: the lobe is isotropic about R here, where a
 * real GGX lobe stretches at grazing angles. The visible cost is that a rough
 * metal seen edge-on reflects a slightly too-round blur. Two variance-matched
 * box passes stand in for the Gaussian, which is what keeps it O(pixels).
 *
 * ── Encoding ────────────────────────────────────────────────────────
 *
 * RGBA8 with a single `scale` and a square-root transfer: stored =
 * sqrt(v/scale), decoded = stored^2 * scale. The sqrt buys back the precision
 * 8 bits lose in the darks (where reflections mostly live) and `scale` carries
 * the HDR range of an EXR sky that a plain 0..1 store would clip. Nothing here
 * is sRGB — the texture uploads as raw data (`displayReferred` off), so the
 * shader reads exactly these numbers back.
 */
export const ENV_SPEC_WIDTH = 256;
export const ENV_SPEC_HEIGHT = 128;
/**
 * Roughness levels in the atlas. MUST equal the renderer's `ENV_SPEC_LEVELS`
 * (packages/renderer/src/pipeline/uniforms.ts), which is baked into the shader
 * text as a literal because WGSL has no way to read it from a uniform without
 * a dynamic loop. Pinned by a unit test rather than by comment alone.
 */
export const ENV_SPEC_LEVELS = 5;

export interface EnvSpecularMap {
  /**
   * Identity of the CONTENT — the sky it was built from plus the layout. The
   * renderer keys its GPU texture off this and re-uploads only when it
   * changes, so a keyframed rotation (a uniform) uploads nothing.
   */
  id: string;
  width: number;
  height: number;
  levels: number;
  /** Multiplier the shader applies after squaring the stored value. */
  scale: number;
  /** RGBA8, `levels` bands of `width` x `height` stacked top to bottom. */
  data: Uint8Array;
}

/**
 * Box radius (in samples) whose variance matches ONE of two passes summing to
 * `sigmaSamples` of standard deviation. A box of radius r has variance
 * ((2r+1)^2 - 1)/12; two of them add, so each carries sigma^2 / 2.
 */
function boxRadiusFor(sigmaSamples: number): number {
  if (!(sigmaSamples > 0)) return 0;
  return Math.max(0, Math.round((Math.sqrt(6 * sigmaSamples * sigmaSamples + 1) - 1) / 2));
}

/** One horizontal box pass with a per-row radius, WRAPPING in longitude. */
function boxRowsWrap(
  src: Float32Array,
  w: number,
  h: number,
  radiusOf: (row: number) => number,
): Float32Array {
  const out = new Float32Array(src.length);
  // Prefix sums over one row, so a window is a subtraction whatever its width.
  const pre = new Float32Array((w + 1) * 3);
  for (let j = 0; j < h; j++) {
    const base = j * w * 3;
    const r = Math.min(radiusOf(j), Math.floor(w / 2));
    if (r <= 0) { out.set(src.subarray(base, base + w * 3), base); continue; }
    pre[0] = 0; pre[1] = 0; pre[2] = 0;
    for (let i = 0; i < w; i++) {
      const o = base + i * 3;
      const p = (i + 1) * 3;
      pre[p] = pre[p - 3]! + src[o]!;
      pre[p + 1] = pre[p - 2]! + src[o + 1]!;
      pre[p + 2] = pre[p - 1]! + src[o + 2]!;
    }
    const t0 = pre[w * 3]!, t1 = pre[w * 3 + 1]!, t2 = pre[w * 3 + 2]!;
    const n = 2 * r + 1;
    // Whole revolutions the window makes, and what is left over. n can exceed
    // w (an even-width row at the pole radius covers the circle and one more),
    // which is why `full` exists at all rather than being assumed 0.
    const full = Math.floor(n / w);
    const rem = n % w;
    for (let i = 0; i < w; i++) {
      // Start of the window, brought into [0, w) — a whole-revolution shift
      // re-indexes the window, it does not enlarge it, so nothing is added
      // for one. (The first draft added a row total per shift here, which
      // multiplied a flat sky by four and broke energy conservation.)
      const a = ((i - r) % w + w) % w;
      let a0 = full * t0, a1 = full * t1, a2 = full * t2;
      const b = a + rem;
      if (b <= w) {
        a0 += pre[b * 3]! - pre[a * 3]!;
        a1 += pre[b * 3 + 1]! - pre[a * 3 + 1]!;
        a2 += pre[b * 3 + 2]! - pre[a * 3 + 2]!;
      } else {
        // Wrapped: the tail of the row plus the head of it.
        const c = b - w;
        a0 += (t0 - pre[a * 3]!) + pre[c * 3]!;
        a1 += (t1 - pre[a * 3 + 1]!) + pre[c * 3 + 1]!;
        a2 += (t2 - pre[a * 3 + 2]!) + pre[c * 3 + 2]!;
      }
      const o = base + i * 3;
      out[o] = a0 / n; out[o + 1] = a1 / n; out[o + 2] = a2 / n;
    }
  }
  return out;
}

/** One vertical box pass, CLAMPING at the poles (there is nothing past them). */
function boxColsClamp(src: Float32Array, w: number, h: number, radius: number): Float32Array {
  const r = Math.min(radius, h - 1);
  if (r <= 0) return src;
  const out = new Float32Array(src.length);
  const pre = new Float32Array((h + 1) * 3);
  for (let i = 0; i < w; i++) {
    pre[0] = 0; pre[1] = 0; pre[2] = 0;
    for (let j = 0; j < h; j++) {
      const o = (j * w + i) * 3;
      const p = (j + 1) * 3;
      pre[p] = pre[p - 3]! + src[o]!;
      pre[p + 1] = pre[p - 2]! + src[o + 1]!;
      pre[p + 2] = pre[p - 1]! + src[o + 2]!;
    }
    const top = i * 3;
    const bot = ((h - 1) * w + i) * 3;
    for (let j = 0; j < h; j++) {
      const lo = j - r;
      const hi = j + r + 1;
      const a = Math.max(0, lo);
      const b = Math.min(h, hi);
      // Clamp-to-edge: rows past a pole repeat the first / last row.
      const head = a - lo;
      const tail = hi - b;
      const n = (b - a) + head + tail;
      const o = (j * w + i) * 3;
      out[o] = (pre[b * 3]! - pre[a * 3]! + head * src[top]! + tail * src[bot]!) / n;
      out[o + 1] = (pre[b * 3 + 1]! - pre[a * 3 + 1]! + head * src[top + 1]! + tail * src[bot + 1]!) / n;
      out[o + 2] = (pre[b * 3 + 2]! - pre[a * 3 + 2]! + head * src[top + 2]! + tail * src[bot + 2]!) / n;
    }
  }
  return out;
}

/**
 * Blur an equirect by an ANGULAR sigma (radians), separably.
 *
 * The horizontal radius is PER ROW: one texel spans (2pi/w)*sin(theta) radians
 * of arc, so the kernel has to widen toward the poles to cover the same angle
 * — without that a uniform sky blurs into a bowtie. The vertical radius is
 * constant, because one texel is always pi/h.
 */
export function blurEquirectAngular(src: EnvPixels, sigmaRad: number): EnvPixels {
  const { width: w, height: h } = src;
  if (!(sigmaRad > 0)) return { width: w, height: h, data: src.data.slice() };
  const ry = boxRadiusFor((sigmaRad * h) / Math.PI);
  const rowRadius = (j: number): number => {
    const theta = ((j + 0.5) / h) * Math.PI;
    return boxRadiusFor((sigmaRad * w) / (2 * Math.PI * Math.max(Math.sin(theta), 1e-3)));
  };
  let d: Float32Array = src.data;
  d = boxRowsWrap(d, w, h, rowRadius);
  d = boxRowsWrap(d, w, h, rowRadius);
  d = boxColsClamp(d, w, h, ry);
  d = boxColsClamp(d, w, h, ry);
  return { width: w, height: h, data: d };
}

/** The roughness atlas level `level` is prefiltered for. */
export function envSpecularLevelRoughness(level: number): number {
  return ENV_SPEC_LEVELS > 1 ? level / (ENV_SPEC_LEVELS - 1) : 0;
}

/** Build the stacked, encoded atlas from a base equirect. */
export function buildEnvSpecularAtlas(base: EnvPixels, id: string): EnvSpecularMap {
  const w = base.width;
  const h = base.height;
  const levels: EnvPixels[] = [];
  for (let i = 0; i < ENV_SPEC_LEVELS; i++) {
    const r = envSpecularLevelRoughness(i);
    // sigma = the GGX alpha = roughness^2. Level 0 is alpha 0 — a mirror, left
    // exactly as it came in.
    levels.push(blurEquirectAngular(base, r * r));
  }
  let max = 0;
  for (const lv of levels) {
    for (let k = 0; k < lv.data.length; k++) if (lv.data[k]! > max) max = lv.data[k]!;
  }
  // A pitch-black sky still needs a positive scale, or the encode divides by 0.
  const scale = Math.max(1e-4, max);
  const data = new Uint8Array(w * h * ENV_SPEC_LEVELS * 4);
  let o = 0;
  for (const lv of levels) {
    for (let p = 0; p < w * h; p++) {
      for (let c = 0; c < 3; c++) {
        const v = Math.sqrt(Math.max(0, lv.data[p * 3 + c]!) / scale);
        data[o++] = Math.max(0, Math.min(255, Math.round(v * 255)));
      }
      data[o++] = 255;
    }
  }
  return { id, width: w, height: h * ENV_SPEC_LEVELS, levels: ENV_SPEC_LEVELS, scale, data };
}

/**
 * assetId -> its downsampled LINEAR equirect, kept beside the SH so the
 * specular prefilter needs no second decode. Filled by the same loader that
 * fills `assetShCache` (see environmentImage.ts).
 */
const assetPixelCache = new Map<string, EnvPixels>();

export function setEnvironmentAssetPixels(assetId: string, px: EnvPixels): void {
  assetPixelCache.set(assetId, px);
  specularCache.clear();
}

export function hasEnvironmentAssetPixels(assetId: string): boolean {
  return assetPixelCache.has(assetId);
}

/** Drop one asset's cached equirect (or all of them) — a re-import, or a test. */
export function clearEnvironmentAssetPixels(assetId?: string): void {
  if (assetId === undefined) assetPixelCache.clear();
  else assetPixelCache.delete(assetId);
  specularCache.clear();
}

/** The base equirect a sky REFLECTS — a preset, or a decoded image. */
export function environmentEquirect(sky: unknown): EnvPixels {
  const assetId = environmentSkyAssetId(sky);
  if (assetId !== null) {
    const px = assetPixelCache.get(assetId);
    if (px) return px;
    if (assetId !== '') assetLoader?.(assetId);
    // Same degradation as `environmentSh`: a sky whose image has not landed
    // reflects the default studio room for this frame, never nothing.
    return presetPixels(DEFAULT_ENVIRONMENT_PRESET, ENV_SPEC_WIDTH, ENV_SPEC_HEIGHT);
  }
  return presetPixels(
    isEnvironmentPresetId(sky) ? sky : DEFAULT_ENVIRONMENT_PRESET,
    ENV_SPEC_WIDTH,
    ENV_SPEC_HEIGHT,
  );
}

/** sky key -> its atlas. One entry per sky the project uses. */
const specularCache = new Map<string, EnvSpecularMap>();
const SPECULAR_CACHE_MAX = 8;

/**
 * The prefiltered reflection map for a sky, memoised.
 *
 * Depends on the SKY ALONE — intensity and rotation are shader uniforms — so a
 * keyframed environment rebuilds nothing and re-uploads nothing. The cache key
 * carries the layout too, so changing the atlas dimensions cannot serve a
 * stale shape to a shader that expects the new one.
 */
export function environmentSpecularMap(sky: unknown): EnvSpecularMap {
  const assetId = environmentSkyAssetId(sky);
  // An image sky with no pixels yet IS the default preset this frame; keying
  // it under its own id would cache the fallback under the image's name and
  // never rebuild once the decode landed.
  const resolved = assetId !== null && !assetPixelCache.has(assetId) ? DEFAULT_ENVIRONMENT_PRESET : sky;
  const key = `${String(resolved)}|${ENV_SPEC_WIDTH}x${ENV_SPEC_HEIGHT}x${ENV_SPEC_LEVELS}`;
  const hit = specularCache.get(key);
  if (hit) return hit;
  const map = buildEnvSpecularAtlas(environmentEquirect(sky), key);
  if (specularCache.size >= SPECULAR_CACHE_MAX) specularCache.clear();
  specularCache.set(key, map);
  return map;
}
