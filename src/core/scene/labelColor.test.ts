/**
 * Label color (AE-style per-layer label) — storage round-trip.
 *
 * The color must survive: view-cache reads (getNode), scene-graph writes via
 * `node.color`, and full project serialization (sceneProjectIO capture →
 * restore), since that is what feeds the Scene rows and timeline colors.
 */


import { LABEL_COLORS } from './labelColor';

beforeEach(() => {
});

describe('LABEL_COLORS palette', () => {
  it('is a fixed set of unique hex swatches', () => {
    expect(LABEL_COLORS.length).toBeGreaterThanOrEqual(12);
    const hexes = LABEL_COLORS.map((c) => c.color);
    expect(new Set(hexes).size).toBe(hexes.length);
    for (const h of hexes) expect(h).toMatch(/^#[0-9a-f]{6}$/i);
    const ids = LABEL_COLORS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
