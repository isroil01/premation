/**
 * Essential Properties — two instances of one comp must be able to differ.
 *
 * THE TEST THAT MATTERS IS THE ANIMATED ONE. Overrides have two halves that are
 * easy to build separately and fatal to build alone:
 *
 *   static  — patched onto the clone's Transform by `expandCompInstances`.
 *   animated— `buildSnapshot`'s `anim` shim dropping the prop, so the ORIGINAL
 *             node's track stops outvoting that patch on every frame.
 *
 * Build only the first and you get a control that works on a static layer and
 * does nothing at all the moment someone keyframes it — no error, no warning,
 * just a value that never appears. That is the shape of the four dead controls
 * this repo has already paid for. `overrides a KEYFRAMED property` below is the
 * assertion that would fail if the shim were removed, and it is the reason this
 * file exists at all.
 */

import { readSource } from '@/__testHelpers__/readSource';
import { expandCompInstances, readCompRef, COMP_REF_PROP } from './compInstance';
import {
  applyOverridesToComponents,
  overrideKey,
  overriddenPropsFor,
  parseOverrideKey,
  readCompOverride,
  readCompOverrides,
  setCompOverride,
  clearCompOverridesFor,
  compositionRootOf,
  readEssentialProps,
  setEssentialProp,
  isEssentialProp,
  COMP_ESSENTIAL_PROPS,
} from './compInstanceOverrides';
import defaultSceneGraph from './DefaultSceneGraph';
import { SCENE_KIND_PROP } from './seedDefaultScene';
import { flattenComposition } from './sceneDerive';
import { buildSnapshot } from '@core/rendering/buildSnapshot';
import { defaultAnimation } from '@motion/animation';
import { useProjectStore } from '@stores/projectStore';
import type { SceneNode } from '@core/types';

function addComp(id: string, name: string): void {
  defaultSceneGraph.addNode({
    id, name, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: `${id}_meta`, type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
  } as unknown as SceneNode);
}

function addShape(id: string, parent: string, x = 10): void {
  defaultSceneGraph.addChild(parent, {
    id, name: id, parent, children: [], visible: true, locked: false,
    transform: { position: { x, y: 10 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x, y: 10, width: 20, height: 20 } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#f00' } },
    ],
  } as never);
}

function addInstance(id: string, parent: string, ref: string): void {
  defaultSceneGraph.addChild(parent, {
    id, name: id, parent, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'comp', x: 0, y: 0 } },
      { id: `${id}_fx`, type: 'fx', props: { precomp: true, [COMP_REF_PROP]: ref } },
    ],
  } as never);
}

function resetScene(): void {
  const ids: string[] = [];
  defaultSceneGraph.traverse((n) => ids.push(n.id));
  for (const id of ids) defaultSceneGraph.removeNode(id);
  defaultAnimation.clear();
}

const COMP = {
  width: 1920, height: 1080, fps: 30, durationSeconds: 10,
  background: '#000', transparent: false, startFrame: 0,
};

beforeEach(() => {
  resetScene();
  addComp('comp_root', 'Main');
  addComp('comp_b', 'Lower Third');
  useProjectStore.getState().actions.replaceComps({
    comp_root: { id: 'comp_root', name: 'Main', ...COMP },
    comp_b: { id: 'comp_b', name: 'Lower Third', ...COMP },
  });
  const proj = useProjectStore.getState();
  proj.actions.setActiveTab(proj.actions.openTab('comp_root', ['comp_root'], 'Main'));
});

const expand = (): SceneNode[] =>
  expandCompInstances(defaultSceneGraph, flattenComposition(defaultSceneGraph, 'comp_root'), 'comp_root');

const cloneNamed = (id: string): SceneNode => expand().find((n) => n.id === id)!;

const transformProps = (n: SceneNode): Record<string, unknown> =>
  n.components.find((c) => c.type === 'Transform')!.props as Record<string, unknown>;

const snapshot = (rootId = 'comp_root'): ReturnType<typeof buildSnapshot> =>
  buildSnapshot(defaultSceneGraph, defaultAnimation, 0, undefined, undefined, undefined, undefined, {
    width: 1920, height: 1080, background: '#000', transparent: false, rootId,
  });

