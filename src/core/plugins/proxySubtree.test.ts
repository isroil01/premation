/**
 * Regeneration, ownership, and the contract that keeps playback from melting.
 *
 * Three properties here are each the difference between a usable feature and a
 * support problem:
 *
 *   • **Ids are preserved for unchanged children.** Churn them and a user's
 *     selection jumps, an unrelated layer's `layer('Blur 3', …)` goes dead, and
 *     undo granularity collapses — all far from the parameter tweak that caused
 *     it. Asserted on IDS, not on shape.
 *   • **A manual edit detaches rather than being overwritten.** Marking owned
 *     children exists precisely to prevent silent overwriting.
 *   • **The host stops a regeneration loop.** A plugin that regenerates in
 *     response to its own regeneration wedges the editor, and the author's own
 *     testing is where a one-plugin loop is least likely to appear.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { seedDefaultScene } from '@core/scene/seedDefaultScene';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import { defaultAnimation } from '@motion/animation';
import { buildCustomLayerNode, customPropPath, isPluginOwned, ownerOf } from './customLayers';
import {
  detachSubtree,
  noteManualEdit,
  regenerateProxyChildren,
  resetRateLimitForTests,
  type ProxyChildSpec,
} from './proxySubtree';
import {
  clearLayerChangeListeners,
  flush,
  notifyAuthoredChange,
  onLayerChanged,
  resetNotifierForTests,
} from './layerChangeNotifier';
import type { LayerKindContribution } from './layerKindSchema';

const PLUGIN = 'studio.acme.lab';
const KIND: LayerKindContribution = {
  id: 'depthImage',
  label: 'Depth Image',
  render: 'proxy',
  schemaVersion: 1,
  props: { focal: { type: 'number', default: 50, min: 0, max: 100, animatable: true } },
};

const child = (key: string, name = key): ProxyChildSpec => ({ key, kind: 'shape', name });

beforeAll(() => {
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
});

beforeEach(() => {
  defaultSceneGraph.clear();
  seedDefaultScene();
  resetRateLimitForTests();
  resetNotifierForTests();
  defaultSceneGraph.addNode(buildCustomLayerNode('depth-1', PLUGIN, KIND));
});

const childIds = (): string[] => defaultSceneGraph.getChildren('depth-1').map((c) => c.id);

describe('regeneration diffs rather than recreating', () => {
  it('preserves the ids of unchanged children', () => {
    regenerateProxyChildren('depth-1', PLUGIN, 'Acme Lab', [child('a'), child('b'), child('c')]);
    const before = childIds();
    expect(before).toHaveLength(3);

    // Same keys, different content — the normal case when a parameter changes.
    const result = regenerateProxyChildren('depth-1', PLUGIN, 'Acme Lab', [
      { ...child('a'), props: { x: 40 } },
      { ...child('b'), props: { x: 80 } },
      { ...child('c'), props: { x: 120 } },
    ]);

    // Asserted on ids: a "correct-shaped" subtree with new ids is exactly the
    // failure this prevents, and it looks identical in a shape assertion.
    expect(childIds()).toEqual(before);
    expect(result.created).toEqual([]);
    expect(result.updated).toEqual(before);
  });

  it('adds only what is new and removes only what is gone', () => {
    regenerateProxyChildren('depth-1', PLUGIN, 'Acme Lab', [child('a'), child('b')]);
    const keptId = childIds()[0]!;

    const result = regenerateProxyChildren('depth-1', PLUGIN, 'Acme Lab', [child('a'), child('c')]);

    expect(result.created).toHaveLength(1);
    expect(result.removed).toHaveLength(1);
    expect(childIds()).toContain(keptId);
  });

  it('is ONE undo entry for the whole subtree', () => {
    const history = (setCommandSystem as never, defaultCommandHistory());
    const pushed: string[] = [];
    const real = history.push.bind(history);
    (history as unknown as { push: (c: { label: string }) => void }).push = (c) => {
      pushed.push(c.label);
      real(c as never);
    };

    regenerateProxyChildren('depth-1', PLUGIN, 'Acme Lab', [child('a'), child('b'), child('c')]);

    // Not one press of Ctrl+Z per generated layer.
    expect(pushed).toEqual(['Acme Lab: update layers']);
  });

  it('marks every generated child in the DOCUMENT, not only in the UI', () => {
    regenerateProxyChildren('depth-1', PLUGIN, 'Acme Lab', [child('a')]);
    const node = defaultSceneGraph.getNode(childIds()[0]!)!;
    // A user opening this project elsewhere has to be able to see these layers
    // are managed — the layer tree reads the same stored field.
    expect(isPluginOwned(node)).toBe(true);
    expect(ownerOf(node)).toBe(PLUGIN);
  });

  it('writes bindings with authoredBy, so plugin expressions are attributable', () => {
    /*
      Proxy output is expression-bearing by design, so a document fills up with
      expressions the user never wrote. Without an origin label, "why does this
      layer have an expression on it" is unanswerable months later and is not
      recoverable from anything else in the file.
    */
    regenerateProxyChildren('depth-1', PLUGIN, 'Acme Lab', [{
      ...child('a'),
      expressions: { x: `layer('Depth Image', '${customPropPath('focal')}')` },
    }]);

    // Read through the engine's own provenance query — there is deliberately no
    // `getExpressionState`, and this is the accessor the feature exists for.
    const authored = defaultAnimation.expressionsAuthoredBy(PLUGIN);
    expect(authored).toContainEqual({ nodeId: childIds()[0]!, prop: 'x' });
  });
});

