/**
 * The editor's layer kinds (`SceneKind`: what icons, colours and Inspector
 * sections key on) from a mirror `LayerInfo` (B4). Pure.
 *
 * The API's `LayerKind` is finer (rectangle / ellipse / polygon / path /
 * solid are all shape layers to the editor; image and sequence are both
 * images) and names precomps and 3D models, which the editor draws as
 * `comp` / `shape`.
 */

import type { LayerInfo, LayerKind } from '@motion/engine-api';
import type { SceneKind } from '@core/scene/seedDefaultScene';

const TO_UI: Record<LayerKind, SceneKind> = {
  null: 'null',
  solid: 'shape',
  shape: 'shape',
  rectangle: 'shape',
  ellipse: 'shape',
  polygon: 'shape',
  path: 'shape',
  text: 'text',
  image: 'image',
  sequence: 'image',
  video: 'video',
  audio: 'audio',
  svg: 'svg',
  precomp: 'comp',
  camera: 'camera',
  light: 'light',
  group: 'group',
  component: 'group',
  particle: 'particle',
  model3d: 'shape',
  generator: 'shape',
  adjustment: 'adjustment',
};

export function uiKindOf(layer: Pick<LayerInfo, 'kind' | 'source'> | undefined): SceneKind | null {
  if (!layer) return null;
  // A legacy nested precomp (a group carrying its own layers) has no source item.
  if (layer.kind === 'precomp' && !layer.source) return 'group';
  return TO_UI[layer.kind] ?? 'shape';
}

/** Kinds with no picture of their own. */
export function isAbstractKind(kind: SceneKind | null): boolean {
  return kind === 'camera' || kind === 'light' || kind === 'audio';
}

/** An image or video layer — what an Alt-drop can replace the source of (`replaceSourceDrop.isReplaceableLayer`). */
export function isReplaceableSourceLayer(layer: Pick<LayerInfo, 'kind' | 'source'> | undefined): boolean {
  const k = uiKindOf(layer);
  return k === 'image' || k === 'video';
}

const THREE_D_CAPABLE: ReadonlySet<SceneKind> = new Set(['shape', 'text', 'image', 'video', 'null', 'svg']);

/**
 * Whether a layer can take the 3D switch — the twin of `threeD.canBe3D`: a
 * content kind, or a SEALED composition layer (a collapsed one splices its
 * layers into the host and is not a layer that draws). A plugin generator is
 * not one (its editor kind is the plugin's own).
 */
export function canBe3DLayer(layer: Pick<LayerInfo, 'kind' | 'source' | 'generator' | 'switches'> | undefined): boolean {
  if (!layer || (layer.kind === 'generator' && layer.generator !== '')) return false;
  const k = uiKindOf(layer);
  if (k === 'comp') return !layer.switches.collapse;
  return k !== null && THREE_D_CAPABLE.has(k);
}

const PAINTABLE: ReadonlySet<SceneKind> = new Set(['shape', 'text', 'image', 'svg', 'video']);

/**
 * Whether a layer takes Paint strokes — the twin of `paintCoords.isPaintableKind`.
 * A plugin generator layer is not one (its editor kind is the plugin's own).
 */
export function isPaintableLayer(layer: Pick<LayerInfo, 'kind' | 'source' | 'generator'> | undefined): boolean {
  if (!layer || (layer.kind === 'generator' && layer.generator !== '')) return false;
  const k = uiKindOf(layer);
  return k !== null && PAINTABLE.has(k);
}

const RIGGABLE: ReadonlySet<SceneKind> = new Set(['shape', 'image']);

/**
 * Whether a layer can be rigged directly — the twin of `rigLogo.isRiggableLeafNode`
 * (its `RIGGABLE_KINDS`: shape and image; text and groups go through Rig Logo).
 */
export function isRiggableLayer(layer: Pick<LayerInfo, 'kind' | 'source'> | undefined): boolean {
  const k = uiKindOf(layer);
  return k !== null && RIGGABLE.has(k);
}
