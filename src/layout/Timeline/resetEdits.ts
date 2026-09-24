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

import { Matrix } from '@motion/scene';
import type { LayerInfo } from '@motion/engine-api';
import { resetTransformWrites, propertyResetValue, type ResetTransformInput } from '@core/scene/layerTransformOps';
import { engine } from '@core/engine/engineInstance';
import { compTime } from '@core/engine/propRefs';
import { edit } from '@core/engine/uiEdits';
import { uiKindOf } from '@core/mirror/layerKinds';
import { mirrorPropertyMeta } from '@core/mirror/metaFacts';
import { trackRefIn } from '@core/mirror/trackIndex';
import { documentMirror } from '@stores/documentMirror';
import { valueCommands } from '@layout/Inspector/inspectorEdits';
import { getTime } from '@stores/playbackClockStore';
import { activeCompIdNow } from '@hooks/useMirror';

/** The active composition's frame size (what Reset centres Position in), from the document mirror (B4). */
export function activeCompSize(): { width: number; height: number } {
  const s = documentMirror().comp(activeCompIdNow() ?? '')?.settings;
  return { width: s?.width ?? 1920, height: s?.height ?? 1080 };
}

function playheadSeconds(): number {
  return getTime();
}

/**
 * The comp centre in the layer's PARENT space (a layer's position lives
 * there): the inverse of the parent's layer→comp matrix at `seconds`, asked
 * of the engine (`getLayerTransforms`); the comp's own space at the top of a
 * comp, or when the engine cannot say.
 */
async function centreInParent(layer: LayerInfo, comp: { width: number; height: number }, seconds: number): Promise<{ x: number; y: number }> {
  const centre = { x: comp.width / 2, y: comp.height / 2 };
  if (!layer.parent) return centre;
  const res = await engine().query({ type: 'getLayerTransforms', layers: [layer.parent], time: compTime(seconds) });
  const m = res.ok ? res.value.transforms[0]?.matrix : undefined;
  if (!m || m.length < 16) return centre;
  // Column-major 4×4 → the 2D affine (a b c d e f).
  const world = { a: m[0]!, b: m[1]!, c: m[4]!, d: m[5]!, e: m[12]!, f: m[13]! };
  return Matrix.transformPoint(Matrix.invert(world), centre);
}

/**
 * What Reset needs to know about a layer (the mirror twin of
 * `layerTransformOps.resetInputFor`), from the document MIRROR (B4): its
 * kind, its 3D switch, whether it carries an Opacity property.
 */
async function resetInputOf(layer: LayerInfo, comp: { width: number; height: number }, seconds: number): Promise<ResetTransformInput> {
  return {
    kind: uiKindOf(layer) ?? 'shape',
    is3D: layer.switches.threeD,
    hasOpacity: trackRefIn(documentMirror().tree(layer.id), 'opacity') !== null,
    centre: await centreInParent(layer, comp, seconds),
  };
}

/** Reset the Transform group of each layer — one entry. */
export async function resetTransformEdit(ids: ReadonlyArray<string>, comp: { width: number; height: number }): Promise<void> {
  const seconds = playheadSeconds();
  const m = documentMirror();
  const entries: Array<{ nodeId: string; values: Record<string, number> }> = [];
  for (const id of ids) {
    const layer = m.layer(id);
    if (!layer || layer.switches.locked) continue;
    const values: Record<string, number> = {};
    for (const w of resetTransformWrites(await resetInputOf(layer, comp, seconds))) values[w.prop] = w.value;
    entries.push({ nodeId: id, values });
  }
  const cmds = valueCommands(entries, { seconds, autoKeyframe: false });
  if (cmds.length > 0) await edit(entries.length === 1 ? 'Reset Transform' : `Reset Transform (${entries.length} layers)`, cmds);
}

/** Reset the props behind ONE timeline row — one entry. */
export async function resetPropertiesEdit(
  nodeId: string,
  props: ReadonlyArray<string>,
  comp: { width: number; height: number },
  label = 'Reset Property',
): Promise<void> {
  const seconds = playheadSeconds();
  const m = documentMirror();
  const layer = m.layer(nodeId);
  if (!layer || layer.switches.locked) return;
  const defaults = resetTransformWrites(await resetInputOf(layer, comp, seconds));
  const tree = m.tree(nodeId);
  const values: Record<string, number> = {};
  for (const prop of props) {
    const v = propertyResetValue(prop, defaults, mirrorPropertyMeta(prop, layer, tree).defaultValue);
    if (v !== undefined) values[prop] = v;
  }
  const cmds = valueCommands([{ nodeId, values }], { seconds, autoKeyframe: false });
  if (cmds.length > 0) await edit(label, cmds);
}
