/**
 * The one answer to "what pixel grid is the track point in?".
 *
 * Everything user-facing (the overlay, the inspector fields, the stored
 * point, applied samples) speaks the source's DISPLAY grid — storedWidth ×
 * PAR by storedHeight, the same numbers Interpret Footage shows. The decoder
 * hands the tracker CODED-size planes (padding and anamorphic squeeze
 * included), and trackVideoLayer converts at that boundary in both
 * directions. Two modules quietly assuming different grids is a half-pixel
 * bug that looks like tracker drift, so the conversion lives in exactly one
 * file — this one plus the two scale calls in trackVideoLayer.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { footageSourceOf } from '@core/source/sourceInfo';

export function sourceDisplaySize(nodeId: string): { width: number; height: number } | null {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return null;
  const s = footageSourceOf(node);
  if (!s || s.width <= 0 || s.height <= 0) return null;
  return { width: s.width, height: s.height };
}
