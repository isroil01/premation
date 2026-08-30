/**
 * Object Matte — install the neural segmentation model, or don't.
 *
 * The Roto tool works without it: clicks fall back to GrabCut, which produces a
 * real matte. What a model adds is the one-click subject selection Roto Brush 3
 * and SAM are known for. So this control's job is to make that upgrade
 * available and completely optional, and to be honest about what pressing the
 * button does.
 *
 * ── Why the URL is shown, and editable ─────────────────────────────────
 * Pressing Install makes an HTTPS request to a third-party host from an
 * application whose entire pitch is that it does not do that unless asked. The
 * host is therefore on screen before the request, not buried in a release note.
 * It is editable because the best available model is a moving target and nobody
 * should wait for a release to try a better one.
 *
 * After one install the model is cached locally and loaded at boot with no
 * network at all.
 */

import { useEffect, useState } from 'react';
import { Button } from '@components/Button';
import { Input } from '@components/Input';
import { SUGGESTED_MODEL, useSamModelStore } from '@core/tracking/samModelInstall';
import styles from './ObjectMatteControl.module.css';

const MB = 1024 * 1024;

/** Bytes as a short human string — "42 MB", "0.4 MB". */
function megabytes(bytes: number): string {
  return `${(bytes / MB).toFixed(bytes < MB ? 1 : 0)} MB`;
}

export function ObjectMatteControl(): JSX.Element {
  const status = useSamModelStore((s) => s.status);
  const install = useSamModelStore((s) => s.install);
  const remove = useSamModelStore((s) => s.remove);
  const cancel = useSamModelStore((s) => s.cancel);
  const restore = useSamModelStore((s) => s.restore);
  const [url, setUrl] = useState<string>(SUGGESTED_MODEL.url);

  // The store is process-wide and boot already restores a cached model, but the
  // dialog can be the first thing to open in a session that skipped boot
  // restore (a pop-out window, a hot reload). Idempotent and silent.
  useEffect(() => {
    if (status.kind === 'absent') void restore();
    // Once, on mount: re-running on every status change would re-restore over a
    // download the user just started.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (status.kind === 'ready') {
    return (
      <div className={styles.root}>
        <div className={styles.readyRow}>
          <span className={styles.ready}>Installed · {megabytes(status.bytes)}</span>
          <Button variant="secondary" size="sm" onClick={() => { void remove(); }}>
            Remove
          </Button>
        </div>
        {/* The source, kept and shown: "which model is running on my footage,
            and where did it come from" is a fair question to be able to answer. */}
        <div className={styles.source} title={status.sourceUrl}>{status.sourceUrl}</div>
      </div>
    );
  }

  if (status.kind === 'downloading') {
    const { receivedBytes, totalBytes } = status;
    const pct = totalBytes ? Math.min(100, Math.round((receivedBytes / totalBytes) * 100)) : null;
    return (
      <div className={styles.root}>
        <div className={styles.readyRow}>
          <span className={styles.progressText}>
            {/* No percentage without a Content-Length — model hosts often send
                chunked responses, and inventing a denominator would be a lie. */}
            {pct === null ? `Downloading… ${megabytes(receivedBytes)}` : `Downloading… ${pct}%`}
          </span>
          <Button variant="secondary" size="sm" onClick={cancel}>Cancel</Button>
        </div>
        <div className={styles.progressTrack}>
          <div
            className={pct === null ? styles.progressIndeterminate : styles.progressFill}
            style={pct === null ? undefined : { width: `${pct}%` }}
          />
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
          onChange={(e) => setUrl(e.target.value)}
          aria-label="Object Matte model URL"
          spellCheck={false}
        />
        <Button variant="secondary" size="sm" onClick={() => { void install(url); }}>
          Install
        </Button>
      </div>
      {status.kind === 'failed' ? <div className={styles.error}>{status.message}</div> : null}
      <div className={styles.hint}>
        Optional. Downloads about {megabytes(SUGGESTED_MODEL.approxBytes)} from the host above, once,
        and keeps it on this device. Without it the Roto tool still works — clicks
        use the classical matte.
      </div>
    </div>
  );
}

export default ObjectMatteControl;
