/**
 * What a save actually did, and what the project is called afterwards.
 *
 * WHY THIS EXISTS. `save`/`saveAs` returned a bare boolean, and `false` meant
 * three unrelated things — no project open, the user cancelled, the write threw.
 * The command layer collapsed all three into a SUCCESS toast and then cleared
 * the dirty flag and DELETED the crash-recovery snapshot, so the user was told
 * their work was safe at the moment it stopped being anywhere. These pin the
 * three outcomes apart at the source, where the distinction actually exists.
 *
 * The naming cases are the other half: `saveAs` kept the name it was ASKED for
 * and ignored the file the user chose, so a project saved to `Promo.motion`
 * stayed "Untitled" in the recent list, in the discard prompt, and in the next
 * Increment and Save.
 */

import { ProjectManager, type ProjectDocumentIO } from './ProjectManager';
import type { ProjectStorage } from '@core/persistence/ProjectStorage';
import type { VersionedDocument } from '@core/types';

const DOC = { version: '1.1.0' } as VersionedDocument;

const io: ProjectDocumentIO = {
  createEmpty: () => DOC,
  capture: () => DOC,
  restore: () => {},
};

const logger = { info() {}, warn() {}, error() {} } as never;
const okStorage: ProjectStorage = { save: async () => {}, load: async () => null };

function makeRecent(): { add: jest.Mock; entries: Array<{ id: string; name: string; path: string | null }> } {
  const entries: Array<{ id: string; name: string; path: string | null }> = [];
  const add = jest.fn((e: { id: string; name: string; path: string | null }) => void entries.push(e));
  return { add, entries };
}

function makePm(opts: {
  chooseSavePath?: () => Promise<string | null>;
  storage?: ProjectStorage;
  recent?: { add: jest.Mock };
}): ProjectManager {
  const files = { chooseSavePath: opts.chooseSavePath ?? (async () => '/x/My.motion') } as never;
  return new ProjectManager({
    service: {} as never,
    files,
    recent: (opts.recent ?? makeRecent()) as never,
    logger,
    io,
    storage: opts.storage ?? okStorage,
  });
}

describe('save outcomes are distinguishable', () => {
  it('reports `cancelled` when the user dismisses the save dialog', async () => {
    const pm = makePm({ chooseSavePath: async () => null });
    expect((await pm.saveAs('My')).status).toBe('cancelled');
  });

  it('reports `failed` — NOT cancelled — when the write throws', async () => {
    // The distinction the boolean could not carry. A cancel must never clear
    // the recovery snapshot, and neither must a failure; but only a failure
    // should raise an error.
    const boom = new Error('disk full');
    const storage: ProjectStorage = { save: async () => { throw boom; }, load: async () => null };
    const outcome = await makePm({ storage }).saveAs('My');

    expect(outcome.status).toBe('failed');
    expect(outcome).toMatchObject({ error: boom });
  });

  it('saves rather than silently doing nothing when NO project is open', async () => {
    // The headline bug: `save()` with `current === null` returned false without
    // touching the disk, and the caller announced "Saved". In the local edition
    // that is the state at boot until the user creates or opens something, so
    // Ctrl+S over an unsaved scene reported success and wrote nothing.
    const saved: string[] = [];
    const storage: ProjectStorage = { save: async (p) => void saved.push(p), load: async () => null };
    const pm = makePm({ storage });

    const outcome = await pm.save();

    expect(outcome.status).toBe('saved');
    expect(saved).toEqual(['/x/My.motion']);
  });
});

describe('the project takes the name of the file that was chosen', () => {
  it('renames to the chosen file, not the suggested name', async () => {
    const pm = makePm({ chooseSavePath: async () => 'D:\\work\\Promo v2.motion' });
    await pm.saveAs('Untitled');
    expect(pm.getState().current?.name).toBe('Promo v2');
  });

  it('handles posix paths and the .json extension', async () => {
    const pm = makePm({ chooseSavePath: async () => '/home/a/Hero.json' });
    await pm.saveAs('Untitled');
    expect(pm.getState().current?.name).toBe('Hero');
  });

  it('keeps the requested name when the "path" is a cloud project id', async () => {
    // The cloud adapter's chooseSavePath returns a BACKEND ID, not a file path.
    // Deriving a name from it would rename the project to a uuid.
    const pm = makePm({ chooseSavePath: async () => 'clx7a9b2c0000' });
    await pm.saveAs('Launch film');
    expect(pm.getState().current?.name).toBe('Launch film');
  });
});

describe('Save As forks the document', () => {
  it('takes a NEW id, so the MRU cannot mistake the copy for the original', async () => {
    // RecentProjects dedupes by id. Reusing the ref's id meant "Save As" made
    // the copy overwrite the source project's row — the original vanished from
    // the start screen while still sitting on disk.
    const recent = makeRecent();
    const pm = makePm({ chooseSavePath: async () => '/x/Original.motion', recent });
    await pm.saveAs('Original');
    const firstId = pm.getState().current?.id;

    (pm as unknown as { deps: { files: { chooseSavePath: () => Promise<string> } } }).deps.files
      .chooseSavePath = async () => '/x/Copy.motion';
    await pm.saveAs('Copy');

    expect(pm.getState().current?.id).not.toBe(firstId);
    expect(recent.entries.map((e) => e.path)).toEqual(['/x/Original.motion', '/x/Copy.motion']);
  });
});
