/**
 * F34 — an animated stroke width reaches the renderer.
 *
 * ## The bug
 *
 * `strokeWidth` was registered in `propertyMeta`, so the inspector and the
 * timeline both offered a stopwatch for it. Nothing folded the sampled value
 * into the resolved stroke, so the track was authored and never read: a 6 → 40
 * ramp rendered 5296 stroke pixels at BOTH ends.
 *
 * ## Rule 5·0 — the observable, the layer, the medium
 *
 * The observable is the WIDTH THE RASTERIZER RECEIVES. It is produced by a
 * hand-written fold inside `buildSnapshot`, between two units that each stay
 * green while the feature does nothing (F30): the animation engine samples the
 * track correctly, and the rasterizer strokes correctly at whatever width it is
 * handed. Only the crossing was broken, so the crossing is what this samples —
 * `buildSnapshot(...).layers[].stroke.width`.
 *
 * This mirrors `dashOffsetSnapshot.test.ts`, whose docstring cites F34 as the
 * cautionary example for exactly this shape.
 *
 * ## What the clean fixture would exclude
 *
 * A ramp whose endpoints happen to rasterize alike is what let F34 survive
 * being looked at. The values here are 6 → 40 — the same ones the original
 * measurement used — and `changes across the ramp` asserts the two ends DIFFER
 * rather than merely that each matches its expected number, because "both ends
 * equal" was the actual symptom.
 */

import { buildSnapshot } from '@core/rendering/buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';

const comp = { width: 400, height: 300, background: '#101014' };
const STATIC_WIDTH = 14;
/** The ramp from the original F34 measurement. */
const FROM = 6;
const TO = 40;
const DUR = 2;

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

function scene(): { graph: SceneGraph; anim: AnimationEngine } {
  const graph = new SceneGraph();
  graph.addNode(shapeNode('s'));
  graph.setStroke('s', {
    enabled: true, color: '#33e0a0', width: STATIC_WIDTH, opacity: 1,
    align: 'center', dash: [], cap: 'butt', join: 'miter',
  });
  return { graph, anim: new AnimationEngine() };
}

function strokeAt(graph: SceneGraph, anim: AnimationEngine, t: number) {
  const snap = buildSnapshot(graph, anim, t, undefined, undefined, undefined, undefined, comp);
  const layer = snap.layers.find((l) => l.id === 's');
  expect(layer).toBeDefined();
  return layer!.stroke;
}

/** Linear ramp FROM → TO over DUR seconds. */
function rampWidth(anim: AnimationEngine): void {
  anim.setKeyframe('s', 'strokeWidth', 0, FROM, 'linear');
  anim.setKeyframe('s', 'strokeWidth', DUR, TO, 'linear');
}

describe('the fixture is real', () => {
  it('has a stroke at all — otherwise nothing below means anything', () => {
    const { graph, anim } = scene();
    expect(strokeAt(graph, anim, 0)?.enabled).toBe(true);
  });

  it('a STATIC width survives into the snapshot, unanimated', () => {
    const { graph, anim } = scene();
    expect(strokeAt(graph, anim, 0)?.width).toBe(STATIC_WIDTH);
  });
});

describe('an ANIMATED stroke width reaches the snapshot (F34)', () => {
  it.each([
    ['the start of the ramp', 0, FROM],
    ['halfway, derived on paper: 6 + (40-6)/2', DUR / 2, (FROM + TO) / 2],
    ['the end of the ramp', DUR, TO],
  ])('%s', (_label, t, expected) => {
    const { graph, anim } = scene();
    rampWidth(anim);
    expect(strokeAt(graph, anim, t)?.width).toBeCloseTo(expected, 5);
  });

  it('CHANGES across the ramp — the actual symptom was both ends equal', () => {
    const { graph, anim } = scene();
    rampWidth(anim);
    const a = strokeAt(graph, anim, 0)!.width;
    const b = strokeAt(graph, anim, DUR)!.width;
    expect(a).not.toBeCloseTo(b, 3);
  });

  it('overrides the stored static width rather than being ignored by it', () => {
    // The stored stroke says 14. If the fold read the stored object instead of
    // the sampled map, every time would report 14 and the three rows above
    // would fail — but only if the ramp does not happen to pass through 14.
    const { graph, anim } = scene();
    rampWidth(anim);
    expect(strokeAt(graph, anim, 0)?.width).not.toBe(STATIC_WIDTH);
  });
});

describe('it composes with the other animated stroke properties', () => {
  it('width and dash offset animate on the SAME layer', () => {
    // The chaining lesson already written beside this fold: rebuilding from
    // `baseStroke` instead of `finalStroke` silently drops whichever was
    // applied first. Two animated properties is the only fixture that shows it.
    const { graph, anim } = scene();
    graph.setStroke('s', {
      enabled: true, color: '#33e0a0', width: STATIC_WIDTH, opacity: 1,
      align: 'center', dash: [24, 12], cap: 'butt', join: 'miter',
    });
    rampWidth(anim);
    anim.setKeyframe('s', 'strokeDashOffset', 0, 9, 'linear');
    const s = strokeAt(graph, anim, 0);
    expect({ width: s?.width, dashOffset: s?.dashOffset }).toEqual({ width: FROM, dashOffset: 9 });
  });

  it('width and stroke COLOUR animate on the same layer', () => {
    const { graph, anim } = scene();
    rampWidth(anim);
    anim.setKeyframe('s', 'stroke_r', 0, 1, 'linear');
    anim.setKeyframe('s', 'stroke_g', 0, 0, 'linear');
    anim.setKeyframe('s', 'stroke_b', 0, 0, 'linear');
    anim.setKeyframe('s', 'stroke_a', 0, 1, 'linear');
    const s = strokeAt(graph, anim, 0);
    expect(s?.width).toBeCloseTo(FROM, 5);
    expect(s?.color?.toLowerCase()).toContain('ff0000');
  });
});

describe('values the curve can produce but Canvas2D cannot take', () => {
  it('clamps a negative width to zero', () => {
    // An overshooting ease undershoots between keys, and a negative lineWidth
    // is an exception rather than a thinner stroke. The property's own `min: 0`
    // says the same thing.
    const { graph, anim } = scene();
    anim.setKeyframe('s', 'strokeWidth', 0, -12, 'linear');
    expect(strokeAt(graph, anim, 0)?.width).toBe(0);
  });
});
