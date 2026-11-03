/**
 * What the Plugins sidebar and a plugin's page do to a plugin and with what it
 * brings: apply one of its effects or presets to the selected layers, open its
 * page, and the plugin's right-click menu. One place, so the row and the page
 * can never disagree.
 */

import { useSyncExternalStore } from 'react';
import { edit } from '@core/engine/uiEdits';
import type { PluginEffectDef } from '@core/inspector/pluginEffectDefs';
import {
  pluginContribRevision,
  pluginInfos,
  subscribePluginContrib,
} from '@core/nativePlugins/pluginContrib';
import { applyPluginPresetCommand, type PluginPreset } from '@core/nativePlugins/pluginPresets';
import {
  canOpenNativePluginFolder,
  openNativePluginFolder,
  type NativePlugin,
} from '@core/nativePlugins/nativePlugins';
import type { InstalledState } from '@hooks/usePluginStore';
import { addEffectEdit } from '@layout/Effects/effectEdits';
import { revealAppliedEffects } from '@layout/Effects/revealEffectControls';
import type { ContextMenuItem } from '@stores/contextMenuStore';
import { usePluginPageStore } from '@stores/pluginPageStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import { t } from '@core/i18n';

function selectedLayers(): ReadonlyArray<string> {
  return useSelectionStore.getState().ids;
}

function needLayer(): boolean {
  if (selectedLayers().length > 0) return false;
  useUIStore.getState().notify({ level: 'info', message: t('plugins.panel.selectLayerFirst', 'Select a layer first, then apply the effect again.'), durationMs: 3000 });
  return true;
}

/** Add a plugin effect to the selected layers (one undo entry each, as Effects & Presets). */
export function applyPluginEffect(def: PluginEffectDef): void {
  if (needLayer()) return;
  void addEffectEdit(selectedLayers(), def.type);
  revealAppliedEffects();
}

/** Apply a plugin preset to the selected layers: one addEffect with the preset's values, one undo entry. */
export function applyPluginPreset(preset: PluginPreset): void {
  if (needLayer()) return;
  void edit(`Apply ${preset.name}`, applyPluginPresetCommand(preset, selectedLayers()));
  revealAppliedEffects();
}

/** Open (or bring forward) a plugin's page in the main body. */
export function openPluginPage(id: string, name: string, owner?: boolean): void {
  usePluginPageStore.getState().open({ id, name: name || id, ...(owner ? { owner: true } : {}) });
}

/**
 * The engine's plugin list, as the contributions cache holds it — refreshed by
 * the shell, the sidebar and every install / enable / rescan — so the sidebar
 * and a plugin's page read one list.
 */
export function useEnginePlugins(): readonly NativePlugin[] | null {
  const revision = useSyncExternalStore(subscribePluginContrib, pluginContribRevision, pluginContribRevision);
  return revision > 0 ? pluginInfos() : null;
}

/** Right-click on an installed plugin: what can be done to the plugin itself. */
export function pluginMenuItems(plugin: NativePlugin, store: InstalledState): ContextMenuItem[] {
  const name = plugin.name || plugin.id;
  const mine = store.installed?.plugins[plugin.id];
  const queued = store.installed?.uninstall.includes(plugin.id) ?? false;
  const update = store.updates.get(plugin.id);
  const busy = store.busy !== null;
  const items: ContextMenuItem[] = [
    { id: 'details', label: t('plugins.sidebar.openPage', 'Open Plugin Page'), onSelect: () => openPluginPage(plugin.id, name) },
    { id: 'sep-details', separator: true },
  ];
  if (plugin.status !== 'revoked' && plugin.status !== 'locked') {
    const enabled = plugin.status !== 'disabled';
    items.push({
      id: 'enable',
      label: enabled ? t('plugins.panel.disable', 'Disable') : t('plugins.panel.enable', 'Enable'),
      disabled: busy || plugin.status === 'failed',
      onSelect: () => void store.setEnabled(plugin.id, !enabled),
    });
  }
  if (update && !queued) {
    items.push({ id: 'update', label: t('plugins.list.updateTo', 'Update to {version}', { version: update.latestVersion }), disabled: busy, onSelect: () => void store.install(plugin.id, update.latestVersion) });
  }
  if (plugin.status === 'locked') {
    items.push({ id: 'plan', label: t('plugins.list.checkPlan', 'Check plan'), disabled: busy, onSelect: () => void store.checkPlan() });
  }
  if (canOpenNativePluginFolder()) {
    items.push({ id: 'sep-folder', separator: true });
    items.push({ id: 'folder', label: t('plugins.panel.showInFolder', 'Show in Folder'), icon: 'folder-open', onSelect: () => void openNativePluginFolder() });
  }
  if (mine && !queued) {
    items.push(
      { id: 'sep-uninstall', separator: true },
      { id: 'uninstall', label: t('plugins.list.uninstall', 'Uninstall {name}', { name }), icon: 'trash', danger: true, disabled: busy, onSelect: () => void store.uninstall(plugin.id) },
    );
  }
  // No trailing separator when nothing followed the page entry.
  if (items[items.length - 1]?.separator) items.pop();
  return items;
}
