/**
 * A preload that hands EVERY frame a working invoke bridge.
 *
 * The opposite of what the app ships, and intentionally so. The app's preload
 * only ever runs in the top frame, which means a test using it would show a
 * subframe failing for the wrong reason — no bridge — and would keep passing
 * with the frame guard removed.
 *
 * Here the bridge exists everywhere. Anything that refuses a subframe is the
 * guard doing its job.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('harness', {
  /**
   * Returns the resolved value, or the rejection message as a string.
   *
   * Flattened deliberately: the interesting assertion is WHICH message comes
   * back, and a rejected promise crossing the context bridge into Playwright's
   * evaluate arrives as an unhelpfully generic error.
   */
  async ping() {
    try {
      return { resolved: await ipcRenderer.invoke('harness:ping') };
    } catch (err) {
      return { rejected: String(err && err.message ? err.message : err) };
    }
  },
});
