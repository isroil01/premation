/**
 * A layer's COMPONENT PROP (the name an Inspector row has always used: a
 * camera's `focalLength`, a light's `lightType`, a Text field `fontFamily`, a
 * layer's `fill`) read from the document MIRROR (B4) — what `useComponentProp`
 * shows. Pure: takes a mirror reader and never touches the engine.
 *
 * The API names every such prop by a path whose property's match name is the
 * prop (`camera/focalLength` ⇄ `focalLength`, `text/fontFamily` ⇄
 * `fontFamily`, `light/lightType` ⇄ `lightType`), so `trackRefIn` finds it; a
 * few are spelled differently and are mapped here:
 *
 *   content      the text of `text/sourceText`
 *   fill         the layer's colour `layer/fill`, as `#rrggbb[aa]`
 *   fontWeight   `text/axes/wght` as the CSS weight string the Text component stores ('600')
 *   <plugin key> a plugin layer kind's `plugin/<key>`
 *
 * Numbers come back in STORED units (`storedNumber`), colours as hex, choices /
 * strings / switches as themselves, json parsed. A prop the API does not carry
 * is `undefined`.
 */

import type { PropertyInfo } from '@motion/engine-api';
import { plainValue, storedNumber, trackRefIn, type MirrorTreeLike } from './trackIndex';
import { colorValueHex } from './paintFields';

/** What this reader needs from the mirror. `DocumentMirror` is one. */
export interface MirrorPropRead {
  tree(layer: string): MirrorTreeLike | undefined;
}

/** Value types a member number is read from (a switch or a choice is itself). */
const NUMERIC: ReadonlySet<string> = new Set(['scalar', 'int', 'vec2', 'vec3', 'vec4']);

function valueOfInfo(info: PropertyInfo): unknown {
  const v = info.value;
  if (v?.kind === 'color') return colorValueHex(v);
  return plainValue(v);
}

/** The mirror path a component prop reads, or null when the API does not carry it. */
export function componentPropPath(tree: MirrorTreeLike | undefined, key: string): string | null {
  if (!tree) return null;
  if (key === 'content') return tree.nodes.has('text/sourceText') ? 'text/sourceText' : null;
  if (key === 'fill') return tree.nodes.has('layer/fill') ? 'layer/fill' : null;
  const r = trackRefIn(tree, key);
  if (r) return r.path;
  return tree.nodes.has(`plugin/${key}`) ? `plugin/${key}` : null;
}

/** The value of component prop `key` on `layer` (see the header), undefined when the API has none. */
export function componentPropValue(m: MirrorPropRead, layer: string, key: string): unknown {
  const tree = m.tree(layer);
  if (!tree) return undefined;
  if (key === 'content') {
    const v = tree.nodes.get('text/sourceText')?.value;
    return v?.kind === 'textDocument' ? v.value.text : undefined;
  }
  if (key === 'fill') return colorValueHex(tree.nodes.get('layer/fill')?.value);
  const r = trackRefIn(tree, key);
  if (r) {
    if (r.info.valueType === 'color') return colorValueHex(r.info.value);
    if (!NUMERIC.has(r.info.valueType)) return valueOfInfo(r.info);
    const n = storedNumber(r, r.info.value);
    return n !== undefined && key === 'fontWeight' ? String(n) : n;
  }
  const plugin = tree.nodes.get(`plugin/${key}`);
  return plugin && plugin.kind === 'property' ? valueOfInfo(plugin) : undefined;
}
