/**
 * Properties ▸ <layer> for a native plugin LAYER TYPE (SDK 1.4, docs/PLUGIN_SDK.md "Layer types"):
 * the layer's own effect (`layer`, the type's generator) is its content, so its params are shown
 * here as the layer's own properties — the same rows as its Effect Controls card (stopwatches,
 * keyframes, expressions) — instead of a shape layer's fill / stroke / corners, which do not
 * draw anything on it.
 */

import { memo, useEffect, useSyncExternalStore } from 'react';
import { t } from '@core/i18n';
import { mirrorEffects } from '@core/mirror/effects';
import { effectDefFor } from '@core/inspector/effectCatalog';
import { pluginEffectDefsRevision, refreshPluginEffectDefs, subscribePluginEffectDefs } from '@core/inspector/pluginEffectDefs';
import { engine } from '@core/engine/engineInstance';
import { useMirrorTreeGroups } from '@hooks/useMirror';
import { EffectParamsBody } from '@layout/Effects/EffectStack';
import styles from './PluginLayerSection.module.css';

const EFFECTS_ROOT = ['effects'] as const;
/** createLayer kind=generator names the layer's own effect `layer` (native/engine handlers_layers.hpp). */
const OWN_EFFECT_ID = 'layer';

function PluginLayerSectionInner({ nodeId }: { nodeId: string }): JSX.Element {
  const tree = useMirrorTreeGroups(nodeId, EFFECTS_ROOT);
  // The plugin's param definitions can arrive after the panel drew.
  useSyncExternalStore(subscribePluginEffectDefs, pluginEffectDefsRevision, pluginEffectDefsRevision);
  const own = mirrorEffects(tree).find((e) => e.id === OWN_EFFECT_ID);
  const type = own?.type;
  // Plugin definitions are asked for when the Effects panel opens; a layer made from Layer ▸ New can
  // be here first — ask now, and the subscription above redraws when they arrive.
  useEffect(() => {
    if (type && !effectDefFor(type)) void refreshPluginEffectDefs(engine());
  }, [type]);
  if (!own) {
    return <p className={styles.missing}>{t('inspector.pluginLayer.missing', 'The plugin that draws this layer is not loaded.')}</p>;
  }
  return <EffectParamsBody nodeId={nodeId} effect={own} />;
}

export const PluginLayerSection = memo(PluginLayerSectionInner);
