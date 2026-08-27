/**
 * Auto-update's decisions, tested where they can be tested.
 *
 * A real update round-trip needs a signed installer, a published GitHub release
 * and a machine willing to restart, so it cannot live in this suite. What CAN
 * live here is every branch that decides whether to update at all — which is
 * where the bug was: macOS was gated behind an environment variable
 * (`MOTION_ENABLE_MAC_UPDATES=1`) that no shipped app has ever had, so every
 * macOS user was silently on manual updates forever, including on the signed
 * and notarized builds the release pipeline produces.
 */

import {
  CHECK_INTERVAL_MS,
  DEFAULT_UPDATE_SETTINGS,
  FIRST_CHECK_DELAY_MS,
  evaluateSupport,
  normalizePercent,
  parseUpdateSettings,
  resolvePolicy,
  type UpdateEnvironment,
} from './updaterPolicy';

const packagedWindows: UpdateEnvironment = {
  packaged: true,
  platform: 'win32',
  disabled: false,
  macSigned: true,
};

describe('evaluateSupport', () => {
  it('allows a packaged Windows build', () => {
    expect(evaluateSupport(packagedWindows)).toEqual({ ok: true });
  });

  it('allows a packaged, SIGNED macOS build — the case that used to be refused', () => {
    expect(evaluateSupport({ ...packagedWindows, platform: 'darwin', macSigned: true })).toEqual({
      ok: true,
    });
  });

  it('refuses an UNSIGNED macOS build, because macOS would refuse it after the download', () => {
    const result = evaluateSupport({ ...packagedWindows, platform: 'darwin', macSigned: false });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/not signed/i);
  });

  it('does not care about signing on Windows — it updates unsigned', () => {
    expect(evaluateSupport({ ...packagedWindows, macSigned: false })).toEqual({ ok: true });
  });

  it('refuses a dev build, where there is no release to compare against', () => {
    const result = evaluateSupport({ ...packagedWindows, packaged: false });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/packaged/i);
  });

  it('honours the MOTION_DISABLE_UPDATES escape hatch', () => {
    const result = evaluateSupport({ ...packagedWindows, disabled: true });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/MOTION_DISABLE_UPDATES/);
  });

  it('reports "not packaged" ahead of everything else, so a dev run says something useful', () => {
    const result = evaluateSupport({
      packaged: false,
      platform: 'darwin',
      disabled: true,
      macSigned: false,
    });
    expect(result.ok === false && result.reason).toMatch(/packaged/i);
  });
});

describe('resolvePolicy', () => {
  it('downloads and installs on quit by default — this is the whole feature', () => {
    expect(resolvePolicy({ ok: true }, { autoDownload: true })).toEqual({
      autoDownload: true,
      autoInstallOnQuit: true,
    });
  });

  it('still installs on quit when the user turned auto-DOWNLOAD off', () => {
    // Not a contradiction: with downloads off nothing arrives unasked, but an
    // update they DID fetch must not be stranded in the cache.
    expect(resolvePolicy({ ok: true }, { autoDownload: false })).toEqual({
      autoDownload: false,
      autoInstallOnQuit: true,
    });
  });

  it('does nothing at all when the build cannot update', () => {
    expect(resolvePolicy({ ok: false, reason: 'dev' }, { autoDownload: true })).toEqual({
      autoDownload: false,
      autoInstallOnQuit: false,
    });
  });
});

describe('parseUpdateSettings', () => {
  it('defaults to auto-download ON', () => {
    expect(DEFAULT_UPDATE_SETTINGS.autoDownload).toBe(true);
    expect(parseUpdateSettings(undefined)).toEqual({ autoDownload: true });
    expect(parseUpdateSettings(null)).toEqual({ autoDownload: true });
  });

  it('reads a stored choice back', () => {
    expect(parseUpdateSettings({ autoDownload: false })).toEqual({ autoDownload: false });
    expect(parseUpdateSettings({ autoDownload: true })).toEqual({ autoDownload: true });
  });

  it('falls back to ON for junk rather than silently disabling updates', () => {
    // The safe direction: a user who wanted it off can turn it off again, but
    // updates disabled by a corrupt file is invisible and permanent.
    expect(parseUpdateSettings('nonsense')).toEqual({ autoDownload: true });
    expect(parseUpdateSettings({ autoDownload: 'no' })).toEqual({ autoDownload: true });
    expect(parseUpdateSettings({})).toEqual({ autoDownload: true });
    expect(parseUpdateSettings(42)).toEqual({ autoDownload: true });
  });

  it('returns a fresh object, so a caller cannot mutate the defaults', () => {
    const a = parseUpdateSettings(null);
    a.autoDownload = false;
    expect(DEFAULT_UPDATE_SETTINGS.autoDownload).toBe(true);
    expect(parseUpdateSettings(null).autoDownload).toBe(true);
  });
});

describe('check scheduling', () => {
  it('waits before the first check rather than competing with app startup', () => {
    expect(FIRST_CHECK_DELAY_MS).toBeGreaterThanOrEqual(5_000);
  });

  it('re-checks periodically — an editor stays open for days', () => {
    // The bug this replaces: a single check at launch, so a long-running
    // session never saw a release at all.
    expect(CHECK_INTERVAL_MS).toBeGreaterThan(0);
    expect(CHECK_INTERVAL_MS).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });
});

describe('normalizePercent', () => {
  it('rounds to a whole percent', () => {
    expect(normalizePercent(41.6)).toBe(42);
  });

  it('clamps the overshoot electron-updater emits on the last tick', () => {
    expect(normalizePercent(100.4)).toBe(100);
    expect(normalizePercent(1e6)).toBe(100);
  });

  it('treats the NaN first tick as 0 rather than rendering a broken bar', () => {
    expect(normalizePercent(Number.NaN)).toBe(0);
    expect(normalizePercent(undefined)).toBe(0);
    expect(normalizePercent(null)).toBe(0);
    expect(normalizePercent(-5)).toBe(0);
  });
});
