import { isMatteType, isTrackMatteConfig, getMatteMode, getMatteSourceId, readNodeMatte } from './matte';
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

describe('isMatteType / isTrackMatteConfig / helpers', () => {
  test('validates the matte types and configs', () => {
    expect(isMatteType('alpha')).toBe(true);
    expect(isMatteType('luma-inv')).toBe(true);
    expect(isMatteType('none')).toBe(false);
    expect(isMatteType(undefined)).toBe(false);

    expect(isTrackMatteConfig({ mode: 'alpha', sourceId: 'layer1' })).toBe(true);
    expect(isTrackMatteConfig('alpha')).toBe(false);

    expect(getMatteMode('alpha')).toBe('alpha');
    expect(getMatteMode({ mode: 'luma', sourceId: 'src1' })).toBe('luma');
    expect(getMatteSourceId({ mode: 'luma', sourceId: 'src1' })).toBe('src1');
  });

  test('reads the stored matte, undefined when absent/invalid', () => {
    expect(readNodeMatte(nodeWithFx())).toBeUndefined();
    expect(readNodeMatte(nodeWithFx({ matte: 'luma' }))).toBe('luma');
    expect(readNodeMatte(nodeWithFx({ matte: { mode: 'alpha', sourceId: 'foo' } }))).toEqual({ mode: 'alpha', sourceId: 'foo' });
    expect(readNodeMatte(nodeWithFx({ matte: 'nope' }))).toBeUndefined();
  });
});

describe('resolveMatteSources', () => {
  // Layers arrive in PAINT order (back → front). AE's positional matte source
  // is the layer directly ABOVE in the stack — the front-most neighbour, i.e.
  // the NEXT layer in paint order.
  test('marks the layer directly above (next in paint order) as the positional source', () => {
    const layers = [layer('plain'), layer('matted', { matte: 'alpha' }), layer('src')];
    resolveMatteSources(layers);
    expect(layers[0]!.isMatteSource).toBeUndefined();
    expect(layers[1]!.isMatteSource).toBeUndefined();
    expect(layers[2]!.isMatteSource).toBe(true);
    expect(layers[1]!.matteSourceId).toBe('src');
  });

  test('marks the explicit sourceId layer when matte object is used', () => {
    const layers = [
      layer('matted', { matte: { mode: 'alpha', sourceId: 'remoteSrc' } }),
      layer('plain'),
      layer('remoteSrc'),
    ];
    resolveMatteSources(layers);
    expect(layers[0]!.isMatteSource).toBeUndefined();
    expect(layers[1]!.isMatteSource).toBeUndefined();
    expect(layers[2]!.isMatteSource).toBe(true);
  });

  test('a positional matte on the front-most layer has no source (nothing above)', () => {
    const layers = [layer('b'), layer('a', { matte: 'alpha' })];
    resolveMatteSources(layers);
    expect(layers[0]!.isMatteSource).toBeUndefined();
    expect(layers[1]!.isMatteSource).toBeUndefined();
  });
});
