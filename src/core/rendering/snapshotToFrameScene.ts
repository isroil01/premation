/**
 * Pure adapter: RenderSnapshot (the app's immutable frame description) → the
 * @motion/renderer FrameScene DTO. buildSnapshot stays the single source of
 * frame data; this only reshapes it for the GPU renderer's input contract.
 *
 * Center-pivot note: RenderSnapshot layers are positioned by their CENTER and
 * rotate/scale about it (matching Canvas2DBackend). The renderer maps the unit
 * quad [0,1]² via a model matrix, so we compose translate·rotate·scale and then
 * shift by (-0.5,-0.5) so the quad's centre — not its corner — lands at (x,y).
 *
 * Known gaps vs Canvas2D (deferred to later prompts, flagged in the mapping):
 *   • shape ellipses / rounded corners  → renderer draws plain rects
 *   • text glyphs, image/video textures → white-texel until a real provider /
 *     asset pipeline exists; they render as tinted quads
 *   • RenderLayer.filter (a CSS string) is NOT read here — it only ever fed the
 *     deleted Canvas2D backend. Everything spatial (user effects, DOF blur,
 *     light-cast shadows) arrives as structured `layer.effects` entries, which
 *     extractSpatialEffects routes through the GPU effect passes.
 */

import { Mat3, Color, depthEligible3D, squareToQuad, isConvexQuad, isIdentityQuad, type BlendMode, type FrameScene, type FxVec4, type Renderable, type RenderableKind, type RenderableSdf, type Quad } from '@motion/renderer';
import { Matrix4Math } from '@motion/scene';
import type { LayerBlendMode } from '@core/effects/blendMode';
import { effectColorMatrix, applyColorMatrix, IDENTITY_COLOR_MATRIX } from '@core/effects/effectColorMatrix';
import { isLutEffect, buildChannelLut, sampleChannelLutAsUploaded, type ChannelLut } from '@core/effects/colorLut';
import type { Effect } from '@core/effects/effects';
import { readCubeLutParam } from '@core/effects/cubeLut';
import { readMatte } from '@core/effects/matte';
import { effectNumber, effectParam, paramsOf, withAlpha, isGpuOnlyEffect, effectHasOpacity, effectOpacityOf } from '@core/effects/effects';
import { deepGlowSettings } from '@core/effects/deepGlow';
import { beamPathRows, beamPathSettings, beamPathSpreadPx } from '@core/effects/beamPath';
import { layerIsBaked, cpuBakeStats } from '@core/effects/effectBake';
import { pushLayerError, errorMessage, type LayerError } from './layerErrors';
import { cornerPinInverse } from '@core/effects/distort';
import { hueOf } from '@core/effects/keyingEffects';
import { rgbToHsl as hslOf, luma as luma709 } from '@core/effects/colorSpace';
import { parseHex } from '@core/effects/canvas2dEffects';
import { polarConversion } from '@core/effects/distort';
import { COLORAMA_PALETTES } from '@core/effects/colorEffects';
import { defaultWarpPoints, isRestWarp } from '@core/effects/bezierWarp';
import type { WarpPoints } from '@core/effects/bezierWarp';
import { rgbToHsl } from '@core/effects/colorSpace';
import { layerHasOrderedPaint, rasterPadding } from './raster/vectorDraw';
import { hasPaintStrokes } from '@core/paint/paintRaster';
import type { RenderSnapshot, RenderLayer, RenderView } from './RenderBackend';

/**
 * Map a layer blend mode to the renderer's portable `BlendMode` union.
 *
 * Reachable only for `normal` and `add`. Every other mode composites through
 * BLEND_COMBINE, and `advancedBlendId() > 0` forces `blend: 'normal'` at each
 * call site — so the old "nearest family member" fallbacks (dodge→screen,
 * HSL→normal, …) described behaviour that had already stopped happening. Deleted
 * rather than left as a comment describing a dead path.
 */
export function layerBlendToGpu(mode: LayerBlendMode | undefined): BlendMode {
  return mode === 'add' ? 'add' : 'normal';
}

/**
 * Advanced blend-mode id for modes that need the backdrop as a shader input.
 * 0 = handled by the fixed-function `blend` path (normal / add only).
 *
 * Multiply/screen/darken/lighten are routed through the combine too, because the
 * fixed-function versions mishandle source alpha.
 *
 * These ids are a WIRE FORMAT between this file and two shader dialects. Never
 * renumber an existing id; only append. 1-11 separable, 12-15 non-separable HSL,
 * 16-26 separable (M1), 27-28 whole-colour compare (M1). The separable range is
 * deliberately NON-CONTIGUOUS, which is why the shader dispatches by family
 * rather than by a `>=` threshold — a threshold would sweep 16-26 into the
 * non-separable branch.
 */
function advancedBlendId(mode: LayerBlendMode | undefined): number {
  switch (mode) {
    case 'multiply': return 1;
    case 'screen': return 2;
    case 'overlay': return 3;
    case 'darken': return 4;
    case 'lighten': return 5;
    case 'color-dodge': return 6;
    case 'color-burn': return 7;
    case 'hard-light': return 8;
    case 'soft-light': return 9;
    case 'difference': return 10;
    case 'exclusion': return 11;
    case 'hue': return 12;
    case 'saturation': return 13;
    case 'color': return 14;
    case 'luminosity': return 15;
    // ── M1 ──
    case 'linear-burn': return 16;
    case 'linear-dodge': return 17;
    case 'linear-light': return 18;
    case 'vivid-light': return 19;
    case 'pin-light': return 20;
    case 'hard-mix': return 21;
    case 'subtract': return 22;
    case 'divide': return 23;
    case 'classic-color-burn': return 24;
    case 'classic-color-dodge': return 25;
    case 'classic-difference': return 26;
    case 'darker-color': return 27;
    case 'lighter-color': return 28;
    // ── M4 (Utility): these write alpha, handled past the composite line ──
    case 'alpha-add': return 29;
    case 'luminescent-premul': return 30;
    // ── M8c (Matte): these DISCARD the source colour and scale the backdrop ──
    case 'stencil-alpha': return 31;
    case 'stencil-luma': return 32;
    case 'silhouette-alpha': return 33;
    case 'silhouette-luma': return 34;
    // ── M5 (stochastic): coverage becomes a per-pixel coin flip. The shader
    // hashes the COMP-GRID pixel (comp size rides cr1.xy) so preview at any
    // zoom and export produce the same speckle. Dancing's re-roll comes from
    // `FrameScene.dissolveFrame` riding cr0.z — no clock in the shader. ──
    case 'dissolve': return 35;
    case 'dancing-dissolve': return 36;
    default: return 0; // normal / add → simple fixed-function blend
  }
}

const KIND_MAP: Record<RenderLayer['kind'], RenderableKind> = {
  shape: 'rect',
  text: 'text',
  image: 'image',
  video: 'video',
};

/**
 * Where the unit quad's origin sits, in UNIT space, once the anchor is folded in.
 *
 * Every matrix below bridges the renderer's [0,1]² unit quad to the layer's own
 * centred local pixels with `scale(W, H) · translate(−0.5, −0.5)`. The anchor is
 * a pivot expressed in those same local pixels, and the model the rest of the
 * app agrees on is
 *
 *     content_world = position + R·S·(local − anchor)
 *
 * (see `core/scene/anchor.ts`, which is the written definition, and
 * `core/workspace/ports.ts`, which builds the selection overlay's matrix from
 * it). Subtracting the anchor is therefore a shift of the bridge's translation
 * by −anchor/size — and because it rides INSIDE the layer's rotate/scale, the
 * anchor becomes the point the layer spins and scales about, which is the whole
 * feature.
 *
 * This was missing entirely. `buildSnapshot` has always threaded `anchorX`/
 * `anchorY` onto the RenderLayer, and `RenderBackend` has always documented them
 * as "content is shifted by −anchor so the anchor point sits at the pivot" — but
 * no matrix here ever read them, so on the unified GPU path the field was
 * write-only. The visible consequences: rotation and scale pivoted at the layer
 * centre no matter what the anchor said, Pan Behind's position compensation
 * moved the layer instead of holding it still, and the selection outline (which
 * DOES apply the anchor) sat exactly `−anchor` away from the artwork. That last
 * one is how the bug was found; the box was right and the render was wrong.
 *
 * Divides by the UNSCALED padded size on purpose: the bridge's scale term is
 * `W·scaleX`, so `−anchorX/W` lands a world shift of `−anchorX·scaleX`, which is
 * `R·S·(−anchor)` — the anchor is in the layer's own pre-scale pixels, exactly
 * as the Inspector shows it.
 */
function quadOrigin(layer: RenderLayer, pad: number): { x: number; y: number } {
  const W = layer.width + 2 * pad;
  const H = layer.height + 2 * pad;
  const ax = layer.anchorX ?? 0;
  const ay = layer.anchorY ?? 0;
  return {
    x: -0.5 - (W > 0 ? ax / W : 0),
    y: -0.5 - (H > 0 ? ay / H : 0),
  };
}

/** Affine scale: `0` is a real value (the layer must vanish), not “missing”.
 *  `|| 1` treated scale 0 as 1, so a text layer scaled to 0 still drew at
 *  its authored size. `??` is the right fallback — only undefined/null default. */
function affineScale(v: number | undefined): number {
  return v ?? 1;
}

/** Center-pivot model matrix: unit-quad centre → (x,y), rotated/scaled in place.
 *  The quad grows by the layer's raster padding so a stroked shape's padded
 *  texture (which includes the outer stroke band) places 1:1 without stretching;
 *  padding is 0 for unstroked shapes/text/image, so those are unaffected.
 *  The anchor rides in the quad's origin — see {@link quadOrigin}. */
function centerModel(layer: RenderLayer): Mat3 {
  const rad = (layer.rotation * Math.PI) / 180;
  const pad = rasterPadding(layer);
  const w = (layer.width + 2 * pad) * affineScale(layer.scaleX);
  const h = (layer.height + 2 * pad) * affineScale(layer.scaleY);
  const skew = layer.skew ?? 0;
  const base = skew === 0
    // The un-skewed path stays on `Mat3.compose` so nothing about existing
    // layers changes — skew is strictly additive.
    ? Mat3.compose(layer.x, layer.y, rad, w, h)
    : composeSkewed(layer.x, layer.y, rad, w, h, skew, layer.skewAxis ?? 0);
  const o = quadOrigin(layer, pad);
  // translate(x,y)·rotate·skew·scale(w,h) · translate(-0.5-ax/W, -0.5-ay/H)
  return Mat3.multiply(base, Mat3.translation(o.x, o.y));
}

/**
 * `Mat3.compose` with a shear folded in: T · R(rotation) · Skew · Scale.
 *
 * `skewAxis` rotates the axis the shear happens along, so a skew is not locked
 * to horizontal — the shear is conjugated by that rotation
 * (R(axis) · Shear · R(−axis)), which is what makes a 90° axis shear vertically
 * and everything between shear diagonally.
 *
 * Built by multiplying 2×2s rather than expanding a closed form: the closed
 * form for rotate·conjugated-shear·scale is four terms of mixed sines and
 * tangents, and getting one sign wrong there produces a layer that looks
 * plausible at small angles and inverts at large ones.
 */
function composeSkewed(
  tx: number,
  ty: number,
  rad: number,
  sx: number,
  sy: number,
  skewDeg: number,
  skewAxisDeg: number,
): Mat3 {
  // [a, b, c, d] with x' = a·x + c·y, y' = b·x + d·y
  type M2 = [number, number, number, number];
  const mul = (A: M2, B: M2): M2 => [
    A[0] * B[0] + A[2] * B[1],
    A[1] * B[0] + A[3] * B[1],
    A[0] * B[2] + A[2] * B[3],
    A[1] * B[2] + A[3] * B[3],
  ];
  const rot = (r: number): M2 => [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r)];
  const shear = (k: number): M2 => [1, 0, k, 1];

  const axis = (skewAxisDeg * Math.PI) / 180;
  // Clamped below ±89.5° — tan explodes at 90° and the layer would collapse to
  // an infinitely long streak.
  const k = Math.tan((Math.max(-89.5, Math.min(89.5, skewDeg)) * Math.PI) / 180);
  let m: M2 = rot(rad);
  m = mul(m, mul(rot(axis), mul(shear(k), rot(-axis))));
  m = mul(m, [sx, 0, 0, sy] as M2);

  const out = Mat3.create();
  out[0] = m[0]; out[1] = m[1]; out[2] = 0;
  out[3] = m[2]; out[4] = m[3]; out[5] = 0;
  out[6] = tx;   out[7] = ty;   out[8] = 1;
  return out;
}

/**
 * mat4 model for the GPU depth-tested 3D path: the layer's 4×4 world matrix
 * (local CENTERED pixels → 3D comp space) composed with the same w×h unit-quad
 * bridge the mat3 path uses — scale(W, H, 1) · translate(−0.5, −0.5, 0) — so
 * the unit quad's centre lands on the layer's anchor exactly like the affine
 * path. Do NOT drop the bridge: without it every 3D layer collapses to ~1px.
 *
 * `world3d` is composed with anchor {0, 0, anchorZ} (see buildSnapshot: "x/y are
 * applied at draw time"), so the X/Y anchor has to enter HERE — the bridge is
 * the draw-time step that comment refers to.
 */
function model3dFor(world3d: readonly number[], layer: RenderLayer): readonly number[] {
  const pad = rasterPadding(layer);
  const W = layer.width + 2 * pad;
  const H = layer.height + 2 * pad;
  const o = quadOrigin(layer, pad);
  const bridge: import('@motion/scene').Matrix4 = [
    W, 0, 0, 0,
    0, H, 0, 0,
    0, 0, 1, 0,
    o.x * W, o.y * H, 0, 1,
  ];
  return Matrix4Math.multiply(world3d as import('@motion/scene').Matrix4, bridge);
}

/** True when a Mat3 is (exactly) the identity — the top-level flatten parent. */
function isIdentityMat3(m: Mat3): boolean {
  return (
    m[0] === 1 && m[1] === 0 && m[2] === 0 &&
    m[3] === 0 && m[4] === 1 && m[5] === 0 &&
    m[6] === 0 && m[7] === 0 && m[8] === 1
  );
}

/**
 * May a layer flattened under `parentMatrix` keep its true-3D placement?
 *
 * `placement3d` is the 2D matrix the CAMERA it will be drawn through already
 * carries: absent = the host camera, which carries none (identity — the
 * legacy gate); a sealed comp's own camera carries the instance placement
 * (see `precompCamera3d`). The 3D model is in that camera's world, so the
 * layer's parent must be exactly that placement — any OTHER transform folded
 * into its mat3 is one the mat4 world never saw, and the layer keeps the
 * affine path. Exact comparison, like `isIdentityMat3`: an inline-collapsed
 * group carrier multiplies by an exact identity, so equal inputs stay equal.
 */
function threeDPlacementOk(parentMatrix: Mat3 | undefined, placement3d: Mat3 | undefined): boolean {
  if (!placement3d) return !parentMatrix || isIdentityMat3(parentMatrix);
  if (!parentMatrix) return isIdentityMat3(placement3d);
  for (let i = 0; i < 9; i++) if (parentMatrix[i] !== placement3d[i]) return false;
  return true;
}

/**
 * A sealed comp instance's own 3D frame, placed on the host.
 *
 * The isolated offscreen is viewport-sized and drawn with the host viewport's
 * 2D camera, i.e. in HOST comp px — while the inner camera's P·V outputs
 * homogeneous INNER comp px. `placement` (`precompChildParent`) is exactly the
 * inner px → host px map, and it is affine in x/y, so lifting it onto the
 * projection (lift(placement) · P) moves the homogeneous x/y without touching
 * z or w: depth order, the DOF depth row (projection[10]/[14]) and the
 * perspective divide are the inner camera's, unchanged. `view` and `eye` stay
 * in inner world space, which is where the children's models, the lights and
 * the shadow maps live.
 */
function precompCamera3d(
  own: NonNullable<RenderLayer['precompScene3d']>,
  placement: Mat3,
): Pick<NonNullable<Renderable['precomp']>, 'camera3d' | 'lights3d' | 'envMap'> {
  const a = placement[0]!, b = placement[1]!, c = placement[3]!, d = placement[4]!;
  const tx = placement[6]!, ty = placement[7]!;
  const lift: import('@motion/scene').Matrix4 = [
    a, b, 0, 0,
    c, d, 0, 0,
    0, 0, 1, 0,
    tx, ty, 0, 1,
  ];
  const projection = Matrix4Math.multiply(lift, own.camera3d.projection as import('@motion/scene').Matrix4);
  return {
    camera3d: { ...own.camera3d, projection },
    ...(own.lights3d && own.lights3d.length > 0 ? { lights3d: own.lights3d } : {}),
    ...(own.envMap ? { envMap: own.envMap } : {}),
  };
}

/** World-space AABB of the transformed unit quad, for the renderer's culling. */
/**
 * Corner Pin, resolved for the render.
 *
 * The pin is stored as four normalised [0,1] corners. `squareToQuad` turns them
 * into a projective homography; composing it AFTER the affine layer model
 * (`model · pin`) gives a projective render matrix that maps the unit quad onto
 * the pinned quad in world space. The shaders emit p.z as w, so the hardware
 * does the perspective divide and interpolates UVs correctly.
 *
 * Only the RENDER matrix becomes projective — the app-level affine `layer.matrix`
 * (what hit-test, gizmo, masks and snapping read) is untouched, honouring the
 * "separate stage" design. Returns null for no/degenerate pin so callers stay on
 * the affine path. `bounds` are the AABB of the pinned world corners (the affine
 * model applied to the corner points), so culling stays correct.
 */
function resolveCornerPin(
  cornerPin: RenderLayer['cornerPin'],
  model: Mat3,
): { pin: Mat3; renderModel: Mat3; bounds: { x: number; y: number; width: number; height: number } } | null {
  if (!cornerPin || cornerPin.length !== 8) return null;
  const quad: Quad = [
    { x: cornerPin[0], y: cornerPin[1] },
    { x: cornerPin[2], y: cornerPin[3] },
    { x: cornerPin[4], y: cornerPin[5] },
    { x: cornerPin[6], y: cornerPin[7] },
  ];
  if (isIdentityQuad(quad) || !isConvexQuad(quad)) return null;
  const pin = squareToQuad(quad);
  if (!pin) return null;
  const renderModel = Mat3.multiply(model, pin);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of quad) {
    const w = Mat3.transformPoint(model, c); // affine: exact pinned world corner
    minX = Math.min(minX, w.x); minY = Math.min(minY, w.y);
    maxX = Math.max(maxX, w.x); maxY = Math.max(maxY, w.y);
  }
  return { pin, renderModel, bounds: { x: minX, y: minY, width: maxX - minX, height: maxY - minY } };
}

