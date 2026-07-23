/**
 * Lottie import — apply layer. Pins the reparent semantics that make nested
 * (parented / precomp) content actually visible: the plan's child transforms
 * are PARENT-relative, so pass 2 must reparent with `preserveWorld: false`.
 * The default world-preserving reparent would recompute each child's local to
 * cancel the parent transform the importer just built, collapsing nested
 * content back to raw Lottie coords (off-frame → invisible). Regression test
 * for exactly that bug.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { baseLocal } from '@core/scene/parenting';
import { worldTransformOf } from '@core/scene/worldTransform';
import { createToolContext } from '@core/ai/toolContext';
import { planLottieImport, type LottieJson } from '../lottieImport';
import { applyImportPlan } from '../lottieImportApply';
import type { SceneNode } from '@core/types';

function reset(): void {
  defaultAnimation.clear();
  defaultSceneGraph.clear();
  defaultSceneGraph.addNode({
    id: 'comp_root',
    name: 'Composition 1',
    parent: null,
    children: [],
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    visible: true,
    locked: false,
    components: [{ id: 'comp_root_meta', type: 'group', props: { __kind: 'group' } }],
  } as unknown as SceneNode);
}

/** World TRS of a live scene node, composed along its parent chain. */
function worldOf(nodeId: string): { x: number; y: number } {
  const localOf = (id: string) => {
    const n = defaultSceneGraph.getNode(id);
    return n ? baseLocal(n) : null;
  };
  const parentOf = (id: string) => {
    const p = defaultSceneGraph.getNode(id)?.parent ?? null;
    return p && p !== 'comp_root' ? p : null;
  };
  const t = worldTransformOf(nodeId, localOf, parentOf);
  return { x: t.x, y: t.y };
}

function findByName(name: string): SceneNode {
  const hit = (function walk(id: string): SceneNode | null {
    const n = defaultSceneGraph.getNode(id);
    if (n?.name === name) return n;
    for (const c of defaultSceneGraph.getChildren(id)) {
      const r = walk(c.id);
      if (r) return r;
    }
    return null;
  })('comp_root');
  if (!hit) throw new Error(`node "${name}" not found in scene`);
  return hit;
}

/** Precomp: group at (100,50) with anchor (256,128); inner shape at precomp-
 *  space (300,200) → planned parent-relative local (44,72), world (144,122). */
const PRECOMP_JSON: LottieJson = {
  fr: 30, w: 512, h: 512, op: 60,
  assets: [
    {
      id: 'pc1',
      layers: [
        { ty: 4, ind: 1, nm: 'Inner', ks: { p: { a: 0, k: [300, 200] } },
          shapes: [{ ty: 'rc', s: { a: 0, k: [40, 40] }, r: { a: 0, k: 0 } }] },
      ],
    },
  ],
  layers: [
    {
      ty: 0, ind: 1, nm: 'Pre', refId: 'pc1',
      ks: { p: { a: 0, k: [100, 50] }, a: { a: 0, k: [256, 128] } },
    },
  ],
};

describe('applyImportPlan — parenting keeps LOCAL transforms', () => {
  beforeEach(reset);

  it('a precomp child lands at the correct WORLD position after apply', () => {
    const plan = planLottieImport(PRECOMP_JSON);
    const ctx = createToolContext(new AbortController().signal);
    const { nodeIds } = applyImportPlan(plan, ctx, { updateComp: false });
    expect(nodeIds.length).toBe(2);

    const group = findByName('Pre');
    const inner = findByName('Inner');
    expect(inner.parent).toBe(group.id);

    // The child keeps its planned parent-relative local — NOT a world-
    // compensated one (the bug re-derived local as if (44,72) were world).
    const innerLocal = baseLocal(inner);
    expect(innerLocal.x).toBeCloseTo(44, 4);
    expect(innerLocal.y).toBeCloseTo(72, 4);

    // World = group (100,50) + child local (44,72).
    expect(worldOf(inner.id).x).toBeCloseTo(144, 4);
    expect(worldOf(inner.id).y).toBeCloseTo(122, 4);
  });

  it('a centring offset moves the root only; children follow via the parent', () => {
    const plan = planLottieImport(PRECOMP_JSON);
    const ctx = createToolContext(new AbortController().signal);
    applyImportPlan(plan, ctx, { updateComp: false, offset: { x: 10, y: 20 } });

    const group = findByName('Pre');
    const inner = findByName('Inner');

    // Root shifted by the offset; the child's LOCAL is untouched…
    expect(baseLocal(group).x).toBeCloseTo(110, 4);
    expect(baseLocal(group).y).toBeCloseTo(70, 4);
    expect(baseLocal(inner).x).toBeCloseTo(44, 4);
    expect(baseLocal(inner).y).toBeCloseTo(72, 4);

    // …so its world inherits the offset exactly once.
    expect(worldOf(inner.id).x).toBeCloseTo(154, 4);
    expect(worldOf(inner.id).y).toBeCloseTo(142, 4);
  });

  it('flat parent links (ty:3 null + parented shape) also keep locals', () => {
    const json: LottieJson = {
      fr: 30, w: 512, h: 512, op: 30,
      layers: [
        { ty: 3, ind: 1, nm: 'Hip', ks: { p: { a: 0, k: [200, 300] } } },
        { ty: 4, ind: 2, nm: 'Arm', parent: 1, ks: { p: { a: 0, k: [30, -40] } },
          shapes: [{ ty: 'rc', s: { a: 0, k: [20, 20] }, r: { a: 0, k: 0 } }] },
      ],
    };
    const plan = planLottieImport(json);
    const ctx = createToolContext(new AbortController().signal);
    applyImportPlan(plan, ctx, { updateComp: false });

    const arm = findByName('Arm');
    expect(arm.parent).toBe(findByName('Hip').id);
    expect(baseLocal(arm).x).toBeCloseTo(30, 4);
    expect(baseLocal(arm).y).toBeCloseTo(-40, 4);
    expect(worldOf(arm.id).x).toBeCloseTo(230, 4);
    expect(worldOf(arm.id).y).toBeCloseTo(260, 4);
  });
});
