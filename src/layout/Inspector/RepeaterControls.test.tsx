/**
 * The Repeater inspector against a real scene node.
 *
 * Offset, Anchor Point and Composite are the three AE parameters this repeater
 * was missing. A parameter that exists in the model but has no control is the
 * failure this project has shipped before, so each one is asserted to be
 * on screen and to write through to the config.
 */

import { render, screen } from '@testing-library/react';
import { RepeaterControls } from './RepeaterControls';
import { insertShape } from '@core/scene/sceneInsert';
import { setRepeater, readRepeaterConfig, defaultRepeater } from '@core/scene/repeater';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useSelectionStore } from '@stores/selectionStore';

function newShape(): string {
  insertShape('rect', 'Repeater Test');
  const id = useSelectionStore.getState().ids[0];
  if (!id) throw new Error('insertShape did not select the new layer');
  return id;
}

describe('RepeaterControls', () => {
  it('exposes Offset, Anchor X/Y and Composite', () => {
    const id = newShape();
    setRepeater(id, { ...defaultRepeater(), offset: 1.5, anchorX: 40, anchorY: -12, composite: 'below' });

    render(<RepeaterControls nodeId={id} />);

    expect(screen.getByRole('spinbutton', { name: 'Offset' }).getAttribute('aria-valuenow')).toBe('1.5');
    expect(screen.getByRole('spinbutton', { name: 'Anchor X' }).getAttribute('aria-valuenow')).toBe('40');
    expect(screen.getByRole('spinbutton', { name: 'Anchor Y' }).getAttribute('aria-valuenow')).toBe('-12');
    // Composite is a discrete pick, so it shows its current value as a label.
    expect(screen.getByText('Below')).toBeTruthy();
  });

  it('shows Above for a repeater that never chose a composite', () => {
    // The historical behaviour, and what every existing project must still read
    // as — AE's own default is Below, which we deliberately do not impose.
    const id = newShape();
    setRepeater(id, { copies: 4, offsetX: 50, offsetY: 0, offsetRotation: 0, offsetScale: 1, offsetOpacity: 1 });

    render(<RepeaterControls nodeId={id} />);

    expect(screen.getByText('Above')).toBeTruthy();
    expect(readRepeaterConfig(defaultSceneGraph.getNode(id)!)?.composite).toBe('above');
  });

  it('round-trips the new fields through the scene graph', () => {
    const id = newShape();
    setRepeater(id, { ...defaultRepeater(), offset: -2, anchorX: 7, anchorY: 9, composite: 'below' });

    expect(readRepeaterConfig(defaultSceneGraph.getNode(id)!)).toMatchObject({
      offset: -2, anchorX: 7, anchorY: 9, composite: 'below',
    });
  });

  it('keeps the original six controls', () => {
    const id = newShape();
    setRepeater(id, defaultRepeater());

    render(<RepeaterControls nodeId={id} />);

    for (const name of ['Copies', 'Position X', 'Position Y', 'Rotation', 'Scale', 'Opacity']) {
      expect(screen.getByRole('spinbutton', { name })).toBeTruthy();
    }
  });
});
