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
 *  • the WRITE — a stop drag lands on the layer's fill, through the same
 *    engine-API paint writers the inspector's `StopList` uses;
 *  • the KEYFRAME branch — with `fill.stops` animated the drag writes a Colors
 *    key (`layer/fillStops`) at the playhead instead of the static paint,
 *    which is the only write the renderer would read;
 *  • B3: every press-drag is ONE engine gesture — one undo entry, named as the
 *    user reads it — and undo restores the document exactly;
 *  • the two-stop floor, which the gizmo must honour as the panel's button does.
 *
 * The camera is mocked 1:1 and the layer sits at the comp origin, so screen px
 * ARE layer-local px and every coordinate below is the projection's own.
 */

import { render, fireEvent, act, cleanup } from '@testing-library/react';
import { GradientHandleOverlay } from './GradientHandleOverlay';
import { useGradientEditStore } from './gradientEditStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useSelectionStore } from '@stores/selectionStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { getNodeFill, getNodeFills, type FillPaint, type LinearFill } from '@core/paint/fill';
import { defaultStroke, getNodeStrokeAt } from '@core/paint/stroke';
import { defaultAnimation } from '@motion/animation';
import { getCommandSystem } from '@core/commands/CommandSystem';
import type { Command } from '@motion/engine-api';
import { engineIdle } from '@core/engine/engineInstance';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { fillPaintCommands, strokesCommands, textStrokePaintCommands } from '@layout/Inspector/appearance/paintEdits';
import { fieldCommands } from '@layout/Text/textEdits';

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

const W = 200;
const H = 160;

let h: Harness & { engine: LocalEngine };
/** The shape layer under test: W×H, at the comp origin. */
let ID: string;

/** Fixture writes, through the engine; the history is cleared after. */
async function fixture(cmds: Command[]): Promise<void> {
  await h.batch('fixture', cmds);
}

/** A layer of `kind` at the comp origin (so layer-local px are screen px). */
async function layerAtOrigin(kind: 'shape' | 'text'): Promise<string> {
  const { layer } = await h.run({ type: 'createLayer', comp: 'comp_root', kind, name: kind, init: [] });
  await h.run({ type: 'setProperty', prop: { layer, path: 'transform/position' }, value: { kind: 'vec2', value: { x: 0, y: 0 } } });
  return layer;
}

/**
 * A horizontal ramp, so the axis is the box's own width: 0° means `half` is
 * w/2, and the axis runs (−100, 0) → (100, 0) about the centred origin.
 */
const LINEAR: LinearFill = {
  type: 'linear',
  angle: 0,
  stops: [
    { id: 'a', offset: 0, color: '#000000' },
    { id: 'b', offset: 1, color: '#ffffff' },
  ],
};

async function linearFillOn(id: string, paint: FillPaint = LINEAR): Promise<void> {
  await fixture(fillPaintCommands(id, paint));
}

function currentStops(): Array<{ id: string; offset: number; color: string }> {
  const fill = getNodeFill(ID);
  return fill && fill.type !== 'solid' ? fill.stops : [];
}

/** The history starts empty for the action under test. */
function freshHistory(): void {
  getCommandSystem().getHistory().clear();
}

type Pt = [number, number];
/** One press-drag-release on the overlay, then the engine settles. */
async function drag(svg: Element, from: Pt, moves: Pt[], opts: { altKey?: boolean } = {}): Promise<void> {
  await act(async () => {
    fireEvent.pointerDown(svg, { clientX: from[0], clientY: from[1], pointerId: 1, altKey: opts.altKey ?? false });
    for (const [x, y] of moves) fireEvent.pointerMove(svg, { clientX: x, clientY: y, pointerId: 1, altKey: opts.altKey ?? false });
    const last = moves[moves.length - 1] ?? from;
    fireEvent.pointerUp(svg, { clientX: last[0], clientY: last[1], pointerId: 1 });
    await engineIdle();
  });
}

