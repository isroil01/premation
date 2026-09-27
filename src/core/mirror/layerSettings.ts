/**
 * Layer / Solid Settings' facts over the document MIRROR (B4) — the twins of
 * `layerSettingsKind`, `readLayerSettings` and `nextSolidName`
 * (core/scene/layerSettings.ts). Pure: they take a mirror reader.
 *
 *   solid  a solid layer (`LayerInfo.kind` solid);
 *   sized  a null or adjustment layer carrying its own size (`layer/width`, `layer/height`);
 *   plain  every other layer.
 */

import type { LayerInfo } from '@motion/engine-api';
import { DEFAULT_SOLID_COLOR, type LayerSettingsKind, type LayerSettingsValues } from '@core/scene/layerSettings';
import { mirrorLabelColor } from './layerLabels';
import { mirrorFill, mirrorLayerSize } from './paintFields';
import type { MirrorFieldRead } from './layerFields';

type Read = Pick<MirrorFieldRead, 'layer' | 'property'>;

export function mirrorLayerSettingsKind(m: Read, layer: LayerInfo): LayerSettingsKind {
  if (layer.kind === 'solid') return 'solid';
  if ((layer.kind === 'null' || layer.switches.adjustment) && mirrorLayerSize(m, layer.id)) return 'sized';
  return 'plain';
}

/** The dialog's starting values for a layer, or null when it is gone. */
export function mirrorLayerSettings(m: Read, id: string): { kind: LayerSettingsKind; values: LayerSettingsValues } | null {
  const layer = m.layer(id);
  if (!layer) return null;
  const kind = mirrorLayerSettingsKind(m, layer);
  const values: LayerSettingsValues = { name: layer.name };
  const label = mirrorLabelColor(layer);
  if (label) values.labelColor = label;
  const size = mirrorLayerSize(m, id);
  if (size && kind !== 'plain') {
    values.width = size.width;
    values.height = size.height;
  }
  if (kind === 'solid') {
    const fill = mirrorFill(m, id);
    values.color = fill && fill.type === 'solid' ? fill.color : DEFAULT_SOLID_COLOR;
  }
  return { kind, values };
}

/** "Solid N" — one past the number of solid layers in the project. */
export function mirrorNextSolidName(m: Pick<MirrorFieldRead, 'layer'> & { layerIds(): Iterable<string> }): string {
  let count = 0;
  for (const id of m.layerIds()) if (m.layer(id)?.kind === 'solid') count += 1;
  return `Solid ${count + 1}`;
}
