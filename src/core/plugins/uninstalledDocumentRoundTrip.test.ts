/**
 * A project containing plugin content, saved and reopened without the plugin.
 *
 * ── Why this is one test and not a subsystem ─────────────────────────────────
 *
 * Opening a project in a build that has no plugin support at all is the same
 * situation as opening one after UNINSTALLING the plugin, which the shipped
 * build already faces. So there is no need to design a content-preservation
 * mechanism before knowing whether one is missing: put every kind of plugin
 * content into a document, take the plugin away, push the document through the
 * real save/load boundary, and diff.
 *
 * `customLayers.test.ts` already asserts that a custom-layer RECORD survives
 * being read without its plugin, but it does so over pure functions on a hand
 * built node. Nothing asserted the whole document through
 * `captureDocument → serializeProject → parseProject → restoreDocument`, and
 * nothing at all covered the two other kinds of plugin content:
 *
 *   - an **effect instance** whose `type` is `<pluginId>.<effectId>`, sitting in
 *     a native layer's `fx` stack with a type no static map has heard of;
 *   - a **proxy subtree** of generated children carrying an ownership marker and
 *     expressions the engine — not the plugin — evaluates.
 *
 * The assertion is on the document being byte-identical, not on the layers
 * merely still existing. A "preserved" layer that lost its parameters is not
 * preserved, and neither is an effect that survived as an empty shell.
 */

import pluginHost from './PluginHost';
import { usePluginStore } from '@stores/pluginStore';
import { useFakeWorkers, testPackage, bootPlugin, type FakeWorker } from './fakeWorker.testkit';
import { resetLayerKindsForTests } from './layerKindRegistry';
import { resetNotifierForTests } from './layerChangeNotifier';
import { resetRateLimitForTests } from './proxySubtree';
import { resetEffectsForTests } from './pluginEffects';
import { customPropPath, isPluginOwned, readCustomLayer } from './customLayers';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { seedDefaultScene } from '@core/scene/seedDefaultScene';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import { defaultAnimation } from '@motion/animation';
import { captureDocument, restoreDocument, type EditorDocument } from '@core/api/cloudDocument';
import { serializeProject, parseProject } from '@core/persistence/ProjectSerializer';
import { getNodeEffects } from '@core/effects/effects';

const PLUGIN = 'studio.acme.roundtrip';

const KIND = {
  id: 'depthImage',
  label: 'Depth Image',
  render: 'proxy',
  schemaVersion: 1,
  props: {
    focal: { type: 'number', default: 50, min: 0, max: 100, animatable: true },
    planes: { type: 'number', default: 3, min: 2, max: 8, step: 1 },
    mode: { type: 'enum', values: ['parallax', 'displace'], default: 'parallax' },
  },
};

/** A minimal but real effect: one animatable parameter, one legal `fs`. */
const EFFECT = {
  id: 'tint',
  label: 'Tint',
  shader: `
    @fragment fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
      let c = textureSample(src, samp, uv);
      return vec4<f32>(c.rgb * params.amount, c.a);
    }
  `,
  params: {
    amount: { type: 'number', default: 1, min: 0, max: 4, animatable: true },
  },
};

const pkg = (): ReturnType<typeof testPackage> =>
  testPackage(['scene:read', 'scene:write', 'animation:write'], PLUGIN, {
    apiVersion: 4,
    name: 'Round Trip',
    contributes: {
      layerKinds: [KIND],
      effects: [EFFECT],
      commands: [{ id: 'insert', label: 'Insert depth image' }],
    },
    activationEvents: ['onStartup'],
  });

