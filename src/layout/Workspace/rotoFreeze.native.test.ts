/**
 * Roto Brush ▸ Freeze: the matte is the mask the tool finds by name and
 * replaces on every stroke; freezing renames it (document state, one undo
 * step) and the tool then refuses to segment or propagate on that layer.
 */

import type { Command } from '@motion/engine-api';
import { setupAppEngine, historyLabels, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { documentMirror } from '@stores/documentMirror';
import { mirrorMaskHeaders } from '@core/mirror/effects';
import { addMaskEdit } from '@layout/Effects/effectEdits';
import {
  ROTO_FROZEN_NAME, ROTO_PATH_NAME, isRotoFrozen, propagateRotoForward, rotoMattes, segmentStrokesToMask, setRotoFrozen,
} from '@core/workspace/rotoBrushTool';

let h: Harness;
let ID: string;
let release: () => void = () => undefined;

const tree = async () => {
  const m = documentMirror();
  await m.whenIdle();
  return m.tree(ID);
};
const names = async () => mirrorMaskHeaders(await tree()).map((x) => x.name);

beforeEach(async () => {
  h = await setupAppEngine();
  ID = (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'solid', name: 'Plate', init: [] } as Command) as { layer: string }).layer;
  // Stand in for the matte the tool writes: a mask carrying the tool's name.
  await addMaskEdit(ID, {
    id: 'm1', name: ROTO_PATH_NAME, mode: 'add', inverted: false, opacity: 1, feather: 0, closed: true,
    points: [{ x: -20, y: -20 }, { x: 20, y: -20 }, { x: 20, y: 20 }, { x: -20, y: 20 }],
  } as never, 'New Mask');
  release = documentMirror().retainTree(ID);
  await tree();
});
afterEach(async () => {
  release();
  await h.dispose();
});

const strokes = [{ id: 's1', kind: 'fg' as const, points: [{ x: 0, y: 0 }] }];

test('freeze renames the matte in one undo step; unfreeze gives the tool its matte back', async () => {
  expect(rotoMattes(ID).live).toHaveLength(1);
  expect(isRotoFrozen(ID)).toBe(false);
  const depth = (await historyLabels()).length;

  expect(await setRotoFrozen(ID, true)).toBe(true);
  expect(await names()).toEqual([ROTO_FROZEN_NAME]);
  expect(isRotoFrozen(ID)).toBe(true);
  expect(await historyLabels()).toHaveLength(depth + 1);
  expect((await historyLabels()).at(-1)).toBe('Freeze Roto Brush');
  // Already frozen: nothing to do, no history entry.
  expect(await setRotoFrozen(ID, true)).toBe(false);
  expect(await historyLabels()).toHaveLength(depth + 1);

  expect(await setRotoFrozen(ID, false)).toBe(true);
  expect(await names()).toEqual([ROTO_PATH_NAME]);
  expect((await historyLabels()).at(-1)).toBe('Unfreeze Roto Brush');
});

test('a frozen layer takes no new segment and no propagation; the matte is untouched', async () => {
  await setRotoFrozen(ID, true);
  await tree();
  await expect(segmentStrokesToMask(ID, strokes, 0)).rejects.toThrow(/frozen/i);
  await expect(propagateRotoForward(ID, strokes, 0, 1, 30, 2)).rejects.toThrow(/frozen/i);
  expect(await names()).toEqual([ROTO_FROZEN_NAME]);
});

test('undo takes the freeze back', async () => {
  await setRotoFrozen(ID, true);
  await h.run({ type: 'undo' } as Command);
  expect(await names()).toEqual([ROTO_PATH_NAME]);
  expect(isRotoFrozen(ID)).toBe(false);
});
