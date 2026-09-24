/**
 * A gradient STROKE exposes its whole stop list, not just its two ends.
 *
 * ## The gap
 *
 * The model and the rasterizer have always carried any number of stops. The
 * inspector wired two lone `ColorPicker`s to `stops[0]` and `stops[n-1]`, so a
 * three-stop stroke rendered three stops and offered two — and no control could
 * add or remove one. A capability reachable only by editing the file.
 *
 * ## Rule 5·0 — the observable and the medium
 *
 * The observable is HOW MANY STOPS THE PANEL OFFERS, and that each one is
 * separately addressable. It is produced by `StopList`, so the medium is the
 * rendered rows read back through `aria-label` — never the JSX, and never a
 * count of what was passed in.
 *
 * ## What the clean fixture would exclude
 *
 * TWO stops. That is exactly the count the old two-picker UI handled correctly,
 * so a two-stop fixture cannot tell the old code from the new. Every fixture
 * here has THREE, and the middle one is the subject: it is the stop the previous
 * UI could not reach.
 */

import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { AppearanceSection } from './AppearanceSection';
import { useSelectionStore } from '@stores/selectionStore';
import { getNodeStroke, defaultStroke } from '@core/paint/stroke';
import { getCommandSystem } from '@core/commands/CommandSystem';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { strokesCommands } from './appearance/paintEdits';

jest.useFakeTimers();

/** THREE stops — see the header; two could not distinguish old from new. */
const STOPS = [
  { id: 's0', offset: 0, color: '#ff0000' },
  { id: 's1', offset: 0.5, color: '#00ff00' },
  { id: 's2', offset: 1, color: '#0000ff' },
];

let h: Harness & { engine: LocalEngine };
let ID: string;

/** A shape layer made through the app's engine, its stroke a three-stop gradient written as the panel writes it. */
async function seed(): Promise<void> {
  ({ layer: ID } = await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'shape', name: 'grad_stroke', init: [] }));
  await h.batch('seed', strokesCommands(ID, [{
    ...defaultStroke('#ffffff'), enabled: true, width: 8, opacity: 1,
    align: 'center', dash: [], cap: 'butt', join: 'miter',
    paint: { type: 'linear', angle: 90, stops: STOPS.map((s) => ({ ...s })) },
  } as never]));
  getCommandSystem().getHistory().clear();
  useSelectionStore.setState({ ids: [ID] } as never);
}

beforeEach(async () => {
  h = await setupAppEngine();
  await seed();
});
afterEach(async () => {
  cleanup();
  await h.dispose();
});

const idle = async (): Promise<void> => { await act(async () => { await engineIdle(); }); };
/** No second entry from the 700 ms recorder on top of the engine's. */
const settle = (): void => { act(() => { jest.advanceTimersByTime(2000); }); };
const undo = async (): Promise<void> => { await act(async () => { await h.run({ type: 'undo' }); }); };

/** Stop rows the panel offers, read back off the DOM. */
const stopLabels = (c: HTMLElement): string[] =>
  [...c.querySelectorAll('[aria-label]')]
    .map((e) => e.getAttribute('aria-label') ?? '')
    .filter((l) => /^Stop \d+ (color|position)$/.test(l));

describe('the fixture is unclean, as the header requires', () => {
  it('POSITIVE CONTROL: the stroke gradient has THREE stops, not two', () => {
    expect(getNodeStroke(ID)?.paint?.type).not.toBe('solid');
    expect((getNodeStroke(ID)?.paint as { stops: unknown[] }).stops).toHaveLength(3);
  });
});

describe('the panel offers every stop', () => {
  it('renders a colour AND a position control for all three', () => {
    const { container } = render(<AppearanceSection nodeId={ID} />);
    const labels = stopLabels(container);
    for (const want of ['Stop 1 color', 'Stop 2 color', 'Stop 3 color',
                        'Stop 1 position', 'Stop 2 position', 'Stop 3 position']) {
      expect({ want, found: labels.includes(want) }).toEqual({ want, found: true });
    }
  });

  it('offers a REMOVE for each — the old UI had none at all', () => {
    const { container } = render(<AppearanceSection nodeId={ID} />);
    const removes = [...container.querySelectorAll('[aria-label]')]
      .map((e) => e.getAttribute('aria-label') ?? '')
      .filter((l) => /^Remove stop \d+$/.test(l));
    expect(removes).toHaveLength(3);
  });

  it('offers an ADD — the capability that was unreachable entirely', () => {
    const { container } = render(<AppearanceSection nodeId={ID} />);
    const add = [...container.querySelectorAll('button')]
      .find((b) => /add stop/i.test(b.textContent ?? ''));
    expect(add).toBeTruthy();
  });
});

describe('editing the MIDDLE stop — the one the old UI could not reach', () => {
  it('moving stop 2 writes stop 2, and leaves the ends alone — one undo entry', async () => {
    const { container } = render(<AppearanceSection nodeId={ID} />);
    const before = h.doc();
    const field = [...container.querySelectorAll('[role="spinbutton"][aria-label="Stop 2 position"]')][0]!;
    fireEvent.keyDown(field, { key: 'ArrowUp' });
    await idle();

    const stops = (getNodeStroke(ID)?.paint as { stops: Array<{ offset: number }> }).stops;
    const offsets = stops.map((s) => s.offset).sort((a, b) => a - b);
    // Anchored to WHICH stop moved: the ends are still 0 and 1, and the middle
    // is no longer 0.5. A write that hit the wrong stop fails on the ends.
    expect(offsets[0]).toBeCloseTo(0, 6);
    expect(offsets[2]).toBeCloseTo(1, 6);
    expect(offsets[1]).not.toBeCloseTo(0.5, 6);
    settle();
    expect(historyLabels()).toHaveLength(1);
    await undo();
    expect(h.doc()).toBe(before);
  });

  it('removing stop 2 leaves the two ends — one undo entry', async () => {
    const { container } = render(<AppearanceSection nodeId={ID} />);
    const before = h.doc();
    const remove = [...container.querySelectorAll('[aria-label="Remove stop 2"]')][0] as HTMLElement;
    fireEvent.click(remove);
    await idle();
    const stops = (getNodeStroke(ID)?.paint as { stops: Array<{ color: string }> }).stops;
    expect(stops).toHaveLength(2);
    expect(stops.map((s) => s.color).sort()).toEqual(['#0000ff', '#ff0000']);
    settle();
    expect(historyLabels()).toHaveLength(1);
    await undo();
    expect(h.doc()).toBe(before);
  });
});

describe('stop keyframing stays FILL-only, and that is deliberate', () => {
  it('the stroke stop list offers no stopwatch', () => {
    // The animated stop list is read from the `fill.stops` data track and there
    // is no `stroke.stops` equivalent in the renderer. Offering the control here
    // would write keyframes nothing samples — F34, fixed twice on this branch.
    const { container } = render(<AppearanceSection nodeId={ID} />);
    const animateChips = [...container.querySelectorAll('button')]
      .filter((b) => /animate stops|stops keyframed/i.test(b.textContent ?? ''));
    expect(animateChips).toHaveLength(0);
  });
});
