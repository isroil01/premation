import { secondsToFlicks, type LayerInfo } from '@motion/engine-api';
import { mirrorBarOf, mirrorCompBars, mirrorHasBar } from './clipBars';

const FPS = 30;
const fr = (n: number): number => secondsToFlicks(n / FPS);

function layer(id: string, kind: LayerInfo['kind'], inF: number, outF: number, parent?: string, locked = false): LayerInfo {
  return {
    id,
    kind,
    ...(parent ? { parent } : {}),
    timing: { inPoint: fr(inF), outPoint: fr(outF), startTime: fr(inF), stretch: 1 } as LayerInfo['timing'],
    switches: { locked } as LayerInfo['switches'],
  } as LayerInfo;
}

function mirror(layers: LayerInfo[]) {
  const byId = new Map(layers.map((l) => [l.id, l] as const));
  return {
    layer: (id: string) => byId.get(id),
    comp: (id: string) => (id === 'c' ? { layers: layers.map((l) => l.id) } : undefined),
  };
}

describe('clip bars over the mirror (the twin of the controller bars)', () => {
  const m = mirror([
    layer('grp', 'group', 0, 90),
    layer('member', 'shape', 10, 20, 'grp'),
    layer('nul', 'null', 0, 60),
    layer('child', 'text', 30, 60, 'nul', true),
    layer('vid', 'video', 60, 120),
  ]);

  it('a group has a bar; its members do not; a parented layer does', () => {
    expect(mirrorHasBar(m, 'grp')).toBe(true);
    expect(mirrorHasBar(m, 'member')).toBe(false);
    expect(mirrorHasBar(m, 'child')).toBe(true);
    expect(mirrorHasBar(m, 'missing')).toBe(false);
  });

  it('bars are the timings in frames, with the lock', () => {
    expect(mirrorBarOf(m, 'child', FPS)).toEqual({ nodeId: 'child', start: 30, end: 60, locked: true });
    expect(mirrorBarOf(m, 'member', FPS)).toBeNull();
  });

  it('a composition lists every layer with a bar, in stack order', () => {
    expect(mirrorCompBars(m, 'c', FPS).map((b) => b.nodeId)).toEqual(['grp', 'nul', 'child', 'vid']);
    expect(mirrorCompBars(m, undefined, FPS)).toEqual([]);
  });
});
