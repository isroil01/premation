/**
 * Face Tracking's landmark model (AE parity 3.3) — downloaded on first use
 * into this computer's app data, where the engine's faceTrack job reads it
 * (electron/faceModel.ts). Nothing is bundled and nothing is fetched until
 * Install is pressed; the URL is on screen, and editable, before the request.
 *
 * The model is a MediaPipe Face Mesh class export (468 or 478 landmarks, a
 * 192×192 RGB input): `face_landmark.onnx`.
 */

import { useEffect, useState } from 'react';
import { Button } from '@components/Button';
import { Input } from '@components/Input';
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
  const [url, setUrl] = useState('');
  const [requestId, setRequestId] = useState<string | null>(null);

  useEffect(() => {
    void bridge()?.status().then((m) => { if (m) setStatus({ kind: 'ready', url: m.url, bytes: m.bytes }); }).catch(() => undefined);
  }, []);

  const install = async (): Promise<void> => {
    const b = bridge();
    if (!b) {
      setStatus({ kind: 'failed', message: 'Installing a model needs the desktop app: the engine reads it from this computer.' });
      return;
    }
    if (!/^https:\/\//i.test(url.trim())) {
      setStatus({ kind: 'failed', message: 'Only https:// model URLs are accepted.' });
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
      const r = await b.install({ url: url.trim(), requestId: id });
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
          <span className={styles.ready}>Installed · {(status.bytes / MB).toFixed(1)} MB</span>
          <Button variant="secondary" size="sm" onClick={() => { void bridge()?.remove().then(() => setStatus({ kind: 'absent' })); }}>
            Remove
          </Button>
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
          <span className={styles.progressText}>{pct === null ? `Downloading… ${(status.received / MB).toFixed(1)} MB` : `Downloading… ${pct}%`}</span>
          <Button variant="secondary" size="sm" onClick={() => { if (requestId) void bridge()?.cancelDownload(requestId); }}>Cancel</Button>
        </div>
        <div className={styles.progressTrack}>
          <div className={pct === null ? styles.progressIndeterminate : styles.progressFill} style={pct === null ? undefined : { width: `${pct}%` }} />
        </div>
      </div>
    );
  }
  return (
    <div className={styles.root}>
      <div className={styles.installRow}>
        <Input
          size="sm"
          fullWidth
          value={url}
          placeholder="https://…/face_landmark.onnx"
          onChange={(e) => setUrl(e.target.value)}
          aria-label="Face landmark model URL"
          spellCheck={false}
        />
        <Button variant="secondary" size="sm" disabled={!url.trim()} onClick={() => { void install(); }}>Install</Button>
      </div>
      {status.kind === 'failed' ? <div className={styles.error}>{status.message}</div> : null}
      <div className={styles.hint}>
        Face Tracking needs a face landmark model (a MediaPipe Face Mesh ONNX export, face_landmark.onnx). It is downloaded once,
        from the URL above, and kept on this computer.
      </div>
    </div>
  );
}

export default FaceModelControl;
