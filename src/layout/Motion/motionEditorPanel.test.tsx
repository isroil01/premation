/**
 * Graph panel: Curve and Bounce are separate workspaces.
 *
 * Mixing the bounce generator with the keyframe editor in one scroll is what
 * made the panel read as a pile of graphs and buttons. These assertions pin
 * the split so the two tools cannot silently share a column again.
 */

import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MotionEditorPanel } from './MotionEditorPanel';
import { useSelectionStore } from '@stores/selectionStore';
import { defaultAnimation } from '@motion/animation';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';

const NODE = 'graph-layer';

beforeAll(() => {
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
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
    defaultAnimation.setKeyframe(NODE, 'y', 0, 0);
    defaultAnimation.setKeyframe(NODE, 'y', 1, 80);
    render(<MotionEditorPanel />);
    expect(screen.getByRole('radiogroup', { name: 'Graph mode' })).toBeTruthy();
    expect(screen.queryByRole('img', { name: 'Bounce curve preview' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Drop In & Bounce' })).toBeNull();
  });

  it('switching to Bounce shows the generator and hides the keyframe graph', () => {
    defaultAnimation.setKeyframe(NODE, 'y', 0, 0);
    defaultAnimation.setKeyframe(NODE, 'y', 1, 80);
    render(<MotionEditorPanel />);
    fireEvent.click(screen.getByRole('tab', { name: 'Bounce generator' }));
    expect(screen.getByRole('tab', { name: 'Bounce generator' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel', { name: 'Bounce' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Bounce curve preview' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Drop In & Bounce' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add to Existing' })).toBeTruthy();
    expect(screen.queryByRole('radiogroup', { name: 'Graph mode' })).toBeNull();
    expect(screen.queryByRole('radiogroup', { name: 'Easing' })).toBeNull();
  });
});
