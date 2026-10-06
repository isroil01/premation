/**
 * The dashboard's Plugins page (`?tab=plugins`): the plugin store, what is
 * installed, and publishing.
 *
 * Plugins are native SDK plugins (docs/PLUGIN_SDK.md). They are free, run
 * locally inside the engine, and install from the store with no restart
 * (docs/PLUGIN_STORE.md). A plugin copied into the plugins folder by hand
 * still works: Rescan picks it up.
 */

import { useState } from 'react';
import { Button } from '@components/Button';
import { Icon } from '@components/Icon';
import { Segmented } from '@components/Segmented';
import { engine } from '@core/engine/engineInstance';
import { canInstallFromStore, rescanPlugins } from '@core/nativePlugins/pluginStore';
import { useNativePlugins } from '@hooks/useNativePlugins';
import { useInstalledPlugins } from '@hooks/usePluginStore';
import { NativePluginsList, OpenPluginsFolderButton } from './NativePluginsList';
import { PluginStoreBrowser } from './PluginStore';
import { PublishPlugins } from './PublishPlugins';
import styles from './NativePlugins.module.css';

type Section = 'store' | 'installed' | 'publish';

const SECTIONS = [
  { value: 'store' as const, label: 'Store' },
  { value: 'installed' as const, label: 'Installed' },
  { value: 'publish' as const, label: 'Publish' },
];

export function NativePluginsPage(): JSX.Element {
  const native = useNativePlugins();
  const store = useInstalledPlugins(native.refresh);
  const [section, setSection] = useState<Section>(canInstallFromStore() ? 'store' : 'installed');
  const [rescanNote, setRescanNote] = useState<string | null>(null);

  return (
    <div className={styles.page}>
      <div className={styles.toolbar}>
        <Segmented options={SECTIONS} value={section} onChange={setSection} aria-label="Plugins" />
      </div>
      {store.message ? (
        <span className={store.message.error ? styles.error : styles.message} role={store.message.error ? 'alert' : 'status'}>
          {store.message.text}
        </span>
      ) : null}

      {section === 'store' ? <PluginStoreBrowser store={store} /> : null}

      {section === 'installed' ? (
        <>
          <NativePluginsList store={store} native={native} />
          <section className={styles.card} aria-labelledby="plugins-folder">
            <h3 id="plugins-folder" className={styles.cardTitle}>Plugins folder</h3>
            <p className={styles.text}>
              Plugins from the store are installed here. A plugin you got elsewhere can be copied into this folder
              (its whole bundle folder); Rescan loads it without a restart.
            </p>
            <div className={styles.toolbar}>
              <OpenPluginsFolderButton size="md" />
              <Button
                variant="secondary"
                size="md"
                leftIcon={<Icon name="refresh" size="sm" />}
                onClick={() => {
                  setRescanNote(null);
                  void rescanPlugins(engine()).then((list) => {
                    setRescanNote(list ? `${list.length} plugin${list.length === 1 ? '' : 's'} found.` : 'The engine has no plugins folder.');
                    native.refresh();
                    store.refresh();
                  });
                }}
              >
                Rescan
              </Button>
              {rescanNote ? <span className={styles.message} role="status">{rescanNote}</span> : null}
            </div>
          </section>
        </>
      ) : null}

      {section === 'publish' ? <PublishPlugins store={store} /> : null}
    </div>
  );
}
