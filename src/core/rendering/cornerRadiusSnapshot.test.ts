/**
 * F35 — an animated corner radius reaches the renderer.
 *
 * ## The bug, and how it was found
 *
 * `cornerRadius` was registered keyframeable in `propertyMeta`, so the inspector
 * and timeline offered a stopwatch. The STATIC value was read by the component
 * scan (`num(p.cornerRadius)`), so a rounded rect drew correctly and nothing
 * looked broken — but the animated TRACK was folded nowhere, so a keyframed
 * corner radius did not move.
 *
 * It was not found by looking. The derived sweep added with F34
 * (`__tests__/animatablePropertyReaders.test.ts`) reported it the same day, from
 * the registry's own inventory. That is the difference between fixing an
 * instance and fixing a class.
 *
 * ## Rule 5·0 — the observable, the layer, the medium
 *
 * The observable is THE RADIUS THE RASTERIZER RECEIVES, produced by a fold in
 * `buildSnapshot` that sits between two units which each stay green while the
 * feature does nothing (F30): the engine samples the track, and the rasterizer
 * rounds correctly at whatever radius it is handed. So this samples the crossing
 * — `buildSnapshot(...).layers[].cornerRadius`.
 *
 * ## What the clean fixture would exclude
 *
 * A ramp that PASSES THROUGH the stored static value. The first draft ran 4 → 36
 * against a stored 8, so the ramp crossed 8 partway and a fold still reading
 * `base.cornerRadius` could have matched a row by coincidence. The positive
 * control below caught that. The ramp now runs 20 → 52 against a stored 8, which
 * is outside the range entirely — so a fold that silently kept reading
 * `base.cornerRadius` reports 8 at every time and EVERY row below fails, instead
 * of one of them passing by accident.
 */

import { buildSnapshot } from '@core/rendering/buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';

const comp = { width: 400, height: 300, background: '#101014' };
const STATIC_R = 8;
const FROM = 20;
const TO = 52;
const DUR = 2;

function rectNode(id: string): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 200, y: 150 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      {
        id: `${id}_t`, type: 'Transform',
        props: {
          [SCENE_KIND_PROP]: 'shape', shapeType: 'rect',
          x: 200, y: 150, rotation: 0, width: 160, height: 120,
          cornerRadius: STATIC_R,
        },
      },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#1f4f8f' } },
    ],
  } as unknown as SceneNode;
}

function scene(): { graph: SceneGraph; anim: AnimationEngine } {
  const graph = new SceneGraph();
  graph.addNode(rectNode('r'));
  return { graph, anim: new AnimationEngine() };
}

function radiusAt(graph: SceneGraph, anim: AnimationEngine, t: number): number | undefined {
  const snap = buildSnapshot(graph, anim, t, undefined, undefined, undefined, undefined, comp);
  const layer = snap.layers.find((l) => l.id === 'r');
  expect(layer).toBeDefined();
  return layer!.cornerRadius;
}

function ramp(anim: AnimationEngine): void {
  anim.setKeyframe('r', 'cornerRadius', 0, FROM, 'linear');
  anim.setKeyframe('r', 'cornerRadius', DUR, TO, 'linear');
}

describe('the fixture is real', () => {
  it('POSITIVE CONTROL: the ramp never passes through the stored static value', () => {
    // If it did, a fold still reading `base.cornerRadius` could pass one row by
    // coincidence instead of failing all of them.
    expect(STATIC_R < FROM || STATIC_R > TO).toBe(true);
  });

  it('a STATIC radius survives into the snapshot, unanimated', () => {
    const { graph, anim } = scene();
    expect(radiusAt(graph, anim, 0)).toBe(STATIC_R);
  });
});

describe('an ANIMATED corner radius reaches the snapshot (F35)', () => {
  it.each([
    ['the start of the ramp', 0, FROM],
    ['halfway, derived on paper: 20 + (52-20)/2', DUR / 2, (FROM + TO) / 2],
    ['the end of the ramp', DUR, TO],
  ])('%s', (_label, t, expected) => {
    const { graph, anim } = scene();
    ramp(anim);
    expect(radiusAt(graph, anim, t)).toBeCloseTo(expected, 5);
  });

  it('CHANGES across the ramp — the symptom was a radius that never moved', () => {
    const { graph, anim } = scene();
    ramp(anim);
    expect(radiusAt(graph, anim, 0)).not.toBeCloseTo(radiusAt(graph, anim, DUR)!, 3);
  });

  it('the animated track WINS over the stored static value', () => {
    const { graph, anim } = scene();
    ramp(anim);
    expect(radiusAt(graph, anim, 0)).not.toBe(STATIC_R);
  });
});

describe('values the curve can produce but Canvas2D cannot take', () => {
  it('clamps a negative radius to zero', () => {
    // An overshooting ease undershoots between keys, and a negative radius
    // throws in `roundRect` rather than drawing a sharper corner.
    const { graph, anim } = scene();
    anim.setKeyframe('r', 'cornerRadius', 0, -9, 'linear');
    expect(radiusAt(graph, anim, 0)).toBe(0);
  });
});
