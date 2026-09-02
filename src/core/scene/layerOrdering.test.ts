/**
 * Layer ordering, end to end.
 *
 * Reported as: "in the Scene panel I added two objects and put one over
 * another; I selected the one underneath and used Bring Forward; it is not
 * working correctly."
 *
 * Stacking order lives in ONE place — the parent's child array in the scene
 * graph, back-to-front (index 0 paints first, so it is the bottom). Five
 * consumers project that array and every one of them has to agree:
 *
 *   • `buildSnapshot` emits layers in child order (paint runs back → front);
 *   • the viewport's z-index for hit-testing is the position in that walk;
 *   • the Scene tree lists it REVERSED (front-most at the top row);
 *   • the timeline rows list it reversed too;
 *   • `sceneContentHash` fingerprints it, because the viewport frame cache is
 *     keyed on that hash — this was the one that did not, which is why the
 *     canvas kept the old stack while every panel showed the new one.
 *
 * So the assertions come in sets: the graph moved AND all five agree.
 */

import defaultSceneGraph from './DefaultSceneGraph';
import { arrangeNodes, moveNodeInStack, reorderSiblings } from './parenting';
import { stackOrderedChildren } from './sceneDerive';
import { sceneGraphToTree } from '@layout/Scene/ScenePanel';
import { deriveTimelineTracks } from '@layout/Timeline/deriveTimelineTracks';
import { getTimelineController } from '@core/timeline/TimelineController';
import { buildSnapshot, type SnapshotComp } from '@core/rendering/buildSnapshot';
import { sceneContentHash, resetSceneContentHashMemo } from '@core/rendering/sceneContentHash';
import { createSceneGraphPort } from '@core/workspace/ports';
import { HitTester } from '@motion/workspace';
import { defaultAnimation } from '@motion/animation';
import { useProjectStore } from '@stores/projectStore';
import type { SceneNode } from '@core/types';

const ROOT = 'comp_root';
/** Every layer is the same 100×100 box at the same place, so they all overlap
 *  and only the STACK decides what a click at (120,120) hits. */
const OVERLAP = { x: 120, y: 120 };

function shape(id: string, parent: string): SceneNode {
  return {
    id,
    name: id,
    parent,
    children: [],
    visible: true,
    locked: false,
    transform: { position: { x: 100, y: 100 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      {
        id: `${id}_t`,
        type: 'Transform',
        props: {
          __kind: 'shape', x: 100, y: 100, rotation: 0,
          scaleX: 1, scaleY: 1, anchorX: 0, anchorY: 0, width: 100, height: 100,
        },
      },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#3b8276' } },
    ],
  } as unknown as SceneNode;
}

function group(id: string, parent: string): SceneNode {
  return {
    id,
    name: id,
    parent,
    children: [],
    visible: true,
    locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: `${id}_g`, type: 'Transform', props: { __kind: 'group', x: 0, y: 0 } }],
  } as unknown as SceneNode;
}

/** A fresh composition holding `ids` as siblings, added bottom-first. */
function reset(ids: string[]): void {
  for (const r of [...defaultSceneGraph.getRoots()]) defaultSceneGraph.removeNode(r.id);
  defaultSceneGraph.addNode({
    id: ROOT,
    name: 'Composition 1',
    parent: null,
    children: [],
    visible: true,
    locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: 'comp_root_meta', type: 'group', props: { __kind: 'group' } }],
  } as unknown as SceneNode);
  for (const id of ids) defaultSceneGraph.addChild(ROOT, shape(id, ROOT));
  resetSceneContentHashMemo();
}

// ── The five projections ─────────────────────────────────────────

/** The authority: child order, back → front. */
const stack = (parent = ROOT): string[] =>
  defaultSceneGraph.getChildren(parent).map((n) => n.id);

/** Paint order out of the renderer's snapshot, back → front. */
const paintOrder = (): string[] => {
  const comp: SnapshotComp = { width: 1920, height: 1080, background: '#101014', rootId: ROOT };
  return buildSnapshot(defaultSceneGraph, defaultAnimation, 0, undefined, undefined, undefined, undefined, comp)
    .layers.map((l) => l.id);
};

/** What the Scene panel LISTS under the composition, top row first. */
const panelRows = (): string[] => {
  const comp = sceneGraphToTree().find((n) => n.id === ROOT);
  return (comp?.children ?? []).map((n) => n.id);
};

/** Timeline track rows, top row first. */
const timelineRows = (): string[] =>
  deriveTimelineTracks({ activeCompId: ROOT, compFps: 60, expandedIds: [] }).map((t) => t.id as string);

/** What a click at the overlap selects. */
const hitAtOverlap = (): string | null =>
  new HitTester(createSceneGraphPort()).hitTest(OVERLAP)?.id ?? null;

const contentHash = (): string => {
  resetSceneContentHashMemo();
  return sceneContentHash(defaultSceneGraph, defaultAnimation);
};

/**
 * Assert every consumer agrees with the graph. `expected` is back → front, the
 * child array's own direction; the two panels list it reversed.
 */
