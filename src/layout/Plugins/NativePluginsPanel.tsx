/**
 * The editor's Plugins panel: what is installed, enable / disable / update /
 * uninstall in place. Browsing the store and publishing live on the
 * dashboard's Plugins page (more room); a plugin installed there is usable
 * here at once (the engine rescans).
 */

import { useNativePlugins } from '@hooks/useNativePlugins';
import { useInstalledPlugins } from '@hooks/usePluginStore';
import { NativePluginsList, OpenPluginsFolderButton } from './NativePluginsList';
import styles from './NativePlugins.module.css';

export function NativePluginsPanel(): JSX.Element {
  const native = useNativePlugins();
  const store = useInstalledPlugins(native.refresh);
  return (
    <div className={styles.panel}>
      <p className={styles.text}>
        Plugins run inside the engine on this computer. Find more in the plugin store on the dashboard&apos;s
        Plugins page.
      </p>
      {store.message ? (
        <span className={store.message.error ? styles.error : styles.message} role={store.message.error ? 'alert' : 'status'}>
          {store.message.text}
        </span>
      ) : null}
      <div className={styles.toolbar}>
        <OpenPluginsFolderButton />
      </div>
      <NativePluginsList compact store={store} native={native} />
    </div>
  );
}
