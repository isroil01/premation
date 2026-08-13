/**
 * Creating a custom layer, through the real host and the real permission gate.
 *
 * The interesting assertions are the refusals. `scene.createLayer` is the first
 * plugin call whose argument names ANOTHER plugin's software, so it is the
 * first place a plugin can try to act as one. Every check here runs host-side
 * on the resolved string, because the argument crossed `postMessage` and is
 * untrusted text — a validator on the worker side would be a validator the
 * caller controls.
 */

import pluginHost from './PluginHost';
import { usePluginStore } from '@stores/pluginStore';
import { FakeWorker, useFakeWorkers, testPackage, bootPlugin } from './fakeWorker.testkit';
import { resetLayerKindsForTests, isCreatableKind, allLayerKinds } from './layerKindRegistry';
import { readCustomLayer } from './customLayers';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { seedDefaultScene } from '@core/scene/seedDefaultScene';
import { setCommandSystem, CommandSystem, getCommandSystem } from '@core/commands/CommandSystem';

const DEPTH_KIND = {
  id: 'depthImage',
  label: 'Depth Image',
  render: 'proxy',
  schemaVersion: 1,
  props: {
    focal: { type: 'number', default: 50, min: 0, max: 100, animatable: true },
    mode: { type: 'enum', values: ['parallax', 'displace'], default: 'parallax' },
  },
};

/** A package that declares one layer kind, at the API version that allows it. */
function kindPackage(id: string, kinds: unknown[] = [DEPTH_KIND]) {
  return testPackage(['scene:write'], id, {
    apiVersion: 3,
    name: id.split('.').pop()!,
    contributes: { layerKinds: kinds },
  });
}

beforeAll(async () => {
  useFakeWorkers();
  await usePluginStore.getState().hydrate();
  pluginHost.configure({ getSelection: () => [] });
  seedDefaultScene();
  // `runDocumentEdit` needs one — every plugin write goes through it, which is
  // the point: one undo entry per call, labelled with the plugin.
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
});
afterAll(() => { pluginHost.setWorkerFactory(null); });

beforeEach(() => {
  for (const p of [...usePluginStore.getState().plugins]) pluginHost.uninstall(p.manifest.id);
  resetLayerKindsForTests();
  FakeWorker.last = null;
});

/** Layer ids currently in the graph, so a creation can be seen. */
const customLayerIds = (): string[] =>
  defaultSceneGraph.getRoots()
    .map((r) => defaultSceneGraph.getNode(r.id))
    .filter((n) => !!n && !!readCustomLayer(n))
    .map((n) => n!.id);

describe('registration follows the plugin lifecycle', () => {
  it('registers declared kinds when the plugin is enabled, before its worker runs', () => {
    // Deliberately not on start. A declared kind has to be creatable before the
    // worker has ever booted, or every plugin that defines one must start at
    // launch just so its layer type appears — which is what activation events
    // exist to avoid.
    pluginHost.install(kindPackage('studio.acme.lab'), ['scene:write']);
    expect(isCreatableKind('studio.acme.lab.depthImage')).toBe(true);
  });

  it('unregisters them on uninstall', () => {
    pluginHost.install(kindPackage('studio.acme.lab'), ['scene:write']);
    pluginHost.uninstall('studio.acme.lab');
    expect(isCreatableKind('studio.acme.lab.depthImage')).toBe(false);
    expect(allLayerKinds()).toEqual([]);
  });

  it('unregisters them when the user disables the plugin', () => {
    pluginHost.install(kindPackage('studio.acme.lab'), ['scene:write']);
    pluginHost.setEnabled('studio.acme.lab', false);
    expect(isCreatableKind('studio.acme.lab.depthImage')).toBe(false);
  });
});

