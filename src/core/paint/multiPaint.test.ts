/**
 * Multi-fill / multi-stroke stacks — array APIs, legacy migration, and the
 * primary-slot mirroring contract (fills[0] ↔ legacy fx.fill).
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import {
  getNodeFill,
  getNodeFills,
  setNodeFill,
  setNodeFills,
  solidFill,
} from './fill';
import {
  defaultStroke,
  getNodeStroke,
  getNodeStrokes,
  setNodeStroke,
  setNodeStrokes,
  normalizeStroke,
} from './stroke';
import type { SceneNode } from '@core/types';

function makeShape(id: string): void {
  const node: SceneNode = {
    id,
    name: id,
    parent: null,
    children: [],
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    visible: true,
    locked: false,
    components: [
      { id: `${id}_t`, type: 'Transform', props: { x: 0, y: 0 } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#112233' } },
    ],
  };
  const rootId = defaultSceneGraph.getRoots()[0]?.id ?? 'comp_root';
  defaultSceneGraph.addChild(rootId, node);
}

describe('fill stacks', () => {
  it('legacy single fill reads as a 1-element stack', () => {
    makeShape('mf_a');
    expect(getNodeFills('mf_a')).toEqual([solidFill('#112233')]);
    defaultSceneGraph.removeNode('mf_a');
  });

  it('setNodeFills stores the stack and mirrors fills[0] to the legacy slot', () => {
    makeShape('mf_b');
    setNodeFills('mf_b', [solidFill('#ff0000'), solidFill('#00ff00')]);
    expect(getNodeFills('mf_b')).toHaveLength(2);
    expect(getNodeFill('mf_b')).toEqual(solidFill('#ff0000'));
    defaultSceneGraph.removeNode('mf_b');
  });

  it('setNodeFill on a stacked node edits the primary and keeps the rest', () => {
    makeShape('mf_c');
    setNodeFills('mf_c', [solidFill('#ff0000'), solidFill('#00ff00')]);
    setNodeFill('mf_c', solidFill('#0000ff'));
    expect(getNodeFills('mf_c')).toEqual([solidFill('#0000ff'), solidFill('#00ff00')]);
    defaultSceneGraph.removeNode('mf_c');
  });

  it('clearing the primary fill drops it from the stack', () => {
    makeShape('mf_d');
    setNodeFills('mf_d', [solidFill('#ff0000'), solidFill('#00ff00')]);
    setNodeFill('mf_d', undefined);
    expect(getNodeFills('mf_d')).toEqual([solidFill('#00ff00')]);
    defaultSceneGraph.removeNode('mf_d');
  });
});

describe('stroke stacks', () => {
  it('setNodeStrokes stores the stack and mirrors strokes[0]', () => {
    makeShape('ms_a');
    const s1 = normalizeStroke({ ...defaultStroke('#ff0000'), width: 6 });
    const s2 = normalizeStroke({ ...defaultStroke('#00ff00'), width: 2 });
    setNodeStrokes('ms_a', [s1, s2]);
    expect(getNodeStrokes('ms_a')).toHaveLength(2);
    expect(getNodeStroke('ms_a')?.color).toBe('#ff0000');
    defaultSceneGraph.removeNode('ms_a');
  });

  it('setNodeStroke on a stacked node edits the primary only', () => {
    makeShape('ms_b');
    setNodeStrokes('ms_b', [defaultStroke('#ff0000'), defaultStroke('#00ff00')]);
    setNodeStroke('ms_b', normalizeStroke({ ...defaultStroke('#123456'), width: 9 }));
    const out = getNodeStrokes('ms_b');
    expect(out[0]!.color).toBe('#123456');
    expect(out[0]!.width).toBe(9);
    expect(out[1]!.color).toBe('#00ff00');
    defaultSceneGraph.removeNode('ms_b');
  });

  it('a gradient stroke paint survives normalization; junk paint is dropped', () => {
    const grad = normalizeStroke({
      ...defaultStroke(),
      paint: { type: 'linear', angle: 45, stops: [{ id: 's1', offset: 0, color: '#fff' }, { id: 's2', offset: 1, color: '#000' }] },
    });
    expect(grad.paint?.type).toBe('linear');
    const junk = normalizeStroke({ ...defaultStroke(), paint: { type: 'nope' } as never });
    expect(junk.paint).toBeUndefined();
  });
});
