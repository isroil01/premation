/**
 * The focus-plane overlay: when it appears, and what a drag actually writes.
 *
 * The geometry and the drag arithmetic are pinned in `focusPlane.test.ts` — pure
 * functions, exact numbers. What CANNOT be tested there is the wiring, and the
 * wiring is where viewport chrome has historically failed in this repo: a
 * handle that draws but writes nothing (`deviceHandles`' original report), or a
 * control whose writer and reader drift apart (the four dead controls
 * `dofModel.test.ts` names). So this file asserts the two ends:
 *
 *  • the GATES — no plane in a comp with no camera, none with Depth of Field
 *    switched off, and none for the camera the view is looking THROUGH, where
 *    the rectangle would trace the comp edges and the drag axis is a point;
 *  • the WRITE — a drag on the handle lands on `focusDistance` through the
 *    engine API by the inspector row's rule, and it keyframes rather than only
 *    writing the base value once the property is animated; the whole drag is
 *    ONE undo entry.
 */

import { render, act, fireEvent } from '@testing-library/react';
import { FocusPlaneOverlay } from './FocusPlaneOverlay';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useSelectionStore } from '@stores/selectionStore';
import { useGuidesStore } from '@stores/guidesStore';
import { useFocusPlaneStore } from '@stores/focusPlaneStore';
import { defaultAnimation } from '@motion/animation';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import type { SceneNode } from '@core/types';
import { engineIdle } from '@core/engine/engineInstance';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import { propRefForTrack, values } from '@core/engine/propRefs';
import { usePreferenceStore } from '@stores/preferenceStore';

jest.mock('@core/workspace/WorkspaceController', () => ({
  getWorkspaceController: () => ({
    // 1:1, unpanned — so canvas px are comp px and the numbers below are the
    // projection's own, not the viewport's.
    getView: () => ({ scale: 1, offsetX: 0, offsetY: 0 }),
    onRender: () => () => undefined,
    requestRender: () => undefined,
  }),
}));

interface CamOpts {
  dofStrength?: number;
  focusDistance?: number;
  focalLength?: number;
}

