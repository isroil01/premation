/**
 * Auto-update: how a user who installed version N gets version N+1.
 *
 * The shape of it: electron-builder publishes the installers AND a small
 * metadata file (`latest.yml` / `latest-mac.yml`) to the GitHub release. This
 * module fetches that metadata, compares its version to the running one, and
 * downloads the new installer in the background. Nothing here talks to our own
 * backend: updates come from the release, so they keep working for anyone
 * self-hosting or offline-first.
 *
 * ── It used to be manual, and this is what that meant ────────────────────────
 * The mechanism was all here, but every step was consent-gated: a modal on
 * launch ("Download / Later"), then a second modal when the bytes landed
 * ("Restart now / On next launch"). Two dialogs per release, both interrupting
 * whatever the user opened the app to do — and a single check at startup, so a
 * session left running for days never saw an update at all. In practice people
 * dismissed the dialogs and stayed on old builds.
 *
 * ── What it does now ─────────────────────────────────────────────────────────
 *  • Checks on a timer (see updaterPolicy), not just once at launch.
 *  • Downloads in the background with no prompt.
 *  • Applies the update on quit — the moment nothing is in progress and no
 *    unsaved work is at stake, because the app's own close handlers have
 *    already run by then.
 *  • Tells the RENDERER what is happening, so the notice is a dismissible toast
 *    with a Restart button rather than a modal that blocks the app.
 *
 * ── What stayed ──────────────────────────────────────────────────────────────
 *  • Failures are logged, never shown, unless the user asked the question via
 *    Help ▸ Check for Updates. A dialog on every launch behind a corporate
 *    proxy is worse than no updates.
 *  • Nothing runs unless the app is packaged.
 *  • The concern behind the old prompt — a silent ~150 MB download on someone's
 *    phone tether — is real, and is answered by a SETTING (on by default)
 *    rather than by asking every user every time.
 */

import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { app, dialog, type BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';
import { handle } from './ipcGuard';
import {
  CHECK_INTERVAL_MS,
  DEFAULT_UPDATE_SETTINGS,
  FIRST_CHECK_DELAY_MS,
  evaluateSupport,
  normalizePercent,
  parseUpdateSettings,
  resolvePolicy,
  type UpdateSettings,
  type UpdateStatus,
  type UpdateSupport,
} from './updaterPolicy';

const SETTINGS_FILE = (): string => path.join(app.getPath('userData'), 'update-settings.json');

let settings: UpdateSettings = { ...DEFAULT_UPDATE_SETTINGS };
let settingsLoaded = false;

async function loadSettings(): Promise<UpdateSettings> {
  if (settingsLoaded) return settings;
  settingsLoaded = true;
  try {
    settings = parseUpdateSettings(JSON.parse(await readFile(SETTINGS_FILE(), 'utf8')));
  } catch {
    // No file yet (first run) or unreadable — defaults, which mean updates ON.
    settings = { ...DEFAULT_UPDATE_SETTINGS };
  }
  return settings;
}

async function saveSettings(next: UpdateSettings): Promise<void> {
  settings = next;
  settingsLoaded = true;
  try {
    await writeFile(SETTINGS_FILE(), JSON.stringify(next, null, 2), 'utf8');
  } catch (err) {
    // A settings write failing must not break updating — the in-memory value
    // still applies for this session.
    console.error('[updater] could not persist settings:', err);
  }
}

/**
 * Does this macOS bundle carry a valid signature?
 *
 * Asked with `codesign`, because there is no Electron API for it and the answer
 * has to be known BEFORE downloading: Squirrel.Mac verifies at install time, so
 * an unsigned build would fetch the whole installer and then refuse it, once
 * per launch, forever.
 *
 * Cached — the answer cannot change while the app is running.
 * Non-macOS resolves true and is never consulted (see `evaluateSupport`).
 */
let macSignedCache: boolean | null = null;
async function isMacSigned(): Promise<boolean> {
  if (process.platform !== 'darwin') return true;
  if (macSignedCache !== null) return macSignedCache;
  // .../Premation.app/Contents/MacOS/Premation → .../Premation.app
  const bundle = path.resolve(path.dirname(app.getPath('exe')), '..', '..');
  macSignedCache = await new Promise<boolean>((resolve) => {
    execFile('codesign', ['--verify', '--strict', bundle], (err) => resolve(!err));
  });
  if (!macSignedCache) {
    console.log('[updater] macOS bundle is not signed — auto-update stays off for this build');
  }
  return macSignedCache;
}

async function currentSupport(): Promise<UpdateSupport> {
  return evaluateSupport({
    packaged: app.isPackaged,
    platform: process.platform,
    disabled: process.env.MOTION_DISABLE_UPDATES === '1',
    macSigned: await isMacSigned(),
  });
}

// ── Renderer channel ─────────────────────────────────────────────────────────
// The window can go away (closed, reloaded) between an event firing and this
// running, so every send is guarded rather than assumed.
let target: BrowserWindow | null = null;
let lastStatus: UpdateStatus = { kind: 'idle' };

function publish(status: UpdateStatus): void {
  lastStatus = status;
  if (!target || target.isDestroyed()) return;
  target.webContents.send('updater:status', status);
}

/** Set when the check came from the Help menu, which SHOULD report its result. */
let userInitiated = false;
let wired = false;
let timer: ReturnType<typeof setInterval> | null = null;

function wire(): void {
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;

  autoUpdater.on('checking-for-update', () => publish({ kind: 'checking' }));

  autoUpdater.on('update-available', (info) => {
    publish({ kind: 'available', version: info.version, downloading: autoUpdater.autoDownload });
  });

  autoUpdater.on('download-progress', (progress) => {
    publish({
      kind: 'downloading',
      version: lastStatus.kind === 'available' ? lastStatus.version : '',
      percent: normalizePercent((progress as { percent?: unknown }).percent),
    });
  });

  autoUpdater.on('update-not-available', () => {
    publish({ kind: 'idle' });
    if (!userInitiated) return;
    userInitiated = false;
    void showInfo('No updates', `Premation ${app.getVersion()} is the latest version.`);
  });

  autoUpdater.on('update-downloaded', (info) => {
    // No dialog. The renderer shows a dismissible toast, and the update applies
    // on quit whether or not anyone reads it.
    publish({ kind: 'ready', version: info.version });
    if (!userInitiated) return;
    userInitiated = false;
    void showInfo(
      'Update ready',
      `Premation ${info.version} will be installed when you quit.`,
      'You can also restart now from the notification in the app.',
    );
  });

  autoUpdater.on('error', (err) => {
    const message = String((err as Error)?.message ?? err);
    console.error('[updater] failed:', message);
    publish({ kind: 'error', message });
    if (!userInitiated) return;
    userInitiated = false;
    void showWarning('Update check failed', 'Could not check for updates.', message);
  });
}

function showInfo(title: string, message: string, detail?: string): Promise<unknown> {
  const opts = { type: 'info' as const, buttons: ['OK'], title, message, ...(detail ? { detail } : {}) };
  return target && !target.isDestroyed()
    ? dialog.showMessageBox(target, opts)
    : dialog.showMessageBox(opts);
}

function showWarning(title: string, message: string, detail: string): Promise<unknown> {
  const opts = { type: 'warning' as const, buttons: ['OK'], title, message, detail };
  return target && !target.isDestroyed()
    ? dialog.showMessageBox(target, opts)
    : dialog.showMessageBox(opts);
}

/** Apply the current settings to electron-updater and run a check. */
async function check(): Promise<void> {
  const support = await currentSupport();
  if (!support.ok) return;
  autoUpdater.autoDownload = resolvePolicy(support, await loadSettings()).autoDownload;
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    console.error('[updater] check failed:', err);
  }
}

