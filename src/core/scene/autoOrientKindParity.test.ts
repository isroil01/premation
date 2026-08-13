/**
 * Auto-orient must not be OFFERED on a kind that never reads it.
 *
 * WHY THIS EXISTS. `MotionControls` rendered the Auto-Orient dropdown for any
 * node carrying a Transform, and a camera has one. `camera3d.ts` never reads
 * `autoOrient`; neither does anything else. The value was written, persisted,
 * round-tripped and displayed — and consumed by nobody.
 *
 * Widening it was the surprise. There are exactly TWO readers, both in
 * `buildSnapshot`'s drawn-layer loop (`readNodeAutoOrient`, then
 * `isAutoOrientedToCamera`). That loop skips `group`/`null`/`camera`/`audio` at
 * its top and diverts `light` a few lines later, so the mode is dead on FIVE
 * kinds, not one. `null` is the one that stings: auto-orienting a null with
 * children parented to it is a standard AE rig, and the control looked live.
 *
 * This is the fourth control of this exact shape found in this repo — after the
 * spot cone that did nothing on a 2D layer, three light params that stopped at
 * the CPU, and `frameBlend` writing a flag no renderer read. Each cost nothing
 * to run, which is why each survived. So the guard is not "remember this one":
 * it DERIVES the dead set from `buildSnapshot.ts`'s own skip list, the way the
 * feature-count table derives from the registries. Change the loop and this
 * fails until the predicate agrees.
 *
 * IF THIS FAILS because you WIRED one of these kinds: remove it from
 * `AUTO_ORIENT_DEAD_KINDS` in the same commit that adds the reader. That edit
 * is the signal this test exists to produce.
 */

import { readSource } from '@/__testHelpers__/readSource';
import { AUTO_ORIENT_DEAD_KINDS, canAutoOrient } from './autoOrient';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { SceneNode } from '@core/types';


function node(kind: string, opts: { transform?: boolean } = {}): SceneNode {
  const components = [
    { id: 'n_meta', type: 'group', props: { [SCENE_KIND_PROP]: kind } },
    ...(opts.transform === false ? [] : [{ id: 'n_t', type: 'Transform', props: {} }]),
  ];
  return {
    id: 'n', name: 'n', parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components,
  } as unknown as SceneNode;
}

describe('auto-orient is offered only where it is read', () => {
  it('the dead set matches the kinds buildSnapshot skips before reading it', () => {
    const src = readSource('core/rendering/buildSnapshot.ts');

    // The drawn-layer loop's top-of-loop bail. Extracted rather than restated,
    // so editing the loop moves this test's expectation with it.
    const skip = /if \(kind === 'group'[^)]*\) continue;/.exec(src)?.[0];
    expect(skip).toBeTruthy();
    const skipped = [...(skip as string).matchAll(/kind === '(\w+)'/g)].map((m) => m[1]);
    expect(skipped.sort()).toEqual(['audio', 'camera', 'group', 'null']);

    // `light` never reaches the transform block either — it is diverted into
    // its own branch above it. Assert that branch still exists rather than
    // trusting the memory of having read it.
    expect(src).toMatch(/if \(kind === 'light'\) \{/);

    expect([...AUTO_ORIENT_DEAD_KINDS].sort())
      .toEqual([...skipped, 'light'].sort());
  });

  it('both readers really are inside that loop, and there are only two', () => {
    const src = readSource('core/rendering/buildSnapshot.ts');
    const readers = [...src.matchAll(/readNodeAutoOrient|isAutoOrientedToCamera/g)];
    // Two call sites + the one import line that names both.
    expect(readers).toHaveLength(4);
  });

  it.each([...AUTO_ORIENT_DEAD_KINDS])('hides the control on a %s layer', (kind) => {
    expect(canAutoOrient(node(kind))).toBe(false);
  });

  it.each(['shape', 'text', 'image', 'video'])('offers it on a %s layer', (kind) => {
    expect(canAutoOrient(node(kind))).toBe(true);
  });

  it('needs a Transform at all — the mode has nothing to write to without one', () => {
    expect(canAutoOrient(node('shape', { transform: false }))).toBe(false);
  });

  it('MotionControls gates the row on the predicate, not on hasTransform', () => {
    const ui = readSource('layout/Inspector/MotionControls.tsx');
    expect(ui).toMatch(/canAutoOrient\(node\)/);
    // The row must be conditional. Without this, the import could stay while
    // the gate was dropped, and every assertion above would still pass.
    expect(ui).toMatch(/\{showAutoOrient && \(/);
  });

  it('Motion Path stays ungated — smoothing a camera\'s position keys is real', () => {
    const ui = readSource('layout/Inspector/MotionControls.tsx');
    // `lastIndexOf`, not `indexOf`: the prose above the component also says
    // "Motion Path" (explaining precisely this exemption), and anchoring on the
    // comment sliced in the auto-orient row and failed. The JSX label is the
    // last occurrence.
    const motionPathRow = ui.slice(ui.lastIndexOf('Motion Path'));
    expect(motionPathRow).not.toMatch(/showAutoOrient/);
    // Anchor the slice: if the label is ever renamed this must fail loudly
    // rather than silently assert against an empty-ish tail.
    expect(motionPathRow).toMatch(/smoothMotionPath|straightenMotionPath/);
  });
});
