/**
 * What double-clicking a layer opens — After Effects' rules.
 *
 *   • A COMPOSITION layer opens the composition it shows, or — with the
 *     preference "On Comp Layer Opens: Layer panel" — the Layer panel.
 *     Alt+double-click always does the other one.
 *   • A FOOTAGE layer (video, image, vector, solid) opens the Layer panel, or —
 *     with "On Footage Layer Opens: Source" — its footage in the Footage viewer.
 *     With a paint or Roto tool active it is always the Layer panel, which is
 *     where AE does that work.
 *   • A GROUP (not an AE concept) opens as its own tab, as before.
 *   • Text and shape layers open nothing here: AE has no Layer panel for them
 *     (they are continuously rasterized), and the canvas edits text itself.
 *
 * Returns false when nothing opened, so callers keep their own fallback.
 */

import type { LayerInfo } from '@motion/engine-api';
import { openLayerComposition } from '@core/composition/compNavigation';
import { documentMirror } from '@stores/documentMirror';
import { uiKindOf } from '@core/mirror/layerKinds';
import { useLayerViewerStore } from '@stores/layerViewerStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { useUIStore } from '@stores/uiStore';
import { useAssetStore } from '@stores/assetStore';
import { openFootagePreview } from '@layout/Assets/FootagePreviewDialog';
import type { SceneNode } from '@core/types';

/** Tools whose double-click always means "open the Layer panel" in AE. */
const LAYER_PANEL_TOOLS: ReadonlySet<string> = new Set(['brush', 'paint', 'eraser', 'roto']);

/** A composition layer (it shows another composition). */
function isCompLayer(layer: LayerInfo): boolean {
  return layer.kind === 'precomp' && !!layer.source;
}

/** Whether a mirror layer can be shown in the Layer panel (AE: footage, solids, comps). */
function layerPanelShows(layer: LayerInfo | undefined): boolean {
  if (!layer) return false;
  if (isCompLayer(layer) || layer.kind === 'solid') return true;
  const kind = uiKindOf(layer);
  return kind === 'image' || kind === 'video' || kind === 'svg';
}

/**
 * Can this layer be shown in the Layer panel? (AE: footage, solids, comps.)
 * Read from the document mirror by the layer's id (a node or an id).
 */
export function canOpenInLayerPanel(node: Pick<SceneNode, 'id'> | string | undefined): boolean {
  const id = typeof node === 'string' ? node : node?.id;
  return !!id && layerPanelShows(documentMirror().layer(id));
}

/** Show `nodeId` in the Layer panel. False for a layer it cannot show. */
export function openLayerPanel(nodeId: string): boolean {
  if (!canOpenInLayerPanel(nodeId)) return false;
  useLayerViewerStore.getState().open(nodeId);
  return true;
}

/** AE's double-click on a layer (canvas or timeline). */
export function openLayerOnDoubleClick(nodeId: string, opts: { alt?: boolean } = {}): boolean {
  const node = documentMirror().layer(nodeId);
  if (!node) return false;
  const alt = opts.alt === true;
  const prefs = usePreferenceStore.getState();

  if (isCompLayer(node)) {
    const wantPanel = (prefs.compLayerOpens === 'layer') !== alt;
    return wantPanel
      ? openLayerPanel(nodeId) || openLayerComposition(nodeId)
      : openLayerComposition(nodeId) || openLayerPanel(nodeId);
  }
  if (uiKindOf(node) === 'group') return openLayerComposition(nodeId);
  if (!layerPanelShows(node)) return false;

  const paintTool = LAYER_PANEL_TOOLS.has(useUIStore.getState().activeTool);
  const wantSource = !paintTool && ((prefs.footageLayerOpens === 'source') !== alt);
  if (wantSource) {
    const assetId = node.source;
    // B4-gap: the Footage viewer (layout/Assets) plays the legacy asset record (its runtime
    // `src`); it goes when the viewer takes an item id.
    const asset = assetId ? useAssetStore.getState().assets.find((a) => a.id === assetId) : undefined;
    if (asset) {
      openFootagePreview(asset);
      return true;
    }
    // A solid has no footage to show — the Layer panel is all there is.
  }
  return openLayerPanel(nodeId);
}
