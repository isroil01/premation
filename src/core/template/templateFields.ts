/**
 * Read/write an exposed template field against the LIVE scene graph. A field
 * targets a prop on a node's component by componentType; we resolve that to the
 * concrete component at call time and write through `SceneGraph.writeProp`, then
 * bump the scene so the viewport (and any open panel) re-renders.
 *
 * This is the whole "editing" side of the template system — it reuses the exact
 * mutation path the inspector uses, so template edits are ordinary prop writes.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { bumpScene } from '@stores/sceneStore';
import { fillSlot } from './mediaSlots';
import type { TemplateField } from './templateTypes';

/** The concrete component id of `componentType` on `nodeId`, or null. */
function componentIdFor(nodeId: string, componentType: string): string | null {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return null;
  const comp = node.components.find((c) => c.type === componentType);
  return comp ? comp.id : null;
}

/** Current value of a field, read straight off the node (undefined if the node/
 *  component is missing — e.g. the template changed under a stale field list). */
export function readTemplateFieldValue(field: TemplateField): unknown {
  const node = defaultSceneGraph.getNode(field.target.nodeId);
  if (!node) return undefined;
  const comp = node.components.find((c) => c.type === field.target.componentType);
  if (!comp) return undefined;
  return (comp.props as Record<string, unknown>)[field.target.prop];
}

/** Write a field's value through the scene graph and re-render. Returns false
 *  when the target node/component no longer exists (nothing written). */
export function writeTemplateField(field: TemplateField, value: string | number): boolean {
  const componentId = componentIdFor(field.target.nodeId, field.target.componentType);
  if (!componentId) return false;
  // A media field is a SLOT fill, not a prop write: it repoints the asset and
  // reframes the layer against the slot rect. Routed here so every surface that
  // fills a template — panel, AI, a future drag-and-drop — gets the framing,
  // rather than each one remembering to call it.
  if (isMediaField(field) && typeof value === 'string') {
    const filled = fillSlot(field.target.nodeId, value);
    return filled !== null;
  }

  const ok = defaultSceneGraph.writeProp(field.target.nodeId, componentId, field.target.prop, value);
  if (ok) bumpScene();
  return ok;
}

/** True for fields that swap a layer's SOURCE (as opposed to text or colour). */
export function isMediaField(field: TemplateField): boolean {
  return (field.kind === 'image' || field.kind === 'media') && field.target.prop === 'src';
}
