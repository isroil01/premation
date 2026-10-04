/**
 * Reported bug: "I add a keyframe at 1s with x:-400, then at 5s set x:0 — they
 * overwrite each other, both end up the same."
 *
 * Root cause: the inspector WROTE keyframes at the layer's time
 * (`toLayerTime`) but READ them back at the raw composition time. On a layer
 * whose clip does not start at 0 those are different axes, so the field showed
 * a point part-way along the curve instead of the keyframe you set — and the
 * next edit "corrected" it, which looks exactly like the later keyframe
 * reaching back and overwriting the earlier one.
 *
 * The invariant these tests hold: **the value the inspector shows at a given
 * playhead time is the value that is stored for that time.**
 */

import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import type { Command } from '@motion/engine-api';
import { TransformSection } from './TransformSection';
import { useProjectStore } from '@stores/projectStore';
import { documentMirror } from '@stores/documentMirror';
import { sampleTrack, sec, settleEdits, setupAppEngine, type Harness } from '@core/engine/__testHelpers__/appEngine';

let h: Harness;
let NODE = '';

/** A shape layer at x = `x`. */
async function addLayer(x: number): Promise<void> {
  NODE = (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'rectangle', name: 'kf-node', init: [] } as Command) as { layer: string }).layer;
  await h.run({ type: 'setProperty', prop: { layer: NODE, path: 'transform/position' }, value: { kind: 'vec2', value: { x, y: 0 } } } as Command);
  await settleEdits();
  await documentMirror().loadTree(NODE);
}

/** The layer's bar dragged to start at `seconds` (its keyframes move with it: layer time). */
async function offsetClip(seconds: number): Promise<void> {
  await h.run({ type: 'moveLayersInTime', layers: [NODE], delta: sec(seconds), ripple: false } as Command);
  await settleEdits();
}

const setTime = (t: number): void => {
  act(() => {
    useProjectStore.getState().actions.setTime(t, Math.round(t * 30));
  });
};

const xField = (): HTMLElement => screen.getByRole('spinbutton', { name: 'Position X' });
const shownX = (): number => Number(xField().getAttribute('aria-valuenow'));

/**
 * The Position row's stopwatch — what makes X (and Y) animated.
 *
 * Found by ACCESSIBLE NAME, not by tag or DOM structure. It used to walk two
 * parents up and grab an `input[type=checkbox]`, which broke the moment the
 * row became a shared component with a real stopwatch button — and would have
 * broken again on any layout change. The name is the contract; the markup is not.
 *
 * Since 2026-09-15 X and Y share ONE row (`MultiPropertyPairRow`) and the
 * row's stopwatch is the group's, so the name is "Position", not "Position X".
 * Everything below still asserts on X alone.
 */
async function lightXStopwatch(): Promise<void> {
  const sw = screen.getByRole('button', { name: /(Enable|Disable) Position animation/ });
  fireEvent.click(sw);
  await idle();
}

/** Inspector writes are engine commands (B3): asynchronous. */
async function idle(): Promise<void> {
  await act(async () => { await settleEdits(); });
}

/** Type an exact value into a resting ValueField (Enter opens the input). */
async function typeValue(field: HTMLElement, value: string): Promise<void> {
  fireEvent.keyDown(field, { key: 'Enter' });
  const input = field.querySelector('input');
  if (!input) throw new Error('ValueField did not open an input on Enter');
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await idle();
}

describe('keyframing position from the inspector', () => {
  beforeEach(async () => {
    h = await setupAppEngine();
    await addLayer(-400);
    setTime(0);
  });

  afterEach(async () => {
    cleanup();
    await h.dispose();
  });

  it('a value set at 5s does not disturb the keyframe at 1s', async () => {
    await h.run({ type: 'addKeyframes', keys: [
      { prop: { layer: NODE, path: 'transform/position' }, time: sec(1), value: { kind: 'vec2', value: { x: -400, y: 0 } }, spatialIn: [], spatialOut: [] },
    ] } as Command);
    await settleEdits();

    setTime(5);
    render(<TransformSection nodeId={NODE} />);
    await typeValue(xField(), '0');

    expect(await sampleTrack(NODE, 'x', 5)).toBeCloseTo(0);
    expect(await sampleTrack(NODE, 'x', 1)).toBeCloseTo(-400);
  });

  it('shows the value you set at each time, on a layer whose clip starts at 1s', async () => {
    // THE REPRODUCTION. Before the fix the field read -300 here: the write went
    // to layer time 0/4 while the read sampled raw comp time 1, landing a
    // quarter of the way along the curve.
    await offsetClip(1); // bar dragged to start at 1s — an everyday AE move
    const { rerender } = render(<TransformSection nodeId={NODE} />);

    setTime(1);
    rerender(<TransformSection nodeId={NODE} />);
    await lightXStopwatch();          // stopwatch on -> keyframe at 1s
    await typeValue(xField(), '-400');

    setTime(5);
    rerender(<TransformSection nodeId={NODE} />);
    await typeValue(xField(), '0');
    expect(shownX()).toBeCloseTo(0);

    // Go back: the first keyframe must still read exactly what was set.
    setTime(1);
    rerender(<TransformSection nodeId={NODE} />);
    await idle();
    expect(shownX()).toBeCloseTo(-400);
  });

  it('agrees with the engine about the value at a given comp time', async () => {
    // The inspector and the renderer must sample the same axis, or the number
    // in the panel disagrees with the pixels on the canvas.
    await offsetClip(1);
    const { rerender } = render(<TransformSection nodeId={NODE} />);

    setTime(1);
    rerender(<TransformSection nodeId={NODE} />);
    await lightXStopwatch();
    await typeValue(xField(), '-400');
    setTime(5);
    rerender(<TransformSection nodeId={NODE} />);
    await typeValue(xField(), '0');

    for (const t of [1, 3, 5]) {
      setTime(t);
      rerender(<TransformSection nodeId={NODE} />);
      await idle();
      expect(shownX()).toBeCloseTo((await sampleTrack(NODE, 'x', t))!);
    }
  });
});
