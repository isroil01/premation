/**
 * A binding survives a rename.
 *
 * The bug: proxy children referenced their parent by NAME, resolved every
 * frame. Rename the layer and every child silently reads 0 — the symptom
 * appears nowhere near the rename, and a user renaming a layer has no reason to
 * connect the two.
 *
 * Fixed in the RESOLUTION layer rather than in the proxy path that found it, so
 * `layer`, `layerAt`, `toComp` and every other name-taking API gets it from one
 * change. Two halves are tested here: new bindings are written by id, and
 * documents already carrying the fragile form are repaired on load.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { seedDefaultScene } from '@core/scene/seedDefaultScene';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import { defaultAnimation, layerIdRef, resolveLayerRef, isLayerIdRef } from '@motion/animation';
import { usePluginStore } from '@stores/pluginStore';
import { buildCustomLayerNode, customPropPath } from './customLayers';
import { regenerateProxyChildren, resetRateLimitForTests } from './proxySubtree';
import { migratePluginBindings } from './bindingMigration';
import type { LayerKindContribution } from './layerKindSchema';

const PLUGIN = 'studio.acme.depth';
const KIND: LayerKindContribution = {
  id: 'depthImage',
  label: 'Depth Image',
  render: 'proxy',
  schemaVersion: 1,
  props: { focal: { type: 'number', default: 50, min: 0, max: 100, animatable: true } },
};

/** The app's own name lookup, as `Providers.tsx` wires it. */
const byName = (name: string): string | null => {
  let found: string | null = null;
  defaultSceneGraph.traverse((n) => { if (found === null && n.name === name) found = n.id; });
  return found;
};

beforeAll(() => {
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
});

beforeEach(async () => {
  await usePluginStore.getState().hydrate();
  for (const p of [...usePluginStore.getState().plugins]) usePluginStore.getState().remove(p.manifest.id);
  defaultSceneGraph.clear();
  seedDefaultScene();
  resetRateLimitForTests();
  defaultAnimation.setLayerResolver(byName);
  defaultSceneGraph.addNode(buildCustomLayerNode('depth-1', PLUGIN, KIND, { name: 'Hero depth' }));
  defaultAnimation.setKeyframe('depth-1', customPropPath('focal'), 0, 10);
  defaultAnimation.setKeyframe('depth-1', customPropPath('focal'), 4, 90);
});

describe('the resolution layer', () => {
  it('takes an id reference without consulting the name lookup at all', () => {
    // Nothing at evaluation time may look a layer up by name — that lookup is
    // the fragility. A resolver that throws proves it is not being called.
    const explode = (): never => { throw new Error('name lookup must not run'); };
    expect(resolveLayerRef(layerIdRef('n_abc'), explode)).toBe('n_abc');
  });

  it('still resolves a plain name, so existing expressions keep working', () => {
    expect(resolveLayerRef('Hero depth', byName)).toBe('depth-1');
  });

  it('keeps the two unambiguous', () => {
    // Without the prefix, a layer NAMED like another layer's id would resolve
    // to the wrong one — a bug that is essentially undiagnosable.
    expect(isLayerIdRef('#n_abc')).toBe(true);
    expect(isLayerIdRef('Hero depth')).toBe(false);
    expect(resolveLayerRef('#', byName)).toBeNull();
  });
});

describe('a new proxy binding', () => {
  function build(): string[] {
    regenerateProxyChildren('depth-1', PLUGIN, 'Depth', [
      { key: 'p0', kind: 'shape', name: 'Plane 1',
        expressions: { x: `layer('Hero depth', '${customPropPath('focal')}')` } },
    ]);
    return defaultSceneGraph.getChildren('depth-1').map((c) => c.id);
  }

  it('is written by id, even though the plugin wrote a name', () => {
    // A plugin naturally writes the parent's NAME — it is what the author sees.
    // Resolving it to a stable id happens once, at authoring time.
    const [childId] = build();
    const src = defaultAnimation.getExpressionSrc(childId!, 'x')!;
    expect(src).toContain(layerIdRef('depth-1'));
    expect(src).not.toContain('Hero depth');
  });

  it('evaluates IDENTICALLY after the parent is renamed', () => {
    /*
      The whole point. Before this, renaming the parent made every child read 0
      — silently, and nowhere near the rename.
    */
    const [childId] = build();
    const before = defaultAnimation.sample(childId!, 'x', 4);
    expect(before).toBeCloseTo(90, 3);

    const node = defaultSceneGraph.getNode('depth-1')!;
    node.name = 'Something else entirely';

    expect(defaultAnimation.sample(childId!, 'x', 4)).toBeCloseTo(before as number, 6);
    expect(defaultAnimation.sample(childId!, 'x', 0)).toBeCloseTo(10, 3);
  });

  it('leaves a reference to a layer that does not exist alone', () => {
    // Rewriting it to `#undefined` would turn an already-broken reference into
    // a permanently broken and untraceable one.
    regenerateProxyChildren('depth-1', PLUGIN, 'Depth', [
      { key: 'p0', kind: 'shape', expressions: { x: `layer('Ghost layer', 'x')` } },
    ]);
    const [childId] = defaultSceneGraph.getChildren('depth-1').map((c) => c.id);
    expect(defaultAnimation.getExpressionSrc(childId!, 'x')).toContain('Ghost layer');
  });
});

