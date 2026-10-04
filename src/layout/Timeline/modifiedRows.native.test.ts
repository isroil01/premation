/**
 * UU over the engine: a static Scale away from 100 % and a keyed Rotation
 * reveal their rows; an untouched layer reveals nothing.
 */

import type { Command } from '@motion/engine-api';
import { setupAppEngine } from '@core/engine/__testHelpers__/appEngine';
import { sec, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { documentMirror } from '@stores/documentMirror';
import { modifiedRowsOf } from './modifiedRows';

let h: Harness;

const settle = async (): Promise<void> => {
  await engineIdle();
  await documentMirror().whenIdle();
  for (let i = 0; i < 6; i++) await Promise.resolve();
};
const layer = async (): Promise<string> =>
  (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'null', name: 'N', init: [] } as Command) as { layer: string }).layer;

beforeEach(async () => {
  h = await setupAppEngine();
});
afterEach(async () => {
  await h.dispose();
});

it('an untouched layer reveals nothing', async () => {
  const id = await layer();
  await settle();
  // Width / Height count as set whenever a size is stored (the legacy rule's reading too): not Transform.
  expect((await modifiedRowsOf(id, 0)).filter((r) => r !== 'width' && r !== 'height')).toEqual([]);
});

it('a static 50 % scale and a keyed rotation reveal their rows', async () => {
  const id = await layer();
  await h.run({ type: 'setProperty', prop: { layer: id, path: 'transform/scale' }, value: { kind: 'vec2', value: { x: 50, y: 50 } } } as Command);
  await h.run({
    type: 'addKeyframes',
    keys: [0, 1].map((t) => ({ prop: { layer: id, path: 'transform/rotation' }, time: sec(t), value: { kind: 'scalar', value: 30 * t }, spatialIn: [], spatialOut: [] })),
  } as Command);
  await settle();
  const rows = await modifiedRowsOf(id, 0);
  expect(rows).toEqual(expect.arrayContaining(['__static:scale', 'scaleX', 'scaleY', '__static:rotation', 'rotation']));
  expect(rows).not.toContain('__static:opacity');
});