/**
 * IPC the renderer uses to show the toast and act on it. Registered once,
 * independently of whether updates are supported — the renderer still needs a
 * truthful answer on a dev or unsigned build, and gets `unsupported`.
 *
 * Through `handle` from ipcGuard, never `ipcMain.handle`: registration goes
 * through one validating door, and `ipcRegistration.test.ts` enforces it.
 */
function registerIpc(): void {
  handle('updater:getStatus', () => lastStatus);
  handle('updater:getSettings', async () => loadSettings());
  handle('updater:setAutoDownload', async (_event, enabled: never) => {
    const next: UpdateSettings = { autoDownload: enabled !== false };
    await saveSettings(next);
    const support = await currentSupport();
    if (support.ok) {
      autoUpdater.autoDownload = resolvePolicy(support, next).autoDownload;
      // Turning it ON should act now rather than at the next 6-hour tick — the
      // user just asked for updates and expects something to happen.
      if (next.autoDownload && lastStatus.kind === 'available') {
        void autoUpdater.downloadUpdate().catch((err: unknown) => {
          console.error('[updater] download failed:', err);
        });
      }
    }
    return next;
  });
  handle('updater:check', async () => {
    await check();
    return lastStatus;
  });
  handle('updater:restartAndInstall', () => {
    // isSilent=false so the installer's own UI shows; isForceRunAfter so the
    // user lands back in the app rather than at their desktop.
    autoUpdater.quitAndInstall(false, true);
  });
  handle('updater:downloadNow', async () => {
    const support = await currentSupport();
    if (!support.ok) return false;
    try {
      await autoUpdater.downloadUpdate();
      return true;
    } catch (err) {
      console.error('[updater] download failed:', err);
      return false;
    }
  });
}

let ipcRegistered = false;

/**
 * Start the update flow for a window. Safe to call unconditionally and more
 * than once — it decides for itself whether this build can update, and says why
 * in the log when it cannot.
 */
export function initAutoUpdate(win: BrowserWindow): void {
  target = win;
  if (!ipcRegistered) {
    registerIpc();
    ipcRegistered = true;
  }

  void (async () => {
    const support = await currentSupport();
    if (!support.ok) {
      console.log(`[updater] disabled: ${support.reason}`);
      publish({ kind: 'unsupported', reason: support.reason });
      return;
    }
    if (!wired) {
      wire();
      wired = true;
    }
    // Delayed, then repeating: see FIRST_CHECK_DELAY_MS / CHECK_INTERVAL_MS.
    setTimeout(() => void check(), FIRST_CHECK_DELAY_MS);
    if (timer === null) {
      timer = setInterval(() => void check(), CHECK_INTERVAL_MS);
      // Do not hold the process open for a check nobody is waiting on.
      timer.unref?.();
    }
  })();
}

/** Help ▸ Check for Updates… — same flow, but it reports "you're up to date". */
export function checkForUpdatesInteractive(win: BrowserWindow): void {
  target = win;
  void (async () => {
    const support = await currentSupport();
    if (!support.ok) {
      void showInfo(
        'Updates unavailable',
        `Premation ${app.getVersion()}`,
        `Automatic updates are not active for this build: ${support.reason}.`,
      );
      return;
    }
    if (!wired) {
      wire();
      wired = true;
    }
    // A user-initiated check should fetch even if background downloads are off:
    // they asked for it, which is the consent the setting was standing in for.
    autoUpdater.autoDownload = true;
    userInitiated = true;
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      console.error('[updater] check failed:', err);
    }
  })();
}
