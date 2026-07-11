import { CommandBuffer, type DrawItem } from '../commands/DrawCommand';
import { SOLID_MATERIAL } from '../shaders/Material';

function item(batchKey: string): DrawItem {
  return { batchKey, material: SOLID_MATERIAL, blend: 'normal', uniforms: new Float32Array(16) };
}

describe('CommandBuffer batching', () => {
  it('groups consecutive items sharing a batch key', () => {
    const cb = new CommandBuffer();
    cb.add(item('A'));
    cb.add(item('A'));
    cb.add(item('B'));
    cb.add(item('A'));
    const batches = cb.batches();
    expect(batches.map((b) => b.batchKey)).toEqual(['A', 'B', 'A']);
    expect(batches.map((b) => b.items.length)).toEqual([2, 1, 1]);
  });

  it('never reorders across differing keys (preserves paint order)', () => {
    const cb = new CommandBuffer();
    for (const k of ['A', 'B', 'C']) cb.add(item(k));
    expect(cb.batches()).toHaveLength(3);
  });

  it('clear empties the buffer', () => {
    const cb = new CommandBuffer();
    cb.add(item('A'));
    expect(cb.length).toBe(1);
    cb.clear();
    expect(cb.length).toBe(0);
    expect(cb.batches()).toHaveLength(0);
  });
});
