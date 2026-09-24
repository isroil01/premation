/**
 * Set Focus Distance to Layer and Distribute Layers in Z through the engine:
 * each ONE undo entry, undone exactly.
 */

import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { defaultAnimation } from '@motion/animation';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useSelectionStore } from '@stores/selectionStore';
import { is3DEnabled } from './threeD';
import { distributeLayersInZ, focusDepthToLayer, linkFocusDistanceToLayer, setFocusDistanceToLayer } from './cameraCommands';

let h: Harness & { engine: LocalEngine };
const comp = 'comp_root';
const pos = (x: number, y: number, z: number) => ({ kind: 'vec3' as const, value: { x, y, z } });

beforeEach(async () => { h = await setupAppEngine(); });
afterEach(async () => { await h.dispose(); });

async function layer(kind: 'camera' | 'solid', name: string): Promise<string> {
  return (await h.run({ type: 'createLayer', comp, kind, name, init: [] })).layer;
}

async function oneEntry(label: string, act: () => Promise<unknown>): Promise<void> {
  const before = h.doc();
  const n = historyLabels().length;
  await act();
  await engineIdle();
  expect(historyLabels().slice(n)).toEqual([label]);
  const after = h.doc();
  await h.run({ type: 'undo' });
  expect(h.doc()).toBe(before);
  await h.run({ type: 'redo' });
  expect(h.doc()).toBe(after);
}

const stored = (id: string, prop: string): unknown =>
  defaultSceneGraph.getNode(id)!.components.find((c) => c.type === 'Transform')!.props[prop];

it('Set Focus Distance to Layer writes the axial depth, drops a Link expression — one entry', async () => {
  const cam = await layer('camera', 'Camera 1');
  const subject = await layer('solid', 'Subject');
  await h.run({ type: 'setLayerSwitches', layers: [subject], patch: { threeD: true } });
  await h.run({ type: 'setProperty', prop: { layer: subject, path: 'transform/position' }, value: pos(900, 500, 500) });
  expect(linkFocusDistanceToLayer(cam, subject)).toBe(true);
  await engineIdle();
  const depth = focusDepthToLayer(defaultSceneGraph.getNode(cam)!, defaultSceneGraph.getNode(subject)!, 0)!;
  let written: number | null = null;
  await oneEntry('Set Focus Distance to Layer', async () => { written = await setFocusDistanceToLayer(cam, subject, 0); });
  expect(written).toBeCloseTo(depth, 6);
  expect(stored(cam, 'focusDistance')).toBeCloseTo(depth, 1);
  expect(defaultAnimation.getExpressionSrc(cam, 'focusDistance') ?? '').toBe('');
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
  for (const id of [a, b, c]) expect(is3DEnabled(defaultSceneGraph.getNode(id)!)).toBe(true);
  const zs = [a, b, c].map((id) => stored(id, 'z') as number);
  expect(new Set(zs).size).toBe(3);
});
