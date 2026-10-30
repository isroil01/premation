/**
 * Preferences ▸ Media & Disk Cache, as After Effects lays it out: Enable Disk
 * Cache, its folder, its maximum size, and Empty Disk Cache.
 *
 * The cache is the engine's (native/engine/src/render/disk_cache.hpp): rendered
 * preview frames kept in a folder as well as in video memory, so a frame video
 * memory dropped — or one drawn in an earlier session — comes back as a file
 * read instead of a render (the blue lane under the timeline ruler). These rows
 * only edit the three preferences; diskCacheSync.ts sends them to the engine.
 * The readout is `getCacheCoverage` (polled only while the rows are mounted).
 */

import { useEffect, useState, useSyncExternalStore } from 'react';
import { Button } from '@components/Button';
import { Icon } from '@components/Icon';
import { Input } from '@components/Input';
import { Switch } from '@components/Switch';
import { usePreferenceStore } from '@stores/preferenceStore';
import { engineCacheSnapshot, subscribeEngineCache } from '@layout/Timeline/engineCacheCoverage';
import { DISK_CACHE_MAX_GB, DISK_CACHE_MIN_GB, defaultDiskCacheFolder } from '@layout/Timeline/diskCacheSync';
import { purgeDiskCache } from '@layout/Timeline/previewCacheCommands';
import { formatCacheMb } from '@layout/Timeline/previewCacheStats';
import { t } from '@core/i18n';
import styles from './CustomizeDialog.module.css';

const MB = 1024 * 1024;

function pickerAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.motionEditor?.shell?.pickFolder === 'function';
}

export function DiskCacheSettings(): JSX.Element {
  const enabled = usePreferenceStore((s) => s.diskCacheEnabled);
  const folder = usePreferenceStore((s) => s.diskCacheFolder);
  const maxGb = usePreferenceStore((s) => s.diskCacheMaxGb);
  const setPref = usePreferenceStore((s) => s.set);
  const cache = useSyncExternalStore(subscribeEngineCache, engineCacheSnapshot);

  const [fallback, setFallback] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void defaultDiskCacheFolder().then((f) => { if (alive) setFallback(f); });
    return () => { alive = false; };
  }, []);
  const shownFolder = folder ?? fallback;

  const [sizeDraft, setSizeDraft] = useState(String(maxGb));
  useEffect(() => setSizeDraft(String(maxGb)), [maxGb]);
  const commitSize = (raw: string): void => {
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n)) {
      setSizeDraft(String(maxGb));
      return;
    }
    setPref('diskCacheMaxGb', Math.min(DISK_CACHE_MAX_GB, Math.max(DISK_CACHE_MIN_GB, n)));
  };

  const chooseFolder = async (): Promise<void> => {
    const pick = window.motionEditor?.shell?.pickFolder;
    if (!pick) return;
    const dir = await pick().catch(() => null);
    if (dir) setPref('diskCacheFolder', dir);
  };

  return (
    <>
      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <span className={styles.settingTitle}>{t('settings.diskCache.title', 'Disk Cache')}</span>
          <span className={styles.settingDesc}>
            {t('settings.diskCache.desc', 'Keeps rendered frames on disk, across sessions.')}
          </span>
        </div>
        <div className={styles.settingRight}>
          <span className={styles.cacheSizeReadout} data-testid="disk-cache-readout">
            {enabled
              ? t('settings.diskCache.readout', '{used} of {max} GB', { used: formatCacheMb(cache.diskBytes / MB), max: maxGb })
              : t('settings.diskCache.off', 'Off')}
          </span>
          <Switch
            checked={enabled}
            onChange={(e) => setPref('diskCacheEnabled', e.currentTarget.checked)}
            aria-label={t('settings.diskCache.enableShort', 'Enable disk cache')}
          />
        </div>
      </div>

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <span className={styles.settingTitle}>{t('settings.diskCache.folder', 'Cache folder')}</span>
          <span className={styles.settingDesc}>
            {t('settings.diskCache.folderDesc', 'A fast local drive works best.')}
          </span>
          {shownFolder ? <code className={styles.kbd} title={shownFolder}>{shownFolder}</code> : null}
        </div>
        <div className={styles.settingRight}>
          {pickerAvailable() ? (
            <Button variant="secondary" size="sm" disabled={!enabled} onClick={() => void chooseFolder()}>
              <Icon name="folder-open" size="sm" />
              <span>{t('settings.diskCache.chooseShort', 'Choose…')}</span>
            </Button>
          ) : null}
          {folder ? (
            <Button variant="ghost" size="sm" disabled={!enabled} onClick={() => setPref('diskCacheFolder', null)}>
              {t('settings.diskCache.useDefaultShort', 'Default')}
            </Button>
          ) : null}
        </div>
      </div>

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <span className={styles.settingTitle}>{t('settings.diskCache.maxSizeShort', 'Maximum size')}</span>
          <span className={styles.settingDesc}>
            {t('settings.diskCache.maxSizeDesc', 'Oldest frames are removed first.')}
          </span>
        </div>
        <div className={styles.settingRight}>
          <Input
            size="sm"
            type="number"
            min={DISK_CACHE_MIN_GB}
            max={DISK_CACHE_MAX_GB}
            step={1}
            value={sizeDraft}
            disabled={!enabled}
            onChange={(e) => setSizeDraft(e.currentTarget.value)}
            onBlur={(e) => commitSize(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') commitSize(e.currentTarget.value); }}
            suffix="GB"
            aria-label={t('settings.diskCache.maxSizeAria', 'Maximum disk cache size in gigabytes')}
            data-enter-safe=""
          />
          <Button
            variant="ghost"
            size="sm"
            disabled={cache.diskBytes <= 0}
            onClick={() => purgeDiskCache()}
          >
            <Icon name="trash" size="sm" />
            <span>{t('settings.diskCache.empty', 'Empty')}</span>
          </Button>
        </div>
      </div>
    </>
  );
}