describe('documents already carrying the fragile form', () => {
  /** Install the plugin so the migration knows whose expressions to look at. */
  function installPlugin(): void {
    usePluginStore.getState().put({
      manifest: {
        id: PLUGIN, name: 'Depth', version: '1.0.0', description: 'x',
        apiVersion: 3, main: 'main.js', permissions: [],
        contributes: { commands: [], panels: [], layerKinds: [KIND], effects: [] },
        activationEvents: ['onStartup'],
      },
      granted: [], enabled: true, files: {}, binaries: {}, installedAt: 0, source: 'file',
    } as never);
  }

  /** A child written the old way, by hand. */
  function legacyChild(src: string): string {
    defaultSceneGraph.addChild('depth-1', {
      id: 'old-child',
      name: 'Plane 1',
      children: [],
      parent: null,
      transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
      components: [{ id: 'old-child_t', type: 'Transform', props: { __kind: 'shape', x: 0, y: 0 } }],
    });
    defaultAnimation.setExpression('old-child', 'x', src, PLUGIN);
    return 'old-child';
  }

  it('migrates a name reference to an id reference', () => {
    installPlugin();
    const id = legacyChild(`layer('Hero depth', '${customPropPath('focal')}')`);

    const report = migratePluginBindings();

    expect(report.migrated).toHaveLength(1);
    expect(defaultAnimation.getExpressionSrc(id, 'x')).toContain(layerIdRef('depth-1'));
  });

  it('keeps the migrated expression attributable to its plugin', () => {
    installPlugin();
    legacyChild(`layer('Hero depth', 'x')`);
    migratePluginBindings();
    // Rewritten with the SAME provenance — a migration must not launder a
    // plugin's output into something that looks user-authored.
    expect(defaultAnimation.expressionsAuthoredBy(PLUGIN).map((e) => e.nodeId)).toContain('old-child');
  });

  it('SURFACES an unresolvable reference rather than dropping it', () => {
    installPlugin();
    const id = legacyChild(`layer('A layer that is gone', 'x')`);

    const report = migratePluginBindings();

    // Containment: `defaultAnimation` is a module singleton that earlier tests
    // in this file also wrote to, and clearing the scene graph does not clear
    // it. What matters is that THIS reference was reported.
    expect(report.unresolved).toContainEqual({ nodeId: id, prop: 'x', name: 'A layer that is gone' });
    // Left exactly as it was: dropping it would delete a plugin's output
    // silently, and rewriting it would make it untraceable.
    expect(defaultAnimation.getExpressionSrc(id, 'x')).toContain('A layer that is gone');
  });

  it('is idempotent, so running it on every load costs nothing after the first', () => {
    installPlugin();
    const id = legacyChild(`layer('Hero depth', 'x')`);

    migratePluginBindings();
    const afterFirst = defaultAnimation.getExpressionSrc(id, 'x');
    const second = migratePluginBindings();

    expect(second.migrated).toEqual([]);
    expect(defaultAnimation.getExpressionSrc(id, 'x')).toBe(afterFirst);
  });

  it('leaves a USER-authored expression alone', () => {
    /*
      A deliberate product decision, not an omission. The source text is what
      the user typed and what they see when they open the expression editor;
      replacing a layer name with `#n_a1b2c3` would make their own expression
      unreadable to them to fix a problem they have not hit. The id form is
      available to them, and the resolution layer treats both identically.
    */
    installPlugin();
    defaultAnimation.setExpression('depth-1', 'y', `layer('Hero depth', 'x')`);

    migratePluginBindings();

    expect(defaultAnimation.getExpressionSrc('depth-1', 'y')).toContain('Hero depth');
  });
});
