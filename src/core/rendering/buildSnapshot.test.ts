import { buildSnapshot } from './buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';

function shapeNode(id: string): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 10, y: 20 }, rotation: 45, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 10, y: 20, rotation: 45 } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#2b7eff' } },
    ],
  } as unknown as SceneNode;
}

describe('buildSnapshot — composition settings', () => {
  const graph = new SceneGraph();
  const anim = new AnimationEngine();

  test('defaults to the previous hardcoded comp when no comp is passed', () => {
    const snap = buildSnapshot(graph, anim, 0);
    expect(snap.width).toBe(1920);
    expect(snap.height).toBe(1080);
    expect(snap.background).toBe('#101014');
    expect(snap.transparent).toBeUndefined();
  });

  test('threads comp size + background into the snapshot', () => {
    const snap = buildSnapshot(graph, anim, 0, undefined, undefined, undefined, undefined, {
      width: 1080,
      height: 1920,
      background: '#ffcc00',
    });
    expect(snap.width).toBe(1080);
    expect(snap.height).toBe(1920);
    expect(snap.background).toBe('#ffcc00');
  });

  test('carries the transparent flag through', () => {
    const snap = buildSnapshot(graph, anim, 0, undefined, undefined, undefined, undefined, {
      width: 1920,
      height: 1080,
      background: '#101014',
      transparent: true,
    });
    expect(snap.transparent).toBe(true);
  });
});

describe('buildSnapshot — per-layer time (E6)', () => {
  const comp = { width: 800, height: 600, background: '#101014' };

  function animatedGraph(): { graph: SceneGraph; anim: AnimationEngine } {
    const graph = new SceneGraph();
    graph.addNode(shapeNode('m'));
    const anim = new AnimationEngine();
    anim.setKeyframe('m', 'x', 0, 0);
    anim.setKeyframe('m', 'x', 2, 200); // x = 100 * t
    return { graph, anim };
  }

  test('a 200% time-stretch samples the animation at half the comp time', () => {
    const { graph, anim } = animatedGraph();
    // At comp t=2, an un-stretched layer is at x=200. Stretched 200% ⇒ source
    // time 1 ⇒ x=100.
    const before = buildSnapshot(graph, anim, 2, undefined, undefined, undefined, undefined, comp).layers[0]!;
    expect(before.x).toBeCloseTo(200);
    graph.setLayerTime('m', { stretch: 200, reverse: false, freeze: false, freezeTime: 0, frameBlend: 'none' });
    const after = buildSnapshot(graph, anim, 2, undefined, undefined, undefined, undefined, comp).layers[0]!;
    expect(after.x).toBeCloseTo(100);
  });

  test('freeze holds the value from the freeze time', () => {
    const { graph, anim } = animatedGraph();
    graph.setLayerTime('m', { stretch: 100, reverse: false, freeze: true, freezeTime: 0.5, frameBlend: 'none' });
    const snap = buildSnapshot(graph, anim, 2, undefined, undefined, undefined, undefined, comp).layers[0]!;
    expect(snap.x).toBeCloseTo(50); // frozen at t=0.5 ⇒ x=50, ignoring comp t=2
  });

  test('reverse plays the animation backwards over its span', () => {
    const { graph, anim } = animatedGraph();
    graph.setLayerTime('m', { stretch: 100, reverse: true, freeze: false, freezeTime: 0, frameBlend: 'none' });
    // Span [0,2]; comp t=0 ⇒ source t=2 ⇒ x=200.
    const snap = buildSnapshot(graph, anim, 0, undefined, undefined, undefined, undefined, comp).layers[0]!;
    expect(snap.x).toBeCloseTo(200);
  });
});

describe('buildSnapshot — fill / stroke / solid', () => {
  const anim = new AnimationEngine();
  const comp = { width: 800, height: 600, background: '#101014' };

  test('reads a fill paint + stroke off the fx component onto the layer', () => {
    const graph = new SceneGraph();
    graph.addNode(shapeNode('s1'));
    graph.setFill('s1', { type: 'linear', angle: 45, stops: [{ id: 'a', offset: 0, color: '#fff' }, { id: 'b', offset: 1, color: '#000' }] });
    graph.setStroke('s1', { enabled: true, color: '#ff0000', width: 5, opacity: 1, align: 'center', dash: [], cap: 'butt', join: 'miter' });
    const layer = buildSnapshot(graph, anim, 0, undefined, undefined, undefined, undefined, comp).layers[0]!;
    expect(layer.fillPaint).toMatchObject({ type: 'linear', angle: 45 });
    expect(layer.stroke).toMatchObject({ color: '#ff0000', width: 5 });
  });

  test('a solid layer is sized + centred to the composition when unseeded', () => {
    const graph = new SceneGraph();
    graph.addNode(shapeNode('bg'));
    graph.setSolid('bg', true);
    const layer = buildSnapshot(graph, anim, 0, undefined, undefined, undefined, undefined, comp).layers[0]!;
    expect(layer.width).toBe(800);
    expect(layer.height).toBe(600);
    expect(layer.x).toBe(400);
    expect(layer.y).toBe(300);
    expect(layer.rotation).toBe(0);
  });

  test('a seeded solid keeps its authored transform (scale / drag work)', () => {
    const graph = new SceneGraph();
    const n = shapeNode('bg2');
    (n.components[0]!.props as Record<string, number>).width = 800;
    (n.components[0]!.props as Record<string, number>).height = 600;
    (n.components[0]!.props as Record<string, number>).x = 400;
    (n.components[0]!.props as Record<string, number>).y = 300;
    (n.components[0]!.props as Record<string, number>).scaleX = 0.5;
    (n.components[0]!.props as Record<string, number>).rotation = 15;
    graph.addNode(n);
    graph.setSolid('bg2', true);
    const layer = buildSnapshot(graph, anim, 0, undefined, undefined, undefined, undefined, comp).layers[0]!;
    expect(layer.width).toBe(800);
    expect(layer.height).toBe(600);
    expect(layer.x).toBe(400);
    expect(layer.y).toBe(300);
    expect(layer.scaleX).toBeCloseTo(0.5);
    expect(layer.rotation).toBeCloseTo(15);
  });

  test('a non-solid shape keeps its fixed kind size', () => {
    const graph = new SceneGraph();
    graph.addNode(shapeNode('s2'));
    const layer = buildSnapshot(graph, anim, 0, undefined, undefined, undefined, undefined, comp).layers[0]!;
    expect(layer.width).toBe(220); // SIZE.shape
    expect(layer.rotation).toBe(45);
  });
});
