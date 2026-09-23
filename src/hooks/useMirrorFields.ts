/**
 * Hooks over a layer's static FIELDS and a composition's layer list in the
 * document mirror (B4) — the Inspector's per-kind sections (camera, light,
 * material, audio, cloner, physics…). Companions of `useMirror.ts`; the pure
 * readers live in `@core/mirror/layerFields`.
 *
 *   useMirrorField(layer, path)          plain value of a static field (json parsed), undefined when absent
 *   useMirrorJson<T>(layer, path)        a json field (`layer/cloner`, `audio/gate`…), stable per record
 *   useActiveCompLayers()                every layer of the active comp (groups' children included)
 */

import { useMemo, useRef } from 'react';
import type { LayerInfo } from '@motion/engine-api';
import { documentMirror } from '@stores/documentMirror';
import { plainValue } from '@core/mirror/trackIndex';
import { compLayersDeep, jsonField } from '@core/mirror/layerFields';
import { useActiveCompId, useMirrorKeys, useMirrorProperty } from './useMirror';

/** A static field's plain value (a choice, a switch, a string; json parsed), undefined when the layer has no such property. */
export function useMirrorField(layer: string | null | undefined, path: string): unknown {
  const info = useMirrorProperty(layer, path);
  return useMemo(() => plainValue(info?.value), [info]);
}

/** A json field (`layer/cloner`, `audio/gate`…), undefined when absent or null. Same object while the record is unchanged. */
export function useMirrorJson<T>(layer: string | null | undefined, path: string): T | undefined {
  const info = useMirrorProperty(layer, path);
  return useMemo(() => (layer && info ? jsonField<T>(documentMirror(), layer, path) : undefined), [info, layer, path]);
}

/**
 * Every layer of the active composition, depth first (a group's children after
 * it). Re-renders when the comp's stack or any layer header changes.
 */
export function useActiveCompLayers(): readonly LayerInfo[] {
  const active = useActiveCompId();
  const m = documentMirror();
  const comp = active ?? m.compIds[0];
  const last = useRef<readonly LayerInfo[]>([]);
  // Read in render (records are immutable); subscribe to the comp's stack,
  // membership and every listed layer's header (a 3D switch, a rename).
  const next = compLayersDeep(m, comp);
  const prev = last.current;
  const list = prev.length === next.length && prev.every((x, i) => x === next[i]) ? prev : next;
  last.current = list;
  const keys = useMemo(
    () => [...(comp ? [`comp:${comp}`, `order:${comp}`] : []), 'layers', 'comps', ...list.map((l) => `layer:${l.id}`)],
    [comp, list],
  );
  useMirrorKeys(keys);
  return list;
}
