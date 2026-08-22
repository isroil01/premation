/**
 * Appearance Fill / Stroke / Corners on image layers must reach the renderer.
 *
 * Textured quads ignore shape SDF corner radius and paint fill; without the
 * snapshot compiling those controls into mask + GPU effects, the inspector
 * silently does nothing — the same class of bug as paint stroke on photos.
 */

import { buildSnapshot } from './buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';

const COMP = { width: 1920, height: 1080, background: '#000', rootId: 'root' };

function imageScene(opts: {
  cornerRadius?: number;
  fill?: { type: 'solid'; color: string };
  stroke?: { enabled: boolean; width: number; color: string; opacity: number };
}) {
  const g = new SceneGraph();
  g.addNode({
    id: 'root', name: 'root', parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: 'root_t', type: 'Transform', props: { [SCENE_KIND_PROP]: 'group' } }],
  } as unknown as SceneNode);
  g.addChild('root', {
    id: 'photo', name: 'photo', parent: 'root', children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      {
        id: 'photo_t',
        type: 'Transform',
        props: {
          [SCENE_KIND_PROP]: 'image',
          x: 960, y: 540, width: 400, height: 300,
          src: 'blob:photo',
        },
      },
      {
        id: 'photo_s',
        type: 'Style',
        props: {
          opacity: 100,
          ...(opts.cornerRadius !== undefined ? { cornerRadius: opts.cornerRadius } : {}),
        },
      },
      {
        id: 'photo_fx',
        type: 'fx',
        props: {
          ...(opts.fill ? { fill: opts.fill } : {}),
          ...(opts.stroke ? { stroke: opts.stroke } : {}),
        },
      },
    ],
  } as unknown as SceneNode);
  return buildSnapshot(g, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP as never);
}

describe('image Appearance styles', () => {
  it('corner radius synthesizes a rounded mask on the image layer', () => {
    const layer = imageScene({ cornerRadius: 24 }).layers.find((l) => l.id === 'photo')!;
    expect(layer.cornerRadius).toBe(24);
    expect(layer.mask?.paths.length).toBeGreaterThan(0);
    expect(layer.mask!.paths.some((p) => p.points.length === 8)).toBe(true);
  });

  it('solid Appearance fill compiles to a GPU fill effect', () => {
    const layer = imageScene({ fill: { type: 'solid', color: '#ff0000' } }).layers.find((l) => l.id === 'photo')!;
    expect(layer.effects?.some((e) => e.id === 'paintfill:primary' && e.type === 'fill')).toBe(true);
  });

  it('Appearance stroke compiles to a GPU stroke effect', () => {
    const layer = imageScene({
      stroke: { enabled: true, width: 4, color: '#00ff00', opacity: 1 },
    }).layers.find((l) => l.id === 'photo')!;
    expect(layer.effects?.some((e) => e.id === 'paintstroke:primary' && e.type === 'stroke')).toBe(true);
  });

  it('per-corner Appearance radii synthesize a rounded mask on the image', () => {
    const g = new SceneGraph();
    g.addNode({
      id: 'root', name: 'root', parent: null, children: [], visible: true, locked: false,
      transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
      components: [{ id: 'root_t', type: 'Transform', props: { [SCENE_KIND_PROP]: 'group' } }],
    } as unknown as SceneNode);
    g.addChild('root', {
      id: 'photo', name: 'photo', parent: 'root', children: [], visible: true, locked: false,
      transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
      components: [
        {
          id: 'photo_t',
          type: 'Transform',
          props: {
            [SCENE_KIND_PROP]: 'image',
            x: 960, y: 540, width: 400, height: 300,
            src: 'blob:photo',
          },
        },
        {
          id: 'photo_s',
          type: 'Style',
          props: {
            opacity: 100,
            cornerRadius: 8,
            cornerRadiusTL: 40,
            cornerRadiusTR: 4,
            cornerRadiusBR: 40,
            cornerRadiusBL: 4,
            cornersLinked: false,
          },
        },
      ],
    } as unknown as SceneNode);
    const layer = buildSnapshot(g, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP as never)
      .layers.find((l) => l.id === 'photo')!;
    expect(layer.cornerRadii).toEqual([40, 4, 40, 4]);
    expect(layer.mask?.paths.some((p) => p.points.length === 8)).toBe(true);
  });
});