describe('override storage', () => {
  it('round-trips through the fx component', () => {
    addShape('b_shape', 'comp_b');
    addInstance('inst1', 'comp_root', 'comp_b');
    setCompOverride('inst1', 'b_shape', 'x', 400);
    expect(readCompOverride(defaultSceneGraph.getNode('inst1'), 'b_shape', 'x')).toBe(400);
  });

  it('clears with undefined, and clears a whole layer', () => {
    addShape('b_shape', 'comp_b');
    addInstance('inst1', 'comp_root', 'comp_b');
    setCompOverride('inst1', 'b_shape', 'x', 400);
    setCompOverride('inst1', 'b_shape', 'opacity', 50);
    setCompOverride('inst1', 'b_shape', 'x', undefined);
    expect(readCompOverride(defaultSceneGraph.getNode('inst1'), 'b_shape', 'x')).toBeUndefined();
    expect(readCompOverride(defaultSceneGraph.getNode('inst1'), 'b_shape', 'opacity')).toBe(50);
    clearCompOverridesFor('inst1', 'b_shape');
    expect(readCompOverrides(defaultSceneGraph.getNode('inst1')).size).toBe(0);
  });

  it('ignores malformed entries rather than trusting the bag', () => {
    addShape('b_shape', 'comp_b');
    addInstance('inst1', 'comp_root', 'comp_b');
    const fx = defaultSceneGraph.getNode('inst1')!.components.find((c) => c.type === 'fx')!;
    defaultSceneGraph.writeProp('inst1', fx.id, '__compOverrides', {
      'b_shape/x': 12, 'b_shape/y': 'nope', bad: 3, '/x': 9, 'b_shape/': 4, 'b_shape/z': NaN,
    });
    expect([...readCompOverrides(defaultSceneGraph.getNode('inst1')).keys()]).toEqual(['b_shape/x']);
  });

  it('parses keys whose node id is not itself ambiguous', () => {
    expect(parseOverrideKey('b_shape/x')).toEqual({ origNodeId: 'b_shape', prop: 'x' });
    expect(parseOverrideKey('nested/b_shape/opacity'))
      .toEqual({ origNodeId: 'nested/b_shape', prop: 'opacity' });
    expect(parseOverrideKey('nokey')).toBeNull();
  });
});

describe('expansion applies the static half', () => {
  // NB: identity (`toBe`) is asserted on the pure helper in `pure helpers`
  // below, not here — a graph node view rebuilds `components` on every access,
  // so array identity never holds through the graph no matter what this code
  // does. Here the claim is only that nothing was CHANGED.
  it('leaves the clone untouched when there are no overrides', () => {
    addShape('b_shape', 'comp_b');
    addInstance('inst1', 'comp_root', 'comp_b');
    expect(cloneNamed('inst1::b_shape').components)
      .toStrictEqual(defaultSceneGraph.getNode('b_shape')!.components);
  });

  it('patches the clone, and never the original', () => {
    addShape('b_shape', 'comp_b', 10);
    addInstance('inst1', 'comp_root', 'comp_b');
    setCompOverride('inst1', 'b_shape', 'x', 400);

    expect(transformProps(cloneNamed('inst1::b_shape')).x).toBe(400);
    expect(transformProps(defaultSceneGraph.getNode('b_shape')!).x).toBe(10);
  });

  it('REPLACES the Transform rather than appending a second one', () => {
    // `readBase` scans every component (last write wins) but `transformComponent`
    // uses `find` (first match). A second appended Transform would make the two
    // readers disagree about one value.
    addShape('b_shape', 'comp_b');
    addInstance('inst1', 'comp_root', 'comp_b');
    setCompOverride('inst1', 'b_shape', 'x', 400);
    const clone = cloneNamed('inst1::b_shape');
    expect(clone.components.filter((c) => c.type === 'Transform')).toHaveLength(1);
    // Non-overridden props survive the rebuild.
    expect(transformProps(clone).width).toBe(20);
    expect(clone.components.some((c) => c.type === 'Style')).toBe(true);
  });

  it('leaves untouched layers sharing the original components', () => {
    addShape('b_shape', 'comp_b');
    addShape('b_other', 'comp_b');
    addInstance('inst1', 'comp_root', 'comp_b');
    setCompOverride('inst1', 'b_shape', 'x', 400);
    expect(cloneNamed('inst1::b_other').components)
      .toStrictEqual(defaultSceneGraph.getNode('b_other')!.components);
    // The override reached the layer it names, and only that one.
    expect(transformProps(cloneNamed('inst1::b_shape')).x).toBe(400);
    expect(transformProps(cloneNamed('inst1::b_other')).x).toBe(10);
  });
});

describe('the headline capability', () => {
  it('two instances of one comp render at different positions', () => {
    addShape('b_shape', 'comp_b', 10);
    addInstance('inst1', 'comp_root', 'comp_b');
    addInstance('inst2', 'comp_root', 'comp_b');
    setCompOverride('inst1', 'b_shape', 'x', 400);

    expect(transformProps(cloneNamed('inst1::b_shape')).x).toBe(400);
    expect(transformProps(cloneNamed('inst2::b_shape')).x).toBe(10);
  });

  it('a nested instance carries its OWN overrides, not the outer instance\'s', () => {
    addComp('comp_c', 'Inner');
    addShape('c_shape', 'comp_c', 10);
    addInstance('b_inner', 'comp_b', 'comp_c');
    addInstance('inst1', 'comp_root', 'comp_b');
    // The override lives on the INNER instance, inside comp_b.
    setCompOverride('b_inner', 'c_shape', 'x', 400);
    expect(transformProps(cloneNamed('inst1::b_inner::c_shape')).x).toBe(400);

    // An outer-instance override naming the same source node does not reach in.
    setCompOverride('inst1', 'c_shape', 'x', 999);
    expect(transformProps(cloneNamed('inst1::b_inner::c_shape')).x).toBe(400);
  });
});