/** One painted frame: the overlay re-renders once per frame (`useSceneRevisionFrame`). */
async function frame(): Promise<void> {
  await act(async () => { await new Promise<void>((r) => { requestAnimationFrame(() => r()); }); });
}

async function undo(): Promise<void> {
  await act(async () => { await h.run({ type: 'undo' }); });
}

/** The screen centre of a labelled handle (its first circle). */
function centreOf(container: HTMLElement, label: string): Pt {
  const c = container.querySelector(`[aria-label="${label}"] circle`);
  if (!c) throw new Error(`no ${label}`);
  return [Number(c.getAttribute('cx')), Number(c.getAttribute('cy'))];
}

beforeEach(async () => {
  h = await setupAppEngine();
  ID = await layerAtOrigin('shape');
  const tid = defaultSceneGraph.getNode(ID)!.components.find((c) => c.type === 'Transform')!.id;
  defaultSceneGraph.writeProp(ID, tid, 'width', W);
  defaultSceneGraph.writeProp(ID, tid, 'height', H);
  useSelectionStore.getState().set([ID]);
  useGradientEditStore.getState().disarm();
  usePreferenceStore.setState({ timelineAutoKeyframe: false });
});

afterEach(async () => {
  cleanup();
  useGradientEditStore.getState().disarm();
  await h.dispose();
});

// ── Gates ────────────────────────────────────────────────────────────

