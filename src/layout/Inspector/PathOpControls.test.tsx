/**
 * The Path Operator inspector, driven against a REAL shape node in the real
 * scene graph — not a mocked node. A mock here would be a second implementation
 * of `readPathOpConfig`, and the whole point is to check that what the operator
 * stores is what the panel reads back (§2·0).
 *
 * Wiggle Paths is the only temporal operator, so its two extra controls must
 * appear for `roughen` and must NOT appear for the others — a rate slider on
 * Twist would be a dead control, which is exactly the class of bug that ships
 * unnoticed.
 */

import { render, screen } from '@testing-library/react';
import { PathOpControls } from './PathOpControls';
import { insertShape } from '@core/scene/sceneInsert';
import { setPathOp, readPathOpConfig } from '@core/scene/pathOps';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useSelectionStore } from '@stores/selectionStore';

function newShape(): string {
  insertShape('rect', 'Wiggle Test');
  const id = useSelectionStore.getState().ids[0];
  if (!id) throw new Error('insertShape did not select the new layer');
  return id;
}

describe('PathOpControls — Wiggle Paths', () => {
  it('offers Wiggles/Second and Random Seed for Wiggle Paths', () => {
    const id = newShape();
    setPathOp(id, { type: 'roughen', amount: 8, detail: 4, wigglesPerSecond: 2, seed: 3 });

    render(<PathOpControls nodeId={id} />);

    expect(screen.getByRole('spinbutton', { name: 'Wiggles/Second' }).getAttribute('aria-valuenow')).toBe('2');
    expect(screen.getByRole('spinbutton', { name: 'Random Seed' }).getAttribute('aria-valuenow')).toBe('3');
    // The shared params are still there — the new rows are additive.
    expect(screen.getByRole('spinbutton', { name: 'Size' })).toBeTruthy();
    expect(screen.getByRole('spinbutton', { name: 'Detail' })).toBeTruthy();
  });

  it('hides both on operators that do not vary with time', () => {
    const id = newShape();
    setPathOp(id, { type: 'twist', amount: 30, detail: 0 });

    render(<PathOpControls nodeId={id} />);

    expect(screen.queryByRole('spinbutton', { name: 'Wiggles/Second' })).toBeNull();
    expect(screen.queryByRole('spinbutton', { name: 'Random Seed' })).toBeNull();
    expect(screen.getByRole('spinbutton', { name: 'Angle' })).toBeTruthy();
  });

  it('round-trips the new fields through the scene graph', () => {
    // The panel is only honest if what it writes survives a read back. This is
    // the read half of the loop the panel's controls drive.
    const id = newShape();
    setPathOp(id, { type: 'roughen', amount: 5, detail: 3, wigglesPerSecond: 4.5, seed: 12 });

    const back = readPathOpConfig(defaultSceneGraph.getNode(id)!);
    expect(back).toMatchObject({ type: 'roughen', wigglesPerSecond: 4.5, seed: 12 });
  });

  it('defaults a pre-temporal operator to a frozen wiggle', () => {
    // A project authored before Wiggle Paths had a rate must not start moving
    // when it loads. Written without the new fields, exactly as an old file is.
    const id = newShape();
    setPathOp(id, { type: 'roughen', amount: 5, detail: 3 } as never);

    expect(readPathOpConfig(defaultSceneGraph.getNode(id)!)?.wigglesPerSecond).toBe(0);
  });
});
