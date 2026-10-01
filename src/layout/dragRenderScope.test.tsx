/**
 * The drag render scope: **a viewport drag step re-renders what shows the
 * moved value, not the editor.**
 *
 * The owner measured "the whole UI re-renders on every mouse move (about 7 ms
 * each)": every pointer move sends one gesture message (`setProperty` on the
 * dragged layer's position), the engine answers with a revisioned event batch,
 * and the document mirror wakes its subscribers. Subscribers on coarse keys
 * re-rendered on EVERY batch — the editor shell's `useMirrorRevision` (which
 * re-rendered the whole unmemoized tree under it), the Layers panel, every
 * Inspector section that took the layer's whole property tree, the timeline's
 * shape rows …
 *
 * This mounts the real `EditorShell` in the real providers over a document
 * with a few layers, drives real gesture steps through `GestureSession`, and
 * counts — with the DevTools-hook render tracker, so real React work, per
 * component — how many components re-rendered per step.
 *
 * Measured on the change that added this file (20 steps, jsdom, dev build):
 *
 *                              before      after
 *   commits per step             3.15       1.40
 *   component renders per step    598      12-20
 *   React render ms per step     68.9     1.2-1.6
 *
 * (The after-numbers vary with how many painted-frame ticks of the viewport shell land between two steps.)
 *
 * `RENDER_SCOPE_VERBOSE=1` prints the per-component tables.
 */
import { renderTracker } from '@layout/__testHelpers__/renderTracker';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Command } from '@motion/engine-api';
import { EditorShell } from '../App';
import { Providers } from '@providers/Providers';
import { TooltipProvider } from '@components/Tooltip/Tooltip';
import { seedDefaultScene } from '@core/scene/seedDefaultScene';
import { insertPrimitive } from '@core/scene/sceneInsert';
import { GestureSession } from '@core/engine/uiEdits';
import { engine, engineIdle } from '@core/engine/engineInstance';
import { documentMirror } from '@stores/documentMirror';
import { useSelectionStore } from '@stores/selectionStore';

const STEPS = 20;
/** The editor's regions, outermost first, for the verbose per-region report. */
const REGIONS = [
  'EditorShellInner', 'EditorLayout', 'TopNav', 'LeftSidebar', 'ScenePanel', 'PropertiesPanel', 'RightInspector',
  'WorkspaceViewport', 'BottomTimeline', 'EditorStatusBar', 'CommandPalette', 'PresentationMode',
];
/** Components that draw nothing of the moved value: a drag step must not run their render at all. */
const MUST_STAY_QUIET = [
  'EditorShellInner', 'EditorLayout', 'TopNav', 'LeftSidebar', 'RightInspector', 'PropertiesPanel', 'ScenePanel', 'TreeView',
  'BottomTimeline', 'Timeline', 'TrackHeader', 'EditorStatusBar', 'CommandPalette', 'PresentationMode', 'AppearanceSectionInner',
  'MotionToolsSection', 'ModifierStackSection', 'AudioDriverSection', 'LayerStylesControls', 'EffectControlsBody', 'StrokeRows',
  'SceneRowSwitches', 'CompositionList',
];

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false, media: query, onchange: null,
      addListener: () => {}, removeListener: () => {},
      addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    }),
  });
  if (!('ResizeObserver' in window)) {
    (window as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
  }
});

afterEach(cleanup);

/** Mount the editor over three layers; the last one is selected. */
async function bootWithSelection(): Promise<{ moved: string }> {
  seedDefaultScene();
  insertPrimitive('shape', 'Drag Shape');
  insertPrimitive('shape', 'Other Shape');
  insertPrimitive('text', 'Drag Text');
  const view = render(
    <MemoryRouter>
      <TooltipProvider>
        <Providers>
          <EditorShell />
        </Providers>
      </TooltipProvider>
    </MemoryRouter>,
  );
  await waitFor(
    () => {
      if ((view.container.textContent ?? '').includes('Loading editor')) throw new Error('still booting');
    },
    { timeout: 20000 },
  );
  await act(async () => { await engineIdle(); });
  const layers = [...documentMirror().layerIds()];
  expect(layers.length).toBeGreaterThanOrEqual(3);
  const moved = layers[layers.length - 1]!;
  await act(async () => { useSelectionStore.getState().set([moved]); await engineIdle(); });
  return { moved };
}

