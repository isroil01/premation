import { buildSnapshot } from './buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';

/**
 * A light lights 3D layers and nothing else (AE). Its glow wash screen-blends
 * over everything beneath it, so in a comp with no light-accepting 3D layer one
 * point light — plus the Ambient Fill that arrives with it — bleached the comp
 * background and every 2D layer to a flat grey, in the viewport and in the
 * exported file alike.
 */
const COMP = { width: 800, height: 600, background: '#101014' };

const node = (id: string, kind: string, props: Record<string, unknown>): SceneNode => ({
  id, name: id, parent: null, children: [], visible: true, locked: false,
  transform: { position: { x: 400, y: 300 }, rotation: 0, scale: { x: 1, y: 1 } },
  components: [
    { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: kind, x: 400, y: 300, rotation: 0, ...props } },
    { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#2b7eff' } },
  ],
} as unknown as SceneNode);

const washesOf = (g: SceneGraph) =>
  buildSnapshot(g, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP)
    .layers.filter((l) => l.light);

describe('light washes and 2D layers', () => {
  it('a light draws no glow by default — it lights 3D layers and is otherwise invisible (AE)', () => {
    // The mixed comp is the normal one: a 3D element over 2D titles and a
    // background. With the wash on by default, adding the cube brought the grey
    // haze straight back over everything 2D.
    const g = new SceneGraph();
    g.addNode(node('L', 'light', { intensity: 100, radius: 500 }));
    g.addNode(node('A', 'light', { lightType: 'ambient', intensity: 30 }));
    g.addNode(node('wall', 'shape', { is3D: true, z: 200, acceptsLights: true }));
    g.addNode(node('title', 'shape', {}));
    const washes = washesOf(g);
    expect(washes).toHaveLength(2);
    expect(washes.every((w) => w.visible === false)).toBe(true);
  });

  it('still LIGHTS the 3D layer with the glow off — shading is not the wash', () => {
    const g = new SceneGraph();
    g.addNode(node('L', 'light', { intensity: 100, radius: 500 }));
    g.addNode(node('wall', 'shape', { is3D: true, z: 200, acceptsLights: true }));
    const wall = buildSnapshot(g, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP)
      .layers.find((l) => l.id === 'wall')!;
    expect(wall.lighting ?? wall.shade3d).toBeDefined();
  });

  it('Visible Glow brings the wash back for the light that asks for it', () => {
    const g = new SceneGraph();
    g.addNode(node('L', 'light', { intensity: 100, radius: 500, lightGlow: true }));
    g.addNode(node('wall', 'shape', { is3D: true, z: 200, acceptsLights: true }));
    expect(washesOf(g).every((w) => w.visible !== false)).toBe(true);
  });

  it('and it is the flag alone that decides — an asked-for glow draws over a 2D comp too', () => {
    const g = new SceneGraph();
    g.addNode(node('L', 'light', { intensity: 100, radius: 500, lightGlow: true }));
    g.addNode(node('box', 'shape', {}));
    expect(washesOf(g).every((w) => w.visible !== false)).toBe(true);
  });

  it('a purely 2D comp is untouched by a default light and its ambient fill', () => {
    const g = new SceneGraph();
    g.addNode(node('L', 'light', { intensity: 100, radius: 500 }));
    g.addNode(node('A', 'light', { lightType: 'ambient', intensity: 30 }));
    g.addNode(node('box', 'shape', {}));
    expect(washesOf(g).every((w) => w.visible === false)).toBe(true);
  });
});
