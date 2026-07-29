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
import { readSvgLayer } from '@core/svg/svgLayer';
import { convertSvgLayerToShapes, describeConversion, canRevertToSvg, revertSvgGroupToLayer } from '@core/svg/svgConvert';
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
  return ok ? convertSvgLayerToShapes(nodeId) : null;
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
