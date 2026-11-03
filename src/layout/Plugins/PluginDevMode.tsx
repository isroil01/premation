/**
 * Plugin Developer Mode (W2, docs/PLUGIN_SDK.md "Hot reload").
 *
 *  - `PluginDevModeCard` (Plugins ▸ Installed): the switch and the dev folders — a plugin's build
 *    output, e.g. `<plugin>/build/plugins`. Changing them restarts the engine (its launch arguments
 *    change); the open project is replayed.
 *  - `PluginDevReloader` (mounted once in AppRouter): each rebuild main reports is reloaded in the
 *    engine, with a toast saying how it went.
 */

import { useEffect, useState } from 'react';
import { Button } from '@components/Button';
import { Icon } from '@components/Icon';
import { Switch } from '@components/Switch';
import { pluginEngine } from '@core/engine/engineInstance';
import { t } from '@core/i18n';
import { devSettings, followDevRebuilds, hasPluginDevMode, pickDevFolder, saveDevSettings, type PluginDevSettings } from '@core/nativePlugins/pluginDev';
import { useUIStore } from '@stores/uiStore';
import styles from './NativePlugins.module.css';

export function PluginDevModeCard(): JSX.Element | null {
  const [settings, setSettings] = useState<PluginDevSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!hasPluginDevMode()) return;
    let live = true;
    void devSettings().then((s) => live && setSettings(s));
    return () => {
      live = false;
    };
  }, []);

  if (!hasPluginDevMode() || settings === null) return null;

  const save = (next: PluginDevSettings): void => {
    setBusy(true);
    setNote(null);
    void saveDevSettings(next).then((saved) => {
      setBusy(false);
      if (saved) {
        setSettings(saved);
        if (saved.enabled !== settings.enabled || (saved.enabled && saved.folders.join('\n') !== settings.folders.join('\n'))) {
          setNote(t('plugins.dev.restarting', 'The engine is restarting with the new plugin folders.'));
        }
      } else {
        setNote(t('plugins.dev.refused', 'Those settings were not saved (at most 16 folders, each a full path).'));
      }
    });
  };

  return (
    <section className={styles.card} aria-labelledby="plugins-dev">
      <h3 id="plugins-dev" className={styles.cardTitle}>{t('plugins.dev.title', 'Developer Mode')}</h3>
      <p className={styles.text}>
        {t(
          'plugins.dev.text',
          'For plugin authors. The plugins in these folders load from copies, so your build can replace them while Premation runs, and each rebuild is reloaded on its own. Point a folder at your build output, such as build/plugins.',
        )}
      </p>
      <Switch
        label={t('plugins.dev.switch', 'Reload plugins when they are rebuilt')}
        checked={settings.enabled}
        disabled={busy}
        onChange={(e) => save({ ...settings, enabled: e.currentTarget.checked })}
      />
      {settings.folders.length > 0 ? (
        <ul className={styles.list} aria-label={t('plugins.dev.folders', 'Developer folders')}>
          {settings.folders.map((f) => (
            <li key={f} className={styles.row}>
              <Icon name="folder-open" size="sm" className={styles.rowIcon} />
              <div className={styles.rowBody}>
                <span className={styles.rowMeta} title={f}>{f}</span>
              </div>
              <div className={styles.rowActions}>
                <Button
                  size="sm"
                  variant="ghost"
                  iconOnly
                  icon={<Icon name="trash" size="sm" />}
                  aria-label={t('plugins.dev.removeFolder', 'Remove folder')}
                  disabled={busy}
                  onClick={() => save({ ...settings, folders: settings.folders.filter((x) => x !== f) })}
                />
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      <div className={styles.toolbar}>
        <Button
          variant="secondary"
          size="md"
          leftIcon={<Icon name="folder-open" size="sm" />}
          disabled={busy}
          onClick={() => {
            void pickDevFolder().then((folder) => {
              if (folder && !settings.folders.includes(folder)) save({ ...settings, folders: [...settings.folders, folder] });
            });
          }}
        >
          {t('plugins.dev.addFolder', 'Add folder…')}
        </Button>
        {note ? <span className={styles.message} role="status">{note}</span> : null}
      </div>
    </section>
  );
}

/** Reloads each rebuilt dev plugin in the engine. Renders nothing. */
export function PluginDevReloader(): null {
  useEffect(
    () =>
      followDevRebuilds(pluginEngine, (n) => {
        useUIStore.getState().notify({
          level: n.level,
          message: n.message,
          ...(n.detail ? { detail: n.detail } : {}),
          durationMs: n.level === 'error' ? 0 : 2500,
          group: 'plugin-dev-reload',
        });
      }),
    [],
  );
  return null;
}
