/**
 * MSAA is REQUESTED on the depth-capable 3D targets.
 *
 * The backend clamps to the device maximum and silently falls back to
 * single-sample if a driver refuses the combination, so this cannot assert that
 * multisampling happened — only that the graph asks for it. That request is the
 * part that regresses silently: drop `samples` from a target declaration and the
 * 3D face seams come straight back with nothing failing.
 */

import { buildDefaultGraph, MSAA_SAMPLES, SCENE_COLOR_TARGET, PRECOMP_TARGETS } from '../rendergraph/passes';

const VP = {
  pixelSize: { width: 800, height: 600 },
} as never;

describe('MSAA on the 3D render targets', () => {
  const graph = buildDefaultGraph();

  // The graph stores target factories; resolve them the way the renderer does.
  // declareTarget stores { name, descriptor } — the factory is the `descriptor`.
  const descOf = (name: string) => {
    const entry = (graph as unknown as {
      targets: Map<string, { name: string; descriptor: (vp: never) => unknown }>;
    }).targets.get(name);
    expect(entry).toBeDefined();
    return entry!.descriptor(VP) as { depth?: boolean; samples?: number };
  };

  it('asks for 4x — the standard quality/bandwidth trade', () => {
    expect(MSAA_SAMPLES).toBe(4);
  });

  it('the scene colour target is multisampled AND depth-capable', () => {
    const d = descOf(SCENE_COLOR_TARGET);
    expect(d.depth).toBe(true);
    expect(d.samples).toBe(MSAA_SAMPLES);
  });

  // A 3D group inside an isolated precomp renders into one of these, so they
  // need the same treatment or nested 3D keeps the seams.
  it('every isolated-precomp target is multisampled AND depth-capable', () => {
    for (const name of PRECOMP_TARGETS) {
      const d = descOf(name);
      expect(d.depth).toBe(true);
      expect(d.samples).toBe(MSAA_SAMPLES);
    }
  });
});
