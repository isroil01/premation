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

import { Mat3, Color, depthEligible3D, type BlendMode, type FrameScene, type Renderable, type RenderableKind, type RenderableSdf } from '@motion/renderer';
import { Matrix4Math } from '@motion/scene';
import type { LayerBlendMode } from '@core/effects/blendMode';
import { effectColorMatrix, applyColorMatrix, IDENTITY_COLOR_MATRIX } from '@core/effects/effectColorMatrix';
import { isLutEffect } from '@core/effects/colorLut';
import { getMatteMode } from '@core/effects/matte';
import { effectNumber, effectParam, withAlpha } from '@core/effects/effects';
import { effectsNeedCpuBake, layerNeedsCpuBake } from '@core/effects/effectBake';
import { rasterPadding } from './raster/vectorDraw';
import type { RenderSnapshot, RenderLayer, RenderView } from './RenderBackend';

/**
 * Map a layer blend mode to the renderer's portable `BlendMode` union. The live
 * Canvas2D path renders the full AE set natively; the GPU union is narrower, so
 * modes without a direct GPU op fall back to their nearest family member
 * (dodge→screen, burn→multiply, light variants→overlay, HSL modes→normal) until
 * per-mode GPU shaders land. Keep this in sync with `gpuSafe` in blendMode.ts.
 */
export function layerBlendToGpu(mode: LayerBlendMode | undefined): BlendMode {
  switch (mode) {
    case 'multiply': return 'multiply';
    case 'screen': return 'screen';
    case 'overlay': return 'overlay';
    case 'add': return 'add';
    case 'darken': return 'darken';
    case 'lighten': return 'lighten';
    case 'color-dodge': return 'screen';   // brighten family
    case 'color-burn': return 'multiply';  // darken family
    case 'hard-light':
    case 'soft-light': return 'overlay';   // contrast family
    case 'difference': return 'subtract';
    case 'exclusion': return 'screen';
    case 'hue':
    case 'saturation':
    case 'color':
    case 'luminosity':                     // no GPU HSL op yet
    case 'normal':
    default: return 'normal';
  }
}

/**
 * Advanced blend-mode id (1..15) for modes fixed-function GL can't do correctly
 * (they need the backdrop as a shader input). 0 = a mode the fixed-function
 * `blend` path handles (normal/add). Multiply/screen/darken/lighten ARE routed
 * through the combine too, because the fixed-function versions mishandle source
 * alpha. Ids match the BLEND_COMBINE shader's mode selector (builtin.ts).
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
    default: return 0; // normal / add → simple fixed-function blend
  }
}

const KIND_MAP: Record<RenderLayer['kind'], RenderableKind> = {
  shape: 'rect',
  text: 'text',
  image: 'image',
  video: 'video',
};

/** Center-pivot model matrix: unit-quad centre → (x,y), rotated/scaled in place.
 *  The quad grows by the layer's raster padding so a stroked shape's padded
 *  texture (which includes the outer stroke band) places 1:1 without stretching;
 *  padding is 0 for unstroked shapes/text/image, so those are unaffected. */
