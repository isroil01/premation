import { isMatteType, readNodeMatte } from './matte';
import { resolveMatteSources } from '@core/rendering/buildSnapshot';
import type { RenderLayer } from '@core/rendering/RenderBackend';
import type { SceneNode } from '@core/types';

function nodeWithFx(props?: Record<string, unknown>): SceneNode {
  return { components: props ? [{ type: 'fx', props }] : [] } as unknown as SceneNode;
}

function layer(id: string, over: Partial<RenderLayer> = {}): RenderLayer {
  return {
    id, kind: 'shape', x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1,
    opacity: 1, width: 100, height: 100, fill: '#fff', visible: true, ...over,
  };
}

describe('isMatteType / readNodeMatte', () => {
  test('validates the matte types', () => {
    expect(isMatteType('alpha')).toBe(true);
    expect(isMatteType('luma-inv')).toBe(true);
    expect(isMatteType('none')).toBe(false);
    expect(isMatteType(undefined)).toBe(false);
  });

  test('reads the stored matte, undefined when absent/invalid', () => {
    expect(readNodeMatte(nodeWithFx())).toBeUndefined();
    expect(readNodeMatte(nodeWithFx({ matte: 'luma' }))).toBe('luma');
    expect(readNodeMatte(nodeWithFx({ matte: 'nope' }))).toBeUndefined();
  });
});

describe('resolveMatteSources', () => {
  test('marks the layer directly above a matted layer as its source', () => {
    const layers = [layer('src'), layer('matted', { matte: 'alpha' }), layer('plain')];
    resolveMatteSources(layers);
    expect(layers[0]!.isMatteSource).toBe(true);
    expect(layers[1]!.isMatteSource).toBeUndefined();
    expect(layers[2]!.isMatteSource).toBeUndefined();
  });

  test('a matte on the first layer has no source (nothing above)', () => {
    const layers = [layer('a', { matte: 'alpha' }), layer('b')];
    resolveMatteSources(layers);
    expect(layers[0]!.isMatteSource).toBeUndefined();
    expect(layers[1]!.isMatteSource).toBeUndefined();
  });
});
