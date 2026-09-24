/**
 * B4: Track Motion's document reads come from the MIRROR (core/mirror/tracking.ts).
 * Pinned on the app engine against the scene-graph readers they replace, so
 * the section shows — and the apply helpers compose — exactly what they did.
 */

import { defaultAnimation } from '@motion/animation';
import { setupAppEngine } from '@core/engine/__testHelpers__/appEngine';
import { buildScene, type Scene } from '@core/engine/__testHelpers__/scene';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { readPropertyValue } from '@core/inspector/multiSelection';
import { staticOrDefaultValue } from '@core/inspector/propertyValue';
import { effectPropPath, getNodeEffects } from '@core/effects/effects';
import type { TrackPlan } from '@core/tracking/applyTrack';
import { propRefForTrack, valueOfNumbers } from '@core/engine/propRefs';
import { applyTrackPlanEdit } from './trackApplyEdits';
import { getNodeMask } from '@core/effects/mask';
import { canReparent } from '@core/scene/parenting';
import { sourceDisplaySize } from '@core/tracking/trackerSource';
import { findSolveCamera, nextTrackedNullName } from '@core/tracking/applyTrack';
import { documentMirror } from '@stores/documentMirror';
import {
  canParentTo,
  findSolveCameraIn,
  firstEffectOfType,
  footageDisplaySize,
  maskVertexCount,
  memberStoredAt,
  nextTrackedNullNameIn,
  siblingSourceIds,
} from '@core/mirror/tracking';

jest.useFakeTimers();

let h: Harness & { engine: LocalEngine };
let s: Scene;
beforeEach(async () => {
  h = await setupAppEngine();
  s = await buildScene(h);
  await engineIdle();
});
afterEach(async () => {
  await h.dispose();
});

test('footage size, mask vertices and the first effect of a type match the scene readers', () => {
  const m = documentMirror();
  for (const id of [s.V, s.A, s.B]) expect(footageDisplaySize(m, id)).toEqual(sourceDisplaySize(id));
  for (const id of [s.A, s.B, s.V]) {
    expect(maskVertexCount(m, id)).toBe(getNodeMask(id).paths.reduce((n, p) => n + p.points.length, 0));
  }
  expect(maskVertexCount(m, s.A)).toBe(4);
  expect(firstEffectOfType(m, s.A, 'glow')).toBe(getNodeEffects(s.A).find((e) => e.type === 'glow')?.id);
  expect(firstEffectOfType(m, s.A, 'glow')).toBe(s.fx);
  expect(firstEffectOfType(m, s.A, 'corner-pin')).toBeUndefined();
});

test('a member keeps its keyed / static value (stored units) like readPropertyValue ?? staticOrDefaultValue', () => {
  const m = documentMirror();
  const legacy = (id: string, track: string, t: number): number => readPropertyValue(id, track, t) ?? staticOrDefaultValue(id, track);
  for (const t of [0, 0.25, 0.5, 1, 2]) {
    for (const track of ['x', 'y', 'rotation', 'scaleX', 'scaleY', 'opacity']) {
      expect(memberStoredAt(m, s.B, track, t)).toBeCloseTo(legacy(s.B, track, t), 6);
      expect(memberStoredAt(m, s.A, track, t)).toBeCloseTo(legacy(s.A, track, t), 6);
    }
  }
  expect(defaultAnimation.isAnimated(s.B, 'x')).toBe(true);
});

test('an effect member keeps its value like the scene reader', async () => {
  await h.run({ type: 'addEffect', layers: [s.B], effect: 'corner-pin', params: [] });
  await engineIdle();
  const m = documentMirror();
  const id = firstEffectOfType(m, s.B, 'corner-pin')!;
  const r = propRefForTrack(s.B, effectPropPath(id, 'bottomRightX'))!;
  await h.run({ type: 'setProperty', prop: r.ref, value: valueOfNumbers(r.valueType, r.members.map((_, i) => 37 + i)) });
  await engineIdle();
  expect(id).toBe(getNodeEffects(s.B).find((e) => e.type === 'corner-pin')?.id);
  for (const k of ['topLeftX', 'topLeftY', 'bottomRightX', 'bottomRightY']) {
    const track = effectPropPath(id, k);
    expect([k, memberStoredAt(m, s.B, track, 0)]).toEqual([k, readPropertyValue(s.B, track, 0) ?? staticOrDefaultValue(s.B, track)]);
  }
  expect(memberStoredAt(m, s.B, effectPropPath(id, 'bottomRightX'), 0)).not.toBe(0);
});

