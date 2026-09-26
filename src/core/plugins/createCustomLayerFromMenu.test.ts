/**
 * Making the FIRST layer of a plugin-defined kind.
 *
 * The gap this closes made layer kinds unusable in practice, and the shape of
 * it is worth stating because it is not obvious: a custom layer is created BY
 * its plugin, and the plugin only wakes when a document CONTAINING one is
 * opened. So the first layer could never exist — the plugin needed it in order
 * to start, and it needed the plugin in order to be made.
 *
 * Only the host can break that, which is what this does.
 */

import pluginHost from './PluginHost';
import { usePluginStore } from '@stores/pluginStore';
import { useFakeWorkers, testPackage, FakeWorker } from './fakeWorker.testkit';
import { allLayerKinds, resetLayerKindsForTests } from './layerKindRegistry';
import { createCustomLayerFromMenu } from './createCustomLayerFromMenu';
import { readCustomLayer } from './customLayers';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useSelectionStore } from '@stores/selectionStore';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';

const PLUGIN = 'studio.acme.depth';
const KIND = {
  id: 'depthImage',
  label: 'Depth Image',
  render: 'proxy',
  schemaVersion: 1,
  props: {
    focal: { type: 'number', default: 50, min: 0, max: 100, animatable: true },
    mode: { type: 'enum', values: ['parallax', 'displace'], default: 'parallax' },
  },
};

/** Declares a kind and wakes ONLY on it — the case that used to be impossible. */
const pkg = (): ReturnType<typeof testPackage> =>
  testPackage([], PLUGIN, {
    apiVersion: 3,
    name: 'Depth',
    contributes: { layerKinds: [KIND] },
    activationEvents: ['onLayerKind:depthImage'],
  });

let h: Harness & { engine: LocalEngine };

beforeAll(async () => {
  useFakeWorkers();
  await usePluginStore.getState().hydrate();
  pluginHost.configure({ getSelection: () => [] });
});
afterAll(() => { pluginHost.setWorkerFactory(null); });

beforeEach(async () => {
  // B5: the insert is an engine `pasteLayers` — the app's engine, a fresh project.
  h = await setupAppEngine();
  for (const p of [...usePluginStore.getState().plugins]) pluginHost.uninstall(p.manifest.id);
  resetLayerKindsForTests();
  FakeWorker.last = null;
});
afterEach(async () => { await h.dispose(); });

describe('the menu lists what can be created', () => {
  it('offers an INACTIVE plugin s kinds', () => {
    // Kinds register on ENABLE, not on start. A menu that only listed running
    // plugins' kinds would reintroduce the gap: nothing would be listed until
    // something had already started the plugin.
    pluginHost.install(pkg(), []);
    expect(pluginHost.info(PLUGIN).status).not.toBe('running');
    expect(allLayerKinds().map((k) => k.kind.id)).toEqual(['depthImage']);
  });

  it('omits a DISABLED plugin s kinds', () => {
    // Consistent with `activateForDocument` refusing to wake software the user
    // turned off. Offering to create a layer that would immediately be inert is
    // an offer with nothing behind it.
    pluginHost.install(pkg(), []);
    pluginHost.setEnabled(PLUGIN, false);
    expect(allLayerKinds()).toEqual([]);
  });
});

describe('choosing one', () => {
  beforeEach(() => { pluginHost.install(pkg(), []); FakeWorker.last = null; });

  it('creates the layer with every declared prop at its default', async () => {
    const id = (await createCustomLayerFromMenu(`${PLUGIN}.depthImage`))!;
    const record = readCustomLayer(defaultSceneGraph.getNode(id)!)!;
    expect(record).toMatchObject({
      pluginId: PLUGIN,
      kindId: 'depthImage',
      schemaVersion: 1,
      props: { focal: 50, mode: 'parallax' },
    });
  });

  it('ACTIVATES the plugin, which is the whole point', async () => {
    // The plugin declares no `onStartup`. Before this, nothing could ever put
    // it in a state where it could produce its own output.
    await createCustomLayerFromMenu(`${PLUGIN}.depthImage`);
    expect(FakeWorker.last).not.toBeNull();

    FakeWorker.last!.emit({ k: 'ready' });
    FakeWorker.last!.emit({ k: 'activated' });
    expect(pluginHost.info(PLUGIN).status).toBe('running');
  });

  it('is one engine undo entry, named after the layer rather than the plugin', async () => {
    // The user chose "New Depth Image" from the Layer menu; that is what their
    // undo stack should say. The plugin's own regeneration is a separate entry.
    const before = h.doc();
    const id = (await createCustomLayerFromMenu(`${PLUGIN}.depthImage`))!;
    expect(historyLabels()).toEqual(['New Depth Image']);
    // Inside the active composition, and undone exactly.
    expect(defaultSceneGraph.getNode(id)!.parent).not.toBeNull();
    await h.run({ type: 'undo' });
    expect(h.doc()).toBe(before);
  });

  it('selects it, so the inspector shows what was just made', async () => {
    const id = (await createCustomLayerFromMenu(`${PLUGIN}.depthImage`))!;
    expect(useSelectionStore.getState().ids).toEqual([id]);
  });

  it('does nothing for a kind that is no longer registered', async () => {
    // The user disabled the plugin between the menu opening and the click. A
    // no-op, not an error: nothing has gone wrong from their point of view.
    pluginHost.setEnabled(PLUGIN, false);
    expect(await createCustomLayerFromMenu(`${PLUGIN}.depthImage`)).toBeNull();
  });
});