function expectStack(expected: string[]): void {
  expect(stack()).toEqual(expected);
  expect(paintOrder()).toEqual(expected);
  expect(panelRows()).toEqual([...expected].reverse());
  expect(timelineRows()).toEqual([...expected].reverse());
  expect(hitAtOverlap()).toBe(expected[expected.length - 1]);
}

describe('the reported bug: Bring Forward on the layer underneath', () => {
  beforeEach(() => reset(['A', 'B']));

  it('starts with B (added second) on top, in every consumer', () => {
    expectStack(['A', 'B']);
  });

  it('brings A above B — graph, paint order, both panels and the click', () => {
    // The exact call `layer.bringForward`, its Ctrl/Cmd+] chord and both
    // context menus all make.
    expect(arrangeNodes(['A'], 'forward')).toBe(true);
    expectStack(['B', 'A']);
  });

  it('moves the viewport frame cache off the pre-reorder frame', () => {
    /*
      THE root cause. The cache key is a content hash of the scene, and the
      hash walked each node's own fields only — parent, flags, transform,
      components. Sibling order is in the PARENT's child array and in nothing
      else, so a pure reorder left every row byte-identical: the key did not
      move, the cached frame was blitted, and the canvas kept the old stacking
      order while the Scene tree and the timeline showed the new one.
    */
    const before = contentHash();
    arrangeNodes(['A'], 'forward');
    expect(contentHash()).not.toBe(before);
  });

  it('returns to the same hash when the move is undone — the cache is not thrown away for nothing', () => {
    const before = contentHash();
    arrangeNodes(['A'], 'forward');
    arrangeNodes(['A'], 'backward');
    expect(stack()).toEqual(['A', 'B']);
    expect(contentHash()).toBe(before);
  });
});

describe('the four arrange verbs on a single layer', () => {
  beforeEach(() => reset(['A', 'B', 'C']));

  it('Bring Forward moves one step toward the front', () => {
    arrangeNodes(['A'], 'forward');
    expectStack(['B', 'A', 'C']);
  });

  it('Send Backward moves one step toward the back', () => {
    arrangeNodes(['C'], 'backward');
    expectStack(['A', 'C', 'B']);
  });

  it('Bring to Front jumps the whole stack', () => {
    arrangeNodes(['A'], 'front');
    expectStack(['B', 'C', 'A']);
  });

  it('Send to Back jumps the whole stack the other way', () => {
    arrangeNodes(['C'], 'back');
    expectStack(['C', 'A', 'B']);
  });
});

describe('no-ops stay no-ops — and say so', () => {
  beforeEach(() => reset(['A', 'B', 'C']));

  it('Bring Forward on the front-most layer changes nothing', () => {
    expect(arrangeNodes(['C'], 'forward')).toBe(false);
    expectStack(['A', 'B', 'C']);
  });

  it('Send Backward on the back-most layer changes nothing', () => {
    expect(arrangeNodes(['A'], 'backward')).toBe(false);
    expectStack(['A', 'B', 'C']);
  });

  it('Bring to Front on the front-most layer changes nothing', () => {
    expect(arrangeNodes(['C'], 'front')).toBe(false);
    expectStack(['A', 'B', 'C']);
  });

  it('an unknown id is refused rather than corrupting the stack', () => {
    expect(arrangeNodes(['nope'], 'front')).toBe(false);
    expectStack(['A', 'B', 'C']);
  });

  it('an empty selection is refused', () => {
    expect(arrangeNodes([], 'forward')).toBe(false);
    expectStack(['A', 'B', 'C']);
  });
});

describe('a multi-selection moves as a block and keeps its internal order', () => {
  beforeEach(() => reset(['A', 'B', 'C', 'D']));

  it('Bring Forward over two adjacent layers actually moves them', () => {
    // The loop-per-layer version moved A up past B and then B back down past
    // A: a net no-op, and the shape of the original report.
    expect(arrangeNodes(['A', 'B'], 'forward')).toBe(true);
    expectStack(['C', 'A', 'B', 'D']);
  });

  it('Send Backward over two adjacent layers moves them one step', () => {
    expect(arrangeNodes(['C', 'D'], 'backward')).toBe(true);
    expectStack(['A', 'C', 'D', 'B']);
  });

  it('Send to Back does not REVERSE the selection', () => {
    // Loop-per-layer sent C to index 0, then D to index 0 — C and D swapped.
    arrangeNodes(['C', 'D'], 'back');
    expectStack(['C', 'D', 'A', 'B']);
  });

  it('Bring to Front keeps stack order, not click order', () => {
    // Selected bottom-last on purpose: Bring to Front must not re-stack the
    // selection among itself.
    arrangeNodes(['C', 'A'], 'front');
    expectStack(['B', 'D', 'A', 'C']);
  });

  it('a block already at the front is a no-op', () => {
    expect(arrangeNodes(['C', 'D'], 'forward')).toBe(false);
    expectStack(['A', 'B', 'C', 'D']);
  });

  it('a non-contiguous selection closes up rather than leapfrogging', () => {
    expect(arrangeNodes(['A', 'C'], 'forward')).toBe(true);
    expectStack(['B', 'A', 'D', 'C']);
  });
});