describe('when the gizmo appears at all', () => {
  it('draws nothing for a layer with no gradient fill', async () => {
    await linearFillOn(ID, { type: 'solid', color: '#ff0000' });
    const { container } = render(<GradientHandleOverlay />);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('shows only the swatch chip until the editor is armed', async () => {
    // Gradient layers are usually backgrounds; an axis drawn across the
    // artwork on every selection would be chrome in the way far more often
    // than it was wanted.
    await linearFillOn(ID);
    const { container } = render(<GradientHandleOverlay />);
    expect(container.querySelector('svg')?.getAttribute('aria-label')).toBe('Gradient fill');
    expect(container.querySelector('line')).toBeNull();
  });

  it('draws the axis and both grips once armed', async () => {
    await linearFillOn(ID);
    useGradientEditStore.getState().arm(ID, 0);
    const { container } = render(<GradientHandleOverlay />);
    expect(container.querySelector('svg')?.getAttribute('aria-label')).toBe('Gradient handles');
    expect(container.querySelector('[aria-label="Gradient Start handle"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Gradient End handle"]')).not.toBeNull();
    // One diamond per stop, labelled by the position it sits at.
    expect(container.querySelector('[aria-label="Gradient stop 0%"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Gradient stop 100%"]')).not.toBeNull();
  });

  it('disappears when the armed layer is deselected', async () => {
    await linearFillOn(ID);
    useGradientEditStore.getState().arm(ID, 0);
    useSelectionStore.getState().set([]);
    const { container } = render(<GradientHandleOverlay />);
    expect(container.querySelector('svg')).toBeNull();
  });
});

// ── The write ────────────────────────────────────────────────────────

describe('dragging a stop', () => {
  async function armed() {
    await linearFillOn(ID);
    freshHistory();
    useGradientEditStore.getState().arm(ID, 0);
    const utils = render(<GradientHandleOverlay />);
    return { ...utils, svg: utils.container.querySelector('svg')! };
  }

  it('writes the new position onto the layer fill — ONE "Move Gradient Stop" entry; undo restores it', async () => {
    const { svg } = await armed();
    const before = h.doc();
    // The stop at offset 1 sits at the axis end — local (100, 0), and the
    // camera is 1:1, so that is where the pointer goes.
    await drag(svg, [100, 0], [[60, 0], [30, 0], [0, 0]]);

    const stops = currentStops();
    expect(stops).toHaveLength(2);
    expect(stops.find((s) => s.id === 'b')?.offset).toBeCloseTo(0.5);
    // The stop that was not dragged is untouched, colours and all.
    expect(stops.find((s) => s.id === 'a')).toEqual({ id: 'a', offset: 0, color: '#000000' });
    expect(historyLabels()).toEqual(['Move Gradient Stop']);

    await undo();
    expect(h.doc()).toEqual(before);
    expect(currentStops().find((s) => s.id === 'b')?.offset).toBe(1);
  });

  it('clamps a drag that runs past the end of the axis', async () => {
    const { svg } = await armed();
    await drag(svg, [-100, 0], [[400, 0]]);
    expect(currentStops().find((s) => s.id === 'a')?.offset).toBe(1);
  });

  it('adds a stop with the interpolated colour when the axis itself is clicked — ONE "Add Gradient Stop" entry', async () => {
    const { svg } = await armed();
    // Midway along a black→white ramp: the gradient must look identical the
    // instant the stop appears, and only change when it is dragged.
    await drag(svg, [0, 0], []);
    const stops = currentStops();
    expect(stops).toHaveLength(3);
    const added = stops.find((s) => s.id !== 'a' && s.id !== 'b');
    expect(added?.offset).toBeCloseTo(0.5);
    expect(added?.color).toBe('#808080ff');
    expect(historyLabels()).toEqual(['Add Gradient Stop']);
    await undo();
    expect(currentStops()).toHaveLength(2);
  });

  it('carries the stop it just added through the rest of the gesture', async () => {
    // The regression the gesture keeps its own copy of the list for: the next
    // move would otherwise map over a render-stale list that does not contain
    // the new stop, and write it straight back out of existence.
    const { svg } = await armed();
    await drag(svg, [0, 0], [[25, 0], [50, 0]]);
    const stops = currentStops();
    expect(stops).toHaveLength(3);
    expect(stops.find((s) => s.id !== 'a' && s.id !== 'b')?.offset).toBeCloseTo(0.75);
    // Add + drag is one action.
    expect(historyLabels()).toEqual(['Add Gradient Stop']);
  });

  it('Alt-drag duplicates instead of moving', async () => {
    const { svg } = await armed();
    await drag(svg, [100, 0], [[0, 0]], { altKey: true });
    const stops = currentStops();
    expect(stops).toHaveLength(3);
    // The original stayed where it was; the copy moved and kept its colour.
    expect(stops.find((s) => s.id === 'b')?.offset).toBe(1);
    const copy = stops.find((s) => s.id !== 'a' && s.id !== 'b');
    expect(copy?.offset).toBeCloseTo(0.5);
    expect(copy?.color).toBe('#ffffff');
    expect(historyLabels()).toEqual(['Duplicate Gradient Stop']);
  });

  it('does not steal a drag that started on empty canvas', async () => {
    // The SVG spans the whole stage. If it claimed events away from the hit
    // shapes, selecting and panning would stop working while it is armed.
    const { svg } = await armed();
    await drag(svg, [0, 60], [[40, 60]]);
    expect(currentStops().map((s) => s.offset)).toEqual([0, 1]);
    expect(historyLabels()).toEqual([]);
  });

  it('a press on a stop that does not move it records nothing', async () => {
    const { svg } = await armed();
    await drag(svg, [100, 0], []);
    expect(useGradientEditStore.getState().selectedStopId).toBe('b');
    expect(historyLabels()).toEqual([]);
  });
});

describe('dragging a grip', () => {
  it('turns a linear fill: the static angle, ONE "Move Gradient Handle" entry; undo restores it', async () => {
    await linearFillOn(ID);
    freshHistory();
    useGradientEditStore.getState().arm(ID, 0);
    const { container } = render(<GradientHandleOverlay />);
    const before = h.doc();
    // The end grip stands 15px past the axis end (100, 0).
    await drag(container.querySelector('svg')!, [115, 0], [[20, 60], [0, 90]]);
    expect((getNodeFill(ID) as LinearFill).angle).toBeCloseTo(90);
    expect(defaultAnimation.isAnimated(ID, 'fillAngle')).toBe(false);
    expect(historyLabels()).toEqual(['Move Gradient Handle']);
    await undo();
    expect(h.doc()).toEqual(before);
  });

  it('keys fillAngle at the playhead under Auto-Keyframe', async () => {
    await linearFillOn(ID);
    freshHistory();
    usePreferenceStore.setState({ timelineAutoKeyframe: true });
    useGradientEditStore.getState().arm(ID, 0);
    const { container } = render(<GradientHandleOverlay />);
    await drag(container.querySelector('svg')!, [115, 0], [[0, 90]]);
    expect(defaultAnimation.isAnimated(ID, 'fillAngle')).toBe(true);
    expect(defaultAnimation.sample(ID, 'fillAngle', 0)).toBeCloseTo(90);
    expect(historyLabels()).toEqual(['Move Gradient Handle']);
  });
});

describe('deleting a stop', () => {
  async function armedWithThree() {
    await linearFillOn(ID, {
      type: 'linear',
      angle: 0,
      stops: [
        { id: 'a', offset: 0, color: '#000000' },
        { id: 'b', offset: 0.5, color: '#ff0000' },
        { id: 'c', offset: 1, color: '#ffffff' },
      ],
    });
    freshHistory();
    useGradientEditStore.getState().arm(ID, 0);
    const utils = render(<GradientHandleOverlay />);
    return { ...utils, svg: utils.container.querySelector('svg')! };
  }

  it('removes the selected stop — ONE "Delete Gradient Stop" entry', async () => {
    const { svg } = await armedWithThree();
    await drag(svg, [0, 0], []);
    expect(useGradientEditStore.getState().selectedStopId).toBe('b');
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Delete' });
      await engineIdle();
    });
    expect(currentStops().map((s) => s.id)).toEqual(['a', 'c']);
    expect(historyLabels()).toEqual(['Delete Gradient Stop']);
    await undo();
    expect(currentStops().map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });

  it('refuses at two stops, because one is not a gradient', async () => {
    await linearFillOn(ID);
    freshHistory();
    useGradientEditStore.getState().arm(ID, 0);
    const { container } = render(<GradientHandleOverlay />);
    const svg = container.querySelector('svg')!;
    await drag(svg, [100, 0], []);
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Delete' });
      await engineIdle();
    });
    expect(currentStops()).toHaveLength(2);
    expect(historyLabels()).toEqual([]);
  });

  it('Escape puts the gizmo away', async () => {
    await linearFillOn(ID);
    useGradientEditStore.getState().arm(ID, 0);
    render(<GradientHandleOverlay />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useGradientEditStore.getState().nodeId).toBeNull();
  });
});

