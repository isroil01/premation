/**
 * Roll edit at the controller level.
 *
 * `Clip.rollClips` already pins the geometry, so what is left to prove here is
 * everything the pure helper cannot see, and every one of these is a way the
 * feature could ship looking correct and behaving wrongly:
 *
 *   • the two bars are found by SCENE NODE. Layer ids are re-minted by
 *     `syncFromScene` after any scene restore, so a roll that captured one
 *     would work once and then quietly address nothing.
 *   • it is ONE history entry. Two `trimLayer` calls produce the same pixels
 *     and a broken intermediate state on the way back out.
 *   • it refuses a pair that does not actually meet, instead of silently
 *     trimming two unrelated bars towards each other.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { setCommandSystem, CommandSystem, getCommandSystem } from '@core/commands/CommandSystem';
import type { SceneNode } from '@core/types';
import { getTimelineController } from './TimelineController';

const ROOT = 'comp_root';

function layer(id: string): void {
  defaultSceneGraph.addChild(ROOT, {
    id,
    name: id,
    parent: ROOT,
    children: [],
    visible: true,
    locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 100, y: 100, width: 50, height: 50 } },
    ],
  } as unknown as SceneNode);
}

beforeEach(() => {
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
  defaultSceneGraph.clear();
  defaultSceneGraph.addNode({
    id: ROOT,
    name: 'Composition 1',
    parent: null,
    children: [],
    visible: true,
    locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: 'comp_root_meta', type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
  } as unknown as SceneNode);
  layer('a');
  layer('b');
  const controller = getTimelineController();
  controller.reset();
  controller.getLayersForNode('a');
  controller.syncFromScene(ROOT);
});

const barOf = (nodeId: string) => getTimelineController().getLayersForNode(nodeId)[0]!;

/**
 * Butt `b` against `a` at `cut`, with real source handles on both sides so the
 * roll has somewhere to go. Seeded bars are unbounded (shapes), so
 * `sourceDuration` is set by hand — the bound is the interesting half.
 */
function butt(cut: number, opts: { leftSource?: number | null; rightSource?: number | null } = {}): void {
  const a = barOf('a');
  const b = barOf('b');
  a.clip.start = 0;
  a.clip.duration = cut;
  a.clip.sourceIn = 10;
  a.clip.sourceDuration = opts.leftSource === undefined ? 200 : opts.leftSource;
  b.clip.start = cut;
  b.clip.duration = 40;
  b.clip.sourceIn = 20;
  b.clip.sourceDuration = opts.rightSource === undefined ? 200 : opts.rightSource;
}

describe('TimelineController.rollEdit', () => {
  it('moves the cut on both bars at once, leaving no gap', () => {
    butt(30);
    const applied = getTimelineController().rollEdit('a', 'b', 6);
    expect(applied).toBe(6);
    expect(barOf('a').end).toBe(36);
    expect(barOf('b').start).toBe(36);
    // The pair still spans exactly what it did.
    expect(barOf('a').start).toBe(0);
    expect(barOf('b').end).toBe(70);
  });

  it('keeps both halves in sync with their source', () => {
    butt(30);
    getTimelineController().rollEdit('a', 'b', 6);
    expect(barOf('a').clip.sourceIn).toBe(10); // head untouched
    expect(barOf('a').clip.sourceOut).toBe(46); // 6 more frames of tail
    expect(barOf('b').clip.sourceIn).toBe(26); // 6 frames of head given up
    expect(barOf('b').clip.sourceOut).toBe(60); // out untouched
  });

  it('clamps to the source handles and reports what it applied', () => {
    // The right bar has only 20 frames of head handle (sourceIn 20).
    butt(30);
    expect(getTimelineController().rollEdit('a', 'b', -100)).toBe(-20);
    expect(barOf('a').end).toBe(10);
    expect(barOf('b').start).toBe(10);
    expect(barOf('b').clip.sourceIn).toBe(0);
  });

  it('is ONE undo entry for both bars', () => {
    // The engine's `history.run` is routed to the APP's command stack by
    // `initTimeline`'s `onPush`, so that — not the engine's local stack, which
    // is bypassed entirely — is where the entry count has to be read.
    butt(30);
    const history = getCommandSystem().getHistory();
    const before = history.getEntries().length;
    getTimelineController().rollEdit('a', 'b', 6);
    expect(history.getEntries().length).toBe(before + 1);
    history.undo();
    // Both bars come back together — the state in between a pair of trims
    // (gap open, or one side moved) must never be reachable.
    expect(barOf('a').end).toBe(30);
    expect(barOf('b').start).toBe(30);
    expect(barOf('a').clip.sourceOut).toBe(40);
    expect(barOf('b').clip.sourceIn).toBe(20);
  });

  it('pushes nothing when the cut is already against its limit', () => {
    butt(30);
    const history = getCommandSystem().getHistory();
    getTimelineController().rollEdit('a', 'b', -20); // exhausts the head handle
    const after = history.getEntries().length;
    expect(getTimelineController().rollEdit('a', 'b', -5)).toBe(0);
    // A no-op roll that still pushed would cost the user a wasted Ctrl+Z.
    expect(history.getEntries().length).toBe(after);
  });

  it('refuses two bars that do not meet', () => {
    const a = barOf('a');
    const b = barOf('b');
    a.clip.start = 0;
    a.clip.duration = 30;
    b.clip.start = 60; // a 30-frame gap
    b.clip.duration = 40;
    expect(getTimelineController().rollEdit('a', 'b', 5)).toBe(0);
    expect(barOf('a').end).toBe(30);
    expect(barOf('b').start).toBe(60);
  });

  it('refuses to roll a node against itself', () => {
    butt(30);
    expect(getTimelineController().rollEdit('a', 'a', 5)).toBe(0);
  });

  it('does not move a locked bar', () => {
    butt(30);
    barOf('b').locked = true;
    expect(getTimelineController().rollEdit('a', 'b', 6)).toBe(0);
    expect(barOf('a').end).toBe(30);
  });

  it('treats an unbounded source as an infinite handle', () => {
    // Shapes and text can be trimmed past any "source" length — only the bars'
    // own durations bound the roll.
    butt(30, { leftSource: null, rightSource: null });
    expect(getTimelineController().rollEdit('a', 'b', 39)).toBe(39);
    expect(barOf('b').duration).toBe(1);
  });
});

describe('TimelineController.rollLimitsFor', () => {
  it('reports the range the UI may drag through', () => {
    butt(30);
    expect(getTimelineController().rollLimitsFor('a', 'b')).toEqual({ min: -20, max: 39 });
  });

  it('is null when there is no cut between the two nodes', () => {
    const b = barOf('b');
    b.clip.start = 500;
    expect(getTimelineController().rollLimitsFor('a', 'b')).toBeNull();
  });
});

describe('rollEditSeconds', () => {
  it('converts to whole frames on the comp frame rate', () => {
    butt(30);
    const fps = getTimelineController().fps;
    const applied = getTimelineController().rollEditSeconds('a', 'b', 6 / fps);
    expect(applied).toBe(6);
    expect(barOf('a').end).toBe(36);
  });
});