describe('scene.createLayer for a custom kind', () => {
  it('creates the layer with every declared prop at its default', () => {
    const w = bootPlugin(kindPackage('studio.acme.lab'), { granted: ['scene:write'] });
    const before = customLayerIds().length;

    w.callAndWait('scene.createLayer', { kind: 'studio.acme.lab.depthImage' });

    const ids = customLayerIds();
    expect(ids).toHaveLength(before + 1);
    const record = readCustomLayer(defaultSceneGraph.getNode(ids[ids.length - 1]!)!)!;
    expect(record).toMatchObject({
      pluginId: 'studio.acme.lab',
      kindId: 'depthImage',
      schemaVersion: 1,
      props: { focal: 50, mode: 'parallax' },
    });
  });

  it('validates the props HOST-side and refuses what the schema forbids', () => {
    const w = bootPlugin(kindPackage('studio.acme.lab'), { granted: ['scene:write'] });

    w.callAndWait('scene.createLayer', {
      kind: 'studio.acme.lab.depthImage',
      props: { focal: 500, mode: 'orbit', invented: true },
    });

    const ids = customLayerIds();
    const record = readCustomLayer(defaultSceneGraph.getNode(ids[ids.length - 1]!)!)!;
    // Out of range clamps — 500 on a 0–100 property meant the maximum.
    expect(record.props.focal).toBe(100);
    // A value outside the declared enum is refused, so the default stands.
    expect(record.props.mode).toBe('parallax');
    // A prop the kind never declared is not stored at all.
    expect(record.props.invented).toBeUndefined();
  });

  it('is ONE undo entry, labelled with the plugin name', () => {
    const w = bootPlugin(kindPackage('studio.acme.lab'), { granted: ['scene:write'] });
    const history = getCommandSystem().getHistory();
    const pushed: string[] = [];
    const realPush = history.push.bind(history);
    (history as unknown as { push: (c: { label: string }) => void }).push = (c) => {
      pushed.push(c.label);
      realPush(c as never);
    };

    w.callAndWait('scene.createLayer', { kind: 'studio.acme.lab.depthImage', name: 'Hero depth' });

    // ONE entry for the whole creation, not one per property written. And the
    // label names the plugin: a user reading their undo stack has to be able to
    // tell which plugin changed their document.
    expect(pushed).toEqual(['lab: create Hero depth']);
  });
});

describe("a plugin cannot act as another plugin", () => {
  it("refuses to create another plugin's kind, and says whose it is", () => {
    pluginHost.install(kindPackage('studio.other.tools'), ['scene:write']);
    const w = bootPlugin(kindPackage('studio.acme.lab'), { granted: ['scene:write'] });
    const before = customLayerIds().length;

    const result = w.callAndWait('scene.createLayer', { kind: 'studio.other.tools.depthImage' }) as
      { ok: boolean; error?: string };

    expect(customLayerIds()).toHaveLength(before);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/belongs to "studio\.other\.tools"/);
    expect(result.error).toMatch(/only create, change or observe its own layer kinds/);
  });

  it('logs the refusal, like any other refused call', () => {
    pluginHost.install(kindPackage('studio.other.tools'), ['scene:write']);
    const w = bootPlugin(kindPackage('studio.acme.lab'), { granted: ['scene:write'] });

    w.callAndWait('scene.createLayer', { kind: 'studio.other.tools.depthImage' });

    // Silence here presents to the author as "my createLayer does nothing".
    const log = pluginHost.log('studio.acme.lab').map((l) => l.text).join('\n');
    expect(log).toMatch(/createLayer|belongs to/i);
  });

  it('refuses a kind it declares but is no longer registered for', () => {
    const w = bootPlugin(kindPackage('studio.acme.lab'), { granted: ['scene:write'] });
    // Disabling unregisters the kinds; the worker in this test is still up,
    // which is exactly the window where a stale call could land.
    pluginHost.setEnabled('studio.acme.lab', false);
    const before = customLayerIds().length;

    w.callAndWait('scene.createLayer', { kind: 'studio.acme.lab.depthImage' });

    expect(customLayerIds()).toHaveLength(before);
  });

  it('refuses a bare native kind dressed up as a plugin kind', () => {
    const w = bootPlugin(kindPackage('studio.acme.lab'), { granted: ['scene:write'] });
    const result = w.callAndWait('scene.createLayer', { kind: 'studio.acme.lab.shape' }) as
      { error?: string };
    expect(result.error).toMatch(/does not declare a layer kind "shape"/);
  });
});

describe('activation on document open', () => {
  it('wakes a plugin whose kind appears in the document', () => {
    // `onLayerKind:<id>` is validated in the manifest and, until this, nothing
    // raised it — so a project full of custom layers would sit inert until the
    // user happened to run one of the plugin's commands.
    pluginHost.install(kindPackage('studio.acme.lab'), ['scene:write']);
    expect(pluginHost.info('studio.acme.lab').status).not.toBe('running');

    pluginHost.activateForDocument(['studio.acme.lab.depthImage']);
    FakeWorker.last!.emit({ k: 'ready' });
    FakeWorker.last!.emit({ k: 'activated' });

    expect(pluginHost.info('studio.acme.lab').status).toBe('running');
  });

  it('does not wake a plugin the user has disabled', () => {
    pluginHost.install(kindPackage('studio.acme.lab'), ['scene:write']);
    pluginHost.setEnabled('studio.acme.lab', false);
    FakeWorker.last = null;

    pluginHost.activateForDocument(['studio.acme.lab.depthImage']);

    // Opening a document is not consent to run software the user turned off.
    expect(FakeWorker.last).toBeNull();
  });

  it('ignores a kind whose plugin is not installed', () => {
    FakeWorker.last = null;
    pluginHost.activateForDocument(['studio.ghost.app.thing', 'shape', '']);
    expect(FakeWorker.last).toBeNull();
  });
});
