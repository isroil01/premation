/**
 * Proportional Scrubbing's arithmetic, and the ordered selection it runs on.
 */

import { usePropertySelectionStore, scrubWeights, distributeScrub, propertyKey } from './propertySelectionStore';

beforeEach(() => usePropertySelectionStore.setState({ entries: [], proportional: true }));

describe('ordered selection', () => {
  it('keeps click order, and toggle removes without reordering the rest', () => {
    const s = usePropertySelectionStore.getState();
    s.select({ nodeId: 'a', prop: 'opacity' });
    s.toggle({ nodeId: 'b', prop: 'opacity' });
    s.toggle({ nodeId: 'c', prop: 'opacity' });
    expect(usePropertySelectionStore.getState().entries.map((e) => e.nodeId)).toEqual(['a', 'b', 'c']);
    usePropertySelectionStore.getState().toggle({ nodeId: 'b', prop: 'opacity' });
    expect(usePropertySelectionStore.getState().entries.map((e) => e.nodeId)).toEqual(['a', 'c']);
  });
  it('replace collapses the selection to one', () => {
    const s = usePropertySelectionStore.getState();
    s.toggle({ nodeId: 'a', prop: 'x' }); s.toggle({ nodeId: 'b', prop: 'x' });
    usePropertySelectionStore.getState().select({ nodeId: 'z', prop: 'x' });
    expect(usePropertySelectionStore.getState().entries).toEqual([{ nodeId: 'z', prop: 'x' }]);
  });
});

describe('scrubWeights', () => {
  it("is Adobe's ramp: first 0%, last 100%, linear between", () => {
    expect(scrubWeights(5, true)).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });
  it('is uniform when proportional is off', () => {
    expect(scrubWeights(4, false)).toEqual([1, 1, 1, 1]);
  });
  it('a single selection scrubs as if none existed', () => {
    expect(scrubWeights(1, true)).toEqual([1]);
    expect(scrubWeights(0, true)).toEqual([]);
  });
});

describe('distributeScrub', () => {
  const entries = [{ nodeId: 'a', prop: 'opacity' }, { nodeId: 'b', prop: 'opacity' }, { nodeId: 'c', prop: 'opacity' }];
  const starts = new Map(entries.map((e, i) => [propertyKey(e), 100 - i * 10])); // 100, 90, 80

  it('ramps the delta across the selection from the START values', () => {
    const out = distributeScrub(entries, starts, -40, true);
    expect(out.map((o) => o.value)).toEqual([100, 70, 40]);
  });
  it('moves everything by the delta when uniform', () => {
    expect(distributeScrub(entries, starts, 5, false).map((o) => o.value)).toEqual([105, 95, 85]);
  });
  it('skips an entry with no start (a property that vanished mid-drag)', () => {
    const partial = new Map(starts); partial.delete(propertyKey(entries[1]!));
    expect(distributeScrub(entries, partial, 10, true).map((o) => o.ref.nodeId)).toEqual(['a', 'c']);
  });
});
