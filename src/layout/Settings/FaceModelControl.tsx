/**
 * Face Tracking's landmark model (AE parity 3.3): MediaPipe Face Mesh V2 as
 * ONNX, bundled with the app and pinned to one revision and checksum
 * (electron/models.json `face-landmarks`). Install re-fetches that pinned
 * file into this computer's app data (a copy that survives a damaged
 * install); there is no URL to type.
 */

import { useEffect, useState } from 'react';
import { Button } from '@components/Button';
import { t } from '@core/i18n';
import styles from './ObjectMatteControl.module.css';

const MB = 1024 * 1024;

type Status =
  | { kind: 'absent' }
  | { kind: 'downloading'; received: number; total: number | null }
  | { kind: 'ready'; url: string; bytes: number }
  | { kind: 'failed'; message: string };

const bridge = (): NonNullable<Window['motionEditor']>['faceModel'] | undefined =>
  typeof window !== 'undefined' ? window.motionEditor?.faceModel : undefined;

export function FaceModelControl(): JSX.Element {
  const [status, setStatus] = useState<Status>({ kind: 'absent' });
  const [bundled, setBundled] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);

  useEffect(() => {
    void bridge()?.status().then((m) => {
      if (!m) return;
      setBundled(m.bundled === true);
      setStatus({ kind: 'ready', url: m.url, bytes: m.bytes });
    }).catch(() => undefined);
  }, []);

  const install = async (): Promise<void> => {
    const b = bridge();
    if (!b) {
      setStatus({ kind: 'failed', message: t('settings.faceModel.needsDesktop', 'Installing a model needs the desktop app: the engine reads it from this computer.') });
      return;
    }
    const id = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
    setRequestId(id);
    setStatus({ kind: 'downloading', received: 0, total: null });
    const off = b.onDownloadProgress((e) => {
      const p = e as { requestId?: unknown; receivedBytes?: unknown; totalBytes?: unknown };
      if (p.requestId === id && typeof p.receivedBytes === 'number') {
        setStatus({ kind: 'downloading', received: p.receivedBytes, total: typeof p.totalBytes === 'number' ? p.totalBytes : null });
      }
    });
    try {
      const r = await b.install({ requestId: id });
      if (r.ok) setBundled(false);
      setStatus(r.ok ? { kind: 'ready', url: r.model.url, bytes: r.model.bytes } : { kind: 'failed', message: r.message });
    } finally {
      off();
      setRequestId(null);
    }
  };

  if (status.kind === 'ready') {
    return (
      <div className={styles.root}>
        <div className={styles.readyRow}>
          <span className={styles.ready}>{bundled
            ? t('settings.faceModel.bundled', 'Bundled with the app · {size} MB', { size: (status.bytes / MB).toFixed(1) })
            : t('settings.faceModel.installed', 'Installed · {size} MB', { size: (status.bytes / MB).toFixed(1) })}</span>
          {!bundled && (
            <Button variant="secondary" size="sm" onClick={() => { void bridge()?.remove().then(() => bridge()?.status()).then((m) => {
              setBundled(m?.bundled === true);
              setStatus(m ? { kind: 'ready', url: m.url, bytes: m.bytes } : { kind: 'absent' });
            }); }}>
              {t('settings.faceModel.remove', 'Remove')}
            </Button>
          )}
        </div>
        <div className={styles.source} title={status.url}>{status.url}</div>
      </div>
    );
  }
  if (status.kind === 'downloading') {
    const pct = status.total ? Math.min(100, Math.round((status.received / status.total) * 100)) : null;
    return (
      <div className={styles.root}>
        <div className={styles.readyRow}>
          <span className={styles.progressText}>{pct === null
            ? t('settings.faceModel.downloadingMb', 'Downloading… {size} MB', { size: (status.received / MB).toFixed(1) })
            : t('settings.faceModel.downloadingPct', 'Downloading… {pct}%', { pct })}</span>
          <Button variant="secondary" size="sm" onClick={() => { if (requestId) void bridge()?.cancelDownload(requestId); }}>{t('settings.faceModel.cancel', 'Cancel')}</Button>
        </div>
        <div className={styles.progressTrack}>
          <div className={pct === null ? styles.progressIndeterminate : styles.progressFill} style={pct === null ? undefined : { transform: `scaleX(${pct / 100})` }} />
        </div>
      </div>
    );
  }
  return (
    <div className={styles.root}>
      <div className={styles.installRow}>
        <Button variant="secondary" size="sm" onClick={() => { void install(); }}>{t('settings.faceModel.install', 'Install')}</Button>
      </div>
      {status.kind === 'failed' ? <div className={styles.error}>{status.message}</div> : null}
      <div className={styles.hint}>
        {t('settings.faceModel.hintPinned', 'MediaPipe Face Mesh V2, 4.9 MB. Usually built in.')}
      </div>
    </div>
  );
}

export default FaceModelControl;
