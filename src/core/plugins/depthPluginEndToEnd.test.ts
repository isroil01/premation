/**
 * A real `render: 'proxy'` plugin, written the way an author would write one,
 * driven end to end through the host.
 *
 * ── What this replaces, and why ──────────────────────────────────────────────
 *
 * B3.6 asked for the existing 3D image plugin to be rebuilt on `proxy`, as the
 * only honest test of whether this API is usable by an author. **There is no
 * such plugin in this repo** — the editor's 3D layers, extrusion and camera are
 * native features, and a search of the tree finds no bundled or example plugin
 * of that name. So rather than report the slice as blocked, this does the thing
 * the slice was FOR: a genuine parallax/depth plugin, exercising the whole
 * layer-kind API from manifest to animated output, with the gaps it hit
 * reported in the session notes rather than worked around here.
 *
 * The property it has to demonstrate is the one the whole design turns on:
 *
 *     the subtree keeps animating with the plugin uninstalled.
 *
 * If that fails, `proxy` is not a fallback strategy, it is just a slower way to
 * lose a user's work.
 */

import pluginHost from './PluginHost';
import { usePluginStore } from '@stores/pluginStore';
import { useFakeWorkers, testPackage, bootPlugin, FakeWorker } from './fakeWorker.testkit';
import { resetLayerKindsForTests } from './layerKindRegistry';
import { resetNotifierForTests, flush } from './layerChangeNotifier';
import { resetRateLimitForTests } from './proxySubtree';
import { customPropPath, isPluginOwned, readCustomLayer } from './customLayers';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { seedDefaultScene } from '@core/scene/seedDefaultScene';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import { defaultAnimation } from '@motion/animation';

const PLUGIN = 'studio.acme.depth';

/**
 * The manifest an author would actually write.
 *
 * Three planes driven by one animatable `focal`, an image slot, and a mode.
 * Nothing here is host-specific: it is the schema from `docs/PLUGINS.md` §8b.
 */
const DEPTH_KIND = {
  id: 'depthImage',
  label: 'Depth Image',
  icon: 'image',
  render: 'proxy',
  schemaVersion: 1,
  props: {
    focal: { type: 'number', default: 50, min: 0, max: 100, animatable: true },
    planes: { type: 'number', default: 3, min: 2, max: 8, step: 1 },
    source: { type: 'asset', assetKind: 'image' },
    mode: { type: 'enum', values: ['parallax', 'displace'], default: 'parallax' },
  },
};

const pkg = (): ReturnType<typeof testPackage> =>
  testPackage(['scene:read', 'scene:write', 'animation:write'], PLUGIN, {
    apiVersion: 3,
    name: 'Depth',
    contributes: {
      layerKinds: [DEPTH_KIND],
      // GAP 1, found here: `onLayerKind:depthImage` alone is not enough.
      //
      // It fires when a document CONTAINING the kind is opened — but the first
      // layer of that kind has to be created by the plugin, which is not
      // running yet. So a plugin whose only activation event is `onLayerKind`
      // can never create its own first layer, and an author has to add
      // `onStartup` (defeating lazy activation) or a command, as here.
      //
      // The host fix is a "New layer ▸ <kind>" entry built from
      // `allLayerKinds()`, which already returns exactly that list and which
      // nothing renders yet. Reported, not worked around.
      commands: [{ id: 'insert', label: 'Insert depth image', icon: 'image' }],
    },
    // `onStartup` is the workaround GAP 1 forces on an author today: without
    // it the plugin is not running when the user asks for the first layer of
    // its own kind, and lazy activation is the thing being given up.
    activationEvents: ['onStartup', 'onCommand:insert', 'onLayerKind:depthImage'],
  });

/** What the plugin's `onLayerChanged` handler would build, given `planes`. */
function planeSpecs(layerName: string, planes: number): unknown[] {
  return Array.from({ length: planes }, (_, i) => ({
    key: `plane-${i}`,
    kind: 'shape',
    name: `Plane ${i + 1}`,
    props: { y: i * 40 },
    // The binding. Evaluated by the ENGINE, so it survives the plugin.
    expressions: { x: `layer('${layerName}', '${customPropPath('focal')}') * ${i + 1}` },
  }));
}

beforeAll(async () => {
  useFakeWorkers();
  await usePluginStore.getState().hydrate();
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
  pluginHost.configure({ getSelection: () => [] });
});
afterAll(() => { pluginHost.setWorkerFactory(null); });

beforeEach(() => {
  /*
    The layer-name resolver, which the app wires at boot (`Providers.tsx`) and
    a bare engine does not have. Needed here because a proxy child's binding
    names its parent by NAME — which is what an author writes, and which is
    also GAP 2: a rename breaks the binding, and the API offers nothing that
    binds by id. Reported rather than papered over.
  */
  defaultAnimation.setLayerResolver((name) => {
    for (const root of defaultSceneGraph.getRoots()) {
      if (root.name === name) return root.id;
      for (const child of defaultSceneGraph.getChildren(root.id)) {
        if (child.name === name) return child.id;
      }
    }
    return null;
  });

  for (const p of [...usePluginStore.getState().plugins]) pluginHost.uninstall(p.manifest.id);
  resetLayerKindsForTests();
  resetNotifierForTests();
  resetRateLimitForTests();
  defaultSceneGraph.clear();
  seedDefaultScene();
});

