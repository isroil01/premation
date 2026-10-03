/**
 * Deleting a layer must not leave its selection chrome on screen.
 *
 * The chrome is painted from `ws.overlay()` on a render tick; the tick is
 * requested by scene / selection changes. A delete goes: page replica removes
 * the layer, the engine's answer prunes the selection. Each step must end with
 * a painted overlay that no longer describes the gone layer.
 */

import { useSelectionStore } from '@stores/selectionStore';
import { engineIdle as engineQueueIdle } from '@core/engine/engineInstance';
import { setupAppEngine } from '@core/engine/__testHelpers__/appEngine';
import { buildScene, type Scene } from '@core/engine/__testHelpers__/scene';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { settleToolEdits } from './viewportGesture';
import { getWorkspaceController } from './WorkspaceController';
import { holdCanvasGeometry, releaseCanvasGeometry } from './__testHelpers__/canvasGeometry';

async function engineIdle(): Promise<void> {
  await settleToolEdits();
  await engineQueueIdle();
  await settleToolEdits();
  await engineQueueIdle();
}

let h: Harness & { engine: LocalEngine };
let s: Scene;
let frames: Array<() => void>;

/** Run every queued animation frame (a tick may queue another). */
function runFrames(): void {
  for (let i = 0; i < 4 && frames.length > 0; i++) {
    const due = frames;
    frames = [];
    for (const cb of due) cb();
  }
}

beforeEach(async () => {
  frames = [];
  jest.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
    frames.push(() => cb(0));
    return frames.length;
  });
  jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
  h = await setupAppEngine();
  s = await buildScene(h);
  useSelectionStore.setState({ ids: [], primary: null });
});

afterEach(async () => {
  jest.restoreAllMocks();
  releaseCanvasGeometry();
  await engineIdle();
  await h.dispose();
});

/** The selection boxes the LAST painted tick saw, by layer id. */
function paintedBoxIds(): string[] {
  const c = getWorkspaceController();
  let seen: string[] = [];
  const off = c.onRender(() => { seen = c.ws.overlay().selectionBoxes.map((b) => b.id); });
  try {
    c.requestRender();
    runFrames();
  } finally {
    off();
  }
  return seen;
}

describe('deleting selected layers', () => {
  it('the deleted layer leaves the drawn selection, and a repaint is requested', async () => {
    const c = getWorkspaceController();
    // A subscriber that records what the overlay held at each tick.
    const ticks: string[][] = [];
    const off = c.onRender(() => { ticks.push(c.ws.overlay().selectionBoxes.map((b) => b.id)); });
    useSelectionStore.getState().set([s.A]);
    await holdCanvasGeometry();
    runFrames();
    expect(ticks.at(-1)).toEqual([s.A]);

    c.deleteSelection();
    await engineIdle();
    runFrames();
    off();

    expect(useSelectionStore.getState().ids).toEqual([]);
    expect(c.ws.overlay().selectionBoxes).toEqual([]);
    // The LAST tick is what is on screen: it must not still hold the gone layer.
    expect(ticks.at(-1)).toEqual([]);
  });

  it('deleting one of several selected layers keeps the others drawn', async () => {
    const c = getWorkspaceController();
    useSelectionStore.getState().set([s.A, s.P]);
    expect(paintedBoxIds().sort()).toEqual([s.A, s.P].sort());
    // Only A is deleted (a command on that layer alone).
    await h.run({ type: 'deleteLayers', layers: [s.A] });
    await engineIdle();
    expect(paintedBoxIds()).toEqual([s.P]);
    expect(c.ws.overlay().selectionBoxes.map((b) => b.id)).toEqual([s.P]);
  });

  it('a layer deleted behind the selection (no selection event) still repaints without its box', async () => {
    const c = getWorkspaceController();
    const ticks: string[][] = [];
    const off = c.onRender(() => { ticks.push(c.ws.overlay().selectionBoxes.map((b) => b.id)); });
    useSelectionStore.getState().set([s.A, s.P]);
    runFrames();
    ticks.length = 0;
    await h.run({ type: 'deleteLayers', layers: [s.A] });
    await engineIdle();
    runFrames();
    off();
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks.at(-1)).not.toContain(s.A);
  });

  it('undo of the delete brings the layer back without a stale box for it', async () => {
    const c = getWorkspaceController();
    useSelectionStore.getState().set([s.A]);
    c.deleteSelection();
    await engineIdle();
    await h.run({ type: 'undo' });
    await engineIdle();
    runFrames();
    // The layer is back; the selection was cleared by the delete, so no chrome.
    expect(c.ws.overlay().selectionBoxes.map((b) => b.id)).toEqual(useSelectionStore.getState().ids);
  });
});