function boundsOf(m: Mat3): { x: number; y: number; width: number; height: number } {
  const pts = [
    { x: m[6]!, y: m[7]! }, // (0,0)
    { x: m[0]! + m[6]!, y: m[1]! + m[7]! }, // (1,0)
    { x: m[3]! + m[6]!, y: m[4]! + m[7]! }, // (0,1)
    { x: m[0]! + m[3]! + m[6]!, y: m[1]! + m[4]! + m[7]! }, // (1,1)
  ];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Flat colour for the GPU SDF (non-textured) path: the layer's solid fill.
 *
 * `layer.fill` is the RESOLVED answer and the only one to read. buildSnapshot
 * already applies the whole precedence chain to it — Style fill, then a solid
 * `fillPaint` from the Fill & Stroke panel, then the animated `fill_r/_g/_b/_a`
 * channels on top — so re-consulting `fillPaint` here does not add information,
 * it discards the last step of that chain.
 *
 * Which is what it did: this used to return `p.color` whenever the paint was
 * solid, and essentially every shape carries a solid paint. So a keyframed fill
 * colour resolved correctly into `layer.fill`, reached this function, and was
 * thrown away for the stored paint — the shape rendered its authored colour at
 * every frame while the Inspector, the timeline and the snapshot all agreed it
 * was animating. The Canvas2D raster path never had the bug: `fillStyleFor`
 * returns its `fallback` (this same `layer.fill`) for a solid paint and only
 * builds a gradient otherwise. Two resolutions of one precedence rule.
 *
 * Gradient / multi-stop fills force a rasterized texture via needsShapeRaster,
 * so a non-solid paint never reaches the SDF path at all; `p.color` survives
 * only as the fallback for a layer that somehow carries a paint and no `fill`.
 */
function representativeColor(layer: RenderLayer): string {
  if (layer.fill) return layer.fill;
  const p = layer.fillPaint;
  return p && p.type === 'solid' ? p.color : '#000000';
}

/**
 * The composed per-channel table for an effect stack, memoised on the stack
 * ARRAY: an extrusion grades three or four ranges off one layer per frame, and
 * the snapshot hands each layer a fresh array, so this only ever saves the
 * repeats within a frame and never serves a stale table.
 */
const uniformLutCache = new WeakMap<ReadonlyArray<Effect>, ChannelLut | null>();
function uniformLutFor(effects: ReadonlyArray<Effect>): ChannelLut | null {
  let lut = uniformLutCache.get(effects);
  if (lut === undefined) {
    lut = buildChannelLut(effects);
    uniformLutCache.set(effects, lut);
  }
  return lut;
}

/**
 * A UNIFORM colour graded by the layer's colour effects on the CPU: the affine
 * matrix, then the per-channel LUT (Levels, Curves, Posterize, Exposure,
 * Lumetri, …) — the order the GPU runs them in on a textured layer, where
 * `lut-textured` remaps after the matrix whatever the stack order.
 *
 * The LUT is the SAME table `MotionRendererBackend` uploads as `lut:<id>`
 * (`buildChannelLut` over the stack), read the way the shader reads the strip
 * (`sampleChannelLutAsUploaded`). Before it ran here, a Levels reached only the
 * textured half of a layer: an extruded title's cap graded and its walls,
 * bevels and back cap did not, and a solid quad — 2D or 3D — ignored it
 * outright, because only textured renderables carry a `lutTextureKey`.
 */
function gradeUniformColor(layer: RenderLayer, base: Color): Color {
  if (!layer.effects || layer.effects.length === 0) return base;
  const cm = effectColorMatrix(layer.effects);
  let rgb = applyColorMatrix(cm, [base.r, base.g, base.b]);
  const lut = uniformLutFor(layer.effects);
  if (lut) rgb = sampleChannelLutAsUploaded(lut, rgb);
  return { r: rgb[0], g: rgb[1], b: rgb[2], a: base.a };
}

/** One mesh-range fill graded by the layer's colour effects — the per-range
 *  form of {@link gradedSolidColor}, for extruded walls / bevels / caps and
 *  untextured model ranges. */
function gradeFillByEffects(layer: RenderLayer, fill: string): Color {
  return gradeUniformColor(layer, Color.fromHex(fill));
}

/** The layer's solid fill graded by its colour effects (brightness/contrast/…,
 *  and any colour LUT), applied on the CPU since the colour is uniform. Spatial
 *  effects (blur/glow) are ignored here — they need offscreen passes. */
function gradedSolidColor(layer: RenderLayer): Color {
  return gradeUniformColor(layer, Color.fromHex(representativeColor(layer)));
}

/**
 * Adapt a resolved Glass style to the renderer's form: hex → Color, degrees →
 * radians.
 *
 * The renderer takes device px and radians and does no unit conversion of its
 * own, so this is the one place the conversion happens. Doing it in the shader
 * instead would put a `* PI / 180` in a per-fragment loop for no reason.
 */
function toRenderableGlass(
  g: NonNullable<RenderLayer['glass']>,
): import('@motion/renderer').RenderableGlass {
  const rad = (deg: number): number => (deg * Math.PI) / 180;
  return {
    refraction: g.refraction,
    edgeWidth: g.edgeWidth,
    aberration: g.chromaticAberration,
    saturation: g.saturation,
    tint: Color.fromHex(g.tintColor),
    tintOpacity: g.tintOpacity,
    rim: Color.fromHex(g.rimColor),
    rimOpacity: g.rimOpacity,
    rimWidth: g.rimWidth,
    rimAngle: rad(g.rimAngle),
    specularAngle: rad(g.specularAngle),
    specularIntensity: g.specularIntensity,
    specularFalloff: g.specularFalloff,
    grain: g.grain,
  };
}

/** SDF geometry for a shape layer so the GPU renderer draws real rounded-rects /
 *  ellipses (dimensions in the layer's local units, matching Canvas2DBackend:
 *  ellipse fills the box; a plain rect gets the same 12px rounded corners). Paths
 *  are deferred (rendered as a plain quad for now). */
/**
 * Corner radii are authored in COMPOSITION px, so the layer's scale has to be
 * divided out of them — see `RenderLayer.cornerRadiusScale`. The solid SDF
 * carries ONE radius, so it can only do that when the two axes agree;
 * `needsShapeRaster` sends the anisotropic case to Canvas2D, which can draw the
 * elliptical corner the compensation asks for.
 */
function uniformCornerScale(layer: RenderLayer): number | null {
  const cs = layer.cornerRadiusScale;
  if (!cs) return 1;
  if (Math.abs(cs[0] - cs[1]) > 1e-6) return null;
  return cs[0] > 1e-6 ? cs[0] : 1;
}

/** True when this layer's corners cannot be said with one radius. */
export function cornerRadiusNeedsRaster(layer: RenderLayer): boolean {
  if (uniformCornerScale(layer) !== null) return false;
  const radii = layer.cornerRadii;
  const biggest = radii ? Math.max(...radii) : (layer.cornerRadius ?? 0);
  return biggest > 0;
}

function sdfFor(layer: RenderLayer): RenderableSdf | undefined {
  if (layer.kind !== 'shape') return undefined;
  // A facet of a larger body tiles against its neighbours; SDF edge coverage
  // would make every join a dark hairline. See RenderLayer.flatFacet.
  if (layer.flatFacet) return undefined;
  if (layer.primitive === 'path') return undefined;
  if (layer.primitive === 'ellipse') {
    return { shape: 'ellipse', radiusPx: 0, width: layer.width, height: layer.height };
  }
  // Independent corners cannot use the isotropic GPU SDF — those shapes rasterize
  // via needsShapeRaster. When all four match, keep the fast SDF path.
  // Local px per comp px. Anisotropic layers never reach here (they rasterize),
  // so this is a single factor by construction.
  const k = 1 / (uniformCornerScale(layer) ?? 1);
  const radii = layer.cornerRadii;
  if (radii) {
    const [tl, tr, br, bl] = radii;
    if (tl === tr && tr === br && br === bl) {
      return { shape: 'rounded', radiusPx: tl * k, width: layer.width, height: layer.height };
    }
    return { shape: 'rounded', radiusPx: 0, width: layer.width, height: layer.height };
  }
  return { shape: 'rounded', radiusPx: (layer.cornerRadius ?? 0) * k, width: layer.width, height: layer.height };
}

// layerNeedsCpuBake is shared by needsShapeRaster and layerToRenderable, which
// must agree with Canvas2DVectorRasterizer about who owns the effect chain.
/**
 * @param onlyGpuOnly restrict the output to effects the CPU bake CANNOT draw
 *   (Displace, Motion Tile). For a baked layer: the bake owns everything else,
 *   so handing the GPU the full list would double-apply it — but these two have
 *   neither a CSS form nor a Canvas2D case, so the bake skips them and dropping
 *   them here too made them vanish entirely.
 */
/**
 * Exported for `pluginEffectSnapshot.test.ts`, which asserts what a plugin
 * effect does and — more importantly — does not emit. Driving it through
 * `snapshotToFrameScene` would need a whole snapshot to ask a question about
 * one effect, and the answer would be buried in a scene.
 */
export function extractSpatialEffects(
  layer: RenderLayer,
  onlyGpuOnly = false,
): import('@motion/renderer').RenderableEffect[] | undefined {
  if (!layer.effects || layer.effects.length === 0) return undefined;
  const spatial: import('@motion/renderer').RenderableEffect[] = [];
  // Compositing Options opacity rides the chain entry its effect emitted, and
  // the pass blends it back over its input (CompositionPass `fx-effect-opacity`).
  // Stamped once the effect's branch has run — at the top of the NEXT iteration
  // and after the loop, so every `continue` below still reaches it. Only a
  // single-entry effect is stamped; `effectsNeedCpuBake` keeps every other kind
  // of opacity-carrying effect on the CPU bake, and a baked layer's GPU list
  // (`onlyGpuOnly`) is left as it was.
  let owner: (typeof layer.effects)[number] | null = null;
  let ownerAt = 0;
  const stampOpacity = (): void => {
    const e = owner;
    owner = null;
    if (!e || onlyGpuOnly || !effectHasOpacity(e) || spatial.length - ownerAt !== 1) return;
    const entry = spatial[ownerAt]!;
    if (entry.type === 'plugin') return;
    const a = effectOpacityOf(e);
    // Held at 0 the blend is the identity; the bake skips the effect outright.
    if (a <= 0) spatial.length = ownerAt;
    // At 1 the blend is the output itself — no pass.
    // `effectOpacity`, never `opacity`: some entries already carry an `opacity`
    // of their own (Light Rays' ray strength), and a shared key made the pass
    // blend that parameter back as Compositing opacity — rays dimmed twice.
    else if (a < 1) spatial[ownerAt] = { ...entry, effectOpacity: a };
  };
  for (const e of layer.effects) {
    stampOpacity();
    if (e.enabled === false) continue;
    if (onlyGpuOnly && !isGpuOnlyEffect(e.type)) continue;
    owner = e;
    ownerAt = spatial.length;
    // Read each effect's own params. Glow's colour, Drop Shadow's angle and
    // Gradient Ramp's endpoints were hardcoded here and unreachable from the UI.
    const n = (k: string): number => effectNumber(e, k);
    const c = (k: string, alpha = 1): Color =>
      Color.fromHex(withAlpha(String(effectParam(e, k) ?? '#000000'), alpha));

    if (e.type === 'blur') {
      const blades = n('blades');
      const roundness = n('roundness');
      const highlightGain = n('highlightGain');
      // AE iris extras (camera DOF, via dofIrisParams): forwarded only at
      // non-neutral values so an untouched camera packs identical uniforms.
      const irisRotation = n('irisRotation');
      const irisAspect = n('irisAspect');
      const highlightThreshold = n('highlightThreshold');
      const highlightSaturation = n('highlightSaturation');
      const diffractionFringe = n('diffractionFringe');
      const params = paramsOf(e);
      const hasCoc = 'coc0' in params;
      const cocCorners = hasCoc
        ? [n('coc0'), n('coc1'), n('coc2'), n('coc3')] as [number, number, number, number]
        : undefined;
      const amount = cocCorners
        ? Math.max(n('amount'), ...cocCorners)
        : n('amount');
      spatial.push({
        type: 'blur',
        radiusPx: amount,
        ...(blades >= 3 ? { blades } : {}),
        ...(blades >= 3 && Number.isFinite(roundness) ? { roundness } : {}),
        ...(highlightGain > 0 ? { highlightGain } : {}),
        ...(blades >= 3 && Number.isFinite(irisRotation) && irisRotation !== 0
          ? { irisRotationDeg: irisRotation } : {}),
        ...(blades >= 3 && Number.isFinite(irisAspect) && irisAspect > 0 && irisAspect !== 1
          ? { irisAspect } : {}),
        ...(highlightThreshold > 0 ? { highlightThreshold } : {}),
        ...(highlightSaturation > 0 ? { highlightSaturation } : {}),
        ...(blades >= 3 && diffractionFringe > 0 ? { fringe: diffractionFringe } : {}),
        ...(cocCorners ? { cocCorners } : {}),
        // Camera-DOF blurs (buildSnapshot's `id: 'dof'`) are tagged so the
        // renderer can drop them for renderables it defocuses through the
        // per-pixel depth-buffer gather instead — applying both would blur
        // twice. Untagged blurs (the user's own Blur effect) always stand.
        ...(e.id === 'dof' ? { dofSource: true } : {}),
      });
    }
    if (e.type === 'glow') {
      const size = n('radius');
      const spread01 = Math.max(0, Math.min(1, n('spread') / 100));
      spatial.push({
        type: 'glow',
        radiusPx: size * (1 - spread01),
        ...(spread01 > 0 ? { spreadPx: size * spread01 } : {}),
        color: c('color', n('intensity') / 100),
      });
    }
    if (e.type === 'deep-glow') {
      const s = deepGlowSettings(e);
      if (s.radius > 0 || s.glowOnly) {
        spatial.push({
          type: 'deep-glow',
          radiusPx: s.radius,
          gain: s.gain,
          threshold: s.threshold,
          aspect: s.aspect,
          chroma: s.chroma,
          tint: s.tint,
          tintAmount: s.tintAmount,
          glowOnly: s.glowOnly,
          dither: s.dither,
          octaves: s.octaves,
        });
      }
    }
    if (e.type === 'drop-shadow') {
      const rad = (n('angle') * Math.PI) / 180;
      const size = n('softness');
      const spread01 = Math.max(0, Math.min(1, n('spread') / 100));
      spatial.push({
        type: 'drop-shadow',
        radiusPx: size * (1 - spread01),
        ...(spread01 > 0 ? { spreadPx: size * spread01 } : {}),
        offsetX: Math.cos(rad) * n('distance'),
        offsetY: Math.sin(rad) * n('distance'),
        color: c('color', n('opacity') / 100),
      });
    }
    if (e.type === 'gradient-ramp') {
      // The angle used to stop here: the pass hardcoded the ramp's endpoints to
      // the box diagonal, so the Gradient Ramp effect's Angle control — and the
      // Gradient Overlay layer style's, which compiles to it — moved nothing.
      spatial.push({ type: 'gradient-ramp', blend: n('blend') / 100, colorA: c('colorA'), colorB: c('colorB'), angle: n('angle') });
    }
    if (e.type === 'beam') {
      /*
        Percentages become FRACTIONS here, and the endpoints stay relative to
        the layer's box — the renderer resolves them against the chain's
        buffer, which is not the layer's box on the 2D route.

        `length` is AE's Time control: how far along the path the head has
        travelled. It is clamped here rather than in the shader because
        `applyBeam` clamps it too, and a value the two paths disagree about is
        the kind of difference that shows up as a beam of the wrong length on
        one backend only.
      */
      const clamp01n = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
      spatial.push({
        type: 'beam',
        startX: n('startX') / 100, startY: n('startY') / 100,
        endX: n('endX') / 100, endY: n('endY') / 100,
        length: clamp01n(n('length') / 100),
        thickness: Math.max(0.5, n('thickness')),
        softness: clamp01n(n('softness') / 100),
        color: c('color'),
      });
    }
    if (e.type === 'light-sweep') {
      const clamp01n = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
      spatial.push({
        type: 'light-sweep',
        // Keep −1..2 range — off-frame start/end is intentional.
        position: n('position') / 100,
        sweepWidth: Math.max(0, n('sweepWidth')),
        angle: n('angle'),
        softness: clamp01n(n('softness') / 100),
        intensity: clamp01n(n('intensity') / 100),
        composite: Math.round(n('composite')),
        color: c('color'),
      });
    }
    if (e.type === 'lens-flare') {
      const clamp01n = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
      spatial.push({
        type: 'lens-flare',
        centerX: n('centerX'),
        centerY: n('centerY'),
        brightness: clamp01n(n('brightness') / 100),
        scale: Math.max(0.05, n('scale')),
        color: c('color'),
      });
    }
    if (e.type === 'light-rays') {
      const clamp01n = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
      spatial.push({
        type: 'light-rays',
        centerX: n('centerX'),
        centerY: n('centerY'),
        rayCount: Math.max(1, Math.min(256, Math.round(n('rayCount')))),
        rayLength: Math.max(0, n('rayLength')),
        spread: clamp01n(n('spread') / 100),
        rotation: (n('rotation') * Math.PI) / 180,
        opacity: clamp01n(n('opacity') / 100),
        falloff: clamp01n(n('falloff') / 100),
        seed: Math.round(n('seed')),
        composite: Math.round(n('composite')),
        color: c('color'),
      });
    }
    // Colour helpers for the round-six ports: raw sRGB bytes (the CPU
    // kernels' own space) and a precomputed tint hue/sat.
    const hexTriple = (hex: string): [number, number, number] => parseHex(hex);
    const rgbToHslHs = (r: number, g: number, b: number): [number, number] => {
      const [hh, ss] = rgbToHsl(r, g, b);
      return [hh, ss];
    };
    // ── Round-six GPU ports: per-pixel colour passes ──
    // Parity contract: the maths (and its scalings) mirror the Canvas2D
    // wrappers byte-for-byte intent — percentages become fractions HERE, and
    // colours stay raw sRGB fractions because the CPU kernels work on sRGB.
    if (e.type === 'vignette') {
      const w = Math.max(1, layer.width || 1);
      const h = Math.max(1, layer.height || 1);
      spatial.push({
        type: 'vignette',
        amount: Math.max(-1, Math.min(1, n('amount') / 100)),
        inner: Math.max(0, Math.min(1, n('size') / 100)),
        feather: Math.max(1e-3, Math.min(1, n('feather') / 100)),
        roundness: Math.max(0, Math.min(1, n('roundness') / 100)),
        cx: 0.5 + n('centerX') / w,
        cy: 0.5 + n('centerY') / h,
        aspect: w / h,
      });
    }
    if (e.type === 'black-and-white') {
      const tintOn = effectParam(e, 'tint') === true;
      const [tr, tg, tb] = hexTriple(String(effectParam(e, 'tintColor') ?? '#d8b48a'));
      const [th, ts] = rgbToHslHs(tr, tg, tb);
      spatial.push({
        type: 'black-and-white',
        reds: n('reds') / 100, yellows: n('yellows') / 100, greens: n('greens') / 100,
        cyans: n('cyans') / 100, blues: n('blues') / 100, magentas: n('magentas') / 100,
        tintOn: tintOn ? 1 : 0, tintH: th, tintS: ts,
      });
    }
    if (e.type === 'tritone') {
      const [sr, sg, sb] = hexTriple(String(effectParam(e, 'shadows') ?? '#000000'));
      const [mr, mg, mb] = hexTriple(String(effectParam(e, 'midtones') ?? '#808080'));
      const [hr, hg, hb] = hexTriple(String(effectParam(e, 'highlights') ?? '#ffffff'));
      spatial.push({
        type: 'tritone',
        sr: sr / 255, sg: sg / 255, sb: sb / 255,
        mr: mr / 255, mg: mg / 255, mb: mb / 255,
        hr: hr / 255, hg: hg / 255, hb: hb / 255,
        blend: Math.max(0, Math.min(1, n('blend') / 100)),
      });
    }
    if (e.type === 'photo-filter') {
      const [pr, pg, pb] = hexTriple(String(effectParam(e, 'color') ?? '#ec8a00'));
      spatial.push({
        type: 'photo-filter',
        r: pr / 255, g: pg / 255, b: pb / 255,
        density: Math.max(0, Math.min(1, n('density') / 100)),
        preserveLuminosity: effectParam(e, 'preserveLuminosity') !== false,
      });
    }
    if (e.type === 'threshold') {
      spatial.push({ type: 'threshold', level: Math.max(0, Math.min(1, n('level') / 255)) });
    }
    if (e.type === 'vibrance') {
      spatial.push({ type: 'vibrance', vibrance: n('vibrance') / 100, saturation: n('saturation') / 100 });
    }
    // ── Round-six waves 2–3: warps + neighbourhood passes ──
    // Geometry stays in LAYER PIXELS with lw/lh riding along, mirroring each
    // Canvas2D wrapper's exact scalings (the CPU kernels are the reference).
    {
      const lw = Math.max(1, layer.width || 1);
      const lh = Math.max(1, layer.height || 1);
      if (e.type === 'mirror') {
        const mrad = (n('angle') * Math.PI) / 180;
        spatial.push({
          type: 'mirror',
          cx: lw / 2 + n('centerX'), cy: lh / 2 + n('centerY'),
          nx: Math.cos(mrad), ny: Math.sin(mrad), lw, lh,
        });
      }
      if (e.type === 'offset') {
        // "Shift centre TO" semantics — the kernel translates by how far the
        // requested centre is from the current one, not by the raw param.
        spatial.push({
          type: 'offset',
          tx: n('shiftX') - lw / 2, ty: n('shiftY') - lh / 2,
          keep: Math.max(0, Math.min(1, n('blend') / 100)), lw, lh,
        });
      }
      if (e.type === 'bulge') {
        spatial.push({
          type: 'bulge',
          cx: lw / 2 + n('centerX'), cy: lh / 2 + n('centerY'),
          radius: n('radius'), amount: n('height') / 100, lw, lh,
        });
      }
      if (e.type === 'twirl') {
        spatial.push({
          type: 'twirl',
          cx: lw / 2 + n('centerX'), cy: lh / 2 + n('centerY'),
          radius: n('radius'), maxAngle: (n('angle') * Math.PI) / 180, lw, lh,
        });
      }
      if (e.type === 'spherize') {
        spatial.push({
          type: 'spherize',
          cx: lw / 2 + n('centerX'), cy: lh / 2 + n('centerY'),
          radius: n('radius'), amount: n('amount') / 100, lw, lh,
        });
      }
      if (e.type === 'kaleidoscope') {
        const segN = Math.max(1, Math.min(64, Math.round(n('segments'))));
        spatial.push({
          type: 'kaleidoscope',
          cx: lw / 2 + n('centerX'), cy: lh / 2 + n('centerY'),
          rot: (n('rotation') * Math.PI) / 180, srcA: (n('sourceAngle') * Math.PI) / 180,
          seg: segN <= 1 ? 0 : (Math.PI * 2) / segN,
          scale: Math.max(0.01, n('zoom') / 100), lw, lh,
        });
      }
      if (e.type === 'ripple') {
        spatial.push({
          type: 'ripple',
          cx: lw / 2 + n('centerX'), cy: lh / 2 + n('centerY'),
          radius: n('radius') > 0 ? n('radius') : Math.hypot(lw, lh),
          amplitude: n('amplitude'), frequency: n('frequency'),
          phase: (n('phase') * Math.PI) / 180, decay: Math.max(0, n('decay')), lw, lh,
        });
      }
      if (e.type === 'chromatic-aberration') {
        const caRad = (n('angle') * Math.PI) / 180;
        const cax = lw / 2 + n('centerX');
        const cay = lh / 2 + n('centerY');
        spatial.push({
          type: 'chromatic-aberration',
          amount: n('amount'),
          linear: Math.round(n('aberrationMode')) === 1,
          lvx: Math.cos(caRad) * n('amount'), lvy: Math.sin(caRad) * n('amount'),
          falloffExp: 1 + (n('falloff') / 100) * 3,
          cx: cax, cy: cay,
          maxR: Math.max(1, Math.hypot(Math.max(cax, lw - cax), Math.max(cay, lh - cay))),
          lw, lh,
        });
      }
      if (e.type === 'magnify') {
        const mradius = n('radius');
        spatial.push({
          type: 'magnify',
          cx: lw / 2 + n('centerX'), cy: lh / 2 + n('centerY'),
          radius: mradius, scale: Math.max(0.01, n('magnification') / 100),
          square: Math.round(n('shape')) === 1,
          feather: Math.max(0, Math.min(n('feather'), mradius)), lw, lh,
        });
      }
      if (e.type === 'mosaic') {
        spatial.push({
          type: 'mosaic',
          cols: Math.max(1, Math.min(lw, Math.round(n('horizontalBlocks')))),
          rows: Math.max(1, Math.min(lh, Math.round(n('verticalBlocks')))),
          sharp: effectParam(e, 'sharpColors') === true, lw, lh,
        });
      }
      /*
        Round seven: the footage set — the effects a video layer most often
        carries, each of which forced a per-frame CPU bake of the whole frame.

        Gaussian Blur and Fast Box Blur ride the existing separable Gaussian
        pass. Their CPU kernels are iterated box blurs whose radius is spread
        over the passes (`blurRgba`: perPass = r/sqrt(n)), so the total variance
        is r^2/3 for any iteration count — the GPU sigma is r/sqrt(3) for both.
        `dims` (0 both, 1 horizontal, 2 vertical) selects the passes.
      */
      if (e.type === 'gaussian-blur' || e.type === 'fast-box-blur') {
        const r = Math.max(0, n(e.type === 'gaussian-blur' ? 'blurriness' : 'blurRadius'));
        if (r > 0) {
          const dimsRaw = Math.round(n('dimensions'));
          spatial.push({ type: e.type, radiusPx: r / Math.sqrt(3), dims: dimsRaw === 1 ? 1 : dimsRaw === 2 ? 2 : 0 });
        }
      }
      if (e.type === 'radial-blur') {
        const amount = n('amount');
        if (amount !== 0) {
          spatial.push({
            type: 'radial-blur',
            cx: lw / 2 + n('centerX'), cy: lh / 2 + n('centerY'),
            amount, zoom: Math.round(n('blurType')) === 1,
            steps: Math.max(2, Math.min(64, Math.round(n('quality') || 16))), lw, lh,
          });
        }
      }
      if (e.type === 'corner-pin') {
        const offs = [
          n('topLeftX'), n('topLeftY'), n('topRightX'), n('topRightY'),
          n('bottomRightX'), n('bottomRightY'), n('bottomLeftX'), n('bottomLeftY'),
        ];
        // All eight at rest is the identity — skipped, like the CPU pass, so a
        // freshly applied Corner Pin costs nothing and loses no sharpness.
        if (offs.some((v) => v !== 0)) {
          const inv = cornerPinInverse(lw, lh, [
            offs[0]!, offs[1]!, lw + offs[2]!, offs[3]!, lw + offs[4]!, lh + offs[5]!, offs[6]!, lh + offs[7]!,
          ]);
          // A degenerate quad has no inverse; the CPU draws nothing there, and
          // an all-zero matrix makes the shader do the same (den = 0).
          spatial.push({ type: 'corner-pin', m: inv ?? [0, 0, 0, 0, 0, 0, 0, 0, 0], lw, lh });
        }
      }
      if (e.type === 'transform') {
        const scale = Math.max(0, n('scale')) / 100;
        const rot = (n('rotation') * Math.PI) / 180;
        const px = n('positionX'); const py = n('positionY');
        const opacity = Math.max(0, Math.min(1, n('opacity') / 100));
        if (!(scale === 1 && rot === 0 && px === 0 && py === 0 && opacity === 1)) {
          spatial.push({ type: 'transform', px, py, scale, rot, opacity, lw, lh });
        }
      }
      /*
        Round eight: the keying set. Colours are decoded once here (bytes →
        display sRGB 0..1) and every derived constant the CPU kernel computes
        per call — channel layout, reference screen amount, key hue and luma,
        projected key — is computed once here too, so the fragment does only
        the per-pixel half.
      */
      if (e.type === 'keylight') {
        const key = parseHex(String(effectParam(e, 'screenColor') ?? '#00ff00'));
        const [kr, kg, kb] = key;
        // `channels()`: the dominant channel is the primary, the other two secondaries.
        let p = 0, a = 1, b = 2;
        if (kg >= kr && kg >= kb) { p = 1; a = 0; b = 2; }
        else if (kb >= kr && kb >= kg) { p = 2; a = 0; b = 1; }
        const balance = Math.max(0, Math.min(1, n('balance') / 100));
        const kv = [kr / 255, kg / 255, kb / 255];
        const sec = balance * Math.max(kv[a]!, kv[b]!) + (1 - balance) * Math.min(kv[a]!, kv[b]!);
        const ref = kv[p]! - sec;
        spatial.push({
          type: 'keylight',
          kr: kv[0]!, kg: kv[1]!, kb: kv[2]!, balance,
          gain: Math.max(0, n('gain') / 100),
          clipBlack: Math.max(0, Math.min(1, n('clipBlack') / 100)),
          clipWhite: Math.max(0, Math.min(1, n('clipWhite') / 100)),
          despill: Math.max(0, Math.min(1, n('despill') / 100)),
          p, a, b, denom: Math.abs(ref) < 1e-4 ? 1 : ref,
          chokePx: Math.sign(n('choke')) * Math.min(10, Math.round(Math.abs(n('choke')))),
          softPx: Math.min(25, Math.round(Math.max(0, n('matteSoftness')))),
          lw, lh,
        });
      }
      if (e.type === 'linear-color-key') {
        const key = parseHex(String(effectParam(e, 'keyColor') ?? '#00ff00'));
        spatial.push({
          type: 'linear-color-key',
          kr: key[0] / 255, kg: key[1] / 255, kb: key[2] / 255,
          mode: Math.round(n('matchOn')) === 1 ? 1 : Math.round(n('matchOn')) === 2 ? 2 : 0,
          tol: Math.max(0, Math.min(1, n('tolerance') / 100)),
          soft: Math.max(0, Math.min(1, n('softness') / 100)),
          keep: effectParam(e, 'keepMatched') === true,
          keyHue: hueOf(key[0], key[1], key[2]),
          keyLum: (0.299 * key[0] + 0.587 * key[1] + 0.114 * key[2]) / 255,
        });
      }
      if (e.type === 'luma-key') {
        spatial.push({
          type: 'luma-key',
          keyType: Math.max(0, Math.min(3, Math.round(n('keyType')))),
          cut: Math.max(0, Math.min(1, n('threshold') / 255)),
          tol: Math.max(0, n('tolerance') / 255),
          soft: Math.max(0, n('softness') / 255),
        });
      }
      if (e.type === 'color-key') {
        const key = parseHex(String(effectParam(e, 'keyColor') ?? '#00ff00'));
        spatial.push({
          type: 'color-key',
          kr: key[0] / 255, kg: key[1] / 255, kb: key[2] / 255,
          tol: Math.max(0, Math.min(1, n('tolerance') / 100)),
          soft: Math.max(0, Math.min(1, n('edgeSoftness') / 100)),
        });
      }
      if (e.type === 'color-range') {
        const key = parseHex(String(effectParam(e, 'keyColor') ?? '#00ff00'));
        const mode = Math.round(n('colorSpace'));
        const y = luma709(key[0], key[1], key[2]);
        const proj = mode === 2
          ? [key[0], key[1], key[2]]
          : mode === 1
            ? [y, (key[2] - y) * 0.565, (key[0] - y) * 0.713]
            : [y, (key[0] - key[1]) * 0.5, (key[1] - key[2]) * 0.5];
        const lo = Math.max(0, Math.min(1, n('minTolerance') / 100)) * 255;
        spatial.push({
          type: 'color-range',
          ky: proj[0]!, ku: proj[1]!, kv: proj[2]!, mode: mode === 1 ? 1 : mode === 2 ? 2 : 0,
          lo, hi: Math.max(lo + 1e-6, Math.max(0, Math.min(1, n('maxTolerance') / 100)) * 255),
          wl: Math.max(0, Math.min(1, n('lumaWeight') / 100)),
        });
      }
      if (e.type === 'extract') {
        spatial.push({
          type: 'extract',
          channel: Math.round(n('extractChannel')),
          black: n('blackPoint'), white: n('whitePoint'),
          blackSoft: n('blackSoftness'), whiteSoft: n('whiteSoftness'),
          invert: effectParam(e, 'invertExtract') === true,
        });
      }
      if (e.type === 'spill-suppressor') {
        const strength = Math.max(0, Math.min(1, n('amount') / 100));
        if (strength > 0) {
          const key = parseHex(String(effectParam(e, 'keyColor') ?? '#00ff00'));
          spatial.push({
            type: 'spill-suppressor',
            keyHue: hslOf(key[0], key[1], key[2])[0],
            strength,
            preserveLuma: effectParam(e, 'preserveLuma') !== false,
          });
        }
      }
      if (e.type === 'simple-choker') {
        const choke = n('chokeAmount');
        const radius = Math.round(Math.abs(choke));
        if (radius > 0) spatial.push({ type: 'simple-choker', radius, erode: choke > 0, lw, lh });
      }
      if (e.type === 'matte-choker') {
        const spread = Math.max(0, n('spread')); const choke = Math.max(0, n('choke')); const softness = Math.max(0, n('softness'));
        if (spread > 0 || choke > 0 || softness > 0) {
          spatial.push({
            type: 'matte-choker', spread, choke, softness,
            iterations: Math.max(1, Math.min(5, Math.round(n('iterations') || 1))), lw, lh,
          });
        }
      }
      if (e.type === 'wave-warp') {
        const height = n('waveHeight');
        const width = Math.max(2, n('waveWidth'));
        if (height !== 0) {
          const dir = (n('direction') * Math.PI) / 180;
          spatial.push({
            type: 'wave-warp',
            dx: Math.cos(dir), dy: Math.sin(dir),
            k: (Math.PI * 2) / width, phase: (n('phase') * Math.PI) / 180,
            height, lw, lh,
          });
        }
      }
      /*
        Round nine: the per-pixel colour, channel and transition set. Byte
        params stay in bytes where the kernel compares bytes (Alpha Levels);
        colours decode to 0..1; angles to radians; the HSL of every target
        colour is taken here once, as the kernels take it once per call.
      */
      if (e.type === 'directional-blur') {
        const length = Math.max(0, n('length'));
        if (length >= 1) {
          const rad = (n('direction') * Math.PI) / 180;
          spatial.push({ type: 'directional-blur', dx: Math.cos(rad), dy: Math.sin(rad), length, steps: Math.max(1, Math.min(64, Math.round(length))), lw, lh });
        }
      }
      if (e.type === 'linear-wipe') {
        const completion = Math.max(0, Math.min(100, n('completion'))) / 100;
        if (completion > 0) {
          const rad = (n('wipeAngle') * Math.PI) / 180;
          const span = Math.abs(lw * Math.cos(rad)) + Math.abs(lh * Math.sin(rad));
          spatial.push({
            type: 'linear-wipe', gx: Math.cos(rad), gy: Math.sin(rad),
            pos: -span / 2 + completion * span, soft: Math.max(Math.max(0, n('feather')), 0.01),
            full: completion >= 1, lw, lh,
          });
        }
      }
      if (e.type === 'shift-channels') {
        const src = (k: string): number => Math.max(0, Math.min(6, Math.round(n(k))));
        spatial.push({ type: 'shift-channels', a: src('takeAlphaFrom'), r: src('takeRedFrom'), g: src('takeGreenFrom'), b: src('takeBlueFrom') });
      }
      if (e.type === 'alpha-levels') {
        spatial.push({
          type: 'alpha-levels', inBlack: n('inBlack'), span: Math.max(1e-6, n('inWhite') - n('inBlack')),
          invGamma: 1 / Math.max(1e-3, n('gamma') || 1), outBlack: n('outBlack'), outWhite: n('outWhite'),
        });
      }
      if (e.type === 'solid-composite') {
        const col = parseHex(String(effectParam(e, 'solidColor') ?? '#000000'));
        spatial.push({
          type: 'solid-composite', cr: col[0] / 255, cg: col[1] / 255, cb: col[2] / 255,
          so: Math.max(0, Math.min(1, n('sourceOpacity') / 100)), co: Math.max(0, Math.min(1, n('solidOpacity') / 100)),
          mode: Math.round(n('compositeMode')),
        });
      }
      if (e.type === 'channel-combiner') {
        spatial.push({ type: 'channel-combiner', mode: Math.round(n('combinerMode')) });
      }
      if (e.type === 'remove-color-matting') {
        const strength = Math.max(0, Math.min(1, n('amount') / 100));
        if (strength > 0) {
          const bgc = parseHex(String(effectParam(e, 'backgroundColor') ?? '#000000'));
          spatial.push({ type: 'remove-color-matting', br: bgc[0] / 255, bg: bgc[1] / 255, bb: bgc[2] / 255, floor: Math.max(0, Math.min(1, n('threshold') / 100)), strength });
        }
      }
      if (e.type === 'change-color') {
        const tgt = parseHex(String(effectParam(e, 'targetColor') ?? '#ff0000'));
        const [th, ts, tl] = hslOf(tgt[0], tgt[1], tgt[2]);
        spatial.push({
          type: 'change-color', th, ts, tl,
          hT: Math.max(0, Math.min(1, n('hueTolerance') / 100)) * 0.5,
          sT: Math.max(0, Math.min(1, n('satTolerance') / 100)), lT: Math.max(0, Math.min(1, n('lightTolerance') / 100)),
          soft: Math.max(0, Math.min(1, n('softness') / 100)),
          hueShift: n('hueShift') / 360, satScale: n('satScale') / 100, lightScale: n('lightScale') / 100,
          invert: effectParam(e, 'invertSelection') === true,
        });
      }
      if (e.type === 'change-to-color') {
        const from = parseHex(String(effectParam(e, 'fromColor') ?? '#ff0000'));
        const to = parseHex(String(effectParam(e, 'toColor') ?? '#0055ff'));
        const [fh, fs, fl] = hslOf(from[0], from[1], from[2]);
        const [dh, ds, dl] = hslOf(to[0], to[1], to[2]);
        spatial.push({
          type: 'change-to-color', fh, fs, fl,
          hT: Math.max(0, Math.min(1, n('hueTolerance') / 100)) * 0.5,
          sT: Math.max(0, Math.min(1, n('satTolerance') / 100)), lT: Math.max(0, Math.min(1, n('lightTolerance') / 100)),
          soft: Math.max(0, Math.min(1, n('softness') / 100)),
          preserve: effectParam(e, 'preserveLightness') !== false, dh, ds, dl,
        });
      }
      if (e.type === 'leave-color') {
        const strength = Math.max(0, Math.min(1, n('amount') / 100));
        if (strength > 0) {
          const tgt = parseHex(String(effectParam(e, 'targetColor') ?? '#ff0000'));
          spatial.push({
            type: 'leave-color', th: hslOf(tgt[0], tgt[1], tgt[2])[0],
            tol: Math.max(0, Math.min(1, n('tolerance') / 100)) * 0.5, soft: Math.max(0, Math.min(1, n('softness') / 100)), strength,
          });
        }
      }
      if (e.type === 'toner') {
        const k = Math.max(0, Math.min(1, 1 - n('blend') / 100));
        if (k > 0) {
          const stops: number[] = [];
          for (const [key, dflt] of [['blackTone', '#000000'], ['shadowTone', '#2a2a45'], ['midTone', '#8a7a63'], ['highlightTone', '#e8d9b8'], ['whiteTone', '#ffffff']] as const) {
            const c3 = parseHex(String(effectParam(e, key) ?? dflt));
            stops.push(c3[0] / 255, c3[1] / 255, c3[2] / 255);
          }
          spatial.push({ type: 'toner', stops, k });
        }
      }
      if (e.type === 'venetian-blinds') {
        const t = Math.max(0, Math.min(1, n('completion') / 100));
        if (t > 0) {
          const rad = (n('direction') * Math.PI) / 180;
          const pitch = Math.max(1, n('width'));
          spatial.push({ type: 'venetian-blinds', cos: Math.cos(rad), sin: Math.sin(rad), pitch, half: (pitch * t) / 2, soft: Math.max(0, n('feather')), full: t >= 1, lw, lh });
        }
      }
      if (e.type === 'radial-wipe') {
        const t = Math.max(0, Math.min(1, n('completion') / 100));
        if (t > 0) {
          const TAU = Math.PI * 2;
          const dirRaw = n('wipe');
          const dir = dirRaw >= 2 ? 2 : dirRaw >= 1 ? 1 : 0;
          spatial.push({
            type: 'radial-wipe', cx: lw / 2 + n('centerX'), cy: lh / 2 + n('centerY'),
            start: ((n('startAngle') * Math.PI) / 180) % TAU, swept: (dir === 2 ? t / 2 : t) * TAU,
            dir, soft: Math.max(0, (n('feather') * Math.PI) / 180), lw, lh,
          });
        }
      }
      if (e.type === 'iris-wipe') {
        const invert = effectParam(e, 'invertIris') === true;
        const completion = n('completion');
        if (completion > 0 || invert) {
          const t = Math.max(0, Math.min(1, completion / 100));
          const cx = lw / 2 + n('centerX'); const cy = lh / 2 + n('centerY');
          const maxR = Math.hypot(Math.max(cx, lw - cx), Math.max(cy, lh - cy)) || 1;
          const outer = t * maxR;
          const useInner = effectParam(e, 'useInnerRadius') === true;
          spatial.push({
            type: 'iris-wipe', cx, cy, outer, inner: useInner ? Math.min(outer, n('innerRadius')) : 0,
            points: Math.round(n('irisPoints')), rot: (n('rotation') * Math.PI) / 180,
            feath: Math.max(1e-3, n('feather')), useInner, invert, lw, lh,
          });
        }
      }
      if (e.type === 'line-sweep') {
        const invert = effectParam(e, 'invertSweep') === true;
        const completion = n('completion');
        if (completion > 0 || invert) {
          const a = (n('angle') * Math.PI) / 180;
          spatial.push({
            type: 'line-sweep', nx: Math.cos(a), ny: Math.sin(a),
            n: Math.max(1, Math.min(512, Math.round(n('lineCount')))), stag: Math.max(0, Math.min(1, n('stagger') / 100)),
            feath: Math.max(1e-3, n('feather') / 100), t: Math.max(0, Math.min(1, completion / 100)), invert, lw, lh,
          });
        }
      }
      /*
        Round ten: separable neighbourhood passes and drawn generators.
        Box radii become Gaussian sigmas where the GPU reuses the Gaussian
        pass: one box pass of radius r has variance r(r+1)/3; three passes of
        r/√3 sum to r²/3 (see round seven).
      */
      if (e.type === 'channel-blur') {
        const rr = Math.max(0, Math.round(n('redBlurriness'))); const rg = Math.max(0, Math.round(n('greenBlurriness')));
        const rb = Math.max(0, Math.round(n('blueBlurriness'))); const ra = Math.max(0, Math.round(n('alphaBlurriness')));
        if (rr > 0 || rg > 0 || rb > 0 || ra > 0) {
          const dimsRaw = Math.round(n('dimensions'));
          spatial.push({ type: 'channel-blur', r: rr, g: rg, b: rb, a: ra, dims: dimsRaw === 1 ? 1 : dimsRaw === 2 ? 2 : 0, repeatEdge: effectParam(e, 'repeatEdge') === true, lw, lh });
        }
      }
      if (e.type === 'minimax') {
        const radius = Math.max(0, Math.round(n('radius')));
        if (radius > 0) {
          const ch = Math.round(n('channel'));
          const dirRaw = n('direction');
          spatial.push({
            type: 'minimax', op: Math.max(0, Math.min(3, Math.round(n('operation')))), radius,
            mask: ch === 1 ? 7 : ch === 2 ? 1 : ch === 3 ? 2 : ch === 4 ? 4 : 8,
            dir: dirRaw >= 2 ? 2 : dirRaw >= 1 ? 1 : 0, lw, lh,
          });
        }
      }
      if (e.type === 'unsharp-mask') {
        const amount = n('amount'); const radius = n('radius');
        if (amount > 0 && radius > 0) {
          spatial.push({ type: 'unsharp-mask', amount: amount / 100, threshold: Math.max(0, n('threshold')) / 255, sigmaPx: radius / Math.sqrt(3) });
        }
      }
      if (e.type === 'shadow-highlight') {
        const sa = n('shadowAmount') / 100; const ha = n('highlightAmount') / 100;
        if (sa !== 0 || ha !== 0) {
          const r = Math.max(0, n('radius'));
          spatial.push({ type: 'shadow-highlight', shadow: sa, highlight: ha, invWidth: 1 / Math.max(0.01, n('tonalWidth') / 100), sigmaPx: Math.sqrt((r * (r + 1)) / 3) });
        }
      }
      if (e.type === 'checkerboard') {
        const opacity = Math.min(1, n('opacity') / 100);
        if (opacity > 0) {
          const sizeW = Math.max(1, n('width')); const sizeH = Math.max(1, n('height'));
          const ax = n('anchorX'); const ay = n('anchorY');
          const unit = (c: readonly [number, number, number]): readonly [number, number, number] => [c[0] / 255, c[1] / 255, c[2] / 255];
          spatial.push({
            type: 'checkerboard', sizeW, sizeH,
            startX: -sizeW + (((ax % sizeW) + sizeW) % sizeW), startY: -sizeH + (((ay % sizeH) + sizeH) % sizeH),
            colA: unit(parseHex(String(effectParam(e, 'colorA') ?? '#000000'))), colB: unit(parseHex(String(effectParam(e, 'colorB') ?? '#ffffff'))),
            opacity, lw, lh,
          });
        }
      }
      if (e.type === 'grid') {
        const thickness = Math.max(0, n('thickness')); const opacity = Math.min(1, n('opacity') / 100);
        if (thickness > 0 && opacity > 0) {
          const pitchX = Math.max(1, n('width')); const pitchY = Math.max(1, n('height'));
          const gc = parseHex(String(effectParam(e, 'color') ?? '#ffffff'));
          spatial.push({
            type: 'grid', pitchX, pitchY,
            offX: ((n('anchorX') % pitchX) + pitchX) % pitchX, offY: ((n('anchorY') % pitchY) + pitchY) % pitchY,
            thickness, snap: Math.round(thickness) % 2 === 1 ? 0.5 : 0, opacity,
            color: [gc[0] / 255, gc[1] / 255, gc[2] / 255], lw, lh,
          });
        }
      }
      if (e.type === 'four-color-gradient') {
        const blend = Math.max(0, Math.min(1, n('blend') / 100));
        if (blend > 0) {
          const unit = (k: string, d: string): readonly [number, number, number] => { const c3 = parseHex(String(effectParam(e, k) ?? d)); return [c3[0] / 255, c3[1] / 255, c3[2] / 255]; };
          spatial.push({ type: 'four-color-gradient', tl: unit('colorTL', '#ff0000'), tr: unit('colorTR', '#00ff00'), bl: unit('colorBL', '#0000ff'), br: unit('colorBR', '#ffff00'), blend, lw, lh });
        }
      }
      if (e.type === 'circle') {
        const radius = Math.max(0, n('radius')); const opacity = Math.max(0, Math.min(1, n('opacity') / 100));
        if (radius > 0 && opacity > 0) {
          const cc = parseHex(String(effectParam(e, 'color') ?? '#ffffff'));
          spatial.push({
            type: 'circle', cx: lw / 2 + n('centerX'), cy: lh / 2 + n('centerY'), radius,
            feather: Math.max(0, Math.min(radius, n('feather'))), thickness: Math.max(0, n('thickness')), opacity,
            invert: effectParam(e, 'invertCircle') === true, composite: Math.round(n('composite')),
            color: [cc[0] / 255, cc[1] / 255, cc[2] / 255], lw, lh,
          });
        }
      }
      if (e.type === 'ellipse') {
        const rx = Math.max(0, n('ellipseWidth') / 2); const ry = Math.max(0, n('ellipseHeight') / 2);
        const opacity = Math.max(0, Math.min(1, n('opacity') / 100));
        if (rx > 0 && ry > 0 && opacity > 0) {
          const ec = parseHex(String(effectParam(e, 'color') ?? '#ffffff'));
          spatial.push({
            type: 'ellipse', cx: lw / 2 + n('centerX'), cy: lh / 2 + n('centerY'), rx, ry,
            rot: (n('rotation') * Math.PI) / 180, thickness: Math.max(0.5, n('thickness')), softness: Math.max(0, n('softness')), opacity,
            composite: Math.round(n('composite')), color: [ec[0] / 255, ec[1] / 255, ec[2] / 255], lw, lh,
          });
        }
      }
      /*
        Round eleven: the advanced distort / transition / stylize set. Each
        block mirrors its Canvas2D wrapper's early-outs and precomputes what
        the kernel precomputes, so the shader receives the kernel's own
        constants. A box radius r becomes a Gaussian sigma sqrt(r(r+1)/3).
      */
      const rad = (deg: number): number => (deg * Math.PI) / 180;
      const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
      const boxSigma = (r: number): number => (r > 0 ? Math.sqrt((r * (r + 1)) / 3) : 0);
      const unit3 = (k: string, d: string): readonly [number, number, number] => { const c3 = parseHex(String(effectParam(e, k) ?? d)); return [c3[0] / 255, c3[1] / 255, c3[2] / 255]; };
      if (e.type === 'polar-coordinates') {
        const interp = n('interpolation');
        if (interp > 0) spatial.push({ type: 'polar-coordinates', t: clamp01(interp / 100), conv: polarConversion(n('conversion')) === 'polar-to-rect' ? 1 : 0, lw, lh });
      }
      if (e.type === 'optics-compensation') {
        const fov = Math.max(0, Math.min(180, n('fieldOfView')));
        if (fov > 0) {
          spatial.push({
            type: 'optics-compensation', k: Math.tan((fov * Math.PI) / 360) * 0.5, reverse: effectParam(e, 'reverse') === true,
            cx: lw / 2 + n('centerX'), cy: lh / 2 + n('centerY'), norm: Math.hypot(lw / 2, lh / 2) || 1, lw, lh,
          });
        }
      }
      if (e.type === 'warp') {
        const bend = n('bend') / 100; const h = n('horizontalDistortion'); const v = n('verticalDistortion');
        if (bend !== 0 || h !== 0 || v !== 0) spatial.push({ type: 'warp', style: Math.round(n('style')), bend, h, v, vert: Math.round(n('warpAxis')) === 1, lw, lh });
      }
      if (e.type === 'page-turn') {
        const amount = n('amount');
        if (amount > 0) {
          const t = clamp01(amount / 100); const a = rad(n('angle')); const nx = Math.cos(a); const ny = Math.sin(a);
          const diag = Math.abs(lw * nx) + Math.abs(lh * ny);
          spatial.push({
            type: 'page-turn', nx, ny, foldAt: (1 - t) * diag - (lw * nx + lh * ny) / 2, rad: Math.max(1, n('curlRadius')),
            backA: clamp01(n('backOpacity') / 100), shade: clamp01(n('shading') / 100), lw, lh,
          });
        }
      }
      if (e.type === 'split') {
        const offset = n('splitOffset');
        if (offset !== 0) {
          const a = rad(n('angle'));
          spatial.push({ type: 'split', nx: Math.cos(a), ny: Math.sin(a), cx: lw / 2 + n('centerX'), cy: lh / 2 + n('centerY'), half: offset / 2, lw, lh });
        }
      }
      if (e.type === 'slant') {
        const slant = n('slant');
        if (slant !== 0) spatial.push({ type: 'slant', slant, vert: Math.round(n('slantAxis')) === 1, anchor: clamp01(n('floor')), lw, lh });
      }
      if (e.type === 'smear') {
        const vx = n('toX') - n('fromX'); const vy = n('toY') - n('fromY'); const radius = n('radius');
        if ((vx !== 0 || vy !== 0) && radius > 0) {
          spatial.push({ type: 'smear', fx: lw / 2 + n('fromX'), fy: lh / 2 + n('fromY'), vx, vy, radius, el: Math.max(0.1, n('elasticity') / 100), lw, lh });
        }
      }
      if (e.type === 'rolling-shutter') {
        const sweep = n('sweep'); const wobble = n('wobble');
        if (sweep !== 0 || wobble !== 0) {
          spatial.push({ type: 'rolling-shutter', sweep, wobble, flip: Math.round(n('scanDirection')) === 1, vertical: effectParam(e, 'verticalScan') === true, lw, lh });
        }
      }
      if (e.type === 'radial-shadow') {
        const op = n('shadowOpacity');
        if (op > 0) {
          const softness = n('softness');
          spatial.push({
            type: 'radial-shadow', lx: lw / 2 + n('lightX'), ly: lh / 2 + n('lightY'), proj: 1 + Math.max(0, n('projection')) / 100,
            color: unit3('shadowColor', '#000000'), op: clamp01(op / 100), sigmaPx: softness > 0 ? boxSigma(Math.max(1, Math.round(softness))) : 0,
            shadowOnly: Math.round(n('renderMode')) === 1, lw, lh,
          });
        }
      }
      if (e.type === 'flo-motion') {
        const k1a = n('knot1Amount') / 100; const k2a = n('knot2Amount') / 100;
        if (k1a !== 0 || k2a !== 0) {
          const sigma = Math.max(4, (n('falloff') / 100) * Math.min(lw, lh));
          spatial.push({
            type: 'flo-motion', k1x: lw / 2 + n('knot1X'), k1y: lh / 2 + n('knot1Y'), k1a, k2x: lw / 2 + n('knot2X'), k2y: lh / 2 + n('knot2Y'), k2a,
            twoSigma2: 2 * sigma * sigma, reachOverSigma: 1.2, lw, lh,
          });
        }
      }
      if (e.type === 'lens') {
        const ballR = Math.max(4, (n('size') / 100) * (Math.min(lw, lh) / 2));
        const halfDiag = Math.hypot(lw, lh) / 2;
        spatial.push({ type: 'lens', cx: lw / 2 + n('centerX'), cy: lh / 2 + n('centerY'), ballR, pull: ballR + (halfDiag - ballR) * clamp01(n('convergence') / 100), lw, lh });
      }
      if (e.type === 'griddler') {
        const r = rad(n('rotation'));
        spatial.push({ type: 'griddler', tile: Math.max(4, n('tileSize')), sx: Math.max(0.01, n('horizontalScale') / 100), sy: Math.max(0.01, n('verticalScale') / 100), cosR: Math.cos(r), sinR: Math.sin(r), lw, lh });
      }
      if (e.type === 'ball-action') {
        const g = Math.max(4, n('grid'));
        spatial.push({ type: 'ball-action', g, R: Math.max(0.01, (g / 2) * clamp01(n('ballSize') / 100)), jit: (n('scatter') / 100) * g * 0.5, seed: Math.floor(n('seed')), lw, lh });
      }
      if (e.type === 'drizzle') {
        const count = Math.round(clamp01(n('dripRate') / 100) * 30); const amp = n('rippleHeight');
        if (n('dripRate') > 0 && count > 0 && amp > 0) {
          const spread = Math.max(8, n('spreading')); const bandW = Math.max(3, spread * 0.08);
          spatial.push({ type: 'drizzle', n: count, spread, bandW, freq: Math.PI / (bandW * 0.6), evolution: n('evolution'), seed: Math.floor(n('seed')), amp, lw, lh });
        }
      }
      if (e.type === 'jaws') {
        const t = clamp01(n('completion') / 100);
        if (t > 0) {
          const a = rad(n('direction')); const ux = Math.cos(a); const uy = Math.sin(a);
          const extent = Math.abs(-uy * lw) / 2 + Math.abs(ux * lh) / 2;
          const th = n('teethHeight');
          spatial.push({ type: 'jaws', ux, uy, sep: t >= 1 ? 1e6 : t * (extent + th), tw: Math.max(2, n('teethWidth')), th: Math.max(1, th), lw, lh });
        }
      }
      if (e.type === 'pixel-polly') {
        const t = clamp01(n('completion') / 100);
        if (t > 0) {
          const cell = Math.max(4, n('cellSize'));
          spatial.push({
            type: 'pixel-polly', t, cell, fx: lw / 2 + n('centerX'), fy: lh / 2 + n('centerY'), maxFly: Math.hypot(lw, lh) * 0.7,
            grav: (n('gravity') / 100) * lh * 0.8, spin: rad(n('spin')), seed: Math.floor(n('seed')), fade: t < 0.6 ? 1 : Math.max(0, 1 - (t - 0.6) / 0.4),
            cols: Math.ceil(lw / cell), lw, lh,
          });
        }
      }
      if (e.type === 'twister') {
        const t = clamp01(n('completion') / 100);
        if (t > 0) spatial.push({ type: 'twister', t, axisY: lh / 2 + n('centerY'), twist: rad(n('twist')), lw, lh });
      }
      if (e.type === 'card-dance') {
        const amt = clamp01(n('amount') / 100);
        if (amt > 0) {
          spatial.push({
            type: 'card-dance', rows: Math.max(1, Math.round(n('rows'))), cols: Math.max(1, Math.round(n('columns'))), amt,
            rot: rad(n('cardRotation')), phase: n('phase'), maxOff: Math.min(lw, lh) * 0.4, lw, lh,
          });
        }
      }
      if (e.type === 'unmult') {
        spatial.push({ type: 'unmult', thresh: Math.max(0, Math.min(0.99, n('threshold') / 100)), boost: Math.max(0.1, n('boost') / 100) });
      }
      if (e.type === 'cc-composite') {
        const op = n('opacity');
        if (op > 0) spatial.push({ type: 'cc-composite', mix: clamp01(op / 100), mode: Math.max(0, Math.min(10, Math.round(n('blendMode')))), rgbOnly: effectParam(e, 'rgbOnly') === true });
      }
      if (e.type === 'cc-scatterize') {
        const amount = n('amount');
        if (amount > 0.001) spatial.push({ type: 'cc-scatterize', amt: amount * 0.5, twist: rad(n('twist')), windX: n('windX'), windY: n('windY'), seed: Math.floor(n('seed')), lw, lh });
      }
      if (e.type === 'radial-fast-blur') {
        const amount = n('amount');
        if (amount > 0.01) spatial.push({ type: 'radial-fast-blur', cx: lw / 2 + n('centerX'), cy: lh / 2 + n('centerY'), amt: (amount / 100) * 0.8, mode: Math.max(0, Math.min(2, Math.round(n('zoomMode')))), lw, lh });
      }
      if (e.type === 'cross-blur') {
        const rx = Math.max(0, Math.round(n('radiusX'))); const ry = Math.max(0, Math.round(n('radiusY')));
        if (rx > 0 || ry > 0) {
          const rep = effectParam(e, 'repeatEdges');
          spatial.push({ type: 'cross-blur', rx, ry, repeatEdge: rep === undefined ? true : rep === true, lw, lh });
        }
      }
      if (e.type === 'scale-wipe') {
        const comp = clamp01(n('completion') / 100);
        if (comp > 0.001) {
          const a = rad(n('direction')); const maxDist = Math.hypot(lw, lh);
          spatial.push({ type: 'scale-wipe', cx: lw / 2 + n('centerX'), cy: lh / 2 + n('centerY'), ux: Math.cos(a), uy: Math.sin(a), wipeEdge: comp * maxDist, stretch: n('stretch'), maxDist, lw, lh });
        }
      }
      if (e.type === 'plastic') {
        const la = rad(n('lightAngle')); const lx = Math.cos(la); const ly = -Math.sin(la); const lz = 0.8;
        const len = Math.hypot(lx, ly, lz) || 1;
        spatial.push({
          type: 'plastic', bump: (n('surfaceBump') / 100) * 8, gain: n('lightIntensity') / 100, l: [lx / len, ly / len, lz / len],
          specGain: (n('specular') / 100) * 1.5, sigmaPx: boxSigma(Math.max(0, Math.round(n('softness')))), lw, lh,
        });
      }
      if (e.type === 'glass') {
        const la = rad(n('lightAngle')); const hgt = n('height') / 100;
        spatial.push({
          type: 'glass', dispK: hgt * n('displacement'), hgt, lx: Math.cos(la), ly: -Math.sin(la), gain: n('lightIntensity') / 100,
          shine: clamp01(n('shininess') / 100), sigmaPx: boxSigma(Math.max(0, Math.round(n('bumpSoftness')))), lw, lh,
        });
      }
      if (e.type === 'texturize') {
        const gain = n('contrast') / 100;
        if (gain > 0) {
          const la = rad(n('lightAngle'));
          spatial.push({ type: 'texturize', pattern: Math.round(n('pattern')), gain, lx: Math.cos(la), ly: -Math.sin(la), s: 100 / Math.max(10, n('scale')), lw, lh });
        }
      }
      if (e.type === 'threads') {
        const th = Math.max(2, Math.round(n('thickness')));
        spatial.push({ type: 'threads', th, period: th + Math.max(0, Math.round(n('spacing'))), dk: clamp01(n('depth') / 100), lw, lh });
      }
      if (e.type === 'hex-tile') {
        spatial.push({ type: 'hex-tile', R: Math.max(2, n('radius')), bd: clamp01(n('border') / 100), lw, lh });
      }
      /*
        Effects round seven. Each pushes its shader's vec4 slots verbatim as
        `p` — what every slot holds is documented on the shader in
        `fxRoundFifteen.ts`, which is the only place that documentation can be
        checked against the code that reads it.

        Every one of these skips the push at its NEUTRAL setting, under exactly
        the condition the Canvas2D handler returns early on. That pairing is
        the contract: if the two disagreed, a layer sitting at an effect's
        default would render one way on the GPU and another through a bake.
      */
      if (e.type === 'cc-tiler') {
        const scale = n('scale');
        if (scale < 100 || n('centerX') !== 0 || n('centerY') !== 0) {
          spatial.push({
            type: 'cc-tiler',
            p: [
              [lw, lh, Math.max(0.01, scale / 100), clamp01(n('blendWithOriginal') / 100)],
              [lw / 2 + n('centerX'), lh / 2 + n('centerY'), 0, 0],
            ],
          });
        }
      }
      if (e.type === 'ripple-pulse') {
        const amplitude = n('amplitude');
        if (amplitude !== 0) {
          spatial.push({
            type: 'ripple-pulse',
            p: [
              [lw, lh, lw / 2 + n('centerX'), lh / 2 + n('centerY')],
              [n('pulseRadius'), amplitude, Math.max(1, n('width')), effectParam(e, 'renderBump') === false ? 0 : 1],
            ],
          });
        }
      }
      if (e.type === 'radial-scale-wipe') {
        const t = clamp01(n('completion') / 100);
        if (t > 0) {
          // The forward map reads FURTHER out as completion rises, so the
          // picture shrinks; reversed it reads nearer and the picture blows up.
          const reverse = effectParam(e, 'reverse') === true;
          const k = t >= 1 ? 0 : (reverse ? 1 - t : 1 / (1 - t));
          spatial.push({
            type: 'radial-scale-wipe',
            p: [
              [lw, lh, lw / 2 + n('centerX'), lh / 2 + n('centerY')],
              [k, 1 - t, 0, 0],
            ],
          });
        }
      }
      if (e.type === 'glass-wipe') {
        const t = clamp01(n('completion') / 100);
        if (t > 0) {
          spatial.push({
            type: 'glass-wipe',
            p: [
              [lw, lh, t, Math.max(0.02, clamp01(n('softness') / 100))],
              [n('displacement'), 0, 0, 0],
            ],
          });
        }
      }
      if (e.type === 'image-wipe') {
        const t = clamp01(n('completion') / 100);
        if (t > 0) {
          const band = Math.max(0.001, clamp01(n('borderSoftness') / 100));
          spatial.push({
            type: 'image-wipe',
            p: [
              [lw, lh, t * (1 + 2 * band) - band, band],
              [Math.max(0, Math.min(4, Math.round(n('gradientChannel')))), effectParam(e, 'invertGradient') === true ? 1 : 0, 0, 0],
            ],
          });
        }
      }
      if (e.type === 'color-difference-key') {
        const key = c('keyColor');
        const len = Math.hypot(key.r, key.g, key.b) || 1;
        // Which channel the key LEADS on decides partial B — see the kernel.
        const keyIdx = key.r >= key.g && key.r >= key.b ? 0 : key.g >= key.b ? 1 : 2;
        const black = clamp01(n('matteInBlack') / 255);
        const white = clamp01(n('matteInWhite') / 255);
        spatial.push({
          type: 'color-difference-key',
          p: [
            [key.r / len, key.g / len, key.b / len, keyIdx],
            [black, 1 / Math.max(0.0001, white - black), 1 / Math.max(0.01, n('matteGamma')), Math.round(n('viewMode'))],
          ],
        });
      }
      if (e.type === 'wire-removal') {
        const ax = lw / 2 + n('pointAX');
        const ay = lh / 2 + n('pointAY');
        const dx = (lw / 2 + n('pointBX')) - ax;
        const dy = (lh / 2 + n('pointBY')) - ay;
        const len = Math.hypot(dx, dy);
        const thickness = n('thickness');
        if (len >= 0.0001 && thickness > 0) {
          const half = thickness / 2;
          spatial.push({
            type: 'wire-removal',
            p: [
              [lw, lh, ax, ay],
              [dx / len, dy / len, len, half],
              [half + clamp01(n('slope') / 100) * thickness + 1, thickness, 0, 0],
            ],
          });
        }
      }
      if (e.type === 'broadcast-colors') {
        // NTSC carries a 7.5 IRE setup pedestal and PAL does not, so black sits
        // at a different place on the scale and the gain differs with it.
        const pedestal = Math.round(n('standard')) === 0 ? 7.5 : 0;
        spatial.push({
          type: 'broadcast-colors',
          p: [[pedestal, 100 - pedestal, Math.max(90, Math.min(120, n('maxSignalAmplitude'))), Math.round(n('howToMakeColorSafe'))]],
        });
      }
      if (e.type === 'noise-hls') {
        const hue = clamp01(n('hue') / 100);
        const lightness = clamp01(n('lightness') / 100);
        const saturation = clamp01(n('saturation') / 100);
        if (hue > 0 || lightness > 0 || saturation > 0) {
          spatial.push({
            type: 'noise-hls',
            p: [
              [lw, lh, Math.max(0.5, n('grainSize')), Math.floor(n('noisePhase'))],
              [hue, lightness, saturation, Math.round(n('noiseType'))],
            ],
          });
        }
      }
      if (e.type === 'block-load') {
        const completion = n('completion');
        if (completion < 100) {
          spatial.push({
            type: 'block-load',
            p: [
              [lw, lh, clamp01(completion / 100), Math.max(1, Math.min(8, Math.round(n('scans'))))],
              [Math.max(1, Math.round(n('blockSize'))), 0, 0, 0],
            ],
          });
        }
      }
      if (e.type === 'kernel') {
        const k = [
          n('k00'), n('k01'), n('k02'),
          n('k10'), n('k11'), n('k12'),
          n('k20'), n('k21'), n('k22'),
        ];
        const divisor = n('divisor');
        const offset = n('offset');
        const isIdentity = divisor === 1 && offset === 0
          && k.every((v, i) => v === (i === 4 ? 1 : 0));
        if (!isIdentity) {
          spatial.push({
            type: 'kernel',
            p: [
              [k[0]!, k[1]!, k[2]!, k[3]!],
              [k[4]!, k[5]!, k[6]!, k[7]!],
              [k[8]!, Math.abs(divisor) < 0.0001 ? 1 : divisor, offset / 255, 0],
              [lw, lh, 0, 0],
            ],
          });
        }
      }
      if (e.type === '3d-glasses') {
        const shift = effectParam(e, 'swapLeftRight') === true
          ? -n('convergenceOffset')
          : n('convergenceOffset');
        spatial.push({
          type: '3d-glasses',
          p: [
            [lw, lh, shift, Math.round(n('view'))],
            [clamp01(n('balance') / 100), 0, 0, 0],
          ],
        });
      }
      if (e.type === 'fractal') {
        const inside = c('insideColor');
        // The classic window is +-2 on the SHORTER side, so the framing holds
        // when the layer's aspect changes.
        const scale = 4 / (Math.min(lw, lh) * Math.max(0.1, n('magnification')));
        spatial.push({
          type: 'fractal',
          p: [
            [lw, lh, Math.round(n('setType')), Math.max(1, Math.min(256, Math.round(n('iterations'))))],
            [n('centerX'), n('centerY'), scale, 0],
            [n('juliaX'), n('juliaY'), n('colorPhase') / 360, Math.max(0.1, n('colorCycles'))],
            [inside.r, inside.g, inside.b, 0],
          ],
        });
      }
      if (e.type === 'particle-systems') {
        const birthRate = n('birthRate');
        // `time` is RESOLVED from the clock — see `TIME_DEPENDENT`.
        const time = n('time');
        if (birthRate > 0 && time >= 0) {
          const longevity = Math.max(0.0001, n('longevity'));
          const rate = Math.max(0.0001, birthRate);
          // The alive window, computed HERE so the shader never iterates past
          // it: births are ordered by index, so the live set is a contiguous
          // range. Widened by one either side to cover the birth jitter, and
          // capped at the shader's own 512-iteration loop bound.
          const first = Math.max(0, Math.floor((time - longevity) * rate) - 1);
          const last = Math.min(Math.floor(time * rate) + 1, first + 511);
          const animation = Math.round(n('animation'));
          // A fountain aims UP: screen y grows downward, so 270 degrees is up,
          // and a fountain left at 0 would spray sideways.
          const direction = animation === 2 && n('direction') === 0 ? 270 : n('direction');
          const birth = c('birthColor');
          const death = c('deathColor');
          spatial.push({
            type: 'particle-systems',
            p: [
              [lw, lh, time, rate],
              [longevity, n('producerX'), n('producerY'), n('producerRadiusX')],
              [n('producerRadiusY'), animation === 0 ? 0 : 1, rad(direction), rad(n('spread'))],
              [n('velocity'), clamp01(n('velocityVariation') / 100), n('gravity'), n('resistance')],
              [n('birthSize'), n('deathSize'), clamp01(n('sizeVariation') / 100), clamp01(n('opacity') / 100)],
              [birth.r, birth.g, birth.b, Math.round(n('blend'))],
              [death.r, death.g, death.b, Math.floor(n('seed'))],
              [first, last, 0, 0],
            ],
          });
        }
      }
      if (e.type === 'cc-bubbles') {
        const count = Math.max(0, Math.round(n('bubbleAmount')));
        const opacity = n('opacity');
        if (count > 0 && opacity > 0) {
          const size = n('bubbleSize');
          const cell = Math.max(4, Math.sqrt((lw * lh) / Math.max(1, count)));
          const col = c('color');
          spatial.push({
            type: 'cc-bubbles',
            p: [
              [lw, lh, cell, Math.max(1, Math.ceil(lw / cell))],
              [Math.max(1, Math.ceil(lh / cell)), count, n('bubbleSpeed'), n('wobbleAmplitude')],
              [n('wobbleFrequency'), size, clamp01(n('sizeVariation') / 100), Math.round(n('shading'))],
              [col.r, col.g, col.b, clamp01(opacity / 100)],
              // The wrap span is one bubble taller than the layer, so a bubble
              // leaving the top is not seen re-entering at the bottom.
              [n('evolution'), Math.floor(n('seed')), lh + size * 2, 0],
            ],
          });
        }
      }
      if (e.type === 'vector-blur') {
        const amount = n('amount');
        if (amount > 0) {
          const K = Math.max(2, Math.min(24, Math.round(amount))); const r = rad(n('angleOffset'));
          spatial.push({ type: 'vector-blur', amount, K, cosR: Math.cos(r), sinR: Math.sin(r), step: amount / K, sigmaPx: boxSigma(Math.max(0, Math.round(n('smoothness')))), lw, lh });
        }
      }
      /*
        Rounds twelve + thirteen: noise, transitions, windowed blurs, grid
        warps, the interior layer styles and the particle generators. Each
        block mirrors its Canvas2D wrapper's early-outs and packs the shader's
        vec4 slots (documented in fxRoundTwelve.ts / fxRoundThirteen.ts).
      */
      const lin01 = (c: number): number => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
      const lin3 = (k: string, d: string): readonly [number, number, number] => { const u = unit3(k, d); return [lin01(u[0]), lin01(u[1]), lin01(u[2])]; };
      const flag = (k: string, d: boolean): number => { const v = effectParam(e, k); return (v === undefined ? d : v === true) ? 1 : 0; };
      const stride = (r: number): number => Math.max(1, Math.ceil(r / 6));
      if (e.type === 'turbulent-displace' || e.type === 'curl-noise') {
        const amount = n('amount');
        if (amount !== 0) {
          const size = Math.max(4, n('size'));
          const oct = Math.max(1, Math.min(6, Math.floor(n('complexity'))));
          const k = e.type === 'curl-noise' ? amount * size * 0.5 : amount;
          spatial.push({ type: e.type, p: [[lw, lh, k, 1 / size], [n('evolution') * 0.01, oct, 0, 0]] });
        }
      }
      if (e.type === 'roughen-edges') {
        const border = Math.max(0, n('border'));
        if (border > 0) {
          spatial.push({ type: 'roughen-edges', p: [[lw, lh, border, 1 / Math.max(1, (n('scale') / 100) * 20)], [n('evolution') / 60, n('seed'), Math.max(1, Math.min(6, Math.round(n('complexity')))), Math.max(0, n('edgeSharpness'))]] });
        }
      }
      if (e.type === 'scatter') {
        const amount = n('amount');
        if (amount > 0) spatial.push({ type: 'scatter', p: [[lw, lh, amount, n('grain')], [n('seed'), n('evolution'), 0, 0]] });
      }
      if (e.type === 'colorama') {
        const pal = COLORAMA_PALETTES[Math.max(0, Math.min(COLORAMA_PALETTES.length - 1, Math.round(n('palette'))))]!;
        const stops: FxVec4[] = [];
        for (let i = 0; i < 7; i++) {
          const st = pal.stops[Math.min(i, pal.stops.length - 1)]!;
          stops.push([st.rgb[0] / 255, st.rgb[1] / 255, st.rgb[2] / 255, st.at]);
        }
        spatial.push({ type: 'colorama', p: [...stops, [n('phaseShift') / 360, Math.max(0.01, n('cycleRepetitions')), Math.max(0, Math.min(100, n('blendWithOriginal'))) / 100, pal.stops.length]] });
      }
      if (e.type === 'selective-color') {
        const cyan = n('cyan'); const magenta = n('magenta'); const yellow = n('yellow'); const black = n('black');
        if (cyan !== 0 || magenta !== 0 || yellow !== 0 || black !== 0) {
          spatial.push({ type: 'selective-color', p: [[Math.max(0, Math.min(8, Math.round(n('range')))), cyan / 100, magenta / 100, yellow / 100], [black / 100, effectParam(e, 'absolute') === true ? 0 : 1, 0, 0]] });
        }
      }
      if (e.type === 'turbulent-noise') {
        spatial.push({ type: 'turbulent-noise', p: [[lw, lh, Math.max(1, n('scale')), Math.max(1, Math.min(8, Math.round(n('complexity'))))], [n('evolution'), n('contrast') / 100, n('brightness') / 100, flag('invert', false)]] });
      }
      if (e.type === 'add-grain') {
        const intensity = n('intensity');
        if (intensity !== 0) spatial.push({ type: 'add-grain', p: [[lw, lh, intensity / 100, Math.max(0.1, n('size'))], [clamp01(n('saturation') / 100), n('seed'), 0, 0]] });
      }
      if (e.type === 'median') {
        const r = Math.max(0, Math.min(8, Math.round(n('radius'))));
        if (r > 0) spatial.push({ type: 'median', p: [[lw, lh, r, 0], [0, 0, 0, 0]] });
      }
      if (e.type === 'dust-scratches') {
        spatial.push({ type: 'dust-scratches', p: [[lw, lh, Math.max(1, Math.min(8, Math.round(n('radius')))), 1], [Math.max(0, n('threshold')) / 255, 0, 0, 0]] });
      }
      if (e.type === 'block-dissolve') {
        const completion = n('completion');
        if (completion > 0) {
          const t = clamp01(completion / 100);
          spatial.push({ type: 'block-dissolve', p: [[lw, lh, t, Math.max(1, Math.round(n('blockWidth')))], [Math.max(1, Math.round(n('blockHeight'))), t >= 1 ? 0 : Math.max(0, n('feather')), n('seed'), 0]] });
        }
      }
      if (e.type === 'gradient-wipe') {
        const completion = n('completion');
        if (completion > 0) spatial.push({ type: 'gradient-wipe', p: [[clamp01(completion / 100), Math.max(0.0001, n('softness') / 100), flag('invertGradient', false), 0]] });
      }
      if (e.type === 'card-wipe') {
        const completion = n('completion');
        if (completion > 0) {
          spatial.push({ type: 'card-wipe', p: [[lw, lh, clamp01(completion / 100), Math.max(1, Math.round(n('rows')))], [Math.max(1, Math.round(n('columns'))), Math.max(0, Math.min(4, Math.round(n('flipOrder')))), 0, 0]] });
        }
      }
      if (e.type === 'strobe-light') {
        const period = Math.max(0.001, n('strobePeriod'));
        const time = n('time');
        const phase = (((time % period) + period) % period) / period;
        const k = clamp01(n('intensity') / 100);
        if (phase < clamp01(n('strobeDuty') / 100) && k > 0) {
          const col = unit3('strobeColor', '#ffffff');
          spatial.push({ type: 'strobe-light', p: [[k, Math.round(n('strobeOperation')), 0, 0], [col[0], col[1], col[2], 0]] });
        }
      }
      if (e.type === 'burn-film') {
        const burn = n('burn');
        if (burn > 0) {
          const t = clamp01(burn / 100); const cx = lw / 2 + n('centerX'); const cy = lh / 2 + n('centerY');
          const maxR = Math.hypot(Math.max(cx, lw - cx), Math.max(cy, lh - cy)) || 1;
          const bc = unit3('burnColor', '#fff6e0'); const ch = unit3('charColor', '#3d1f0a');
          spatial.push({ type: 'burn-film', p: [[lw, lh, t, cx], [cy, maxR, t * maxR * 1.15, clamp01(n('randomness') / 100)], [bc[0], bc[1], bc[2], Math.round(n('seed'))], [ch[0], ch[1], ch[2], 0]] });
        }
      }
      if (e.type === 'light-wipe') {
        const completion = n('completion');
        if (completion > 0) {
          const t = clamp01(completion / 100); const radial = Math.round(n('wipeShape')) === 1;
          const cx = lw / 2 + n('centerX'); const cy = lh / 2 + n('centerY');
          const a = rad(n('angle')); const nx = Math.cos(a); const ny = Math.sin(a);
          const span = radial ? (Math.hypot(Math.max(cx, lw - cx), Math.max(cy, lh - cy)) || 1) : Math.abs(lw * nx) + Math.abs(lh * ny);
          const width = n('lightWidth'); const col = unit3('lightColor', '#ffffff');
          spatial.push({ type: 'light-wipe', p: [[lw, lh, radial ? 1 : 0, cx], [cy, nx, ny, span], [t * (span + width), Math.max(0.001, width), clamp01(n('intensity') / 100), Math.max(0.001, n('feather'))], [col[0], col[1], col[2], 0]] });
        }
      }
      if (e.type === 'grid-wipe') {
        const completion = n('completion'); const invert = flag('invertGrid', false);
        if (completion > 0 || invert > 0) {
          spatial.push({ type: 'grid-wipe', p: [[lw, lh, clamp01(completion / 100), Math.max(1, Math.min(256, Math.round(n('columns'))))], [Math.max(1, Math.min(256, Math.round(n('rows')))), Math.round(n('tileShape')), clamp01(n('randomSeed') / 100), Math.max(0.001, n('feather') / 100)], [invert, 0, 0, 0]] });
        }
      }
      if (e.type === 'noise-alpha') {
        const amount = n('amount');
        if (amount > 0) spatial.push({ type: 'noise-alpha', p: [[lw, lh, clamp01(amount / 100), flag('uniformNoise', true)], [Math.round(n('seed')), Math.round(n('noisePhase')), flag('clipResult', true), 0]] });
      }
      if (e.type === 'brush-strokes') {
        const density = n('density');
        if (density > 0) {
          spatial.push({ type: 'brush-strokes', p: [[lw, lh, Math.max(1, Math.min(32, Math.round(n('strokeLength')))), Math.max(1, Math.round(n('cellSize')))], [clamp01(n('randomness') / 100) * Math.PI, clamp01(density / 100), rad(n('strokeAngle')), 0]] });
        }
      }
      if (e.type === 'bilateral-blur' || e.type === 'smart-blur' || e.type === 'camera-lens-blur') {
        const r = Math.max(0, Math.min(24, Math.round(n('radius'))));
        if (n('radius') > 0 && r > 0) {
          if (e.type === 'bilateral-blur') {
            const ss = Math.max(0.5, r / 2); const sr = Math.max(1, n('colorSigma'));
            spatial.push({ type: 'bilateral-blur', p: [[lw, lh, r, 1 / (2 * ss * ss)], [1 / (2 * sr * sr), flag('preserveAlpha', true), stride(r), 0]] });
          } else if (e.type === 'smart-blur') {
            spatial.push({ type: 'smart-blur', p: [[lw, lh, r, Math.max(0, n('threshold'))], [Math.round(n('mode')), stride(r), 0, 0]] });
          } else {
            spatial.push({ type: 'camera-lens-blur', p: [[lw, lh, r, Math.round(n('blades'))], [rad(n('irisRotation')), Math.max(1, n('gain')), clamp01(n('highlightThreshold') / 100), stride(r)]] });
          }
        }
      }
      if (e.type === 'mesh-warp') {
        const offs: number[] = [];
        for (let i = 0; i < 16; i++) offs.push(n(`v${i}X`), n(`v${i}Y`));
        if (offs.some((v) => v !== 0)) {
          const p: FxVec4[] = [[lw, lh, 0, 0]];
          for (let i = 0; i < 32; i += 4) p.push([offs[i]!, offs[i + 1]!, offs[i + 2]!, offs[i + 3]!]);
          spatial.push({ type: 'mesh-warp', p });
        }
      }
      if (e.type === 'liquify') {
        const radius = n('brushSize'); const pushX = n('pushX'); const pushY = n('pushY'); const twirl = rad(n('twirl')); const pinch = n('pinch') / 100;
        if (radius > 0 && (pushX !== 0 || pushY !== 0 || twirl !== 0 || pinch !== 0)) {
          spatial.push({ type: 'liquify', p: [[lw, lh, lw / 2 + n('centerX'), lh / 2 + n('centerY')], [radius, pushX, pushY, twirl], [pinch, 0, 0, 0]] });
        }
      }
      if (e.type === 'bezier-warp') {
        const rest = defaultWarpPoints(lw, lh);
        const keys = ['topLeft', 'top1', 'top2', 'topRight', 'right1', 'right2', 'bottomRight', 'bottom1', 'bottom2', 'bottomLeft', 'left1', 'left2'];
        const pts = keys.map((k, i) => ({ x: rest[i]!.x + n(`${k}X`), y: rest[i]!.y + n(`${k}Y`) })) as unknown as WarpPoints;
        if (!isRestWarp(pts, lw, lh)) {
          const p: FxVec4[] = [[lw, lh, 0, 0]];
          for (let i = 0; i < 12; i += 2) p.push([pts[i]!.x, pts[i]!.y, pts[i + 1]!.x, pts[i + 1]!.y]);
          spatial.push({ type: 'bezier-warp', p });
        }
      }
      if (e.type === 'cell-pattern') {
        spatial.push({ type: 'cell-pattern', p: [[lw, lh, Math.max(2, n('size')), Math.max(0.01, n('contrast') / 100)], [n('evolution'), flag('invert', false), flag('membrane', false), 0]] });
      }
      if (e.type === 'radio-waves') {
        const a = clamp01(n('opacity') / 100);
        if (a > 0) {
          const maxRadius = n('maxRadius'); const col = lin3('color', '#7dd3fc');
          spatial.push({ type: 'radio-waves', p: [[lw, lh, lw / 2 + n('centerX'), lh / 2 + n('centerY')], [Math.max(1, Math.min(64, Math.round(n('waveCount')))), maxRadius > 0 ? maxRadius : Math.hypot(lw, lh) / 2, n('phase') / 360, Math.max(0.5, n('thickness'))], [col[0], col[1], col[2], a], [clamp01(n('fadeOut') / 100), Math.round(n('composite')), 0, 0]] });
        }
      }
      if (e.type === 'beam-path') {
        const s = beamPathSettings(e, lw, lh);
        if (s.points.length >= 4 && s.totalLen > 0) {
          spatial.push({ type: 'beam-path', p: beamPathRows(s, lw, lh), spreadPx: beamPathSpreadPx(s) });
        }
      }
      if (e.type === 'light-burst') {
        const gain = Math.max(0, n('intensity') / 100); const reach = clamp01(n('rayLength') / 100);
        if (n('intensity') > 0 && gain > 0 && reach > 0) spatial.push({ type: 'light-burst', p: [[lw, lh, lw / 2 + n('centerX'), lh / 2 + n('centerY')], [gain, reach, 0, 0]] });
      }
      if (e.type === 'write-on') {
        const t1 = clamp01(n('completion') / 100);
        const sx = lw / 2 + n('startX'); const sy = lh / 2 + n('startY');
        const dx = n('endX') - n('startX'); const dy = n('endY') - n('startY'); const len = Math.hypot(dx, dy);
        if (t1 > 0 && len >= 0.001) {
          const radius = Math.max(0.5, n('brushSize') / 2); const taper = n('taper'); const col = lin3('brushColor', '#ffffff');
          spatial.push({ type: 'write-on', p: [[lw, lh, sx, sy], [dx, dy, t1, (n('wobble') / 100) * len * 0.12], [radius, Math.max(0.000001, (taper / 100) * t1), taper > 0 ? 1 : 0, Math.max(2, Math.min(256, Math.ceil((len * t1) / Math.max(1, radius * 0.5))))], [col[0], col[1], col[2], -dy / len], [dx / len, 0, 0, 0]] });
        }
      }
      if (e.type === 'star-burst') {
        const col = unit3('starColor', '#ffffff');
        spatial.push({ type: 'star-burst', p: [[lw, lh, Math.round(clamp01(n('amount') / 100) * 400), n('phase')], [n('size'), clamp01(n('blend') / 100), Math.floor(n('seed')), Math.hypot(lw / 2, lh / 2)], [col[0], col[1], col[2], 0]] });
      }
      if (e.type === 'snowfall') {
        const amount = n('amount');
        if (amount > 0) {
          const amt = Math.max(0.01, clamp01(amount / 100));
          const cell = Math.max(12, Math.sqrt(1200 / amt), lh / 64); const col = lin3('flakeColor', '#ffffff');
          spatial.push({ type: 'snowfall', p: [[lw, lh, cell, n('size')], [n('evolution'), n('wind'), clamp01(n('opacity') / 100), Math.floor(n('seed'))], [col[0], col[1], col[2], Math.ceil(lw / cell)]] });
        }
      }
      if (e.type === 'rainfall') {
        const amount = n('amount');
        if (amount > 0) {
          const amt = Math.max(0.01, clamp01(amount / 100)); const len = Math.max(2, n('length'));
          const cell = Math.max(16, Math.sqrt(2500 / amt), lh / 64, lw / 64, len / 5); const a = rad(n('angle')); const col = lin3('rainColor', '#cfe6ff');
          spatial.push({ type: 'rainfall', p: [[lw, lh, cell, len], [n('evolution'), clamp01(n('opacity') / 100), Math.floor(n('seed')), Math.sin(a)], [col[0], col[1], col[2], Math.cos(a)], [Math.ceil(lw / cell), Math.ceil(lh / cell), 0, 0]] });
        }
      }
      if (e.type === 'cartoon') {
        const blurR = Math.max(0, Math.min(12, Math.round(n('smoothness'))));
        const levels = Math.max(2, Math.min(64, Math.round(n('levels'))));
        spatial.push({ type: 'cartoon', p: [[lw, lh, 255 / (levels - 1), Math.max(0, n('edgeThreshold'))], [Math.max(1, Math.round(n('edgeWidth'))), clamp01(n('edgeOpacity') / 100), blurR > 0 ? 1 : 0, 0]], sigmaPx: boxSigma(blurR) });
      }
      if (e.type === 'inner-shadow' || e.type === 'inner-glow') {
        const opacity = clamp01(n('opacity') / 100);
        if (opacity > 0) {
          const glow = e.type === 'inner-glow';
          const size = Math.max(0, glow ? n('size') : n('softness'));
          const dist = glow ? 0 : Math.max(0, n('distance')); const a = rad(glow ? 0 : n('angle'));
          // Display sRGB, not linear: the kernels shade in the CPU pass's space (fxRoundThirteen).
          const col = unit3('color', glow ? '#ffd070' : '#000000');
          spatial.push({ type: e.type, p: [[Math.cos(a) * dist, Math.sin(a) * dist, opacity, glow ? 1 : 0], [col[0], col[1], col[2], 0], [lw, lh, 0, 0]], sigmaPx: size });
        }
      }
      if (e.type === 'satin') {
        const opacity = clamp01(n('opacity') / 100); const size = Math.max(0, n('size')); const dist = Math.max(0, n('distance'));
        if (opacity > 0 && (size > 0 || dist > 0)) {
          const a = rad(n('angle')); const col = unit3('color', '#000000');
          spatial.push({ type: 'satin', p: [[Math.cos(a) * dist, Math.sin(a) * dist, opacity, flag('invert', false)], [col[0], col[1], col[2], 0], [lw, lh, 0, 0]], sigmaPx: size });
        }
      }
      if (e.type === 'bevel') {
        const size = Math.max(1, n('size')); const depth = Math.max(0, n('depth')) / 100;
        const hiOp = clamp01(n('highlightOpacity') / 100); const loOp = clamp01(n('shadowOpacity') / 100);
        if (depth > 0 && (hiOp > 0 || loOp > 0)) {
          const down = effectParam(e, 'direction') === 'down';
          const a = rad(n('angle') + (down ? 180 : 0)); const alt = rad(Math.max(0, Math.min(90, n('altitude'))));
          const hi = unit3('highlightColor', '#ffffff'); const lo = unit3('shadowColor', '#000000');
          spatial.push({ type: 'bevel', p: [[Math.cos(a) * Math.cos(alt), Math.sin(a) * Math.cos(alt), Math.sin(alt), depth * 8], [hi[0], hi[1], hi[2], hiOp], [lo[0], lo[1], lo[2], loOp], [lw, lh, 0, 0]], sigmaPx: Math.max(0.5, size) });
        }
      }
      /*
        Round fourteen: the histogram colour autos. `applyTables` is a no-op at
        blend 100 (keep 0), and Equalize skips at amount 0 — both early-outs
        mirrored here. Slots: mode, amount-or-black-clip, 1 − white-clip, snap;
        blend keep.
      */
      if (e.type === 'equalize' || e.type === 'auto-levels' || e.type === 'auto-contrast' || e.type === 'auto-color') {
        const keep = clamp01(1 - n('blend') / 100);
        if (keep > 0 && (e.type !== 'equalize' || n('amount') > 0)) {
          const lo = clamp01(n('blackClip') / 100); const hi = 1 - clamp01(n('whiteClip') / 100);
          const p: FxVec4[] = e.type === 'equalize'
            ? [[Math.round(n('equalizeMode')) === 1 ? 1 : 0, clamp01(n('amount') / 100), 0, 0], [keep, 0, 0, 0]]
            : e.type === 'auto-levels' ? [[2, lo, hi, 0], [keep, 0, 0, 0]]
              : e.type === 'auto-contrast' ? [[3, lo, hi, 0], [keep, 0, 0, 0]]
                : [[4, lo, hi, clamp01(n('snapNeutral') / 100)], [keep, 0, 0, 0]];
          spatial.push({ type: e.type, p, lw, lh });
        }
      }
      if (e.type === 'find-edges') {
        spatial.push({
          type: 'find-edges',
          invert: effectParam(e, 'invert') !== false,
          blend: Math.max(0, Math.min(1, n('blendWithOriginal') / 100)), lw, lh,
        });
      }
      if (e.type === 'emboss') {
        const erad = (n('angle') * Math.PI) / 180;
        spatial.push({
          type: 'emboss',
          dx: Math.cos(erad) * n('relief'), dy: Math.sin(erad) * n('relief'),
          k: n('contrast') / 100,
          keep: Math.max(0, Math.min(1, n('blend') / 100)), lw, lh,
        });
      }
      if (e.type === 'color-emboss') {
        const cerad = (n('direction') * Math.PI) / 180;
        spatial.push({
          type: 'color-emboss',
          ox: Math.round(Math.cos(cerad) * Math.max(1, n('relief'))),
          oy: Math.round(Math.sin(cerad) * Math.max(1, n('relief'))),
          k: Math.max(0, n('contrast')) / 100,
          blend: Math.max(0, Math.min(1, 1 - n('blendWithOriginal') / 100)), lw, lh,
        });
      }
      if (e.type === 'halftone') {
        const hrad = (n('screenAngle') * Math.PI) / 180;
        const [ir, ig, ib] = hexTriple(String(effectParam(e, 'inkColor') ?? '#000000'));
        const [pr, pg, pb] = hexTriple(String(effectParam(e, 'paperColor') ?? '#ffffff'));
        spatial.push({
          type: 'halftone',
          cell: Math.max(2, Math.round(n('cellSize'))),
          ca: Math.cos(hrad), sa: Math.sin(hrad),
          k: Math.max(0.01, n('contrast') / 100),
          inkR: ir / 255, inkG: ig / 255, inkB: ib / 255,
          colorize: effectParam(e, 'colorize') === true,
          paperR: pr / 255, paperG: pg / 255, paperB: pb / 255,
          blend: Math.max(0, Math.min(1, 1 - n('blendWithOriginal') / 100)), lw, lh,
        });
      }
    }
    if (e.type === 'fractal-noise') spatial.push({ type: 'fractal-noise', scale: n('scale') });
    if (e.type === 'displacement-map') {
      // Map source layer (node id === renderable id). '' / non-string = unset →
      // CompositionPass falls back to self-displacement.
      const mapRaw = effectParam(e, 'mapLayerId');
      const mapLayerId = typeof mapRaw === 'string' && mapRaw !== '' ? mapRaw : undefined;
      spatial.push({ type: 'displacement-map', amount: n('amount'), ...(mapLayerId ? { mapLayerId } : {}) });
    }
    if (e.type === 'apply-color-lut') {
      /*
        Emitted only when the file actually parsed.

        An unset or unreadable LUT is a layer with no grade, and the honest
        render of that is the layer unchanged — so the entry is omitted rather
        than emitted with an empty table for the renderer to skip. That also
        keeps the effect list free of entries the pass would only discard, which
        matters because `effectSpreadPx` and the batching walk it.
      */
      const cube = readCubeLutParam(e);
      if (cube) {
        spatial.push({
          type: 'apply-color-lut',
          // The SAME key MotionRendererBackend registers the strip under. Two
          // spellings of one key is how a texture ends up uploaded and never
          // sampled — see `lut:` vs `cubelut:` there for why they differ.
          lutTextureKey: `cubelut:${layer.id}`,
          size: cube.size1d > 0 ? cube.size1d : cube.size,
          is1d: cube.size1d > 0,
          intensity: n('intensity') / 100,
          // One pair for all three channels; `.cube` allows a per-channel
          // domain and files using one are vanishingly rare.
          domainMin: cube.domainMin[0],
          domainMax: cube.domainMax[0],
        });
      }
    }
    if (e.type === 'compound-blur') {
      // Same unset rule and the same self-fallback as displacement-map above.
      const mapRaw = effectParam(e, 'blurLayerId');
      const mapLayerId = typeof mapRaw === 'string' && mapRaw !== '' ? mapRaw : undefined;
      spatial.push({
        type: 'compound-blur',
        maxRadiusPx: n('maxBlur'),
        // Read as a BOOLEAN, not through `n()`: `effectNumber` returns 0 for a
        // checkbox param, so `n('invert') > 0.5` would be unconditionally false
        // and the control would persist, keyframe, and do nothing. Same reading
        // as set-matte's `invert` below, which is the existing precedent.
        invert: e.params?.invert === true,
        ...(mapLayerId ? { mapLayerId } : {}),
      });
    }
    if (e.type === 'set-matte') {
      // Same shape as displacement-map above — node id === renderable id. The
      // difference is the unset case: displacement falls back to self, this one
      // is skipped in CompositionPass, because a layer matted by its own alpha
      // is a wrong picture rather than a degraded one.
      const matteRaw = effectParam(e, 'matteLayerId');
      const matteLayerId = typeof matteRaw === 'string' && matteRaw !== '' ? matteRaw : undefined;
      // Read as BOOLEANS, not through `n()`. `effectNumber` returns 0 for a
      // checkbox param, so `n('invert') > 0.5` is unconditionally false — the
      // control would persist, keyframe, and do nothing. Same reading as
      // `monochrome` below, which is the existing precedent.
      spatial.push({
        type: 'set-matte',
        useLuminance: e.params?.useLuminance === true,
        invert: e.params?.invert === true,
        ...(matteLayerId ? { matteLayerId } : {}),
      });
    }
    if (e.type === 'motion-tile') spatial.push({ type: 'motion-tile', scale: n('scale') });
    if (e.type === 'bevel-alpha' || e.type === 'bevel-edges') {
      /*
        Thickness arrives in PIXELS and the shaders work in UV, so it is scaled
        by the layer box here — a bevel specified in pixels must not get
        thicker when the same layer is used at a larger size.
      */
      const px = Math.max(1, layer.width || 1);
      const py = Math.max(1, layer.height || 1);
      spatial.push({
        type: e.type,
        thickness: n('thickness') / Math.min(px, py),
        lightRad: (n('lightAngle') * Math.PI) / 180,
        intensity: n('intensity') / 100,
        color: c('lightColor', 1),
      });
    }
    if (e.type === 'arithmetic') {
      // 0..255 → 0..1. Authored 8-bit because And/Or/Xor are only meaningful
      // on integers; the shader re-quantises for those three operators.
      spatial.push({
        type: 'arithmetic',
        operator: Math.round(n('operator')),
        r: n('red') / 255,
        g: n('green') / 255,
        b: n('blue') / 255,
        // Read as a BOOLEAN: effectNumber returns 0 for a checkbox param, so
        // `n('clip') > 0.5` would be unconditionally false and the control
        // would persist, keyframe and do nothing.
        clip: e.params?.clip !== false,
      });
    }
    if (e.type === 'sphere') {
      // `aspect` lets the shader keep the silhouette CIRCULAR on a non-square
      // layer — without it the sphere is an ellipse, because raw UV compresses
      // x by w/h.
      spatial.push({
        type: 'sphere',
        radius: n('radius') / 100,
        rotXRad: (n('rotateX') * Math.PI) / 180,
        rotYRad: (n('rotateY') * Math.PI) / 180,
        rotZRad: (n('rotateZ') * Math.PI) / 180,
        shading: n('shading') / 100,
        aspect: Math.max(1, layer.width || 1) / Math.max(1, layer.height || 1),
        color: c('lightColor', 1),
      });
    }
    if (e.type === 'cylinder') {
      spatial.push({
        type: 'cylinder',
        radius: n('radius') / 100,
        rotRad: (n('rotation') * Math.PI) / 180,
        shading: n('shading') / 100,
        color: c('lightColor', 1),
      });
    }
    if (e.type === 'spotlight') {
      // From/To are offsets from rest (top-centre, layer centre), resolved here
      // and converted to aspect-corrected units — the same treatment Bend's
      // Top/Base get, and for the same reason: a cone measured in raw UV is an
      // ellipse on a non-square layer.
      const w = Math.max(1, layer.width || 1);
      const h = Math.max(1, layer.height || 1);
      const aspect = w / h;
      const toQ = (pxX: number, pxY: number): { x: number; y: number } =>
        ({ x: (pxX / w) * aspect, y: pxY / h });
      const from = toQ(w / 2 + n('fromX'), 0 + n('fromY'));
      const to = toQ(w / 2 + n('toX'), h / 2 + n('toY'));
      // Migrate known-bad shipping defaults that crushed fullscreen layers into
      // the dark comp background (looked like the whole scene went blank).
      let ambientPct = n('ambient');
      if (ambientPct === 15 || ambientPct === 55) ambientPct = 100;
      let intensityPct = n('intensity');
      if (intensityPct === 150 && (n('ambient') === 15 || n('ambient') === 55)) {
        intensityPct = 100;
      }
      spatial.push({
        type: 'spotlight',
        fromX: from.x, fromY: from.y,
        toX: to.x, toY: to.y,
        // The control is the FULL cone; the shader measures a half angle from
        // the axis. Halving once here beats every reader of the uniform having
        // to remember which one it holds.
        coneHalfRad: (n('coneAngle') * Math.PI) / 360,
        softness: n('edgeSoftness') / 100,
        intensity: intensityPct / 100,
        ambient: ambientPct / 100,
        aspect,
        lightOnly: Math.round(n('render')) === 1,
        // Percent of the layer's height — the unit the shader works in.
        reach: Math.max(0.01, n('reach') / 100),
        color: c('lightColor', 1),
      });
    }
    if (e.type === 'bend') {
      /*
        Top and Base are stored as OFFSETS from a rest position — the layer's
        top-centre and bottom-centre — which is the convention every handled
        effect uses (effectHandles.ts). Resolving rest here, once, is what lets
        the params default to zero and survive a resize.

        Converted to ASPECT-CORRECTED layer units, the space the shader bends
        in: x scaled by w/h so a unit is the same distance on both axes. In raw
        UV a bend line at any angle other than horizontal or vertical would
        shear on a non-square layer.
      */
      const w = Math.max(1, layer.width || 1);
      const h = Math.max(1, layer.height || 1);
      const aspect = w / h;
      // rest + offset, in px, then into units of the layer's height.
      const topPxX = w / 2 + n('topX');
      const topPxY = 0 + n('topY');
      const basePxX = w / 2 + n('baseX');
      const basePxY = h + n('baseY');
      spatial.push({
        type: 'bend',
        angleRad: (n('amount') * Math.PI) / 180,
        style: Math.round(n('style')),
        aspect,
        holdOutside: Math.round(n('outside')) === 1,
        topX: (topPxX / w) * aspect,
        topY: topPxY / h,
        baseX: (basePxX / w) * aspect,
        baseY: basePxY / h,
      });
    }
    if (e.type === 'fill') {
      spatial.push({ type: 'fill', color: c('color', n('opacity') / 100) });
    }
    if (e.type === 'stroke') {
      const posRaw = effectParam(e, 'position');
      let position: 0 | 1 | 2 = 0;
      if (posRaw === 'inside' || posRaw === 1) position = 1;
      else if (posRaw === 'center' || posRaw === 2) position = 2;
      else if (typeof posRaw === 'number' && posRaw >= 1 && posRaw <= 2) {
        position = Math.round(posRaw) as 1 | 2;
      }
      spatial.push({
        type: 'stroke',
        widthPx: n('width'),
        color: c('color', n('opacity') / 100),
        ...(position !== 0 ? { position } : {}),
      });
    }
    if (e.type === 'sharpen') {
      spatial.push({ type: 'sharpen', amount: n('amount') / 100 });
    }
    if (e.type === 'noise') {
      spatial.push({ type: 'noise', amount: n('amount') / 100, evolution: n('evolution'), monochrome: e.params?.monochrome !== false });
    }
  }
  stampOpacity();
  return spatial.length > 0 ? spatial : undefined;
}

/**
 * Deformed-mesh (puppet / skeleton) vertices arrive in CENTERED LOCAL PIXELS
 * (−w/2..w/2), but the GPU draws them through the layer's model matrix, which —
 * like every textured quad — maps a [0,1] UNIT QUAD to comp space. Feeding raw
 * pixels to that matrix throws the geometry far off-screen (a plain rig makes
 * the layer vanish). Normalise XY to unit-quad space here so the SAME model
 * matrix places every vertex correctly: n = v/(dim+2·pad) + 0.5, which the
 * matrix's scale(dim·scale)·translate(−0.5) maps back to `v·scale` in comp
 * space (layer scale/rotation/position then follow). UVs already sample the
 * `path:` texture in [0,1] and pass through untouched. (The old Canvas2D
 * backend applied the pixel-space matrix itself; the unified GPU path did not,
 * so this normalisation restores puppet/bone deformation on screen.)
 */
function normalizeDeformedMesh(
  mesh: { vertices: Float32Array; triangles: Uint16Array; depth?: Float32Array },
  width: number,
  height: number,
  pad: number,
): { vertices: Float32Array; triangles: Uint16Array; depth?: Float32Array } {
  const W = width + 2 * pad;
  const H = height + 2 * pad;
  const src = mesh.vertices;
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 4) {
    out[i] = src[i]! / W + 0.5;
    out[i + 1] = src[i + 1]! / H + 0.5;
    out[i + 2] = src[i + 2]!; // u
    out[i + 3] = src[i + 3]!; // v
  }
  // Depth is a per-vertex scalar in its own space — it is NOT a position, so it
  // must not go through the unit-quad normalisation above.
  return mesh.depth
    ? { vertices: out, triangles: mesh.triangles, depth: mesh.depth }
    : { vertices: out, triangles: mesh.triangles };
}

