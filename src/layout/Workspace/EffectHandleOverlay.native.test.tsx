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

import { render, fireEvent, act, cleanup, waitFor } from '@testing-library/react';
import { paramsOf, effectPropPath } from '@core/effects/effects';
import { values } from '@core/engine/propRefs';
import { clearHistory, setupAppEngine, historyLabels, settleEdits, trackRef } from '@core/engine/__testHelpers__/appEngine';
import { docView } from '@core/engine/__testHelpers__/docView';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
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

/** The overlay's SVG, once a frame has carried the geometry it draws from. */
async function svgOf(container: HTMLElement): Promise<SVGSVGElement> {
  await waitFor(() => expect(container.querySelector('svg')).not.toBeNull());
  return container.querySelector('svg')!;
}

let h: Harness;
let ID: string;
let FX: string;

beforeEach(async () => {
  h = await setupAppEngine();
  ID = (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'shape', name: 'Box', init: [] })).layer;
  await h.run({ type: 'setProperty', prop: { layer: ID, path: 'transform/position' }, value: { kind: 'vec2', value: { x: 0, y: 0 } } });
  const { groups: [group] } = await h.run({ type: 'addEffect', layers: [ID], effect: 'bulge', params: [] });
  FX = group!.split('/')[1]!;
  await clearHistory();
  useSelectionStore.getState().set([ID]);
  useEffectHandleStore.getState().select(ID, FX);
});

afterEach(async () => {
  cleanup();
  useEffectHandleStore.getState().clear();
  await h.dispose();
});

const centre = async (): Promise<{ x: number; y: number }> => {
  const p = paramsOf((await docView()).getNodeEffects(ID).find((e) => e.id === FX)!) as Record<string, number>;
  return { x: p.centerX ?? 0, y: p.centerY ?? 0 };
};

function handleAt(container: HTMLElement): [number, number] {
  const c = container.querySelector('[aria-label="Bulge Centre handle"] circle');
  if (!c) throw new Error('no Bulge Centre handle drawn');
  return [Number(c.getAttribute('cx')), Number(c.getAttribute('cy'))];
}

/** Render, then let the mirror tree and the overlay geometry subscription land (B4). */
async function renderOverlay(): Promise<ReturnType<typeof render>> {
  const r = render(<EffectHandleOverlay />);
  await act(async () => { await settleEdits(); });
  // The handles draw once a frame carries the layer's geometry.
  await waitFor(() => expect(r.container.querySelector('[aria-label="Bulge Centre handle"]')).not.toBeNull());
  return r;
}

async function dragBy(svg: Element, from: [number, number], steps: Array<[number, number]>): Promise<void> {
  await act(async () => {
    fireEvent.pointerDown(svg, { clientX: from[0], clientY: from[1], pointerId: 1 });
    for (const [dx, dy] of steps) fireEvent.pointerMove(svg, { clientX: from[0] + dx, clientY: from[1] + dy, pointerId: 1 });
    const [dx, dy] = steps[steps.length - 1]!;
    fireEvent.pointerUp(svg, { clientX: from[0] + dx, clientY: from[1] + dy, pointerId: 1 });
    await settleEdits();
  });
}

test('a handle drag writes the params — ONE "Move Bulge Centre" entry; undo restores the document', async () => {
  const { container } = await renderOverlay();
  const svg = await svgOf(container);
  const start = (await centre());
  const before = (await h.doc());

  await dragBy(svg, handleAt(container), [[10, 5], [20, 10], [30, 20]]);

  // Absolute: the handle lands where the pointer ended, once — not the sum of
  // the moves.
  expect((await centre()).x).toBeCloseTo(start.x + 30, 6);
  expect((await centre()).y).toBeCloseTo(start.y + 20, 6);
  expect((await docView()).isAnimated(ID, effectPropPath(FX, 'centerX'))).toBe(false);
  expect((await historyLabels())).toEqual(['Move Bulge Centre']);

  await act(async () => { await h.run({ type: 'undo' }); });
  expect((await h.doc())).toEqual(before);
});

test('an animated param keys at the playhead; the static one takes the value', async () => {
  const track = effectPropPath(FX, 'centerX');
  const ref = await trackRef(ID, track);
  await h.run({ type: 'addKeyframes', keys: [{ prop: { layer: ID, path: ref.path }, time: 0, value: values.scalar(0), spatialIn: [], spatialOut: [] }] });
  await clearHistory();
  const { container } = await renderOverlay();
  const svg = await svgOf(container);
  const startY = (await centre()).y;

  await dragBy(svg, handleAt(container), [[40, 15]]);

  expect((await docView()).getTrackKeyframes(ID, track)?.map((k) => k.value)).toEqual([40]);
  expect((await docView()).isAnimated(ID, effectPropPath(FX, 'centerY'))).toBe(false);
  expect((await centre()).y).toBeCloseTo(startY + 15, 6);
  expect((await historyLabels())).toEqual(['Move Bulge Centre']);
});

test('a press that misses every handle writes nothing', async () => {
  const { container } = await renderOverlay();
  const svg = await svgOf(container);
  const before = (await h.doc());
  await dragBy(svg, [4000, 4000], [[4030, 4020]]);
  expect((await h.doc())).toEqual(before);
  expect((await historyLabels())).toEqual([]);
});
