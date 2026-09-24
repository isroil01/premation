import type { LayerInfo } from '@motion/engine-api';
import { mirrorLookThroughCamera, mirrorLookThroughCameras } from './cameras';

const layer = (id: string, kind: string, extra: Partial<{ visible: boolean; children: string[]; source: string }> = {}): LayerInfo =>
  ({ id, name: id.toUpperCase(), kind, source: extra.source, children: extra.children ?? [], switches: { visible: extra.visible ?? true } } as unknown as LayerInfo);

function fakeMirror(layers: LayerInfo[], comps: Record<string, string[]>) {
  const byId = new Map(layers.map((l) => [l.id, l]));
  return {
    compIds: Object.keys(comps),
    layer: (id: string) => byId.get(id),
    comp: (id: string) => (comps[id] ? { layers: comps[id]! } : undefined),
  };
}

// comp c: top-first [cam2, g(group: [cam3]), off(hidden camera), s(shape), nest(legacy nested precomp: [cam4]), cam1]
const m = fakeMirror(
  [
    layer('cam2', 'camera'), layer('g', 'group', { children: ['cam3'] }), layer('cam3', 'camera'),
    layer('off', 'camera', { visible: false }), layer('s', 'shape'), layer('nest', 'precomp'), layer('cam4', 'camera'),
    layer('cam1', 'camera'), layer('other', 'camera'),
  ],
  { c: ['cam2', 'g', 'off', 's', 'nest', 'cam1'], nest: ['cam4'], d: ['other'] },
);

test('lists the visible cameras of a comp top-first, groups and nested precomp groups included', () => {
  expect(mirrorLookThroughCameras(m, 'c').map((l) => l.id)).toEqual(['cam2', 'cam3', 'cam4', 'cam1']);
});

test('an unknown comp walks every composition', () => {
  expect(mirrorLookThroughCameras(m, 'nope').map((l) => l.id)).toEqual(['cam2', 'cam3', 'cam4', 'cam1', 'other']);
});

test('lookThroughCamera: a live camera of the comp, else null', () => {
  expect(mirrorLookThroughCamera(m, 'cam3', 'c')?.id).toBe('cam3');
  expect(mirrorLookThroughCamera(m, 'off', 'c')).toBeNull();
  expect(mirrorLookThroughCamera(m, 's', 'c')).toBeNull();
  expect(mirrorLookThroughCamera(m, 'other', 'c')).toBeNull();
  expect(mirrorLookThroughCamera(m, null, 'c')).toBeNull();
});