/**
 * Shape layers that must rasterize to a `path:` texture on the GPU path:
 * custom paths (no SDF form), gradient fills (the SDF solid flattens a
 * gradient to one colour — centre of a black→white ramp rendered black), and
 * masked solids (the mask shader runs only on TEXTURED renderables, so a
 * masked SDF rect simply ignored its mask). Shared with the texture-feeding
 * loop in MotionRendererBackend — both sides must agree or the renderable
 * points at a texture nobody uploaded.
 */
export function needsShapeRaster(layer: RenderLayer): boolean {
  if (layer.kind !== 'shape') return false;
  if (layer.deformedMesh) return true;
  if (layer.primitive === 'path') return true;
  if (layer.fillPaint && layer.fillPaint.type !== 'solid') return true;
  if (layer.fillPaints && layer.fillPaints.some((p) => p.type !== 'solid')) return true;
  if (layer.stroke && layer.stroke.width > 0) return true;
  if (layer.strokes && layer.strokes.some((s) => s.width > 0)) return true;
  // A fill with its own Composite/blend mode is an ordered paint stack, which
  // only the Canvas2D raster draws (the SDF solid has one paint and no blend).
  if (layerHasOrderedPaint(layer)) return true;
  if (layer.mask && layer.mask.paths.length > 0) return true;
  if (layer.paint && layer.paint.strokes.length > 0) return true;
  // Non-uniform per-corner radii need Canvas2D roundRect([tl,tr,br,bl]) — the
  // GPU solid SDF is isotropic and cannot express independent corners.
  if (
    layer.cornerRadii
    && !(
      layer.cornerRadii[0] === layer.cornerRadii[1]
      && layer.cornerRadii[1] === layer.cornerRadii[2]
      && layer.cornerRadii[2] === layer.cornerRadii[3]
    )
  ) return true;
  // A corner radius under a NON-UNIFORM scale is an ellipse in the layer's own
  // space (see `cornerRadiusNeedsRaster`), and the solid SDF is isotropic.
  if (cornerRadiusNeedsRaster(layer)) return true;
  // A shape carrying a Canvas2D-only effect is CPU-baked (content + mask +
  // full effect chain) into its `path:` texture — those effects have no GPU
  // shader form and otherwise silently no-op.
  if (layerIsBaked(layer)) return true;
  return false;
}

