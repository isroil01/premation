/**
 * Save/load fidelity — the round trip that no test crossed.
 *
 * Every unit here passed its own tests while the product silently lost data,
 * because the suites exercised each engine's interior and never the boundary
 * between them. `serializeTimeline` was correct AND had zero callers; the
 * timeline field on the document was declared and never assigned. So every
 * trim, split, marker and work area died on reload, and nothing went red.
 *
 * These tests assert the CONTRACT — capture(...) → restore(...) preserves what
 * a user authored. When you add authored state to the editor, add it here.
 */




import { useGuidesStore } from '@stores/guidesStore';

beforeEach(() => {
});

describe('captureDocument → restoreDocument', () => {

  it('migrates a legacy gridDivisions onto the PROPORTIONAL grid', () => {
    // Projects saved before the absolute/proportional split stored one
    // `gridDivisions` (cells per axis). That only ever described a
    // comp-relative division, so it must not land on the absolute grid's
    // pixel spacing — 12 cells and 12 pixels are wildly different things.
    useGuidesStore.getState().restore({ proportionalColumns: 8, proportionalRows: 6, gridSpacing: 100 });
    useGuidesStore.getState().restore({ gridDivisions: 12 } as never);

    const s = useGuidesStore.getState().settings();
    expect(s.proportionalColumns).toBe(12);
    expect(s.proportionalRows).toBe(12);
    expect(s.gridSpacing).toBe(100);
  });
});
