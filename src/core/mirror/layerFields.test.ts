import type { LayerInfo, PropertyInfo, Value } from '@motion/engine-api';
import { compLayersDeep, fieldValue, jsonField } from './layerFields';

const layer = (id: string, children: string[] = []): LayerInfo => ({ id, children } as unknown as LayerInfo);
const prop = (value: Value): PropertyInfo => ({ value } as unknown as PropertyInfo);

function fakeMirror(props: Record<string, PropertyInfo>, layers: LayerInfo[], comps: Record<string, string[]>) {
  const byId = new Map(layers.map((l) => [l.id, l]));
  return {
    layer: (id: string) => byId.get(id),
    property: (l: string, p: string) => props[`${l}|${p}`],
    comp: (id: string) => (comps[id] ? { layers: comps[id]! } : undefined),
    tree: () => undefined,
  };
}

test('fieldValue returns plain values and parses json', () => {
  const m = fakeMirror({
    'a|light/lightType': prop({ kind: 'choice', value: 'spot' }),
    'a|layer/cloner': prop({ kind: 'json', value: '{"count":3}' }),
  }, [layer('a')], {});
  expect(fieldValue(m, 'a', 'light/lightType')).toBe('spot');
  expect(fieldValue(m, 'a', 'layer/cloner')).toEqual({ count: 3 });
  expect(fieldValue(m, 'a', 'nope')).toBeUndefined();
});

test('jsonField is stable per value record and undefined for null', () => {
  const v: Value = { kind: 'json', value: '{"count":3}' };
  const m = fakeMirror({ 'a|layer/cloner': prop(v), 'a|layer/physics': prop({ kind: 'json', value: 'null' }) }, [layer('a')], {});
  const first = jsonField<{ count: number }>(m, 'a', 'layer/cloner');
  expect(first).toEqual({ count: 3 });
  expect(jsonField(m, 'a', 'layer/cloner')).toBe(first);
  expect(jsonField(m, 'a', 'layer/physics')).toBeUndefined();
  expect(jsonField(m, 'a', 'layer/particle')).toBeUndefined();
});

test('compLayersDeep walks group children depth first, top first', () => {
  const m = fakeMirror({}, [layer('g', ['c1', 'c2']), layer('c1'), layer('c2'), layer('b')], { comp: ['g', 'b'] });
  expect(compLayersDeep(m, 'comp').map((l) => l.id)).toEqual(['g', 'c1', 'c2', 'b']);
  expect(compLayersDeep(m, 'missing')).toEqual([]);
  expect(compLayersDeep(m, undefined)).toEqual([]);
});