// ── The keyframe branch ──────────────────────────────────────────────

describe('when fill.stops is animated', () => {
  async function armedAnimated(paint: FillPaint = LINEAR) {
    await linearFillOn(ID, paint);
    // The Colors stopwatch: one key at 0 holding the stops.
    await h.run({ type: 'setAnimated', prop: { layer: ID, path: 'layer/fillStops' }, animated: true, time: 0 });
    freshHistory();
    useGradientEditStore.getState().arm(ID, 0);
    const utils = render(<GradientHandleOverlay />);
    return { ...utils, svg: utils.container.querySelector('svg')! };
  }
  const sampled = (): number[] =>
    ((defaultAnimation.sampleData(ID, 'fill.stops', 0) as Array<{ pos: number }> | undefined) ?? []).map((s) => s.pos);

  it('a drag writes the keyframe, not the static paint', async () => {
    const { svg } = await armedAnimated();
    await drag(svg, [100, 0], [[0, 0]]);

    expect(sampled()).toEqual([0, 0.5]);
    // The static paint is deliberately untouched: the renderer reads the
    // track, so writing there as well would be an edit nothing samples.
    expect((getNodeFill(ID) as LinearFill).stops.map((s) => s.offset)).toEqual([0, 1]);
  });

  it('a many-move drag is ONE undo entry, and undo restores the key', async () => {
    const { svg } = await armedAnimated();
    const before = h.doc();
    const moves: Pt[] = [];
    for (let i = 0; i < 12; i++) moves.push([100 - i * 8, 0]);
    moves.push([4, 0]);
    await drag(svg, [100, 0], moves);
    expect(historyLabels()).toEqual(['Move Gradient Stop']);
    await undo();
    expect(h.doc()).toEqual(before);
    expect(sampled()).toEqual([0, 1]);
  });

  it('the selection follows a dragged stop past its neighbour, so Delete removes THAT stop', async () => {
    // A keyed stop list is stored in offset order and its stops are named by
    // index: dragging the first stop past the middle one changes its index.
    const { svg } = await armedAnimated({
      type: 'linear',
      angle: 0,
      stops: [
        { id: 'a', offset: 0, color: '#000000' },
        { id: 'm', offset: 0.5, color: '#ff0000' },
        { id: 'b', offset: 1, color: '#ffffff' },
      ],
    });
    await drag(svg, [-100, 0], [[0, 0], [50, 0]]);
    expect(sampled()).toEqual([0.5, 0.75, 1]);
    expect(useGradientEditStore.getState().selectedStopId).toBe('anim_1');
    // The key is pressed after the gizmo has redrawn the moved list.
    await frame();
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Delete' });
      await engineIdle();
    });
    expect(sampled()).toEqual([0.5, 1]);
    expect(historyLabels()).toEqual(['Move Gradient Stop', 'Delete Gradient Stop']);
  });
});

