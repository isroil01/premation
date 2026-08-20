/**
 * Compositions as a real, insertable entity.
 *
 * Before this, nothing ever inserted into `projectStore.comps`: the table was
 * seeded with one entry and `updateComp` only patched existing keys. So "New
 * Composition" could do nothing but overwrite the single comp and wipe the
 * scene — Reset Project wearing the wrong label — and AE's core organising unit
 * effectively did not exist.
 */

import { createComposition, createOrAdoptComposition, deleteComposition, duplicateComposition, pristineCompToAdopt, renameComposition } from './compositionOps';
import { defaultAnimation } from '@motion/animation';
import { useProjectStore } from '@stores/projectStore';
import { buildSnapshot } from '@core/rendering/buildSnapshot';
import { flattenComposition } from '@core/scene/sceneDerive';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';

/** Add a shape layer INTO a composition (addChild links parent → children). */
function addLayer(id: string, parent: string): void {
  defaultSceneGraph.addChild(parent, {
    id, name: id, parent, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 10, y: 10, width: 20, height: 20 } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#fff' } },
    ],
  } as never);
}

function resetScene(): void {
  const ids: string[] = [];
  defaultSceneGraph.traverse((n) => ids.push(n.id));
  for (const id of ids) defaultSceneGraph.removeNode(id);
}

beforeEach(() => {
  resetScene();
  // The seeded default comp + its root node.
  defaultSceneGraph.addNode({
    id: 'comp_root', name: 'Main', parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: 'comp_root_meta', type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
  } as unknown as SceneNode);
  useProjectStore.getState().actions.replaceComps({
    comp_root: {
      id: 'comp_root', name: 'Main', width: 1920, height: 1080, fps: 30,
      durationSeconds: 10, background: '#101014', transparent: false, startFrame: 0,
    },
  });
});

describe('createOrAdoptComposition — the pristine-comp adoption', () => {
  const markPristine = (): void => {
    useProjectStore.getState().actions.updateComp('comp_root', { pristine: true });
  };

  it('a pristine, layerless comp is ADOPTED: configured in place, no second comp', () => {
    markPristine();
    const id = createOrAdoptComposition({ name: 'Mine', width: 800, height: 600, fps: 24 });
    expect(id).toBe('comp_root');
    const comps = useProjectStore.getState().comps;
    expect(Object.keys(comps)).toHaveLength(1);
    expect(comps.comp_root!.name).toBe('Mine');
    expect(comps.comp_root!.width).toBe(800);
    expect(comps.comp_root!.pristine).toBeUndefined();
    // The scene root carries the name the panels show.
    expect(defaultSceneGraph.getNode('comp_root')!.name).toBe('Mine');
  });

  it('a pristine comp the user has DRAWN INTO is theirs by use — never adopted', () => {
    markPristine();
    addLayer('mine', 'comp_root');
    const id = createOrAdoptComposition({ name: 'Second' });
    expect(id).not.toBe('comp_root');
    expect(Object.keys(useProjectStore.getState().comps)).toHaveLength(2);
    expect(useProjectStore.getState().comps.comp_root!.name).toBe('Main');
  });

  it('a real (non-pristine) comp is never adopted', () => {
    const id = createOrAdoptComposition({ name: 'Second' });
    expect(id).not.toBe('comp_root');
    expect(Object.keys(useProjectStore.getState().comps)).toHaveLength(2);
  });

  it('pristineCompToAdopt reports the adoptable comp, and only then', () => {
    expect(pristineCompToAdopt()).toBeNull();
    markPristine();
    expect(pristineCompToAdopt()).toBe('comp_root');
    addLayer('used', 'comp_root');
    expect(pristineCompToAdopt()).toBeNull();
  });
});

