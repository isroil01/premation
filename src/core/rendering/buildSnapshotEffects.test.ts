/**
 * Keyframeable effect parameters (Effect Controls / AE stopwatch parity): an
 * effect's amount can be animated on the track `effect.<effectId>`, and
 * buildSnapshot samples it per frame so the compiled CSS filter animates — the
 * same reversible keyframe path as transforms.
 */

import { buildSnapshot } from './buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { effectPropPath } from '@core/effects/effects';

function shapeWithEffect(id: string, effectId: string, amount: number): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 400, y: 300 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 400, y: 300 } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#2b7eff' } },
      { id: `${id}_fx`, type: 'fx', props: { effects: [{ id: effectId, type: 'blur', amount }] } },
    ],
  } as unknown as SceneNode;
}

const comp = { width: 800, height: 600, background: '#101014' };

function layerFilter(graph: SceneGraph, anim: AnimationEngine, id: string, t: number): string | undefined {
  const snap = buildSnapshot(graph, anim, t, undefined, undefined, undefined, undefined, comp);
  return snap.layers.find((l) => l.id === id)?.filter;
}

describe('buildSnapshot — keyframeable effect amounts', () => {
  test('a static (un-keyframed) effect amount produces a constant filter', () => {
    const graph = new SceneGraph();
    graph.addNode(shapeWithEffect('e', 'fx_1', 6));
    const anim = new AnimationEngine();
    expect(layerFilter(graph, anim, 'e', 0)).toContain('blur(6px)');
    expect(layerFilter(graph, anim, 'e', 5)).toContain('blur(6px)');
  });

  test('a keyframed effect amount animates the filter across the playhead', () => {
    const graph = new SceneGraph();
    graph.addNode(shapeWithEffect('e', 'fx_1', 6));
    const anim = new AnimationEngine();
    anim.setKeyframe('e', effectPropPath('fx_1'), 0, 0);
    anim.setKeyframe('e', effectPropPath('fx_1'), 2, 40); // amount = 20 * t

    expect(layerFilter(graph, anim, 'e', 0)).toContain('blur(0px)');
    expect(layerFilter(graph, anim, 'e', 1)).toContain('blur(20px)');
    expect(layerFilter(graph, anim, 'e', 2)).toContain('blur(40px)');
  });
});
