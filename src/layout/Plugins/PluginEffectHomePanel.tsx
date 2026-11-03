/**
 * An effect plugin's own sidebar panel (`plugin:<id>`, owner 2026-10-14): the
 * bundle's page (`ui/index.html`) docked as a panel of its own, the way After
 * Effects gives Element 3D or Optical Flares a window of their own instead of
 * folding them into Effect Controls.
 *
 * The page edits one effect instance. By default the panel follows the
 * selection: the first selected layer's first effect from this plugin. The
 * tab's ≡ / right-click menu can PIN it to the instance it shows (owner board
 * 2, 2026-11-03): it then stays on that layer's effect whatever is selected,
 * until the pin is lifted or the layer or effect is gone
 * (pluginDockRules.ts `pinStatus`). The pin is editor state
 * (stores/pluginPanelPinStore.ts), never the project document. With no effect
 * to show, the panel says so and offers to apply the plugin's effect to the
 * selected layer. The frame is the same one the effect card's "Open Panel…"
 * window shows (Effects/PluginPanel.tsx): one protocol, every edit an engine
 * command.
 */

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { Button } from '@components/Button';
import { useDockPanelHeader } from '@components/DockPanel';
import type { DropdownItem } from '@components/Dropdown';
import { EmptyState } from '@components/EmptyState';
import { Icon } from '@components/Icon';
import { effectDefFor } from '@core/inspector/effectCatalog';
import {
  isPluginEffectDef,
  pluginEffectDefs,
  pluginEffectDefsRevision,
  subscribePluginEffectDefs,
  type PluginEffectDef,
} from '@core/inspector/pluginEffectDefs';
import { mirrorEffects } from '@core/mirror/effects';
import { useMirrorLayer, useMirrorStatus, useMirrorTreeGroups } from '@hooks/useMirror';
import { PluginEffectFrame } from '@layout/Effects/PluginPanel';
import { addEffectEdit } from '@layout/Effects/effectEdits';
import { useActiveWorkspace } from '@stores/projectStore';
import { usePluginPanelPinStore } from '@stores/pluginPanelPinStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import { pinStatus } from './pluginDockRules';
import styles from './PluginEffectHomePanel.module.css';
import { t } from '@core/i18n';

const EFFECTS_ROOT: readonly string[] = ['effects'];