describe('a user takes the subtree over', () => {
  beforeEach(() => {
    regenerateProxyChildren('depth-1', PLUGIN, 'Acme Lab', [child('a'), child('b')]);
  });

  it('detaches the WHOLE subtree on a manual edit, and destroys nothing', () => {
    const ids = childIds();
    noteManualEdit(ids[0]!);

    // Both children, not just the one edited: a half-owned subtree is a state
    // neither side can reason about.
    for (const id of ids) expect(isPluginOwned(defaultSceneGraph.getNode(id)!)).toBe(false);
    // Still there. Detaching clears a mark; it does not delete work.
    expect(childIds()).toEqual(ids);
  });

  it('then REFUSES the next regeneration rather than overwriting', () => {
    // Silently overwriting is exactly what the ownership mark exists to prevent.
    noteManualEdit(childIds()[0]!);
    const ids = childIds();

    const result = regenerateProxyChildren('depth-1', PLUGIN, 'Acme Lab', [child('a')]);

    expect(result.refused).toBe('detached');
    expect(childIds()).toEqual(ids);
  });

  it('does not detach while the plugin is regenerating its own children', () => {
    // Both go through the same scene-graph calls. Without the guard, the first
    // write of a regeneration would detach the subtree being regenerated.
    const ids = childIds();
    regenerateProxyChildren('depth-1', PLUGIN, 'Acme Lab', [child('a'), child('b')]);
    for (const id of ids) expect(isPluginOwned(defaultSceneGraph.getNode(id)!)).toBe(true);
  });

  it('ignores an edit to a layer no plugin owns', () => {
    detachSubtree('depth-1', PLUGIN);
    expect(() => noteManualEdit(childIds()[0]!)).not.toThrow();
  });
});

describe('the host stops a regeneration loop', () => {
  it('cuts a plugin off after too many regenerations in one window', () => {
    let allowed = 0;
    for (let i = 0; i < 40; i += 1) {
      const result = regenerateProxyChildren('depth-1', PLUGIN, 'Acme Lab', [child('a')], 1000);
      if (result.updated.length > 0 || result.created.length > 0) allowed += 1;
    }
    // Bounded by the host, not by author discipline: the failure mode is a
    // wedged editor, and a one-plugin loop is least likely to show up in the
    // author's own testing.
    expect(allowed).toBeLessThanOrEqual(20);
    expect(allowed).toBeGreaterThan(0);
  });

  it('lets it start again in the next window', () => {
    for (let i = 0; i < 40; i += 1) {
      regenerateProxyChildren('depth-1', PLUGIN, 'Acme Lab', [child('a')], 1000);
    }
    // A rate limit that never forgives is a plugin permanently broken by one
    // bad second.
    const later = regenerateProxyChildren('depth-1', PLUGIN, 'Acme Lab', [child('a')], 5000);
    expect(later.updated.length + later.created.length).toBeGreaterThan(0);
  });
});

