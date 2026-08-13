/**
 * Editable parameters for an INSERTED motion-graphics element.
 *
 * A Motion GFX card drops a finished, choreographed group into the comp — and
 * then leaves the user with "Name Surname", "Title / Role" and a fixed accent
 * colour, reachable only by hunting through the layer tree for the right child
 * and finding the one prop on it that is safe to touch. The element is a
 * template in every sense except that nothing exposed its blanks.
 *
 * This derives those blanks from the built subtree instead of asking each of
 * the catalog's items to declare them, so items added later are covered without
 * anyone remembering to maintain a manifest. Two rules, matching how the items
 * are actually built:
 *
 *   • a child with a Text component → its `content` is a text field
 *   • a child with a Style.fill string → that fill is a colour field
 *
 * Fields come out as `TemplateField`s so they are written through
 * `writeTemplateField` — the same path the fill-in-the-blanks template panel
 * uses — rather than a second, subtly different write.
 *
 * ## What is deliberately NOT exposed
 *
 * Text driven by a `text.source` DATA TRACK (the number counters and the
 * word-swap kinetic titles) is skipped. Those nodes have their content
 * regenerated per frame from hold keyframes, so a typed-in value is overwritten
 * on the next evaluation — an edit box that silently discards what you type is
 * worse than no edit box. Same reasoning as the transform-write routing rule:
 * a raw prop write to an animated property is discarded.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { TemplateField } from '@core/template/templateTypes';

/** Stamped on an inserted group's meta component so the subtree can be
 *  recognised as one element later. Underscore-prefixed like the other internal
 *  scene props, which keeps it out of the generic inspector. */
export const MOGRAPH_ID_PROP = '__mographId';

/** The catalog id an inserted group came from, or null for an ordinary group. */
export function mographIdOf(nodeId: string): string | null {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return null;
  for (const c of node.components) {
    const v = (c.props as Record<string, unknown>)[MOGRAPH_ID_PROP];
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

/**
 * The inserted-element root at or above `nodeId`, or null when the selection is
 * not inside one. Selecting a child layer should still offer the element's
 * fields — that is where a user lands after clicking the thing on canvas.
 */
export function findMographRoot(nodeId: string | null): string | null {
  let cursor = nodeId;
  let guard = 0;
  while (cursor && guard++ < 64) {
    if (mographIdOf(cursor)) return cursor;
    cursor = defaultSceneGraph.getNode(cursor)?.parent ?? null;
  }
  return null;
}

/** Child ids of `rootId`, depth-first, excluding the root. */
function descendants(rootId: string): string[] {
  const out: string[] = [];
  const walk = (id: string): void => {
    for (const child of defaultSceneGraph.getNode(id)?.children ?? []) {
      const cid = typeof child === 'string' ? child : (child as { id: string }).id;
      out.push(cid);
      walk(cid);
    }
  };
  walk(rootId);
  return out;
}

/**
 * A readable label for a built child, from the id suffix the catalog authored
 * (`mg_3_kf9a_role` → "Role", `..._sub_title` → "Sub Title"). The suffixes are
 * the item author's own names for the parts, so they read better than anything
 * derivable from geometry — and this is the same string used for the layer name
 * at insert, so the Inspector field and the Layers row agree.
 */
export function partLabel(rootId: string, childId: string): string {
  const suffix = childId.startsWith(`${rootId}_`) ? childId.slice(rootId.length + 1) : childId;
  const words = suffix.split(/[_-]+/).filter(Boolean);
  if (words.length === 0) return 'Part';
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/** True when this node's text is regenerated per frame from a data track, so a
 *  typed value would not survive. */
function textIsDataDriven(nodeId: string): boolean {
  return defaultAnimation.isDataAnimated(nodeId, 'text.source');
}

/**
 * The editable fields of an inserted element, in subtree order: every text part
 * first, then every colour. Returns an empty list for a node that is not an
 * inserted element.
 */
export function readMographFields(rootId: string): TemplateField[] {
  if (!mographIdOf(rootId)) return [];
  const text: TemplateField[] = [];
  const colour: TemplateField[] = [];

  for (const childId of descendants(rootId)) {
    const node = defaultSceneGraph.getNode(childId);
    if (!node) continue;
    const label = partLabel(rootId, childId);

    const textComp = node.components.find((c) => c.type === 'Text');
    if (textComp && !textIsDataDriven(childId)) {
      text.push({
        id: `mgf_${childId}_content`,
        label,
        kind: 'text',
        group: 'Content',
        default: String((textComp.props as Record<string, unknown>).content ?? ''),
        target: { nodeId: childId, componentType: 'Text', prop: 'content' },
      });
    }

    // Colour lives on Style.fill for shapes and on the Text component for type.
    // Only a plain CSS colour is offered — a gradient paint lives on the `fx`
    // component and needs the real gradient editor, not a swatch.
    const fillComp = node.components.find(
      (c) => (c.type === 'Style' || c.type === 'Text') && typeof (c.props as Record<string, unknown>).fill === 'string',
    );
    if (fillComp) {
      colour.push({
        id: `mgf_${childId}_fill`,
        label,
        kind: 'color',
        group: 'Colour',
        default: String((fillComp.props as Record<string, unknown>).fill ?? '#ffffff'),
        target: { nodeId: childId, componentType: fillComp.type, prop: 'fill' },
      });
    }
  }
  return [...text, ...colour];
}

/**
 * Name the built children of an inserted element after the parts their ids
 * describe, and title-case the group itself.
 *
 * Without this the Layers panel fills with `mg_3_kf9a_rule`, `mg_3_kf9a_dot`,
 * `mg_3_kf9a_name` — the builders default a node's name to its id, which is
 * fine for a throwaway preview graph and unreadable in the panel a user
 * actually navigates. One pass at insert covers every item, including ones
 * added to the catalog later.
 */
export function nameMographParts(rootId: string): void {
  for (const childId of descendants(rootId)) {
    const node = defaultSceneGraph.getNode(childId);
    // Only rename the placeholder name the builders stamped (name === id).
    // A node the user already renamed keeps its name.
    if (node && node.name === childId) node.name = partLabel(rootId, childId);
  }
}

/** True when `nodeId` is a group the Motion GFX library inserted — used to
 *  decide whether the element section belongs in the Inspector at all. */
export function isMographGroup(nodeId: string): boolean {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return false;
  const kind = node.components.find((c) => (c.props as Record<string, unknown>)[SCENE_KIND_PROP] !== undefined);
  return mographIdOf(nodeId) !== null && kind !== undefined;
}
