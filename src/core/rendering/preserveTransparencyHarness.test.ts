/**
 * End-to-end: harness-shaped scene → snapshot → FrameScene must carry PUT
 * onto the magenta layer and force hasEffects (samplable backdrop target).
 */
import { buildSnapshot } from './buildSnapshot';
import { snapshotToFrameScene } from './snapshotToFrameScene';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { SceneNode } from '@core/types';

const COMP = { width: 320, height: 220, background: '#0c0c12' };

function node(
  id: string,
  opts: {
    kind: string;
    position?: { x: number; y: number };
    transform?: Record<string, unknown>;
    style?: Record<string, unknown>;
  },
): SceneNode {
  const { kind, position = { x: 0, y: 0 }, transform = {}, style } = opts;
  const comps: Array<{ id: string; type: string; props: Record<string, unknown> }> = [
    {
      id: `${id}_t`,
      type: 'Transform',
      props: { [SCENE_KIND_PROP]: kind, x: position.x, y: position.y, rotation: 0, ...transform },
    },
  ];
  if (style) comps.push({ id: `${id}_s`, type: 'Style', props: { opacity: 100, ...style } });
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position, rotation: 0, scale: { x: 1, y: 1 } },
    components: comps,
  } as unknown as SceneNode;
}

describe('preserve-transparency harness scene routing', () => {
  it('flags the top layer and forces a samplable scene target', () => {
    const g = new SceneGraph();
    g.addNode(node('base', {
      kind: 'shape',
      position: { x: 160, y: 110 },
      transform: { width: 200, height: 160, shapeType: 'ellipse' },
      style: { fill: '#1ec8ff' },
    }));
    g.addNode(node('top', {
      kind: 'shape',
      position: { x: 160, y: 110 },
      transform: { width: 280, height: 180, shapeType: 'rect' },
      style: { fill: '#ff2d55' },
    }));
    g.setFxKey('top', 'preserveTransparency', true);

    const snap = buildSnapshot(g, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP as never);
    const top = snap.layers.find((l) => l.id === 'top');
    const base = snap.layers.find((l) => l.id === 'base');
    expect(base).toBeDefined();
    expect(top).toBeDefined();
    expect(top!.preserveTransparency).toBe(true);
    expect(top!.blend ?? 'normal').toBe('normal');

    const scene = snapshotToFrameScene(snap);
    expect(scene.hasEffects).toBe(true);
    const rTop = scene.renderables.find((r) => r.id === 'top');
    expect(rTop?.preserveTransparency).toBe(true);
    // Paint order: base under top.
    const iBase = scene.renderables.findIndex((r) => r.id === 'base');
    const iTop = scene.renderables.findIndex((r) => r.id === 'top');
    expect(iBase).toBeGreaterThanOrEqual(0);
    expect(iTop).toBeGreaterThan(iBase);
  });
});