test('a plan keys once per member group, the unkeyed member keeping its value; an effect plan reuses its effect', async () => {
  const plan = (writes: TrackPlan['writes'], effectType?: string): TrackPlan => ({ label: 'Apply Motion Track', layer: s.B, writes, count: 1, ...(effectType ? { effectType } : {}) });
  expect(await applyTrackPlanEdit(plan([{ track: 'x', keys: [{ compTime: 0.5, value: 50 }] }]))).toBe(1);
  await engineIdle();
  expect(readPropertyValue(s.B, 'x', 0.5)).toBeCloseTo(50, 6);
  expect(readPropertyValue(s.B, 'y', 0.5)).toBeCloseTo(150, 6);

  const pin = plan([{ track: 'topLeftX', keys: [{ compTime: 0, value: 10 }, { compTime: 1, value: 20 }] }], 'corner-pin');
  expect(await applyTrackPlanEdit(pin)).toBe(1);
  expect(await applyTrackPlanEdit(pin)).toBe(1);
  await engineIdle();
  const pins = getNodeEffects(s.B).filter((e) => e.type === 'corner-pin');
  expect(pins).toHaveLength(1);
  expect(readPropertyValue(s.B, effectPropPath(pins[0]!.id, 'topLeftX'), 1)).toBeCloseTo(20, 6);
});

test('parenting to the tracked null follows canReparent (self, loops, other comps)', async () => {
  await h.run({ type: 'setParent', layers: [s.B], parent: s.P, keepWorldTransform: false });
  await engineIdle();
  const m = documentMirror();
  const ids = [s.A, s.B, s.T, s.V, s.P, s.c2layer];
  for (const child of ids) {
    for (const parent of [...ids, s.comp, s.comp2]) {
      expect([child, parent, canParentTo(m, child, parent)]).toEqual([child, parent, canReparent(child, parent)]);
    }
  }
});

test('the same-parent list and the null names / solve camera match the scene', async () => {
  const m0 = documentMirror();
  const top = siblingSourceIds(m0, s.A).filter((id) => m0.layer(id)?.parent === undefined);
  expect(new Set(top)).toEqual(new Set([s.A, s.B, s.T, s.V, s.P]));

  expect(nextTrackedNullNameIn(m0)).toBe(nextTrackedNullName());
  await h.run({ type: 'createLayer', comp: s.comp, kind: 'null', name: 'Tracked Null', init: [] });
  await h.run({ type: 'createLayer', comp: s.comp2, kind: 'null', name: 'Tracked Null 2', init: [] });
  await engineIdle();
  expect(nextTrackedNullNameIn(documentMirror())).toBe('Tracked Null 3');
  expect(nextTrackedNullNameIn(documentMirror())).toBe(nextTrackedNullName());

  expect(findSolveCameraIn(documentMirror())).toBeNull();
  await h.run({ type: 'createLayer', comp: s.comp, kind: 'camera', name: 'Plain camera', init: [] });
  const { layer: cam } = await h.run({
    type: 'createLayer', comp: s.comp2, kind: 'camera', name: '3D Camera Tracker',
    init: [{ path: 'camera/trackerSolve', value: { kind: 'bool', value: true } }],
  });
  await engineIdle();
  expect(findSolveCameraIn(documentMirror())).toBe(cam);
  expect(findSolveCameraIn(documentMirror())).toBe(findSolveCamera({}));
  expect(findSolveCameraIn(documentMirror(), s.comp)).toBeNull();
  expect(findSolveCameraIn(documentMirror(), s.comp2)).toBe(cam);
});
