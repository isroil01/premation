/**
 * The gradient gizmo's WIRING — the half `gradientHandles.test.ts` cannot pin.
 *
 * The geometry is exact and tested there. What is asserted here is the failure
 * mode viewport chrome has actually had in this repo: a handle that draws
 * beautifully and writes nothing (`deviceHandles`' original report), or one
 * whose writer and reader drift apart so the drag lands somewhere the renderer
 * never looks (F34, twice on this same panel). So:
 *
 *  • the GATES — nothing at all without a gradient, only a chip until armed;
 *  • the WRITE — a stop drag lands on the layer's fill, through the same path
 *    the inspector's `StopList` uses;
 *  • the KEYFRAME branch — with `fill.stops` animated the drag writes a
 *    `gradientStops` keyframe at the playhead instead of the static paint,
 *    which is the only write the renderer would read, and the whole gesture
 *    collapses to ONE undo entry;
 *  • the two-stop floor, which the gizmo must honour as the panel's button does.
 *
 * The camera is mocked 1:1 and the layer sits at the comp origin, so screen px
 * ARE layer-local px and every coordinate below is the projection's own.
 */

import { render, fireEvent } from '@testing-library/react';
import { GradientHandleOverlay } from './GradientHandleOverlay';
import { useGradientEditStore } from './gradientEditStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useSelectionStore } from '@stores/selectionStore';
import { getNodeFill, setNodeFill, setNodeFills, solidFill, type LinearFill } from '@core/paint/fill';
import { defaultAnimation } from '@motion/animation';
import { setCommandSystem, CommandSystem, getCommandSystem } from '@core/commands/CommandSystem';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { SceneNode } from '@core/types';

jest.mock('@core/workspace/WorkspaceController', () => ({
  getWorkspaceController: () => ({
    onRender: () => () => undefined,
    requestRender: () => undefined,
    ws: {
      camera: {
        zoom: 1,
        worldToScreen: (p: { x: number; y: number }) => ({ x: p.x, y: p.y }),
        screenToWorld: (p: { x: number; y: number }) => ({ x: p.x, y: p.y }),
      },
    },
  }),
}));

const ID = 'grad1';
const W = 200;
const H = 160;

function shapeNode(id: string): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      {
        id: `${id}_t`,
        type: 'Transform',
        props: { [SCENE_KIND_PROP]: 'shape', x: 0, y: 0, rotation: 0, width: W, height: H },
      },
    ],
  } as unknown as SceneNode;
}

/**
 * A horizontal ramp, so the axis is the box's own width: 0° means `half` is
 * w/2, and the axis runs (−100, 0) → (100, 0) about the centred origin.
 */
function linearFillOn(id: string): void {
  setNodeFill(id, {
    type: 'linear',
    angle: 0,
    stops: [
      { id: 'a', offset: 0, color: '#000000' },
      { id: 'b', offset: 1, color: '#ffffff' },
    ],
  });
}

function currentStops(): Array<{ id: string; offset: number; color: string }> {
  const fill = getNodeFill(ID);
  return fill && fill.type !== 'solid' ? fill.stops : [];
}

function undoDepth(): number {
  const hist = getCommandSystem().getHistory();
  let n = 0;
  while (hist.canUndo()) { hist.undo(); n++; }
  for (let i = 0; i < n; i++) hist.redo();
  return n;
}

beforeEach(() => {
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
  defaultAnimation.clear();
  try { defaultSceneGraph.removeNode(ID); } catch { /* fresh */ }
  defaultSceneGraph.addNode(shapeNode(ID));
  useSelectionStore.getState().set([ID]);
  useGradientEditStore.getState().disarm();
});

afterEach(() => {
  useGradientEditStore.getState().disarm();
});

// ── Gates ────────────────────────────────────────────────────────────