describe('the animated half — the dead-control guard', () => {
  it('overrides a KEYFRAMED property, instead of being outvoted every frame', () => {
    addShape('b_shape', 'comp_b', 10);
    addInstance('inst1', 'comp_root', 'comp_b');
    addInstance('inst2', 'comp_root', 'comp_b');
    // The SOURCE layer is animated: without the shim in buildSnapshot's `anim`,
    // `evaluateNode` returns x=777 for the clone and the static patch is dead.
    defaultAnimation.setKeyframe('b_shape', 'x', 0, 777);

    setCompOverride('inst1', 'b_shape', 'x', 400);

    const layerX = (instId: string): number => {
      const c = snapshot().layers.find((l) => l.id === instId)!;
      return c.precompLayers!.find((l) => l.id === `${instId}::b_shape`)!.x;
    };
    // Overridden instance takes the override; the other still animates.
    expect(layerX('inst1')).toBe(400);
    expect(layerX('inst2')).toBe(777);
  });

  it('reports an overridden prop as not animated, so the UI does not offer a track', () => {
    addShape('b_shape', 'comp_b');
    addInstance('inst1', 'comp_root', 'comp_b');
    defaultAnimation.setKeyframe('b_shape', 'opacity', 0, 20);
    setCompOverride('inst1', 'b_shape', 'opacity', 90);
    const c = snapshot().layers.find((l) => l.id === 'inst1')!;
    expect(c.precompLayers!.find((l) => l.id === 'inst1::b_shape')!.opacity).toBeCloseTo(0.9);
  });

  it('an un-overridden animated prop is untouched', () => {
    addShape('b_shape', 'comp_b');
    addInstance('inst1', 'comp_root', 'comp_b');
    defaultAnimation.setKeyframe('b_shape', 'x', 0, 777);
    setCompOverride('inst1', 'b_shape', 'opacity', 50);
    const c = snapshot().layers.find((l) => l.id === 'inst1')!;
    expect(c.precompLayers!.find((l) => l.id === 'inst1::b_shape')!.x).toBe(777);
  });
});

describe('pure helpers', () => {
  it('overriddenPropsFor returns null rather than an empty set on the hot path', () => {
    expect(overriddenPropsFor(new Map(), 'n')).toBeNull();
    expect(overriddenPropsFor(new Map([[overrideKey('other', 'x'), 1]]), 'n')).toBeNull();
    expect([...overriddenPropsFor(new Map([[overrideKey('n', 'x'), 1]]), 'n')!]).toEqual(['x']);
  });

  it('applyOverridesToComponents returns the SAME array when nothing applies', () => {
    const comps = [{ id: 't', type: 'Transform', props: { x: 1 } }] as unknown as SceneNode['components'];
    expect(applyOverridesToComponents(comps, new Map(), 'n')).toBe(comps);
    expect(applyOverridesToComponents(comps, new Map([[overrideKey('other', 'x'), 5]]), 'n')).toBe(comps);
  });

  it('ignores a key naming a property outside the overridable set', () => {
    const comps = [{ id: 't', type: 'Transform', props: { x: 1 } }] as unknown as SceneNode['components'];
    expect(applyOverridesToComponents(comps, new Map([[overrideKey('n', 'fill'), 5]]), 'n')).toBe(comps);
  });
});

