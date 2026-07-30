/**
 * Auto-update: how a user who installed version N gets version N+1.
 *
 * The shape of it: electron-builder publishes the installers AND a small
 * metadata file (`latest.yml` / `latest-mac.yml` / `latest-linux.yml`) to the
 * GitHub release. This module fetches that metadata, compares its version to the
 * running one, and — with the user's consent — downloads the new installer and
 * hands over to it on quit. Nothing here talks to our own backend: updates come
 * from the release, so they keep working for anyone self-hosting or offline-first.
 *
 * Deliberate choices:
 *
 *  • `autoDownload = false`. A silent background download of a ~150 MB installer
 *    on someone's phone tether is not a favour. We ask first.
 *  • Failures are logged, never shown. A failed check is not the user's problem
 *    to solve, and a dialog on every launch behind a corporate proxy is worse
 *    than no updates.
 *  • Nothing runs unless the app is packaged. In dev there is no `latest.yml`
 *    to find and electron-updater throws — which is noise, not information.
 *  • **macOS needs a signed app.** Squirrel.Mac refuses to apply an update whose
 *    signature it cannot verify, so on an unsigned build the check fails with a
 *    code-signature error every launch. Rather than ship that, macOS is opt-in
 *    via MOTION_ENABLE_MAC_UPDATES=1 — flip it once the build is signed and
 *    notarized. Windows (NSIS) and Linux (AppImage) update unsigned, though on
 *    Windows an unsigned installer still faces SmartScreen.
 */

import { app, dialog, type BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';

/** Set once the user has agreed to a download, so we don't ask twice. */
let downloading = false;
/** Set when a check was started by a menu click, which SHOULD report its result. */
let userInitiated = false;

function updatesSupported(): { ok: true } | { ok: false; reason: string } {
  if (!app.isPackaged) {
    return { ok: false, reason: 'not a packaged build — there is no release to compare against' };
  }
  if (process.env.MOTION_DISABLE_UPDATES === '1') {
    return { ok: false, reason: 'MOTION_DISABLE_UPDATES=1' };
  }
  if (process.platform === 'darwin' && process.env.MOTION_ENABLE_MAC_UPDATES !== '1') {
    return {
      ok: false,
      reason:
        'macOS auto-update needs a signed and notarized build (set MOTION_ENABLE_MAC_UPDATES=1 once it is)',
    };
  }
  return { ok: true };
}

function wire(win: BrowserWindow): void {
  autoUpdater.autoDownload = false;
  // Applying the update is the user's decision, made in the dialog below — not a
  // side effect of them closing the window.
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = null;

  autoUpdater.on('update-available', (info) => {
    if (downloading) return;
    void dialog
      .showMessageBox(win, {
        type: 'info',
        buttons: ['Download', 'Later'],
        defaultId: 0,
        cancelId: 1,
        title: 'Update available',
        message: `Premation ${info.version} is available.`,
        detail: `You have ${app.getVersion()}. The update downloads in the background; you choose when to restart.`,
      })
      .then(({ response }) => {
        if (response !== 0) return;
        downloading = true;
        void autoUpdater.downloadUpdate().catch((err: unknown) => {
          downloading = false;
          console.error('[updater] download failed:', err);
        });
      });
  });

  autoUpdater.on('update-not-available', () => {
    // Only worth saying out loud when the user asked the question.
    if (!userInitiated) return;
    userInitiated = false;
    void dialog.showMessageBox(win, {
      type: 'info',
      buttons: ['OK'],
      title: 'No updates',
      message: `Premation ${app.getVersion()} is the latest version.`,
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    downloading = false;
    void dialog
      .showMessageBox(win, {
        type: 'info',
        buttons: ['Restart now', 'On next launch'],
        defaultId: 0,
        cancelId: 1,
        title: 'Update ready',
        message: `Premation ${info.version} is ready to install.`,
        detail: 'Save your work before restarting — unsaved changes are not preserved across a restart.',
      })
      .then(({ response }) => {
        if (response === 0) {
          // isSilent=false so the installer's own UI shows; isForceRunAfter so
          // the user lands back in the app rather than at their desktop.
          autoUpdater.quitAndInstall(false, true);
        } else {
          // They said "later", so honour that at quit rather than dropping the
          // downloaded update on the floor.
          autoUpdater.autoInstallOnAppQuit = true;
        }
      });
  });

  autoUpdater.on('error', (err) => {
    downloading = false;
    console.error('[updater] check failed:', err);
    if (!userInitiated) return;
    userInitiated = false;
    void dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['OK'],
      title: 'Update check failed',
      message: 'Could not check for updates.',
      detail: String((err as Error)?.message ?? err),
    });
  });
}

let wired = false;

/**
 * Start the update flow for a window. Safe to call unconditionally — it decides
 * for itself whether this build can update, and says why in the log when it
 * cannot.
 */
export function initAutoUpdate(win: BrowserWindow): void {
  const support = updatesSupported();
  if (!support.ok) {
    console.log(`[updater] disabled: ${support.reason}`);
    return;
  }
  if (!wired) {
    wire(win);
    wired = true;
  }
  void autoUpdater.checkForUpdates().catch((err: unknown) => {
    console.error('[updater] check failed:', err);
  });
}

/** Help ▸ Check for Updates… — same flow, but it reports "you're up to date". */
export function checkForUpdatesInteractive(win: BrowserWindow): void {
  const support = updatesSupported();
  if (!support.ok) {
    void dialog.showMessageBox(win, {
      type: 'info',
      buttons: ['OK'],
      title: 'Updates unavailable',
      message: `Premation ${app.getVersion()}`,
      detail: `Automatic updates are not active for this build: ${support.reason}.`,
    });
    return;
  }
  if (!wired) {
    wire(win);
    wired = true;
  }
  userInitiated = true;
  void autoUpdater.checkForUpdates().catch((err: unknown) => {
    console.error('[updater] check failed:', err);
  });
}
