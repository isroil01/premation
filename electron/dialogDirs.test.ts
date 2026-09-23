/**
 * Electron 43 made a dialog with no `defaultPath` open in Downloads and stopped
 * the OS from restoring the last folder. dialogDirs is the app's replacement
 * memory; these pin that it remembers, survives a restart, and degrades to
 * "no defaultPath" (Electron's own default) rather than to a broken path.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { folderOfPick, initDialogDirs, parseDialogDirs, rememberDir, rememberedDir } from './dialogDirs';

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 50));

describe('dialogDirs', () => {
  let root: string;
  let stateFile: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'dialogdirs-'));
    stateFile = path.join(root, 'dialog-dirs.json');
    initDialogDirs(stateFile);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('passes no defaultPath before anything was picked', () => {
    expect(rememberedDir('project')).toEqual({});
  });

  it('remembers the folder holding a picked file, and a picked folder itself', () => {
    const footage = path.join(root, 'footage');
    mkdirSync(footage);
    rememberDir('media', path.join(footage, 'clip.mp4'), false);
    expect(rememberedDir('media')).toEqual({ defaultPath: footage });
    rememberDir('outputFolder', footage, true);
    expect(rememberedDir('outputFolder')).toEqual({ defaultPath: footage });
    // Kinds are independent.
    expect(rememberedDir('project')).toEqual({});
  });

  it('survives a restart through the state file', async () => {
    const projects = path.join(root, 'projects');
    mkdirSync(projects);
    rememberDir('project', path.join(projects, 'a.motion'), false);
    await flush();
    expect(JSON.parse(readFileSync(stateFile, 'utf8'))).toEqual({ project: projects });
    initDialogDirs(stateFile);
    expect(rememberedDir('project')).toEqual({ defaultPath: projects });
  });

  it('forgets a folder that no longer exists instead of handing it to the dialog', () => {
    const gone = path.join(root, 'gone');
    mkdirSync(gone);
    rememberDir('media', gone, true);
    rmSync(gone, { recursive: true });
    expect(rememberedDir('media')).toEqual({});
  });

  it('ignores a cancelled dialog and relative paths', () => {
    rememberDir('media', undefined, true);
    rememberDir('media', 'relative/clip.mp4', false);
    expect(rememberedDir('media')).toEqual({});
  });

  it('drops a corrupt or hostile state file rather than repairing it', () => {
    writeFileSync(stateFile, '{not json');
    initDialogDirs(stateFile);
    expect(rememberedDir('project')).toEqual({});
    expect(parseDialogDirs(JSON.stringify({ project: 'relative', media: 7, bogus: root }))).toEqual({});
  });

  it('folderOfPick', () => {
    expect(folderOfPick(path.join(root, 'x', 'y.mp4'), false)).toBe(path.join(root, 'x'));
    expect(folderOfPick(path.join(root, 'x'), true)).toBe(path.join(root, 'x'));
  });
});