describe('reorderSiblings — the pure rule the block moves obey', () => {
  const kids = ['A', 'B', 'C', 'D'];

  it('ignores ids that are not siblings', () => {
    expect(reorderSiblings(kids, ['A', 'elsewhere'], 'front')).toEqual(['B', 'C', 'D', 'A']);
  });

  it('never drops or duplicates a sibling', () => {
    for (const action of ['front', 'back', 'forward', 'backward'] as const) {
      for (const sel of [['A'], ['D'], ['A', 'D'], ['B', 'C'], kids]) {
        const out = reorderSiblings(kids, sel, action);
        expect([...out].sort()).toEqual([...kids].sort());
      }
    }
  });

  it('selecting everything can never change anything', () => {
    for (const action of ['forward', 'backward'] as const) {
      expect(reorderSiblings(kids, kids, action)).toEqual(kids);
    }
  });
});

describe('arrange is scoped to the siblings of ONE parent', () => {
  beforeEach(() => {
    reset(['A', 'B']);
    defaultSceneGraph.addChild(ROOT, group('G', ROOT));
    defaultSceneGraph.addChild('G', shape('g1', 'G'));
    defaultSceneGraph.addChild('G', shape('g2', 'G'));
  });

  it('a layer inside a group reorders within the group and never leaves it', () => {
    expect(arrangeNodes(['g1'], 'front')).toBe(true);
    expect(stack('G')).toEqual(['g2', 'g1']);
    expect(stack()).toEqual(['A', 'B', 'G']);
    expect(defaultSceneGraph.getNode('g1')!.parent).toBe('G');
  });

  it('the front-most member of a group cannot be pushed out to the comp', () => {
    expect(arrangeNodes(['g2'], 'forward')).toBe(false);
    expect(stack('G')).toEqual(['g1', 'g2']);
    expect(stack()).toEqual(['A', 'B', 'G']);
  });

  it('a mixed selection reorders each parent within its own list', () => {
    expect(arrangeNodes(['A', 'g1'], 'front')).toBe(true);
    expect(stack()).toEqual(['B', 'G', 'A']);
    expect(stack('G')).toEqual(['g2', 'g1']);
  });

  it('the Scene tree nests the group members the same way it stacks layers', () => {
    arrangeNodes(['g1'], 'front');
    const comp = sceneGraphToTree().find((n) => n.id === ROOT);
    const g = (comp?.children ?? []).find((n) => n.id === 'G');
    expect((g?.children ?? []).map((n) => n.id)).toEqual(['g1', 'g2']);
  });
});

describe('the timeline keeps its clip bars across a reorder', () => {
  beforeEach(() => {
    reset(['A', 'B', 'C']);
    useProjectStore.getState().actions.openTab(ROOT);
    getTimelineController().syncFromScene(ROOT);
  });

  it('every layer still has its bar, and the rows re-stack', () => {
    const controller = getTimelineController();
    const barsBefore = new Map(
      ['A', 'B', 'C'].map((id) => [id, controller.getLayersForNode(id).map((l) => l.id)] as const),
    );
    for (const [id, bars] of barsBefore) {
      expect(bars.length).toBeGreaterThan(0);
      expect(id).toBeTruthy();
    }

    arrangeNodes(['A'], 'front');
    // The structural mirror the app runs on SceneGraphChanged.
    controller.syncFromScene(ROOT);

    // Addressed by NODE id — layer ids are not stable across a sync.
    for (const id of ['A', 'B', 'C']) {
      expect(controller.getLayersForNode(id).length).toBeGreaterThan(0);
    }
    expect(timelineRows()).toEqual(['A', 'C', 'B']);
    // The bars themselves survived: same clip ids, not fresh ones.
    for (const [id, before] of barsBefore) {
      expect(controller.getLayersForNode(id).map((l) => l.id)).toEqual(before);
    }
  });
});

describe('the derivation helpers stay in step', () => {
  beforeEach(() => reset(['A', 'B', 'C']));

  it('stackOrderedChildren is the child array, front first', () => {
    expect(stackOrderedChildren(defaultSceneGraph, ROOT).map((n) => n.id)).toEqual(['C', 'B', 'A']);
  });

  it('moveNodeInStack is arrangeNodes for one layer', () => {
    expect(moveNodeInStack('A', 'forward')).toBe(true);
    expectStack(['B', 'A', 'C']);
  });

  it('setChildOrder refuses anything that is not a permutation', () => {
    expect(defaultSceneGraph.setChildOrder(ROOT, ['A', 'B'])).toBe(false);
    expect(defaultSceneGraph.setChildOrder(ROOT, ['A', 'B', 'ghost'])).toBe(false);
    expect(stack()).toEqual(['A', 'B', 'C']);
    expect(defaultSceneGraph.setChildOrder(ROOT, ['C', 'B', 'A'])).toBe(true);
    expect(stack()).toEqual(['C', 'B', 'A']);
  });
});
