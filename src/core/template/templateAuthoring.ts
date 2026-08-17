/**
 * Template authoring — turn the CURRENT composition into a template by exposing
 * specific layers as editable fields, without writing code. The field manifest
 * is stored as a `__templateFields` prop on the comp root's meta component (via
 * writeProp), so it travels with the scene like any other node data and stays
 * hidden from the generic inspector (same `__` convention as audio props).
 *
 * A field is inferred from the selected layer's kind:
 *   text layer  → Text.content   (text)
 *   image layer → Transform.src  (image)
 *   shape layer → Style.fill     (colour)
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { activeCompRootId } from '@core/scene/activeComp';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { declareSlot, DEFAULT_SLOT_FIT } from './mediaSlots';
import { bumpScene } from '@stores/sceneStore';
import { slugFieldId, uniqueFieldId, isPublicFieldId } from '@core/automation/fieldIds';
import type { TemplateField } from './templateTypes';

const FIELDS_PROP = '__templateFields';

/** The comp root's first (meta) component — where we stash the manifest. */
function metaComponentId(rootId: string): string | null {
  const node = defaultSceneGraph.getNode(rootId);
  return node?.components[0]?.id ?? null;
}

/** The template fields authored on a composition (empty when none). */
export function readAuthoredFields(rootId: string = activeCompRootId()): TemplateField[] {
  const node = defaultSceneGraph.getNode(rootId);
  if (!node) return [];
  for (const c of node.components) {
    const v = (c.props as Record<string, unknown>)[FIELDS_PROP];
    if (Array.isArray(v)) return v as TemplateField[];
  }
  return [];
}

function writeAuthoredFields(rootId: string, fields: TemplateField[]): void {
  const componentId = metaComponentId(rootId);
  if (!componentId) return;
  defaultSceneGraph.writeProp(rootId, componentId, FIELDS_PROP, fields);
  bumpScene();
}

function nextFieldId(label: string, existing: readonly TemplateField[]): string {
  const taken = new Set(existing.map((f) => f.id));
  return uniqueFieldId(slugFieldId(label) || 'input', taken);
}

/** Build a field that exposes the primary editable prop of `nodeId`, or null if
 *  the node has nothing obviously editable. Default value = its current value. */
export function inferFieldForNode(nodeId: string): TemplateField | null {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return null;
  const label = node.name || 'Field';
  const id = nextFieldId(label, readAuthoredFields());

  const text = node.components.find((c) => c.type === 'Text');
  if (text) {
    return {
      id, label, kind: 'text', group: 'Text',
      default: String((text.props as Record<string, unknown>).content ?? ''),
      target: { nodeId, componentType: 'Text', prop: 'content' },
    };
  }

  // MEDIA SLOT — any layer that shows a source, not just stills.
  //
  // This used to require `sceneKind === 'image'`, so a video placeholder could
  // not be exposed at all: the most obvious thing to want in a product-launch
  // template (drop your clip here) was the one thing the author could not
  // offer. Asking `sourceOf` instead of matching a kind means stills, footage,
  // image sequences and placed compositions are all slottable by the same rule,
  // and no new source kind has to be remembered here later.
  const transform = node.components.find((c) => c.type === 'Transform');
  const sceneKind = transform && (transform.props as Record<string, unknown>)[SCENE_KIND_PROP];
  if (transform && (sceneKind === 'image' || sceneKind === 'video' || sceneKind === 'svg' || sceneKind === 'comp')) {
    // Capture the placeholder's box as the slot rect NOW, while it is still the
    // authored design — after the first fill the box is the fitted size, and
    // capturing then would make every later fill compound.
    declareSlot(nodeId, DEFAULT_SLOT_FIT);
    return {
      id, label, kind: 'media', group: 'Media', fit: DEFAULT_SLOT_FIT,
      default: String((transform.props as Record<string, unknown>).src ?? ''),
      target: { nodeId, componentType: 'Transform', prop: 'src' },
    };
  }

  const style = node.components.find((c) => c.type === 'Style');
  if (style) {
    return {
      id, label, kind: 'color', group: 'Colours',
      default: String((style.props as Record<string, unknown>).fill ?? '#000000'),
      target: { nodeId, componentType: 'Style', prop: 'fill' },
    };
  }

  return null;
}

/** Expose a node as a template field on the current comp. Returns the field, or
 *  null when the node isn't exposable. Re-exposing the same target is idempotent
 *  (updates in place rather than duplicating). */
export function exposeNodeAsField(nodeId: string): TemplateField | null {
  const field = inferFieldForNode(nodeId);
  if (!field) return null;
  const rootId = activeCompRootId();
  const existing = readAuthoredFields(rootId);
  const prior = existing.find(
    (f) => f.target.nodeId === field.target.nodeId && f.target.prop === field.target.prop,
  );
  const next = prior ? { ...field, id: prior.id } : field;
  writeAuthoredFields(
    rootId,
    [...existing.filter((f) => f.id !== next.id), next],
  );
  return next;
}

export function removeAuthoredField(fieldId: string): void {
  const rootId = activeCompRootId();
  writeAuthoredFields(rootId, readAuthoredFields(rootId).filter((f) => f.id !== fieldId));
}

export function renameAuthoredField(fieldId: string, label: string): void {
  const rootId = activeCompRootId();
  writeAuthoredFields(rootId, readAuthoredFields(rootId).map((f) => (f.id === fieldId ? { ...f, label } : f)));
}

/**
 * Change the public input id n8n will send. Rejects collisions and ids that
 * are not a public slug. Returns false when the rename did not apply.
 */
export function renameAuthoredFieldId(fieldId: string, nextId: string): boolean {
  const id = nextId.trim();
  if (!isPublicFieldId(id)) return false;
  const rootId = activeCompRootId();
  const fields = readAuthoredFields(rootId);
  if (fields.some((f) => f.id === id && f.id !== fieldId)) return false;
  writeAuthoredFields(
    rootId,
    fields.map((f) => (f.id === fieldId ? { ...f, id } : f)),
  );
  return true;
}
