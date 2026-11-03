/**
 * Help ▸ Check for Updates… — the in-app answer.
 *
 * This replaced OS message boxes ("No updates", "Update ready", "Update check
 * failed"), which looked like a different program and could only say OK. The
 * dialog runs the check itself (`updates.checkInteractive`) and stays with it:
 * a found update downloads with its progress shown, and ends on "ready" with
 * Restart now / Later. Closing it never cancels anything; a download carries
 * on and the title bar's "Restart to update" button picks it up.
 *
 * Open state lives in `updateStore.dialogOpen` (set by `useAutoUpdate` when
 * the menu asks); everything else is local, because it is only meaningful
 * while the dialog is showing.
 */

import { useCallback, useEffect, useState } from 'react';
import { Modal, DialogFooter } from '@components/Modal';
import { Button } from '@components/Button';
import { Progress } from '@components/Progress';
import { Logo } from '@components/Logo';
import { useUpdateStore } from '@stores/updateStore';
import { APP_VERSION } from '@core/config/appVersion';
import { t } from '@core/i18n';
import type { InteractiveCheckResult, UpdateStatus } from '@app-types/motionEditor';
import styles from './UpdateDialog.module.css';

type Phase =
  | { kind: 'checking' }
  | { kind: 'upToDate'; version: string }
  | { kind: 'downloading'; version: string; percent: number | null }
  | { kind: 'ready'; version: string }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'failed'; message: string };

function fromResult(r: InteractiveCheckResult): Phase {
  switch (r.kind) {
    case 'found':
      return { kind: 'downloading', version: r.version, percent: null };
    case 'upToDate':
      return { kind: 'upToDate', version: r.version };
    case 'ready':
      return { kind: 'ready', version: r.version };
    case 'unsupported':
      return { kind: 'unsupported', reason: r.reason };
    case 'failed':
      return { kind: 'failed', message: r.message };
  }
}

function title(phase: Phase): string {
  switch (phase.kind) {
    case 'checking':
      return t('updates.dialog.checkingTitle', 'Checking for updates');
    case 'upToDate':
      return t('updates.dialog.upToDateTitle', "You're up to date");
    case 'downloading':
      return t('updates.dialog.downloadingTitle', 'Downloading Premation {version}', { version: phase.version });
    case 'ready':
      return t('updates.dialog.readyTitle', 'Premation {version} is ready', { version: phase.version });
    case 'unsupported':
      return t('updates.dialog.unsupportedTitle', 'Updates are off for this build');
    case 'failed':
      return t('updates.dialog.failedTitle', "Couldn't check for updates");
  }
}

export function UpdateDialog(): JSX.Element | null {
  const open = useUpdateStore((s) => s.dialogOpen);
  const restarting = useUpdateStore((s) => s.restarting);
  const [phase, setPhase] = useState<Phase>({ kind: 'checking' });

  const close = useCallback(() => useUpdateStore.getState().setDialogOpen(false), []);

  const run = useCallback(() => {
    const bridge = window.motionEditor?.updates;
    if (!bridge) return;
    setPhase({ kind: 'checking' });
    bridge
      .checkInteractive()
      .then((r) => setPhase(fromResult(r)))
      .catch((err: unknown) => setPhase({ kind: 'failed', message: String((err as Error)?.message ?? err) }));
  }, []);

  // A fresh check every time the dialog opens: the user asked the question now.
  useEffect(() => {
    if (open) run();
  }, [open, run]);

  // Follow a download through to "ready" while the dialog is up. Statuses for
  // a different stage (a background `checking`) are ignored, not drawn.
  useEffect(() => {
    if (!open) return;
    const bridge = window.motionEditor?.updates;
    if (!bridge) return;
    return bridge.onStatus((s: UpdateStatus) => {
      setPhase((cur) => {
        if (s.kind === 'ready') return { kind: 'ready', version: s.version };
        if (cur.kind !== 'downloading') return cur;
        if (s.kind === 'downloading') return { kind: 'downloading', version: cur.version, percent: s.percent };
        if (s.kind === 'error') return { kind: 'failed', message: s.message };
        return cur;
      });
    });
  }, [open]);

  if (!open) return null;

  const restart = (): void => {
    const bridge = window.motionEditor?.updates;
    if (!bridge) return;
    useUpdateStore.getState().setRestarting(true);
    void bridge.restartAndInstall();
  };

  let message: string;
  let footer: JSX.Element;
  switch (phase.kind) {
    case 'checking':
      message = t('updates.dialog.checkingBody', 'Looking for a newer version of Premation.');
      footer = <DialogFooter secondary={<Button onClick={close}>{t('updates.dialog.cancel', 'Cancel')}</Button>} />;
      break;
    case 'upToDate':
      message = t('updates.dialog.upToDateBody', 'Premation {version} is the newest version.', { version: phase.version });
      footer = <DialogFooter primary={<Button variant="primary" onClick={close}>{t('updates.dialog.ok', 'OK')}</Button>} />;
      break;
    case 'downloading':
      message = t('updates.dialog.downloadingBody', 'You can keep working while it downloads. It installs the next time you quit.');
      footer = <DialogFooter secondary={<Button onClick={close}>{t('updates.dialog.hide', 'Hide')}</Button>} />;
      break;
    case 'ready':
      message = t('updates.dialog.readyBody', 'Restart now to install it, or it installs the next time you quit.');
      footer = (
        <DialogFooter
          secondary={<Button onClick={close}>{t('updates.dialog.later', 'Later')}</Button>}
          primary={
            <Button variant="primary" onClick={restart} disabled={restarting}>
              {restarting ? t('updates.dialog.restarting', 'Restarting…') : t('updates.dialog.restart', 'Restart now')}
            </Button>
          }
        />
      );
      break;
    case 'unsupported':
      message = t('updates.dialog.unsupportedBody', 'This copy of Premation cannot update itself. Download the latest version from the website.');
      footer = <DialogFooter primary={<Button variant="primary" onClick={close}>{t('updates.dialog.ok', 'OK')}</Button>} />;
      break;
    case 'failed':
      message = t('updates.dialog.failedBody', 'Check your internet connection and try again.');
      footer = (
        <DialogFooter
          secondary={<Button onClick={close}>{t('updates.dialog.close', 'Close')}</Button>}
          primary={<Button variant="primary" onClick={run}>{t('updates.dialog.retry', 'Try again')}</Button>}
        />
      );
      break;
  }

  return (
    <Modal open onClose={close} id="update-dialog" size="sm" title={title(phase)} footer={footer}>
      <div className={styles.body}>
        <div className={styles.product}>
          <Logo variant="mark" size={36} />
          <div className={styles.productText}>
            <span className={styles.productName}>Premation</span>
            <span className={styles.productVersion}>
              {t('updates.dialog.installed', 'Installed {version}', { version: APP_VERSION })}
            </span>
          </div>
        </div>
        <p className={styles.message}>{message}</p>
        {phase.kind === 'checking' && (
          <Progress indeterminate size="sm" aria-label={t('updates.dialog.checkingTitle', 'Checking for updates')} />
        )}
        {phase.kind === 'downloading' && (
          phase.percent === null ? (
            <Progress indeterminate size="sm" aria-label={title(phase)} />
          ) : (
            <Progress value={phase.percent / 100} size="sm" showValue aria-label={title(phase)} />
          )
        )}
        {phase.kind === 'unsupported' && <p className={styles.detail}>{phase.reason}</p>}
        {phase.kind === 'failed' && <p className={styles.detail}>{phase.message}</p>}
      </div>
    </Modal>
  );
}

export default UpdateDialog;
