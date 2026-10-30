/**
 * Settings ▸ Models — every ML model the engine runs (electron/models.json),
 * in one list: what is built in, what is installed, what a tool would fetch
 * on first use, each with its size and licence, and Install / Remove.
 *
 * The list is main's (`models:list`): the page holds no manifest of its own.
 * A download started here runs through the same main-process installer the
 * tools use (electron/modelInstaller.ts: https only, no credentials,
 * checksum-verified when pinned) and outlives this pane — the status bar's
 * job chip follows it. A model the person supplies a URL for (face
 * landmarks) is installed from its own row elsewhere; here it only shows.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ModelListing } from '@app-types/motionEditor';
import { Badge } from '@components/Badge';
import { Button } from '@components/Button';
import { useUIStore } from '@stores/uiStore';
import { t } from '@core/i18n';
import styles from './CustomizeDialog.module.css';

const MB = 1024 * 1024;

const bridge = (): NonNullable<Window['motionEditor']>['models'] | undefined =>
  typeof window !== 'undefined' ? window.motionEditor?.models : undefined;

/** Bytes as "7.6 MB" / "99 MB". */
function megabytes(bytes: number): string {
  const mb = bytes / MB;
  return t('settings.models.mb', '{size} MB', { size: mb < 10 ? mb.toFixed(1) : mb.toFixed(0) });
}

type Download = { requestId: string; received: number; total: number | null };

