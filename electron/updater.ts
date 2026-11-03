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
 *  • Tells the RENDERER what is happening, so the notice is a persistent
 *    "Restart to update" button in the title bar rather than a modal that
 *    blocks the app. It was a dismissible toast first, and users reported not
 *    seeing it — a pending update outlives any transient, so it is now drawn as
 *    the standing fact it is (`src/stores/updateStore.ts`).
 *
 * ── What stayed ──────────────────────────────────────────────────────────────
 *  • Failures are logged, never shown, unless the user asked the question via
 *    Help ▸ Check for Updates. A dialog on every launch behind a corporate
 *    proxy is worse than no updates.
 *  • That question is answered IN the app (`src/layout/Updates/UpdateDialog`),
 *    not with OS message boxes: the menu item asks the renderer to open its
 *    dialog, and the dialog runs `updater:checkInteractive` and follows the
 *    download through to "ready".
 *  • Nothing runs unless the app is packaged.
 *  • The concern behind the old prompt — a silent ~150 MB download on someone's
 *    phone tether — is real, and is answered by a SETTING (on by default)
 *    rather than by asking every user every time.
 */

import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { app, type BrowserWindow } from 'electron';
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
  updatedFrom,
  type InteractiveCheckResult,
  type UpdateSettings,
  type UpdateStatus,
  type UpdateSupport,
} from './updaterPolicy';

const SETTINGS_FILE = (): string => path.join(app.getPath('userData'), 'update-settings.json');
const LAST_VERSION_FILE = (): string => path.join(app.getPath('userData'), 'last-version.json');

/**
 * `{ from, to }` when this launch is the first one after an upgrade, so the
 * renderer can say "Updated to Premation X" once. Read and rewritten at
 * startup; handed out once (`updater:takeJustUpdated` clears it), so a reload
 * does not announce it again.
 */
let justUpdated: Promise<{ from: string; to: string } | null> | null = null;

async function readJustUpdated(): Promise<{ from: string; to: string } | null> {
  const current = app.getVersion();
  let previous: string | null = null;
  try {
    const raw = JSON.parse(await readFile(LAST_VERSION_FILE(), 'utf8')) as { version?: unknown };
    previous = typeof raw.version === 'string' ? raw.version : null;
  } catch {
    // First run with this file, or unreadable: nothing to announce.
  }
  if (previous !== current) {
    try {
      await writeFile(LAST_VERSION_FILE(), JSON.stringify({ version: current }), 'utf8');
    } catch (err) {
      console.error('[updater] could not record the running version:', err);
    }
  }
  const from = updatedFrom(previous, current);
  return from ? { from, to: current } : null;
}

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

  autoUpdater.on('update-not-available', () => publish({ kind: 'idle' }));

  autoUpdater.on('update-downloaded', (info) => {
    // No dialog. The title bar's "Restart to update" button (and the update
    // dialog, if the user has it open) shows it; the update applies on quit
    // whether or not anyone reads it.
    publish({ kind: 'ready', version: info.version });
  });

  autoUpdater.on('error', (err) => {
    const message = String((err as Error)?.message ?? err);
    console.error('[updater] failed:', message);
    publish({ kind: 'error', message });
  });
}

/**
 * The check behind Help ▸ Check for Updates…, answered to the renderer's
 * dialog. Fetches even if background downloads are off: the user asked, which
 * is the consent that setting stands in for.
 */
async function interactiveCheck(): Promise<InteractiveCheckResult> {
  const support = await currentSupport();
  if (!support.ok) return { kind: 'unsupported', version: app.getVersion(), reason: support.reason };
  if (!wired) {
    wire();
    wired = true;
  }
  // Already on disk, or already coming down: report it rather than ask again.
  if (lastStatus.kind === 'ready') return { kind: 'ready', version: lastStatus.version };
  if (lastStatus.kind === 'downloading' && lastStatus.version) return { kind: 'found', version: lastStatus.version };
  autoUpdater.autoDownload = true;
  try {
    const result = await autoUpdater.checkForUpdates();
    if (!result || !result.isUpdateAvailable) return { kind: 'upToDate', version: app.getVersion() };
    return { kind: 'found', version: result.updateInfo.version };
  } catch (err) {
    console.error('[updater] check failed:', err);
    return { kind: 'failed', message: String((err as Error)?.message ?? err) };
  }
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
  handle('updater:checkInteractive', () => interactiveCheck());
  handle('updater:takeJustUpdated', async () => {
    const value = await (justUpdated ?? Promise.resolve(null));
    justUpdated = Promise.resolve(null);
    return value;
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
 * Open the renderer's `updater:*` channels. Idempotent.
 *
 * Called from main BEFORE the window is created, not only from
 * `initAutoUpdate` (which waits for `ready-to-show`). On Electron 44 the page's
 * boot code reaches `updates.getStatus()` before `ready-to-show` fires, and the
 * invoke was rejected with "No handler registered for 'updater:getStatus'".
 * `getStatus` answers `idle` until `initAutoUpdate` has decided.
 */
export function registerUpdaterIpc(): void {
  if (ipcRegistered) return;
  justUpdated = readJustUpdated();
  registerIpc();
  ipcRegistered = true;
}

/**
 * Start the update flow for a window. Safe to call unconditionally and more
 * than once — it decides for itself whether this build can update, and says why
 * in the log when it cannot.
 */
export function initAutoUpdate(win: BrowserWindow): void {
  target = win;
  registerUpdaterIpc();

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

/**
 * Help ▸ Check for Updates… — opens the renderer's update dialog, which runs
 * `updater:checkInteractive` and reports every outcome, "you're up to date"
 * included.
 */
export function checkForUpdatesInteractive(win: BrowserWindow): void {
  target = win;
  if (win.isDestroyed()) return;
  win.webContents.send('updater:openDialog');
}
