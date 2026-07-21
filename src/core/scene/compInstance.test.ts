/**
 * Comp instances — a composition used as a layer inside another composition.
 *
 * The instance node is flagged precomp + `__compRef`; at snapshot time it
 * expands into render-only clones (prefixed ids) routed through the precomp
 * texture path, sampling the ORIGINAL nodes' animation. These tests pin the
 * expansion, the id indirection, cycle safety, and that the render actually
 * contains the referenced comp's content — per instance.
 */

import { expandCompInstances, instanceSourceOf, readCompRef, wouldCreateCompCycle, COMP_REF_PROP } from './compInstance';
import { insertCompInstance } from './sceneInsert';
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

function addShape(id: string, parent: string): void {
  defaultSceneGraph.addChild(parent, {
    id, name: id, parent, children: [], visible: true, locked: false,
    transform: { position: { x: 10, y: 10 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 10, y: 10, width: 20, height: 20 } },
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

beforeEach(() => {
  resetScene();
  addComp('comp_root', 'Main');
  addComp('comp_b', 'Lower Third');
  useProjectStore.getState().actions.replaceComps({
    comp_root: { id: 'comp_root', name: 'Main', width: 1920, height: 1080, fps: 30, durationSeconds: 10, background: '#000', transparent: false, startFrame: 0 },
    comp_b: { id: 'comp_b', name: 'Lower Third', width: 1920, height: 1080, fps: 30, durationSeconds: 10, background: '#000', transparent: false, startFrame: 0 },
  });
  const proj = useProjectStore.getState();
  const tabId = proj.actions.openTab('comp_root', ['comp_root'], 'Main');
  proj.actions.setActiveTab(tabId);
});

describe('expandCompInstances', () => {
  it('returns the input untouched when no instances exist', () => {
    addShape('s1', 'comp_root');
    const nodes = flattenComposition(defaultSceneGraph, 'comp_root');
    expect(expandCompInstances(defaultSceneGraph, nodes, 'comp_root')).toBe(nodes);
  });

  it('appends prefixed clones of the referenced comp after the instance', () => {
    addShape('b_shape', 'comp_b');
    addInstance('inst1', 'comp_root', 'comp_b');
    const nodes = flattenComposition(defaultSceneGraph, 'comp_root');
    const out = expandCompInstances(defaultSceneGraph, nodes, 'comp_root');

    const instIdx = out.findIndex((n) => n.id === 'inst1');
    const clone = out[instIdx + 1]!;
    expect(clone.id).toBe('inst1::b_shape');
    expect(clone.parent).toBe('inst1');
    expect(instanceSourceOf(clone)).toBe('b_shape');
    // The original b_shape is NOT in the host comp's flatten.
    expect(out.some((n) => n.id === 'b_shape')).toBe(false);
  });

  it('two instances of the same comp expand independently', () => {
    addShape('b_shape', 'comp_b');
    addInstance('inst1', 'comp_root', 'comp_b');
    addInstance('inst2', 'comp_root', 'comp_b');
    const out = expandCompInstances(defaultSceneGraph, flattenComposition(defaultSceneGraph, 'comp_root'), 'comp_root');
    expect(out.some((n) => n.id === 'inst1::b_shape')).toBe(true);
    expect(out.some((n) => n.id === 'inst2::b_shape')).toBe(true);
  });

  it('refuses self-reference and reference cycles', () => {
    addShape('b_shape', 'comp_b');
    // comp_b already contains an instance of comp_root → root ⊂ b would cycle.
    addInstance('back_ref', 'comp_b', 'comp_root');
    expect(wouldCreateCompCycle(defaultSceneGraph, 'comp_root', 'comp_b')).toBe(true);
    expect(wouldCreateCompCycle(defaultSceneGraph, 'comp_root', 'comp_root')).toBe(true);

    // Expansion of an (illegally present) cyclic instance terminates and
    // simply skips re-entering the open comp.
    addInstance('inst1', 'comp_root', 'comp_b');
    const out = expandCompInstances(defaultSceneGraph, flattenComposition(defaultSceneGraph, 'comp_root'), 'comp_root');
    expect(out.some((n) => n.id === 'inst1::b_shape')).toBe(true);
    expect(out.some((n) => n.id.includes('back_ref::'))).toBe(false);
  });
});

describe('insertCompInstance', () => {
  it('inserts into the active comp and reads back the reference', () => {
    const id = insertCompInstance('comp_b');
    expect(id).toBeTruthy();
    const node = defaultSceneGraph.getNode(id!)!;
    expect(node.parent).toBe('comp_root');
    expect(readCompRef(node)).toBe('comp_b');
  });

  it('refuses a cycle', () => {
    addInstance('back_ref', 'comp_b', 'comp_root');
    expect(insertCompInstance('comp_b')).toBeNull();
  });
});

describe('render integration', () => {
  it('renders the referenced content inside the instance container, per instance', () => {
    addShape('b_shape', 'comp_b');
    addInstance('inst1', 'comp_root', 'comp_b');
    addInstance('inst2', 'comp_root', 'comp_b');

    const snap = buildSnapshot(defaultSceneGraph, defaultAnimation, 0, undefined, undefined, undefined, undefined, {
      width: 1920, height: 1080, background: '#000', transparent: false, rootId: 'comp_root',
    });

    const containers = snap.layers.filter((l) => l.precompLayers);
    expect(containers.map((c) => c.id).sort()).toEqual(['inst1', 'inst2']);
    for (const c of containers) {
      expect(c.precompLayers!.some((l) => l.id === `${c.id}::b_shape`)).toBe(true);
    }
  });

  it('does not leak the source comp into a snapshot of the source itself', () => {
    addShape('b_shape', 'comp_b');
    addInstance('inst1', 'comp_root', 'comp_b');
    const snap = buildSnapshot(defaultSceneGraph, defaultAnimation, 0, undefined, undefined, undefined, undefined, {
      width: 1920, height: 1080, background: '#000', transparent: false, rootId: 'comp_b',
    });
    // Rendering comp_b directly: just its own shape, no instance machinery.
    expect(snap.layers.some((l) => l.id === 'b_shape')).toBe(true);
    expect(snap.layers.some((l) => l.precompLayers)).toBe(false);
  });
});
