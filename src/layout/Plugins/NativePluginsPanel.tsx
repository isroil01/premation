/**
 * The editor's Plugins panel — where the old Plugins (marketplace) tab lived,
 * but for the plugins 0.9 actually runs: native SDK plugins in the engine.
 * The same list as the dashboard's Plugins page, compact, with the folder
 * button; the full explanation and install steps are on that page.
 */

import { NativePluginsList, OpenPluginsFolderButton } from './NativePluginsList';
import styles from './NativePlugins.module.css';

export function NativePluginsPanel(): JSX.Element {
  return (
    <div className={styles.panel}>
      <p className={styles.text}>
        Native plugins run inside the engine. Install one by copying it into the plugins folder, then
        restart Premation. Registry plugins aren&apos;t supported in 0.9 yet.
      </p>
      <div className={styles.toolbar}>
        <OpenPluginsFolderButton />
      </div>
      <NativePluginsList compact />
    </div>
  );
}
