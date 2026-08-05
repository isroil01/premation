/**
 * Dash offset across the seam: an animation track → `buildSnapshot` → the
 * stroke the rasterizer receives.
 *
 * `dashOffset.test.ts` covers the model, the cache key and the canvas call, and
 * every one of those units can be green while the feature does nothing — because
 * the value only becomes ANIMATED inside `buildSnapshot`, in a hand-written fold
 * that no unit on either side observes (F30). Registering the property in
 * `propertyMeta` puts a stopwatch in the inspector whether or not the renderer
 * reads the track, which is precisely how `strokeWidth` came to be a
 * keyframeable property that changes nothing (F34 — since FIXED, and now guarded
 * by `strokeWidthSnapshot.test.ts` beside this one, plus the derived sweep over
 * the whole class in `__tests__/animatablePropertyReaders.test.ts`).
 *
 * So this asserts the crossing itself, at the only place both halves meet.
 */

import { buildSnapshot } from '@core/rendering/buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';

const comp = { width: 400, height: 300, background: '#101014' };
const DASH = [24, 12];
const PERIOD = DASH[0]! + DASH[1]!;

function shapeNode(id: string): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 200, y: 150 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 200, y: 150, rotation: 0, width: 160, height: 120 } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#1f4f8f' } },
    ],
  } as unknown as SceneNode;
}

function scene(staticOffset?: number): { graph: SceneGraph; anim: AnimationEngine } {
  const graph = new SceneGraph();
  graph.addNode(shapeNode('s'));
  graph.setStroke('s', {
    enabled: true, color: '#33e0a0', width: 14, opacity: 1,
    align: 'center', dash: [...DASH], cap: 'butt', join: 'miter',
    ...(staticOffset === undefined ? {} : { dashOffset: staticOffset }),
  });
  return { graph, anim: new AnimationEngine() };
}

function strokeAt(graph: SceneGraph, anim: AnimationEngine, t: number) {
  const snap = buildSnapshot(graph, anim, t, undefined, undefined, undefined, undefined, comp);
  const layer = snap.layers.find((l) => l.id === 's');
  expect(layer).toBeDefined();
  return layer!.stroke;
}

describe('dash offset reaches the renderer', () => {
  it('the fixture really has a dashed stroke — otherwise nothing below means anything', () => {
    expect(strokeAt(scene().graph, scene().anim, 0)?.dash).toEqual(DASH);
  });

  it('a STATIC offset survives into the snapshot', () => {
    const { graph, anim } = scene(9);
    expect(strokeAt(graph, anim, 0)?.dashOffset).toBe(9);
  });

  it('an ANIMATED offset overrides the stored value and moves with time', () => {
    // The value the renderer sees must come from the track, not the fx object.
    const { graph, anim } = scene(0);
    anim.setKeyframe('s', 'strokeDashOffset', 0, 0);
    anim.setKeyframe('s', 'strokeDashOffset', 2, PERIOD);
    expect(strokeAt(graph, anim, 0)?.dashOffset).toBeCloseTo(0, 6);
    expect(strokeAt(graph, anim, 1)?.dashOffset).toBeCloseTo(PERIOD / 2, 6);
    expect(strokeAt(graph, anim, 2)?.dashOffset).toBeCloseTo(PERIOD, 6);
  });

  it('samples a QUARTER period correctly — not only the endpoints', () => {
    // Endpoints of a 0 → period ramp are the two values that draw the SAME
    // picture. A fixture checking only those cannot tell a working interpolation
    // from one that snaps to whichever keyframe is nearest (rule 3a).
    const { graph, anim } = scene(0);
    anim.setKeyframe('s', 'strokeDashOffset', 0, 0);
    anim.setKeyframe('s', 'strokeDashOffset', 4, PERIOD);
    expect(strokeAt(graph, anim, 1)?.dashOffset).toBeCloseTo(PERIOD / 4, 6);
  });

  it('leaves the offset absent when nothing sets one', () => {
    expect(strokeAt(scene().graph, scene().anim, 0)?.dashOffset).toBeUndefined();
  });

  it('an animated offset and an animated COLOUR both survive together', () => {
    // The two folds are chained. Rebuilding the second from the stored stroke
    // rather than from the first result silently drops whichever ran earlier —
    // and each property tested alone would still pass.
    const { graph, anim } = scene(0);
    anim.setKeyframe('s', 'strokeDashOffset', 0, 9);
    anim.setKeyframe('s', 'stroke_r', 0, 255);
    anim.setKeyframe('s', 'stroke_g', 0, 0);
    anim.setKeyframe('s', 'stroke_b', 0, 0);
    anim.setKeyframe('s', 'stroke_a', 0, 1);
    const stroke = strokeAt(graph, anim, 0);
    expect(stroke?.dashOffset).toBe(9);
    expect(stroke?.color.toLowerCase()).toContain('ff0000');
  });
});
