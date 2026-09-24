/**
 * Keyframe assistants off-document: the helper's keyframe changes land as
 * setKeyframes per property — one entry, undone exactly — and a helper that
 * changes anything else is refused with nothing changed.
 */

import { setupAppEngine, historyLabels } from '../__testHelpers__/appEngine';
import type { Harness } from '../__testHelpers__/harness';
import { buildScene, type Scene } from '../__testHelpers__/scene';
import type { LocalEngine } from '../LocalEngine';
import { engineIdle } from '../engineInstance';
import { assistantKeyframeCommands, assistantKeyframesEdit } from '../assistantKeys';
import { OffDocumentError } from '../offDocument';
import { smoothMotionPath } from '@core/motion/motionPath';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';

let h: Harness & { engine: LocalEngine };
let s: Scene;
beforeEach(async () => {
  h = await setupAppEngine();
  s = await buildScene(h);
});
afterEach(async () => { await h.dispose(); });

it('Smooth Motion Path: one entry of setKeyframes, undone exactly', async () => {
  await h.run({ type: 'addKeyframes', keys: [
    { prop: { layer: s.B, path: 'transform/position' }, time: 2 * 705_600_000, value: { kind: 'vec2', value: { x: 500, y: 100 } }, spatialIn: [], spatialOut: [] },
  ] });
  const before = h.doc();
  const plan = assistantKeyframeCommands([s.B], () => smoothMotionPath(s.B));
  expect(plan.cmds.map((c) => c.type)).toEqual(['setKeyframes']);
  expect(h.doc()).toBe(before); // the plan changed nothing
  const n = historyLabels().length;
  const { ok } = await assistantKeyframesEdit('Smooth motion path', [s.B], () => smoothMotionPath(s.B));
  await engineIdle();
  expect(ok).toBe(true);
  expect(historyLabels().slice(n)).toEqual(['Smooth motion path']);
  expect(h.doc()).not.toBe(before);
  await h.run({ type: 'undo' });
  expect(h.doc()).toBe(before);
});

it('a helper that changes nothing sends nothing', async () => {
  const n = historyLabels().length;
  const { ok } = await assistantKeyframesEdit('Nothing', [s.A], () => undefined);
  expect(ok).toBe(true);
  expect(historyLabels().length).toBe(n);
});

it('refuses a helper that changes more than keyframes, changing nothing', () => {
  const before = h.doc();
  expect(() => assistantKeyframeCommands([s.A], () => {
    defaultAnimation.setKeyframe(s.A, 'x', 0, 5);
    const n = defaultSceneGraph.getNode(s.A)!;
    defaultSceneGraph.writeProp(s.A, n.components[0]!.id, '__probe', 1);
  })).toThrow(OffDocumentError);
  expect(h.doc()).toBe(before);
});
