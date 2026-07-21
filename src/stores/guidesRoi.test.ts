import { useGuidesStore } from './guidesStore';

/**
 * The ROI must round-trip through the store and change the render key, or a
 * stale cached frame would blit back over it (the class of bug the key exists
 * to prevent).
 */
describe('guidesStore region of interest', () => {
  beforeEach(() => useGuidesStore.getState().setRoi(null));

  it('stores and clears a region', () => {
    expect(useGuidesStore.getState().roi).toBeNull();
    useGuidesStore.getState().setRoi({ x: 10, y: 20, width: 100, height: 80 });
    expect(useGuidesStore.getState().roi).toEqual({ x: 10, y: 20, width: 100, height: 80 });
    useGuidesStore.getState().setRoi(null);
    expect(useGuidesStore.getState().roi).toBeNull();
  });

  it('changes the render key when the region changes', () => {
    const k0 = useGuidesStore.getState().key();
    useGuidesStore.getState().setRoi({ x: 0, y: 0, width: 50, height: 50 });
    const k1 = useGuidesStore.getState().key();
    useGuidesStore.getState().setRoi({ x: 0, y: 0, width: 60, height: 50 });
    const k2 = useGuidesStore.getState().key();
    expect(k1).not.toBe(k0);
    expect(k2).not.toBe(k1); // a resize is a different key too
  });
});
