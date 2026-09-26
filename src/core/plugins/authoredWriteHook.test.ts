/**
 * The write hook, driven through the real host.
 *
 * `proxySubtree.test.ts` proves the modules behave; this proves they are
 * actually WIRED — which is the failure this repo has seen before: a feature
 * registered, rendered, fully tested and unreachable.
 *
 * The authored-change report is hooked at `SceneGraph.writeProp`, and that
 * placement is the claim under test (the detach is the engine's rule now). It makes the playback property STRUCTURAL rather than a
 * discipline: animation samples tracks and never writes props, so it cannot
 * reach the hook at all — no amount of coalescing is doing that work.
 */

import pluginHost from './PluginHost';
import { usePluginStore } from '@stores/pluginStore';
import { useFakeWorkers, testPackage, bootPlugin, FakeWorker } from './fakeWorker.testkit';
import { resetLayerKindsForTests } from './layerKindRegistry';
import { resetNotifierForTests, flush, pendingCount } from './layerChangeNotifier';
import { resetRateLimitForTests, regenerateProxyChildren } from './proxySubtree';
import { buildCustomLayerNode, customLayerComponent, customPropPath, isPluginOwned } from './customLayers';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { seedDefaultScene } from '@core/scene/seedDefaultScene';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import { activeCompRootId } from '@core/scene/activeComp';
import { setupAppEngine } from '@core/engine/__testHelpers__/appEngine';
import { defaultAnimation } from '@motion/animation';
import type { LayerKindContribution } from './layerKindSchema';

const PLUGIN = 'studio.acme.lab';
const KIND: LayerKindContribution = {
  id: 'depthImage',
  label: 'Depth Image',
  render: 'proxy',
  schemaVersion: 1,
  props: {
    focal: { type: 'number', default: 50, min: 0, max: 100, animatable: true },
    mode: { type: 'enum', values: ['parallax', 'displace'], default: 'parallax' },
  },
};

beforeAll(async () => {
  useFakeWorkers();
  await usePluginStore.getState().hydrate();
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
  // `configure` is what registers the write hook.
  pluginHost.configure({ getSelection: () => [] });
});
afterAll(() => { pluginHost.setWorkerFactory(null); });

beforeEach(() => {
  for (const p of [...usePluginStore.getState().plugins]) pluginHost.uninstall(p.manifest.id);
  resetLayerKindsForTests();
  resetNotifierForTests();
  resetRateLimitForTests();
  defaultSceneGraph.clear();
  seedDefaultScene();
});

function bootWithKind(): FakeWorker {
  return bootPlugin(
    testPackage(['scene:read', 'scene:write'], PLUGIN, {
      apiVersion: 3,
      name: 'Acme Lab',
      contributes: { layerKinds: [KIND] },
    }),
    { granted: ['scene:read', 'scene:write'] },
  );
}

/** The worker messages the host pushed, of one kind. */
const messagesOfKind = (w: FakeWorker, k: string): unknown[] =>
  w.sent.filter((m) => (m as { k?: string }).k === k);

