/**
 * Lottie Trim Paths land as the editor's trim operator, with the animated
 * channels keyed onto the operator's own id-scoped prop paths.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { createLegacyDocumentContext } from '@core/ai/toolContext';
import { readTrimOp, pathOpPropPath } from '@core/scene/pathOps';
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

function findByName(name: string): SceneNode {
  let hit: SceneNode | null = null;
  defaultSceneGraph.traverse((n) => { if (!hit && n.name === name) hit = n; });
  if (!hit) throw new Error(`node "${name}" not found`);
  return hit;
}

const line = (): NonNullable<LottieJson['layers']>[number] => ({
  ty: 4, ind: 1, nm: 'line', ip: 0, op: 60,
  ks: { o: { a: 0, k: 100 }, p: { a: 0, k: [200, 200, 0] }, a: { a: 0, k: [0, 0, 0] }, s: { a: 0, k: [100, 100, 100] }, r: { a: 0, k: 0 } },
  shapes: [{ ty: 'gr', it: [
    { ty: 'sh', ks: { a: 0, k: { i: [[0, 0], [0, 0]], o: [[0, 0], [0, 0]], v: [[-100, 0], [100, 0]], c: false } } },
    { ty: 'st', c: { a: 0, k: [1, 1, 1, 1] }, o: { a: 0, k: 100 }, w: { a: 0, k: 4 } },
    { ty: 'tm', s: { a: 0, k: 0 }, e: { a: 1, k: [{ t: 0, s: [0] }, { t: 60, s: [100] }] }, o: { a: 0, k: 90 }, m: 1 },
    { ty: 'tr', p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } },
  ] }],
} as unknown as NonNullable<LottieJson['layers']>[number]);

describe('Lottie trim paths → trim operator', () => {
  beforeEach(reset);

  it('a single trimmed path (the draw-on) keeps its trim through the host collapse', () => {
    const json: LottieJson = { fr: 30, op: 60, w: 400, h: 400, layers: [line()] };
    const plan = planLottieImport(json);
    expect(plan.warnings.some((w) => /trim/i.test(w))).toBe(false);
    expect(plan.layers.length).toBe(1);
    expect(plan.layers[0]!.trim).toBeDefined();

    applyImportPlan(plan, createLegacyDocumentContext(), { updateComp: false });
    const node = findByName('line');
    const op = readTrimOp(node);
    expect(op).not.toBeNull();
    expect(op!.start).toBe(0);
    expect(op!.offset).toBeCloseTo(25); // 90° = a quarter turn
    expect(op!.trimMultipleShapes).toBe('simultaneously');

    const endProp = pathOpPropPath(op!.id, 'end');
    expect(defaultAnimation.isAnimated(node.id, endProp)).toBe(true);
    expect(defaultAnimation.sample(node.id, endProp, 0)).toBeCloseTo(0);
    expect(defaultAnimation.sample(node.id, endProp, 2)).toBeCloseTo(100);
  });
});