function centerModel(layer: RenderLayer): Mat3 {
  const rad = (layer.rotation * Math.PI) / 180;
  const pad = rasterPadding(layer);
  const w = (layer.width + 2 * pad) * (layer.scaleX || 1);
  const h = (layer.height + 2 * pad) * (layer.scaleY || 1);
  const skew = layer.skew ?? 0;
  const base = skew === 0
    // The un-skewed path stays on `Mat3.compose` so nothing about existing
    // layers changes — skew is strictly additive.
    ? Mat3.compose(layer.x, layer.y, rad, w, h)
    : composeSkewed(layer.x, layer.y, rad, w, h, skew, layer.skewAxis ?? 0);
  // translate(x,y)·rotate·skew·scale(w,h) · translate(-0.5,-0.5)
  return Mat3.multiply(base, Mat3.translation(-0.5, -0.5));
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
 */
function model3dFor(world3d: readonly number[], layer: RenderLayer): readonly number[] {
  const pad = rasterPadding(layer);
  const W = layer.width + 2 * pad;
  const H = layer.height + 2 * pad;
  const bridge: import('@motion/scene').Matrix4 = [
    W, 0, 0, 0,
    0, H, 0, 0,
    0, 0, 1, 0,
    -0.5 * W, -0.5 * H, 0, 1,
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

/** Flat colour for the GPU SDF (non-textured) path: the layer's solid fill.
 *  Gradient / multi-stop fills force a rasterized texture via needsShapeRaster,
 *  so a non-solid fill never reaches the SDF path — the old "first gradient
 *  stop" fallback here was dead and has been removed (engine-unification Ph2;
 *  gradients are now fully rasterized, never flattened to one stop). */
function representativeColor(layer: RenderLayer): string {
  const p = layer.fillPaint;
  return !p || p.type !== 'solid' ? (layer.fill ?? '#000000') : p.color;
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
  if (layer.primitive === 'path') return undefined;
  if (layer.primitive === 'ellipse') {
    return { shape: 'ellipse', radiusPx: 0, width: layer.width, height: layer.height };
  }
  return { shape: 'rounded', radiusPx: layer.cornerRadius ?? 0, width: layer.width, height: layer.height };
}

// effectsNeedCpuBake imported for both needsShapeRaster and layerToRenderable.
function extractSpatialEffects(layer: RenderLayer): import('@motion/renderer').RenderableEffect[] | undefined {
  if (!layer.effects || layer.effects.length === 0) return undefined;
  const spatial: import('@motion/renderer').RenderableEffect[] = [];
  for (const e of layer.effects) {
    if (e.enabled === false) continue;
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
      spatial.push({ type: 'gradient-ramp', blend: n('blend') / 100, colorA: c('colorA'), colorB: c('colorB') });
    }
    if (e.type === 'fractal-noise') spatial.push({ type: 'fractal-noise', scale: n('scale') });
    if (e.type === 'displacement-map') {
      // Map source layer (node id === renderable id). '' / non-string = unset →
      // CompositionPass falls back to self-displacement.
      const mapRaw = effectParam(e, 'mapLayerId');
      const mapLayerId = typeof mapRaw === 'string' && mapRaw !== '' ? mapRaw : undefined;
      spatial.push({ type: 'displacement-map', amount: n('amount'), ...(mapLayerId ? { mapLayerId } : {}) });
    }
    if (e.type === 'motion-tile') spatial.push({ type: 'motion-tile', scale: n('scale') });
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
  // A shape carrying a Canvas2D-only effect is CPU-baked (content + mask +
  // full effect chain) into its `path:` texture — those effects have no GPU
  // shader form and otherwise silently no-op.
  if (layerNeedsCpuBake(layer.effects, layer.fillOpacity)) return true;
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
    model = Mat3.multiply(
      model,
      Mat3.multiply(Mat3.scaling(layer.width + 2 * pad, layer.height + 2 * pad), Mat3.translation(-0.5, -0.5)),
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
          Mat3.multiply(Mat3.scaling(layer.width + 2 * pad, layer.height + 2 * pad), Mat3.translation(-0.5, -0.5)),
        );
      } else {
        const rad = (s.rotation * Math.PI) / 180;
        const w = (layer.width + 2 * pad) * (s.scaleX || 1);
        const h = (layer.height + 2 * pad) * (s.scaleY || 1);
        m = Mat3.multiply(Mat3.compose(s.x, s.y, rad, w, h), Mat3.translation(-0.5, -0.5));
        if (parentMatrix) m = Mat3.multiply(parentMatrix, m);
      }
      return { modelMatrix: m, opacity: s.opacity };
    });
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
  const cpuBaked = (layer.kind === 'shape' || layer.kind === 'text') && effectsNeedCpuBake(layer.effects);
  // Per-quad Lambert gain (Accepts Lights): folded into the draw tint on the
  // affine fallback. Renderables that take the depth-tested group path get the
  // gain UNfolded and carry per-fragment shade data instead (decided after
  // construction below, with the SAME predicate CompositionPass partitions by).
  const applyLighting = (c: Color): Color =>
    layer.lighting ? { r: c.r * layer.lighting[0], g: c.g * layer.lighting[1], b: c.b * layer.lighting[2], a: c.a } : c;
  const out: Renderable = {
    id: layer.id,
    kind,
    modelMatrix: model,
    bounds: boundsOf(model),
    opacity,
    blend: advBlend > 0 ? 'normal' : layerBlendToGpu(layer.blend),
    ...(advBlend > 0 ? { advancedBlend: advBlend } : {}),
    ...(layer.backdropBlur && layer.backdropBlur > 0 ? { backdropBlur: layer.backdropBlur } : {}),
    ...(layer.glass ? { glass: toRenderableGlass(layer.glass) } : {}),
    color: textured ? Color.white() : gradedSolidColor(layer),
    // Texture-backed kinds resolve via the provider
    ...(isCustomPath ? { textureKey: `path:${layer.id}` } : {}),
    ...(!isCustomPath && (kind === 'image' || kind === 'video') ? { textureKey: `asset:${layer.id}` } : {}),
    ...(kind === 'text' ? { textureKey: `text:${layer.id}` } : {}),
    ...(!cpuBaked && layer.mask && layer.mask.paths.length > 0 ? { maskTextureKey: `mask:${layer.id}` } : {}),
    // Colour LUT (Levels/Curves/Posterize) on a textured layer: the provider
    // uploads `lut:<id>` and the LUT shader remaps through it after the grade.
    ...(!cpuBaked && textured && hasLutEffect(layer) ? { lutTextureKey: `lut:${layer.id}` } : {}),
    ...(matteOf(layer) ? { matte: matteOf(layer)! } : {}),
    ...(textured ? { colorMatrix: cpuBaked ? undefined : texturedColorMatrix(layer) } : { sdf: sdfFor(layer) }),
    ...(motionSamples ? { motionSamples } : {}),
    effects: cpuBaked ? undefined : extractSpatialEffects(layer),
    ...(layer.deformedMesh ? { deformedMesh: normalizeDeformedMesh(layer.deformedMesh, layer.width, layer.height, pad) } : {}),
    // True-3D placement for the depth-tested GPU path. Only meaningful for a
    // layer whose 2D model came from the projected affine (`layer.matrix`) —
    // an inline-collapsed precomp child folds an extra parent transform into
    // the mat3 that the mat4 world doesn't know about, so it must keep the
    // affine path (the top-level flatten passes an identity parent).
    ...(layer.world3d && layer.matrix && (!parentMatrix || isIdentityMat3(parentMatrix))
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
export function precompNeedsIsolation(layer: RenderLayer): boolean {
  if (!layer.precompLayers || layer.precompLayers.length === 0) return false;
  if (layer.blend && layer.blend !== 'normal') return true;
  if (layer.mask && layer.mask.paths.length > 0) return true;
  if (getMatteMode(layer.matte) && layer.matteSourceId) return true;
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
  // Children flatten with IDENTITY parent — they are already in the container's
  // comp space (buildSnapshot emits them with full world transforms) and the
  // offscreen texture is composited in that same space.
  const inner = flattenLayers(layer.precompLayers!, Mat3.identity(), 1);
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

/** Parse a layer's track matte into the renderable's matte descriptor, or null
 *  when it has no matte (or its source wasn't resolved). */
function matteOf(layer: RenderLayer): { mode: 'alpha' | 'luma'; inverted: boolean; sourceId: string } | null {
  const mode = getMatteMode(layer.matte);
  if (!mode || !layer.matteSourceId) return null;
  const luma = mode === 'luma' || mode === 'luma-inv';
  const inverted = mode === 'alpha-inv' || mode === 'luma-inv';
  return { mode: luma ? 'luma' : 'alpha', inverted, sourceId: layer.matteSourceId };
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
      const rad = (layer.rotation * Math.PI) / 180;
      const tOrigin = Mat3.translation(-layer.width / 2, -layer.height / 2);
      const mPrecomp = Mat3.compose(layer.x, layer.y, rad, layer.scaleX || 1, layer.scaleY || 1);

      const localParent = Mat3.multiply(mPrecomp, tOrigin);
      const nextParent = Mat3.multiply(parentMatrix, localParent);
      const nextOpacity = parentOpacity * layer.opacity;

      flattenLayers(layer.precompLayers, nextParent, nextOpacity, result);
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

export function snapshotToFrameScene(snapshot: RenderSnapshot): FrameScene {
  const renderables = flattenLayers(snapshot.layers, Mat3.identity(), 1);
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
  const hasAdvancedBlend = renderables.some((r) => (r.advancedBlend ?? 0) > 0);
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
    selection: [],
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
