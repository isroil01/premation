/**
 * The folder a file dialog opens in, remembered per purpose.
 *
 * Electron 43 changed what an open/save dialog does when it is given no
 * `defaultPath`: it now passes the user's Downloads folder explicitly, and the
 * OS no longer restores the folder the user was last in (breaking-changes.md,
 * "Dialog methods default to Downloads directory"). On Electron 32 every
 * dialog below opened where the user had last been; after the upgrade each one
 * opened in Downloads, every time. That is a real regression for an editor
 * whose projects and footage live in a handful of working folders.
 *
 * So the app remembers instead: one folder per purpose, updated from what the
 * user actually picked, kept in `<userData>/dialog-dirs.json` so it survives a
 * restart the way the OS's own memory did. Only dialogs that had no
 * `defaultPath` use this — a dialog given a bare file name ("Untitled.mp4")
 * still gets the OS's per-app memory, because a relative `defaultPath` is not
 * turned into a folder by Electron.
 *
 * Best-effort throughout: a missing or corrupt file, or a folder that has since
 * been deleted, simply means the dialog opens in Electron's default.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './atomicWrite';

/**
 * What a dialog is for. Each remembers its own folder.
 *
 * The publisher signing-key picker (pluginPublish.ts) is deliberately absent:
 * that flow promises the app keeps nothing about the key, and where the key
 * file lives is part of "nothing".
 */
export type DialogDirKind = 'project' | 'media' | 'outputFolder';

const KINDS: readonly DialogDirKind[] = ['project', 'media', 'outputFolder'];

/** Parse the state file's JSON; anything malformed is dropped, not repaired. */
export function parseDialogDirs(text: string): Partial<Record<DialogDirKind, string>> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'object') return {};
  const out: Partial<Record<DialogDirKind, string>> = {};
  for (const kind of KINDS) {
    const v = (raw as Record<string, unknown>)[kind];
    if (typeof v === 'string' && v.length > 0 && v.length < 4096 && path.isAbsolute(v)) out[kind] = v;
  }
  return out;
}

/**
 * The folder to remember for a dialog result: the picked folder itself, or the
 * folder that holds the picked file.
 */
export function folderOfPick(picked: string, pickedIsFolder: boolean): string {
  return pickedIsFolder ? picked : path.dirname(picked);
}

let stateFile: string | null = null;
let dirs: Partial<Record<DialogDirKind, string>> = {};

/** Point the memory at its file and load it. Called once from main at startup. */
export function initDialogDirs(file: string): void {
  stateFile = file;
  try {
    dirs = parseDialogDirs(readFileSync(file, 'utf8'));
  } catch {
    dirs = {};
  }
}

function isFolder(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Dialog options carrying the remembered folder for `kind`, or nothing when
 * there is none (the dialog then opens in Electron's default, as before).
 */
export function rememberedDir(kind: DialogDirKind): { defaultPath?: string } {
  const dir = dirs[kind];
  return dir && existsSync(dir) && isFolder(dir) ? { defaultPath: dir } : {};
}

/** Remember where a dialog ended up. A cancelled dialog passes nothing. */
export function rememberDir(kind: DialogDirKind, picked: string | undefined, pickedIsFolder: boolean): void {
  if (!picked || !path.isAbsolute(picked)) return;
  const dir = folderOfPick(picked, pickedIsFolder);
  if (dirs[kind] === dir) return;
  dirs = { ...dirs, [kind]: dir };
  if (!stateFile) return;
  void writeFileAtomic(stateFile, JSON.stringify(dirs, null, 2)).catch(() => {
    /* best-effort: the folder is still remembered for this session */
  });
}