export function layerToRenderable(
  layer: RenderLayer,
  parentMatrix?: Mat3,
  parentOpacity?: number,
  /** The 2D placement the camera this layer draws through already carries —
   *  absent for the host camera (see `threeDPlacementOk`). */
  placement3d?: Mat3,
): Renderable {
  // Raster padding grows the placement quad to match the padded stroke texture
  // (0 for unstroked shapes/text/image). Used by every matrix branch below.
  const pad = rasterPadding(layer);
  // Advanced blend modes composite through the BLEND_COMBINE shader (needs the
  // backdrop), so their `blend` stays 'normal' and `advancedBlend` carries the id.
  const advBlend = advancedBlendId(layer.blend);
  let model: Mat3;
  if (layer.matrix) {
    const [a, b, c, d, e, f] = layer.matrix;
    model = Mat3.create();
    model[0] = a;
    model[1] = b;
    model[2] = 0;
    model[3] = c;
    model[4] = d;
    model[5] = 0;
    model[6] = e;
    model[7] = f;
    model[8] = 1;
    // The projected affine maps layer-local PIXELS → comp space (Canvas2D
    // applies it and then draws at (-w/2..w/2)). The renderer's input is the
    // unit quad [0,1]², so scale it up to w×h and centre it BEFORE the affine —
    // without this every 3D layer collapses to a ~1px dot on the GPU path.
    // The anchor rides in that centring step (quadOrigin).
    const o = quadOrigin(layer, pad);
    model = Mat3.multiply(
      model,
      Mat3.multiply(Mat3.scaling(layer.width + 2 * pad, layer.height + 2 * pad), Mat3.translation(o.x, o.y)),
    );
    if (parentMatrix) model = Mat3.multiply(parentMatrix, model);
  } else {
    const localModel = centerModel(layer);
    model = parentMatrix ? Mat3.multiply(parentMatrix, localModel) : localModel;
  }
  const opacity = (parentOpacity !== undefined ? parentOpacity * layer.opacity : layer.opacity);
  
  const isCustomPath = needsShapeRaster(layer);
  const kind = isCustomPath ? 'image' : KIND_MAP[layer.kind];

  // Motion-blur sub-frame samples → fully-composed model matrices, one per
  // sample. 3D samples carry their own projected affine; 2D samples rebuild
  // the layer model with the sampled transform (exactly what Canvas2D's
  // drawComposited does with them).
  let motionSamples: Array<{ modelMatrix: Mat3; opacity: number }> | undefined;
  if (layer.motionSamples && layer.motionSamples.length > 1) {
    // Sub-frame samples rebuild the layer model, so they need the same anchored
    // quad origin the still frame uses — otherwise an anchored layer's blur
    // trail sits `-anchor` away from the layer it belongs to.
    const so = quadOrigin(layer, pad);
    motionSamples = layer.motionSamples.map((s) => {
      let m: Mat3;
      if (s.matrix) {
        const [a, b, c, d, e, f] = s.matrix;
        m = Mat3.create();
        m[0] = a; m[1] = b; m[2] = 0;
        m[3] = c; m[4] = d; m[5] = 0;
        m[6] = e; m[7] = f; m[8] = 1;
        // Same pixel-space → unit-quad bridge as the layer matrix above.
        m = Mat3.multiply(
          m,
          Mat3.multiply(Mat3.scaling(layer.width + 2 * pad, layer.height + 2 * pad), Mat3.translation(so.x, so.y)),
        );
      } else {
        const rad = (s.rotation * Math.PI) / 180;
        const w = (layer.width + 2 * pad) * affineScale(s.scaleX);
        const h = (layer.height + 2 * pad) * affineScale(s.scaleY);
        m = Mat3.multiply(Mat3.compose(s.x, s.y, rad, w, h), Mat3.translation(so.x, so.y));
        if (parentMatrix) m = Mat3.multiply(parentMatrix, m);
      }
      return { modelMatrix: m, opacity: s.opacity };
    });
  }

  // Corner Pin: compose the projective homography onto the RENDER model (and each
  // motion-blur sub-frame), so a keyframed, motion-blurred pin foreshortens on
  // every sample. The affine `layer.matrix` is untouched — this is a render-only
  // stage. Degenerate/identity pins resolve to null and leave the affine path.
  const pinned = resolveCornerPin(layer.cornerPin, model);
  const renderModel = pinned ? pinned.renderModel : model;
  const renderBounds = pinned ? pinned.bounds : boundsOf(model);
  if (pinned && motionSamples) {
    motionSamples = motionSamples.map((s) => ({ modelMatrix: Mat3.multiply(s.modelMatrix, pinned.pin), opacity: s.opacity }));
  }

  // Textured kinds sample a texture that already carries their colour (photo, or
  // text rasterized in its own fill), so they must not be multiplied by a fill.
  // Only shapes use their solid/representative colour.
  const textured = kind === 'image' || kind === 'video' || kind === 'text';
  // A CPU-baked SHAPE or TEXT layer carries content + mask + the FULL effect
  // chain in its texture (`path:`/`text:`), so it is drawn plain — every
  // GPU-side effect input (mask, LUT, colour matrix, spatial effects) is
  // dropped to avoid double-applying. A track matte is a compositing
  // relationship, not baked, so it survives. (Image/video are not baked:
  // dynamic/large content; those still route to Canvas2D.)
  // `layerNeedsCpuBake`, NOT `effectsNeedCpuBake` — the SAME predicate
  // Canvas2DVectorRasterizer gates its bake on. They must agree or the two
  // sides disagree about who owns the effect chain and it is applied twice:
  // fill opacity alone sends a layer down the bake path, and gating this side
  // on the effects term only meant the grade, LUT, mask and spatial effects
  // were baked into the texture AND handed to the GPU on top of it.
  // ONE predicate, kind-dispatched internally (M5b). This site used to pick
  // between two by hand and pick wrong; see layerIsBaked for what that cost.
  // Whichever branch it takes, the bake has already applied the colour grade,
  // any LUT, AND the mask — the mask first, so interior styles shape themselves
  // from the masked silhouette — so none of the three may run again here.
  const baked = layerIsBaked(layer);
  if (baked) cpuBakeStats.noteBakedLayer(layer.effects);
  // Per-quad Lambert gain (Accepts Lights): folded into the draw tint on the
  // affine fallback. Renderables that take the depth-tested group path get the
  // gain UNfolded and carry per-fragment shade data instead (decided after
  // construction below, with the SAME predicate CompositionPass partitions by).
  const applyLighting = (c: Color): Color =>
    layer.lighting ? { r: c.r * layer.lighting[0], g: c.g * layer.lighting[1], b: c.b * layer.lighting[2], a: c.a } : c;
  const out: Renderable = {
    id: layer.id,
    kind,
    modelMatrix: renderModel,
    bounds: renderBounds,
    ...(pinned ? { cornerPin: layer.cornerPin } : {}),
    opacity,
    blend: advBlend > 0 ? 'normal' : layerBlendToGpu(layer.blend),
    ...(advBlend > 0 ? { advancedBlend: advBlend } : {}),
    ...(layer.preserveTransparency ? { preserveTransparency: true } : {}),
    ...(layer.backdropBlur && layer.backdropBlur > 0 ? { backdropBlur: layer.backdropBlur } : {}),
    ...(layer.glass ? { glass: toRenderableGlass(layer.glass) } : {}),
    // AE's per-layer Quality switch. Only emitted for 'draft' — the linear
    // default is what every other layer already gets, and emitting it
    // explicitly would churn the renderable for no behavioural change.
    ...(layer.quality === 'draft' ? { sampling: 'nearest' as const } : {}),
    color: textured ? Color.white() : gradedSolidColor(layer),
    // Texture-backed kinds resolve via the provider
    ...(isCustomPath ? { textureKey: `path:${layer.id}` } : {}),
    ...(!isCustomPath && (kind === 'image' || kind === 'video') ? { textureKey: `asset:${layer.id}` } : {}),
    // Media-slot cover crop. FrameScene already carries `uvRect` and the pass
    // reads `r.uvRect ?? tex.uv`, so this is the whole of the plumbing.
    ...(layer.uvRect ? { uvRect: layer.uvRect } : {}),
    // Premultiplied footage: routes the draw to the shader twin that divides
    // the premultiplication out before grading.
    ...(kind === 'text' ? { textureKey: `text:${layer.id}` } : {}),
    ...(!baked && layer.mask && layer.mask.paths.length > 0 ? { maskTextureKey: `mask:${layer.id}` } : {}),
    // Colour LUT (Levels/Curves/Posterize) on a textured layer: the provider
    // uploads `lut:<id>` and the LUT shader remaps through it after the grade.
    ...(!baked && textured && hasLutEffect(layer) ? { lutTextureKey: `lut:${layer.id}` } : {}),
    ...(matteOf(layer) ? { matte: matteOf(layer)! } : {}),
    ...(textured ? { colorMatrix: baked ? undefined : texturedColorMatrix(layer) } : { sdf: sdfFor(layer) }),
    ...(motionSamples ? { motionSamples } : {}),
    // A baked layer carries content + mask + the whole drawable chain in its
    // texture, so the GPU must not re-apply any of it. The exception is the
    // GPU-ONLY pair (Displace, Motion Tile): the bake has no form for them and
    // skips them, so they are passed through here rather than lost. They land
    // AFTER the baked result regardless of their position in the stack — a real
    // ordering compromise, but a displaced layer beats a silently undisplaced
    // one, and stack order is already exact on the unbaked path.
    effects: baked ? extractSpatialEffects(layer, true) : extractSpatialEffects(layer),
    ...(layer.deformedMesh ? { deformedMesh: normalizeDeformedMesh(layer.deformedMesh, layer.width, layer.height, pad) } : {}),
    // True-3D placement for the depth-tested GPU path. Only meaningful for a
    // layer whose 2D model came from the projected affine (`layer.matrix`),
    // and only when the camera it will be drawn through knows every 2D
    // transform folded into that mat3 (`threeDPlacementOk`):
    //  • host layers (the top-level flatten, an identity parent) draw through
    //    the host camera, which carries no placement;
    //  • a SEALED comp instance with its own 3D frame flattens its children
    //    under the instance placement — and its precomp carries the inner
    //    camera with exactly that placement lifted onto the projection, so
    //    they keep `threeD` in INNER world space and depth-test / light / shadow
    //    through the comp they live in (never the host's camera — the leak
    //    `buildSnapshotCollapseTransforms.test.ts` pins — and that includes an
    //    instance whose frame happens to equal the host's, whose identity
    //    placement used to pass the old gate and draw through the host camera);
    //  • any other extra parent (a transformed inline-collapsed carrier) is a
    //    transform the mat4 world doesn't know about, so the affine path.
    // A corner-pinned layer stays on the 2D pinned path: the 3D path uses its own
    // mat4 (model3dFor) which does not carry the 2D homography, so taking it would
    // silently drop the pin. Combining corner pin with a true-3D camera is a
    // documented follow-up (lift the 3x3 pin into the mat4 in front of mvp3dFor).
    ...(layer.world3d && layer.matrix && !pinned && threeDPlacementOk(parentMatrix, placement3d)
      ? { threeD: { model: model3dFor(layer.world3d, layer) } }
      : {}),
    // Extruded mesh: the vertices are already in the layer's centred pixel
    // frame, so the model is the bare world3d — no unit-quad bridge. Placed
    // after the quad `threeD` so it wins.
    //
    // A textured cap samples the layer's raster with LAYER-BOX UVs, but a
    // rasterized texture (text, path shape) covers the box EXPANDED by its
    // raster padding — the quad path absorbs that by growing the quad, which a
    // mesh cap cannot. So the carrier maps the box into the padded texture via
    // uvRect; pad 0 (media assets keep their own crop rect above) is identity.
    // Same placement gate as the quad above — a sealed comp's extrusion is in
    // its INNER world and draws through the inner camera like its front face.
    ...(layer.extrudedMesh && layer.world3d && layer.matrix && threeDPlacementOk(parentMatrix, placement3d)
      ? {
          threeD: { model: layer.world3d },
          // Gradient walls sample their paint plate, whose texels are UNGRADED.
          // Colour effects reach a texture sample only through `colorMatrix` /
          // `lutTextureKey`, which the spread above sets for textured layers
          // alone — and a bare (non-content) carrier is a 'rect'. So an Invert
          // or a Levels graded a solid extrusion's walls (on the CPU, below)
          // and skipped a gradient-filled one's. Both fields are read only
          // where a texture is sampled, so the solid ranges and any solid draw
          // of this carrier stay exactly as they were.
          ...(!textured && !baked && layer.extrudedMesh.paint && layer.extrudedMesh.ranges.some((r) => r.paintTextured)
            ? {
                colorMatrix: texturedColorMatrix(layer),
                ...(hasLutEffect(layer) ? { lutTextureKey: `lut:${layer.id}` } : {}),
              }
            : {}),
          ...(!layer.uvRect && pad > 0
            ? {
                uvRect: {
                  x: pad / (layer.width + 2 * pad),
                  y: pad / (layer.height + 2 * pad),
                  width: layer.width / (layer.width + 2 * pad),
                  height: layer.height / (layer.height + 2 * pad),
                },
              }
            : {}),
          extrudedMesh: {
            key: layer.extrudedMesh.key,
            vertices: layer.extrudedMesh.vertices,
            indices: layer.extrudedMesh.indices,
            ranges: layer.extrudedMesh.ranges.map((r) => ({
              role: r.role,
              first: r.first,
              count: r.count,
              // Solid ranges are uniform colour, so the layer's colour effects
              // grade them here on the CPU — the mesh equivalent of
              // gradedSolidColor, and what makes an Invert reach the walls.
              color: r.textured || r.paintTextured ? Color.fromHex(r.fill) : gradeFillByEffects(layer, r.fill),
              gain: r.gain,
              ...(r.textured ? { textured: true } : {}),
              // A gradient wall: textured off the paint plate, not the layer.
              ...(r.paintTextured && layer.extrudedMesh!.paint
                ? { textured: true, textureKey: layer.extrudedMesh!.paint.key }
                : {}),
            })),
            // Texture KEYS, matching what MotionRendererBackend feeds under
            // `pbrmap:<layerId>:*` — the same contract every other textureKey
            // here follows.
            ...(layer.extrudedMesh.pbr
              ? {
                  pbr: {
                    ...(layer.extrudedMesh.pbr.normalSrc ? { normalKey: `pbrmap:${layer.id}:n` } : {}),
                    ...(layer.extrudedMesh.pbr.metallicRoughnessSrc ? { metallicRoughnessKey: `pbrmap:${layer.id}:m` } : {}),
                    ...(layer.extrudedMesh.pbr.occlusionSrc ? { occlusionKey: `pbrmap:${layer.id}:o` } : {}),
                    ...(layer.extrudedMesh.pbr.emissiveSrc ? { emissiveKey: `pbrmap:${layer.id}:e` } : {}),
                    normalScale: layer.extrudedMesh.pbr.normalScale,
                    occlusionStrength: layer.extrudedMesh.pbr.occlusionStrength,
                    emissive: layer.extrudedMesh.pbr.emissive,
                  },
                }
              : {}),
          },
        }
      : {}),
  };
  // Accepts-Lights routing: a renderable that will take the depth-tested group
  // path carries per-fragment shade data (the shader lights it for real, with
  // the per-quad gain as its own fallback); anything on the affine painter path
  // gets the per-quad gain folded into its tint exactly as before.
  /*
    Casting is INDEPENDENT of lighting, and of the shade block below.

    A layer that refuses Accepts Lights has no `shade3d` and no `lighting`, and
    it still stands between a lamp and the wall. Attaching this inside the
    `layer.lighting` branch would have made an unlit card transparent to every
    shadow-mapped light — the bug this placement exists to avoid.
  */
  if (layer.castsShadow3d && out.threeD) out.threeD.castsShadow = true;
  if (layer.lighting) {
    if (layer.shade3d && out.threeD && depthEligible3D(out)) {
      out.threeD.shade = {
        specular: layer.shade3d.specular,
        shininess: layer.shade3d.shininess,
        ...(layer.shade3d.metal ? { metal: layer.shade3d.metal } : {}),
        ...(layer.shade3d.roughness !== undefined ? { roughness: layer.shade3d.roughness } : {}),
        ...(layer.shade3d.toonBands !== undefined ? { toonBands: layer.shade3d.toonBands } : {}),
        ...(layer.shade3d.oneSided ? { oneSided: true } : {}),
        ...(layer.shade3d.ambient !== undefined ? { ambient: layer.shade3d.ambient } : {}),
        ...(layer.shade3d.diffuse !== undefined ? { diffuse: layer.shade3d.diffuse } : {}),
        // Advanced-3D axes — sparse, like `metal`: absent is the identity the
        // packer fills in, so untouched materials pack the exact old bytes.
        ...(layer.shade3d.reflectionIntensity !== undefined ? { reflectionIntensity: layer.shade3d.reflectionIntensity } : {}),
        ...(layer.shade3d.reflectionSharpness !== undefined ? { reflectionSharpness: layer.shade3d.reflectionSharpness } : {}),
        ...(layer.shade3d.reflectionRolloff !== undefined ? { reflectionRolloff: layer.shade3d.reflectionRolloff } : {}),
        ...(layer.shade3d.transparency !== undefined ? { transparency: layer.shade3d.transparency } : {}),
        ...(layer.shade3d.transparencyRolloff !== undefined ? { transparencyRolloff: layer.shade3d.transparencyRolloff } : {}),
        ...(layer.shade3d.ior !== undefined ? { ior: layer.shade3d.ior } : {}),
        // Only ever FALSE reaches here — a shadow catcher turned off. Absent is
        // the default (a lit surface receives), which is what every layer
        // emitted before shadow maps existed carries.
        ...(layer.acceptsShadows3d === false ? { acceptsShadows: false } : {}),
        quadGain: layer.lighting,
      };
    } else if (out.color) {
      out.color = applyLighting(out.color);
    }
  }
  return out;
}