export function PluginEffectHomePanel({ panelId, plugin, pluginName }: { panelId?: string; plugin: string; pluginName: string }): JSX.Element {
  // A plugin's effect definitions can arrive after the panel drew.
  useSyncExternalStore(subscribePluginEffectDefs, pluginEffectDefsRevision, pluginEffectDefsRevision);
  const selectedId = useSelectionStore((s) => s.ids[0] ?? null);
  const pin = usePluginPanelPinStore((s) => (panelId ? s.pins[panelId] : undefined));
  const docReady = useMirrorStatus() === 'ready';
  const selectedLayer = useMirrorLayer(selectedId);
  const selectedTree = useMirrorTreeGroups(selectedId, EFFECTS_ROOT);
  const pinnedLayer = useMirrorLayer(pin?.layerId ?? null);
  const pinnedTree = useMirrorTreeGroups(pin?.layerId ?? null, EFFECTS_ROOT);
  const time = useActiveWorkspace()?.time ?? 0;

  const own = (type: string): PluginEffectDef | undefined => {
    const def = effectDefFor(type);
    return isPluginEffectDef(def) && def.provider === plugin ? def : undefined;
  };
  const pinnedEffect = pin && pinnedTree ? mirrorEffects(pinnedTree).find((e) => e.id === pin.effectId && own(e.type)) : undefined;
  const status = pinStatus({
    pin,
    docReady,
    layerExists: !!pinnedLayer,
    effectsLoaded: pinnedTree !== undefined,
    effectExists: !!pinnedEffect,
  });

  // A pin whose layer or effect is gone: back to following the selection.
  useEffect(() => {
    if (status === 'stale' && panelId) usePluginPanelPinStore.getState().unpin(panelId);
  }, [status, panelId]);

  const pinned = status === 'active';
  const layerId = pinned ? pin!.layerId : selectedId;
  const layer = pinned ? pinnedLayer : selectedLayer;
  const effect = pinned ? pinnedEffect : selectedId ? mirrorEffects(selectedTree).find((e) => own(e.type)) : undefined;
  const def = effect ? own(effect.type) : undefined;

  // The tab's ≡ / right-click rows: what the panel is bound to, and Follow / Pin.
  const header = useDockPanelHeader();
  const setMenu = header?.setCustomMenuItems;
  const effectLabel = def?.label ?? '';
  const layerName = layer?.name ?? '';
  const bound = !!(layerId && effect && def);
  const effectId = effect?.id ?? null;
  const items = useMemo((): DropdownItem[] => {
    if (!panelId) return [];
    const target = { effect: effectLabel, layer: layerName };
    const info = !bound
      ? t('plugins.effectHome.bindingNone', 'Follows the selection: no {plugin} effect selected', { plugin: pluginName })
      : pinned
        ? t('plugins.effectHome.bindingPinned', 'Pinned: {effect} on “{layer}”', target)
        : t('plugins.effectHome.bindingFollows', 'Follows: {effect} on “{layer}”', target);
    return [
      { type: 'label', label: info },
      {
        type: 'checkbox',
        id: 'plugin-follow-selection',
        label: t('plugins.effectHome.followSelection', 'Follows Selection'),
        checked: !pinned,
        onChange: () => usePluginPanelPinStore.getState().unpin(panelId),
      },
      {
        type: 'checkbox',
        id: 'plugin-pin-effect',
        label: bound
          ? t('plugins.effectHome.pinTo', 'Pin to {effect} on “{layer}”', target)
          : t('plugins.effectHome.pinToEffect', 'Pin to This Effect'),
        checked: pinned,
        disabled: !bound && !pinned,
        onChange: (on) => {
          if (!on) usePluginPanelPinStore.getState().unpin(panelId);
          else if (layerId && effectId) usePluginPanelPinStore.getState().pin(panelId, { layerId, effectId });
        },
      },
    ];
  }, [panelId, pluginName, effectLabel, layerName, bound, pinned, layerId, effectId]);
  useEffect(() => {
    setMenu?.(items);
  }, [setMenu, items]);

  if (layerId && effect && def) {
    return (
      <div className={styles.panel}>
        <div className={styles.context}>
          <Icon name={pinned ? 'push-pin' : 'layers'} size="sm" className={styles.contextIcon} />
          <span className={styles.contextText} title={layer?.name}>{layer?.name ?? t('plugins.effectHome.layer', 'Layer')}</span>
          <span className={styles.contextMeta}>
            {pinned ? t('plugins.effectHome.pinnedMeta', '{effect} · pinned', { effect: def.label }) : def.label}
          </span>
        </div>
        <div className={styles.frame}>
          <PluginEffectFrame key={`${layerId}:${effect.id}`} nodeId={layerId} effect={effect} def={def} time={time} plugin={plugin} />
        </div>
      </div>
    );
  }

  const offered = pluginEffectDefs().filter((d) => d.provider === plugin);
  const apply = (d: PluginEffectDef): void => {
    if (!selectedId) return;
    void addEffectEdit([selectedId], d.type).then((added) => {
      if (added.length > 0) useUIStore.getState().notify({ level: 'success', message: t('plugins.effectHome.added', 'Added {name}', { name: d.label }), durationMs: 2400 });
    });
  };
  return (
    <div className={styles.panel}>
      <EmptyState
        icon="plugin"
        message={
          selectedId
            ? t('plugins.effectHome.noEffect', '{layer} has no {plugin} effect. Apply it to edit the layer here.', {
                layer: selectedLayer?.name ?? t('plugins.effectHome.thisLayer', 'This layer'),
                plugin: pluginName,
              })
            : t('plugins.effectHome.selectLayer', 'Select a layer with {plugin} applied to edit it here.', { plugin: pluginName })
        }
        action={
          selectedId && offered.length > 0 ? (
            <>
              {offered.map((d) => (
                <Button key={d.type} size="sm" variant="secondary" leftIcon={<Icon name="plus" size="sm" />} onClick={() => apply(d)}>
                  {t('plugins.effectHome.apply', 'Apply {name}', { name: d.label })}
                </Button>
              ))}
            </>
          ) : undefined
        }
      />
    </div>
  );
}
