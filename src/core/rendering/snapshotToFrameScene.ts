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

import { Mat3, Color, depthEligible3D, squareToQuad, isConvexQuad, isIdentityQuad, type BlendMode, type FrameScene, type Renderable, type RenderableKind, type RenderableSdf, type Quad } from '@motion/renderer';
import { Matrix4Math } from '@motion/scene';
import type { LayerBlendMode } from '@core/effects/blendMode';
import { effectColorMatrix, applyColorMatrix, IDENTITY_COLOR_MATRIX } from '@core/effects/effectColorMatrix';
import { isLutEffect } from '@core/effects/colorLut';
import { readCubeLutParam } from '@core/effects/cubeLut';
import { readMatte } from '@core/effects/matte';
import { effectNumber, effectParam, paramsOf, withAlpha, isGpuOnlyEffect } from '@core/effects/effects';
import { effectById, beginEffectDraw, endEffectDraw } from '@core/plugins/pluginEffects';
import { layerParamNames, packParameters, effectSpreadFor } from '@core/plugins/effectSchema';
import { layerIsBaked } from '@core/effects/effectBake';
import { parseHex } from '@core/effects/canvas2dEffects';
import { rgbToHsl } from '@core/effects/colorSpace';
import { rasterPadding } from './raster/vectorDraw';
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

/** The layer's solid fill graded by its colour effects (brightness/contrast/…),
 *  applied on the CPU since the colour is uniform. Spatial effects (blur/glow)
 *  are ignored here — they need offscreen passes. */
