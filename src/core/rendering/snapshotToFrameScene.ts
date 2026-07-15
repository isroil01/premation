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
 *   • shape ellipses / rounded corners  → renderer draws plain rects (Prompt 5)
 *   • text glyphs, image/video textures → white-texel until a real provider /
 *     asset pipeline exists (Prompt 7); they render as tinted quads
 *   • per-layer CSS filters (RenderLayer.filter) → EffectPass is inert (Prompt 5)
 */

import { Mat3, Color, type BlendMode, type FrameScene, type Renderable, type RenderableKind, type RenderableSdf } from '@motion/renderer';
import { sortedStops } from '@core/paint/fill';
import type { LayerBlendMode } from '@core/effects/blendMode';
import { effectColorMatrix, applyColorMatrix, IDENTITY_COLOR_MATRIX } from '@core/effects/effectColorMatrix';
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

const KIND_MAP: Record<RenderLayer['kind'], RenderableKind> = {
  shape: 'rect',
  text: 'text',
  image: 'image',
  video: 'video',
};

/** Center-pivot model matrix: unit-quad centre → (x,y), rotated/scaled in place. */
function centerModel(layer: RenderLayer): Mat3 {
  const rad = (layer.rotation * Math.PI) / 180;
  const w = layer.width * (layer.scaleX || 1);
  const h = layer.height * (layer.scaleY || 1);
  // translate(x,y)·rotate·scale(w,h) · translate(-0.5,-0.5)
  return Mat3.multiply(Mat3.compose(layer.x, layer.y, rad, w, h), Mat3.translation(-0.5, -0.5));
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

/** Representative flat colour for the GPU path: solid colour, or the first
 *  gradient stop (gradients + strokes are Canvas2D-only for now — documented). */
function representativeColor(layer: RenderLayer): string {
  const p = layer.fillPaint;
  if (!p) return layer.fill;
  if (p.type === 'solid') return p.color;
  return sortedStops(p.stops)[0]?.color ?? layer.fill;
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

function extractSpatialEffects(layer: RenderLayer): import('@motion/renderer').RenderableEffect[] | undefined {
  if (!layer.effects || layer.effects.length === 0) return undefined;
  const spatial: import('@motion/renderer').RenderableEffect[] = [];
  for (const e of layer.effects) {
    if (e.enabled === false) continue;
    if (e.type === 'blur') spatial.push({ type: 'blur', radiusPx: e.amount });
    if (e.type === 'glow') spatial.push({ type: 'glow', radiusPx: e.amount, color: Color.fromHex('rgba(120,180,255,0.9)') });
    if (e.type === 'drop-shadow') spatial.push({ type: 'drop-shadow', radiusPx: e.amount, offsetX: e.amount * 0.45, offsetY: e.amount * 0.45, color: Color.fromHex('rgba(0,0,0,0.55)') });
    if (e.type === 'gradient-ramp') spatial.push({ type: 'gradient-ramp', blend: e.amount / 100, colorA: Color.fromHex('#ff0000'), colorB: Color.fromHex('#0000ff') });
    if (e.type === 'fractal-noise') spatial.push({ type: 'fractal-noise', scale: e.amount });
    if (e.type === 'displacement-map') spatial.push({ type: 'displacement-map', amount: e.amount });
    if (e.type === 'motion-tile') spatial.push({ type: 'motion-tile', scale: e.amount });
  }
  return spatial.length > 0 ? spatial : undefined;
}

export function layerToRenderable(layer: RenderLayer, parentMatrix?: Mat3, parentOpacity?: number): Renderable {
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
    model = Mat3.multiply(model, Mat3.translation(-0.5, -0.5));
  } else {
    const localModel = centerModel(layer);
    model = parentMatrix ? Mat3.multiply(parentMatrix, localModel) : localModel;
  }
  const opacity = (parentOpacity !== undefined ? parentOpacity * layer.opacity : layer.opacity);
  
  const isCustomPath = layer.kind === 'shape' && layer.primitive === 'path';
  // Note: hasMask/hasMatte no longer force 'image' for CPU rasterization
  const kind = isCustomPath ? 'image' : KIND_MAP[layer.kind];

  // Textured kinds sample a texture that already carries their colour (photo, or
  // text rasterized in its own fill), so they must not be multiplied by a fill.
  // Only shapes use their solid/representative colour.
  const textured = kind === 'image' || kind === 'video' || kind === 'text';
  return {
    id: layer.id,
    kind,
    modelMatrix: model,
    bounds: boundsOf(model),
    opacity,
    blend: layerBlendToGpu(layer.blend),
    color: textured ? Color.white() : gradedSolidColor(layer),
    // Texture-backed kinds resolve via the provider
    ...(isCustomPath ? { textureKey: `path:${layer.id}` } : {}),
    ...(!isCustomPath && (kind === 'image' || kind === 'video') ? { textureKey: `asset:${layer.id}` } : {}),
    ...(kind === 'text' ? { textureKey: `text:${layer.id}` } : {}),
    ...(layer.mask && layer.mask.paths.length > 0 ? { maskTextureKey: `mask:${layer.id}` } : {}),
    ...(textured ? { colorMatrix: texturedColorMatrix(layer) } : { sdf: sdfFor(layer) }),
    effects: extractSpatialEffects(layer),
  };
}

/** Colour-grade transform for a textured layer, applied per-pixel in the shader.
 *  Omitted when the stack has no colour effects (identity). */
function texturedColorMatrix(layer: RenderLayer): { m: readonly number[]; offset: readonly number[] } | undefined {
  if (!layer.effects || layer.effects.length === 0) return undefined;
  const cm = effectColorMatrix(layer.effects);
  return cm === IDENTITY_COLOR_MATRIX ? undefined : cm;
}

function flattenLayers(
  layers: ReadonlyArray<RenderLayer>,
  parentMatrix: Mat3,
  parentOpacity: number,
  result: Renderable[] = []
): Renderable[] {
  for (const layer of layers) {
    if (!layer.visible) continue;
    if (layer.isMatteSource || layer.isAdjustment) continue;
    // 2D lights are a Canvas2D screen-blend gradient; the GPU graph has no
    // light pass yet. Without this skip the light's carrier layer (a full-comp
    // black shape) rasterized as an opaque black rectangle over the frame.
    if (layer.light) continue;

    if (layer.precompLayers && layer.precompLayers.length > 0) {
      // Precomp container: accumulate transformation matrix and opacity for child layers
      const rad = (layer.rotation * Math.PI) / 180;
      const tOrigin = Mat3.translation(-layer.width / 2, -layer.height / 2);
      const mPrecomp = Mat3.compose(layer.x, layer.y, rad, layer.scaleX || 1, layer.scaleY || 1);
      
      const localParent = Mat3.multiply(mPrecomp, tOrigin);
      const nextParent = Mat3.multiply(parentMatrix, localParent);
      const nextOpacity = parentOpacity * layer.opacity;

      flattenLayers(layer.precompLayers, nextParent, nextOpacity, result);
    } else {
      // Leaf layer: map to renderable with parent transformations applied
      result.push(layerToRenderable(layer, parentMatrix, parentOpacity));
    }
  }
  return result;
}

export function snapshotToFrameScene(snapshot: RenderSnapshot): FrameScene {
  const renderables = flattenLayers(snapshot.layers, Mat3.identity(), 1);
  const checkEffects = (layers: ReadonlyArray<RenderLayer>): boolean => {
    for (const l of layers) {
      if (l.effects && l.effects.length > 0) return true;
      if (l.precompLayers && checkEffects(l.precompLayers)) return true;
    }
    return false;
  };
  const hasEffects = checkEffects(snapshot.layers);
  return {
    composition: {
      id: 'composition',
      size: { width: snapshot.width, height: snapshot.height },
      background: snapshot.transparent ? Color.transparent() : Color.fromHex(snapshot.background),
    },
    renderables,
    selection: [],
    hasEffects,
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