describe('createComposition', () => {
  it('adds a comp instead of replacing the existing one', () => {
    createComposition({ name: 'Second', width: 800, height: 600, fps: 24 });

    const comps = useProjectStore.getState().comps;
    expect(Object.keys(comps)).toHaveLength(2);
    expect(comps.comp_root).toMatchObject({ name: 'Main', width: 1920 });
  });

  it('does NOT wipe existing layers', () => {
    addLayer('keep_me', 'comp_root');

    createComposition({ name: 'Second' });

    // The regression: this used to clear the scene graph and every keyframe.
    expect(defaultSceneGraph.getNode('keep_me')).toBeDefined();
  });

  it('gives the comp a scene root whose id is the comp id', () => {
    const id = createComposition({ name: 'Second' });
    const root = defaultSceneGraph.getNode(id);
    expect(root).toBeDefined();
    expect(root!.parent).toBeNull();
  });

  it('opens and activates a tab for the new comp', () => {
    const id = createComposition({ name: 'Second' });
    const s = useProjectStore.getState();
    const active = s.activeTabId ? s.tabs[s.activeTabId] : null;
    expect(active?.compositionId).toBe(id);
  });

  it('honours an explicit id so redo stays stable', () => {
    // A fresh id on redo would orphan later history entries pointing at it.
    expect(createComposition({ id: 'comp_fixed', name: 'X' })).toBe('comp_fixed');
  });

  it('keeps each comp on its own settings', () => {
    const id = createComposition({ name: 'Square', width: 500, height: 500, fps: 60 });
    const comps = useProjectStore.getState().comps;
    expect(comps[id]).toMatchObject({ width: 500, height: 500, fps: 60 });
    expect(comps.comp_root).toMatchObject({ width: 1920, height: 1080, fps: 30 });
  });
});

describe('composition scoping', () => {
  it('flattenComposition returns only that comp subtree', () => {
    addLayer('a', 'comp_root');
    const second = createComposition({ name: 'Second' });
    addLayer('b', second);

    expect(flattenComposition(defaultSceneGraph, 'comp_root').map((n) => n.id)).toEqual(['comp_root', 'a']);
    expect(flattenComposition(defaultSceneGraph, second).map((n) => n.id)).toEqual([second, 'b']);
  });

  it('falls back to the whole scene for a missing root', () => {
    addLayer('a', 'comp_root');
    expect(flattenComposition(defaultSceneGraph, 'nope').length).toBeGreaterThan(0);
  });

  it('renders ONE composition, not every comp at once', () => {
    addLayer('a', 'comp_root');
    const second = createComposition({ name: 'Second' });
    addLayer('b', second);

    const render = (rootId: string) =>
      buildSnapshot(defaultSceneGraph, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, {
        width: 800, height: 600, background: '#000', rootId,
      }).layers.map((l) => l.id);

    // Without rootId the renderer walks every root and draws both comps.
    expect(render('comp_root')).toContain('a');
    expect(render('comp_root')).not.toContain('b');
    expect(render(second)).toContain('b');
    expect(render(second)).not.toContain('a');
  });
});

describe('renameComposition', () => {
  it('renames the settings entry AND the scene root', () => {
    // The panels read the name off the scene root; the comp table drives the
    // tab. Both must move together or they disagree.
    renameComposition('comp_root', 'Renamed');
    expect(useProjectStore.getState().comps.comp_root!.name).toBe('Renamed');
    expect(defaultSceneGraph.getNode('comp_root')!.name).toBe('Renamed');
  });

  it('ignores an empty name', () => {
    renameComposition('comp_root', '   ');
    expect(useProjectStore.getState().comps.comp_root!.name).toBe('Main');
  });
});

