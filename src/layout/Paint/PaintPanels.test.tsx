/**
 * The Paint and Brushes panels drive the same stores the viewers read, and
 * every document edit they make is one undo step.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import type { Command } from '@motion/engine-api';
import { drawToolOptions } from '@motion/workspace';
import { defaultAnimation } from '@motion/animation';
import { getNodePaint } from '@core/paint/paintStrokes';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { useSelectionStore } from '@stores/selectionStore';
import { usePaintStore } from '@stores/paintStore';
import { useUIStore } from '@stores/uiStore';
import { PaintPanel } from './PaintPanel';
import { BrushesPanel } from './BrushesPanel';

const initial = usePaintStore.getState();
let h: Harness & { engine: LocalEngine };

beforeEach(async () => {
  h = await setupAppEngine();
  usePaintStore.setState(initial, true);
  useSelectionStore.getState().set([]);
  useUIStore.getState().setActiveTool('paint');
});
afterEach(async () => {
  await h.dispose();
});

const addStroke = async (layer: string, stroke: object): Promise<string> =>
  (await h.run({ type: 'addPaintStroke', layer, stroke: JSON.stringify(stroke), keys: [] }) as { stroke: string }).stroke;
const click = async (el: Element): Promise<void> => {
  await act(async () => {
    fireEvent.click(el);
    await engineIdle();
  });
};

describe('PaintPanel', () => {
  test('the tool switch picks Clone Stamp and shows Clone Options', () => {
    render(<PaintPanel />);
    expect(screen.getByText('Select one layer to see its paint.')).toBeTruthy();
    expect(screen.queryByText('Clone Options')).toBeNull();
    fireEvent.click(screen.getByText('Clone'));
    expect(usePaintStore.getState().mode).toBe('clone');
    expect(useUIStore.getState().activeTool).toBe('paint');
    expect(screen.getByText('Clone Options')).toBeTruthy();
    fireEvent.click(screen.getByText('Eraser'));
    expect(useUIStore.getState().activeTool).toBe('eraser');
    expect(screen.getByLabelText('Erase')).toBeTruthy();
  });

  test('lists the selected layer\'s strokes; hide, key, select and delete them — one engine edit each', async () => {
    const ID = (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'solid', name: 'Plate', init: [] } as Command) as { layer: string }).layer;
    const b = await addStroke(ID, { points: [{ x: 0, y: 0 }] });
    await addStroke(ID, { points: [{ x: 1, y: 1 }], mode: 'erase' });
    act(() => useSelectionStore.getState().set([ID]));
    render(<PaintPanel />);
    expect(screen.getByText('Brush 1')).toBeTruthy();
    expect(screen.getByText('Eraser 1')).toBeTruthy();

    await click(screen.getAllByLabelText('Hide stroke')[0]!);
    expect(getNodePaint(ID)!.strokes[0]!.visible).toBe(false);
    expect(historyLabels().at(-1)).toBe('Hide Paint Stroke');
    await click(screen.getAllByLabelText('Show stroke')[0]!);
    expect(getNodePaint(ID)!.strokes[0]!.visible).toBeUndefined();

    await click(screen.getAllByLabelText('Animate path')[0]!);
    expect(defaultAnimation.isDataAnimated(ID, `paint.${b}.path`)).toBe(true);
    expect(historyLabels().at(-1)).toBe('Enable Path Animation');
    await click(screen.getAllByLabelText('Stop animating path')[0]!);
    expect(defaultAnimation.isDataAnimated(ID, `paint.${b}.path`)).toBe(false);

    await click(screen.getByLabelText('Paint on Transparent'));
    expect(getNodePaint(ID)!.onTransparent).toBe(true);
    expect(historyLabels().at(-1)).toBe('Paint on Transparent');

    fireEvent.click(screen.getByText('Brush 1'));
    expect(usePaintStore.getState().selectedStroke).toEqual({ nodeId: ID, strokeId: b });

    await click(screen.getAllByLabelText('Delete stroke')[1]!);
    expect(getNodePaint(ID)!.strokes.map((s) => s.id)).toEqual([b]);
    expect(historyLabels().at(-1)).toBe('Delete Paint Stroke');
    await act(async () => {
      await h.run({ type: 'undo' });
    });
    expect(getNodePaint(ID)!.strokes).toHaveLength(2);
  });
});

describe('BrushesPanel', () => {
  test('a tip preset sets Diameter, Hardness and Spacing; dynamics bind to the pen', () => {
    render(<BrushesPanel />);
    fireEvent.click(screen.getByTitle(/^Soft 13 /));
    expect(drawToolOptions.brushSize).toBe(13);
    expect(usePaintStore.getState().hardness).toBe(0);
    expect(usePaintStore.getState().spacing).toBe(0.25);
    fireEvent.change(screen.getByLabelText('Size dynamics'), { target: { value: 'pressure' } });
    expect(usePaintStore.getState().dynamics.size).toBe('pressure');
  });
});
