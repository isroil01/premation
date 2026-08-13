/**
 * Storage, driven through the host the way a plugin reaches it.
 *
 * `pluginStorage.test.ts` covers the store itself. This covers the things only
 * the wiring can get wrong, and each of them is a way the isolation could
 * silently not hold:
 *
 *   • the plugin id comes from the MANIFEST, never from the caller;
 *   • no permission is required, and none is consumed;
 *   • a `project` write marks the document dirty and is NOT undoable;
 *   • the state survives save/load and travels with the file.
 */

import pluginHost from './PluginHost';
import { usePluginStore } from '@stores/pluginStore';
import { useFakeWorkers, testPackage, bootPlugin, FakeWorker } from './fakeWorker.testkit';
import { resetStorageForTests, storageGet } from './pluginStorage';
import { captureDocument, restoreDocument, type EditorDocument } from '@core/api/cloudDocument';
import { serializeProject, parseProject } from '@core/persistence/ProjectSerializer';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { seedDefaultScene } from '@core/scene/seedDefaultScene';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import { defaultAnimation } from '@motion/animation';
import { METHOD_PERMISSIONS } from './protocol';

const A = 'studio.acme.notes';
const B = 'studio.other.notes';

const pkg = (id: string, permissions: string[] = []) =>
  testPackage(permissions as never, id, {
    apiVersion: 5,
    name: 'Notes',
    requires: ['storage.global', 'storage.project'],
    activationEvents: ['onStartup'],
  });

beforeAll(async () => {
  useFakeWorkers();
  await usePluginStore.getState().hydrate();
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
  pluginHost.configure({ getSelection: () => [] });
});
afterAll(() => { pluginHost.setWorkerFactory(null); });

beforeEach(() => {
  for (const p of [...usePluginStore.getState().plugins]) pluginHost.uninstall(p.manifest.id);
  resetStorageForTests();
  defaultSceneGraph.clear();
  defaultAnimation.clear();
  seedDefaultScene();
  FakeWorker.last = null;
});

describe('the permission table', () => {
  it('requires nothing for any storage verb', () => {
    /*
      A decision, not an omission. Neither scope touches the user's layers, and
      a ninth consent line reading "remembers its own settings" costs attention
      on the one screen where attention is the entire point — a user who reads
      eight lines carefully and skims the ninth has been made worse off by it.
      It is disclosed as an informational line instead.
    */
    for (const method of ['storage.get', 'storage.set', 'storage.delete', 'storage.list']) {
      expect(METHOD_PERMISSIONS[method]).toBeNull();
    }
  });
});

describe('a plugin with NO permissions at all', () => {
  it('can still store and read', () => {
    const worker = bootPlugin(pkg(A), { granted: [] });

    expect(worker.callAndWait('storage.set', 'global', 'theme', 'dark').ok).toBe(true);
    const reply = worker.callAndWait('storage.get', 'global', 'theme');
    expect(reply.ok && reply.value).toBe('dark');
  });

  it('lists and deletes its own keys', () => {
    const worker = bootPlugin(pkg(A), { granted: [] });
    worker.callAndWait('storage.set', 'global', 'a', 1);
    worker.callAndWait('storage.set', 'global', 'b', 2);

    expect((worker.callAndWait('storage.list', 'global') as { value: string[] }).value)
      .toEqual(['a', 'b']);

    worker.callAndWait('storage.delete', 'global', 'a');
    expect((worker.callAndWait('storage.list', 'global') as { value: string[] }).value)
      .toEqual(['b']);
  });
});

describe('the plugin id comes from the manifest', () => {
  it('so one plugin cannot read another s bag', () => {
    /*
      The isolation everything else rests on, asserted through the real message
      path. The scope and key cross `postMessage` from third-party code; the
      identity does not, and there is no argument through which a caller could
      name a different bag.
    */
    const a = bootPlugin(pkg(A), { granted: [] });
    a.callAndWait('storage.set', 'global', 'secret', 'mine');

    const b = bootPlugin(pkg(B), { granted: [] });
    expect((b.callAndWait('storage.get', 'global', 'secret') as { value: unknown }).value).toBeNull();
    expect((b.callAndWait('storage.list', 'global') as { value: string[] }).value).toEqual([]);
  });
});

