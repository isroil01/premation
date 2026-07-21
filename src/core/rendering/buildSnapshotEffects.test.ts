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
import { snapshotToFrameScene } from './snapshotToFrameScene';

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

describe('buildSnapshot — DOF blur / cast shadow as GPU effect entries', () => {
  function bareShape(id: string, extra: Record<string, unknown> = {}): SceneNode {
    return {
      id, name: id, parent: null, children: [], visible: true, locked: false,
      transform: { position: { x: 240, y: 180 }, rotation: 0, scale: { x: 1, y: 1 } },
      components: [
        { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 240, y: 180, width: 100, height: 80, ...extra } },
        { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#4ad0a0' } },
      ],
    } as unknown as SceneNode;
  }

  test('an out-of-focus 3D layer gets a synthetic blur effect (and the CSS filter twin)', () => {
    const graph = new SceneGraph();
    graph.addNode(bareShape('far', { z: 600 }));
    graph.addNode({
      id: 'cam', name: 'cam', parent: null, children: [], visible: true, locked: false,
      transform: { position: { x: 240, y: 180 }, rotation: 0, scale: { x: 1, y: 1 } },
      components: [
        { id: 'cam_t', type: 'Transform', props: { [SCENE_KIND_PROP]: 'camera', x: 240, y: 180, z: -1000, focalLength: 1000, dofStrength: 24, focusDistance: 1000, dofAperture: 40 } },
      ],
    } as unknown as SceneNode);
    const snap = buildSnapshot(graph, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, comp);
    const layer = snap.layers.find((l) => l.id === 'far')!;
    const blurFx = layer.effects?.find((e) => e.id === 'dof' && e.type === 'blur');
    expect(blurFx).toBeDefined();
    // depth 1600 vs focus 1000 → defocus 0.6 → min(24, 0.6·40) = 24
    expect(blurFx!.params?.amount).toBe(24);
    expect(layer.filter).toContain('blur(24.0px)');
    // And it reaches the GPU scene: hasEffects flips on and the renderable
    // carries a blur spatial effect for CompositionPass.
    const scene = snapshotToFrameScene(snap);
    expect(scene.hasEffects).toBe(true);
    const r = scene.renderables.find((x) => x.id === 'far')!;
    expect(r.effects?.some((e) => e.type === 'blur' && e.radiusPx === 24)).toBe(true);
    // Determinism: a second identical build emits an identical entry.
    const snap2 = buildSnapshot(graph, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, comp);
    expect(snap2.layers.find((l) => l.id === 'far')!.effects).toEqual(layer.effects);
  });

  test('a shadow-casting light appends a drop-shadow effect pointing away from it', () => {
    const graph = new SceneGraph();
    graph.addNode(bareShape('p'));
    graph.addNode({
      id: 'L', name: 'L', parent: null, children: [], visible: true, locked: false,
      transform: { position: { x: 140, y: 80 }, rotation: 0, scale: { x: 1, y: 1 } },
      components: [
        { id: 'L_t', type: 'Transform', props: { [SCENE_KIND_PROP]: 'light', x: 140, y: 80, intensity: 100, radius: 320, lightType: 'point', castShadows: true } },
        { id: 'L_s', type: 'Style', props: { opacity: 100, fill: '#ffcc55' } },
      ],
    } as unknown as SceneNode);
    const snap = buildSnapshot(graph, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, comp);
    const layer = snap.layers.find((l) => l.id === 'p')!;
    const shadowFx = layer.effects?.find((e) => e.id === 'cast-shadow' && e.type === 'drop-shadow');
    expect(shadowFx).toBeDefined();
    // intensity 100 → strength 1 → distance 16, softness 14, opacity 45%,
    // angle = atan2(100, 100) = 45° (layer at 240,180; light at 140,80).
    expect(shadowFx!.params).toEqual({ distance: 16, angle: 45, softness: 14, color: '#000000', opacity: 45 });
    expect(layer.filter).toContain('drop-shadow(');
  });

  test('DOF/shadow entries do NOT change the layer contentHash (raster cache stays transform-invariant)', () => {
    const withCam = new SceneGraph();
    withCam.addNode(bareShape('s', { z: 600 }));
    withCam.addNode({
      id: 'cam', name: 'cam', parent: null, children: [], visible: true, locked: false,
      transform: { position: { x: 240, y: 180 }, rotation: 0, scale: { x: 1, y: 1 } },
      components: [
        { id: 'cam_t', type: 'Transform', props: { [SCENE_KIND_PROP]: 'camera', x: 240, y: 180, z: -1000, focalLength: 1000, dofStrength: 24, focusDistance: 1000, dofAperture: 40 } },
      ],
    } as unknown as SceneNode);
    const noCam = new SceneGraph();
    noCam.addNode(bareShape('s', { z: 600 }));
    const a = buildSnapshot(withCam, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, comp).layers.find((l) => l.id === 's')!;
    const b = buildSnapshot(noCam, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, comp).layers.find((l) => l.id === 's')!;
    expect(a.effects?.some((e) => e.id === 'dof')).toBe(true);
    expect(b.effects ?? []).toHaveLength(0);
    expect(a.contentHash).toBe(b.contentHash);
  });
});

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