/**
 * The matrix a precomp container's CHILDREN compose under: the container's own
 * placement, with its box re-origined to its top-left so a child at (0, 0) in
 * the referenced composition lands at the container's top-left corner.
 *
 * Shared by both composite paths (isolated-to-texture and inline-collapse) on
 * purpose — they disagreed, so whether a nested composition landed in the right
 * place depended on whether it happened to carry a blend mode or an effect.
 *
 * For a full-comp carrier (x = w/2, y = h/2, no rotation, unit scale) this is
 * exactly the identity, which is why plain precomp groups are unaffected.
 */
export function precompChildParent(layer: RenderLayer, parentMatrix: Mat3): Mat3 {
  const rad = (layer.rotation * Math.PI) / 180;
  // The container's anchor shifts its content in the container's own local
  // pixels, exactly as `centerModel` shifts the container's own quad. Both paths
  // must carry it or an anchored precomp lands in two different places
  // depending on whether it happened to need isolation.
  const tOrigin = Mat3.translation(
    -layer.width / 2 - (layer.anchorX ?? 0),
    -layer.height / 2 - (layer.anchorY ?? 0),
  );
  const mPrecomp = Mat3.compose(layer.x, layer.y, rad, affineScale(layer.scaleX), affineScale(layer.scaleY));
  return Mat3.multiply(parentMatrix, Mat3.multiply(mPrecomp, tOrigin));
}