describe('the control is reachable', () => {
  // A section that exists but is never rendered is the "composed but
  // unexecuted" failure this repo has shipped before — tests green, feature
  // absent. So assert the mount, not just the module.

  it('CompOverridesSection is mounted on the placed-composition branch', () => {
    const ui = readSource('layout/Inspector/PrecompControl.tsx');
    expect(ui).toMatch(/import \{ CompOverridesSection \}/);
    expect(ui).toMatch(/<CompOverridesSection nodeId=\{nodeId\} \/>/);
    // It must sit in the `kind === 'comp'` branch — the only one that has a
    // referenced comp to override into.
    const compBranch = ui.slice(ui.indexOf("if (kind === 'comp')"));
    expect(compBranch.indexOf('<CompOverridesSection')).toBeGreaterThan(-1);
  });

  it('the section writes through the same API these tests exercise', () => {
    const ui = readSource('layout/Inspector/CompOverridesSection.tsx');
    expect(ui).toMatch(/setCompOverride\(/);
    expect(ui).toMatch(/clearCompOverridesFor\(/);
    expect(ui).toMatch(/OVERRIDABLE_PROPS/);
    expect(ui).toMatch(/readEssentialProps/);
  });

  it('property menu can promote into Essential Properties', () => {
    const menu = readSource('core/inspector/propertyMenu.ts');
    expect(menu).toMatch(/Add to Essential Properties/);
    expect(menu).toMatch(/setEssentialProp/);
  });
});

/**
 * Source-side promotion — without this, every Transform prop on every direct
 * child appears on every instance. Publishing a curated set is AE's model and
 * is what unlocks nested layers in the instance UI (the engine already
 * resolved grandchild overrides; the listing was the limit).
 */
describe('Essential Properties promotion', () => {
  it('compositionRootOf walks to the parentless root', () => {
    addShape('b_group', 'comp_b');
    addShape('b_deep', 'b_group');
    expect(compositionRootOf('b_deep')).toBe('comp_b');
    expect(compositionRootOf('comp_b')).toBe('comp_b');
    expect(compositionRootOf('missing')).toBeNull();
  });

  it('setEssentialProp publishes and clears keys on the source root', () => {
    addShape('b_shape', 'comp_b');
    expect(readEssentialProps('comp_b').size).toBe(0);
    setEssentialProp('comp_b', 'b_shape', 'opacity', true);
    expect(isEssentialProp('comp_b', 'b_shape', 'opacity')).toBe(true);
    expect([...readEssentialProps('comp_b')]).toEqual([overrideKey('b_shape', 'opacity')]);
    const meta = defaultSceneGraph.getNode('comp_b')!.components[0]!;
    expect((meta.props as Record<string, unknown>)[COMP_ESSENTIAL_PROPS]).toEqual([
      'b_shape/opacity',
    ]);
    setEssentialProp('comp_b', 'b_shape', 'opacity', false);
    expect(readEssentialProps('comp_b').size).toBe(0);
  });

  it('refuses to promote the composition root itself or a non-overridable prop', () => {
    setEssentialProp('comp_b', 'comp_b', 'x', true);
    addShape('b_shape', 'comp_b');
    setEssentialProp('comp_b', 'b_shape', 'width' as 'x', true);
    expect(readEssentialProps('comp_b').size).toBe(0);
  });
});

/**
 * How deep an override can reach — a fact about the ENGINE, written down
 * because a backlog was about to be planned from a guess about it.
 *
 * Listing used to be direct-children-only; with promotion, nested keys appear
 * in the instance UI. The engine always resolved any node id.
 */
describe('override depth', () => {
  it('applies to a GRANDCHILD of the referenced comp, not only a direct child', () => {
    addShape('b_group', 'comp_b');
    addShape('b_deep', 'b_group', 11);
    addInstance('inst1', 'comp_root', 'comp_b');
    setCompOverride('inst1', 'b_deep', 'x', 456);

    expect(transformProps(cloneNamed('inst1::b_deep')).x).toBe(456);
    expect(transformProps(cloneNamed('inst1::b_group')).x).toBe(10);
  });

  it('a grandchild override survives the ANIMATED half too', () => {
    addShape('b_group', 'comp_b');
    addShape('b_deep', 'b_group', 11);
    addInstance('inst1', 'comp_root', 'comp_b');
    addInstance('inst2', 'comp_root', 'comp_b');
    defaultAnimation.setKeyframe('b_deep', 'x', 0, 11);
    defaultAnimation.setKeyframe('b_deep', 'x', 1, 99);
    setCompOverride('inst1', 'b_deep', 'x', 456);

    const find = (layers: ReadonlyArray<{ id: string; x: number; precompLayers?: ReadonlyArray<never> }>, id: string): { x: number } | undefined => {
      for (const l of layers) {
        if (l.id === id) return l;
        const nested = (l as { precompLayers?: typeof layers }).precompLayers;
        if (nested) {
          const hit = find(nested, id);
          if (hit) return hit;
        }
      }
      return undefined;
    };
    const snap = snapshot().layers as never;
    const overridden = find(snap, 'inst1::b_deep');
    const inherited = find(snap, 'inst2::b_deep');
    expect(overridden).toBeTruthy();
    expect(inherited).toBeTruthy();
    expect(overridden!.x - inherited!.x).toBeCloseTo(456 - 11, 9);
  });
});

describe('instances still work at all', () => {
  it('an instance with no overrides expands exactly as before', () => {
    addShape('b_shape', 'comp_b');
    addInstance('inst1', 'comp_root', 'comp_b');
    const out = expand();
    expect(out.find((n) => n.id === 'inst1::b_shape')).toBeTruthy();
    expect(readCompRef(defaultSceneGraph.getNode('inst1')!)).toBe('comp_b');
  });
});
