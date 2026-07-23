import { buildSnapshot } from './buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { readNodeLight } from '@core/scene/light';

const COMP = { width: 800, height: 600, background: '#101014' };

function light(id: string): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 400, y: 300 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'light', x: 400, y: 300, rotation: 0, intensity: 80, radius: 250 } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#ffcc00' } },
    ],
  } as unknown as SceneNode;
}

describe('lights', () => {
  it('readNodeLight reads colour / intensity / radius (with type defaults)', () => {
    expect(readNodeLight(light('L'))).toEqual({
      type: 'point',
      color: '#ffcc00',
      intensity: 80,
      radius: 250,
      angle: 0,
      cone: 45,
      shadows: false,
    });
  });

  it('readNodeLight honours explicit spot config', () => {
    const n = light('S');
    (n.components[0]!.props as Record<string, unknown>).lightType = 'spot';
    (n.components[0]!.props as Record<string, unknown>).lightAngle = 90;
    (n.components[0]!.props as Record<string, unknown>).lightCone = 30;
    const lt = readNodeLight(n);
    expect(lt.type).toBe('spot');
    expect(lt.angle).toBe(90);
    expect(lt.cone).toBe(30);
  });

  it('Draft 3D (comp.draft3d) suppresses light washes and cast shadows', () => {
    const g = new SceneGraph();
    const shadowCaster = light('L');
    (shadowCaster.components[0]!.props as Record<string, unknown>).castShadows = true;
    g.addNode(shadowCaster);
    g.addNode({
      id: 'box', name: 'box', parent: null, children: [], visible: true, locked: false,
      transform: { position: { x: 100, y: 100 }, rotation: 0, scale: { x: 1, y: 1 } },
      components: [
        { id: 'box_t', type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 100, y: 100, rotation: 0 } },
        { id: 'box_s', type: 'Style', props: { opacity: 100, fill: '#3aa' } },
      ],
    } as unknown as SceneNode);

    // Full quality: the light wash layer renders and the shape casts a shadow.
    const full = buildSnapshot(g, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP).layers;
    expect(full.some((l) => l.light)).toBe(true);
    const fullShape = full.find((l) => l.id === 'box')!;
    expect((fullShape.effects ?? []).some((fx) => fx.id === 'cast-shadow')).toBe(true);

    // Draft 3D: same scene, lighting entirely gone — layer set and effects.
    const draft = buildSnapshot(g, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, { ...COMP, draft3d: true }).layers;
    expect(draft.some((l) => l.light)).toBe(false);
    const draftShape = draft.find((l) => l.id === 'box')!;
    expect((draftShape.effects ?? []).some((fx) => fx.id === 'cast-shadow' || fx.id === 'dof')).toBe(false);
    expect(draftShape.filter ?? '').not.toContain('drop-shadow');
  });

  it('buildSnapshot emits a light layer at the light position', () => {
    const g = new SceneGraph();
    g.addNode(light('L'));
    const layers = buildSnapshot(g, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP).layers;
    expect(layers).toHaveLength(1);
    expect(layers[0]!.light).toEqual({
      color: '#ffcc00',
      intensity: 80,
      radius: 250,
      type: 'point',
      angle: 0,
      cone: 45,
    });
    expect(layers[0]!.x).toBeCloseTo(400);
    expect(layers[0]!.y).toBeCloseTo(300);
  });
});
