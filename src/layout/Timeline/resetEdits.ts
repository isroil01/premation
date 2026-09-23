/**
 * The timeline's Reset (the Transform group heading, a property row's
 * right-click) through the engine API (B3z) — a client macro (ENGINE_API.md §1
 * rule 7): the defaults are the ones `layerTransformOps` computes (Position =
 * the comp centre in the parent's space, anchor 0,0, scale 100 %, rotation 0,
 * opacity 100 %; the property registry's rest value for any other row), sent
 * as ONE entry of `setProperties` at the playhead.
 *
 * After Effects semantics, not the old helper's: AE's Reset on an animated
 * property sets the default AT THE CURRENT TIME (a keyframe there), exactly
 * what `setProperty{time}` does; the legacy helper removed every keyframe of
 * the row instead. A static property simply takes the default.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { resetInputFor, resetTransformWrites, propertyResetValue } from '@core/scene/layerTransformOps';
import { resolvePropertyMeta } from '@core/inspector/propertyMeta';
import { edit } from '@core/engine/uiEdits';
import { valueCommands } from '@layout/Inspector/inspectorEdits';
import { getTimelineController } from '@core/timeline/TimelineController';

function playheadSeconds(): number {
  return getTimelineController().currentSeconds;
}

/** Reset the Transform group of each layer — one entry. */
export async function resetTransformEdit(ids: ReadonlyArray<string>, comp: { width: number; height: number }): Promise<void> {
  const entries: Array<{ nodeId: string; values: Record<string, number> }> = [];
  for (const id of ids) {
    const node = defaultSceneGraph.getNode(id);
    if (!node || node.locked) continue;
    const values: Record<string, number> = {};
    for (const w of resetTransformWrites(resetInputFor(id, node, comp))) values[w.prop] = w.value;
    entries.push({ nodeId: id, values });
  }
  const cmds = valueCommands(entries, { seconds: playheadSeconds(), autoKeyframe: false });
  if (cmds.length > 0) await edit(entries.length === 1 ? 'Reset Transform' : `Reset Transform (${entries.length} layers)`, cmds);
}

/** Reset the props behind ONE timeline row — one entry. */
export async function resetPropertiesEdit(
  nodeId: string,
  props: ReadonlyArray<string>,
  comp: { width: number; height: number },
  label = 'Reset Property',
): Promise<void> {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node || node.locked) return;
  const defaults = resetTransformWrites(resetInputFor(nodeId, node, comp));
  const values: Record<string, number> = {};
  for (const prop of props) {
    const v = propertyResetValue(prop, defaults, resolvePropertyMeta(prop, nodeId).defaultValue);
    if (v !== undefined) values[prop] = v;
  }
  const cmds = valueCommands([{ nodeId, values }], { seconds: playheadSeconds(), autoKeyframe: false });
  if (cmds.length > 0) await edit(label, cmds);
}