describe('when the gizmo appears at all', () => {
  it('draws nothing for a layer with no gradient fill', () => {
    setNodeFill(ID, solidFill('#ff0000'));
    const { container } = render(<GradientHandleOverlay />);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('shows only the swatch chip until the editor is armed', () => {
    // Gradient layers are usually backgrounds; an axis drawn across the
    // artwork on every selection would be chrome in the way far more often
    // than it was wanted.
    linearFillOn(ID);
    const { container } = render(<GradientHandleOverlay />);
    expect(container.querySelector('svg')?.getAttribute('aria-label')).toBe('Gradient fill');
    expect(container.querySelector('line')).toBeNull();
  });

  it('draws the axis and both grips once armed', () => {
    linearFillOn(ID);
    useGradientEditStore.getState().arm(ID, 0);
    const { container } = render(<GradientHandleOverlay />);
    expect(container.querySelector('svg')?.getAttribute('aria-label')).toBe('Gradient handles');
    expect(container.querySelector('[aria-label="Gradient Start handle"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Gradient End handle"]')).not.toBeNull();
    // One diamond per stop, labelled by the position it sits at.
    expect(container.querySelector('[aria-label="Gradient stop 0%"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Gradient stop 100%"]')).not.toBeNull();
  });

  it('disappears when the armed layer is deselected', () => {
    linearFillOn(ID);
    useGradientEditStore.getState().arm(ID, 0);
    useSelectionStore.getState().set([]);
    const { container } = render(<GradientHandleOverlay />);
    expect(container.querySelector('svg')).toBeNull();
  });
});

// ── The write ────────────────────────────────────────────────────────

describe('dragging a stop', () => {
  function armed() {
    linearFillOn(ID);
    useGradientEditStore.getState().arm(ID, 0);
    const utils = render(<GradientHandleOverlay />);
    return { ...utils, svg: utils.container.querySelector('svg')! };
  }

  it('writes the new position onto the layer fill', () => {
    const { svg } = armed();
    // The stop at offset 1 sits at the axis end — local (100, 0), and the
    // camera is 1:1, so that is where the pointer goes.
    fireEvent.pointerDown(svg, { clientX: 100, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerUp(svg, { clientX: 0, clientY: 0, pointerId: 1 });

    const stops = currentStops();
    expect(stops).toHaveLength(2);
    expect(stops.find((s) => s.id === 'b')?.offset).toBeCloseTo(0.5);
    // The stop that was not dragged is untouched, colours and all.
    expect(stops.find((s) => s.id === 'a')).toEqual({ id: 'a', offset: 0, color: '#000000' });
  });

  it('clamps a drag that runs past the end of the axis', () => {
    const { svg } = armed();
    fireEvent.pointerDown(svg, { clientX: -100, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: 400, clientY: 0, pointerId: 1 });
    fireEvent.pointerUp(svg, { clientX: 400, clientY: 0, pointerId: 1 });
    expect(currentStops().find((s) => s.id === 'a')?.offset).toBe(1);
  });

  it('adds a stop with the interpolated colour when the axis itself is clicked', () => {
    const { svg } = armed();
    // Midway along a black→white ramp: the gradient must look identical the
    // instant the stop appears, and only change when it is dragged.
    fireEvent.pointerDown(svg, { clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerUp(svg, { clientX: 0, clientY: 0, pointerId: 1 });
    const stops = currentStops();
    expect(stops).toHaveLength(3);
    const added = stops.find((s) => s.id !== 'a' && s.id !== 'b');
    expect(added?.offset).toBeCloseTo(0.5);
    expect(added?.color).toBe('#808080ff');
  });

  it('carries the stop it just added through the rest of the gesture', () => {
    // The regression the gesture keeps its own copy of the list for: the next
    // move would otherwise map over a render-stale list that does not contain
    // the new stop, and write it straight back out of existence.
    const { svg } = armed();
    fireEvent.pointerDown(svg, { clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: 50, clientY: 0, pointerId: 1 });
    fireEvent.pointerUp(svg, { clientX: 50, clientY: 0, pointerId: 1 });
    const stops = currentStops();
    expect(stops).toHaveLength(3);
    expect(stops.find((s) => s.id !== 'a' && s.id !== 'b')?.offset).toBeCloseTo(0.75);
  });

  it('Alt-drag duplicates instead of moving', () => {
    const { svg } = armed();
    fireEvent.pointerDown(svg, { clientX: 100, clientY: 0, pointerId: 1, altKey: true });
    fireEvent.pointerMove(svg, { clientX: 0, clientY: 0, pointerId: 1, altKey: true });
    fireEvent.pointerUp(svg, { clientX: 0, clientY: 0, pointerId: 1 });
    const stops = currentStops();
    expect(stops).toHaveLength(3);
    // The original stayed where it was; the copy moved and kept its colour.
    expect(stops.find((s) => s.id === 'b')?.offset).toBe(1);
    const copy = stops.find((s) => s.id !== 'a' && s.id !== 'b');
    expect(copy?.offset).toBeCloseTo(0.5);
    expect(copy?.color).toBe('#ffffff');
  });

  it('does not steal a drag that started on empty canvas', () => {
    // The SVG spans the whole stage. If it claimed events away from the hit
    // shapes, selecting and panning would stop working while it is armed.
    const { svg } = armed();
    fireEvent.pointerDown(svg, { clientX: 0, clientY: 60, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: 40, clientY: 60, pointerId: 1 });
    fireEvent.pointerUp(svg, { clientX: 40, clientY: 60, pointerId: 1 });
    expect(currentStops().map((s) => s.offset)).toEqual([0, 1]);
  });
});

describe('deleting a stop', () => {
  function armedWithThree() {
    setNodeFill(ID, {
      type: 'linear',
      angle: 0,
      stops: [
        { id: 'a', offset: 0, color: '#000000' },
        { id: 'b', offset: 0.5, color: '#ff0000' },
        { id: 'c', offset: 1, color: '#ffffff' },
      ],
    });
    useGradientEditStore.getState().arm(ID, 0);
    const utils = render(<GradientHandleOverlay />);
    return { ...utils, svg: utils.container.querySelector('svg')! };
  }

  it('removes the selected stop', () => {
    const { svg } = armedWithThree();
    fireEvent.pointerDown(svg, { clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerUp(svg, { clientX: 0, clientY: 0, pointerId: 1 });
    expect(useGradientEditStore.getState().selectedStopId).toBe('b');
    fireEvent.keyDown(window, { key: 'Delete' });
    expect(currentStops().map((s) => s.id)).toEqual(['a', 'c']);
  });

  it('refuses at two stops, because one is not a gradient', () => {
    linearFillOn(ID);
    useGradientEditStore.getState().arm(ID, 0);
    const { container } = render(<GradientHandleOverlay />);
    const svg = container.querySelector('svg')!;
    fireEvent.pointerDown(svg, { clientX: 100, clientY: 0, pointerId: 1 });
    fireEvent.pointerUp(svg, { clientX: 100, clientY: 0, pointerId: 1 });
    fireEvent.keyDown(window, { key: 'Delete' });
    expect(currentStops()).toHaveLength(2);
  });

  it('Escape puts the gizmo away', () => {
    linearFillOn(ID);
    useGradientEditStore.getState().arm(ID, 0);
    render(<GradientHandleOverlay />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useGradientEditStore.getState().nodeId).toBeNull();
  });
});

// ── The keyframe branch ──────────────────────────────────────────────

describe('when fill.stops is animated', () => {
  function armedAnimated() {
    linearFillOn(ID);
    defaultAnimation.setDataKeyframe(ID, 'fill.stops', 'gradientStops', 0, [
      { pos: 0, color: '#000000' },
      { pos: 1, color: '#ffffff' },
    ]);
    useGradientEditStore.getState().arm(ID, 0);
    const utils = render(<GradientHandleOverlay />);
    return { ...utils, svg: utils.container.querySelector('svg')! };
  }

  it('a drag writes the keyframe, not the static paint', () => {
    const { svg } = armedAnimated();
    fireEvent.pointerDown(svg, { clientX: 100, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerUp(svg, { clientX: 0, clientY: 0, pointerId: 1 });

    const sampled = defaultAnimation.sampleData(ID, 'fill.stops', 0) as
      | Array<{ pos: number; color: string }>
      | undefined;
    expect(sampled?.map((s) => s.pos)).toEqual([0, 0.5]);
    // The static paint is deliberately untouched: the renderer reads the
    // track, so writing there as well would be an edit nothing samples.
    expect((getNodeFill(ID) as LinearFill).stops.map((s) => s.offset)).toEqual([0, 1]);
  });

  it('a many-move drag is ONE undo entry', () => {
    const { svg } = armedAnimated();
    const before = undoDepth();
    fireEvent.pointerDown(svg, { clientX: 100, clientY: 0, pointerId: 1 });
    for (let i = 0; i < 12; i++) {
      fireEvent.pointerMove(svg, { clientX: 100 - i * 8, clientY: 0, pointerId: 1 });
    }
    fireEvent.pointerUp(svg, { clientX: 4, clientY: 0, pointerId: 1 });
    expect(undoDepth() - before).toBe(1);
  });
});

// ── Multi-fill ───────────────────────────────────────────────────────

describe('a fill stack', () => {
  it('offers a chip per fill and edits the one that is picked', () => {
    setNodeFills(ID, [
      { type: 'linear', angle: 0, stops: [
        { id: 'a', offset: 0, color: '#000000' },
        { id: 'b', offset: 1, color: '#ffffff' },
      ] },
      { type: 'linear', angle: 0, stops: [
        { id: 'c', offset: 0, color: '#ff0000' },
        { id: 'd', offset: 1, color: '#00ff00' },
      ] },
    ]);
    useGradientEditStore.getState().arm(ID, 1);
    const { container } = render(<GradientHandleOverlay />);
    expect(container.querySelectorAll('[aria-label="Which fill to edit"] button')).toHaveLength(2);

    const svg = container.querySelector('svg')!;
    fireEvent.pointerDown(svg, { clientX: 100, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerUp(svg, { clientX: 0, clientY: 0, pointerId: 1 });

    const node = defaultSceneGraph.getNode(ID)!;
    const fx = node.components.find((c) => c.type === 'fx');
    const stack = fx?.props.fills as Array<{ stops: Array<{ id: string; offset: number }> }>;
    // The SECOND fill moved; the primary is untouched.
    expect(stack[1]?.stops.find((s) => s.id === 'd')?.offset).toBeCloseTo(0.5);
    expect(stack[0]?.stops.find((s) => s.id === 'b')?.offset).toBe(1);
  });
});