/**
 * True when a precomp container must render through an offscreen texture and
 * composite as ONE unit (RenderBackend.precompLayers contract), rather than
 * being collapsed inline:
 *   • group opacity < 1 over MULTIPLE children — per-child multiplication
 *     double-darkens every overlap, isolation fades the group as a whole;
 *   • a mask, track matte (either side), non-normal blend, or effects on the
 *     container — inline collapse silently dropped all of these;
 *   • an adjustment layer anywhere in the subtree — inline collapse would emit
 *     the grade into the PARENT paint order, so it would re-composite siblings
 *     that sit outside the precomp (AE keeps adjustments scoped to the comp
 *     they live in).
 * Everything else (plain transform, full opacity, single child) keeps the fast
 * inline-collapse path. Exported for unit tests.
 */
export function precompNeedsIsolation(layer: RenderLayer): boolean {
  if (!layer.precompLayers || layer.precompLayers.length === 0) return false;
  // A sealed comp with its own 3D frame needs its own render SCOPE (its camera
  // and lights swapped in for the host's), which only the isolated path has —
  // collapsed inline, its 3D children would draw through the host camera.
  // Normally already isolated by its frame mask; this covers an instance whose
  // referenced size is unknown (no `compSizeOf`, so no frame and no mask).
  if (layer.precompScene3d) return true;
  // A motion-blurred comp layer composites its shutter samples as ONE card —
  // inline collapse would hand each child the container's single pose and
  // drop the samples.
  if (layer.motionSamples && layer.motionSamples.length > 1) return true;
  // A 3D comp card renders its comp flat and is drawn through a perspective
  // quad — only the isolated path has a flat offscreen to draw it from.
  if (layer.quad3d) return true;
  if (layer.blend && layer.blend !== 'normal') return true;
  if (layer.mask && layer.mask.paths.length > 0) return true;
  if (readMatte(layer.matte) && layer.matteSourceId) return true;
  if (layer.isMatteSource) return true;
  if (layer.effects && layer.effects.length > 0) return true;
  if (layer.opacity < 1 && layer.precompLayers.filter((l) => l.visible).length > 1) return true;
  // Adjustment (or a nested precomp that itself needs isolation for one) keeps
  // the grade inside this unit. Checked after the cheap container flags so the
  // common "no adjustment" path does not walk the subtree.
  if (precompSubtreeHasAdjustment(layer.precompLayers)) return true;
  return false;
}

