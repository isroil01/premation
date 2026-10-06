/**
 * Paint strokes under the Selection tool in the Layer viewer: the stroke's
 * points reach the page (the engine reports an un-keyed Path's value), a click
 * selects, a drag moves the stroke's Position in the layer's pixels (one undo
 * step), Delete removes it.
 */

import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { secondsToFlicks, type Command } from '@motion/engine-api';
import { setupAppEngine, historyLabels, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { commitPaintDrag, setPaintPathAnimated } from '@core/engine/paintEdits';
import { mirrorPaintStrokeShapes } from '@core/mirror/paintStrokes';
import { documentMirror } from '@stores/documentMirror';
import { usePaintStore } from '@stores/paintStore';
import { useUIStore } from '@stores/uiStore';
import { LayerPaintSelect } from './LayerPaintSelect';

let h: Harness;
let ID: string;
let STROKE: string;
const initialPaint = usePaintStore.getState();
const initialTool = useUIStore.getState().activeTool;

beforeEach(async () => {
  h = await setupAppEngine();
  ID = (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'solid', name: 'Plate', init: [] } as Command) as { layer: string }).layer;
  usePaintStore.setState(initialPaint, true);
  const r = await commitPaintDrag({
    nodeId: ID, mode: 'paint', points: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 80, y: 10 }], times: [0, 50, 100], pen: [null, null, null], size: 12, compTime: 0,
  });
  STROKE = (r as { strokeId: string }).strokeId;
  await documentMirror().whenIdle();
  act(() => useUIStore.setState({ activeTool: 'select' as never }));
});
afterEach(async () => {
  act(() => useUIStore.setState({ activeTool: initialTool }));
  await h.dispose();
});

const shapes = async () => {
  await documentMirror().whenIdle();
  return mirrorPaintStrokeShapes(documentMirror(), ID);
};

// 2 screen px per layer px.
const view = { scale: 2, offsetX: 0, offsetY: 0 };
const mount = () => render(<LayerPaintSelect nodeId={ID} frameWidth={200} frameHeight={100} view={view} stageWidth={400} stageHeight={200} compTime={0} />);
const hit = (c: HTMLElement): SVGPathElement => c.querySelector(`[data-paint-stroke="${STROKE}"] path:last-of-type`) as SVGPathElement;

test('the stroke’s points and brush reach the page', async () => {
  const s = (await shapes())[0]!;
  expect(s.id).toBe(STROKE);
  expect(s.points.length).toBeGreaterThanOrEqual(2);
  expect(s.points[0]).toEqual({ x: 0, y: 0 });
  expect(s.diameter).toBe(12);
  expect([s.positionX, s.positionY, s.scale]).toEqual([0, 0, 100]);
});

test('click selects; a drag moves the stroke by the layer’s pixels in one undo step', async () => {
  const { container } = mount();
  const depth = (await historyLabels()).length;
  fireEvent.pointerDown(hit(container), { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
  expect(usePaintStore.getState().selectedStroke).toEqual({ nodeId: ID, strokeId: STROKE });
  fireEvent.pointerMove(hit(container), { clientX: 130, clientY: 80, pointerId: 1 });
  fireEvent.pointerUp(hit(container), { clientX: 130, clientY: 80, pointerId: 1 });
  await waitFor(async () => expect((await historyLabels()).at(-1)).toBe('Move Paint Stroke'));
  expect(await historyLabels()).toHaveLength(depth + 1);
  const s = (await shapes())[0]!;
  // 30 × −20 screen px at 2× = 15 × −10 layer px.
  expect([s.positionX, s.positionY]).toEqual([15, -10]);
  // The points themselves are untouched: the move is the stroke's Transform.
  expect(s.points[0]).toEqual({ x: 0, y: 0 });
});

test('a click without travel moves nothing; Delete removes the selected stroke', async () => {
  const { container } = mount();
  const depth = (await historyLabels()).length;
  fireEvent.pointerDown(hit(container), { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
  fireEvent.pointerUp(hit(container), { clientX: 101, clientY: 100, pointerId: 1 });
  expect(await historyLabels()).toHaveLength(depth);
  fireEvent.keyDown(container.querySelector('svg')!, { key: 'Delete' });
  await waitFor(async () => expect(await shapes()).toHaveLength(0));
  expect((await historyLabels()).at(-1)).toBe('Delete Paint Stroke');
  expect(usePaintStore.getState().selectedStroke).toBeNull();
});

test('another tool: the strokes are not in the pointer’s way', () => {
  act(() => useUIStore.setState({ activeTool: 'pen' as never }));
  const { container } = mount();
  expect(container.querySelector('svg')).toBeNull();
});

test('a keyframed Path is picked at its shape at the time on show', async () => {
  await setPaintPathAnimated(ID, STROKE, true, 0);
  await h.run({ type: 'setPaintStrokePath', layer: ID, stroke: STROKE, points: JSON.stringify([{ x: 10, y: 30 }, { x: 60, y: 30 }]), time: secondsToFlicks(1) } as Command);
  await documentMirror().whenIdle();
  const { container } = render(<LayerPaintSelect nodeId={ID} frameWidth={200} frameHeight={100} view={view} stageWidth={400} stageHeight={200} compTime={1} />);
  // Layer (10, 30), centred in a 200 × 100 frame at 2×, is stage (220, 160).
  await waitFor(() => expect(hit(container).getAttribute('d')).toMatch(/^M220\.0 160\.0 /));
});