describe('duplicateComposition', () => {
  beforeEach(() => {
    useProjectStore.getState().actions.updateComp('comp_root', { width: 640, height: 480, fps: 24 });
  });

  it('copies the settings under a new id', () => {
    const copy = duplicateComposition('comp_root')!;
    const comps = useProjectStore.getState().comps;
    expect(copy).not.toBe('comp_root');
    expect(comps[copy]).toMatchObject({ width: 640, height: 480, fps: 24, name: 'Main copy' });
  });

  it('copies the layers with fresh ids', () => {
    addLayer('orig', 'comp_root');
    const copy = duplicateComposition('comp_root')!;

    const copied = flattenComposition(defaultSceneGraph, copy).filter((n) => n.id !== copy);
    expect(copied).toHaveLength(1);
    expect(copied[0]!.id).not.toBe('orig');
    // The original is untouched.
    expect(defaultSceneGraph.getNode('orig')).toBeDefined();
  });

  it('remaps parents so the copy never points back at the original', () => {
    addLayer('parent', 'comp_root');
    addLayer('child', 'parent');
    const copy = duplicateComposition('comp_root')!;

    const nodes = flattenComposition(defaultSceneGraph, copy);
    const ids = new Set(nodes.map((n) => n.id));
    for (const n of nodes) {
      if (n.parent != null) expect(ids.has(n.parent)).toBe(true);
    }
  });

  it('copies the keyframes on every layer', () => {
    addLayer('anim', 'comp_root');
    defaultAnimation.setKeyframe('anim', 'x', 0, 0);
    defaultAnimation.setKeyframe('anim', 'x', 1, 200);

    const copy = duplicateComposition('comp_root')!;
    const clone = flattenComposition(defaultSceneGraph, copy).find((n) => n.id !== copy)!;

    // Keyframes live per node id — a subtree copy alone would lose them.
    expect(defaultAnimation.getTrackKeyframes(clone.id, 'x')).toHaveLength(2);
    expect(defaultAnimation.sample(clone.id, 'x', 1)).toBe(200);
  });

  it('leaves the copy independent of the original', () => {
    addLayer('anim', 'comp_root');
    defaultAnimation.setKeyframe('anim', 'x', 0, 0);
    const copy = duplicateComposition('comp_root')!;
    const clone = flattenComposition(defaultSceneGraph, copy).find((n) => n.id !== copy)!;

    defaultAnimation.setKeyframe(clone.id, 'x', 0, 999);

    expect(defaultAnimation.sample('anim', 'x', 0)).toBe(0);
  });

  it('returns null for an unknown comp', () => {
    expect(duplicateComposition('nope')).toBeNull();
  });
});

describe('deleteComposition', () => {
  it('removes the comp, its layers and its tab', () => {
    const id = createComposition({ name: 'Second' });
    addLayer('gone', id);

    expect(deleteComposition(id)).toBe(true);
    expect(useProjectStore.getState().comps[id]).toBeUndefined();
    expect(defaultSceneGraph.getNode(id)).toBeUndefined();
    expect(Object.values(useProjectStore.getState().tabs).some((t) => t.compositionId === id)).toBe(false);
  });

  it('leaves other comps alone', () => {
    addLayer('keep', 'comp_root');
    const id = createComposition({ name: 'Second' });

    deleteComposition(id);

    expect(useProjectStore.getState().comps.comp_root).toBeDefined();
    expect(defaultSceneGraph.getNode('keep')).toBeDefined();
  });

  it('takes the layers\' animation with it — no orphan tracks in the document', () => {
    const id = createComposition({ name: 'Second' });
    addLayer('animated_gone', id);
    defaultAnimation.setKeyframe('animated_gone', 'x', 0, 42);
    defaultAnimation.setKeyframe(id, 'timeRemap', 0, 0); // comp-level track on the root

    deleteComposition(id);

    // clearNode drops the whole node entry; tracksFor of a cleared node is [].
    expect(defaultAnimation.tracksFor('animated_gone')).toHaveLength(0);
    expect(defaultAnimation.tracksFor(id)).toHaveLength(0);
  });

  it('deleting the last composition lands on the empty project — a fresh pristine comp', () => {
    // The engine still needs a root, but the USER asked for zero comps: the
    // deleted one goes, and a pristine scaffolding comp (the "(none)" state)
    // stands in — unlisted, unadopted, with no tab open.
    expect(deleteComposition('comp_root')).toBe(true);

    const comps = Object.values(useProjectStore.getState().comps);
    expect(useProjectStore.getState().comps.comp_root).toBeUndefined();
    expect(defaultSceneGraph.getNode('comp_root')).toBeUndefined();
    expect(comps).toHaveLength(1);
    expect(comps[0]!.pristine).toBe(true);
    // The replacement has a scene root and no open tab of its own.
    expect(defaultSceneGraph.getNode(comps[0]!.id)).toBeDefined();
    expect(Object.values(useProjectStore.getState().tabs).some((t) => t.compositionId === comps[0]!.id)).toBe(false);
  });

  it('ignores an unknown id', () => {
    createComposition({ name: 'Second' });
    expect(deleteComposition('nope')).toBe(false);
  });
});
