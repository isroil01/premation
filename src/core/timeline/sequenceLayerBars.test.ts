/**
 * Sequence Layers (bars) — AE's real behaviour: lay the selected layers' clip
 * BARS end-to-end in time. Distinct from the keyframe-stagger assistant.
 */

import { getTimelineController } from './TimelineController';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { SceneNode } from '@core/types';

function node(id: string, parent: string | null = 'comp_root'): SceneNode {
  return {
    id, name: id, parent, children: [],
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    visible: true, locked: false,
    components: [{ id: `${id}_meta`, type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
  } as unknown as SceneNode;
}

function seed(ids: string[]): void {
  const existing: string[] = [];
  defaultSceneGraph.traverse((n) => existing.push(n.id));
  for (const id of existing) defaultSceneGraph.removeNode(id);
  const root = node('comp_root', null);
  root.children = [...ids];
  defaultSceneGraph.addNode(root);
  for (const id of ids) defaultSceneGraph.addNode(node(id));
  getTimelineController().syncFromScene('comp_root');
}

describe('sequenceLayerBars', () => {
  it('lays clip bars end-to-end in order, first layer anchored', () => {
    seed(['a', 'b', 'c']);
    const ctrl = getTimelineController();
    // Give each a distinct duration by trimming the end (start stays 0).
    ctrl.trimClipTo(ctrl.getLayersForNode('a')[0]!.id, 'end', 2);
    ctrl.trimClipTo(ctrl.getLayersForNode('b')[0]!.id, 'end', 3);
    ctrl.trimClipTo(ctrl.getLayersForNode('c')[0]!.id, 'end', 1);

    const ok = ctrl.sequenceLayerBars(['a', 'b', 'c'], 0);
    expect(ok).toBe(true);

    const a = ctrl.getLayersForNode('a')[0]!;
    const b = ctrl.getLayersForNode('b')[0]!;
    const c = ctrl.getLayersForNode('c')[0]!;
    // a stays; b starts at a.end; c starts at b.end — no gaps, no overlap.
    expect(b.start).toBe(a.end);
    expect(c.start).toBe(b.end);
  });

  it('applies an overlap so consecutive bars cross-dissolve', () => {
    seed(['a', 'b']);
    const ctrl = getTimelineController();
    ctrl.trimClipTo(ctrl.getLayersForNode('a')[0]!.id, 'end', 2);
    ctrl.trimClipTo(ctrl.getLayersForNode('b')[0]!.id, 'end', 2);
    const fps = ctrl.timeline.getFrameRate().fps;

    ctrl.sequenceLayerBars(['a', 'b'], 0.5); // half-second overlap

    const a = ctrl.getLayersForNode('a')[0]!;
    const b = ctrl.getLayersForNode('b')[0]!;
    expect(b.start).toBe(a.end - Math.round(0.5 * fps));
  });

  it('returns false with fewer than two layers', () => {
    seed(['solo']);
    expect(getTimelineController().sequenceLayerBars(['solo'], 0)).toBe(false);
    expect(getTimelineController().sequenceLayerBars([], 0)).toBe(false);
  });
});