/** True when any layer in a precomp subtree is an adjustment (nested precomps
 *  included). Isolation is required so the grade cannot leak to parent siblings. */
function precompSubtreeHasAdjustment(layers: ReadonlyArray<RenderLayer>): boolean {
  for (const l of layers) {
    if (l.isAdjustment) return true;
    if (l.precompLayers && precompSubtreeHasAdjustment(l.precompLayers)) return true;
  }
  return false;
}

/** An isolated precomp container → a textured renderable carrying its flattened
 *  subtree. CompositionPass renders the subtree offscreen, registers the target
 *  texture under `precomp:<id>`, and then composites this renderable through
 *  the ordinary per-layer machinery (blend / advanced blend / effects / matte),
 *  so the whole group behaves exactly like a single layer. */
function precompToRenderable(
  layer: RenderLayer,
  parentMatrix: Mat3,
  parentOpacity: number,
  placement3d?: Mat3,
): Renderable {
  // Children flatten under the container's OWN transform — the same matrix the
  // inline-collapse path below builds, so the two agree.
  //
  // This used to pass IDENTITY, on the reasoning that children were already in
  // comp space. That held only while every container was a full-comp carrier at
  // the comp centre, where the matrix degenerates to the identity anyway. A comp
  // instance has a real position, size and rotation, and the isolated path threw
  // all three away — so the moment a precomp got a blend mode, a mask, a matte
  // or an effect (the things that force isolation) it jumped back to the origin.
  // A 3D comp CARD (`quad3d`): its comp is drawn FLAT, in its own pixels, and
  // the card is drawn through a perspective homography onto the projected
  // corners (comp px) — `precomp.flat` tells CompositionPass to map the flat
  // children onto the whole offscreen first. A degenerate quad falls back to
  // the ordinary screen-space container.
  const q = layer.quad3d ?? null;
  const cardModel = q
    ? squareToQuad([{ x: q[0], y: q[1] }, { x: q[2], y: q[3] }, { x: q[4], y: q[5] }, { x: q[6], y: q[7] }])
    : null;
  const childParent = cardModel ? Mat3.create() : precompChildParent(layer, parentMatrix);
  // A sealed comp with its own 3D frame: its children's 3D is in the INNER
  // world and draws through the inner camera, which carries `childParent` (see
  // `precompCamera3d`). Anything else inherits the camera it is drawn under —
  // except a flat card's children, which are drawn in the card, not the scene.
  // On a CARD that placement is the identity: the card offscreen holds the comp
  // in its own pixels, and CompositionPass lifts the inner projection onto the
  // offscreen itself — the one map that is not known until the viewport is.
  const own = layer.precompScene3d;
  const inner = flattenLayers(layer.precompLayers!, childParent, 1, [], own ? childParent : cardModel ? undefined : placement3d);
  const local = centerModel(layer);
  const model = cardModel ? Mat3.multiply(parentMatrix, cardModel) : Mat3.multiply(parentMatrix, local);
  const cardBounds = cardModel && q
    ? (() => {
        const pts = [0, 2, 4, 6].map((i) => Mat3.transformPoint(parentMatrix, { x: q[i]!, y: q[i + 1]! }));
        const xs = pts.map((p) => p.x);
        const ys = pts.map((p) => p.y);
        const minX = Math.min(...xs);
        const minY = Math.min(...ys);
        return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
      })()
    : null;
  const advBlend = advancedBlendId(layer.blend);
  return {
    id: layer.id,
    kind: 'image',
    modelMatrix: model,
    bounds: cardBounds ?? boundsOf(model),
    opacity: parentOpacity * layer.opacity,
    blend: advBlend > 0 ? 'normal' : layerBlendToGpu(layer.blend),
    ...(advBlend > 0 ? { advancedBlend: advBlend } : {}),
    ...(layer.preserveTransparency ? { preserveTransparency: true } : {}),
    ...(layer.backdropBlur && layer.backdropBlur > 0 ? { backdropBlur: layer.backdropBlur } : {}),
    ...(layer.glass ? { glass: toRenderableGlass(layer.glass) } : {}),
    color: layer.lighting
      ? { r: layer.lighting[0], g: layer.lighting[1], b: layer.lighting[2], a: 1 }
      : Color.white(),
    textureKey: `precomp:${layer.id}`,
    ...(layer.mask && layer.mask.paths.length > 0 ? { maskTextureKey: `mask:${layer.id}` } : {}),
    ...(matteOf(layer) ? { matte: matteOf(layer)! } : {}),
    ...(layer.isMatteSource ? { matteSource: true } : {}),
    colorMatrix: texturedColorMatrix(layer),
    effects: extractSpatialEffects(layer),
    precomp: {
      renderables: inner,
      ...(own ? precompCamera3d(own, childParent) : {}),
      ...(cardModel ? { flat: { width: layer.width, height: layer.height } } : {}),
    },
    // A motion-blurred comp layer: one model per shutter sample, built exactly
    // like the still model above (`centerModel`) from the sampled world pose.
    // CompositionPass re-expresses them against the isolated offscreen (see
    // `prepareIsolatedPrecomp`), so each sample shifts the same card.
    //
    // A 3D CARD's samples are quads instead — the sub-frame perspective, built
    // the same way its still model is. They are already the card's whole model,
    // so CompositionPass hands them through untouched.
    ...(layer.motionSamples && layer.motionSamples.length > 1
      ? {
          motionSamples: layer.motionSamples.map((s) => {
            if (cardModel && s.quad) {
              const sq = squareToQuad([
                { x: s.quad[0], y: s.quad[1] }, { x: s.quad[2], y: s.quad[3] },
                { x: s.quad[4], y: s.quad[5] }, { x: s.quad[6], y: s.quad[7] },
              ]);
              if (sq) return { modelMatrix: Mat3.multiply(parentMatrix, sq), opacity: parentOpacity * s.opacity };
            }
            const pad = rasterPadding(layer);
            const so = quadOrigin(layer, pad);
            const rad = (s.rotation * Math.PI) / 180;
            const w = (layer.width + 2 * pad) * affineScale(s.scaleX);
            const h = (layer.height + 2 * pad) * affineScale(s.scaleY);
            const m = Mat3.multiply(Mat3.compose(s.x, s.y, rad, w, h), Mat3.translation(so.x, so.y));
            return { modelMatrix: Mat3.multiply(parentMatrix, m), opacity: parentOpacity * s.opacity };
          }),
        }
      : {}),
  };
}

/** A particle emitter layer → a textured renderable sampling its rasterized
 *  field (`particles:<id>`, fed by AppTextureProvider from the deterministic
 *  simulation). The field is layer-box sized with the emitter at its centre, so
 *  the layer transform flies/rotates/scales the whole system; being an ordinary
 *  textured renderable, blend modes, masks, mattes and spatial effects all
 *  compose over it with no special cases. */
