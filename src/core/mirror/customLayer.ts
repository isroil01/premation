/**
 * A custom plugin layer's record from the document MIRROR (B4) — the twin of
 * `readCustomLayer` (core/plugins/customLayers.ts): the kind from
 * `LayerInfo.generator`, the stored schema version from
 * `LayerInfo.pluginSchemaVersion` (present exactly when `readCustomLayer`
 * finds a record) and the authored values from the layer's `plugin/<name>`
 * properties (pluginProps.ts: every stored prop, typed by what it stores).
 */

import type { LayerInfo } from '@motion/engine-api';
import { splitKind } from '@core/plugins/layerKindSchema';
import type { CustomLayerRecord } from '@core/plugins/customLayers';
import { plainValue, type MirrorTreeLike } from './trackIndex';

/** The record, or null when the layer is not a custom plugin layer. */
export function mirrorCustomLayer(
  layer: Pick<LayerInfo, 'generator' | 'pluginSchemaVersion'> | undefined,
  tree: MirrorTreeLike | undefined,
): CustomLayerRecord | null {
  if (!layer || layer.pluginSchemaVersion === undefined) return null;
  const split = splitKind(layer.generator);
  if (!split) return null;
  const props: Record<string, unknown> = {};
  for (const [path, info] of tree?.nodes ?? []) {
    if (info.kind !== 'property' || !path.startsWith('plugin/')) continue;
    const name = path.slice('plugin/'.length);
    // `plugin/<slug>/<panel>/…` are a contributed panel's params, not the kind's.
    if (name.includes('/')) continue;
    props[name] = plainValue(info.value);
  }
  return { kind: layer.generator, pluginId: split.pluginId, kindId: split.kindId, schemaVersion: layer.pluginSchemaVersion, props };
}
