/**
 * PluginsModal — the plugin manager (spec §Extensibility). Lists available
 * plugins with a runtime Install / Uninstall toggle. Installing registers the
 * plugin's commands immediately (no restart) — they appear in the Command
 * Palette right away.
 */

import { useSyncExternalStore } from 'react';
import { Icon } from '@components/Icon';
import { cn } from '@utils/cn';
import { openModal } from '@stores/modalStore';
import pluginHost from '@core/plugins/PluginHost';
import { SAMPLE_PLUGINS } from '../../plugins/samplePlugins';
import styles from './PluginsModal.module.css';

function PluginsList(): JSX.Element {
  // Re-render whenever install state changes.
  useSyncExternalStore(
    (cb) => pluginHost.subscribe(cb),
    () => SAMPLE_PLUGINS.filter((p) => pluginHost.isInstalled(p.id)).length,
  );

  return (
    <div className={styles.list}>
      {SAMPLE_PLUGINS.map((p) => {
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
        Installed plugins add commands you can run from the Command Palette (⌘⇧P).
      </p>
    </div>
  );
}

export function openPluginsModal(): void {
  openModal({ id: 'plugins-modal', title: 'Plugins', size: 'md', render: () => <PluginsList /> });
}
