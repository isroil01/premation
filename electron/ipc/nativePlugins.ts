/**
 * The native plugins folder, for the Plugins page and panel.
 *
 * Native SDK plugins (docs/PLUGIN_SDK.md) are installed by hand in 0.9: the
 * user copies a plugin bundle into `<userData>/native-plugins` and the engine
 * process loads it at start (`EngineHost`'s `nativePluginDir`). The renderer
 * never learns the path through a free-form channel — it can only ask main to
 * open THIS folder in Explorer / Finder, and to say what it is called so the
 * install steps can name it.
 *
 * Registered through `ipcGuard`'s `handle`, like every other channel, so the
 * sender-frame check applies. Neither channel takes an argument from the page.
 */

import { mkdirSync } from 'node:fs';
import { shell } from 'electron';
import { handle } from '../ipcGuard';

export interface OpenNativePluginFolderResult {
  ok: boolean;
  /** The folder that was (or would have been) opened. */
  path: string;
  /** The OS's reason when it could not be opened. */
  error?: string;
}

export interface NativePluginIpcDeps {
  /** The folder the engine loads native plugins from (main.ts's `nativePluginDir`). */
  dir: () => string;
  /** `shell.openPath` — injected for the test. Resolves '' on success, else an error string. */
  openPath?: (p: string) => Promise<string>;
  /** Create the folder if it is missing — a fresh install has not made it yet. */
  ensureDir?: (p: string) => void;
}

/** The handler bodies, exported for the test. */
export function nativePluginHandlers(deps: NativePluginIpcDeps): {
  openFolder: () => Promise<OpenNativePluginFolderResult>;
  folderPath: () => string;
} {
  const openPath = deps.openPath ?? ((p: string) => shell.openPath(p));
  const ensure = deps.ensureDir ?? ((p: string) => { mkdirSync(p, { recursive: true }); });
  return {
    openFolder: async () => {
      const dir = deps.dir();
      try {
        ensure(dir);
        const error = await openPath(dir);
        return error ? { ok: false, path: dir, error } : { ok: true, path: dir };
      } catch (err) {
        return { ok: false, path: dir, error: err instanceof Error ? err.message : String(err) };
      }
    },
    folderPath: () => deps.dir(),
  };
}

export function registerNativePluginIpc(deps: NativePluginIpcDeps): void {
  const h = nativePluginHandlers(deps);
  /** Open the native plugins folder in the OS file manager. */
  handle('plugins:openNativeFolder', () => h.openFolder());
  /** The native plugins folder's path, for the install instructions. */
  handle('plugins:nativeFolderPath', () => h.folderPath());
}
