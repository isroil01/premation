/**
 * Text character props (font size / letter spacing / line height) are
 * keyframeable — the renderer must sample the animated value, not just the
 * static base prop. Without this, the inspector stopwatch would be cosmetic.
 */

import { buildSnapshot } from './buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { SceneNode } from '@core/types';

function textNode(id: string, fontSize: number, letterSpacing = 0): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 100, y: 100 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'text', x: 100, y: 100, rotation: 0 } },
      { id: `${id}_c`, type: 'Text', props: { content: 'Hello', fontSize, letterSpacing, opacity: 100 } },
    ],
  } as unknown as SceneNode;
}
const layer = (graph: SceneGraph, anim: AnimationEngine, t: number, id: string) =>
  buildSnapshot(graph, anim, t).layers.find((l) => l.id === id);

describe('text props are keyframeable in the renderer', () => {
  it('samples an animated fontSize over time', () => {
    const graph = new SceneGraph();
    graph.addNode(textNode('t1', 40));
    const anim = new AnimationEngine();
    anim.setKeyframe('t1', 'fontSize', 0, 40);
    anim.setKeyframe('t1', 'fontSize', 1, 120);
    expect(layer(graph, anim, 0, 't1')!.fontSize).toBe(40);
    expect(layer(graph, anim, 1, 't1')!.fontSize).toBe(120);
    // mid-track it interpolates
    expect(layer(graph, anim, 0.5, 't1')!.fontSize).toBeGreaterThan(40);
    expect(layer(graph, anim, 0.5, 't1')!.fontSize).toBeLessThan(120);
  });

  it('samples animated letterSpacing (the classic reveal)', () => {
    const graph = new SceneGraph();
    graph.addNode(textNode('t2', 60, 30));
    const anim = new AnimationEngine();
    anim.setKeyframe('t2', 'letterSpacing', 0, 30);
    anim.setKeyframe('t2', 'letterSpacing', 1, 0);
    expect(layer(graph, anim, 0, 't2')!.letterSpacing).toBe(30);
    expect(layer(graph, anim, 1, 't2')!.letterSpacing).toBe(0);
  });

  it('falls back to the static prop when not animated', () => {
    const graph = new SceneGraph();
    graph.addNode(textNode('t3', 48));
    const anim = new AnimationEngine();
    expect(layer(graph, anim, 2, 't3')!.fontSize).toBe(48);
  });
});