function particlesToRenderable(layer: RenderLayer, parentMatrix: Mat3, parentOpacity: number): Renderable {
  const local = centerModel(layer);
  const model = Mat3.multiply(parentMatrix, local);
  const advBlend = advancedBlendId(layer.blend);
  // The config's 'add' transfer composites the field additively over the
  // backdrop (the classic glow look) unless the layer sets its own blend mode.
  const fieldAdd = layer.particles!.blend === 'add' && (!layer.blend || layer.blend === 'normal');
  return {
    id: layer.id,
    kind: 'image',
    modelMatrix: model,
    bounds: boundsOf(model),
    opacity: parentOpacity * layer.opacity,
    blend: advBlend > 0 ? 'normal' : fieldAdd ? 'add' : layerBlendToGpu(layer.blend),
    ...(advBlend > 0 ? { advancedBlend: advBlend } : {}),
    ...(layer.preserveTransparency ? { preserveTransparency: true } : {}),
    ...(layer.backdropBlur && layer.backdropBlur > 0 ? { backdropBlur: layer.backdropBlur } : {}),
    ...(layer.glass ? { glass: toRenderableGlass(layer.glass) } : {}),
    color: Color.white(),
    textureKey: `particles:${layer.id}`,
    ...(layer.mask && layer.mask.paths.length > 0 ? { maskTextureKey: `mask:${layer.id}` } : {}),
    ...(matteOf(layer) ? { matte: matteOf(layer)! } : {}),
    ...(layer.isMatteSource ? { matteSource: true } : {}),
    colorMatrix: texturedColorMatrix(layer),
    effects: extractSpatialEffects(layer),
  };
}

/**
 * Parse a layer's track matte into the renderable's matte descriptor, or null
 * when it has no matte (or its source wasn't resolved).
 *
 * This used to translate four enum values into `{mode, inverted}` here, which
 * meant the renderer had always been on the two-field model while storage and UI
 * were not. Since 1.2.0 the stored shape IS the descriptor, so the translation
 * is gone and only the source-resolution guard remains.
 */
function matteOf(layer: RenderLayer): { mode: 'alpha' | 'luma'; inverted: boolean; sourceId: string } | null {
  const m = readMatte(layer.matte);
  if (!m || !layer.matteSourceId) return null;
  return { mode: m.mode, inverted: m.inverted, sourceId: layer.matteSourceId };
}

/** True when a layer carries an enabled per-channel LUT colour effect. */
function hasLutEffect(layer: RenderLayer): boolean {
  return !!layer.effects?.some((e) => e.enabled !== false && isLutEffect(e.type));
}

/** An adjustment layer → a full-frame grade marker, or null when its grade is
 *  identity (nothing to apply). The grade is an affine colour matrix and/or a
 *  per-channel LUT; CompositionPass re-composites everything beneath through it. */
function adjustmentToRenderable(layer: RenderLayer): Renderable | null {
  const cm = layer.effects && layer.effects.length > 0 ? effectColorMatrix(layer.effects) : IDENTITY_COLOR_MATRIX;
  const lut = hasLutEffect(layer);
  const spatial = extractSpatialEffects(layer);
  const hasGrade = cm !== IDENTITY_COLOR_MATRIX || lut;
  const hasSpatial = spatial && spatial.length > 0;
  if (!hasGrade && !hasSpatial) return null;
  return {
    id: layer.id,
    kind: 'group',
    modelMatrix: Mat3.identity(),
    bounds: { x: 0, y: 0, width: 1, height: 1 },
    opacity: 1,
    blend: 'normal',
    adjustment: {
      ...(cm !== IDENTITY_COLOR_MATRIX ? { colorMatrix: cm } : {}),
      ...(lut ? { lutTextureKey: `lut:${layer.id}` } : {}),
    },
    effects: spatial,
  };
}

/** Colour-grade transform for a textured layer, applied per-pixel in the shader.
 *  Omitted when the stack has no colour effects (identity). */
function texturedColorMatrix(layer: RenderLayer): { m: readonly number[]; offset: readonly number[] } | undefined {
  if (!layer.effects || layer.effects.length === 0) return undefined;
  const cm = effectColorMatrix(layer.effects);
  return cm === IDENTITY_COLOR_MATRIX ? undefined : cm;
}

/** A 2D light as a screen-blended radial-gradient quad — the same technique
 *  Canvas2DBackend.drawLight uses (a real light model is out of scope for a 2D
 *  compositor). The gradient texture (`light:<id>`) is fed by AppTextureProvider;
 *  here we place a 2·radius quad at the light's centre, screen-blend it, and use
 *  intensity as the opacity.
 *
 *  The quad ROTATES. A spot's cone is baked into the wash texture opening along
 *  +X and aimed by turning the quad, so `buildSnapshot`'s resolved aim (the
 *  light's Direction plus its world rotation) sweeps the beam without touching
 *  the texture. This composed 0 before, which is why rotating a light moved
 *  nothing on screen. */
function lightToRenderable(layer: RenderLayer, parentMatrix: Mat3, parentOpacity: number): Renderable {
  // SCREEN radius: `buildSnapshot` has already put the light's reach (or, for a
  // landed beam, its footprint on the lit plane) through the projection. Sizing
  // from the world `radius` here is what made a light dollied deep into the
  // scene throw the same glow as one on the comp plane.
  const size = Math.max(1, layer.light!.screenRadius) * 2;
  const aim = ((layer.rotation ?? 0) * Math.PI) / 180;
  const local = Mat3.multiply(Mat3.compose(layer.x, layer.y, aim, size, size), Mat3.translation(-0.5, -0.5));
  const model = Mat3.multiply(parentMatrix, local);
  const intensity = Math.max(0, Math.min(1, layer.light!.intensity / 100));
  return {
    id: layer.id,
    kind: 'image',
    modelMatrix: model,
    bounds: boundsOf(model),
    opacity: parentOpacity * intensity,
    blend: 'screen',
    color: Color.white(),
    textureKey: `light:${layer.id}`,
    // Marks the quad so CompositionPass can hoist it past a 3D depth run
    // instead of splitting the run (see Renderable.lightWash).
    lightWash: true,
  };
}

/**
 * Layers `flattenLayers` had to skip during the current `snapshotToFrameScene`
 * call — null until one throws. Module state rather than a parameter because
 * the walk recurses through helpers (isolated precomps flatten their own
 * children) and every level reports into the same frame. Reset at the top of
 * each call; read with `takeSceneLayerErrors`.
 */
let sceneLayerErrors: LayerError[] | null = null;

/** The layers the last `snapshotToFrameScene` call skipped, and forget them. */
export function takeSceneLayerErrors(): LayerError[] | null {
  const out = sceneLayerErrors;
  sceneLayerErrors = null;
  return out;
}

function flattenLayers(
  layers: ReadonlyArray<RenderLayer>,
  parentMatrix: Mat3,
  parentOpacity: number,
  result: Renderable[] = [],
  /** The 2D placement the camera these layers draw through carries — absent
   *  for the host camera; a sealed comp's own camera carries its instance
   *  placement (see `threeDPlacementOk`). Inherited by nested groups. */
  placement3d?: Mat3,
): Renderable[] {
  // A layer's leaf renderable, honouring the special content sources (particle
  // fields, isolated precomps) so matte sources and plain draws share one path.
  const toRenderable = (layer: RenderLayer): Renderable =>
    layer.particles
        ? particlesToRenderable(layer, parentMatrix, parentOpacity)
        : layer.precompLayers && layer.precompLayers.length > 0 && precompNeedsIsolation(layer)
          ? precompToRenderable(layer, parentMatrix, parentOpacity, placement3d)
          : layerToRenderable(layer, parentMatrix, parentOpacity, placement3d);

  for (const layer of layers) {
    // Per-layer isolation: a layer that cannot be mapped (a NaN matrix, effect
    // params that break a packer) is left out instead of throwing the whole
    // frame away, and recorded so export refuses the frame. `mark` is a number,
    // so the healthy path allocates nothing.
    const mark = result.length;
    try {
      if (!layer.visible) continue;
      if (layer.isMatteSource) {
        // Emit the source flagged — CompositionPass renders it into MATTE_TARGET on
        // demand for its matted layer, and skips drawing it to the scene. Particle
        // and precomp sources route through their texture-backed renderables (a
        // precomp source used to matte with its comp-sized black carrier rect).
        const src = toRenderable(layer);
        src.matteSource = true;
        result.push(src);
        continue;
      }
      if (layer.isAdjustment) {
        // Adjustment layer: emit a grade marker that re-composites everything below
        // it (GPU parity with Canvas2D applyAdjustment). Skipped only when its grade
        // is identity (no colour/LUT effect) — then it would be a no-op copy.
        const adj = adjustmentToRenderable(layer);
        if (adj) result.push(adj);
        continue;
      }
      // 2D lights: a screen-blended radial-gradient quad (parity with Canvas2D's
      // drawLight). Without this the light's carrier layer (a full-comp black
      // shape) would rasterize as an opaque black rectangle over the frame.
      if (layer.light) {
        result.push(lightToRenderable(layer, parentMatrix, parentOpacity));
        continue;
      }

      // Particle emitter: a textured renderable sampling its rasterized field —
      // never the comp-sized solid its carrier layer describes (which painted the
      // whole comp opaque black before particles had a render path).
      if (layer.particles) {
        result.push(particlesToRenderable(layer, parentMatrix, parentOpacity));
        continue;
      }

      if (layer.precompLayers && layer.precompLayers.length > 0) {
        if (precompNeedsIsolation(layer)) {
          // True isolation: render offscreen, composite as one unit with the
          // container's opacity / blend / mask / matte / effects.
          result.push(precompToRenderable(layer, parentMatrix, parentOpacity, placement3d));
          continue;
        }
        // Fast path (plain transform + full/single-child opacity, no compositing
        // features): collapse inline — transform folds, opacity multiplies. The
        // children draw under the same camera, so they inherit its placement.
        flattenLayers(
          layer.precompLayers,
          precompChildParent(layer, parentMatrix),
          parentOpacity * layer.opacity,
          result,
          placement3d,
        );
      } else if (
        layer.kind === 'video' && layer.frameBlend && layer.frameBlend.mode === 'pixelMotion'
        // A PAINTED clip never routes to the blend keys: its feed draws the
        // strokes onto one frame under `asset:` (MotionRendererBackend), so it
        // must reach the leaf branch below or it would sample a texture nobody
        // uploaded. Same guard on Frame Mix.
        && !hasPaintStrokes(layer.paint)
      ) {
        // Pixel Motion: ONE renderable sampling the motion-compensated
        // in-between the texture feed computes (optical-flow warp of the two
        // bracket frames — see rendering/pixelMotion.ts). The feed falls back to
        // the ordinary `vfm:` video ladder when either bracket frame has not
        // decoded yet, so the degradation is nearest-frame, never a hole.
        const r = layerToRenderable(layer, parentMatrix, parentOpacity, placement3d);
        r.textureKey = `vfm:${layer.id}`;
        result.push(r);
      } else if (layer.kind === 'video' && layer.frameBlend && !hasPaintStrokes(layer.paint)) {
        // Frame blending (Frame Mix): the two decoded frames bracketing the
        // playhead cross-dissolve — frame A full, frame B at the sub-frame
        // weight on top, exactly Canvas2D's drawBlendedVideo. The feed uploads
        // `vfa:`/`vfb:` from the decoded-frame cache (falling back to the live
        // element's frame for both until the cache lands, which degrades to
        // nearest-frame instead of showing nothing).
        const a = layerToRenderable(layer, parentMatrix, parentOpacity, placement3d);
        a.textureKey = `vfa:${layer.id}`;
        result.push(a);
        const b = layerToRenderable(layer, parentMatrix, parentOpacity, placement3d);
        b.id = `${layer.id}::fb`;
        b.textureKey = `vfb:${layer.id}`;
        b.opacity = a.opacity * layer.frameBlend.weight;
        result.push(b);
      } else {
        // Leaf layer: map to renderable with parent transformations applied
        result.push(layerToRenderable(layer, parentMatrix, parentOpacity, placement3d));
      }
    } catch (err) {
      // Roll back what this layer pushed before it threw (a Frame Mix pair
      // pushes its first half before building the second).
      result.length = mark;
      sceneLayerErrors = pushLayerError(sceneLayerErrors, { layerId: layer.id, stage: 'scene', message: errorMessage(err) });
    }
  }
  return result;
}

/** A gradient composition background as a full-comp quad sampling the baked
 *  `bg-gradient` texture (fed by AppTextureProvider). Drawn first so every layer
 *  composites over it — the GPU parity for a gradient `background`. */
function gradientBackgroundRenderable(width: number, height: number): Renderable {
  const model = Mat3.multiply(
    Mat3.compose(width / 2, height / 2, 0, width, height),
    Mat3.translation(-0.5, -0.5),
  );
  return {
    id: 'bg-gradient',
    kind: 'image',
    modelMatrix: model,
    bounds: boundsOf(model),
    opacity: 1,
    blend: 'normal',
    color: Color.white(),
    textureKey: 'bg-gradient',
  };
}

/**
 * The synthesized faces of one extrusion take the SAME render path as the layer
 * they belong to.
 *
 * ── The failure this closes ─────────────────────────────────────────────────
 *
 * `depthEligible3D` is asked per RENDERABLE, but an extrusion is one OBJECT
 * spread across up to fourteen of them, and the predicate cannot see that. So a
 * per-renderable exclusion cuts a solid in half: `CompositionPass.renderList`
 * collects CONTIGUOUS runs of eligible renderables, so the excluded faces drop
 * to the affine painter path — which has no depth state at all — while their
 * siblings stay in the depth-tested group.
 *
 * Observed with glass. Glass and backdrop blur are excluded for a good reason
 * (they read what is composited beneath, which the depth pass cannot supply),
 * and they reached the front face and the back cap but not the four walls. The
 * body went to the depth group, the caps went to the painter, and the glass
 * panel visibly detached from the solid with its rim overlapping the top wall.
 *
 * ── Why this is a pass over the result, not a rule in the predicate ─────────
 *
 * The correct answer is not "make glass eligible" — it is not — but "do not
 * split the object". That is a statement about a SET of renderables, which a
 * per-renderable predicate cannot express whatever rules are added to it. So
 * the agreement is enforced where the whole set exists, by asking the REAL
 * `depthEligible3D` rather than by restating its rules. A future exclusion
 * added to that predicate is therefore honoured here automatically, which is
 * the property the glass case did not have.
 *
 * Faces are identified by the `::ext-` id convention `buildSnapshot` mints
 * them with — the same convention that keeps them out of hit-testing and the
 * timeline.
 */
const EXT_FACE_MARK = '::ext-';

/** `foo::ext-r` → `foo`; anything else → itself. */
function extrusionBaseId(id: string): string {
  const at = id.indexOf(EXT_FACE_MARK);
  return at < 0 ? id : id.slice(0, at);
}

function enforceExtrusionPathAgreement(renderables: Renderable[]): void {
  // Recurse FIRST: a sealed precomp renders through its own list, so an
  // extrusion inside one would otherwise be missed entirely — and a nested comp
  // is exactly where nobody would think to look for a body that came apart.
  for (const r of renderables) {
    if (r.precomp) enforceExtrusionPathAgreement(r.precomp.renderables as Renderable[]);
  }
  // Three linear passes rather than a nested scan. The obvious version asks,
  // for each renderable, whether any OTHER renderable is one of its faces —
  // which is quadratic, and this runs on every frame of every scene including
  // the overwhelming majority that contain no extrusion at all.
  const owners = new Set<string>();
  for (const r of renderables) {
    if (r.id.includes(EXT_FACE_MARK)) owners.add(extrusionBaseId(r.id));
  }
  if (owners.size === 0) return;

  const split = new Set<string>();
  for (const r of renderables) {
    const base = extrusionBaseId(r.id);
    if (!owners.has(base)) continue;
    if (!depthEligible3D(r)) split.add(base);
  }
  if (split.size === 0) return;

  // Only ever sets the flag: the resolution of a disagreement is that the whole
  // object leaves the depth group, never that an ineligible face is forced into
  // it. Glass genuinely cannot be depth-tested — the fix is to stop the body
  // splitting, not to pretend the exclusion was wrong.
  for (const r of renderables) {
    if (split.has(extrusionBaseId(r.id))) r.depthExempt = true;
  }
  // An extruded MESH has no affine form — the painter path would draw its
  // carrier as a flat quad in the wall colour over the object. Drop it with
  // the object that left the depth group; the front face still draws.
  dropMeshesOutsideDepthPath(renderables);
}

function dropMeshesOutsideDepthPath(renderables: Renderable[]): void {
  for (let i = renderables.length - 1; i >= 0; i--) {
    const r = renderables[i]!;
    if (r.extrudedMesh && (r.depthExempt || !r.threeD)) renderables.splice(i, 1);
  }
}

function dropMeshesEverywhere(renderables: Renderable[]): void {
  for (let i = renderables.length - 1; i >= 0; i--) {
    const r = renderables[i]!;
    // A sealed comp with its own camera has a depth path of its own, whatever
    // the host has — its meshes stay.
    if (r.precomp && !r.precomp.camera3d) dropMeshesEverywhere(r.precomp.renderables as Renderable[]);
    if (r.extrudedMesh) renderables.splice(i, 1);
  }
}

export function snapshotToFrameScene(snapshot: RenderSnapshot): FrameScene {
  // Closes the previous frame's CPU-bake tally; the layer walk below fills the next.
  cpuBakeStats.beginFrame();
  sceneLayerErrors = null;
  const renderables = flattenLayers(snapshot.layers, Mat3.identity(), 1);
  enforceExtrusionPathAgreement(renderables);
  // Gradient background sits behind everything (solids stay on the flat
  // composition.background below, which also serves as the fallback plate).
  const bgPaint = snapshot.backgroundPaint;
  if (bgPaint && bgPaint.type !== 'solid' && !snapshot.transparent) {
    renderables.unshift(gradientBackgroundRenderable(snapshot.width, snapshot.height));
  }
  const checkEffects = (layers: ReadonlyArray<RenderLayer>): boolean => {
    for (const l of layers) {
      if (l.effects && l.effects.length > 0) return true;
      if (l.precompLayers && checkEffects(l.precompLayers)) return true;
    }
    return false;
  };
  // Advanced blend layers need the samplable SCENE_COLOR_TARGET (they sample the
  // backdrop), same precondition as effects — force it on when any are present.
  // Preserve Underlying Transparency samples the accumulated backdrop's ALPHA,
  // so it has the same precondition — and it can be on with a Normal blend
  // (advancedBlend 0), which is the common case, so testing advancedBlend alone
  // would miss every one of them.
  const hasAdvancedBlend = renderables.some(
    (r) => (r.advancedBlend ?? 0) > 0 || !!r.preserveTransparency);
  // Backdrop blur samples the scene beneath the layer — same precondition.
  // Glass samples the backdrop too, and can legitimately run with a blur
  // radius of 0 (clear glass), so testing backdropBlur alone would miss it.
  const hasBackdropBlur = renderables.some((r) => (r.backdropBlur ?? 0) > 0 || !!r.glass);
  // 3D depth groups need a depth-capable colour target; the surface has no
  // guaranteed depth attachment, so any 3D frame routes through the scene
  // colour target too (it is declared with depth: true).
  const checkThreeD = (rs: ReadonlyArray<Renderable>): boolean =>
    rs.some((r) => !!r.threeD || (r.precomp ? checkThreeD(r.precomp.renderables) : false));
  const has3d = !!snapshot.camera3d && checkThreeD(renderables);
  if (!has3d) dropMeshesEverywhere(renderables);
  const hasEffects = checkEffects(snapshot.layers) || hasAdvancedBlend || hasBackdropBlur || has3d;
  return {
    composition: {
      id: 'composition',
      size: { width: snapshot.width, height: snapshot.height },
      background: snapshot.transparent ? Color.transparent() : Color.fromHex(snapshot.background),
    },
    renderables,
    hasEffects,
    // Dancing Dissolve's re-roll: the comp FRAME INDEX, computed here where the
    // playhead is known, so the shader needs no clock and export (which renders
    // the same snapshot times) speckles identically to preview. Rounded, not
    // floored — buildSnapshot's own frame derivations round, and a float time a
    // hair under the boundary flooring to the previous frame would make one
    // frame's speckle appear twice.
    dissolveFrame: Math.round((snapshot.time ?? 0) * (snapshot.fps ?? 30)),
    ...(has3d ? { camera3d: snapshot.camera3d } : {}),
    ...(has3d && snapshot.lights3d && snapshot.lights3d.length > 0 ? { lights3d: snapshot.lights3d } : {}),
    // The reflection half of the same environment light whose irradiance rig
    // rides `lights3d`. Gated on `has3d` like everything else on the depth
    // path: with no 3D layer there is nothing to reflect in, and shipping the
    // atlas anyway would upload a texture no draw binds.
    ...(has3d && snapshot.envMap ? { envMap: snapshot.envMap } : {}),
    // Ambient occlusion, handed straight through. Gated on `has3d` like every
    // other depth-path field: with no 3D layer there is no run to prepass, and
    // the pass would render three targets for nothing.
    ...(has3d && snapshot.ssao?.enabled ? { ssao: snapshot.ssao } : {}),
  };
}

/**
 * Map the app's comp→canvas view onto a renderer camera state.
 *   Canvas2D: canvasPx = compPx·scale + offset
 *   Camera2D: screenPx = (world − center)·zoom + viewport/2
 * ⇒ zoom = scale, center = (viewport/2 − offset)/scale. Falls back to a centered
 * fit (matching Canvas2D's 0.92 contain) when no camera view is supplied.
 */
export function viewToCamera(
  view: RenderView | undefined,
  comp: { width: number; height: number },
  cssWidth: number,
  cssHeight: number,
): { center: { x: number; y: number }; zoom: number } {
  if (view) {
    const zoom = view.scale;
    return {
      zoom,
      center: { x: (cssWidth / 2 - view.offsetX) / zoom, y: (cssHeight / 2 - view.offsetY) / zoom },
    };
  }
  const zoom = Math.min(cssWidth / comp.width, cssHeight / comp.height) * 0.92;
  return { zoom, center: { x: comp.width / 2, y: comp.height / 2 } };
}
