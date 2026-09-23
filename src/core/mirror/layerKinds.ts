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