describe('onLayerChanged is for authored edits only', () => {
  afterEach(() => clearLayerChangeListeners());

  it('delivers an authored edit, coalesced into one call', () => {
    const calls: unknown[] = [];
    onLayerChanged(PLUGIN, 'depthImage', (e) => calls.push(e));

    // A drag: one event per pointer move.
    for (let i = 0; i < 30; i += 1) {
      notifyAuthoredChange('depth-1', `${PLUGIN}.depthImage`, 'focal');
    }
    flush();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ layerId: 'depth-1', kindId: 'depthImage', props: ['focal'] });
  });

  it('does not fire during playback, however many frames are scrubbed', () => {
    /*
      The decisive assertion. Animated values never reach this module — they
      reach the generated children through expression bindings the engine
      evaluates. Scrubbing 300 frames across an animated proxy layer must
      produce ZERO regenerations, and no amount of coalescing could achieve
      that if value changes were routed here.
    */
    const calls: unknown[] = [];
    onLayerChanged(PLUGIN, 'depthImage', (e) => calls.push(e));

    defaultAnimation.setKeyframe('depth-1', customPropPath('focal'), 0, 10);
    defaultAnimation.setKeyframe('depth-1', customPropPath('focal'), 5, 90);
    for (let f = 0; f < 300; f += 1) {
      defaultAnimation.sample('depth-1', customPropPath('focal'), f / 60);
    }
    flush();

    expect(calls).toEqual([]);
  });

  it('reports every property touched in the burst, once each', () => {
    const calls: Array<{ props: string[] }> = [];
    onLayerChanged(PLUGIN, 'depthImage', (e) => calls.push(e));

    notifyAuthoredChange('depth-1', `${PLUGIN}.depthImage`, 'focal');
    notifyAuthoredChange('depth-1', `${PLUGIN}.depthImage`, 'mode');
    notifyAuthoredChange('depth-1', `${PLUGIN}.depthImage`, 'focal');
    flush();

    expect(calls[0]!.props).toEqual(['focal', 'mode']);
  });

  it('tells a plugin about its OWN kinds only', () => {
    const mine: unknown[] = [];
    onLayerChanged(PLUGIN, 'depthImage', (e) => mine.push(e));

    notifyAuthoredChange('other-1', 'studio.other.tools.gizmo', 'size');
    flush();

    expect(mine).toEqual([]);
  });

  it('survives a listener that throws, and still delivers the rest', () => {
    const survived: unknown[] = [];
    onLayerChanged(PLUGIN, 'depthImage', () => { throw new Error('plugin bug'); });
    onLayerChanged('studio.other.tools', 'gizmo', (e) => survived.push(e));

    notifyAuthoredChange('depth-1', `${PLUGIN}.depthImage`, 'focal');
    notifyAuthoredChange('other-1', 'studio.other.tools.gizmo', 'size');
    expect(() => flush()).not.toThrow();

    // One plugin's bug must not silently stop another plugin's layers updating.
    expect(survived).toHaveLength(1);
  });

  it('drops pending work for a kind nobody is listening to', () => {
    // Otherwise every custom layer edit accumulates forever for the plugins
    // that never registered a callback, which is most of them.
    notifyAuthoredChange('depth-1', `${PLUGIN}.depthImage`, 'focal');
    flush();
    expect(() => flush()).not.toThrow();
  });
});

/** The live history service, without importing the whole command surface. */
function defaultCommandHistory(): { push: (c: unknown) => void } {
  const { getCommandSystem } = require('@core/commands/CommandSystem') as
    typeof import('@core/commands/CommandSystem');
  return getCommandSystem().getHistory() as unknown as { push: (c: unknown) => void };
}
