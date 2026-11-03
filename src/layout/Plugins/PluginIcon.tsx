/**
 * A plugin's icon: its own (`src`, the bundle's manifest icon as
 * `plugin-ui://…`), else the store listing's, else its initial — each tried
 * in turn when the one before is missing or fails to load.
 */

import { useState } from 'react';
import { storeMediaUrl, type StorePluginSummary } from '@core/api/client';
import styles from './NativePlugins.module.css';

export function PluginIcon({
  plugin,
  size = 40,
  src,
}: {
  plugin: Pick<StorePluginSummary, 'name' | 'iconUrl'>;
  size?: number;
  /** A picture to try before the store's (the installed bundle's own icon). */
  src?: string | null;
}): JSX.Element {
  const candidates = [src ?? null, storeMediaUrl(plugin.iconUrl)].filter((s): s is string => !!s);
  const [broken, setBroken] = useState<ReadonlySet<string>>(() => new Set());
  const current = candidates.find((c) => !broken.has(c)) ?? null;
  return (
    <span className={styles.pluginIcon} style={{ width: size, height: size }} aria-hidden="true">
      {current ? (
        <img
          key={current}
          src={current}
          alt=""
          width={size}
          height={size}
          onError={() => setBroken((prev) => new Set(prev).add(current))}
        />
      ) : (
        <span className={styles.pluginIconInitial} style={{ fontSize: Math.round(size * 0.42) }}>
          {(plugin.name.trim()[0] ?? '?').toUpperCase()}
        </span>
      )}
    </span>
  );
}