function planeSpecs(layerName: string, planes: number): unknown[] {
  return Array.from({ length: planes }, (_, i) => ({
    key: `plane-${i}`,
    kind: 'shape',
    name: `Plane ${i + 1}`,
    props: { y: i * 40 },
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
  resetEffectsForTests();
  defaultSceneGraph.clear();
  defaultAnimation.clear();
  seedDefaultScene();
});

/**
 * Author a document containing all three kinds of plugin content.
 *
 * Driven through the host, not by writing components directly, so the shapes
 * under test are the ones the shipped code produces.
 */
function authorDocument(): { worker: FakeWorker; customLayerId: string; nativeLayerId: string } {
  const worker = bootPlugin(pkg(), { granted: ['scene:read', 'scene:write', 'animation:write'] });

  // The ordinary layer first: `insertPrimitive` parents to the selection, so a
  // shape created after the custom layer would land INSIDE its proxy subtree
  // and the subtree assertions would be counting the wrong thing.
  const nativeLayerId = (worker.callAndWait('scene.createLayer', {
    kind: 'shape',
    name: 'Plain rectangle',
  }) as { value: string }).value;

  // 1. A custom layer of a plugin-declared kind…
  const customLayerId = (worker.callAndWait('scene.createLayer', {
    kind: `${PLUGIN}.depthImage`,
    name: 'Hero depth',
    props: { focal: 72, planes: 3, mode: 'displace' },
  }) as { value: string }).value;

  // …with a keyframed custom property…
  worker.callAndWait('animation.setKeyframes', customLayerId, customPropPath('focal'), [
    { time: 0, value: 20 },
    { time: 2, value: 90 },
  ]);

  // 2. …a proxy subtree beneath it…
  worker.callAndWait('scene.setProxyChildren', customLayerId, planeSpecs('Hero depth', 3));

  // 3. …and a plugin effect on the ordinary layer.
  const effectId = (worker.callAndWait(
    'effects.add', nativeLayerId, `${PLUGIN}.${EFFECT.id}`,
  ) as { value: string }).value;
  worker.callAndWait('effects.setParam', nativeLayerId, effectId, 'amount', 2.5);

  return { worker, customLayerId, nativeLayerId };
}

/** Save, wipe every live engine, and open again — the real boundary. */
function saveAndReopen(doc: EditorDocument): EditorDocument {
  const onDisk = serializeProject(doc as never);
  defaultSceneGraph.clear();
  defaultAnimation.clear();
  restoreDocument(parseProject(onDisk) as unknown as EditorDocument);
  return captureDocument();
}

describe('a document authored with a plugin, reopened without it', () => {
  it('round-trips byte-identically', () => {
    authorDocument();
    const saved = captureDocument();

    // The plugin goes away — the same state a build without plugin support is
    // permanently in.
    pluginHost.uninstall(PLUGIN);
    resetEffectsForTests();
    resetLayerKindsForTests();

    const reopened = saveAndReopen(saved);

    expect(reopened.scene).toEqual(saved.scene);
    expect(reopened.animation).toEqual(saved.animation);
    // Whole-document, so nothing outside the scene quietly drops either.
    expect(serializeProject(reopened as never)).toBe(serializeProject(saved as never));
  });

  it('keeps the custom layer and every authored value', () => {
    const { customLayerId } = authorDocument();
    const saved = captureDocument();
    pluginHost.uninstall(PLUGIN);
    resetEffectsForTests();
    resetLayerKindsForTests();
    saveAndReopen(saved);

    const node = defaultSceneGraph.getNode(customLayerId);
    expect(node).toBeTruthy();
    expect(readCustomLayer(node!)).toEqual({
      kind: `${PLUGIN}.depthImage`,
      pluginId: PLUGIN,
      kindId: 'depthImage',
      schemaVersion: 1,
      props: { focal: 72, planes: 3, mode: 'displace' },
    });
  });

  it('keeps the proxy subtree, its ownership marks and its expressions', () => {
    const { customLayerId } = authorDocument();
    const saved = captureDocument();
    pluginHost.uninstall(PLUGIN);
    resetEffectsForTests();
    resetLayerKindsForTests();
    saveAndReopen(saved);

    const children = defaultSceneGraph.getChildren(customLayerId);
    expect(children).toHaveLength(3);
    for (const child of children) {
      expect(isPluginOwned(defaultSceneGraph.getNode(child.id)!)).toBe(true);
    }
    // The bindings are what make the subtree keep animating without the plugin,
    // so an expression lost here is the whole feature lost.
    expect(defaultAnimation.snapshot().expressions).toEqual(saved.animation.expressions);
  });

  it('keeps the plugin effect on the layer, with its parameters', () => {
    const { nativeLayerId } = authorDocument();
    const saved = captureDocument();
    pluginHost.uninstall(PLUGIN);
    resetEffectsForTests();
    resetLayerKindsForTests();
    saveAndReopen(saved);

    /*
      The one with no prior coverage. `effectDefFor` returns undefined for this
      type once the plugin is gone — the question is whether anything on the
      save/load path uses that as licence to drop the instance.
    */
    const effects = getNodeEffects(nativeLayerId);
    expect(effects).toHaveLength(1);
    expect(effects[0]!.type).toBe(`${PLUGIN}.${EFFECT.id}`);
    expect(effects[0]!.params?.amount).toBe(2.5);
  });

  it('still names the plugin the document depends on', () => {
    // Without this the editor can say "this layer needs a plugin" and not which.
    authorDocument();
    const saved = captureDocument();
    pluginHost.uninstall(PLUGIN);
    resetEffectsForTests();
    resetLayerKindsForTests();

    const reopened = saveAndReopen(saved);
    expect(reopened.plugins?.map((p) => p.id)).toContain(PLUGIN);
  });
});
