/**
 * Undo granularity for the canvas rig gestures.
 *
 * The contract every rig gesture is written to: ONE user gesture = ONE undo
 * step, and undoing it restores the exact prior state. That is easy to get
 * wrong in the direction that matters — a drag writes a keyframe per
 * pointermove, so a gesture that records per-move instead of per-release leaves
 * the user pressing Ctrl+Z fifty times to undo one drag.
 *
 * These three gestures had no coverage: weight-paint strokes, Puppet Sketch
 * recordings, and spatial-tangent drags.
 */

import { render, fireEvent } from '@testing-library/react';
import { PuppetOverlay } from './PuppetOverlay';
import { BoneOverlay } from './BoneOverlay';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import { defaultAnimation } from '@motion/animation';
import { clearRestMeshCache } from '@core/rig/puppet';
import { readNodeSkeleton } from '@core/rig/skeletonCommands';
import { isWeightPaintEmpty } from '@core/rig/weightPaint';
import { performUndo, performRedo } from '@stores/historyStore';
import { setCommandSystem, CommandSystem, getCommandSystem } from '@core/commands/CommandSystem';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';

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

function shapeNode(id: string): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      {
        id: `${id}_t`,
        type: 'Transform',
        props: { [SCENE_KIND_PROP]: 'shape', x: 0, y: 0, rotation: 0, width: 200, height: 160 },
      },
    ],
  } as unknown as SceneNode;
}

/** Current undo-stack depth, probed non-destructively (drain, then restore). */
function undoDepth(): number {
  const hist = getCommandSystem().getHistory();
  let n = 0;
  while (hist.canUndo()) { hist.undo(); n++; }
  for (let i = 0; i < n; i++) hist.redo();
  return n;
}

/**
 * Steps the stack GREW by while `fn` ran.
 *
 * Measured as a delta, not an absolute depth: mounting an overlay and selecting
 * a layer legitimately pushes unrelated entries (the timeline adds an
 * "Add Track" for the node), so counting from zero would attribute the harness's
 * own bookkeeping to the gesture under test.
 */
function stepsAdded(fn: () => void): number {
  const before = undoDepth();
  fn();
  return undoDepth() - before;
}

beforeEach(() => {
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
  // `defaultAnimation` is a module singleton — without this a track authored by
  // an earlier test survives into the next one, and an undo then "fails" by
  // reverting to that leftover rather than to nothing.
  defaultAnimation.clear();
  clearRestMeshCache();
  try { defaultSceneGraph.removeNode('u1'); } catch { /* fresh */ }
  defaultSceneGraph.addNode(shapeNode('u1'));
  useSelectionStore.getState().set(['u1']);
});

// ── Weight-paint stroke ─────────────────────────────────────────────

describe('weight-paint stroke undo', () => {
  const paintButton = (container: HTMLElement, label: string) =>
    [...container.querySelectorAll('g')].find(
      (g) =>
        g.children.length === 2 &&
        g.children[0]!.tagName === 'rect' &&
        g.children[1]!.textContent === label,
    )!;

  function setup() {
    defaultSceneGraph.setSkeleton('u1', {
      bones: [
        { id: 'upper', name: 'Upper', parentId: null, length: 50, x: -60, y: 0, rotation: 0 },
        { id: 'fore', name: 'Fore', parentId: 'upper', length: 50, x: 50, y: 0, rotation: 0 },
      ],
      ikTargets: [], meshDensity: 6, meshExpansion: 0,
    });
    useUIStore.getState().setActiveTool('bone');
    const utils = render(<BoneOverlay />);
    const { container } = utils;
    // Select a bone, then engage the brush.
    const boneG = container.querySelector('polygon[stroke="#ffaa00"]')!.parentElement!;
    fireEvent.pointerDown(boneG, { clientX: -60, clientY: 0, pointerId: 1 });
    fireEvent.pointerUp(container.querySelector('svg')!, { clientX: -60, clientY: 0, pointerId: 1 });
    fireEvent.click(paintButton(container, 'Paint +'));
    return utils;
  }

  /** A stroke with MANY pointermoves — the case that could over-record. */
  function stroke(container: HTMLElement): void {
    const svg = container.querySelector('svg')!;
    fireEvent.pointerDown(svg, { clientX: -50, clientY: 0, pointerId: 2 });
    for (let i = 0; i < 12; i++) {
      fireEvent.pointerMove(svg, { clientX: -50 + i * 6, clientY: 0, pointerId: 2 });
    }
    fireEvent.pointerUp(svg, { clientX: 22, clientY: 0, pointerId: 2 });
  }

  it('a 12-move stroke is exactly ONE undo step', () => {
    const { container } = setup();
    expect(stepsAdded(() => stroke(container))).toBe(1);
    expect(isWeightPaintEmpty(readNodeSkeleton(defaultSceneGraph.getNode('u1')!)!.weightPaint)).toBe(false);
  });

  it('undo restores the unpainted binding, redo brings it back', () => {
    const { container } = setup();
    stroke(container);
    const painted = readNodeSkeleton(defaultSceneGraph.getNode('u1')!)!.weightPaint;
    expect(isWeightPaintEmpty(painted)).toBe(false);

    performUndo();
    expect(isWeightPaintEmpty(readNodeSkeleton(defaultSceneGraph.getNode('u1')!)!.weightPaint)).toBe(true);

    performRedo();
    expect(readNodeSkeleton(defaultSceneGraph.getNode('u1')!)!.weightPaint).toEqual(painted);
  });

  it('two strokes are two steps, undone independently', () => {
    const { container } = setup();
    stroke(container);
    const afterFirst = readNodeSkeleton(defaultSceneGraph.getNode('u1')!)!.weightPaint;
    stroke(container);

    performUndo();
    expect(readNodeSkeleton(defaultSceneGraph.getNode('u1')!)!.weightPaint).toEqual(afterFirst);
  });
});

