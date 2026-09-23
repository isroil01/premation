/**
 * SVG layer actions shared by every menu that offers them.
 *
 * Both right-click menus (canvas and scene tree) and the Inspector button must
 * open the SAME confirmation with the SAME wording — a "Convert" that warns
 * about 247 layers in one place and silently converts in another is worse than
 * having only one entry point.
 */

import type { ContextMenuItem } from '@stores/contextMenuStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { forgetSvgLayerSrc, readSvgLayer } from '@core/svg/svgLayer';
import type { Command } from '@motion/engine-api';
import {
  buildSvgShapeGroup,
  describeConversion,
  canRevertToSvg,
  revertSvgGroupToLayer,
  notifyNoSvgGeometry,
  notifySvgConverted,
  type BuiltSvgShapes,
} from '@core/svg/svgConvert';
import { activeCompRootId } from '@core/scene/activeComp';
import { buildLayerFragment, type BuiltLayers } from '@core/engine/offDocument';
import { layerIdsOfComp, compOfLayer } from '@core/engine/doc';
import { edit, reportEngineError } from '@core/engine/uiEdits';
import { useSelectionStore } from '@stores/selectionStore';
import { customConfirm } from '@components/Modal';

/** Ask what conversion costs, then do it. Resolves to the new group id or null. */
export async function confirmAndConvertSvg(nodeId: string): Promise<string | null> {
  const node = defaultSceneGraph.getNode(nodeId);
  const data = node ? readSvgLayer(node) : null;
  if (!data) return null;
  const ok = await customConfirm(
    'Convert to Editable Shapes',
    describeConversion(data).join('\n\n'),
    { confirmLabel: 'Convert', cancelLabel: 'Cancel' },
  );
  return ok ? convertSvgToShapes(nodeId) : null;
}

/**
 * Convert to Editable Shapes — a client macro (ENGINE_API.md §15.9 B3z): the
 * SVG parser (fonts for <text>, clip intersection, CSS/SMIL → keys) runs in the
 * editor, off-document, and its RESULT — the editable group — goes to the
 * engine as ONE batch: `pasteLayers` at the SVG layer's stack slot, then
 * `deleteLayers` of the SVG layer. One undo entry, replayable in both engines.
 */
export async function convertSvgToShapes(nodeId: string): Promise<string | null> {
  const node = defaultSceneGraph.getNode(nodeId);
  const data = node ? readSvgLayer(node) : null;
  if (!data) return null;
  const comp = activeCompRootId();
  let result: BuiltSvgShapes | null = null;
  let built: BuiltLayers | null;
  try {
    built = buildLayerFragment(comp, () => { result = buildSvgShapeGroup(nodeId); });
  } catch (err) {
    reportEngineError('Convert SVG to Editable Shapes', { code: 'internal', message: err instanceof Error ? err.message : String(err) });
    return null;
  }
  const r = result as BuiltSvgShapes | null;
  if (!built || !r) {
    notifyNoSvgGeometry(data.fileName);
    return null;
  }
  // Replace in place (AE's conversions put the result where the source was):
  // the SVG layer's stack slot, inside the same parent layer when it is nested.
  const inComp = compOfLayer(nodeId) === comp;
  const slot = inComp ? layerIdsOfComp(comp).indexOf(nodeId) : -1;
  const parent = inComp ? (node?.parent !== comp ? node?.parent : undefined) : built.parent;
  const paste = {
    type: 'pasteLayers',
    comp,
    fragment: built.fragment,
    index: slot >= 0 ? slot : built.index,
    ...(parent ? { parent } : {}),
  } as Command;
  const res = await edit('Convert SVG to Editable Shapes', [paste, { type: 'deleteLayers', layers: [nodeId] }]);
  if (!res.ok) return null;
  const groupId = (res.value[0] as { layers?: string[] } | undefined)?.layers?.[0] ?? null;
  forgetSvgLayerSrc(nodeId);
  if (groupId) useSelectionStore.getState().set([groupId]);
  notifySvgConverted(r.data, r.count);
  return groupId;
}

/**
 * The SVG entries for a layer's context menu — empty for a layer that is
 * neither an SVG nor converted from one, so call sites can splat unconditionally.
 */
export function svgContextMenuItems(nodeId: string): ContextMenuItem[] {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return [];

  if (readSvgLayer(node)) {
    return [
      { id: 'svg-sep', separator: true },
      {
        id: 'svg-convert',
        label: 'Convert to Editable Shapes…',
        onSelect: () => { void confirmAndConvertSvg(nodeId); },
      },
    ];
  }
  if (canRevertToSvg(nodeId)) {
    return [
      { id: 'svg-sep', separator: true },
      {
        id: 'svg-revert',
        label: 'Revert to Original SVG',
        onSelect: () => { revertSvgGroupToLayer(nodeId); },
      },
    ];
  }
  return [];
}
