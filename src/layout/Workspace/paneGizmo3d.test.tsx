/**
 * The 3D transform gizmo in a SECONDARY view pane.
 *
 * The gizmo used to read the main viewport's globals directly — the view mode
 * off `guidesStore.camera3dMode`, the comp → canvas transform off the workspace
 * controller — which made a second one structurally impossible: a 2-up / 4-up
 * pane draws the same scene through its own camera and its own framing, so a
 * gizmo built from the main viewport's numbers lands somewhere the pane's pixels
 * are not, and hit-tests the pointer against a projection nothing on screen
 * uses. Both are parameters now (`Gizmo3dViewOptions`).
 *
 * Two ends are asserted here, because this is exactly the shape of viewport
 * chrome failure this repo keeps hitting — geometry that draws in the wrong
 * place, or a handle that draws and writes nothing:
 *
 *  • the PROJECTION — a pane on `top` places its handles through the top
 *    orthographic projection and the pane's own transform, while a sibling
 *    reading the main viewport (on `front`, at a different zoom) places the
 *    same layer's handles somewhere else entirely;
 *  • the WRITE — a drag in the pane goes through the engine API by the same
 *    rule the main viewport uses, and moves the layer along the handle's own
 *    world axis — ONE undo entry per drag.
 */

import { useRef } from 'react';
import { render, act, fireEvent } from '@testing-library/react';
import { Project3D } from '@motion/scene';
import { useGizmo3d } from './useGizmo3d';
import { Gizmo3dOverlay } from './Gizmo3dOverlay';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useSelectionStore } from '@stores/selectionStore';
import { useGuidesStore, type Camera3dMode } from '@stores/guidesStore';
import { useCompositionStore } from '@stores/compositionStore';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import type { RenderView } from '@core/rendering/RenderBackend';
import { engineIdle } from '@core/engine/engineInstance';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';

/**
 * The MAIN viewport's transform, distinct from every pane view below — so a
 * position taken from the controller instead of the pane is unmistakable.
 */
const MAIN_VIEW: RenderView = { scale: 2, offsetX: 400, offsetY: 250 };

jest.mock('@core/workspace/WorkspaceController', () => ({
  getWorkspaceController: () => ({
    getView: () => ({ scale: 2, offsetX: 400, offsetY: 250 }),
    onRender: () => () => undefined,
    requestRender: () => undefined,
  }),
}));

/** A 3D layer well off the comp centre, so every axis projects distinctly. */
const START = { x: 200, y: 300, z: 400 };

/**
 * One pane's worth of gizmo: the hook bound to a view, and the overlay drawing
 * what it produced. `view` omitted means "behave like the main viewport" — the
 * pre-existing path, kept honest by the same test.
 */
function GizmoHarness({ mode, view }: { mode?: Camera3dMode; view?: RenderView }): JSX.Element {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const props = useGizmo3d(stageRef, view ? { mode, getView: () => view } : undefined);
  return (
    <div ref={stageRef} data-testid="stage" style={{ position: 'relative' }}>
      <Gizmo3dOverlay
        {...props}
        nodeId={props.singleId ?? null}
        showGizmo={props.is3D && !!props.singleId}
      />
    </div>
  );
}

/** The gizmo's centre dot, in the overlay's own (comp-space) coordinates. */
function centreDot(container: HTMLElement): { x: number; y: number } {
  const c = container.querySelector('g.gizmo-3d > circle');
  if (!c) throw new Error('no gizmo centre drawn');
  return { x: Number(c.getAttribute('cx')), y: Number(c.getAttribute('cy')) };
}

/** The zoom-scaled group's transform — the view the handles are placed with. */
function groupTransform(container: HTMLElement): string {
  return container.querySelector('g.gizmo-3d')?.getAttribute('transform') ?? '';
}

/** The +X position arm's tip, in comp space (its arrow marker identifies it). */
function xArmTip(container: HTMLElement): { x: number; y: number } {
  const line = container.querySelector('g.gizmo-3d line[marker-end="url(#arrow-x)"]');
  if (!line) throw new Error('no X position arm drawn');
  return { x: Number(line.getAttribute('x2')), y: Number(line.getAttribute('y2')) };
}

