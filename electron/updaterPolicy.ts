/**
 * The decisions behind auto-update, separated from the machinery that acts on
 * them so they can be tested without Electron or a live GitHub release.
 *
 * The machinery (`electron/updater.ts`) is a thin shell around these: it asks
 * "may this build update?", "should it download on its own?", "when is the next
 * check due?" and does what it is told.
 */

/** How the app behaves once an update exists. */
export interface UpdatePolicy {
  /** Fetch the installer without asking. */
  autoDownload: boolean;
  /** Apply a downloaded update when the app quits. */
  autoInstallOnQuit: boolean;
}

/**
 * Persisted per-machine update settings.
 *
 * Only the download half is a user choice. Whether a DOWNLOADED update gets
 * applied on quit is not: at that point the bytes are already on disk, the user
 * is closing the app anyway, and leaving them un-applied is how someone runs a
 * six-month-old build with an update sitting in their cache.
 */
export interface UpdateSettings {
  /** Download updates in the background. Default true. */
  autoDownload: boolean;
}

export const DEFAULT_UPDATE_SETTINGS: UpdateSettings = {
  autoDownload: true,
};

/**
 * Read persisted settings out of whatever was on disk.
 *
 * Deliberately permissive: a corrupt or hand-edited settings file must not stop
 * the app updating. Anything unparseable falls back to the defaults, which are
 * the safe direction — a user who wanted auto-download off can turn it off
 * again, whereas silently disabling updates is invisible and permanent.
 */
export function parseUpdateSettings(raw: unknown): UpdateSettings {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_UPDATE_SETTINGS };
  const value = (raw as Record<string, unknown>).autoDownload;
  if (typeof value !== 'boolean') return { ...DEFAULT_UPDATE_SETTINGS };
  return { autoDownload: value };
}

/** Inputs the support decision is made from — all injectable, none read here. */
export interface UpdateEnvironment {
  packaged: boolean;
  platform: NodeJS.Platform;
  /** MOTION_DISABLE_UPDATES — an escape hatch for locked-down deployments. */
  disabled: boolean;
  /**
   * Whether this macOS bundle carries a valid signature.
   *
   * Squirrel.Mac refuses to APPLY an update it cannot verify, and it only finds
   * that out after downloading the whole thing. So on macOS this has to be
   * known before auto-download is allowed, or an unsigned build re-downloads
   * ~150 MB on every launch and throws it away every time.
   *
   * Irrelevant on Windows, which updates unsigned (SmartScreen warns at install
   * but the update itself works).
   */
  macSigned: boolean;
}

export type UpdateSupport = { ok: true } | { ok: false; reason: string };

/**
 * Whether this build can update itself at all.
 *
 * This used to gate macOS behind `MOTION_ENABLE_MAC_UPDATES=1`, which no
 * shipped app ever has in its environment — so every macOS user was silently on
 * manual updates forever, including on the signed and notarized builds the
 * release pipeline produces. The real question is whether the bundle is signed,
 * so that is what gets asked.
 */
export function evaluateSupport(env: UpdateEnvironment): UpdateSupport {
  if (!env.packaged) {
    return { ok: false, reason: 'not a packaged build — there is no release to compare against' };
  }
  if (env.disabled) {
    return { ok: false, reason: 'MOTION_DISABLE_UPDATES=1' };
  }
  if (env.platform === 'darwin' && !env.macSigned) {
    return {
      ok: false,
      reason: 'this macOS build is not signed, and macOS refuses to apply an update it cannot verify',
    };
  }
  return { ok: true };
}

/**
 * Turn settings + support into the two flags electron-updater actually reads.
 *
 * `autoInstallOnQuit` is true whenever updates work at all — including when the
 * user has turned auto-download OFF. That is not a contradiction: with
 * auto-download off nothing is ever downloaded without their say-so, but an
 * update they DID choose to download still gets applied rather than stranded.
 */
export function resolvePolicy(support: UpdateSupport, settings: UpdateSettings): UpdatePolicy {
  if (!support.ok) return { autoDownload: false, autoInstallOnQuit: false };
  return { autoDownload: settings.autoDownload, autoInstallOnQuit: true };
}

/**
 * How long to wait before the first check, and between checks after that.
 *
 * The app only checked once, at launch. An editor is the kind of program people
 * leave open for days, so "at launch" meant a long-running session never saw an
 * update at all.
 *
 * The startup delay is not politeness — a check during boot competes with the
 * renderer for the network while it is fetching the app's own assets.
 */
export const FIRST_CHECK_DELAY_MS = 10_000;
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Statuses the main process reports to the renderer. */
export type UpdateStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'available'; version: string; downloading: boolean }
  | { kind: 'downloading'; version: string; percent: number }
  | { kind: 'ready'; version: string }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'error'; message: string };

/**
 * Clamp a download-progress percentage into something a UI can render.
 *
 * electron-updater's `percent` is a float that can arrive as NaN on the first
 * tick (bytes/total before total is known) and can overshoot 100 slightly on
 * the last. Both render as a broken progress bar.
 */
export function normalizePercent(percent: unknown): number {
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return 0;
  return Math.max(0, Math.min(100, Math.round(percent)));
}
