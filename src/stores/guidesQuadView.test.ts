import { useGuidesStore, type QuadViewModes } from './guidesStore';

/**
 * 4-up (2×2) view state. Each cell's mode must round-trip through the store and
 * change the render key, or a stale cached main-viewport frame would blit back
 * over a layout/view change (the same class of bug the key exists to prevent).
 */
describe('guidesStore 4-up quad view', () => {
  beforeEach(() => {
    // Restore the shipped defaults (session state has no reset action).
    useGuidesStore.setState({
      viewLayout: '1',
      quadViewModes: ['active', 'front', 'top', 'custom1'],
    });
  });

  it('defaults to AE-like [active, front, top, custom1]', () => {
    expect(useGuidesStore.getState().quadViewModes).toEqual(['active', 'front', 'top', 'custom1']);
  });

  it('setQuadViewMode updates only the target index', () => {
    useGuidesStore.getState().setQuadViewMode(2, 'left');
    expect(useGuidesStore.getState().quadViewModes).toEqual(['active', 'front', 'left', 'custom1']);

    useGuidesStore.getState().setQuadViewMode(1, 'right');
    expect(useGuidesStore.getState().quadViewModes).toEqual(['active', 'right', 'left', 'custom1']);
  });

  it('does not mutate the previous array (new reference each set)', () => {
    const before = useGuidesStore.getState().quadViewModes;
    useGuidesStore.getState().setQuadViewMode(3, 'bottom');
    const after = useGuidesStore.getState().quadViewModes;
    expect(after).not.toBe(before);
    expect(before).toEqual(['active', 'front', 'top', 'custom1']); // untouched
  });

  it('ignores out-of-range indices', () => {
    const before = useGuidesStore.getState().quadViewModes;
    useGuidesStore.getState().setQuadViewMode(-1, 'back');
    useGuidesStore.getState().setQuadViewMode(4, 'back');
    expect(useGuidesStore.getState().quadViewModes).toEqual(before);
  });

  it('changes the render key when any cell mode changes', () => {
    const k0 = useGuidesStore.getState().key();
    useGuidesStore.getState().setQuadViewMode(1, 'back');
    const k1 = useGuidesStore.getState().key();
    useGuidesStore.getState().setQuadViewMode(2, 'right');
    const k2 = useGuidesStore.getState().key();
    expect(k1).not.toBe(k0);
    expect(k2).not.toBe(k1);
  });

  it('changes the render key across 1 → 2 → 4 layout transitions', () => {
    useGuidesStore.getState().setViewLayout('1');
    const k1 = useGuidesStore.getState().key();
    useGuidesStore.getState().setViewLayout('2');
    const k2 = useGuidesStore.getState().key();
    useGuidesStore.getState().setViewLayout('4');
    const k4 = useGuidesStore.getState().key();
    expect(k2).not.toBe(k1);
    expect(k4).not.toBe(k2);
    expect(useGuidesStore.getState().viewLayout).toBe<'4'>('4');
  });

  it('quadViewModes stays a 4-tuple type', () => {
    const modes: QuadViewModes = useGuidesStore.getState().quadViewModes;
    expect(modes).toHaveLength(4);
  });
});