function reset(): void {
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
  useSelectionStore.getState().set([]);
  // The MAIN viewport looks front-on. Every pane below asks for something else,
  // so a value taken from the global is visible as such.
  useGuidesStore.getState().setCamera3dMode('front');
  useGuidesStore.getState().setGizmo3dAxisMode('world');
  useGuidesStore.getState().setGizmo3dState('universal');
  useGuidesStore.getState().setCameraTool('none');
}

beforeEach(reset);
afterEach(reset);

describe('a pane places its handles through ITS OWN view', () => {
  // A 3D layer of the composition, built through the engine: the gizmo's
  // 3D gate reads the layer header from the document mirror (B4).
  let h: Awaited<ReturnType<typeof setupAppEngine>>;
  let layerId: string;

  beforeEach(async () => {
    h = await setupAppEngine();
    layerId = (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'rectangle', name: 'Box', init: [] })).layer;
    await h.run({ type: 'setLayerSwitches', layers: [layerId], patch: { threeD: true } });
    await h.run({ type: 'setProperty', prop: { layer: layerId, path: 'transform/position' }, value: { kind: 'vec3', value: START } });
    await engineIdle();
  });

  afterEach(async () => {
    await h.dispose();
  });

  it('projects through the pane’s ortho axis and framing, not the main viewport’s', () => {
    act(() => useSelectionStore.getState().set([layerId]));

    const paneView: RenderView = { scale: 0.5, offsetX: 12, offsetY: 34 };
    const pane = render(<GizmoHarness mode="top" view={paneView} />);
    act(() => undefined);

    const { width, height } = useCompositionStore.getState();
    const expected = Project3D.projectOrtho(START, 'top', width, height);
    const at = centreDot(pane.container);
    expect(at.x).toBeCloseTo(expected.x, 6);
    expect(at.y).toBeCloseTo(expected.y, 6);
    // The comp-space points above are placed on the pane's pixels by the
    // group's transform — which must be the PANE's, not the controller's.
    expect(groupTransform(pane.container)).toBe(
      `translate(${paneView.offsetX}, ${paneView.offsetY}) scale(${paneView.scale})`,
    );

    // Same layer, same moment, a viewport reading the globals: a different
    // projection (front) placed by a different transform.
    const main = render(<GizmoHarness />);
    act(() => undefined);
    const mainExpected = Project3D.projectOrtho(START, 'front', width, height);
    const mainAt = centreDot(main.container);
    expect(mainAt.x).toBeCloseTo(mainExpected.x, 6);
    expect(mainAt.y).toBeCloseTo(mainExpected.y, 6);
    expect(groupTransform(main.container)).toBe(
      `translate(${MAIN_VIEW.offsetX}, ${MAIN_VIEW.offsetY}) scale(${MAIN_VIEW.scale})`,
    );
    // The two disagree — which is the whole point of a second view.
    expect(mainAt).not.toEqual(at);
  });

  it('two panes on different axes disagree with each other', () => {
    act(() => useSelectionStore.getState().set([layerId]));
    const view: RenderView = { scale: 1, offsetX: 0, offsetY: 0 };

    const top = render(<GizmoHarness mode="top" view={view} />);
    const right = render(<GizmoHarness mode="right" view={view} />);
    act(() => undefined);
    expect(centreDot(top.container)).not.toEqual(centreDot(right.container));
  });
});

/**
 * B3: on a composition's LAYER (the editor's case) the drag goes through the
 * engine API — every move an absolute Position, the whole drag ONE undo entry.
 */
