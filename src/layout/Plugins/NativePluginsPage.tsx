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
import { pluginEngine } from '@core/engine/engineInstance';
import { canInstallFromFile } from '@core/nativePlugins/pluginFiles';
import { canInstallFromStore, rescanPlugins } from '@core/nativePlugins/pluginStore';
import { useNativePlugins } from '@hooks/useNativePlugins';
import { useInstalledPlugins } from '@hooks/usePluginStore';
import { installFromFilePicker } from './InstallPackageDialog';
import { NativePluginsList, OpenPluginsFolderButton } from './NativePluginsList';
import { PluginDevModeCard } from './PluginDevMode';
import { PluginStoreBrowser } from './PluginStore';
import { PublishPlugins } from './PublishPlugins';
import { StoreMessageLine } from './StoreMessageLine';
import styles from './NativePlugins.module.css';
import { t } from '@core/i18n';

type Section = 'store' | 'installed' | 'publish';

function sections(): { value: Section; label: string }[] {
  return [
    { value: 'store', label: t('plugins.page.store', 'Store') },
    { value: 'installed', label: t('plugins.page.installed', 'Installed') },
    { value: 'publish', label: t('plugins.page.publish', 'Publish') },
  ];
}

export function NativePluginsPage(): JSX.Element {
  const native = useNativePlugins();
  const store = useInstalledPlugins(native.refresh);
  const [section, setSection] = useState<Section>(canInstallFromStore() ? 'store' : 'installed');
  const [rescanNote, setRescanNote] = useState<string | null>(null);

  return (
    <div className={styles.page}>
      <div className={styles.toolbar}>
        <Segmented options={sections()} value={section} onChange={setSection} aria-label={t('plugins.page.aria', 'Plugins')} />
      </div>
      <StoreMessageLine message={store.message} />

      {section === 'store' ? <PluginStoreBrowser store={store} /> : null}

      {section === 'installed' ? (
        <>
          <NativePluginsList store={store} native={native} />
          <section className={styles.card} aria-labelledby="plugins-folder">
            <h3 id="plugins-folder" className={styles.cardTitle}>{t('plugins.page.folderTitle', 'Plugins folder')}</h3>
            <p className={styles.text}>
              {t(
                'plugins.page.folderText',
                'Plugins from the store are installed here. A plugin you got as a .pplugin file installs with Install from file (or a double-click on the file). A bundle folder copied into this folder, or into the machine-wide plug-ins folder a vendor\'s installer uses, loads on Rescan without a restart.',
              )}
            </p>
            <div className={styles.toolbar}>
              {canInstallFromFile() ? (
                <Button
                  variant="primary"
                  size="md"
                  leftIcon={<Icon name="upload" size="sm" />}
                  onClick={() => {
                    void installFromFilePicker().then((out) => {
                      if (out) setRescanNote(out.message);
                      native.refresh();
                      store.refresh();
                    });
                  }}
                >
                  {t('plugins.page.installFromFile', 'Install from file…')}
                </Button>
              ) : null}
              <OpenPluginsFolderButton size="md" />
              <Button
                variant="secondary"
                size="md"
                leftIcon={<Icon name="refresh" size="sm" />}
                onClick={() => {
                  setRescanNote(null);
                  void rescanPlugins(pluginEngine()).then((list) => {
                    setRescanNote(
                      list
                        ? list.length === 1
                          ? t('plugins.page.foundOne', '{n} plugin found.', { n: list.length })
                          : t('plugins.page.foundOther', '{n} plugins found.', { n: list.length })
                        : t('plugins.page.noFolder', 'The engine has no plugins folder.'),
                    );
                    native.refresh();
                    store.refresh();
                  });
                }}
              >
                {t('plugins.page.rescan', 'Rescan')}
              </Button>
              {rescanNote ? <span className={styles.message} role="status">{rescanNote}</span> : null}
            </div>
          </section>
          <PluginDevModeCard />
        </>
      ) : null}

      {section === 'publish' ? <PublishPlugins store={store} /> : null}
    </div>
  );
}
