/**
 * A layer's LABEL colour from a mirror `LayerInfo` (B4) — the mirror twin of
 * `readNodeLabelColor` / `getNodeLabelColor` (core/scene/labelColor.ts). Pure.
 *
 * The API reports a palette label as its index (`switches.label`, 1-based into
 * `LABEL_COLORS`, 0 = none) and an off-palette colour as itself
 * (`switches.labelColor`). Undefined = no label (the kind's default colour).
 */

import type { LayerInfo } from '@motion/engine-api';
import { LABEL_COLORS } from '@core/scene/labelColor';

/** The label colour hex, or undefined when the layer has none. */
export function mirrorLabelColor(layer: Pick<LayerInfo, 'switches'> | undefined): string | undefined {
  if (!layer) return undefined;
  const i = layer.switches.label;
  if (i > 0) return LABEL_COLORS[i - 1]?.color;
  return layer.switches.labelColor || undefined;
}
