/**
 * The one user-facing control over auto-update: whether the app may download in
 * the background.
 *
 * Not a preference in `preferenceStore` like everything else on this tab, and
 * deliberately so. The shell has to know the answer at launch — before any
 * renderer exists to read localStorage — so the setting lives in the main
 * process (`electron/updater.ts`) and this is a view onto it.
 *
 * Whether a DOWNLOADED update gets applied on quit is not offered as a choice.
 * At that point the bytes are already on disk and the user is closing the app
 * anyway; the only thing an "install on quit?" toggle can produce is someone
 * running a months-old build with the new one sitting in their cache.
 */

import { useEffect, useState } from 'react';
import { Button } from '@components/Button';
import type { UpdateStatus } from '@app-types/motionEditor';
// The dialog's own row styling — this renders INTO its rows, so it shares them
// rather than inventing a second look for the same list.
import styles from './CustomizeDialog.module.css';

function bridge(): NonNullable<Window['motionEditor']>['updates'] | null {
  return window.motionEditor?.updates ?? null;
}

/** One line of plain English for whatever the updater is doing. */
function describe(status: UpdateStatus | null, checking: boolean): string {
  if (checking) return 'Checking…';
  if (!status) return '';
  switch (status.kind) {
    case 'checking':
      return 'Checking…';
    case 'available':
      return status.downloading
        ? `Version ${status.version} found — downloading…`
        : `Version ${status.version} is available.`;
    case 'downloading':
      return `Downloading… ${status.percent}%`;
    case 'ready':
      return `Version ${status.version} is ready — it installs when you quit.`;
    case 'unsupported':
      return `Not available for this build: ${status.reason}`;
    case 'error':
      // The message is a network/HTTP string from electron-updater. Shown here
      // because the user is looking AT the updater; the toast stays silent.
      return `Last check failed: ${status.message}`;
    case 'idle':
    default:
      return 'Up to date.';
  }
}

export function UpdatesControl(): JSX.Element | null {
  const api = bridge();
  const [autoDownload, setAutoDownload] = useState<boolean | null>(null);
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (!api) return;
    void api.getSettings().then((s) => setAutoDownload(s.autoDownload)).catch(() => setAutoDownload(true));
    void api.getStatus().then(setStatus).catch(() => undefined);
    return api.onStatus(setStatus);
  }, [api]);

  // Browser build — there is no shell to update.
  if (!api) return null;

  const unsupported = status?.kind === 'unsupported';

  return (
    <>
      <div className={styles.row}>
        <span className={styles.rowLabel}>Download updates automatically</span>
        <div className={styles.rowRight}>
          <input
            type="checkbox"
            checked={autoDownload ?? true}
            disabled={autoDownload === null || unsupported}
            onChange={(e) => {
              const next = e.target.checked;
              setAutoDownload(next);
              void api.setAutoDownload(next).catch(() => setAutoDownload(!next));
            }}
            aria-label="Download updates in the background, without asking"
          />
        </div>
      </div>
      <div className={styles.row}>
        <span className={styles.rowLabel} style={{ color: 'var(--color-text-tertiary)' }}>
          {describe(status, checking)}
        </span>
        <div className={styles.rowRight} style={{ display: 'inline-flex', gap: 'var(--space-2)' }}>
          {/* Offered only when there IS something to fetch and the user has
              turned background downloads off — otherwise it is a button that
              does nothing visible. */}
          {status?.kind === 'available' && !status.downloading ? (
            <Button size="sm" variant="primary" onClick={() => void api.downloadNow()}>
              Download
            </Button>
          ) : null}
          {status?.kind === 'ready' ? (
            <Button size="sm" variant="primary" onClick={() => void api.restartAndInstall()}>
              Restart now
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="secondary"
            disabled={checking || unsupported}
            onClick={() => {
              setChecking(true);
              void api
                .check()
                .then(setStatus)
                .catch(() => undefined)
                .finally(() => setChecking(false));
            }}
          >
            Check now
          </Button>
        </div>
      </div>
    </>
  );
}
