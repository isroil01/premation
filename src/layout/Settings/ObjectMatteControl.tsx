/**
 * Object Matte — install the neural segmentation model, or don't.
 *
 * The Roto tool works without it: clicks fall back to GrabCut, which produces a
 * real matte. What a model adds is the one-click subject selection Roto Brush 3
 * and SAM are known for. So this control's job is to make that upgrade
 * available and completely optional, and to be honest about what pressing the
 * button does.
 *
 * ── Why the URLs are shown, and editable ───────────────────────────────
 * Pressing Install makes an HTTPS request to a third-party host from an
 * application whose entire pitch is that it does not do that unless asked. The
 * hosts are therefore on screen before the request, not buried in a release
 * note. They are editable because the best available model is a moving target
 * and nobody should wait for a release to try a better one. TWO fields, not
 * one: SAM-class checkpoints ship as an encoder/decoder pair (samPipeline.ts),
 * and a single-file URL cannot produce a working segmenter.
 *
 * After one install the model is cached locally and loaded at boot with no
 * network at all.
 */

import { useEffect, useState } from 'react';
import { Button } from '@components/Button';
import { Input } from '@components/Input';
import { SUGGESTED_MODEL } from '@core/tracking/samModelInstall';
import { useSamModelStore } from '@stores/samModelStore';
import { registerBundledSamAtBoot } from '@core/tracking/samBundled';
import { installObjectMatteJob } from './objectMatteJob';
import styles from './ObjectMatteControl.module.css';

// The download outlives this control; the job tray and toast follow it.
installObjectMatteJob();

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
  const [encoderUrl, setEncoderUrl] = useState<string>(SUGGESTED_MODEL.encoderUrl);
  const [decoderUrl, setDecoderUrl] = useState<string>(SUGGESTED_MODEL.decoderUrl);

  // The store is process-wide and boot already restores a cached model, but the
  // dialog can be the first thing to open in a session that skipped boot
  // restore (a pop-out window, a hot reload). Idempotent and silent.
  useEffect(() => {
    if (status.kind === 'absent') void restore();
    // Once, on mount: re-running on every status change would re-restore over a
    // download the user just started.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (status.kind === 'bundled') {
    return (
      <div className={styles.root}>
        <div className={styles.readyRow}>
          <span className={styles.ready}>Bundled with the app · {megabytes(status.bytes)}</span>
        </div>
        {/* No Remove button: there is nothing on this device to reclaim — the
            model ships inside the app. Installing a custom model below still
            overrides it (samModelInstall.ts). */}
        <div className={styles.hint}>
          Neural one-click selection is ready — nothing to download. Clicks in the
          Roto tool use it automatically, with the classical matte as fallback.
        </div>
      </div>
    );
  }

  if (status.kind === 'ready') {
    return (
      <div className={styles.root}>
        <div className={styles.readyRow}>
          <span className={styles.ready}>Installed · {megabytes(status.bytes)}</span>
          {/* Removing the custom model falls back to the bundled one, not to
              nothing — re-registered immediately so the very next Roto click
              behaves the way the panel now says it will. */}
          <Button variant="secondary" size="sm" onClick={() => { void remove().then(() => registerBundledSamAtBoot()); }}>
            Remove
          </Button>
        </div>
        {/* The sources, kept and shown: "which model is running on my footage,
            and where did it come from" is a fair question to be able to answer. */}
        <div className={styles.source} title={status.sourceUrl}>{status.sourceUrl}</div>
        {status.decoderUrl ? (
          <div className={styles.source} title={status.decoderUrl}>{status.decoderUrl}</div>
        ) : null}
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
      <Input
        size="sm"
        fullWidth
        value={encoderUrl}
        onChange={(e) => setEncoderUrl(e.target.value)}
        aria-label="Object Matte encoder model URL"
        spellCheck={false}
      />
      <div className={styles.installRow}>
        <Input
          size="sm"
          fullWidth
          value={decoderUrl}
          onChange={(e) => setDecoderUrl(e.target.value)}
          aria-label="Object Matte decoder model URL"
          spellCheck={false}
        />
        <Button variant="secondary" size="sm" onClick={() => { void install(encoderUrl, decoderUrl); }}>
          Install
        </Button>
      </div>
      {status.kind === 'failed' ? <div className={styles.error}>{status.message}</div> : null}
      <div className={styles.hint}>
        Optional. Downloads an encoder/decoder pair — about {megabytes(SUGGESTED_MODEL.approxBytes)} from
        the hosts above, once — and keeps it on this device. Without it the Roto
        tool still works — this build bundles a neural model, and clicks fall
        back to the classical matte only when neither is available.
      </div>
    </div>
  );
}

export default ObjectMatteControl;
