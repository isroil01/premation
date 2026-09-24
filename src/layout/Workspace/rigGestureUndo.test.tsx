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
 *
 * The rig layer is a real layer on the APP's engine (B3z): the overlays send
 * engine commands, so every gesture is awaited (`idle`) before the document or
 * the history is read back; undo / redo are the user's (`performUndo`).
 */

import { render, fireEvent, act, cleanup } from '@testing-library/react';
import { PuppetOverlay } from './PuppetOverlay';
import { BoneOverlay } from './BoneOverlay';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { defaultAnimation } from '@motion/animation';
import { clearRestMeshCache } from '@core/rig/puppet';
import { readNodeSkeleton } from '@core/rig/skeletonCommands';
import { isWeightPaintEmpty } from '@core/rig/weightPaint';
import { performUndo, performRedo } from '@stores/historyStore';
import { getCommandSystem } from '@core/commands/CommandSystem';
import { setupAppEngine } from '@core/engine/__testHelpers__/appEngine';
import { sec } from '@core/engine/__testHelpers__/harness';
import { engineIdle } from '@core/engine/engineInstance';
import { useRigSelectionStore } from '@stores/rigSelectionStore';
import { rigTestLayer } from './__testHelpers__/rigLayer';

/**
 * The overlays redraw on the viewport's render ticks (`onRender`), which the
 * real controller fires after every document change. The mock collects the
 * listeners and `idle()` ticks them once the engine has settled.
 */
