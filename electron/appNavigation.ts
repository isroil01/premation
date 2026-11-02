/**
 * Whether a navigation of the app window stays on the app.
 *
 * Nothing may replace the editor page: a window with no address bar has no way
 * back from whatever loaded in its place, and the page it replaced held the
 * engine's frame receiver. `window.location.href = <checkout>` did exactly that.
 * Split out of main.ts so the decision is a pure function a test can pin.
 */

/** True for the app's own page: its dev-server origin, or the one packaged file. */
export function isAppPage(url: string, appHome: string): boolean {
  let target: URL;
  let home: URL;
  try {
    target = new URL(url);
    home = new URL(appHome);
  } catch {
    return false;
  }
  if (target.protocol !== home.protocol) return false;
  // A file dropped on the window navigates to it, so `file:` alone is not enough.
  // Windows paths compare without case; the query carries the window chrome.
  if (home.protocol === 'file:') return target.pathname.toLowerCase() === home.pathname.toLowerCase();
  return target.origin === home.origin;
}

/** Only the web may be handed to the system browser, never a local scheme. */
export function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}
