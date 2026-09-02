/**
 * The choreography panel: the controls have to reach the plan, and the plan
 * has to reach the keyframes.
 *
 * What is worth pinning is the wiring, not the layout. A parametric panel that
 * renders every input correctly and applies the DEFAULTS is the exact failure
 * this rework exists to fix — it looks completely right in a screenshot — so
 * every assertion here goes through a real apply and reads what the engine
 * stored, never what the component rendered.
 *
 * The per-layer list gets the most attention because it is the only control
 * whose value is both displayed and editable: it shows the computed plan until
 * you type in it, and then it must show yours and keep showing yours.
 */

import { render, screen, fireEvent, cleanup, within, act } from '@testing-library/react';
import { defaultAnimation } from '@motion/animation';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import { useSelectionStore } from '@stores/selectionStore';
import { useChoreographyStore } from '@stores/choreographyStore';
import { activeCompId } from '@core/animation/choreographyCommands';
import { ChoreographySection } from './ChoreographySection';

const LAYERS = ['panel_a', 'panel_b', 'panel_c'];

function addLayer(id: string, x: number): void {
  defaultSceneGraph.addChild('comp_root', {
    id,
    name: `Layer ${id.slice(-1).toUpperCase()}`,
    parent: 'comp_root',
    children: [],
    transform: { position: { x, y: 100 }, rotation: 0, scale: { x: 1, y: 1 } },
    visible: true,
    locked: false,
    components: [{ id: `${id}_t`, type: 'Transform', props: { __kind: 'solid', x, y: 100, width: 50, height: 50 } }],
  } as never);
}

/** The first keyframe time on each layer, in the order the layers were added. */
function starts(): number[] {
  return LAYERS.map((id) => {
    const ts = defaultAnimation.tracksFor(id).flatMap((t) => t.keyframes.map((k) => k.t));
    return ts.length ? Math.min(...ts) : Number.NaN;
  });
}

/** Every editable offset box in the per-layer list, in render order. */
function offsetInputs(): HTMLInputElement[] {
  return screen.getAllByLabelText(/^Offset for /) as HTMLInputElement[];
}

beforeAll(() => {
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) as never }));
});

beforeEach(() => {
  for (const id of LAYERS) {
    if (defaultSceneGraph.getNode(id)) defaultSceneGraph.removeNode?.(id);
  }
  // Positions descend, so "Left to right" disagrees with selection order and a
  // test that confuses the two cannot pass by accident.
  LAYERS.forEach((id, i) => addLayer(id, 500 - i * 150));
  defaultAnimation.clear();
  useChoreographyStore.setState({ byComp: {}, lastParams: null });
  useSelectionStore.setState({ ids: [...LAYERS] } as never);
});

afterEach(() => {
  cleanup();
  defaultAnimation.clear();
});

