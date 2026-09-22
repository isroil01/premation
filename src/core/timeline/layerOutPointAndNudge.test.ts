/**
 * `]` (move the OUT point to the playhead) and the Alt+Page Up / Down nudge.
 *
 * ── The bug this exists for ────────────────────────────────────────────
 * `]` computes `start = playhead − duration`. For a layer longer than the
 * playhead time — a default layer spans the whole comp, so: always — that is
 * negative, the engine floored it at 0, 0 was where the bar already was, and
 * the move was dropped as a no-op. The key did nothing, silently, for the one
 * case everybody tries first. `[` worked, which made it look like a binding
 * problem rather than arithmetic.
 *
 * The fixture is therefore a FULL-LENGTH layer with the playhead inside it. A
 * short layer parked late in the comp — the convenient fixture — passes against
 * the broken code, because its new start happens to be positive.
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
  // A full controller reset — the registries outlive `defaultSceneGraph.clear()`
  // and `syncFromScene` never touches the geometry of a clip it already has.
  const controller = getTimelineController();
  controller.reset();
  controller.getLayersForNode('a');
  controller.syncFromScene(ROOT);
});

const bar = (nodeId: string) => getTimelineController().getLayersForNode(nodeId)[0]!;
const undo = (): unknown => getCommandSystem().getHistory().undo();

describe('] — move the out point to the playhead', () => {
  it('POSITIVE CONTROL: the fixture is the failing case — start 0, longer than the playhead time', () => {
    const c = getTimelineController();
    c.timeline.seek(60);
    expect(bar('a').start).toBe(0);
    expect(bar('a').duration).toBeGreaterThan(60);
  });

  it('ends the layer at the playhead, starting it before time 0', () => {
    const c = getTimelineController();
    const duration = bar('a').duration;
    c.timeline.seek(60);
    c.moveSelectedEndToPlayhead(['a']);
    expect(bar('a').end).toBe(60);
    expect(bar('a').start).toBe(60 - duration);
    expect(bar('a').start).toBeLessThan(0);
    // A move, not a trim: the length and the source mapping are untouched.
    expect(bar('a').duration).toBe(duration);
  });

  it('gates the layer on the new span — live before the playhead, gone after it', () => {
    const c = getTimelineController();
    c.timeline.seek(60);
    c.moveSelectedEndToPlayhead(['a']);
    expect(bar('a').isActiveAt(0)).toBe(true);
    expect(bar('a').isActiveAt(59)).toBe(true);
    expect(bar('a').isActiveAt(60)).toBe(false);
    // The head that hangs off the front is sampled, not skipped: comp frame 0
    // shows the source frame the bar was shifted past.
    expect(bar('a').clip.sourceFrameAt(0)).toBe(bar('a').clip.sourceIn - bar('a').start);
  });

  it('is one undo for the whole selection', () => {
    const c = getTimelineController();
    c.timeline.seek(60);
    c.moveSelectedEndToPlayhead(['a', 'b']);
    expect([bar('a').end, bar('b').end]).toEqual([60, 60]);
    undo();
    expect([bar('a').start, bar('b').start]).toEqual([0, 0]);
  });

  it('never parks a layer wholly before time 0, where it could not be grabbed back', () => {
    const c = getTimelineController();
    c.timeline.seek(0);
    c.moveSelectedEndToPlayhead(['a']);
    expect(bar('a').end).toBe(1);
  });

  it('leaves a pointer move floored at 0 — only the out-point edits may go negative', () => {
    const c = getTimelineController();
    c.setClipStart(bar('a').id, -2);
    expect(bar('a').start).toBe(0);
  });

  it('[ still moves the in point', () => {
    const c = getTimelineController();
    c.timeline.seek(60);
    c.moveSelectedStartToPlayhead(['a']);
    expect(bar('a').start).toBe(60);
  });
});

describe('nudgeSelectedLayers — Alt+Page Down / Up', () => {
  it('moves every selected bar by the delta, and says so', () => {
    const c = getTimelineController();
    expect(c.nudgeSelectedLayers(['a', 'b'], 10)).toBe(true);
    expect([bar('a').start, bar('b').start]).toEqual([10, 10]);
    expect(c.nudgeSelectedLayers(['a'], -1)).toBe(true);
    expect(bar('a').start).toBe(9);
  });

  it('is ONE undo however many layers moved', () => {
    const c = getTimelineController();
    c.nudgeSelectedLayers(['a', 'b'], 10);
    undo();
    expect([bar('a').start, bar('b').start]).toEqual([0, 0]);
  });

  it('can take a layer earlier than time 0, as AE does', () => {
    const c = getTimelineController();
    expect(c.nudgeSelectedLayers(['a'], -1)).toBe(true);
    expect(bar('a').start).toBe(-1);
  });

  it('reports false — so the key is left alone — with nothing to move', () => {
    const c = getTimelineController();
    expect(c.nudgeSelectedLayers([], 1)).toBe(false);
    expect(c.nudgeSelectedLayers(['no_such_node'], 1)).toBe(false);
    expect(c.nudgeSelectedLayers(['a'], 0)).toBe(false);
  });
});
