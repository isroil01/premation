/**
 * The Layers panel's view state.
 *
 * All of this used to be `useState` inside the panel, which a dock tab unmounts
 * every time the user looks at Assets. What is pinned here is the division that
 * makes the persistence correct rather than merely present: filters belong to a
 * COMPOSITION, view settings belong to the PANEL, and a filter keyed to a comp
 * id from a document you are no longer in is dead weight that never matches.
 */

import { EMPTY_FILTER, ROW_DENSITY, isFilterActive, useSceneViewStore } from './sceneViewStore';

const DEFAULTS = {
  scope: 'comp' as const,
  density: 'cozy' as const,
  switches: ['shy', 'motionBlur', 'adjustment', 'threeD'] as const,
  thumbnails: false,
  hideShy: false,
};

beforeEach(() => {
  localStorage.clear();
  useSceneViewStore.setState({ ...DEFAULTS, switches: [...DEFAULTS.switches], filters: {} });
});

describe('filters are per composition', () => {
  it('hands back the empty filter for a comp nobody has filtered', () => {
    expect(useSceneViewStore.getState().filterFor('comp_a')).toEqual(EMPTY_FILTER);
  });

  it('keeps two comps\' filters apart', () => {
    const s = useSceneViewStore.getState();
    s.patchFilter('comp_a', { query: 'logo' });
    s.patchFilter('comp_b', { query: 'title' });
    // "Show me the layers called logo" is a question about the comp it was
    // asked in; carried across it empties a comp with nothing saying why.
    expect(useSceneViewStore.getState().filterFor('comp_a').query).toBe('logo');
    expect(useSceneViewStore.getState().filterFor('comp_b').query).toBe('title');
  });

  it('merges a patch rather than replacing the filter', () => {
    const s = useSceneViewStore.getState();
    s.patchFilter('comp_a', { query: 'logo' });
    s.patchFilter('comp_a', { animatedOnly: true });
    const f = useSceneViewStore.getState().filterFor('comp_a');
    expect(f.query).toBe('logo');
    expect(f.animatedOnly).toBe(true);
  });

  it('clears one comp and leaves the others alone', () => {
    const s = useSceneViewStore.getState();
    s.patchFilter('comp_a', { query: 'logo' });
    s.patchFilter('comp_b', { query: 'title' });
    s.clearFilter('comp_a');
    expect(useSceneViewStore.getState().filterFor('comp_a')).toEqual(EMPTY_FILTER);
    expect(useSceneViewStore.getState().filterFor('comp_b').query).toBe('title');
  });

  it('gives a panel with no open comp somewhere stable to put one', () => {
    useSceneViewStore.getState().patchFilter(undefined, { query: 'x' });
    expect(useSceneViewStore.getState().filterFor(undefined).query).toBe('x');
  });
});

describe('what counts as filtering', () => {
  it('is false for the empty filter and for whitespace', () => {
    expect(isFilterActive(EMPTY_FILTER)).toBe(false);
    expect(isFilterActive({ ...EMPTY_FILTER, query: '   ' })).toBe(false);
  });

  it('is true for each of the five questions the panel asks', () => {
    expect(isFilterActive({ ...EMPTY_FILTER, query: 'a' })).toBe(true);
    expect(isFilterActive({ ...EMPTY_FILTER, kinds: ['camera'] })).toBe(true);
    expect(isFilterActive({ ...EMPTY_FILTER, label: 'none' })).toBe(true);
    expect(isFilterActive({ ...EMPTY_FILTER, animatedOnly: true })).toBe(true);
    expect(isFilterActive({ ...EMPTY_FILTER, effectsOnly: true })).toBe(true);
  });
});

describe('the switch column', () => {
  it('toggles a flag in and out of the set', () => {
    const s = useSceneViewStore.getState();
    expect(useSceneViewStore.getState().switches).toContain('shy');
    s.toggleSwitch('shy');
    expect(useSceneViewStore.getState().switches).not.toContain('shy');
    useSceneViewStore.getState().toggleSwitch('shy');
    expect(useSceneViewStore.getState().switches).toContain('shy');
  });
});

describe('row density', () => {
  it('gives each step a pixel height the tree can virtualize on', () => {
    // The virtual window is O(1) only because the row height is a constant, so
    // the three steps have to be three constants rather than a CSS decision.
    expect(ROW_DENSITY.compact).toBeLessThan(ROW_DENSITY.cozy);
    expect(ROW_DENSITY.cozy).toBeLessThan(ROW_DENSITY.comfortable);
  });
});

describe('persistence', () => {
  it('restores the view settings a reload later', async () => {
    const s = useSceneViewStore.getState();
    s.setScope('project');
    s.setDensity('compact');
    s.setThumbnails(true);

    jest.resetModules();
    const fresh = (await import('./sceneViewStore')).useSceneViewStore;
    expect(fresh.getState().scope).toBe('project');
    expect(fresh.getState().density).toBe('compact');
    expect(fresh.getState().thumbnails).toBe(true);
  });

  it('does NOT restore filters, which are keyed to a document that may be gone', async () => {
    useSceneViewStore.getState().patchFilter('comp_a', { query: 'logo' });
    jest.resetModules();
    const fresh = (await import('./sceneViewStore')).useSceneViewStore;
    // A comp id from another project never matches anything, so the panel would
    // open empty with the cause invisible. Filters are cheap to re-set.
    expect(fresh.getState().filters).toEqual({});
  });

  it('survives storage being unavailable', () => {
    const spy = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    // A full or blocked localStorage is not a reason for the panel to fail.
    expect(() => useSceneViewStore.getState().setDensity('comfortable')).not.toThrow();
    expect(useSceneViewStore.getState().density).toBe('comfortable');
    spy.mockRestore();
  });
});
