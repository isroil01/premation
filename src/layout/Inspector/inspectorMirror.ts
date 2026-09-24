/**
 * The Inspector core's layer facts, read from the document MIRROR (B4,
 * docs/B4_MIRROR.md) — what the section registry, the selection header and
 * the transform/compositing sections ask about a layer: does it exist, what
 * kind is it (a plugin-provided kind included: `LayerInfo.generator`), can it
 * take the 3D switch, does it draw pixels.
 */

import { flicksToSeconds, type LayerInfo } from '@motion/engine-api';
import { documentMirror, type DocumentMirror } from '@stores/documentMirror';
import { useProjectStore } from '@stores/projectStore';
import { uiKindOf, isAbstractKind } from '@core/mirror/layerKinds';
import { childOrderOf } from '@core/mirror/layerTree';
import { useActiveMirrorComp, useMirrorComp, useMirrorKeys, useMirrorLayer } from '@hooks/useMirror';

/** The layer's mirror header, or undefined when it is gone (or not a layer). */
export function mirrorLayer(id: string | null | undefined): LayerInfo | undefined {
  return id ? documentMirror().layer(id) : undefined;
}

export function layerExists(id: string | null | undefined): boolean {
  return mirrorLayer(id) !== undefined;
}

/**
 * The editor kind the Inspector keys on: `uiKindOf` of the mirror header, and
 * for a generator layer the plugin kind id (`<pluginId>.<kindId>`) when the
 * layer is a plugin-provided kind.
 */
export function inspectorKindOf(id: string | null | undefined): string | null {
  const layer = mirrorLayer(id);
  if (!layer) return null;
  // A plugin-provided kind: LayerInfo.generator names it (B4).
  if (layer.kind === 'generator' && layer.generator !== '') return layer.generator;
  return uiKindOf(layer);
}

/** Kinds with no spatial or visual presence of their own (camera, light, audio). */
export function isAbstractLayer(id: string): boolean {
  return isAbstractKind(uiKindOf(mirrorLayer(id)));
}

/** Kinds that draw pixels the render pipeline composites (not camera/light/audio). */
export function isRenderableLayer(id: string): boolean {
  const layer = mirrorLayer(id);
  return !!layer && !isAbstractKind(uiKindOf(layer));
}

const THREE_D_CAPABLE = new Set(['shape', 'text', 'image', 'video', 'null', 'svg']);

/**
 * Whether the layer can take the 3D switch (the mirror twin of `canBe3D`): a
 * content kind, or a composition layer that is not collapsed (a sealed comp
 * is a 3D card; a collapsed one splices its layers into the host).
 */
export function canBe3DLayer(id: string): boolean {
  const layer = mirrorLayer(id);
  if (!layer) return false;
  const kind = inspectorKindOf(id);
  if (kind === 'comp') return !layer.switches.collapse;
  return kind !== null && THREE_D_CAPABLE.has(kind);
}

/** Whether the layer's 3D switch is on. */
export function is3DLayer(id: string): boolean {
  return mirrorLayer(id)?.switches.threeD === true;
}

/**
 * The active tab's composition id, for a CALLBACK (the hook form is
 * `useActiveCompId`): editor state, then the document's first composition.
 */
export function activeMirrorCompId(): string | undefined {
  const s = useProjectStore.getState();
  const id = s.activeTabId ? s.tabs[s.activeTabId]?.compositionId : undefined;
  return id ?? documentMirror().compIds[0];
}

/** The active composition's duration, seconds (0 when there is none). */
export function useActiveCompDurationSeconds(): number {
  const d = useActiveMirrorComp()?.settings.duration;
  return typeof d === 'number' ? flicksToSeconds(d) : 0;
}

/** The active composition's frame size (0 × 0 when there is none). */
export function useActiveCompSize(): { width: number; height: number } {
  const s = useActiveMirrorComp()?.settings;
  return { width: s?.width ?? 0, height: s?.height ?? 0 };
}

/**
 * Re-render when anything a picker over `nodeId`'s composition lists changes —
 * the comp's stack, membership, or any of its layers' headers (a rename, a
 * reparent, a 3D switch) — the parent / IK-target dropdowns. Returns the
 * layer's header.
 */
export function useCompLayersWatch(nodeId: string | null | undefined): LayerInfo | undefined {
  const layer = useMirrorLayer(nodeId);
  const comp = useMirrorComp(layer?.comp);
  useMirrorKeys(comp ? ['layers', ...comp.layers.map((id) => `layer:${id}`)] : []);
  return layer;
}

/**
 * The other layers under `layer`'s parent (the composition's top layers when it
 * has none), BACK to FRONT — the scene graph's `getChildren(parent)` order,
 * minus the layer itself. What the matte-source pickers list.
 */
export function siblingsOf(m: DocumentMirror, layer: LayerInfo): LayerInfo[] {
  return childOrderOf(m, layer.parent ?? layer.comp)
    .filter((id) => id !== layer.id)
    .map((id) => m.layer(id))
    .filter((l): l is LayerInfo => l !== undefined);
}
