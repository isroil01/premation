/**
 * The editable blanks of an INSERTED motion-graphics element read from the
 * document MIRROR (B4) — the twin of `readMographFields` / `findMographRoot`
 * (core/library/mographParams.ts), which walk the scene graph. Pure: they take
 * a mirror reader and never touch the engine.
 *
 * The same two rules, in API terms:
 *
 *   • a part with Source Text (`text/sourceText`) → a text field, unless the
 *     text is KEYED (the data-track counters and word swaps regenerate it per
 *     frame, so a typed value would not survive)
 *   • a part with a Fill Color (`layer/fill`: a text layer's character colour,
 *     a shape's solid fill) → a colour field
 *
 * The root is the nearest layer up the parent chain whose header names a
 * library item (`LayerInfo.mographId`). Fields come out as `TemplateField`s so
 * the fill-in panel's writer (`templateFieldCommands`) applies them.
 */

import type { LayerInfo, PropertyInfo, Value } from '@motion/engine-api';
import type { TemplateField } from '@core/template/templateTypes';
import { childOrderOf, type MirrorTreeRead } from './layerTree';
import { colorValueHex } from './paintFields';
import type { MirrorTreeLike } from './trackIndex';

/** What these readers need from the mirror. `DocumentMirror` is one. */
export interface MographMirrorRead extends MirrorTreeRead {
  tree(layer: string): MirrorTreeLike | undefined;
  valueAt(layer: string, path: string, time: number): Value | undefined;
}

const SOURCE_TEXT = 'text/sourceText';
const FILL = 'layer/fill';

/**
 * A readable label for a built part, from the id suffix the catalog authored
 * (`mg_3_kf9a_role` → "Role", `..._sub_title` → "Sub Title"). The suffixes are
 * the item author's own names for the parts, so they read better than anything
 * derivable from geometry — and this is the same string used for the layer
 * name at insert, so the Inspector field and the Layers row agree.
 */
export function partLabel(rootId: string, childId: string): string {
  const suffix = childId.startsWith(`${rootId}_`) ? childId.slice(rootId.length + 1) : childId;
  const words = suffix.split(/[_-]+/).filter(Boolean);
  if (words.length === 0) return 'Part';
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/** The inserted-element root at or above `layerId`, or null when the layer is not inside one. */
export function mirrorMographRoot(m: Pick<MirrorTreeRead, 'layer'>, layerId: string | null): string | null {
  let cursor: LayerInfo | undefined = layerId ? m.layer(layerId) : undefined;
  for (let guard = 0; cursor && guard < 64; guard++) {
    if (cursor.mographId) return cursor.id;
    cursor = cursor.parent ? m.layer(cursor.parent) : undefined;
  }
  return null;
}

/** The layers under `rootId`, depth-first in child order, the root excluded. */
export function mographPartIds(m: MirrorTreeRead, rootId: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([rootId]);
  const walk = (id: string): void => {
    for (const child of childOrderOf(m, id)) {
      if (seen.has(child)) continue;
      seen.add(child);
      out.push(child);
      walk(child);
    }
  };
  walk(rootId);
  return out;
}

/** The text a Source Text value holds. */
function textOf(v: Value | undefined): string | undefined {
  return v?.kind === 'textDocument' ? v.value.text : undefined;
}

function staticText(info: PropertyInfo | undefined): string {
  return textOf(info?.value) ?? '';
}

/**
 * The editable fields of the element rooted at `rootId`, in part order: every
 * text part first, then every colour. Empty when `rootId` is not an inserted
 * element, or while a part's property tree has not loaded yet.
 */
export function mirrorMographFields(m: MographMirrorRead, rootId: string | null): TemplateField[] {
  if (!rootId || !m.layer(rootId)?.mographId) return [];
  const text: TemplateField[] = [];
  const colour: TemplateField[] = [];
  for (const id of mographPartIds(m, rootId)) {
    const tree = m.tree(id);
    if (!tree) continue;
    const label = partLabel(rootId, id);
    const source = tree.nodes.get(SOURCE_TEXT);
    if (source && !source.animated) {
      text.push({
        id: `mgf_${id}_content`,
        label,
        kind: 'text',
        group: 'Content',
        default: staticText(source),
        target: { nodeId: id, componentType: 'Text', prop: 'content' },
      });
    }
    const fill = tree.nodes.get(FILL);
    const hex = colorValueHex(fill?.value);
    if (fill && hex) {
      colour.push({
        id: `mgf_${id}_fill`,
        label,
        kind: 'color',
        group: 'Colour',
        default: hex,
        target: { nodeId: id, componentType: source ? 'Text' : 'Style', prop: 'fill' },
      });
    }
  }
  return [...text, ...colour];
}

/**
 * A field's current value at comp time `time` (flicks): the part's Source Text
 * or its Fill Color (hex) — at the playhead when the colour is keyed, which is
 * where the field's write lands. The field's default when the mirror has none.
 * (A stored `rgba(…)` fill reads as white through the TS engine's `layer/fill`
 * today — the section keeps a stored read for colours until both engines parse
 * CSS colours.)
 */
export function mirrorMographFieldValue(m: MographMirrorRead, field: TemplateField, time: number): string {
  const { nodeId, prop } = field.target;
  const v = prop === 'content'
    ? textOf(m.valueAt(nodeId, SOURCE_TEXT, time))
    : prop === 'fill' ? colorValueHex(m.valueAt(nodeId, FILL, time)) : undefined;
  return v ?? String(field.default ?? '');
}

/**
 * The mirror keys the section depends on: the selected layer's parent chain
 * (which element it is in), the element's structure, and each part's tree,
 * Source Text and Fill Color (info, keys, value).
 */
export function mographWatchKeys(m: MographMirrorRead, selected: string | null): string[] {
  const keys = ['layers'];
  let cursor: LayerInfo | undefined = selected ? m.layer(selected) : undefined;
  for (let guard = 0; cursor && guard < 64; guard++) {
    keys.push(`layer:${cursor.id}`);
    if (cursor.mographId) break;
    cursor = cursor.parent ? m.layer(cursor.parent) : undefined;
  }
  const root = mirrorMographRoot(m, selected);
  if (!root) return keys;
  const comp = m.layer(root)?.comp;
  if (comp) keys.push(`order:${comp}`);
  for (const id of mographPartIds(m, root)) {
    keys.push(`layer:${id}`, `tree:${id}`);
    for (const path of [SOURCE_TEXT, FILL]) keys.push(`prop:${id}|${path}`, `key:${id}|${path}`, `value:${id}|${path}`);
  }
  return keys;
}