function gradedSolidColor(layer: RenderLayer): Color {
  const base = Color.fromHex(representativeColor(layer));
  if (!layer.effects || layer.effects.length === 0) return base;
  const cm = effectColorMatrix(layer.effects);
  const [r, g, b] = applyColorMatrix(cm, [base.r, base.g, base.b]);
  return { r, g, b, a: base.a };
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
  const radii = layer.cornerRadii;
  if (radii) {
    const [tl, tr, br, bl] = radii;
    if (tl === tr && tr === br && br === bl) {
      return { shape: 'rounded', radiusPx: tl, width: layer.width, height: layer.height };
    }
    return { shape: 'rounded', radiusPx: 0, width: layer.width, height: layer.height };
  }
  return { shape: 'rounded', radiusPx: layer.cornerRadius ?? 0, width: layer.width, height: layer.height };
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
  for (const e of layer.effects) {
    if (e.enabled === false) continue;
    if (onlyGpuOnly && !isGpuOnlyEffect(e.type)) continue;
    // Read each effect's own params. Glow's colour, Drop Shadow's angle and
    // Gradient Ramp's endpoints were hardcoded here and unreachable from the UI.
    const n = (k: string): number => effectNumber(e, k);
    const c = (k: string, alpha = 1): Color =>
      Color.fromHex(withAlpha(String(effectParam(e, k) ?? '#000000'), alpha));

    if (e.type === 'blur') spatial.push({ type: 'blur', radiusPx: n('amount') });
    if (e.type === 'glow') {
      spatial.push({ type: 'glow', radiusPx: n('radius'), color: c('color', n('intensity') / 100) });
    }
    if (e.type === 'drop-shadow') {
      const rad = (n('angle') * Math.PI) / 180;
      spatial.push({
        type: 'drop-shadow',
        radiusPx: n('softness'),
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
      spatial.push({ type: 'stroke', widthPx: n('width'), color: c('color', n('opacity') / 100) });
    }
    if (e.type === 'sharpen') {
      spatial.push({ type: 'sharpen', amount: n('amount') / 100 });
    }
    if (e.type === 'noise') {
      spatial.push({ type: 'noise', amount: n('amount') / 100, evolution: n('evolution'), monochrome: e.params?.monochrome !== false });
    }
    /*
      A plugin's effect.

      Matched by the DOT in its type rather than against a list, because the set
      is not knowable at build time — it is whatever is installed. Namespacing
      (`<pluginId>.<effectId>`) is what makes that safe: no built-in type
      contains a dot, so this branch cannot swallow one.

      Everything the renderer needs is resolved HERE. The parameter layout comes
      from the plugin's manifest, which only this side knows about; the pass
      receives a shader name and packed bytes and stays ignorant of plugins.
    */
    if (e.type.includes('.')) {
      const registered = effectById(e.type);
      /*
        Emitted only when READY.

        `pending` has no compiled pipeline yet, `failed` had its shader refused,
        and `disabled` was implicated in a device loss. Drawing any of them asks
        the renderer for a pipeline that does not exist — and for `disabled` it
        would silently undo the protection the user was given, which is the
        worst of the three.
      */
      if (registered?.state === 'ready') {
        /*
          The second texture, when this effect declared one.

          Same shape and the same unset rule as `displacement-map` above — node
          id === renderable id, empty or non-string means unset — and the same
          fallback: unset self-samples rather than being skipped. An effect
          whose map is missing should draw the layer against itself, which is
          visibly wrong and debuggable, rather than disappear.

          Read from whatever the manifest named its layer parameter, not a fixed
          key, so the scene follows the author's own vocabulary.
        */
        const [layerParam] = layerParamNames(registered.contribution.params);
        const mapRaw = layerParam ? paramsOf(e)[layerParam] : undefined;
        const mapLayerId = typeof mapRaw === 'string' && mapRaw !== '' ? mapRaw : undefined;

        // Packed ONCE and shared by every pass. They all read the same
        // parameter block from the same offsets; only the host's own fields
        // differ per pass, and the renderer writes those.
        // `packParameters` hands back an ArrayBuffer; the scene carries a typed
        // view so the renderer never has to know the element size.
        const params = new Float32Array(packParameters(
          registered.layout.layout,
          registered.layout.size,
          paramsOf(e),
        ));

        /*
          ★ One spatial entry PER PASS. This is what executes a chain.

          The renderer's spatial-effects list already ping-pongs between
          offscreen targets — that is how a layer with a blur and then a glow
          works — so a chain needs no new mechanism, only its passes emitted in
          order. The host sequences and allocates; the plugin never sees a
          target, which is the promise multi-pass had to keep.

          `passIndex` travels as a field rather than being baked into `params`
          because the value beside it in the shader, `texelSize`, depends on the
          size of the target being drawn into. Only the renderer knows that, so
          the whole host block is written there and this side stays out of it.
        */
        /*
          Does anything in this chain want the original back?

          Decided HERE, once per chain, because this is the only side that
          knows how the flat list of scene entries below groups into chains.
          The renderer sees N independent entries and could not work it out.

          Per chain rather than always, because capturing costs a full-screen
          blit every frame and the overwhelming majority of chains — every
          separable blur — never look at it.
        */
        const chainReadsOrigin = registered.passes.some((p) => p.readsOrigin);

        /*
          How far this effect reaches outside the layer, at THIS frame's
          parameter values.

          Evaluated here because this is the side that holds them. A number
          fixed at install would have to be the animated worst case — a blur
          going 0 → 40 would reserve 40px of margin on the frame where its
          radius is 0, on every 3D layer carrying it.

          Emitted on pass 0 only. The margin is a property of the EFFECT, and
          `effectSpreadPx` takes the max over the list, so repeating it on
          every pass would be the same number counted several times — harmless
          today and exactly the sort of thing that stops being harmless when
          someone later sums instead of maxing.
        */
        const spreadPx = effectSpreadFor(registered.contribution, paramsOf(e));

        for (const pass of registered.passes) {
          spatial.push({
            type: 'plugin',
            shader: pass.shaderId,
            passIndex: pass.index,
            // Only when it is not 1, so a single-pass effect's scene entry is
            // byte-identical to what it was before chains existed.
            ...(pass.scale !== 1 ? { passScale: pass.scale } : {}),
            // Pass 0 takes the snapshot; the passes that asked read it.
            ...(chainReadsOrigin && pass.index === 0 ? { capturesOrigin: true } : {}),
            ...(pass.readsOrigin ? { readsOrigin: true } : {}),
            ...(spreadPx > 0 && pass.index === 0 ? { spreadPx } : {}),
            // What the SHADER asks for, not what the user chose — see the field's
            // own note. Set from the declaration so an effect with no map picked
            // yet still gets a material whose layout matches its bindings.
            ...(layerParam ? { readsMap: true } : {}),
            ...(mapLayerId ? { mapLayerId } : {}),
            params,
            /*
              Attribution names the EFFECT, not the pass.

              A device loss inside the vertical half of a blur is the blur's
              fault as far as a user is concerned, and `disableEffect` keys off
              the effect id — reporting `acme.blur#vertical` would name
              something they cannot find in any list.
            */
            onDraw: {
              begin: () => beginEffectDraw(registered.id),
              end: () => endEffectDraw(),
            },
          });
        }
      }
    }
  }
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
  // A shape carrying a Canvas2D-only effect is CPU-baked (content + mask +
  // full effect chain) into its `path:` texture — those effects have no GPU
  // shader form and otherwise silently no-op.
  if (layerIsBaked(layer)) return true;
  return false;
}

export function layerToRenderable(layer: RenderLayer, parentMatrix?: Mat3, parentOpacity?: number): Renderable {
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
    // layer whose 2D model came from the projected affine (`layer.matrix`) —
    // an inline-collapsed precomp child folds an extra parent transform into
    // the mat3 that the mat4 world doesn't know about, so it must keep the
    // affine path (the top-level flatten passes an identity parent).
    // A corner-pinned layer stays on the 2D pinned path: the 3D path uses its own
    // mat4 (model3dFor) which does not carry the 2D homography, so taking it would
    // silently drop the pin. Combining corner pin with a true-3D camera is a
    // documented follow-up (lift the 3x3 pin into the mat4 in front of mvp3dFor).
    ...(layer.world3d && layer.matrix && !pinned && (!parentMatrix || isIdentityMat3(parentMatrix))
      ? { threeD: { model: model3dFor(layer.world3d, layer) } }
      : {}),
  };
  // Accepts-Lights routing: a renderable that will take the depth-tested group
  // path carries per-fragment shade data (the shader lights it for real, with
  // the per-quad gain as its own fallback); anything on the affine painter path
  // gets the per-quad gain folded into its tint exactly as before.
  if (layer.lighting) {
    if (layer.shade3d && out.threeD && depthEligible3D(out)) {
      out.threeD.shade = {
        specular: layer.shade3d.specular,
        shininess: layer.shade3d.shininess,
        ...(layer.shade3d.metal ? { metal: layer.shade3d.metal } : {}),
        ...(layer.shade3d.oneSided ? { oneSided: true } : {}),
        quadGain: layer.lighting,
      };
    } else if (out.color) {
      out.color = applyLighting(out.color);
    }
  }
  return out;
}

/**
 * True when a precomp container must render through an offscreen texture and
 * composite as ONE unit (RenderBackend.precompLayers contract), rather than
 * being collapsed inline:
 *   • group opacity < 1 over MULTIPLE children — per-child multiplication
 *     double-darkens every overlap, isolation fades the group as a whole;
 *   • a mask, track matte (either side), non-normal blend, or effects on the
 *     container — inline collapse silently dropped all of these.
 * Everything else (plain transform, full opacity, single child) keeps the fast
 * inline-collapse path. Exported for unit tests.
 */
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

export function precompNeedsIsolation(layer: RenderLayer): boolean {
  if (!layer.precompLayers || layer.precompLayers.length === 0) return false;
  if (layer.blend && layer.blend !== 'normal') return true;
  if (layer.mask && layer.mask.paths.length > 0) return true;
  if (readMatte(layer.matte) && layer.matteSourceId) return true;
  if (layer.isMatteSource) return true;
  if (layer.effects && layer.effects.length > 0) return true;
  if (layer.opacity < 1 && layer.precompLayers.filter((l) => l.visible).length > 1) return true;
  return false;
}

/** An isolated precomp container → a textured renderable carrying its flattened
 *  subtree. CompositionPass renders the subtree offscreen, registers the target
 *  texture under `precomp:<id>`, and then composites this renderable through
 *  the ordinary per-layer machinery (blend / advanced blend / effects / matte),
 *  so the whole group behaves exactly like a single layer. */
function precompToRenderable(layer: RenderLayer, parentMatrix: Mat3, parentOpacity: number): Renderable {
  // Children flatten under the container's OWN transform — the same matrix the
  // inline-collapse path below builds, so the two agree.
  //
  // This used to pass IDENTITY, on the reasoning that children were already in
  // comp space. That held only while every container was a full-comp carrier at
  // the comp centre, where the matrix degenerates to the identity anyway. A comp
  // instance has a real position, size and rotation, and the isolated path threw
  // all three away — so the moment a precomp got a blend mode, a mask, a matte
  // or an effect (the things that force isolation) it jumped back to the origin.
  const inner = flattenLayers(layer.precompLayers!, precompChildParent(layer, parentMatrix), 1);
  const local = centerModel(layer);
  const model = Mat3.multiply(parentMatrix, local);
  const advBlend = advancedBlendId(layer.blend);
  return {
    id: layer.id,
    kind: 'image',
    modelMatrix: model,
    bounds: boundsOf(model),
    opacity: parentOpacity * layer.opacity,
    blend: advBlend > 0 ? 'normal' : layerBlendToGpu(layer.blend),
    ...(advBlend > 0 ? { advancedBlend: advBlend } : {}),
    ...(layer.preserveTransparency ? { preserveTransparency: true } : {}),
    ...(layer.backdropBlur && layer.backdropBlur > 0 ? { backdropBlur: layer.backdropBlur } : {}),
    ...(layer.glass ? { glass: toRenderableGlass(layer.glass) } : {}),
    color: Color.white(),
    textureKey: `precomp:${layer.id}`,
    ...(layer.mask && layer.mask.paths.length > 0 ? { maskTextureKey: `mask:${layer.id}` } : {}),
    ...(matteOf(layer) ? { matte: matteOf(layer)! } : {}),
    ...(layer.isMatteSource ? { matteSource: true } : {}),
    colorMatrix: texturedColorMatrix(layer),
    effects: extractSpatialEffects(layer),
    precomp: { renderables: inner },
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
 *  intensity as the opacity. */
function lightToRenderable(layer: RenderLayer, parentMatrix: Mat3, parentOpacity: number): Renderable {
  const radius = Math.max(1, layer.light!.radius);
  const size = radius * 2;
  const local = Mat3.multiply(Mat3.compose(layer.x, layer.y, 0, size, size), Mat3.translation(-0.5, -0.5));
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
  };
}

function flattenLayers(
  layers: ReadonlyArray<RenderLayer>,
  parentMatrix: Mat3,
  parentOpacity: number,
  result: Renderable[] = []
): Renderable[] {
  // A layer's leaf renderable, honouring the special content sources (particle
  // fields, isolated precomps) so matte sources and plain draws share one path.
  const toRenderable = (layer: RenderLayer): Renderable =>
    layer.particles
      ? particlesToRenderable(layer, parentMatrix, parentOpacity)
      : layer.precompLayers && layer.precompLayers.length > 0 && precompNeedsIsolation(layer)
        ? precompToRenderable(layer, parentMatrix, parentOpacity)
        : layerToRenderable(layer, parentMatrix, parentOpacity);

  for (const layer of layers) {
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
        result.push(precompToRenderable(layer, parentMatrix, parentOpacity));
        continue;
      }
      // Fast path (plain transform + full/single-child opacity, no compositing
      // features): collapse inline — transform folds, opacity multiplies.
      flattenLayers(
        layer.precompLayers,
        precompChildParent(layer, parentMatrix),
        parentOpacity * layer.opacity,
        result,
      );
    } else if (layer.kind === 'video' && layer.frameBlend) {
      // Frame blending (Frame Mix): the two decoded frames bracketing the
      // playhead cross-dissolve — frame A full, frame B at the sub-frame
      // weight on top, exactly Canvas2D's drawBlendedVideo. The feed uploads
      // `vfa:`/`vfb:` from the decoded-frame cache (falling back to the live
      // element's frame for both until the cache lands, which degrades to
      // nearest-frame instead of showing nothing).
      const a = layerToRenderable(layer, parentMatrix, parentOpacity);
      a.textureKey = `vfa:${layer.id}`;
      result.push(a);
      const b = layerToRenderable(layer, parentMatrix, parentOpacity);
      b.id = `${layer.id}::fb`;
      b.textureKey = `vfb:${layer.id}`;
      b.opacity = a.opacity * layer.frameBlend.weight;
      result.push(b);
    } else {
      // Leaf layer: map to renderable with parent transformations applied
      result.push(layerToRenderable(layer, parentMatrix, parentOpacity));
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
}

export function snapshotToFrameScene(snapshot: RenderSnapshot): FrameScene {
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
  const hasEffects = checkEffects(snapshot.layers) || hasAdvancedBlend || hasBackdropBlur || has3d;
  return {
    composition: {
      id: 'composition',
      size: { width: snapshot.width, height: snapshot.height },
      background: snapshot.transparent ? Color.transparent() : Color.fromHex(snapshot.background),
    },
    renderables,
    hasEffects,
    ...(has3d ? { camera3d: snapshot.camera3d } : {}),
    ...(has3d && snapshot.lights3d && snapshot.lights3d.length > 0 ? { lights3d: snapshot.lights3d } : {}),
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
