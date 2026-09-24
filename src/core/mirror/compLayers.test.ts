/**
 * `flattenCompLayers` walks a composition the way `flattenComposition` walks
 * the scene graph (depth first, a parent before its children, siblings back to
 * front, into legacy nested precomp groups); `compHas3DContent` gates the 3D
 * chrome on it.
 */

import type { LayerInfo } from '@motion/engine-api';
import { compHas3DContent, flattenCompLayers, type MirrorCompLayersRead } from './compLayers';

function layer(id: string, comp: string, kind: LayerInfo['kind'], extra: Partial<LayerInfo> = {}, threeD = false): LayerInfo {
  return {
    id, comp, kind, name: id, children: [], hasVideo: true, hasAudio: false, markers: [], comment: '', generator: '',
    pinned: [], effectCount: 0,
    switches: { threeD, visible: true } as LayerInfo['switches'],
    timing: {} as LayerInfo['timing'], blendMode: 'normal' as LayerInfo['blendMode'], matte: {} as LayerInfo['matte'],
    ...extra,
  };
}

function fake(comps: Record<string, string[]>, layers: LayerInfo[]): MirrorCompLayersRead {
  const map = new Map(layers.map((l) => [l.id, l]));
  return {
    layer: (id) => map.get(id),
    comp: (id) => (comps[id] ? { layers: comps[id] as string[] } : undefined),
    layerIds: () => [...map.keys()],
  };
}

describe('flattenCompLayers', () => {
  // Stack, top first: a (with child a1, a2 — a1 in front), b, nested group g (its own comp: g1).
  const m = fake(
    { c: ['a', 'a1', 'a2', 'b', 'g'], g: ['g1'] },
    [
      layer('a', 'c', 'shape'),
      layer('a1', 'c', 'shape', { parent: 'a' }),
      layer('a2', 'c', 'shape', { parent: 'a' }),
      layer('b', 'c', 'camera'),
      layer('g', 'c', 'precomp'),
      layer('g1', 'g', 'text', {}, true),
    ],
  );

  it('lists back to front, parents before children, descending into a nested group', () => {
    expect(flattenCompLayers(m, 'c')).toEqual(['g', 'g1', 'b', 'a', 'a2', 'a1']);
  });

  it('falls back to every layer for an unknown composition', () => {
    expect(new Set(flattenCompLayers(m, 'nope'))).toEqual(new Set(['a', 'a1', 'a2', 'b', 'g', 'g1']));
    expect(flattenCompLayers(m, undefined).length).toBe(6);
  });

  it('finds 3D content, with or without counting cameras', () => {
    expect(compHas3DContent(m, 'c', false)).toBe(true); // g1, inside the nested group
    const flat = fake({ c: ['b'] }, [layer('b', 'c', 'camera')]);
    expect(compHas3DContent(flat, 'c', false)).toBe(false);
    expect(compHas3DContent(flat, 'c', true)).toBe(true);
    const lit = fake({ c: ['l'] }, [layer('l', 'c', 'light', {}, true)]);
    expect(compHas3DContent(lit, 'c', false)).toBe(false);
  });
});
