/**
 * The Path Operator inspector, driven against a REAL shape layer in the C++
 * engine — not a mocked node. A mock here would be a second implementation of
 * the operator's read-back, and the whole point is to check that what the
 * operator stores is what the panel reads back (§2·0).
 *
 * Wiggle Paths is the only temporal operator, so its two extra controls must
 * appear for `roughen` and must NOT appear for the others — a rate slider on
 * Twist would be a dead control, which is exactly the class of bug that ships
 * unnoticed.
 */

import { render, screen, waitFor, cleanup } from '@testing-library/react';
import type { Command } from '@motion/engine-api';
import { PathOpControls } from './PathOpControls';
import { mirrorPathOps } from '@core/mirror/layerFacts';
import { documentMirror } from '@stores/documentMirror';
import { setupAppEngine, settleEdits, type Harness } from '@core/engine/__testHelpers__/appEngine';

let h: Harness;
beforeEach(async () => { h = await setupAppEngine(); });
afterEach(async () => { cleanup(); await h.dispose(); });

/** A shape layer with one path operator of `type`, its parameters as given. */
async function shapeWithOp(type: string, params: Record<string, number>): Promise<string> {
  const layer = (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'rectangle', name: 'Wiggle Test', init: [] } as Command) as { layer: string }).layer;
  await h.run({
    type: 'addPropertyGroup', layer, parent: 'contents', matchName: `pathop:${type}`,
    init: Object.entries(params).map(([path, value]) => ({ path, value: { kind: 'scalar', value } })),
  } as Command);
  await settleEdits();
  await documentMirror().loadTree(layer);
  return layer;
}

const opOf = (layer: string) => mirrorPathOps(documentMirror().tree(layer))[0];

describe('PathOpControls — Wiggle Paths', () => {
  it('offers Wiggles/Second and Random Seed for Wiggle Paths', async () => {
    const id = await shapeWithOp('roughen', { amount: 8, detail: 4, wigglesPerSecond: 2, seed: 3 });

    render(<PathOpControls nodeId={id} />);

    await waitFor(() => expect(screen.getByRole('spinbutton', { name: 'Wiggles/Second' }).getAttribute('aria-valuenow')).toBe('2'));
    expect(screen.getByRole('spinbutton', { name: 'Random Seed' }).getAttribute('aria-valuenow')).toBe('3');
    // The shared params are still there — the new rows are additive.
    expect(screen.getByRole('spinbutton', { name: 'Size' })).toBeTruthy();
    expect(screen.getByRole('spinbutton', { name: 'Detail' })).toBeTruthy();
  });

  it('hides both on operators that do not vary with time', async () => {
    const id = await shapeWithOp('twist', { amount: 30 });

    render(<PathOpControls nodeId={id} />);

    await waitFor(() => expect(screen.getByRole('spinbutton', { name: 'Angle' })).toBeTruthy());
    expect(screen.queryByRole('spinbutton', { name: 'Wiggles/Second' })).toBeNull();
    expect(screen.queryByRole('spinbutton', { name: 'Random Seed' })).toBeNull();
  });

  it('round-trips the new fields through the document', async () => {
    // The panel is only honest if what it writes survives a read back. This is
    // the read half of the loop the panel's controls drive.
    const id = await shapeWithOp('roughen', { amount: 5, detail: 3, wigglesPerSecond: 4.5, seed: 12 });
    expect(opOf(id)).toMatchObject({ type: 'roughen', wigglesPerSecond: 4.5, seed: 12 });
  });

  it('defaults a new Wiggle Paths to a frozen wiggle', async () => {
    // An operator added without a rate must not start moving.
    const id = await shapeWithOp('roughen', { amount: 5, detail: 3 });
    expect(opOf(id)?.wigglesPerSecond).toBe(0);
  });
});
