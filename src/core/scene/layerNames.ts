import { documentMirror } from '@stores/documentMirror';
import { activeCompRootId } from '@core/scene/activeComp';
import { flattenCompLayers } from '@core/mirror/compLayers';

/**
 * A layer name nothing else in the active comp is using: `base`, then `base 2`,
 * `base 3`…
 *
 * Every drawn shape was "Rectangle" (or "Circle", "Star", "Text"). Three of them
 * are three identical rows in the timeline, the Layers panel, every parent
 * menu and every expression that names a layer — and a name is how a layer is
 * told apart. The first keeps the bare word, so a one-shape project reads as it
 * always did. Names come from the document mirror (block 3).
 */
export function uniqueLayerName(base: string): string {
  const m = documentMirror();
  const used = new Set<string>();
  for (const id of flattenCompLayers(m, activeCompRootId())) {
    const name = m.layer(id)?.name;
    if (name) used.add(name.trim());
  }
  if (!used.has(base)) return base;
  let i = 2;
  while (used.has(`${base} ${i}`)) i += 1;
  return `${base} ${i}`;
}
