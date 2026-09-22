/**
 * The Object Matte model download, as a JOB.
 *
 * `useSamModelStore` already carries the download's progress for the control
 * that started it; this mirrors its status transitions into `uiStore.jobs` so
 * the status-bar tray and a progress toast show the download after the
 * Preferences dialog is closed — a 40 MB fetch outlives the dialog that
 * started it, and a person who closed it deserves to know when it landed.
 *
 * Installed once, on first import (the control imports it). A module-level
 * subscription rather than an effect in the control, for exactly that reason:
 * the control unmounts with the dialog and the download does not.
 */

import { useSamModelStore } from '@stores/samModelStore';
import { useUIStore } from '@stores/uiStore';

export const OBJECT_MATTE_JOB_ID = 'object-matte-model';

const MB = 1024 * 1024;

let installed = false;

export function installObjectMatteJob(): void {
  if (installed) return;
  installed = true;
  let wasDownloading = false;
  useSamModelStore.subscribe((state) => {
    const { status } = state;
    const ui = useUIStore.getState();
    if (status.kind === 'downloading') {
      const { receivedBytes, totalBytes } = status;
      const label = totalBytes
        ? `Downloading Object Matte model… ${Math.min(100, Math.round((receivedBytes / totalBytes) * 100))}%`
        : `Downloading Object Matte model… ${(receivedBytes / MB).toFixed(0)} MB`;
      // No percentage without a Content-Length — inventing one would be a lie.
      const progress = totalBytes ? Math.min(1, receivedBytes / totalBytes) : 'indeterminate';
      if (!wasDownloading) ui.startJob({ id: OBJECT_MATTE_JOB_ID, label, progress });
      else ui.updateJob(OBJECT_MATTE_JOB_ID, { label, progress });
      wasDownloading = true;
      return;
    }
    if (!wasDownloading) return;
    wasDownloading = false;
    if (status.kind === 'ready') {
      ui.finishJob(OBJECT_MATTE_JOB_ID, {
        status: 'done',
        message: `Object Matte model installed (${(status.bytes / MB).toFixed(0)} MB)`,
      });
    } else if (status.kind === 'failed') {
      ui.finishJob(OBJECT_MATTE_JOB_ID, { status: 'failed', message: `Model download failed: ${status.message}` });
    } else {
      // `absent` after downloading is the user's Cancel.
      ui.finishJob(OBJECT_MATTE_JOB_ID, { status: 'cancelled', message: 'Model download cancelled' });
    }
  });
}
