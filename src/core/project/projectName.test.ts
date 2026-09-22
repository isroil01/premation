/**
 * A project is named after its FILE, not its path.
 *
 * WHY THIS EXISTS. `openPath` named a project `path.replace(ext, '')`, so a
 * project opened from disk was titled "C:/Users/…/files/qa1" in the title bar
 * and recorded in the recent list under that — while Save, which had its own
 * (correct) derivation, called the same project "qa1".
 */

import { displayProjectName, looksLikeFilePath, projectNameFromFilePath } from './projectName';
import { ProjectManager, type ProjectDocumentIO } from './ProjectManager';
import { RecentProjects, type RecentProjectEntry } from './RecentProjects';
import type { VersionedDocument } from '@core/types';

describe('projectNameFromFilePath', () => {
  it('is the base name without the project extension, on either slash style', () => {
    expect(projectNameFromFilePath('C:/Users/me/files/qa1.motion')).toBe('qa1');
    expect(projectNameFromFilePath('C:\\Users\\me\\files\\qa1.json')).toBe('qa1');
    expect(projectNameFromFilePath('/home/u/Title Sequence.MOTION')).toBe('Title Sequence');
  });

  it('handles the `.motion` DIRECTORY bundle, with or without a trailing separator', () => {
    expect(projectNameFromFilePath('D:\\work\\Promo.motion\\')).toBe('Promo');
    expect(projectNameFromFilePath('/work/Promo.motion/')).toBe('Promo');
  });

  it('strips only a PROJECT extension — "v1.2" is a version, not an extension', () => {
    expect(projectNameFromFilePath('/work/Logo v1.2.motion')).toBe('Logo v1.2');
    expect(projectNameFromFilePath('/work/Logo v1.2')).toBe('Logo v1.2');
  });

  it('never returns an empty title', () => {
    expect(projectNameFromFilePath('/', 'Untitled')).toBe('Untitled');
    expect(projectNameFromFilePath('/x/.motion', 'Untitled')).toBe('Untitled');
  });

  it('leaves a bare id alone — the cloud route opens by backend id', () => {
    expect(projectNameFromFilePath('clx7a9b2c0000')).toBe('clx7a9b2c0000');
  });
});

describe('displayProjectName', () => {
  it('repairs a name that was stored as a path, and only that', () => {
    expect(looksLikeFilePath('C:/Users/me/files/qa1')).toBe(true);
    expect(displayProjectName('C:/Users/me/files/qa1')).toBe('qa1');
    expect(displayProjectName('Promo v2')).toBe('Promo v2');
  });
});

describe('ProjectManager.openPath', () => {
  const DOC = { version: '1.1.0' } as VersionedDocument;
  const io: ProjectDocumentIO = { createEmpty: () => DOC, capture: () => DOC, restore: () => {} };

  it('names the project after the file, and records THAT in the recent list', async () => {
    const add = jest.fn();
    const pm = new ProjectManager({
      service: {} as never,
      files: {} as never,
      recent: { add } as never,
      logger: { info() {}, warn() {}, error() {} } as never,
      io,
      storage: { save: async () => {}, load: async () => DOC },
    });
    const ref = await pm.openPath('C:/Users/me/files/qa1.motion');
    expect(ref?.name).toBe('qa1');
    expect(ref?.path).toBe('C:/Users/me/files/qa1.motion');
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ name: 'qa1' }));
  });
});

describe('RecentProjects', () => {
  /** The smallest SettingsManager that can hold one key. */
  function settingsWith(initial: RecentProjectEntry[]) {
    let value = initial;
    const observers = new Set<(v: RecentProjectEntry[]) => void>();
    return {
      get: () => value,
      set: (_k: string, v: RecentProjectEntry[]) => {
        value = v;
        for (const o of observers) o(v);
      },
      observe: (_k: string, fn: (v: RecentProjectEntry[]) => void) => {
        observers.add(fn);
        return () => observers.delete(fn);
      },
    };
  }

  it('repairs entries an older build stored under their full path', () => {
    const recent = new RecentProjects(
      settingsWith([
        { id: 'a', name: 'C:/Users/me/files/qa1', path: 'C:/Users/me/files/qa1.motion', openedAt: 2 },
        { id: 'b', name: 'Promo', path: '/x/Promo.motion', openedAt: 1 },
      ]) as never,
    );
    expect(recent.list().map((e) => e.name)).toEqual(['qa1', 'Promo']);
  });

  it('hands subscribers the repaired list too, and persists it on the next add', () => {
    const settings = settingsWith([
      { id: 'a', name: 'C:\\files\\qa1', path: 'C:\\files\\qa1.motion', openedAt: 1 },
    ]);
    const recent = new RecentProjects(settings as never);
    const seen: string[][] = [];
    recent.subscribe((list) => seen.push(list.map((e) => e.name)));
    recent.add({ id: 'c', name: 'New', path: '/x/New.motion', openedAt: 3 });
    expect(seen.at(-1)).toEqual(['New', 'qa1']);
    expect(settings.get().map((e) => e.name)).toEqual(['New', 'qa1']);
  });
});