describe('through the engine API', () => {
  let h: Awaited<ReturnType<typeof setupAppEngine>>;
  let id: string;

  beforeEach(async () => {
    h = await setupAppEngine();
    id = (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'rectangle', name: 'Box', init: [] })).layer;
    await h.run({ type: 'setLayerSwitches', layers: [id], patch: { threeD: true } });
    await h.run({ type: 'setProperty', prop: { layer: id, path: 'transform/position' }, value: { kind: 'vec3', value: START } });
    useGuidesStore.getState().setGizmo3dState('position');
  });

  afterEach(async () => {
    await h.dispose();
  });

  const transformOf = (): Record<string, number> =>
    defaultSceneGraph.getNode(id)!.components.find((c) => c.type === 'Transform')!.props as Record<string, number>;

  it('moves the layer along the handle’s world axis, through the shared write path', async () => {
    act(() => useSelectionStore.getState().set([id]));
    // Position-only handles (beforeEach): no rotation rings to sit near the
    // arm's tip and win the hit test, which would make this a test of
    // something else.
    const { container, getByTestId } = render(
      <GizmoHarness mode="top" view={{ scale: 1, offsetX: 0, offsetY: 0 }} />,
    );
    act(() => undefined);
    // The pane view is 1:1 and unpanned, so comp px ARE screen px.
    const tip = xArmTip(container);
    const stage = getByTestId('stage');
    await act(async () => {
      fireEvent.pointerDown(stage, { clientX: tip.x, clientY: tip.y, button: 0, pointerId: 7 });
      fireEvent.pointerMove(window, { clientX: tip.x + 60, clientY: tip.y, pointerId: 7 });
      fireEvent.pointerUp(window, { clientX: tip.x + 60, clientY: tip.y, pointerId: 7 });
      await engineIdle();
    });

    const props = transformOf();
    // World-X handle: y and z are untouched by construction, x carries the drag.
    expect(props.y).toBeCloseTo(START.y, 6);
    expect(props.z).toBeCloseTo(START.z, 6);
    // A position arm follows the pointer's own ray/axis intersection — it does
    // NOT preserve the grab offset, which is the arithmetic the main viewport
    // has always used (`closestPointRayAxis`). In a top view world X *is* comp
    // X, so the layer lands on the world X the pointer ended over: the arm tip
    // plus the drag. The tip is read back out of the PANE's own drawing, so
    // this number can only come out right if the pane's projection is what
    // drove the drag.
    expect(props.x).toBeCloseTo(tip.x + 60, 3);
    expect(Number(props.x)).not.toBeCloseTo(START.x, 3);
  });

  it('leaves the scene alone when the press misses every handle', async () => {
    act(() => useSelectionStore.getState().set([id]));
    const { getByTestId } = render(
      <GizmoHarness mode="top" view={{ scale: 1, offsetX: 0, offsetY: 0 }} />,
    );
    act(() => undefined);
    const stage = getByTestId('stage');
    const before = h.doc();
    const entries = historyLabels().length;
    await act(async () => {
      fireEvent.pointerDown(stage, { clientX: 5000, clientY: 5000, button: 0, pointerId: 8 });
      fireEvent.pointerMove(window, { clientX: 5060, clientY: 5000, pointerId: 8 });
      fireEvent.pointerUp(window, { clientX: 5060, clientY: 5000, pointerId: 8 });
      await engineIdle();
    });
    expect(transformOf().x).toBeCloseTo(START.x, 6);
    expect(h.doc()).toEqual(before);
    expect(historyLabels().length).toBe(entries);
  });

  it('a pane drag moves the layer — ONE "Move" entry, undo restores it', async () => {
    act(() => useSelectionStore.getState().set([id]));
    const { container, getByTestId } = render(
      <GizmoHarness mode="top" view={{ scale: 1, offsetX: 0, offsetY: 0 }} />,
    );
    act(() => undefined);
    const stage = getByTestId('stage');
    const tip = xArmTip(container);
    const entries = historyLabels().length;
    await act(async () => {
      fireEvent.pointerDown(stage, { clientX: tip.x, clientY: tip.y, button: 0, pointerId: 9 });
      for (const dx of [20, 40, 60]) fireEvent.pointerMove(window, { clientX: tip.x + dx, clientY: tip.y, pointerId: 9 });
      fireEvent.pointerUp(window, { clientX: tip.x + 60, clientY: tip.y, pointerId: 9 });
      await engineIdle();
    });
    const t = defaultSceneGraph.getNode(id)!.components.find((c) => c.type === 'Transform')!.props as Record<string, number>;
    expect(t.x).toBeCloseTo(tip.x + 60, 3);
    expect(t.y).toBeCloseTo(START.y, 6);
    expect(t.z).toBeCloseTo(START.z, 6);
    expect(historyLabels().length).toBe(entries + 1);
    expect(historyLabels().at(-1)).toBe('Move');
    await act(async () => { await h.run({ type: 'undo' }); });
    const back = defaultSceneGraph.getNode(id)!.components.find((c) => c.type === 'Transform')!.props as Record<string, number>;
    expect(back.x).toBeCloseTo(START.x, 6);
  });
});