function report(perStep: number, commitsPerStep: number): string {
  const head = `[drag render scope] ${STEPS} steps: ${commitsPerStep.toFixed(2)} commits/step, ${perStep.toFixed(1)} component renders/step, `
    + `${(renderTracker.renderMs / STEPS).toFixed(2)} ms React render/step (jsdom, dev build)`;
  if (!process.env.RENDER_SCOPE_VERBOSE) return head;
  const byCount = renderTracker.top(200).map(([n, c]) => `  ${(c / STEPS).toFixed(2).padStart(6)}/step  ${n}`).join('\n');
  const byRegion = REGIONS.map((n) => `  ${(renderTracker.inclusiveTime(n) / STEPS).toFixed(2).padStart(7)} ms  ${(renderTracker.count(n) / STEPS).toFixed(2)}x  ${n}`).join('\n');
  const byTime = renderTracker.topByTime(30).map(([n, ms]) => `  ${(ms / STEPS).toFixed(3).padStart(7)} ms/step  ${n}`).join('\n');
  return `${head}\nby renders:\n${byCount}\nby region (inclusive):\n${byRegion}\nby self time:\n${byTime}`;
}

describe('a viewport drag step', () => {
  it('re-renders only what shows the moved value', async () => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { moved } = await bootWithSelection();

    const g = new GestureSession('Move');
    const step = async (i: number): Promise<void> => {
      await act(async () => {
        g.send({ type: 'setProperty', prop: { layer: moved, path: 'transform/position' }, value: { kind: 'vec2', value: { x: 200 + i, y: 80 } }, time: 0 } as Command);
        await engineIdle();
      });
    };
    // Warm: the gesture opens, the first move makes the layer "modified" (Inspector rows, overlays).
    await step(0);
    await step(1);

    renderTracker.reset();
    for (let i = 2; i < 2 + STEPS; i++) await step(i);
    const perStep = renderTracker.total() / STEPS;
    const commitsPerStep = renderTracker.commits / STEPS;
    console.log(report(perStep, commitsPerStep));
    const snapshot = renderTracker.snapshot();
    await act(async () => { await g.end(); await engineIdle(); });
    errors.mockRestore();

    // The Position row shows the dragged value: it DID render (the harness sees updates).
    expect(snapshot.MultiPropertyPairRowInner ?? 0).toBeGreaterThan(0);
    // Nothing that has nothing to show for it.
    const noisy = MUST_STAY_QUIET.filter((n) => (snapshot[n] ?? 0) > 0).map((n) => `${n} x${snapshot[n]}`);
    expect(noisy).toEqual([]);
    // The budget: it was ~600 component renders and ~3.2 commits per step.
    expect(perStep).toBeLessThan(60);
    expect(commitsPerStep).toBeLessThan(2.5);
  }, 120_000);

  it('a STRUCTURAL edit still reaches the layer tree, the timeline rows and the Inspector header', async () => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { moved } = await bootWithSelection();
    renderTracker.reset();
    await act(async () => {
      await engine().execute({ type: 'renameLayer', layer: moved, name: 'Renamed By Test' } as Command);
      await engineIdle();
    });
    const snapshot = renderTracker.snapshot();
    errors.mockRestore();
    // The narrowed keys must not have cut these off: a rename is a header write.
    expect(snapshot.ScenePanel ?? 0).toBeGreaterThan(0);
    expect(snapshot.TrackHeader ?? 0).toBeGreaterThan(0);
    expect(snapshot.PropertiesPanel ?? 0).toBeGreaterThan(0);
    expect(document.body.textContent).toContain('Renamed By Test');
  }, 120_000);
});
