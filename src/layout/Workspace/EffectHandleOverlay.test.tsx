/**
 * The effect handle overlay's WRITE through the engine API (B3,
 * docs/B3_PATTERNS.md §3/§7): a handle drag is ONE gesture — every move an
 * absolute param value, one undo entry named after the handle, undo restores
 * the document exactly — and an animated param keys at the playhead instead
 * of taking a static value (the numeric field's rule).
 *
 * The camera is mocked 1:1 and the layer sits at the comp origin, so screen px
 * ARE layer-local px; handle positions are read back out of the overlay's own
 * drawing.
 */

import { render, fireEvent, act, cleanup } from '@testing-library/react';
import { defaultAnimation } from '@motion/animation';
import { getNodeEffects, paramsOf, effectPropPath } from '@core/effects/effects';
import { getCommandSystem } from '@core/commands/CommandSystem';
import { engineIdle } from '@core/engine/engineInstance';
import { propRefForTrack, values } from '@core/engine/propRefs';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { useSelectionStore } from '@stores/selectionStore';
import { useEffectHandleStore } from '@stores/effectHandleStore';
import { EffectHandleOverlay } from './EffectHandleOverlay';

jest.mock('@core/workspace/WorkspaceController', () => ({
  getWorkspaceController: () => ({
    onRender: () => () => undefined,
    requestRender: () => undefined,
    ws: {
      camera: {
        zoom: 1,
        worldToScreen: (p: { x: number; y: number }) => ({ x: p.x, y: p.y }),
        screenToWorld: (p: { x: number; y: number }) => ({ x: p.x, y: p.y }),
      },
    },
  }),
}));

let h: Harness & { engine: LocalEngine };
let ID: string;
let FX: string;

beforeEach(async () => {
  h = await setupAppEngine();
  ID = (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'shape', name: 'Box', init: [] })).layer;
  await h.run({ type: 'setProperty', prop: { layer: ID, path: 'transform/position' }, value: { kind: 'vec2', value: { x: 0, y: 0 } } });
  const { groups: [group] } = await h.run({ type: 'addEffect', layers: [ID], effect: 'bulge', params: [] });
  FX = group!.split('/')[1]!;
  getCommandSystem().getHistory().clear();
  useSelectionStore.getState().set([ID]);
  useEffectHandleStore.getState().select(ID, FX);
});

afterEach(async () => {
  cleanup();
  useEffectHandleStore.getState().clear();
  await h.dispose();
});

const centre = (): { x: number; y: number } => {
  const p = paramsOf(getNodeEffects(ID).find((e) => e.id === FX)!) as Record<string, number>;
  return { x: p.centerX ?? 0, y: p.centerY ?? 0 };
};

function handleAt(container: HTMLElement): [number, number] {
  const c = container.querySelector('[aria-label="Bulge Centre handle"] circle');
  if (!c) throw new Error('no Bulge Centre handle drawn');
  return [Number(c.getAttribute('cx')), Number(c.getAttribute('cy'))];
}

async function dragBy(svg: Element, from: [number, number], steps: Array<[number, number]>): Promise<void> {
  await act(async () => {
    fireEvent.pointerDown(svg, { clientX: from[0], clientY: from[1], pointerId: 1 });
    for (const [dx, dy] of steps) fireEvent.pointerMove(svg, { clientX: from[0] + dx, clientY: from[1] + dy, pointerId: 1 });
    const [dx, dy] = steps[steps.length - 1]!;
    fireEvent.pointerUp(svg, { clientX: from[0] + dx, clientY: from[1] + dy, pointerId: 1 });
    await engineIdle();
  });
}

test('a handle drag writes the params — ONE "Move Bulge Centre" entry; undo restores the document', async () => {
  const { container } = render(<EffectHandleOverlay />);
  const svg = container.querySelector('svg')!;
  const start = centre();
  const before = h.doc();

  await dragBy(svg, handleAt(container), [[10, 5], [20, 10], [30, 20]]);

  // Absolute: the handle lands where the pointer ended, once — not the sum of
  // the moves.
  expect(centre().x).toBeCloseTo(start.x + 30, 6);
  expect(centre().y).toBeCloseTo(start.y + 20, 6);
  expect(defaultAnimation.isAnimated(ID, effectPropPath(FX, 'centerX'))).toBe(false);
  expect(historyLabels()).toEqual(['Move Bulge Centre']);

  await act(async () => { await h.run({ type: 'undo' }); });
  expect(h.doc()).toEqual(before);
});

test('an animated param keys at the playhead; the static one takes the value', async () => {
  const track = effectPropPath(FX, 'centerX');
  const ref = propRefForTrack(ID, track)!.ref;
  await h.run({ type: 'addKeyframes', keys: [{ prop: ref, time: 0, value: values.scalar(0), spatialIn: [], spatialOut: [] }] });
  getCommandSystem().getHistory().clear();
  const { container } = render(<EffectHandleOverlay />);
  const svg = container.querySelector('svg')!;
  const startY = centre().y;

  await dragBy(svg, handleAt(container), [[40, 15]]);

  expect(defaultAnimation.sample(ID, track, 0)).toBeCloseTo(40, 6);
  expect(defaultAnimation.isAnimated(ID, effectPropPath(FX, 'centerY'))).toBe(false);
  expect(centre().y).toBeCloseTo(startY + 15, 6);
  expect(historyLabels()).toEqual(['Move Bulge Centre']);
});

test('a press that misses every handle writes nothing', async () => {
  const { container } = render(<EffectHandleOverlay />);
  const svg = container.querySelector('svg')!;
  const before = h.doc();
  await dragBy(svg, [4000, 4000], [[4030, 4020]]);
  expect(h.doc()).toEqual(before);
  expect(historyLabels()).toEqual([]);
});