describe('an authored edit reaches the plugin', () => {
  it('is delivered as one coalesced layerChanged, naming what changed', () => {
    const w = bootWithKind();
    w.callAndWait('scene.onLayerChanged', 'depthImage');
    defaultSceneGraph.addNode(buildCustomLayerNode('depth-1', PLUGIN, KIND));
    const component = customLayerComponent(defaultSceneGraph.getNode('depth-1')!)!;

    // A drag: many writes to the same property.
    for (let i = 0; i < 25; i += 1) {
      defaultSceneGraph.writeProp('depth-1', component.id, 'focal', 50 + i);
    }
    defaultSceneGraph.writeProp('depth-1', component.id, 'mode', 'displace');
    flush();

    const events = messagesOfKind(w, 'layerChanged') as Array<{ layerId: string; props: string[] }>;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ layerId: 'depth-1', props: ['focal', 'mode'] });
  });

  it('does NOT fire while the timeline is scrubbed across an animated layer', () => {
    /*
      The decisive one, and the reason the hook lives on the write path.

      Animation samples tracks; it never writes props. So 300 frames of playback
      cannot reach the notifier at all — this is structural, not a coalescing
      window that happens to be long enough.
    */
    const w = bootWithKind();
    w.callAndWait('scene.onLayerChanged', 'depthImage');
    defaultSceneGraph.addNode(buildCustomLayerNode('depth-1', PLUGIN, KIND));

    defaultAnimation.setKeyframe('depth-1', customPropPath('focal'), 0, 10);
    defaultAnimation.setKeyframe('depth-1', customPropPath('focal'), 5, 90);
    for (let f = 0; f < 300; f += 1) {
      defaultAnimation.sample('depth-1', customPropPath('focal'), f / 60);
    }
    flush();

    expect(pendingCount()).toBe(0);
    expect(messagesOfKind(w, 'layerChanged')).toEqual([]);
  });

  it('ignores a transform nudge, which is not a schema change', () => {
    const w = bootWithKind();
    w.callAndWait('scene.onLayerChanged', 'depthImage');
    defaultSceneGraph.addNode(buildCustomLayerNode('depth-1', PLUGIN, KIND));
    const transform = defaultSceneGraph.getNode('depth-1')!.components.find((c) => c.type === 'Transform')!;

    // Moving the layer is not a reason to rebuild its output.
    defaultSceneGraph.writeProp('depth-1', transform.id, 'x', 400);
    flush();

    expect(messagesOfKind(w, 'layerChanged')).toEqual([]);
  });

  it('refuses to observe another plugin s kind', () => {
    const w = bootWithKind();
    const result = w.callAndWait('scene.onLayerChanged', 'gizmo') as { ok: boolean; error?: string };
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/does not declare a layer kind "gizmo"/);
  });
});

describe('a user edit detaches a generated subtree', () => {
  // B5: regeneration is an engine batch — the app's engine, a fresh project,
  // the custom layer inside its composition. The detach is the ENGINE's rule
  // (src/core/engine/proxyOwnership.ts): any command whose origin is not
  // `plugin` that changes a generated child.
  let h: Awaited<ReturnType<typeof setupAppEngine>>;
  let dispose: () => Promise<void> = async () => {};
  beforeEach(async () => { h = await setupAppEngine(); dispose = h.dispose; });
  afterEach(async () => { await dispose(); });

  it('detaches wherever the edit came from, not only from the inspector', async () => {
    bootWithKind();
    defaultSceneGraph.addChild(activeCompRootId() as string, buildCustomLayerNode('depth-1', PLUGIN, KIND));
    await regenerateProxyChildren('depth-1', PLUGIN, 'Acme Lab', [
      { key: 'a', kind: 'shape' },
      { key: 'b', kind: 'shape' },
    ]);
    const ids = defaultSceneGraph.getChildren('depth-1').map((c) => c.id);
    expect(ids).toHaveLength(2);

    // The command a canvas drag, a menu or the Inspector sends — the rule sits
    // in the engine, so no surface can forget it.
    await h.run({ type: 'setProperty', prop: { layer: ids[0]!, path: 'transform/position' }, value: { kind: 'vec2', value: { x: 99, y: 0 } } });

    for (const id of ids) expect(isPluginOwned(defaultSceneGraph.getNode(id)!)).toBe(false);
  });

  it('does not detach while the plugin is regenerating', async () => {
    bootWithKind();
    defaultSceneGraph.addChild(activeCompRootId() as string, buildCustomLayerNode('depth-1', PLUGIN, KIND));
    await regenerateProxyChildren('depth-1', PLUGIN, 'Acme Lab', [{ key: 'a', kind: 'shape' }]);
    // A second pass writes to the same children through the engine (a setProperty).
    await regenerateProxyChildren('depth-1', PLUGIN, 'Acme Lab', [{ key: 'a', kind: 'shape', props: { x: 40 } }]);

    const id = defaultSceneGraph.getChildren('depth-1')[0]!.id;
    expect(isPluginOwned(defaultSceneGraph.getNode(id)!)).toBe(true);
  });
});