const mockRenderListeners = new Set<() => void>();
jest.mock('@core/workspace/WorkspaceController', () => ({
  getWorkspaceController: () => ({
    onRender: (fn: () => void) => {
      mockRenderListeners.add(fn);
      return () => { mockRenderListeners.delete(fn); };
    },
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

let h: Awaited<ReturnType<typeof setupAppEngine>>;
/** The rig layer (engine-created, 200 × 160 at the comp origin). */
let L = '';

/** Let the engine apply what the overlay sent, then tick the viewport (the overlays redraw). */
async function idle(): Promise<void> {
  await act(async () => { await engineIdle(); });
  act(() => { for (const fn of [...mockRenderListeners]) fn(); });
}
const undo = async (): Promise<void> => { await act(async () => { await performUndo(); }); await idle(); };
const redo = async (): Promise<void> => { await act(async () => { await performRedo(); }); await idle(); };
const skelOf = () => readNodeSkeleton(defaultSceneGraph.getNode(L)!)!;

/** Current undo-stack depth. */
const undoDepth = (): number => getCommandSystem().getHistory().getEntries().length;

/**
 * Steps the stack GREW by while `fn` ran (and the engine settled).
 *
 * Measured as a delta, not an absolute depth: mounting an overlay and selecting
 * a layer may legitimately push unrelated entries, so counting from zero would
 * attribute the harness's own bookkeeping to the gesture under test.
 */
async function stepsAdded(fn: () => void | Promise<void>): Promise<number> {
  await idle();
  const before = undoDepth();
  await fn();
  await idle();
  return undoDepth() - before;
}

/** Write a whole rig through the engine (setup, then a clean history). */
async function setRig(path: 'layer/puppet' | 'layer/skeleton', rig: unknown): Promise<void> {
  await h.run({ type: 'setProperty', prop: { layer: L, path }, value: { kind: 'json', value: JSON.stringify(rig) } });
  await idle();
  getCommandSystem().getHistory().clear();
}

beforeEach(async () => {
  h = await setupAppEngine();
  clearRestMeshCache();
  L = await rigTestLayer(h);
  useSelectionStore.getState().set([L]);
  usePreferenceStore.setState({ timelineAutoKeyframe: false });
});
afterEach(async () => {
  cleanup();
  await h.dispose();
});

// ── Weight-paint stroke ─────────────────────────────────────────────

describe('weight-paint stroke undo', () => {
  async function setup() {
    await setRig('layer/skeleton', {
      bones: [
        { id: 'upper', name: 'Upper', parentId: null, length: 50, x: -60, y: 0, rotation: 0 },
        { id: 'fore', name: 'Fore', parentId: 'upper', length: 50, x: 50, y: 0, rotation: 0 },
      ],
      ikTargets: [], meshDensity: 6, meshExpansion: 0,
    });
    useUIStore.getState().setActiveTool('bone');
    useUIStore.getState().setBoneRigMode('weights');
    useUIStore.getState().setBoneWeightMode('add');
    useRigSelectionStore.getState().clear();
    const utils = render(<BoneOverlay />);
    const { container } = utils;
    // Select a bone, then engage the brush.
    const boneG = container.querySelector('polygon[stroke="var(--color-overlay-rig-bone)"]')!.parentElement!;
    fireEvent.pointerDown(boneG, { clientX: -60, clientY: 0, pointerId: 1 });
    fireEvent.pointerUp(container.querySelector('svg')!, { clientX: -60, clientY: 0, pointerId: 1 });
    await idle();
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

  it('a 12-move stroke is exactly ONE undo step', async () => {
    const { container } = await setup();
    expect(await stepsAdded(() => stroke(container))).toBe(1);
    expect(isWeightPaintEmpty(skelOf().weightPaint)).toBe(false);
  });

  it('undo restores the unpainted binding, redo brings it back', async () => {
    const { container } = await setup();
    stroke(container);
    await idle();
    const painted = skelOf().weightPaint;
    expect(isWeightPaintEmpty(painted)).toBe(false);

    await undo();
    expect(isWeightPaintEmpty(skelOf().weightPaint)).toBe(true);

    await redo();
    expect(skelOf().weightPaint).toEqual(painted);
  });

  it('two strokes are two steps, undone independently', async () => {
    const { container } = await setup();
    stroke(container);
    await idle();
    const afterFirst = skelOf().weightPaint;
    stroke(container);
    await idle();

    await undo();
    expect(skelOf().weightPaint).toEqual(afterFirst);
  });
});

// ── Puppet Sketch recording ─────────────────────────────────────────

describe('Puppet Sketch undo', () => {
  async function setup() {
    await setRig('layer/puppet', {
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

  it('a 15-sample recording is exactly ONE undo step', async () => {
    const { container } = await setup();
    expect(await stepsAdded(() => recordStroke(container))).toBe(1);
    expect(defaultAnimation.getDataTrack(L, 'puppet.pin_1.position')).toBeTruthy();
  });

  it('undo removes the whole recording, not one keyframe of it', async () => {
    const { container } = await setup();
    recordStroke(container);
    await idle();
    const before = defaultAnimation.getDataTrack(L, 'puppet.pin_1.position');
    expect(before!.keyframes.length).toBeGreaterThan(0);
    const count = before!.keyframes.length;

    await undo();
    const after = defaultAnimation.getDataTrack(L, 'puppet.pin_1.position');
    expect(after?.keyframes.length ?? 0).toBe(0);

    await redo();
    expect(defaultAnimation.getDataTrack(L, 'puppet.pin_1.position')!.keyframes.length).toBe(count);
  });
});

// ── Spatial tangent drag ────────────────────────────────────────────

describe('spatial tangent drag undo', () => {
  async function setup() {
    await setRig('layer/puppet', {
      meshDensity: 6, meshExpansion: 0,
      pins: [{ id: 'pin_1', name: 'Pin 1', x: 0, y: 0 }],
    });
    // A two-keyframe path so the motion path (and its handles) render.
    const path = 'puppet/pins/pin_1/position';
    await h.run({
      type: 'addKeyframes',
      keys: [
        { prop: { layer: L, path }, time: 0, value: { kind: 'vec2', value: { x: -60, y: 0 } }, spatialIn: [], spatialOut: [] },
        { prop: { layer: L, path }, time: sec(2), value: { kind: 'vec2', value: { x: 60, y: 0 } }, spatialIn: [], spatialOut: [] },
      ],
    });
    await idle();
    getCommandSystem().getHistory().clear();
    useUIStore.getState().setActiveTool('puppet-pin');
    const utils = render(<PuppetOverlay />);
    // Select the pin so its motion path is drawn.
    const dot = utils.container.querySelector('circle[r="5"]')!;
    fireEvent.pointerDown(dot.parentElement!, { clientX: -60, clientY: 0, pointerId: 4 });
    fireEvent.pointerUp(utils.container.querySelector('svg')!, { clientX: -60, clientY: 0, pointerId: 4 });
    await idle();
    return utils;
  }

  const tangentOf = () =>
    defaultAnimation.getDataTrack(L, 'puppet.pin_1.position')!.keyframes[0]!.so;

  it('renders draggable tangent handles for the selected pin', async () => {
    const { container } = await setup();
    expect(container.querySelector('path[stroke-dasharray]')).not.toBeNull();
    expect(container.querySelectorAll('circle[r="3.5"]').length).toBeGreaterThan(0);
  });

  it('a multi-move handle drag is exactly ONE undo step', async () => {
    const { container } = await setup();
    const svg = container.querySelector('svg')!;
    const handle = container.querySelector('circle[r="3.5"]')!;

    const steps = await stepsAdded(async () => {
      fireEvent.pointerDown(handle.parentElement!, { clientX: -20, clientY: 0, pointerId: 5 });
      // The handle resolves its key's engine id on press; a hand's first move comes after.
      await idle();
      for (let i = 0; i < 8; i++) {
        fireEvent.pointerMove(svg, { clientX: -20 + i * 3, clientY: -10 - i * 4, pointerId: 5 });
      }
      fireEvent.pointerUp(svg, { clientX: 4, clientY: -42, pointerId: 5 });
    });

    expect(tangentOf()).toBeTruthy();
    expect(steps).toBe(1);
  });

  it('undo removes the tangent and restores the straight path', async () => {
    const { container } = await setup();
    const svg = container.querySelector('svg')!;
    const handle = container.querySelector('circle[r="3.5"]')!;
    fireEvent.pointerDown(handle.parentElement!, { clientX: -20, clientY: 0, pointerId: 6 });
    await idle();
    fireEvent.pointerMove(svg, { clientX: 0, clientY: -50, pointerId: 6 });
    fireEvent.pointerUp(svg, { clientX: 0, clientY: -50, pointerId: 6 });
    await idle();
    expect(tangentOf()).toBeTruthy();

    await undo();
    expect(tangentOf() ?? null).toBeNull();
    // Keyframe VALUES are untouched either way — a tangent is not a position.
    const kfs = defaultAnimation.getDataTrack(L, 'puppet.pin_1.position')!.keyframes;
    expect(kfs[0]!.value).toEqual([{ x: -60, y: 0 }]);
    expect(kfs[1]!.value).toEqual([{ x: 60, y: 0 }]);
  });
});