// ── Multi-fill ───────────────────────────────────────────────────────

describe('a fill stack', () => {
  it('offers a chip per fill and edits the one that is picked', async () => {
    await fixture(fieldCommands(ID, 'layer/fills', [
      { type: 'linear', angle: 0, stops: [
        { id: 'a', offset: 0, color: '#000000' },
        { id: 'b', offset: 1, color: '#ffffff' },
      ] },
      { type: 'linear', angle: 0, stops: [
        { id: 'c', offset: 0, color: '#ff0000' },
        { id: 'd', offset: 1, color: '#00ff00' },
      ] },
    ]));
    freshHistory();
    useGradientEditStore.getState().arm(ID, 1);
    const { container } = render(<GradientHandleOverlay />);
    expect(container.querySelectorAll('[aria-label="Which fill to edit"] button')).toHaveLength(2);

    const before = h.doc();
    await drag(container.querySelector('svg')!, [100, 0], [[0, 0]]);

    const stack = getNodeFills(ID) as LinearFill[];
    // The SECOND fill moved; the primary is untouched.
    expect(stack[1]?.stops.find((s) => s.id === 'd')?.offset).toBeCloseTo(0.5);
    expect(stack[0]?.stops.find((s) => s.id === 'b')?.offset).toBe(1);
    expect(historyLabels()).toEqual(['Move Gradient Stop']);
    await undo();
    expect(h.doc()).toEqual(before);
  });

  it('a grip drag on a slot above the primary never keys the primary fill’s geometry', async () => {
    await fixture(fieldCommands(ID, 'layer/fills', [LINEAR, { ...LINEAR, stops: LINEAR.stops.map((s) => ({ ...s, id: `${s.id}2` })) }]));
    freshHistory();
    usePreferenceStore.setState({ timelineAutoKeyframe: true });
    useGradientEditStore.getState().arm(ID, 1);
    const { container } = render(<GradientHandleOverlay />);
    await drag(container.querySelector('svg')!, [115, 0], [[0, 90]]);
    const stack = getNodeFills(ID) as LinearFill[];
    expect(stack[1]?.angle).toBeCloseTo(90);
    expect(stack[0]?.angle).toBe(0);
    expect(defaultAnimation.isAnimated(ID, 'fillAngle')).toBe(false);
  });
});

// ── A text layer's stroke gradient ───────────────────────────────────