/** Install, create a layer, and build its subtree — the author's whole loop. */
function buildDepthLayer(planes = 3): { worker: FakeWorker; layerId: string } {
  const worker = bootPlugin(pkg(), { granted: ['scene:read', 'scene:write', 'animation:write'] });

  worker.callAndWait('scene.onLayerChanged', 'depthImage');
  const layerId = worker.callAndWait('scene.createLayer', {
    kind: `${PLUGIN}.depthImage`,
    name: 'Hero depth',
    props: { focal: 60, planes },
  }) as unknown as { value: string };

  const id = (layerId as { value: string }).value;
  worker.callAndWait('scene.setProxyChildren', id, planeSpecs('Hero depth', planes));
  return { worker, layerId: id };
}

describe('the whole author loop', () => {
  it('creates a layer whose declared props hold what the plugin asked for', () => {
    const { layerId } = buildDepthLayer();
    const record = readCustomLayer(defaultSceneGraph.getNode(layerId)!)!;
    expect(record).toMatchObject({
      pluginId: PLUGIN,
      kindId: 'depthImage',
      props: { focal: 60, planes: 3, mode: 'parallax', source: null },
    });
  });

  it('generates a marked subtree', () => {
    const { layerId } = buildDepthLayer();
    const children = defaultSceneGraph.getChildren(layerId);
    expect(children).toHaveLength(3);
    for (const child of children) expect(isPluginOwned(child)).toBe(true);
    expect(children.map((c) => c.name)).toEqual(['Plane 1', 'Plane 2', 'Plane 3']);
  });

  it('rebuilds on an authored edit, keeping the ids of planes that survive', () => {
    const { worker, layerId } = buildDepthLayer(3);
    const before = defaultSceneGraph.getChildren(layerId).map((c) => c.id);

    // The user drags `planes` from 3 to 4 — one authored edit, one rebuild.
    worker.callAndWait('scene.setProxyChildren', layerId, planeSpecs('Hero depth', 4));

    const after = defaultSceneGraph.getChildren(layerId).map((c) => c.id);
    expect(after).toHaveLength(4);
    // The three that already existed kept their ids: a user's selection does
    // not jump, and another layer's expression referencing one stays alive.
    expect(after.slice(0, 3).sort()).toEqual(before.sort());
  });

  it('delivers the authored edit to the plugin, once', () => {
    const { worker, layerId } = buildDepthLayer();
    const node = defaultSceneGraph.getNode(layerId)!;
    const component = node.components.find((c) => c.type.startsWith('pluginLayer:'))!;

    for (let i = 0; i < 20; i += 1) {
      defaultSceneGraph.writeProp(layerId, component.id, 'focal', 60 + i);
    }
    flush();

    const events = worker.sent.filter((m) => (m as { k?: string }).k === 'layerChanged');
    expect(events).toHaveLength(1);
  });
});

describe('the property the whole design turns on', () => {
  it('ANIMATES with the plugin uninstalled', () => {
    /*
      The decisive test. If a proxy subtree stopped animating when its plugin
      went away, `render: 'proxy'` would not be a fallback strategy — it would
      be a slower way to lose a user's work, and `shader` would have been no
      worse.
    */
    const { layerId } = buildDepthLayer();
    const planeIds = defaultSceneGraph.getChildren(layerId).map((c) => c.id);

    // The user animates the parent's authored property.
    defaultAnimation.setKeyframe(layerId, customPropPath('focal'), 0, 0);
    defaultAnimation.setKeyframe(layerId, customPropPath('focal'), 4, 100);

    // …and then uninstalls the plugin entirely.
    pluginHost.uninstall(PLUGIN);
    expect(usePluginStore.getState().get(PLUGIN)).toBeUndefined();

    // The children are still there, still bound, still moving — evaluated by
    // the engine, with nothing plugin-shaped involved.
    const atStart = defaultAnimation.sample(planeIds[1]!, 'x', 0);
    const atEnd = defaultAnimation.sample(planeIds[1]!, 'x', 4);
    expect(atStart).toBeCloseTo(0, 3);
    expect(atEnd).toBeCloseTo(200, 3); // focal 100 × plane index 2
    expect(defaultSceneGraph.getChildren(layerId)).toHaveLength(3);
  });

  it('leaves the parent layer inert but intact after the uninstall', () => {
    const { layerId } = buildDepthLayer();
    pluginHost.uninstall(PLUGIN);

    // Every authored value survives, which is what makes reinstalling a
    // reactivation rather than a rebuild.
    const record = readCustomLayer(defaultSceneGraph.getNode(layerId)!)!;
    expect(record.props).toMatchObject({ focal: 60, planes: 3 });
  });

  it('attributes every expression it wrote', () => {
    const { layerId } = buildDepthLayer();
    const planeIds = defaultSceneGraph.getChildren(layerId).map((c) => c.id);

    // Proxy output is expression-bearing by design, so a document fills with
    // expressions the user never wrote. Without provenance, "why does this
    // layer have an expression on it" is unanswerable later.
    // Containment, not equality: `defaultAnimation` is a module singleton that
    // earlier tests in this file have also written to, and clearing the scene
    // graph does not clear it. What matters is that every plane THIS test
    // generated is attributed.
    const authored = defaultAnimation.expressionsAuthoredBy(PLUGIN).map((a) => a.nodeId);
    for (const id of planeIds) expect(authored).toContain(id);
    expect(defaultAnimation.expressionsAuthoredBy('studio.nobody.else')).toEqual([]);
  });
});
