/**
 * Disk-facing IPC for the Assets panel: reveal a file in the OS file manager,
 * pick a folder, and list a directory for the media browser.
 *
 * Registered through `ipcGuard`'s `handle`, like every other channel, so the
 * sender-frame check applies (see `ipcGuard.ts`). Nothing here writes; the
 * worst a bad argument can do is list a directory the user could already
 * open in Explorer.
 *
 * `fs:listDir` is ONE level, on demand. The media browser is a lazy tree —
 * it asks for a folder when the user opens it — because a recursive walk of
 * a footage drive is the kind of call that returns after the user has given
 * up. Hidden entries (dot-files, `$RECYCLE.BIN`, `Thumbs.db`) are dropped
 * here rather than in the renderer so the list the renderer sees is the list
 * the user expects to see.
 *
 * `fs:watchDirs` replaces the folders this window's Media Browser has on
 * screen; a change in one is pushed back as `fs:dirsChanged` with the folder
 * paths (electron/dirWatch.ts), and the page re-lists just those.
 */

import { app, clipboard, dialog, shell, type WebContents } from 'electron';
import { readClipboardFilePaths } from '../clipboardFiles';
import { existsSync, watch as fsWatch } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { handle } from '../ipcGuard';
import { rememberDir, rememberedDir } from '../dialogDirs';
import { pluginImportExtensions } from '../pluginImportExtensions';
import { DirWatcher, MAX_WATCHED_DIRS } from '../dirWatch';

export interface DirEntryDto {
  name: string;
  path: string;
  kind: 'dir' | 'file';
  size?: number;
  mtimeMs?: number;
}

const HIDDEN = /^(\.|\$RECYCLE\.BIN$|System Volume Information$|Thumbs\.db$|desktop\.ini$)/i;

/** Pure: which directory entries the browser lists. Exported for the test. */
export function listableEntry(name: string): boolean {
  return !HIDDEN.test(name);
}

export async function listDirectory(dir: string): Promise<DirEntryDto[]> {
  const dirents = await readdir(dir, { withFileTypes: true });
  const out: DirEntryDto[] = [];
  for (const d of dirents) {
    if (!listableEntry(d.name)) continue;
    const full = path.join(dir, d.name);
    if (d.isDirectory()) {
      out.push({ name: d.name, path: full, kind: 'dir' });
    } else if (d.isFile()) {
      try {
        const s = await stat(full);
        out.push({ name: d.name, path: full, kind: 'file', size: s.size, mtimeMs: s.mtimeMs });
      } catch {
        out.push({ name: d.name, path: full, kind: 'file' });
      }
    }
    // Symlinks, sockets and the like are skipped: the browser imports files
    // and opens folders, and a link is neither until it is resolved.
  }
  return out;
}

const dirWatchers = new Map<number, DirWatcher>();

function dirWatcherFor(sender: WebContents): DirWatcher {
  const existing = dirWatchers.get(sender.id);
  if (existing) return existing;
  const w = new DirWatcher({
    watch: (dir, onEvent) => {
      try {
        // `persistent: false`: a watch never keeps the app alive on quit.
        const fw = fsWatch(dir, { persistent: false }, () => onEvent());
        fw.on('error', () => fw.close());
        return { close: () => fw.close() };
      } catch {
        return null;
      }
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    emit: (dirs) => {
      if (!sender.isDestroyed()) sender.send('fs:dirsChanged', dirs);
    },
  });
  dirWatchers.set(sender.id, w);
  const id = sender.id;
  sender.once('destroyed', () => {
    dirWatchers.get(id)?.dispose();
    dirWatchers.delete(id);
  });
  return w;
}

export function registerRevealIpc(): void {
  /** Show a file in Explorer / Finder. False when the path does not exist. */
  handle('shell:revealInFolder', (_e, filePath: string) => {
    if (typeof filePath !== 'string' || !filePath || !existsSync(filePath)) return false;
    shell.showItemInFolder(filePath);
    return true;
  });

  /** Native folder picker for the media browser's root. Null if cancelled. */
  handle('dialog:pickFolder', async () => {
    const res = await dialog.showOpenDialog({ ...rememberedDir('media'), properties: ['openDirectory'] });
    if (res.canceled) return null;
    rememberDir('media', res.filePaths[0], true);
    return res.filePaths[0] ?? null;
  });

  /**
   * Native FILE picker for the media browser — specific clips, not a folder.
   * Multi-select; the renderer imports each path through the same
   * `importMediaFile` the browser's rows use. Null if cancelled.
   */
  /** Files copied in the OS file manager, for Edit ▸ Paste (electron/clipboardFiles.ts). Read only. */
  handle('clipboard:readFiles', () => readClipboardFilePaths(clipboard));

  handle('dialog:pickFiles', async () => {
    // P7b: footage formats installed native plugins import (.ppm, …).
    const pluginExts = await pluginImportExtensions([path.join(app.getPath('userData'), 'native-plugins')]);
    const res = await dialog.showOpenDialog({
      ...rememberedDir('media'),
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Media', extensions: ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'mpg', 'mpeg', 'wmv', 'mxf', 'mts', 'm2ts',
          'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif', 'bmp', 'tif', 'tiff', 'exr', 'dpx', 'psd', 'psb', 'pdf', 'ai',
          'mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'aif', 'aiff', 'opus', ...pluginExts] },
        ...(pluginExts.length > 0 ? [{ name: 'Plugin formats', extensions: pluginExts }] : []),
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (res.canceled) return null;
    rememberDir('media', res.filePaths[0], false);
    return res.filePaths;
  });

  /** The Media Browser's on-screen folders; [] stops every watch of this window. */
  handle('fs:watchDirs', (e, dirs: unknown) => {
    const list = Array.isArray(dirs)
      ? dirs.filter((d): d is string => typeof d === 'string' && d.length > 0 && d.length < 32768 && path.isAbsolute(d)).slice(0, MAX_WATCHED_DIRS)
      : [];
    if (list.length === 0) {
      dirWatchers.get(e.sender.id)?.setDirs([]);
      return;
    }
    dirWatcherFor(e.sender).setDirs(list);
  });

  /** One level of a directory, hidden entries removed. Null if unreadable. */
  handle('fs:listDir', async (_e, dir: string) => {
    if (typeof dir !== 'string' || !dir) return null;
    try {
      return await listDirectory(dir);
    } catch {
      return null;
    }
  });
}
