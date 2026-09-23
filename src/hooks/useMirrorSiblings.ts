/**
 * A layer's SIBLINGS from the document mirror (B4, docs/B4_MIRROR.md) — the
 * other layers under the same parent (a group's children, or the comp's top
 * layers), stack order. What the Inspector's layer pickers (a cloner's path /
 * field layer) list. Companion of `useMirror.ts`.
 */

import { useMemo } from 'react';
import type { LayerInfo } from '@motion/engine-api';
import { documentMirror } from '@stores/documentMirror';
import { useMirrorKeys, useMirrorLayer, useMirrorLayers } from './useMirror';

const NONE: readonly string[] = [];

/** Every other layer under `layerId`'s parent (the comp's top layers when it has none), top of the stack first. */
export function useMirrorSiblings(layerId: string | null | undefined): readonly LayerInfo[] {
  const layer = useMirrorLayer(layerId);
  const parent = layer?.parent;
  const comp = layer?.comp;
  // The parent's header carries its children; a comp's top layers are its stack order.
  useMirrorKeys(parent ? [`layer:${parent}`] : comp ? [`order:${comp}`, `comp:${comp}`] : NONE);
  const m = documentMirror();
  const all = parent ? m.layer(parent)?.children : comp ? m.comp(comp)?.layers : undefined;
  const ids = useMemo(() => (all ?? NONE).filter((id) => id !== layerId), [all, layerId]);
  const infos = useMirrorLayers(ids);
  return useMemo(() => infos.filter((l): l is LayerInfo => l !== undefined), [infos]);
}