describe('a text stroke gradient', () => {
  let T: string;
  /** A text layer at the origin carrying a horizontal red→blue stroke ramp. */
  async function withStrokeGradient(): Promise<void> {
    T = await layerAtOrigin('text');
    await fixture(textStrokePaintCommands(T, {
      type: 'linear',
      angle: 0,
      stops: [
        { id: 's0', offset: 0, color: '#ff0000' },
        { id: 's1', offset: 1, color: '#0000ff' },
      ],
    }));
    useSelectionStore.getState().set([T]);
  }
  const strokeOf = () =>
    defaultSceneGraph.getNode(T)!.components.find((c) => c.type === 'Text')!.props.strokePaint as LinearFill;
  const fillStopsOf = (id: string): number[] => {
    const f = getNodeFill(id);
    return f && f.type !== 'solid' ? f.stops.map((s) => s.offset) : [];
  };

  it('offers a Fill/Stroke chip, and on Stroke a stop drag edits the stroke, not the fill', async () => {
    await withStrokeGradient();
    await linearFillOn(T);
    freshHistory();
    useGradientEditStore.getState().arm(T, 0, 'stroke');
    const { container } = render(<GradientHandleOverlay />);
    const chips = container.querySelectorAll('[aria-label="Which paint to edit"] button');
    expect([...chips].map((b) => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([
      ['Fill', 'false'],
      ['Stroke', 'true'],
    ]);

    // From the stop at the axis end to the axis middle.
    const end = centreOf(container, 'Gradient stop 100%');
    const start = centreOf(container, 'Gradient stop 0%');
    const before = h.doc();
    await drag(container.querySelector('svg')!, end, [[(start[0] + end[0]) / 2, (start[1] + end[1]) / 2]]);

    expect(strokeOf().stops.find((s) => s.id === 's1')?.offset).toBeCloseTo(0.5);
    expect(fillStopsOf(T)).toEqual([0, 1]);
    expect(historyLabels()).toEqual(['Move Gradient Stop']);
    await undo();
    expect(h.doc()).toEqual(before);

    fireEvent.click(chips[0]!);
    expect(useGradientEditStore.getState().target).toBe('fill');
  });

  it('a grip drag keyframes strokeAngle when that track is live — ONE undo entry, static paint untouched', async () => {
    await withStrokeGradient();
    defaultAnimation.setKeyframe(T, 'strokeAngle', 0, 0);
    freshHistory();
    useGradientEditStore.getState().arm(T, 0, 'stroke');
    const { container } = render(<GradientHandleOverlay />);
    const grip = centreOf(container, 'Gradient End handle');

    // Straight below the layer origin: the axis turns to 90°.
    await drag(container.querySelector('svg')!, grip, [[20, 60], [0, 90]]);

    expect(defaultAnimation.sample(T, 'strokeAngle', 0)).toBeCloseTo(90);
    expect(strokeOf().angle).toBe(0);
    expect(historyLabels()).toEqual(['Move Gradient Handle']);
  });
});

// ── A shape stroke's gradient (AE Gradient Stroke Start / End points) ─

describe('a shape stroke gradient', () => {
  it('a start-grip drag moves the stroke’s Start point only — ONE entry; undo restores it', async () => {
    await fixture(strokesCommands(ID, [{ ...defaultStroke(), paint: LINEAR }]));
    freshHistory();
    useGradientEditStore.getState().arm(ID, 0, 'shapeStroke');
    const { container } = render(<GradientHandleOverlay />);
    const grip = centreOf(container, 'Gradient Start handle');
    const endBefore = getNodeStrokeAt(ID, 0);
    const before = h.doc();

    // Local (−50, 40) is box-relative (0.25, 0.75).
    await drag(container.querySelector('svg')!, grip, [[-20, 20], [-50, 40]]);

    const g = getNodeStrokeAt(ID, 0)?.gradient;
    expect(g?.startX).toBeCloseTo(0.25);
    expect(g?.startY).toBeCloseTo(0.75);
    // The END point is the one the stroke showed before (derived from its
    // angle model), not moved.
    expect(endBefore?.gradient).toBeUndefined();
    expect(g?.endX).toBeCloseTo(1);
    expect(g?.endY).toBeCloseTo(0.5);
    expect(historyLabels()).toEqual(['Move Gradient Handle']);
    await undo();
    expect(h.doc()).toEqual(before);
  });
});
