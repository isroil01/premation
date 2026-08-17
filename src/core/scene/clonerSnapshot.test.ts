/**
 * Cloners reaching the RENDERER.
 *
 * The unit tests prove the plan and the list surgery. This proves the thing
 * neither can: that `buildSnapshot` emits a layer per clone and applies the
 * offset to the RESOLVED transform.
 *
 * The keyframed case is the one that matters. A cloner offsets what the layer
 * already animates to, so it cannot be a component patch — a keyframed `x`
 * would outvote it every frame — and it cannot use the Essential Properties
 * suppression either, because that REPLACES the animation and the clones are
 * meant to move WITH the layer while spreading apart from each other. Getting
 * that wrong looks like "the cloner works until you animate the layer", which
 * is exactly the class of dead control this codebase keeps finding.
 */

import defaultSceneGraph from './DefaultSceneGraph';
import { SCENE_KIND_PROP } from './seedDefaultScene';
import { buildSnapshot } from '@core/rendering/buildSnapshot';
import { defaultAnimation } from '@motion/animation';
import { useProjectStore } from '@stores/projectStore';
import { CLONER_PROP } from './clonerExpand';
import { DEFAULT_CLONER, type ClonerConfig } from './cloner';
import type { SceneNode } from '@core/types';

const COMP = {
  width: 1920, height: 1080, fps: 30, durationSeconds: 10,
  background: '#000', transparent: false, startFrame: 0,
};

function resetScene(): void {
  const ids: string[] = [];
  defaultSceneGraph.traverse((n) => ids.push(n.id));
  for (const id of ids) defaultSceneGraph.removeNode(id);
  defaultAnimation.clear();
}

function addComp(id: string, name: string): void {
  defaultSceneGraph.addNode({
    id, name, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: `${id}_meta`, type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
  } as unknown as SceneNode);
}

function addShape(id: string, parent: string, cloner?: Partial<ClonerConfig>): void {
  defaultSceneGraph.addChild(parent, {
    id, name: id, parent, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 0, y: 0, width: 20, height: 20 } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#f00' } },
      {
        id: `${id}_fx`,
        type: 'fx',
        props: cloner ? { [CLONER_PROP]: { ...DEFAULT_CLONER, enabled: true, ...cloner } } : {},
      },
    ],
  } as never);
}

const snapshot = (): ReturnType<typeof buildSnapshot> =>
  buildSnapshot(defaultSceneGraph, defaultAnimation, 0, undefined, undefined, undefined, undefined, {
    width: 1920, height: 1080, background: '#000', transparent: false, rootId: 'comp_root',
  });

/** Drawn layers that came from the cloner, in clone order. */
const clones = () => snapshot().layers.filter((l) => l.id.includes('~c'));

beforeEach(() => {
  resetScene();
  addComp('comp_root', 'Main');
  useProjectStore.getState().actions.replaceComps({
    comp_root: { id: 'comp_root', name: 'Main', ...COMP },
  });
  const proj = useProjectStore.getState();
  proj.actions.setActiveTab(proj.actions.openTab('comp_root', ['comp_root'], 'Main'));
});

afterEach(resetScene);

describe('clones reach the renderer', () => {
  it('emits one layer per clone', () => {
    addShape('a', 'comp_root', { mode: 'linear', count: 4, offsetX: 100 });
    expect(clones()).toHaveLength(4);
  });

  it('a layer with no cloner is untouched', () => {
    addShape('a', 'comp_root');
    const layers = snapshot().layers;
    expect(layers.filter((l) => l.id.includes('~c'))).toHaveLength(0);
    expect(layers.find((l) => l.id === 'a')).toBeTruthy();
  });

  it('spreads them along the arrangement', () => {
    addShape('a', 'comp_root', { mode: 'linear', count: 3, offsetX: 100, offsetY: 0 });
    expect(clones().map((l) => Math.round(l.x)).sort((p, q) => p - q)).toEqual([-100, 0, 100]);
  });

  it('lays out a grid centred on the layer', () => {
    addShape('a', 'comp_root', { mode: 'grid', countX: 2, countY: 2, offsetX: 100, offsetY: 60 });
    const pts = clones().map((l) => [Math.round(l.x), Math.round(l.y)]).sort();
    expect(pts).toEqual([[-50, -30], [-50, 30], [50, -30], [50, 30]].sort());
  });
});

describe('the offset applies to the RESOLVED transform', () => {
  it('offsets a KEYFRAMED layer instead of being outvoted by it', () => {
    // THE test. The layer animates to x=500; the clones must sit AROUND that,
    // not at the cloner's raw offsets and not all stacked on 500.
    addShape('a', 'comp_root', { mode: 'linear', count: 3, offsetX: 100, offsetY: 0 });
    defaultAnimation.setKeyframe('a', 'x', 0, 500);
    expect(clones().map((l) => Math.round(l.x)).sort((p, q) => p - q)).toEqual([400, 500, 600]);
  });

  it('every clone animates, not just one', () => {
    // `__instanceSource` is what routes each clone's animation reads to the
    // original's tracks. Without it only the clone whose id matched would move.
    addShape('a', 'comp_root', { mode: 'linear', count: 2, offsetX: 0, offsetY: 0 });
    defaultAnimation.setKeyframe('a', 'y', 0, 250);
    expect(clones().map((l) => Math.round(l.y))).toEqual([250, 250]);
  });

  it('MULTIPLIES scale rather than replacing it', () => {
    addShape('a', 'comp_root', { count: 2, offsetX: 0, step: { ...DEFAULT_CLONER.step, scale: 1 } });
    defaultAnimation.setKeyframe('a', 'scaleX', 0, 2);
    // Clone 0 at ramp 0 → 2 × 1; clone 1 at ramp 1 → 2 × 2.
    expect(clones().map((l) => Math.round(l.scaleX * 100) / 100).sort()).toEqual([2, 4]);
  });

  it('MULTIPLIES opacity rather than replacing it', () => {
    addShape('a', 'comp_root', { count: 2, offsetX: 0, step: { ...DEFAULT_CLONER.step, opacity: -100 } });
    defaultAnimation.setKeyframe('a', 'opacity', 0, 50);
    // Source is 50%; the ramp takes clone 1 to 0.
    const ops = clones().map((l) => Math.round(l.opacity * 100) / 100).sort();
    expect(ops).toEqual([0, 0.5]);
  });

  it('adds rotation on top of the layer’s own', () => {
    addShape('a', 'comp_root', { count: 2, offsetX: 0, step: { ...DEFAULT_CLONER.step, rotation: 90 } });
    defaultAnimation.setKeyframe('a', 'rotation', 0, 45);
    expect(clones().map((l) => Math.round(l.rotation)).sort((p, q) => p - q)).toEqual([45, 135]);
  });
});
