/**
 * The dashboard's Plugins page (`?tab=plugins`).
 *
 * What changed in 0.9, what still works, what is installed, and how to install
 * more — by hand, because there is no registry or installer in 0.9: copy the
 * plugin into the plugins folder and restart.
 */

import { useEffect, useState } from 'react';
import { nativePluginFolderPath } from '@core/nativePlugins/nativePlugins';
import { NativePluginsList, OpenPluginsFolderButton } from './NativePluginsList';
import styles from './NativePlugins.module.css';

export function NativePluginsPage(): JSX.Element {
  const [folder, setFolder] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void nativePluginFolderPath().then((p) => { if (alive) setFolder(p); });
    return () => { alive = false; };
  }, []);

  return (
    <div className={styles.page}>
      <section className={styles.card} aria-labelledby="plugins-about">
        <h3 id="plugins-about" className={styles.cardTitle}>Plugins in Premation 0.9</h3>
        <p className={styles.text}>
          Plugins from the plugin registry aren&apos;t supported in Premation 0.9 yet. Native plugins still
          work: they run inside the engine, and you install them by copying them into your plugins folder.
          Premation loads everything in that folder when it starts.
        </p>
        {folder ? (
          <p className={styles.text}>
            Your plugins folder: <span className={styles.path}>{folder}</span>
          </p>
        ) : null}
        <div className={styles.toolbar}>
          <OpenPluginsFolderButton size="md" />
        </div>
      </section>

      <NativePluginsList />

      <section className={styles.card} aria-labelledby="plugins-install">
        <h3 id="plugins-install" className={styles.cardTitle}>Install a native plugin</h3>
        <ol className={styles.steps}>
          <li>
            <strong>Open the plugins folder</strong> with the button above.
          </li>
          <li>
            <strong>Copy the plugin</strong> (its whole folder or bundle, as its author ships it) into that folder.
          </li>
          <li>
            <strong>Restart Premation.</strong> The plugin appears in the list above. If it failed to load,
            the reason is shown next to it.
          </li>
        </ol>
      </section>
    </div>
  );
}
