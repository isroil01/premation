/**
 * Animatable variable-font weight: a `fontWeight` track overrides the static
 * string, continuously (not snapped to the nine named stops), clamped to CSS's
 * 1–1000. Static layers are byte-identical to before the feature.
 */

import { buildSnapshot } from './buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { SceneNode } from '@core/types';

const textNode = (id: string, parent: string): SceneNode => ({
  id, name: id, parent, children: [], visible: true, locked: false,
  transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
  components: [
    { id: `${id}_t`, type: 'Text', props: { [SCENE_KIND_PROP]: 'text', x: 400, y: 300, content: 'Hi', fontSize: 48, fontWeight: '700' } },
    { id: `${id}_s`, type: 'Style', props: { opacity: 100 } },
  ],
} as unknown as SceneNode);

const comp = (id: string): SceneNode => ({
  id, name: id, parent: null, children: [], visible: true, locked: false,
  transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
  components: [{ id: `${id}_m`, type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
} as unknown as SceneNode);

function weightAt(anim: AnimationEngine, t: number): string | undefined {
  const g = new SceneGraph();
  g.addNode(comp('root'));
  g.addChild('root', textNode('txt', 'root'));
  const s = buildSnapshot(g, anim, t, undefined, undefined, undefined, undefined, {
    width: 800, height: 600, background: '#000', rootId: 'root',
  } as never);
  return s.layers.find((l) => l.id === 'txt')?.fontWeight;
}

describe('fontWeight animation', () => {
  it('no track → the static string, untouched', () => {
    expect(weightAt(new AnimationEngine(), 0)).toBe('700');
  });

  it('a track overrides the static value and interpolates CONTINUOUSLY', () => {
    const a = new AnimationEngine();
    a.setKeyframe('txt', 'fontWeight', 0, 100);
    a.setKeyframe('txt', 'fontWeight', 1, 900);
    expect(weightAt(a, 0)).toBe('100');
    expect(weightAt(a, 1)).toBe('900');
    // Mid-animation values sit strictly between the endpoints and keep moving
    // — a weight that GLIDES, not one that steps through the named stops.
    const w4 = Number(weightAt(a, 0.4));
    const w6 = Number(weightAt(a, 0.6));
    expect(w4).toBeGreaterThan(100);
    expect(w6).toBeLessThan(900);
    expect(w6).toBeGreaterThan(w4);
  });

  it('clamps a keyframe outside CSS range', () => {
    const a = new AnimationEngine();
    a.setKeyframe('txt', 'fontWeight', 0, -50);
    a.setKeyframe('txt', 'fontWeight', 1, 4000);
    expect(weightAt(a, 0)).toBe('1');
    expect(weightAt(a, 1)).toBe('1000');
  });
});