function cameraNode(id: string, o: CamOpts = {}): SceneNode {
  const { dofStrength = 40, focusDistance = 2000, focalLength = 1000 } = o;
  return {
    id,
    name: id,
    parent: null,
    children: [],
    visible: true,
    locked: false,
    transform: { position: { x: 960, y: 540 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      {
        id: `${id}_t`,
        type: 'Transform',
        props: {
          [SCENE_KIND_PROP]: 'camera',
          x: 960,
          y: 540,
          z: -1000,
          focalLength,
          focusDistance,
          dofStrength,
        },
      },
    ],
  } as unknown as SceneNode;
}

function reset(): void {
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
  defaultAnimation.clear?.();
  for (const id of ['cam1']) {
    try {
      defaultSceneGraph.removeNode(id);
    } catch {
      /* already gone */
    }
  }
  useSelectionStore.getState().set([]);
  useFocusPlaneStore.getState().setVisibility('always');
  useFocusPlaneStore.getState().setDragDistance(null);
  // A view from OUTSIDE the camera: the plane is suppressed inside its own.
  useGuidesStore.getState().setCamera3dMode('top');
}

/** The plane's own rectangle — the solid-ish one, not a band. */
const planes = (c: HTMLElement): Element[] => [...c.querySelectorAll('polygon')];
/** The drag handle's invisible hit target. */
const handle = (c: HTMLElement): SVGCircleElement | null =>
  c.querySelector<SVGCircleElement>('circle[fill="transparent"]');

const focusProp = (id: string): unknown => {
  const node = defaultSceneGraph.getNode(id);
  const t = node?.components.find((cmp) => cmp.type === 'Transform');
  return (t?.props as Record<string, unknown> | undefined)?.focusDistance;
};

beforeEach(reset);
afterEach(reset);

describe('when the plane appears', () => {
  it('draws nothing in a composition with no camera at all', () => {
    const { container } = render(<FocusPlaneOverlay />);
    act(() => undefined);
    expect(planes(container)).toHaveLength(0);
  });

  it('draws the plane for a camera with Depth of Field on', () => {
    defaultSceneGraph.addNode(cameraNode('cam1'));
    const { container } = render(<FocusPlaneOverlay />);
    act(() => undefined);
    expect(planes(container).length).toBeGreaterThan(0);
    expect(handle(container)).not.toBeNull();
  });

  it('draws NOTHING when Depth of Field is off', () => {
    // Blur Level 0 means the property changes no pixel. Chrome for an inert
    // setting is worse than none — it invites a drag that does nothing.
    defaultSceneGraph.addNode(cameraNode('cam1', { dofStrength: 0 }));
    const { container } = render(<FocusPlaneOverlay />);
    act(() => undefined);
    expect(planes(container)).toHaveLength(0);
  });

  it('draws nothing while looking THROUGH that camera', () => {
    // In Active Camera view the cross-section IS the comp frame and the view
    // axis projects to a point — a rectangle on the comp edges with a handle
    // that cannot be dragged anywhere meaningful.
    defaultSceneGraph.addNode(cameraNode('cam1'));
    useGuidesStore.getState().setCamera3dMode('active');
    const { container } = render(<FocusPlaneOverlay />);
    act(() => undefined);
    expect(planes(container)).toHaveLength(0);
  });

  it('honours the visibility setting', () => {
    defaultSceneGraph.addNode(cameraNode('cam1'));
    useFocusPlaneStore.getState().setVisibility('off');
    const { container, rerender } = render(<FocusPlaneOverlay />);
    act(() => undefined);
    expect(planes(container)).toHaveLength(0);

    // `selected` shows it only for a camera you picked up.
    act(() => useFocusPlaneStore.getState().setVisibility('selected'));
    rerender(<FocusPlaneOverlay />);
    expect(planes(container)).toHaveLength(0);

    act(() => useSelectionStore.getState().set(['cam1']));
    rerender(<FocusPlaneOverlay />);
    expect(planes(container).length).toBeGreaterThan(0);
  });
});

/**
 * The same overlay mounted in a 2-up / 4-up secondary pane.
 *
 * Everything the gates above describe is stated per VIEW, and until the view
 * was a parameter there could only ever be one: the mode came off
 * `guidesStore.camera3dMode` and the transform off the workspace controller, so
 * an instance inside a Top pane would have drawn the main viewport's Active
 * Camera geometry on the pane's pixels. These pin the two halves of the fix —
 * the mode the gates read, and the transform the plane is placed with.
 */
describe('bound to a secondary pane’s view', () => {
  /** The pane's transform: a different zoom AND a different origin. */
  const PANE_VIEW = { scale: 2, offsetX: 100, offsetY: 50 };

  it('draws for the pane’s own mode while the main viewport suppresses it', () => {
    defaultSceneGraph.addNode(cameraNode('cam1'));
    // The MAIN viewport is looking through the camera, where the plane is
    // suppressed — see the header note. A Top pane is exactly where you would
    // then want to pull focus, and it must not inherit that suppression.
    useGuidesStore.getState().setCamera3dMode('active');

    const main = render(<FocusPlaneOverlay />);
    act(() => undefined);
    expect(planes(main.container)).toHaveLength(0);

    const pane = render(<FocusPlaneOverlay mode="top" getView={() => PANE_VIEW} />);
    act(() => undefined);
    expect(planes(pane.container).length).toBeGreaterThan(0);
    expect(handle(pane.container)).not.toBeNull();
  });

  it('suppresses itself in an Active Camera pane, whatever the main viewport shows', () => {
    defaultSceneGraph.addNode(cameraNode('cam1'));
    useGuidesStore.getState().setCamera3dMode('top');
    const pane = render(<FocusPlaneOverlay mode="active" getView={() => PANE_VIEW} />);
    act(() => undefined);
    expect(planes(pane.container)).toHaveLength(0);
  });

  it('places the handle with the pane’s transform, not the controller’s', () => {
    defaultSceneGraph.addNode(cameraNode('cam1'));
    // The mocked controller view is 1:1 and unpanned, so the main instance's
    // handle sits at the raw comp-space projection …
    const main = render(<FocusPlaneOverlay />);
    const pane = render(<FocusPlaneOverlay mode="top" getView={() => PANE_VIEW} />);
    act(() => undefined);

    const at = (c: HTMLElement): { x: number; y: number } => {
      const h = handle(c)!;
      return { x: Number(h.getAttribute('cx')), y: Number(h.getAttribute('cy')) };
    };
    const compPt = at(main.container);
    // … and the pane's is the same point through the PANE's comp → canvas map.
    expect(at(pane.container).x).toBeCloseTo(compPt.x * PANE_VIEW.scale + PANE_VIEW.offsetX, 6);
    expect(at(pane.container).y).toBeCloseTo(compPt.y * PANE_VIEW.scale + PANE_VIEW.offsetY, 6);
  });
});

/**
 * B3: a camera that is a LAYER of a composition (the editor's case) is written
 * through the engine API — the whole drag is one undo entry, and undo puts the
 * focus back.
 */
describe('through the engine API', () => {
  let h: Awaited<ReturnType<typeof setupAppEngine>>;
  let cam: string;

  beforeEach(async () => {
    h = await setupAppEngine();
    cam = (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'camera', name: 'Cam', init: [] })).layer;
    const tid = defaultSceneGraph.getNode(cam)!.components.find((c) => c.type === 'Transform')!.id;
    for (const [k, v] of Object.entries({ x: 960, y: 540, z: -1000, focalLength: 1000, focusDistance: 2000, dofStrength: 40 })) {
      defaultSceneGraph.writeProp(cam, tid, k, v);
    }
    useGuidesStore.getState().setCamera3dMode('top');
  });

  afterEach(async () => {
    await h.dispose();
  });

  function dragBy(container: HTMLElement, d: { x: number; y: number }): void {
    const hit = handle(container)!;
    const at = { x: Number(hit.getAttribute('cx')), y: Number(hit.getAttribute('cy')) };
    fireEvent.pointerDown(hit, { clientX: at.x, clientY: at.y, button: 0, pointerId: 1 });
    for (let i = 1; i <= 3; i++) fireEvent.pointerMove(hit, { clientX: at.x + (d.x * i) / 3, clientY: at.y + (d.y * i) / 3, pointerId: 1 });
    fireEvent.pointerUp(hit, { clientX: at.x + d.x, clientY: at.y + d.y, pointerId: 1 });
  }

  const idleDrag = async (container: HTMLElement, d: { x: number; y: number }): Promise<void> => {
    await act(async () => {
      dragBy(container, d);
      await engineIdle();
    });
  };

  it('writes focusDistance by the inspector row’s rule', async () => {
    const { container } = render(<FocusPlaneOverlay />);
    act(() => undefined);
    // Top view's screen-down is world −z (`ORTHO_BASIS`), so the camera's +z
    // view axis runs UP the screen at 1:1 — dragging the handle 300px up pushes
    // focus 300 comp px further away.
    await idleDrag(container, { x: 0, y: -300 });
    expect(focusProp(cam)).toBeCloseTo(2300, 3);
    expect(defaultAnimation.isAnimated(cam, 'focusDistance')).toBe(false);
  });

  it('keyframes at the playhead when focusDistance is animated', async () => {
    // The rack-focus case: on an animated property the renderer samples the
    // track, so a base-only write is invisible and the handle looks broken.
    await h.run({
      type: 'addKeyframes',
      keys: [{ prop: propRefForTrack(cam, 'focusDistance')!.ref, time: 0, value: values.scalar(2000), spatialIn: [], spatialOut: [] }],
    });
    const { container } = render(<FocusPlaneOverlay />);
    act(() => undefined);
    await idleDrag(container, { x: 0, y: -250 });
    expect(defaultAnimation.sample(cam, 'focusDistance', 0)).toBeCloseTo(2250, 3);
  });

  it('keys an unanimated focusDistance under Auto-Keyframe', async () => {
    usePreferenceStore.setState({ timelineAutoKeyframe: true });
    try {
      const { container } = render(<FocusPlaneOverlay />);
      act(() => undefined);
      await idleDrag(container, { x: 0, y: -300 });
      expect(defaultAnimation.isAnimated(cam, 'focusDistance')).toBe(true);
      expect(defaultAnimation.sample(cam, 'focusDistance', 0)).toBeCloseTo(2300, 3);
      expect(historyLabels().at(-1)).toBe('Focus Distance');
    } finally {
      usePreferenceStore.setState({ timelineAutoKeyframe: false });
    }
  });

  it('works on a plane that appeared AFTER the overlay mounted', async () => {
    // The overlay renders no SVG at all while there is nothing to draw, so the
    // pointer listeners live on an element that does not exist yet on first
    // mount. Showing the plane later has to re-attach them — otherwise the
    // handle draws and is completely inert, which is the exact failure
    // `deviceHandles` was written to close.
    useFocusPlaneStore.getState().setVisibility('off');
    const { container, rerender } = render(<FocusPlaneOverlay />);
    act(() => undefined);
    expect(handle(container)).toBeNull();

    act(() => useFocusPlaneStore.getState().setVisibility('always'));
    rerender(<FocusPlaneOverlay />);
    await idleDrag(container, { x: 0, y: -300 });
    expect(focusProp(cam)).toBeCloseTo(2300, 3);
  });

  it('a drag ACROSS the axis changes nothing', async () => {
    const { container } = render(<FocusPlaneOverlay />);
    act(() => undefined);
    const before = h.doc();
    await idleDrag(container, { x: 400, y: 0 });
    expect(focusProp(cam)).toBeCloseTo(2000, 3);
    expect(h.doc()).toEqual(before);
  });

  it('a press away from the handle is not a drag', async () => {
    const { container } = render(<FocusPlaneOverlay />);
    act(() => undefined);
    const hit = handle(container)!;
    const entries = historyLabels().length;
    await act(async () => {
      fireEvent.pointerDown(hit, { clientX: 4000, clientY: 4000, button: 0, pointerId: 1 });
      fireEvent.pointerMove(hit, { clientX: 4000, clientY: 4300, pointerId: 1 });
      fireEvent.pointerUp(hit, { clientX: 4000, clientY: 4300, pointerId: 1 });
      await engineIdle();
    });
    expect(focusProp(cam)).toBeCloseTo(2000, 3);
    expect(historyLabels().length).toBe(entries);
  });

  it('a drag is ONE "Focus Distance" entry; undo restores it', async () => {
    const { container } = render(<FocusPlaneOverlay />);
    act(() => undefined);
    const entries = historyLabels().length;
    await act(async () => {
      dragBy(container, { x: 0, y: -300 });
      await engineIdle();
    });
    expect(focusProp(cam)).toBeCloseTo(2300, 3);
    expect(historyLabels().length).toBe(entries + 1);
    expect(historyLabels().at(-1)).toBe('Focus Distance');
    await act(async () => { await h.run({ type: 'undo' }); });
    expect(focusProp(cam)).toBeCloseTo(2000, 3);
  });
});
