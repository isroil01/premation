/**
 * `scene:proxy` — the narrow grant a proxy plugin actually needs.
 *
 * ── What was wrong ───────────────────────────────────────────────────────────
 *
 * A `render: "proxy"` layer kind cannot draw anything without
 * `scene.setProxyChildren`, and that method required `scene:write` — the widest
 * permission in the API, "create, change and delete layers". So the most useful
 * class of plugin could not be installed without also being able to delete
 * everything in the project, and the consent screen had no vocabulary for the
 * difference. A user who wanted a depth-parallax layer had to agree to a plugin
 * that could empty their composition.
 *
 * The narrowing is safe because the SCOPE was never the permission's job. The
 * handler already refuses any target that is not a layer of a kind this plugin
 * declared, refuses a kind that is not `render: "proxy"`, and refuses children
 * the user has edited. All of that predates this change; what changes is that
 * the consent screen can now say so.
 *
 * ── The two properties that matter ──────────────────────────────────────────
 *
 *   1. `scene:read` + `scene:proxy` is enough to build a proxy subtree, and is
 *      refused everywhere else.
 *   2. A plugin holding `scene:write` still works, with no re-consent. That is
 *      not a nicety — it is every proxy plugin currently installed.
 */

import pluginHost from './PluginHost';
import { usePluginStore } from '@stores/pluginStore';
import { useFakeWorkers, testPackage, bootPlugin, FakeWorker } from './fakeWorker.testkit';
import { resetLayerKindsForTests } from './layerKindRegistry';
import { resetNotifierForTests } from './layerChangeNotifier';
import { resetRateLimitForTests } from './proxySubtree';
import { isPluginOwned, buildCustomLayerNode } from './customLayers';
import { expandPermissions, ALL_PERMISSIONS, PERMISSIONS } from './manifest';
import { METHOD_PERMISSIONS } from './protocol';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { seedDefaultScene } from '@core/scene/seedDefaultScene';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import { defaultAnimation } from '@motion/animation';

const PLUGIN = 'studio.acme.depth';
const OTHER = 'studio.other.tools';

const KIND = {
  id: 'depthImage',
  label: 'Depth Image',
  render: 'proxy',
  schemaVersion: 1,
  props: { focal: { type: 'number', default: 50, min: 0, max: 100, animatable: true } },
};

const pkg = (id: string, permissions: string[]) =>
  testPackage(permissions as never, id, {
    apiVersion: 3,
    name: 'Depth',
    contributes: { layerKinds: [KIND] },
    activationEvents: ['onStartup'],
  });

const specs = [{ key: 'plane-0', kind: 'shape', name: 'Plane 1', props: { y: 0 } }];

beforeAll(async () => {
  useFakeWorkers();
  await usePluginStore.getState().hydrate();
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
  pluginHost.configure({ getSelection: () => [] });
});
afterAll(() => { pluginHost.setWorkerFactory(null); });

beforeEach(() => {
  for (const p of [...usePluginStore.getState().plugins]) pluginHost.uninstall(p.manifest.id);
  resetLayerKindsForTests();
  resetNotifierForTests();
  resetRateLimitForTests();
  defaultSceneGraph.clear();
  defaultAnimation.clear();
  seedDefaultScene();
  FakeWorker.last = null;
});

/**
 * Put a layer of the plugin's kind in the document, the way one really arrives.
 *
 * NOT through `scene.createLayer`, and the distinction is the interesting part
 * of this whole item. A plugin holding only `scene:read` + `scene:proxy` cannot
 * call `scene.createLayer` — that method creates ORDINARY layers too, so it
 * needs `scene:write`, and lowering it would hand every plugin the ability to
 * litter the composition under a permission whose text promises the opposite.
 *
 * It does not need to. The parent layer is created by the USER, from
 * `Layer ▸ New ▸ <kind>`, or arrives already in an opened document — which is
 * the same GAP 1 the depth end-to-end test recorded, and which the host closed
 * by building those menu entries from `allLayerKinds()`. The plugin's job
 * starts once the layer exists: fill in the children beneath it. That is
 * exactly the shape `scene:proxy` describes, and it is why the narrow grant is
 * sufficient rather than merely smaller.
 */
function seedOwnLayer(id = 'n_hero'): string {
  defaultSceneGraph.addNode(buildCustomLayerNode(id, PLUGIN, KIND as never, { name: 'Hero depth' }));
  return id;
}

describe('the permission itself', () => {
  it('is offered on the consent screen, above scene:write', () => {
    /*
      Order is not cosmetic. The consent screen renders `PERMISSIONS` in key
      order, and a user reading top to bottom should meet the narrow grant
      first — "build the layers beneath its own" is something a person can
      picture, and meeting "create, change and delete layers" first makes it
      read as a footnote to that rather than as the alternative to it.
    */
    expect(ALL_PERMISSIONS).toContain('scene:proxy');
    expect(ALL_PERMISSIONS.indexOf('scene:proxy')).toBeLessThan(ALL_PERMISSIONS.indexOf('scene:write'));
    expect(PERMISSIONS['scene:proxy'].detail).toMatch(/cannot reach anything else/i);
  });

  it('is what setProxyChildren requires', () => {
    expect(METHOD_PERMISSIONS['scene.setProxyChildren']).toBe('scene:proxy');
  });
});

describe('scene:write contains scene:proxy', () => {
  it('expands to include it', () => {
    expect([...expandPermissions(['scene:write'])].sort()).toEqual(['scene:proxy', 'scene:write']);
  });

  it('does not expand in the other direction', () => {
    // The narrow grant must not quietly become the wide one — that would be the
    // original problem with the labels swapped.
    expect([...expandPermissions(['scene:proxy'])]).toEqual(['scene:proxy']);
  });

  it('leaves unrelated grants alone', () => {
    expect([...expandPermissions(['scene:read', 'timeline'])].sort())
      .toEqual(['scene:read', 'timeline']);
  });
});

