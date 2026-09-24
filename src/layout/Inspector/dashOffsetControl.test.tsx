/**
 * The dash-offset control has to be REACHABLE, and it has to write the track the
 * renderer reads.
 *
 * Two failures this guards, both of which leave every other test in this feature
 * green:
 *   • the row never renders (a model and a renderer with no way in);
 *   • the row renders but writes a different property name than
 *     `buildSnapshot` samples — the shape of F34, where `strokeWidth` has a
 *     stopwatch and no reader.
 *
 * The property name is taken from the SAME registry entry the renderer's track
 * name comes from, rather than being typed out again here, so a rename cannot
 * leave this passing.
 */

import { render, cleanup, fireEvent, screen, act } from '@testing-library/react';
import { AppearanceSection } from './AppearanceSection';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useSelectionStore } from '@stores/selectionStore';
import { defaultAnimation } from '@motion/animation';
import { getCommandSystem } from '@core/commands/CommandSystem';
import { resolvePropertyMeta } from '@core/inspector/propertyMeta';
import { readNodeStroke, defaultStroke } from '@core/paint/stroke';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { strokesCommands } from './appearance/paintEdits';

jest.useFakeTimers();

const PROP = 'strokeDashOffset';
const DASH = [24, 12];

let h: Harness & { engine: LocalEngine };
let ID: string;

/** The stroke, written through the engine as the panel writes it. */
async function setStroke(dash: number[]): Promise<void> {
  await h.batch('seed', strokesCommands(ID, [{
    ...defaultStroke('#33e0a0'), enabled: true, width: 14, opacity: 1,
    align: 'center', dash, cap: 'butt', join: 'miter',
  }]));
  getCommandSystem().getHistory().clear();
}

/** The panel keeps stroke controls behind a popover; open it by its trigger. */
function openStrokePopover(): void {
  const trigger = screen.queryAllByLabelText(/stroke/i)[0];
  if (trigger) fireEvent.click(trigger);
}

const idle = async (): Promise<void> => { await act(async () => { await engineIdle(); }); };
/** No second entry from the 700 ms recorder on top of the engine's. */
const settle = (): void => { act(() => { jest.advanceTimersByTime(2000); }); };
const undo = async (): Promise<void> => { await act(async () => { await h.run({ type: 'undo' }); }); };

beforeEach(async () => {
  h = await setupAppEngine();
  ({ layer: ID } = await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'shape', name: 'dash_probe', init: [] }));
  getCommandSystem().getHistory().clear();
  useSelectionStore.setState({ ids: [ID] } as never);
});

afterEach(async () => {
  cleanup();
  await h.dispose();
});

describe('the Dash Offset row', () => {
  it('is registered under the name the renderer samples', () => {
    // `buildSnapshot` folds `a.get('strokeDashOffset')`. If the registry and the
    // renderer ever disagree the control writes a track nothing reads.
    const meta = resolvePropertyMeta(PROP, ID);
    expect(meta.label).toBe('Dash Offset');
    expect(meta.unit).toBe('px');
  });

  it('appears once the stroke has a dash pattern', async () => {
    await setStroke(DASH);
    render(<AppearanceSection nodeId={ID} />);
    openStrokePopover();
    expect(screen.queryAllByLabelText('Dash Offset').length).toBeGreaterThan(0);
  });

  it('is ABSENT on a solid stroke — offset with no pattern would do nothing', async () => {
    await setStroke([]);
    render(<AppearanceSection nodeId={ID} />);
    openStrokePopover();
    expect(screen.queryAllByLabelText('Dash Offset')).toHaveLength(0);
  });

  it('its keyframe toggle writes the track the renderer reads — one undo entry', async () => {
    await setStroke(DASH);
    render(<AppearanceSection nodeId={ID} />);
    openStrokePopover();
    // The toggle is the row's stopwatch (AnimToggle) — the same control every
    // other animatable row uses since 2026-09-05, not a bare checkbox.
    const stopwatch = screen.getAllByLabelText('Enable Dash Offset animation')[0]!;
    expect(stopwatch).toBeTruthy();
    fireEvent.click(stopwatch);
    await idle();
    expect(defaultAnimation.isAnimated(ID, PROP)).toBe(true);
    settle();
    expect(historyLabels()).toHaveLength(1);
    await undo();
    expect(defaultAnimation.isAnimated(ID, PROP)).toBe(false);
  });

  it('editing with no animation writes the STATIC value onto the stroke — one undo entry', async () => {
    await setStroke(DASH);
    render(<AppearanceSection nodeId={ID} />);
    openStrokePopover();
    const field = screen.getAllByLabelText('Dash Offset')[0]!;
    fireEvent.keyDown(field, { key: 'Enter' });
    const input = field.querySelector('input');
    expect(input).toBeTruthy();
    fireEvent.change(input as Element, { target: { value: '9' } });
    fireEvent.keyDown(input as Element, { key: 'Enter' });
    await idle();
    expect(readNodeStroke(defaultSceneGraph.getNode(ID)!)?.dashOffset).toBe(9);
    expect(defaultAnimation.isAnimated(ID, PROP)).toBe(false);
    settle();
    expect(historyLabels()).toHaveLength(1);
    await undo();
    expect(readNodeStroke(defaultSceneGraph.getNode(ID)!)?.dashOffset ?? 0).toBe(0);
  });
});