// ── Puppet Sketch recording ─────────────────────────────────────────

describe('Puppet Sketch undo', () => {
  function setup() {
    defaultSceneGraph.setPuppet('u1', {
      meshDensity: 6, meshExpansion: 0,
      pins: [{ id: 'pin_1', name: 'Pin 1', x: 0, y: 0 }],
    });
    useUIStore.getState().setActiveTool('puppet-pin');
    return render(<PuppetOverlay />);
  }

  /** Ctrl-drag = record. Many samples, one gesture. */
  function recordStroke(container: HTMLElement): void {
    const svg = container.querySelector('svg')!;
    const dot = container.querySelector('circle[r="5"]')!;
    fireEvent.pointerDown(dot.parentElement!, { clientX: 0, clientY: 0, pointerId: 3, ctrlKey: true });
    for (let i = 1; i <= 15; i++) {
      fireEvent.pointerMove(svg, { clientX: i * 4, clientY: -i * 2, pointerId: 3 });
    }
    fireEvent.pointerUp(svg, { clientX: 60, clientY: -30, pointerId: 3 });
  }

  it('a 15-sample recording is exactly ONE undo step', () => {
    const { container } = setup();
    expect(stepsAdded(() => recordStroke(container))).toBe(1);
    expect(defaultAnimation.getDataTrack('u1', 'puppet.pin_1.position')).toBeTruthy();
  });

  it('undo removes the whole recording, not one keyframe of it', () => {
    const { container } = setup();
    recordStroke(container);
    const before = defaultAnimation.getDataTrack('u1', 'puppet.pin_1.position');
    expect(before!.keyframes.length).toBeGreaterThan(0);

    performUndo();
    const after = defaultAnimation.getDataTrack('u1', 'puppet.pin_1.position');
    expect(after?.keyframes.length ?? 0).toBe(0);

    performRedo();
    expect(defaultAnimation.getDataTrack('u1', 'puppet.pin_1.position')!.keyframes.length)
      .toBe(before!.keyframes.length);
  });
});

// ── Spatial tangent drag ────────────────────────────────────────────

describe('spatial tangent drag undo', () => {
  function setup() {
    defaultSceneGraph.setPuppet('u1', {
      meshDensity: 6, meshExpansion: 0,
      pins: [{ id: 'pin_1', name: 'Pin 1', x: 0, y: 0 }],
    });
    // A two-keyframe path so the motion path (and its handles) render.
    defaultAnimation.setDataTrack('u1', 'puppet.pin_1.position', {
      nodeId: 'u1', prop: 'puppet.pin_1.position', kind: 'points',
      keyframes: [
        { t: 0, value: [{ x: -60, y: 0 }] },
        { t: 2, value: [{ x: 60, y: 0 }] },
      ],
    } as never);
    useUIStore.getState().setActiveTool('puppet-pin');
    const utils = render(<PuppetOverlay />);
    // Select the pin so its motion path is drawn.
    const dot = utils.container.querySelector('circle[r="5"]')!;
    fireEvent.pointerDown(dot.parentElement!, { clientX: -60, clientY: 0, pointerId: 4 });
    fireEvent.pointerUp(utils.container.querySelector('svg')!, { clientX: -60, clientY: 0, pointerId: 4 });
    return utils;
  }

  const tangentOf = () =>
    defaultAnimation.getDataTrack('u1', 'puppet.pin_1.position')!.keyframes[0]!.so;

  it('renders draggable tangent handles for the selected pin', () => {
    const { container } = setup();
    expect(container.querySelector('path[stroke-dasharray]')).not.toBeNull();
    expect(container.querySelectorAll('circle[r="3.5"]').length).toBeGreaterThan(0);
  });

  it('a multi-move handle drag is exactly ONE undo step', () => {
    const { container } = setup();
    const svg = container.querySelector('svg')!;
    const handle = container.querySelector('circle[r="3.5"]')!;

    const steps = stepsAdded(() => {
      fireEvent.pointerDown(handle.parentElement!, { clientX: -20, clientY: 0, pointerId: 5 });
      for (let i = 0; i < 8; i++) {
        fireEvent.pointerMove(svg, { clientX: -20 + i * 3, clientY: -10 - i * 4, pointerId: 5 });
      }
      fireEvent.pointerUp(svg, { clientX: 4, clientY: -42, pointerId: 5 });
    });

    expect(tangentOf()).toBeTruthy();
    expect(steps).toBe(1);
  });

  it('undo removes the tangent and restores the straight path', () => {
    const { container } = setup();
    const svg = container.querySelector('svg')!;
    const handle = container.querySelector('circle[r="3.5"]')!;
    fireEvent.pointerDown(handle.parentElement!, { clientX: -20, clientY: 0, pointerId: 6 });
    fireEvent.pointerMove(svg, { clientX: 0, clientY: -50, pointerId: 6 });
    fireEvent.pointerUp(svg, { clientX: 0, clientY: -50, pointerId: 6 });
    expect(tangentOf()).toBeTruthy();

    performUndo();
    expect(tangentOf() ?? null).toBeNull();
    // Keyframe VALUES are untouched either way — a tangent is not a position.
    const kfs = defaultAnimation.getDataTrack('u1', 'puppet.pin_1.position')!.keyframes;
    expect(kfs[0]!.value).toEqual([{ x: -60, y: 0 }]);
    expect(kfs[1]!.value).toEqual([{ x: 60, y: 0 }]);
  });
});