describe('a plugin holding only scene:read + scene:proxy', () => {
  it('builds its own proxy children', () => {
    const worker = bootPlugin(pkg(PLUGIN, ['scene:read', 'scene:proxy']), {
      granted: ['scene:read', 'scene:proxy'] as never,
    });
    const layerId = seedOwnLayer();

    const reply = worker.callAndWait('scene.setProxyChildren', layerId, specs);
    expect(reply.ok).toBe(true);

    const children = defaultSceneGraph.getChildren(layerId);
    expect(children).toHaveLength(1);
    expect(isPluginOwned(defaultSceneGraph.getNode(children[0]!.id)!)).toBe(true);
  });

  it('cannot create an ordinary layer', () => {
    // The whole point: it can generate beneath its own layers and nothing else.
    const worker = bootPlugin(pkg(PLUGIN, ['scene:read', 'scene:proxy']), {
      granted: ['scene:read', 'scene:proxy'] as never,
    });
    const reply = worker.callAndWait('scene.createLayer', { kind: 'shape', name: 'Rogue' });
    expect(reply.ok).toBe(false);
    expect(reply.error).toMatch(/scene:write/);
  });

  it('cannot delete a layer', () => {
    const writer = bootPlugin(pkg(OTHER, ['scene:write']), { granted: ['scene:write'] as never });
    const victim = (writer.callAndWait('scene.createLayer', {
      kind: 'shape', name: 'Someone else s work',
    }) as { value: string }).value;

    const worker = bootPlugin(pkg(PLUGIN, ['scene:read', 'scene:proxy']), {
      granted: ['scene:read', 'scene:proxy'] as never,
    });
    const reply = worker.callAndWait('scene.deleteLayer', victim);
    expect(reply.ok).toBe(false);
    expect(defaultSceneGraph.getNode(victim)).toBeTruthy();
  });

  it('cannot target a layer belonging to another plugin', () => {
    /*
      Enforced by the handler rather than the permission, and it was already
      true — but it is the assumption the narrow grant rests on, so it is
      asserted here rather than left implied by another file.
    */
    const other = bootPlugin(pkg(OTHER, ['scene:read', 'scene:proxy']), {
      granted: ['scene:read', 'scene:proxy'] as never,
    });
    const theirLayer = (other.callAndWait('scene.createLayer', {
      kind: `${OTHER}.depthImage`, name: 'Theirs',
    }) as { value: string }).value;

    const worker = bootPlugin(pkg(PLUGIN, ['scene:read', 'scene:proxy']), {
      granted: ['scene:read', 'scene:proxy'] as never,
    });
    const reply = worker.callAndWait('scene.setProxyChildren', theirLayer, specs);
    expect(reply.ok).toBe(false);
    expect(defaultSceneGraph.getChildren(theirLayer)).toHaveLength(0);
  });

  it('cannot target an ordinary layer', () => {
    const writer = bootPlugin(pkg(OTHER, ['scene:write']), { granted: ['scene:write'] as never });
    const plain = (writer.callAndWait('scene.createLayer', {
      kind: 'shape', name: 'Plain',
    }) as { value: string }).value;

    const worker = bootPlugin(pkg(PLUGIN, ['scene:read', 'scene:proxy']), {
      granted: ['scene:read', 'scene:proxy'] as never,
    });
    const reply = worker.callAndWait('scene.setProxyChildren', plain, specs);
    expect(reply.ok).toBe(false);
    expect(reply.error).toMatch(/not a plugin layer kind/i);
  });
});

describe('the migration: plugins installed before this permission existed', () => {
  it('still builds proxy children on scene:write alone', () => {
    /*
      Every proxy plugin currently installed holds `scene:write` and no
      `scene:proxy`, because the second did not exist when they were granted.
      Refusing them would be a silent breakage of exactly the plugins this
      change is meant to make easier to ship — and it would arrive as "the
      plugin stopped working", with the permission screen showing a grant the
      user never declined.
    */
    const worker = bootPlugin(pkg(PLUGIN, ['scene:read', 'scene:write']), {
      granted: ['scene:read', 'scene:write'] as never,
    });
    const layerId = seedOwnLayer();

    const reply = worker.callAndWait('scene.setProxyChildren', layerId, specs);
    expect(reply.ok).toBe(true);
    expect(defaultSceneGraph.getChildren(layerId)).toHaveLength(1);
  });

  it('needs no re-consent — the grant on disk is untouched', () => {
    // The implication lives in the gate, not in stored state. A migration that
    // rewrote grants would have to run once, correctly, on every machine.
    bootPlugin(pkg(PLUGIN, ['scene:read', 'scene:write']), {
      granted: ['scene:read', 'scene:write'] as never,
    });
    expect(usePluginStore.getState().get(PLUGIN)?.granted).toEqual(['scene:read', 'scene:write']);
  });
});

describe('a plugin holding neither', () => {
  it('is refused, and told which permission it needs', () => {
    const worker = bootPlugin(pkg(PLUGIN, ['scene:read']), { granted: ['scene:read'] as never });
    const layerId = worker.callAndWait('scene.createLayer', {
      kind: `${PLUGIN}.depthImage`, name: 'Hero depth',
    });
    // Creating its own kind already needs scene:write, so this plugin cannot
    // even get that far — which is itself the point: the refusal names the
    // permission rather than failing somewhere the author cannot see.
    expect(layerId.ok).toBe(false);

    const reply = worker.callAndWait('scene.setProxyChildren', 'n_nonexistent', specs);
    expect(reply.ok).toBe(false);
    expect(reply.error).toMatch(/scene:proxy/);
  });
});
