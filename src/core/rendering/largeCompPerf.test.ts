/**
 * Scale guards for the large-comp path: snapshot stubs for invisible layers.
 * Not a full UI benchmark — asserts the contract that keeps big comps cheap.
 */

import { buildSnapshot } from './buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';

const COMP = { width: 800, height: 600, background: '#000' };

function shape(id: string, visible: boolean): SceneNode {
  return {
    id,
    name: id,
    parent: null,
    children: [],
    visible,
    locked: false,
    transform: { position: { x: 100, y: 100 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      {
        id: `${id}_t`,
        type: 'Transform',
        props: { [SCENE_KIND_PROP]: 'shape', x: 100, y: 100, rotation: 0, width: 40, height: 40 },
      },
      { id: `${id}_s`, type: 'Style', props: { fill: '#4af', opacity: 100 } },
    ],
  } as unknown as SceneNode;
}

describe('large-comp snapshot stubs', () => {
  it('emits invisible stubs instead of full layers for eye-hidden nodes', () => {
    const g = new SceneGraph();
    const N = 200;
    for (let i = 0; i < N; i++) {
      g.addNode(shape(`L${i}`, i % 5 !== 0)); // every 5th hidden
    }
    const snap = buildSnapshot(g, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP);
    const hidden = snap.layers.filter((l) => l.id.startsWith('L') && l.visible === false);
    expect(hidden.length).toBe(40);
    // Stubs are 1×1 — full materialize uses the shape's authored size (40).
    expect(hidden.every((l) => l.width === 1 && l.height === 1)).toBe(true);
    const visible = snap.layers.filter((l) => l.id.startsWith('L') && l.visible !== false);
    expect(visible.length).toBe(160);
    expect(visible.every((l) => (l.width ?? 0) >= 40)).toBe(true);
  });
});
