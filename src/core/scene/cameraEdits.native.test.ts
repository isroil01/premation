/**
 * Set Focus Distance to Layer and Distribute Layers in Z through the engine:
 * each ONE undo entry, undone exactly.
 */

import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import { docView } from '@core/engine/__testHelpers__/docView';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { documentMirror } from '@stores/documentMirror';
import { useSelectionStore } from '@stores/selectionStore';
import { is3DEnabled } from './threeD';
import { distributeLayersInZ, focusDepthToLayer, linkFocusDistanceToLayer, setFocusDistanceToLayer } from './cameraCommands';

let h: Harness;
const comp = 'comp_root';
const pos = (x: number, y: number, z: number) => ({ kind: 'vec3' as const, value: { x, y, z } });

beforeEach(async () => { h = await setupAppEngine(); });
afterEach(async () => { await h.dispose(); });

async function layer(kind: 'camera' | 'solid', name: string): Promise<string> {
  return (await h.run({ type: 'createLayer', comp, kind, name, init: [] })).layer;
}

async function oneEntry(label: string, act: () => Promise<unknown>): Promise<void> {
  const before = (await h.doc());
  const n = (await historyLabels()).length;
  await act();
  await engineIdle();
  expect((await historyLabels()).slice(n)).toEqual([label]);
  const after = (await h.doc());
  await h.run({ type: 'undo' });
  expect((await h.doc())).toBe(before);
  await h.run({ type: 'redo' });
  expect((await h.doc())).toBe(after);
}

const stored = async (id: string, prop: string): Promise<unknown> =>
  (await docView()).getNode(id)!.components.find((c) => c.type === 'Transform')!.props[prop];

it('Set Focus Distance to Layer writes the axial depth, drops a Link expression — one entry', async () => {
  const cam = await layer('camera', 'Camera 1');
  const subject = await layer('solid', 'Subject');
  await h.run({ type: 'setLayerSwitches', layers: [subject], patch: { threeD: true } });
  await h.run({ type: 'setProperty', prop: { layer: subject, path: 'transform/position' }, value: pos(900, 500, 500) });
  expect(await linkFocusDistanceToLayer(cam, subject)).toBe(true);
  await engineIdle();
  const depth = (await focusDepthToLayer(cam, subject, 0))!;
  let written: number | null = null;
  await oneEntry('Set Focus Distance to Layer', async () => { written = await setFocusDistanceToLayer(cam, subject, 0); });
  expect(written).toBeCloseTo(depth, 6);
  expect((await stored(cam, 'focusDistance'))).toBeCloseTo(depth, 1);
  expect(documentMirror().property(cam, 'camera/focusDistance')?.expression ?? '').toBe('');
});

it('Distribute Layers in Z makes the layers 3D and spreads them in depth — one entry', async () => {
  await layer('camera', 'Camera 1');
  const a = await layer('solid', 'A');
  const b = await layer('solid', 'B');
  const c = await layer('solid', 'C');
  useSelectionStore.getState().set([a, b, c]);
  let r: { count: number; span: number } | null = null;
  await oneEntry('Distribute Layers in Z', async () => { r = await distributeLayersInZ(0); });
  expect(r).toMatchObject({ count: 3 });
  const view = await docView();
  for (const id of [a, b, c]) expect(is3DEnabled(view.getNode(id)! as never)).toBe(true);
  const zs: number[] = [];
  for (const id of [a, b, c]) zs.push((await stored(id, 'z')) as number);
  expect(new Set(zs).size).toBe(3);
});
