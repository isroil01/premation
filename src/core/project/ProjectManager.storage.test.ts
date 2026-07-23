/**
 * ProjectManager delegates persistence to its injected ProjectStorage, and the
 * DEFAULT (no storage dep) reproduces the legacy single-file write exactly — so
 * turning LOCAL_FIRST off is byte-for-byte the old behaviour.
 */

import { ProjectManager, type ProjectDocumentIO } from './ProjectManager';
import type { ProjectStorage } from '@core/persistence/ProjectStorage';
import type { VersionedDocument } from '@core/types';

const DOC = { version: '1.1.0', marker: 'captured' } as unknown as VersionedDocument;

const io: ProjectDocumentIO = {
  createEmpty: () => DOC,
  capture: () => DOC,
  restore: jest.fn(),
};

const recent = { add: jest.fn() } as never;
const logger = { info() {}, warn() {}, error() {} } as never;

describe('save/open route through storage', () => {
  it('saveAs hands the captured document to storage.save at the chosen path', async () => {
    const saved: Array<{ path: string; doc: VersionedDocument }> = [];
    const storage: ProjectStorage = {
      save: async (path, doc) => void saved.push({ path, doc }),
      load: async () => null,
    };
    const files = { chooseSavePath: async () => '/x/My.motion' } as never;

    const pm = new ProjectManager({ service: {} as never, files, recent, logger, io, storage });
    const ok = await pm.saveAs('My');

    expect(ok).toBe(true);
    expect(saved).toEqual([{ path: '/x/My.motion', doc: DOC }]);
  });

  it('openPath restores whatever storage.load returns', async () => {
    const restore = jest.fn();
    const storage: ProjectStorage = { save: async () => {}, load: async () => DOC };
    const pm = new ProjectManager({
      service: {} as never, files: {} as never, recent, logger,
      io: { ...io, restore }, storage,
    });

    const ref = await pm.openPath('/x/My.motion');
    expect(restore).toHaveBeenCalledWith(DOC);
    expect(ref?.path).toBe('/x/My.motion');
  });
});

describe('default storage (no storage dep) preserves single-file behaviour', () => {
  it('serializes through the service and writes via the file manager', async () => {
    const writes: Array<{ path: string; contents: string }> = [];
    const files = {
      chooseSavePath: async () => '/x/Legacy.motion',
      write: async (path: string, contents: string) => void writes.push({ path, contents }),
    } as never;
    const service = { serialize: (d: unknown) => JSON.stringify(d) } as never;

    const pm = new ProjectManager({ service, files, recent, logger, io });
    await pm.saveAs('Legacy');

    expect(writes).toEqual([{ path: '/x/Legacy.motion', contents: JSON.stringify(DOC) }]);
  });
});
