/**
 * PluginsModal — the plugin manager (spec §Extensibility). Lists available
 * plugins with a runtime Install / Uninstall toggle. Installing registers the
 * plugin's commands immediately (no restart) — they appear in the Command
 * Palette right away.
 */

import { useSyncExternalStore, type ChangeEvent } from 'react';
import { Icon } from '@components/Icon';
import { cn } from '@utils/cn';
import { openModal } from '@stores/modalStore';
import { useUIStore } from '@stores/uiStore';
import pluginHost from '@core/plugins/PluginHost';
import { SAMPLE_PLUGINS } from '../../plugins/samplePlugins';
import styles from './PluginsModal.module.css';

function PluginsList(): JSX.Element {
  // Re-render whenever install state changes.
  useSyncExternalStore(
    (cb) => pluginHost.subscribe(cb),
    () => SAMPLE_PLUGINS.filter((p) => pluginHost.isInstalled(p.id)).length + pluginHost.getUserPlugins().length,
  );

  const allPlugins = [...SAMPLE_PLUGINS, ...pluginHost.getUserPlugins()];

  const handleLoadScript = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      const code = evt.target?.result as string;
      if (!code) return;
      try {
        const loaded = pluginHost.installFromSource(code);
        useUIStore.getState().notify({
          level: 'success',
          message: `Installed plugin: “${loaded.name}”`,
          durationMs: 3000,
        });
      } catch (err) {
        useUIStore.getState().notify({
          level: 'error',
          message: `Plugin load failed: ${(err as Error).message}`,
          durationMs: 5000,
        });
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  return (
    <div className={styles.list}>
      <label className={styles.loadBtn}>
        <Icon name="upload" size={14} />
        <span>Load External Plugin Script (.js)</span>
        <input
          type="file"
          accept=".js,.ts"
          style={{ display: 'none' }}
          onChange={handleLoadScript}
        />
      </label>

      {allPlugins.map((p) => {
        const installed = pluginHost.isInstalled(p.id);
        return (
          <div key={p.id} className={styles.row}>
            <div className={styles.icon}><Icon name="plugin" size={16} /></div>
            <div className={styles.body}>
              <span className={styles.name}>{p.name}</span>
              <span className={styles.desc}>{p.description}</span>
            </div>
            <button
              type="button"
              className={cn(styles.action, installed && styles.actionInstalled)}
              onClick={() => (installed ? pluginHost.uninstall(p.id) : pluginHost.install(p))}
            >
              {installed ? 'Uninstall' : 'Install'}
            </button>
          </div>
        );
      })}
      <p className={styles.note}>
        Installed plugins add searchable commands to the Command Palette (⌘⇧P).
      </p>
    </div>
  );
}

export function openPluginsModal(): void {
  openModal({ id: 'plugins-modal', title: 'Plugins', size: 'md', render: () => <PluginsList /> });
}
