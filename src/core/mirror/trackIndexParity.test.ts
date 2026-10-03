/**
 * Block 3 (docs/TS_ENGINE_REMOVAL.md): UI writes resolve a track name (`x`,
 * `scaleY`, `pin.p1.x`, `effect.fx_1.radius`, `fill_r` …) to an API property
 * from the MIRROR's property tree (`trackRefIn`) instead of the TypeScript
 * engine's catalog (`catalogFor`). For that switch to change nothing, every
 * member name the catalog answers must resolve to the same path and member
 * index from the property tree the engine reports — over every layer the
 * corpus sessions build.
 */

import { CORPUS, CORPUS_FIXTURES, FAMILY_CORPUS } from '@core/engine/__testHelpers__/corpus';
import { setupEngine, type Harness } from '@core/engine/__testHelpers__/harness';
import { catalogFor } from '@core/engine/props';
import { trackRefIn, type MirrorTreeLike } from './trackIndex';

const SESSIONS = { ...CORPUS, ...FAMILY_CORPUS };

async function mismatchesAfter(name: string): Promise<string[]> {
  const h: Harness = await setupEngine();
  try {
    for (const [path, make] of Object.entries(CORPUS_FIXTURES)) h.files.set(path, make());
    await SESSIONS[name]!(h);
    const doc = await h.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false });
    const out: string[] = [];
    for (const layer of doc.layers) {
      const t = await h.query({ type: 'getPropertyTree', layer: layer.id, path: '', depth: 0 });
      const tree: MirrorTreeLike = { layer: layer.id, nodes: new Map(t.nodes.map((n) => [n.path, n])) };
      let cat: ReturnType<typeof catalogFor>;
      try {
        cat = catalogFor(layer.id);
      } catch {
        continue;
      }
      for (const [member, b] of cat.byMember) {
        const r = trackRefIn(tree, member);
        const want = Math.max(0, b.members.indexOf(member));
        if (!r) out.push(`${layer.kind} ${member}: none (catalog ${b.path}[${want}] ${b.valueType} members=${JSON.stringify(b.members)} match=${tree.nodes.get(b.path)?.matchName} dims=${tree.nodes.get(b.path)?.dimensions} sep=${tree.nodes.get(b.path)?.separated})`);
        else if (r.path !== b.path || r.member !== want) out.push(`${layer.kind} ${member}: ${r.path}[${r.member}] ≠ catalog ${b.path}[${want}]`);
      }
    }
    return out;
  } finally {
    await h.dispose();
  }
}

describe('mirror track index ⇄ the TypeScript catalog', () => {
  test.each(Object.keys(SESSIONS))('%s', async (name) => {
    const bad = [...new Set(await mismatchesAfter(name))];
    expect(bad).toEqual([]);
  }, 120_000);
});