describe('ChoreographySection controls', () => {
  it('lists a row per selected layer, by name, before anything is applied', () => {
    render(<ChoreographySection />);
    expect(screen.getByText('Planned offsets')).toBeInTheDocument();
    const rows = offsetInputs();
    expect(rows).toHaveLength(3);
    expect(screen.getByLabelText('Offset for Layer A')).toBeInTheDocument();
  });

  it('applies the base offset that is in the box, not the default', () => {
    render(<ChoreographySection />);
    fireEvent.change(screen.getByTitle(/Frames between arrivals/), { target: { value: '10' } });
    fireEvent.change(screen.getByTitle(/How much each gap varies/), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Animate In' }));

    const [a, b, c] = starts();
    // 10 frames at the fixture's 30fps.
    expect(b! - a!).toBeCloseTo(10 / 30, 5);
    expect(c! - b!).toBeCloseTo(10 / 30, 5);
  });

  it('applies the chosen order', () => {
    render(<ChoreographySection />);
    fireEvent.change(screen.getByDisplayValue('Selection order'), { target: { value: 'byPositionX' } });
    fireEvent.change(screen.getByTitle(/Frames between arrivals/), { target: { value: '6' } });
    fireEvent.change(screen.getByTitle(/How much each gap varies/), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Animate In' }));

    // Layer C sits furthest left, so it must lead and A must trail.
    const [a, b, c] = starts();
    expect(c).toBeLessThan(b!);
    expect(b).toBeLessThan(a!);
  });

  it('applies the panel feel rather than the global preference', () => {
    render(<ChoreographySection />);
    fireEvent.click(screen.getByRole('button', { name: 'Snappy' }));
    fireEvent.click(screen.getByRole('button', { name: 'Animate In' }));
    expect(useChoreographyStore.getState().byComp[activeCompId()]?.params.feel).toBe('snappy');
  });

  it('rerolling the seed changes the seed that gets applied', () => {
    render(<ChoreographySection />);
    const seedBox = screen.getByTitle(/Same seed/) as HTMLInputElement;
    const before = seedBox.value;
    fireEvent.click(screen.getByRole('button', { name: 'Reroll the seed' }));
    expect(seedBox.value).not.toBe(before);

    fireEvent.click(screen.getByRole('button', { name: 'Animate In' }));
    expect(useChoreographyStore.getState().byComp[activeCompId()]?.params.seed).toBe(Number(seedBox.value));
  });
});

describe('per-layer offsets', () => {
  it('shows the computed plan until a row is overridden', () => {
    render(<ChoreographySection />);
    fireEvent.change(screen.getByTitle(/Frames between arrivals/), { target: { value: '4' } });
    fireEvent.change(screen.getByTitle(/How much each gap varies/), { target: { value: '0' } });
    expect(offsetInputs().map((i) => i.value)).toEqual(['0', '4', '8']);
  });

  it('an edited row wins, and the others keep the plan', () => {
    render(<ChoreographySection />);
    fireEvent.change(screen.getByTitle(/Frames between arrivals/), { target: { value: '4' } });
    fireEvent.change(screen.getByTitle(/How much each gap varies/), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('Offset for Layer B'), { target: { value: '25' } });

    expect(offsetInputs().map((i) => i.value)).toEqual(['0', '25', '8']);
    expect(screen.getByLabelText('Offset for Layer B')).toHaveAttribute('data-overridden', 'true');
    expect(screen.getByLabelText('Offset for Layer A')).toHaveAttribute('data-overridden', 'false');
  });

  it('the override reaches the keyframes', () => {
    render(<ChoreographySection />);
    fireEvent.change(screen.getByTitle(/Frames between arrivals/), { target: { value: '4' } });
    fireEvent.change(screen.getByTitle(/How much each gap varies/), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('Offset for Layer C'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Animate In' }));

    const [a, , c] = starts();
    expect(c! - a!).toBeCloseTo(30 / 30, 5);
  });

  it('clearing a box goes back to the plan instead of pinning it to zero', () => {
    // Typing over a value means clearing it first; if empty meant 0 the layer
    // would jump to the front of the queue mid-keystroke.
    render(<ChoreographySection />);
    fireEvent.change(screen.getByTitle(/Frames between arrivals/), { target: { value: '4' } });
    fireEvent.change(screen.getByTitle(/How much each gap varies/), { target: { value: '0' } });
    const boxC = screen.getByLabelText('Offset for Layer C');
    fireEvent.change(boxC, { target: { value: '30' } });
    fireEvent.change(boxC, { target: { value: '' } });
    expect((boxC as HTMLInputElement).value).toBe('8');
    expect(boxC).toHaveAttribute('data-overridden', 'false');
  });
});

describe('the last choreography', () => {
  const applyOnce = (): void => {
    render(<ChoreographySection />);
    fireEvent.change(screen.getByTitle(/Frames between arrivals/), { target: { value: '3' } });
    fireEvent.change(screen.getByTitle(/How much each gap varies/), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Animate In' }));
  };

  it('appears only after something has been applied', () => {
    render(<ChoreographySection />);
    expect(screen.queryByText('Last choreography')).not.toBeInTheDocument();
    cleanup();

    applyOnce();
    expect(screen.getByText('Last choreography')).toBeInTheDocument();
    expect(screen.getByText(/Animate in · 3 layers/)).toBeInTheDocument();
  });

  it('re-applies with the edited params, replacing rather than layering', () => {
    applyOnce();
    fireEvent.change(screen.getByTitle(/Frames between arrivals/), { target: { value: '9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Re-apply' }));

    const [a, b] = starts();
    expect(b! - a!).toBeCloseTo(9 / 30, 5);
    // Replaced, not layered: a compounded run would leave the 3-frame
    // keyframes behind and the earliest key would still be the old one.
    expect(useChoreographyStore.getState().byComp[activeCompId()]?.params.baseOffsetFrames).toBe(9);
  });

  it('Reset to plan drops every override and is dead until there is one', () => {
    applyOnce();
    const reset = screen.getByRole('button', { name: 'Reset to plan' });
    expect(reset).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Offset for Layer B'), { target: { value: '40' } });
    expect(reset).toBeEnabled();
    fireEvent.click(reset);

    expect(offsetInputs().map((i) => i.value)).toEqual(['0', '3', '6']);
  });

  it('Remove restores the composition and takes the block away', () => {
    applyOnce();
    expect(defaultAnimation.tracksFor(LAYERS[0]!).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    for (const id of LAYERS) expect(defaultAnimation.tracksFor(id)).toHaveLength(0);
    expect(screen.queryByText('Last choreography')).not.toBeInTheDocument();
  });

  it('keeps listing the recorded layers when the selection moves on', () => {
    // The case that matters: you click another layer to look at it, and the
    // numbers you are about to re-apply must not become that layer's.
    applyOnce();
    act(() => useSelectionStore.setState({ ids: [] } as never));
    fireEvent.click(screen.getByRole('button', { name: 'Reroll the seed' }));

    const list = screen.getByRole('list');
    expect(within(list).getAllByRole('spinbutton')).toHaveLength(3);
    expect(screen.getByLabelText('Offset for Layer A')).toBeInTheDocument();
  });

  it('adopts the params of a run started elsewhere', () => {
    // The palette and the Animation menu apply too; the panel has to show what
    // actually happened rather than whatever it last had in its own boxes.
    render(<ChoreographySection />);
    // `act` because the store write comes from outside React, which is exactly
    // the situation being tested: a run triggered from the palette.
    act(() => useChoreographyStore.getState().record(activeCompId(), {
      kind: 'out',
      params: {
        order: 'reverse', seed: 4242, baseOffsetFrames: 17, swingPct: 0,
        feel: 'bouncy', perLayerOverrides: {},
      },
      nodeIds: LAYERS,
      atCompTime: 0,
      fps: 30,
      captured: [],
      installs: {},
      range: null,
      offsetFrames: [0, 17, 34],
      archetypes: [],
      keyframes: 0,
      at: 99,
    }));

    expect((screen.getByTitle(/Frames between arrivals/) as HTMLInputElement).value).toBe('17');
    expect((screen.getByTitle(/Same seed/) as HTMLInputElement).value).toBe('4242');
    expect(screen.getByRole('button', { name: 'Bouncy' })).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('the Stagger button', () => {
  it('is disabled until two layers are actually animated', () => {
    render(<ChoreographySection />);
    expect(screen.getByRole('button', { name: 'Stagger' })).toBeDisabled();
    cleanup();

    for (const id of LAYERS) defaultAnimation.setKeyframe(id, 'opacity', 0, 100);
    render(<ChoreographySection />);
    expect(screen.getByRole('button', { name: 'Stagger' })).toBeEnabled();
  });

  it('shifts the keyframes the layers already have', () => {
    for (const id of LAYERS) {
      defaultAnimation.setKeyframe(id, 'opacity', 0, 0);
      defaultAnimation.setKeyframe(id, 'opacity', 0.5, 100);
    }
    render(<ChoreographySection />);
    fireEvent.change(screen.getByTitle(/Frames between arrivals/), { target: { value: '6' } });
    fireEvent.change(screen.getByTitle(/How much each gap varies/), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Stagger' }));

    const [a, b, c] = starts();
    expect(a).toBeCloseTo(0, 5);
    expect(b).toBeCloseTo(6 / 30, 5);
    expect(c).toBeCloseTo(12 / 30, 5);
  });
});