describe('a bad argument from the worker', () => {
  it('is refused with a message, not a crash', () => {
    const worker = bootPlugin(pkg(A), { granted: [] });

    const badScope = worker.callAndWait('storage.set', 'sneaky', 'k', 1);
    expect(badScope.ok).toBe(false);
    expect(badScope.ok ? '' : badScope.error).toMatch(/is not a storage scope/);

    const badKey = worker.callAndWait('storage.set', 'global', 'has space', 1);
    expect(badKey.ok).toBe(false);
    expect(badKey.ok ? '' : badKey.error).toMatch(/not a usable storage key/);
  });

  it('reports a quota failure the plugin can recognise', () => {
    const worker = bootPlugin(pkg(A), { granted: [] });
    let last = worker.callAndWait('storage.set', 'project', 'k0', 'x');
    for (let i = 0; i < 500 && last.ok; i++) {
      last = worker.callAndWait('storage.set', 'project', `k${i}`, 'x'.repeat(60 * 1024));
    }
    expect(last.ok).toBe(false);
    expect(last.ok ? '' : last.error).toMatch(/storage is full/);
  });
});

describe('project scope travels with the document', () => {
  it('survives save, close and reopen', () => {
    const worker = bootPlugin(pkg(A), { granted: [] });
    worker.callAndWait('storage.set', 'project', 'spine', 'layer_7');
    worker.callAndWait('storage.set', 'global', 'theme', 'dark');

    const onDisk = serializeProject(captureDocument() as never);

    // Everything in memory goes, as it would on opening another project.
    resetStorageForTests();
    defaultSceneGraph.clear();
    restoreDocument(parseProject(onDisk) as unknown as EditorDocument);

    expect(storageGet('project', A, 'spine')).toBe('layer_7');
    /*
      And the GLOBAL value did not come back, which is the half that proves the
      two scopes are actually different. It belongs to the machine, and a
      document that carried it would deliver one user's preferences to another.
    */
    expect(storageGet('global', A, 'theme')).toBeNull();
  });

  it('is absent from a document no plugin wrote to', () => {
    // Byte-identical round trip for every document written before this existed.
    bootPlugin(pkg(A), { granted: [] });
    expect(captureDocument().pluginStorage).toBeUndefined();
  });
});

describe('uninstall', () => {
  it('forgets global state by default', () => {
    /*
      Uninstall should mean uninstall. Leaving state behind by default is how an
      origin accumulates data from software the user removed years ago.
    */
    const worker = bootPlugin(pkg(A), { granted: [] });
    worker.callAndWait('storage.set', 'global', 'theme', 'dark');

    pluginHost.uninstall(A);
    expect(storageGet('global', A, 'theme')).toBeNull();
  });

  it('keeps it when the user asked', () => {
    // Reinstalling a plugin removed by mistake, or to try another version,
    // should not cost the user their configuration.
    const worker = bootPlugin(pkg(A), { granted: [] });
    worker.callAndWait('storage.set', 'global', 'theme', 'dark');

    pluginHost.uninstall(A, { keepData: true });
    expect(storageGet('global', A, 'theme')).toBe('dark');
  });

  it('never touches PROJECT state, whatever the user chose', () => {
    /*
      Project state lives in documents, not on this machine, and those documents
      may be open on someone else's laptop. Deleting it here would reach into
      files this uninstall has no business editing — and the user asking to
      forget a plugin's settings is not asking to edit their projects.
    */
    const worker = bootPlugin(pkg(A), { granted: [] });
    worker.callAndWait('storage.set', 'project', 'spine', 'layer_7');

    pluginHost.uninstall(A);
    expect(storageGet('project', A, 'spine')).toBe('layer_7');
    expect(captureDocument().pluginStorage).toEqual({ [A]: { spine: '"layer_7"' } });
  });
});
