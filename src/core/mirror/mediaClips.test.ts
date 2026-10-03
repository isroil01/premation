/**
 * The interchange exporters' clip list (EDL / ALE / FCPXML / OTIO) from the
 * mirror: footage layers with a bar, their bar and source in frames, hidden
 * layers and non-footage layers left out.
 */

import { secondsToFlicks, type ItemInfo, type LayerInfo } from '@motion/engine-api';
import { mirrorMediaClips, type MirrorMediaRead } from './mediaClips';

const s = (sec: number): number => secondsToFlicks(sec);

function layer(id: string, kind: LayerInfo['kind'], extra: Partial<LayerInfo> = {}): LayerInfo {
  return {
    id, comp: 'c', kind, name: id.toUpperCase(), children: [], hasVideo: true, hasAudio: false, markers: [], comment: '', generator: '',
    pinned: [], effectCount: 0, shapeType: '', managedBy: '', mographId: '', svg: 'none',
    switches: { visible: true } as LayerInfo['switches'],
    timing: { inPoint: s(1), outPoint: s(3), startTime: s(0.5), stretch: 1, timeRemapEnabled: false, retime: 'none' } as unknown as LayerInfo['timing'],
    blendMode: 'normal' as LayerInfo['blendMode'], matte: {} as LayerInfo['matte'],
    ...extra,
  };
}

function fake(layers: LayerInfo[]): MirrorMediaRead {
  const map = new Map(layers.map((l) => [l.id, l]));
  const items = new Map<string, ItemInfo>([['it1', { id: 'it1', name: 'shot01.mov' } as ItemInfo]]);
  return {
    layer: (id) => map.get(id),
    comp: (id) => (id === 'c' ? { layers: layers.map((l) => l.id), settings: { frameRate: { num: 30, den: 1 } } as never } : undefined),
    layerIds: () => [...map.keys()],
    item: (id) => items.get(id),
  };
}

it('lists footage layers with their bar and source frames, skipping hidden and non-footage layers', () => {
  const m = fake([
    layer('v', 'video', { source: 'it1' }),
    layer('t', 'text'),
    layer('h', 'audio', { switches: { visible: false } as LayerInfo['switches'] }),
    layer('a', 'audio'),
  ]);
  const { fps, clips } = mirrorMediaClips(m, 'c');
  expect(fps).toBe(30);
  // Back to front: the stack lists v on top.
  expect(clips).toEqual([
    { nodeId: 'a', name: 'A', kind: 'audio', mediaName: null, itemId: null, start: 30, duration: 60, sourceIn: 15 },
    { nodeId: 'v', name: 'V', kind: 'video', mediaName: 'shot01.mov', itemId: 'it1', start: 30, duration: 60, sourceIn: 15 },
  ]);
});
