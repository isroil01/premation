/**
 * The layer "Use as Source" would replace: exactly one selected image or video
 * layer — `footageWorkflow.replaceableSelectedLayer`'s rule, read from the
 * document mirror (B4) so the Project panel's menu and the footage preview
 * name it from the same record.
 */

import { useSelectionStore } from '@stores/selectionStore';
import { documentMirror } from '@stores/documentMirror';
import { isReplaceableSourceLayer } from '@core/mirror/layerKinds';

export function replaceTargetLayer(): { id: string; name: string } | null {
  const ids = useSelectionStore.getState().ids;
  if (ids.length !== 1) return null;
  const layer = documentMirror().layer(ids[0]!);
  return layer && isReplaceableSourceLayer(layer) ? { id: layer.id, name: layer.name } : null;
}
