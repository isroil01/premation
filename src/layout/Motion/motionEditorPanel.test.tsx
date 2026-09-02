/**
 * Graph panel: ONE curve editor, and Bounce on its own workspace.
 *
 * Two things are pinned here.
 *
 *  1. **The panel hosts the shared `Timeline/GraphEditor`.** It used to carry a
 *     private curve editor that disagreed with the timeline's about what was
 *     selected, what "hold" was called, and what a keyframe action applied to.
 *     A test that only asserted "a graph is on screen" passed happily for both,
 *     which is how the two survived side by side — so these assertions name
 *     controls that exist ONLY in the shared editor (the Animated/Selected
 *     visibility modes, the reference-curve toggle), and assert the absence of
 *     the private one's markup.
 *
 *  2. **Curve and Bounce stay separate workspaces.** Mixing the bounce
 *     generator with the keyframe editor in one scroll is what made the panel
 *     read as a pile of graphs and buttons.
 */

import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MotionEditorPanel } from './MotionEditorPanel';
import { useSelectionStore } from '@stores/selectionStore';
import { defaultAnimation } from '@motion/animation';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';

const NODE = 'graph-layer';

// jsdom ships no ResizeObserver, and the shared editor measures its own
// viewport. Sizes stay 0 here — layout is not what this file is checking.
class NoopResizeObserver {
  observe(): void { /* no layout in jsdom */ }
  unobserve(): void { /* no layout in jsdom */ }
  disconnect(): void { /* no layout in jsdom */ }
}

beforeAll(() => {
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
  globalThis.ResizeObserver ??= NoopResizeObserver as unknown as typeof ResizeObserver;
});

beforeEach(() => {
  defaultAnimation.clear();
  useSelectionStore.getState().set([NODE]);
});

afterEach(() => {
  cleanup();
  useSelectionStore.getState().clear();
  defaultAnimation.clear();
});

const animate = (): void => {
  defaultAnimation.setKeyframe(NODE, 'y', 0, 0);
  defaultAnimation.setKeyframe(NODE, 'y', 1, 80);
};

describe('the panel hosts the shared graph editor', () => {
  it('renders the shared editor’s toolbar, not a private curve', () => {
    animate();
    render(<MotionEditorPanel />);
    // Only the shared editor has these: AE's two graph visibility modes and
    // the reference ("before") curve toggle.
    expect(screen.getByRole('group', { name: 'Graph visibility' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Animated' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Reference/ })).toBeTruthy();
    // …and none of the private editor's markup survives.
    expect(screen.queryByRole('radiogroup', { name: 'Graph mode' })).toBeNull();
    expect(screen.queryByRole('radiogroup', { name: 'Easing' })).toBeNull();
    expect(screen.queryByLabelText('keyframe value')).toBeNull();
    expect(screen.queryByLabelText('ease out influence')).toBeNull();
  });

  it('plots the selected layer’s tracks — the panel’s selection reaches it', () => {
    animate();
    render(<MotionEditorPanel />);
    // The legend chip is per plotted curve, so its presence says the layer's
    // keyframes actually arrived at the shared editor.
    expect(screen.getByRole('button', { name: 'y' })).toBeTruthy();
  });

  it('still offers the expression editor, on a property you pick', () => {
    animate();
    render(<MotionEditorPanel />);
    const props = screen.getByRole('radiogroup', { name: 'Animated property' });
    expect(props).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'y' })).toHaveAttribute('aria-checked', 'true');
    // The expression editor is headed with the property it drives.
    expect(screen.getByText(/Expression · y/)).toBeTruthy();
  });

  it('says there are no keyframes rather than offering an expression target', () => {
    render(<MotionEditorPanel />);
    expect(screen.queryByRole('radiogroup', { name: 'Animated property' })).toBeNull();
    expect(screen.getByText('No keyframes')).toBeTruthy();
    // The graph is still mounted: it explains the empty state in its own words.
    expect(screen.getByRole('group', { name: 'Graph visibility' })).toBeTruthy();
  });
});

describe('Graph panel workspaces', () => {
  it('shows Curve and Bounce tabs, and opens on Curve', () => {
    render(<MotionEditorPanel />);
    expect(screen.getByRole('tab', { name: 'Keyframe curve' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Bounce generator' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tabpanel', { name: 'Keyframe curve' })).toBeTruthy();
    expect(screen.queryByRole('img', { name: 'Bounce curve preview' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Drop In & Bounce' })).toBeNull();
  });

  it('keeps the bounce preview off the Curve workspace even with keyframes', () => {
    animate();
    render(<MotionEditorPanel />);
    expect(screen.getByRole('group', { name: 'Graph visibility' })).toBeTruthy();
    expect(screen.queryByRole('img', { name: 'Bounce curve preview' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Drop In & Bounce' })).toBeNull();
  });

  it('switching to Bounce shows the generator and hides the keyframe graph', () => {
    animate();
    render(<MotionEditorPanel />);
    fireEvent.click(screen.getByRole('tab', { name: 'Bounce generator' }));
    expect(screen.getByRole('tab', { name: 'Bounce generator' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel', { name: 'Bounce' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Bounce curve preview' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add to Existing' })).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Graph visibility' })).toBeNull();
  });
});
