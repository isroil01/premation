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

import { Mat3, Color, type FrameScene, type Renderable, type RenderableKind } from '@motion/renderer';
import type { RenderSnapshot, RenderLayer, RenderView } from './RenderBackend';

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

export function layerToRenderable(layer: RenderLayer): Renderable {
  const model = centerModel(layer);
  const kind = KIND_MAP[layer.kind];
  return {
    id: layer.id,
    kind,
    modelMatrix: model,
    bounds: boundsOf(model),
    opacity: layer.opacity,
    blend: layer.blend ?? 'normal',
    color: Color.fromHex(layer.fill),
    // Texture-backed kinds resolve via the provider (white-texel until Prompt 7).
    ...(kind === 'image' || kind === 'video' ? { textureKey: `asset:${layer.id}` } : {}),
    ...(kind === 'text' ? { textureKey: `text:${layer.id}` } : {}),
  };
}

export function snapshotToFrameScene(snapshot: RenderSnapshot): FrameScene {
  const renderables: Renderable[] = [];
  for (const layer of snapshot.layers) {
    if (!layer.visible) continue;
    renderables.push(layerToRenderable(layer));
  }
  return {
    composition: {
      id: 'composition',
      size: { width: snapshot.width, height: snapshot.height },
      background: Color.fromHex(snapshot.background),
    },
    renderables,
    selection: [],
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