export function ModelsSettingsSection(): JSX.Element {
  const [models, setModels] = useState<ModelListing[] | null>(null);
  const [downloads, setDownloads] = useState<Record<string, Download>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  const refresh = useCallback(async (): Promise<void> => {
    const b = bridge();
    if (!b) {
      setModels([]);
      return;
    }
    try {
      setModels(await b.list());
    } catch {
      setModels([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const b = bridge();
    if (!b) return undefined;
    return b.onDownloadProgress((e) => {
      const p = e as { id?: unknown; requestId?: unknown; receivedBytes?: unknown; totalBytes?: unknown };
      if (typeof p.id !== 'string' || typeof p.requestId !== 'string' || typeof p.receivedBytes !== 'number') return;
      const id = p.id;
      const received = p.receivedBytes;
      const total = typeof p.totalBytes === 'number' ? p.totalBytes : null;
      setDownloads((d) => (d[id]?.requestId === p.requestId ? { ...d, [id]: { requestId: p.requestId as string, received, total } } : d));
    });
  }, [refresh]);

  const install = async (m: ModelListing): Promise<void> => {
    const b = bridge();
    if (!b) return;
    const requestId = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
    setErrors((e) => ({ ...e, [m.id]: '' }));
    setDownloads((d) => ({ ...d, [m.id]: { requestId, received: 0, total: m.bytes } }));
    const jobId = `model-${m.id}`;
    const ui = useUIStore.getState();
    ui.startJob({
      id: jobId,
      kind: 'download',
      label: t('settings.models.jobDownloading', 'Downloading {name}…', { name: m.name }),
      progress: 'indeterminate',
      cancel: () => { void b.cancelDownload(requestId); },
    });
    const off = b.onDownloadProgress((e) => {
      const p = e as { requestId?: unknown; receivedBytes?: unknown; totalBytes?: unknown };
      if (p.requestId !== requestId || typeof p.receivedBytes !== 'number') return;
      const total = typeof p.totalBytes === 'number' && p.totalBytes > 0 ? p.totalBytes : null;
      useUIStore.getState().updateJob(jobId, { progress: total ? Math.min(1, p.receivedBytes / total) : 'indeterminate' });
    });
    try {
      const r = await b.install({ id: m.id, requestId });
      if (r.ok) {
        useUIStore.getState().finishJob(jobId, { status: 'done', message: t('settings.models.jobDone', '{name} installed ({size})', { name: m.name, size: megabytes(r.model.bytes) }) });
      } else if (/^Cancelled\.?$/i.test(r.message)) {
        useUIStore.getState().finishJob(jobId, { status: 'cancelled', message: t('settings.models.jobCancelled', 'Model download cancelled') });
      } else {
        useUIStore.getState().finishJob(jobId, { status: 'failed', message: t('settings.models.jobFailed', 'Model download failed: {message}', { message: r.message }) });
        setErrors((e) => ({ ...e, [m.id]: r.message }));
      }
    } finally {
      off();
      setDownloads((d) => {
        const next = { ...d };
        delete next[m.id];
        return next;
      });
      await refresh();
    }
  };

  const remove = async (m: ModelListing): Promise<void> => {
    const b = bridge();
    if (!b) return;
    await b.remove(m.id).catch(() => false);
    await refresh();
  };

  return (
    <div className={styles.section}>
      <div className={styles.sectionGroup}>
        <div className={styles.sectionHeading}>
          <span className={styles.sectionTitle}>{t('settings.models.title', 'Engine models')}</span>
          <span className={styles.hint}>
            {t('settings.models.hint', 'Neural models the engine runs on this computer. Missing ones download the first time a tool needs them.')}
          </span>
        </div>

        <div className={styles.settingCard}>
          {models === null ? (
            <div className={styles.settingRow}><span className={styles.settingDesc}>{t('settings.models.loading', 'Reading…')}</span></div>
          ) : models.length === 0 ? (
            <div className={styles.settingRow}>
              <span className={styles.settingDesc}>{t('settings.models.needsDesktop', 'Models are installed by the desktop app: the engine reads them from this computer.')}</span>
            </div>
          ) : models.map((m) => {
            const dl = downloads[m.id];
            const pct = dl && dl.total ? Math.min(100, Math.round((dl.received / dl.total) * 100)) : null;
            const size = m.state !== 'absent' ? megabytes(m.installedBytes) : m.bytes !== null ? megabytes(m.bytes) : null;
            const facts = [
              m.licence,
              size,
              m.source === 'pinned' ? t('settings.models.pinned', 'Pinned source, checksum verified') : null,
            ].filter((x): x is string => !!x).join(' · ');
            return (
              <div key={m.id} className={styles.settingRow}>
                <div className={styles.settingInfo}>
                  <span className={styles.settingTitle}>{m.name}</span>
                  <span className={styles.settingDesc}>{m.description}</span>
                  <span className={styles.settingDesc}>{facts}</span>
                  {errors[m.id] ? <span className={styles.settingDesc} role="alert">{errors[m.id]}</span> : null}
                </div>
                <div className={styles.settingRight}>
                  {dl ? (
                    <>
                      <Badge size="sm" variant="accent">
                        {pct === null
                          ? t('settings.models.downloadingMb', 'Downloading… {size}', { size: megabytes(dl.received) })
                          : t('settings.models.downloadingPct', 'Downloading… {pct}%', { pct })}
                      </Badge>
                      <Button variant="secondary" size="sm" onClick={() => { void bridge()?.cancelDownload(dl.requestId); }}>
                        {t('settings.models.cancel', 'Cancel')}
                      </Button>
                    </>
                  ) : m.state === 'bundled' ? (
                    <Badge size="sm" variant="success">{t('settings.models.builtIn', 'Built in')}</Badge>
                  ) : m.state === 'installed' ? (
                    <>
                      <Badge size="sm" variant="success">{t('settings.models.installed', 'Installed')}</Badge>
                      <Button variant="secondary" size="sm" onClick={() => { void remove(m); }}>{t('settings.models.remove', 'Remove')}</Button>
                    </>
                  ) : m.source === 'pinned' ? (
                    <>
                      <Badge size="sm" variant="neutral">{t('settings.models.onDemand', 'Downloaded on first use')}</Badge>
                      <Button variant="secondary" size="sm" onClick={() => { void install(m); }}>{t('settings.models.install', 'Install')}</Button>
                    </>
                  ) : (
                    <Badge size="sm" variant="neutral">{t('settings.models.needsUrl', 'Not installed · URL needed')}</Badge>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
