/**
 * 3D gizmo transform I/O (ports.ts) — the read/write contract that fixes the
 * gizmo/object desync:
 *
 *   READ — sampleTransform3DAtPlayhead returns the ANIMATED value when a
 *           track exists (what the renderer draws), base props otherwise.
 *   WRITE — applyGizmo3DTransforms goes through the engine (B3): a property
 *           with a lit stopwatch keys at the playhead (a base-only write is
 *           invisible there, because the renderer samples the track first),
 *           a static one takes the value. Props NOT in the update are never
 *           touched. One undo entry per call; undo restores exactly.
 */

import { defaultAnimation } from '@motion/animation';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { SceneNode } from '@core/types';
import { engineIdle as engineQueueIdle } from '@core/engine/engineInstance';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import { buildScene, type Scene } from '@core/engine/__testHelpers__/scene';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { usePreferenceStore } from '@stores/preferenceStore';
import { sampleTransform3DAtPlayhead, applyGizmo3DTransforms } from './ports';
import { settleToolEdits } from './viewportGesture';

const NODE = 'gizmo3d-ports-node';
const TRANS = `${NODE}_t`;
const ALL_PROPS = ['x', 'y', 'z', 'rotationX', 'rotationY', 'rotation', 'scaleX', 'scaleY', 'scale'] as const;

function makeNode(): SceneNode {
  return {
    id: NODE, name: NODE, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 100, y: 200 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      {
        id: TRANS,
        type: 'Transform',
        props: {
          [SCENE_KIND_PROP]: 'shape',
          x: 100, y: 200, rotation: 0, scaleX: 1, scaleY: 1, opacity: 100,
          // 3D-enabled layer (depth props present)
          z: 0, rotationX: 0, rotationY: 0,
        },
      },
    ],
  } as unknown as SceneNode;
}

describe('sampleTransform3DAtPlayhead', () => {
  beforeEach(() => {
    defaultSceneGraph.addNode(makeNode());
  });

  afterEach(() => {
    for (const p of ALL_PROPS) defaultAnimation.removeTrack(NODE, p);
    try { defaultSceneGraph.removeNode(NODE); } catch { /* already gone */ }
  });

  it('returns base transform props when nothing is animated', () => {
    const tv = sampleTransform3DAtPlayhead(defaultSceneGraph.getNode(NODE)!);
    expect(tv).toEqual({
      x: 100, y: 200, z: 0, rotationX: 0, rotationY: 0, rotation: 0, scaleX: 1, scaleY: 1, scaleZ: 1,
    });
  });

  it('animated tracks win over base props (what the renderer draws)', () => {
    defaultAnimation.setKeyframe(NODE, 'x', 0, 555);
    defaultAnimation.setKeyframe(NODE, 'rotationY', 0, 45);
    const tv = sampleTransform3DAtPlayhead(defaultSceneGraph.getNode(NODE)!);
    expect(tv.x).toBe(555); // NOT the stale base 100 the old gizmo anchored on
    expect(tv.rotationY).toBe(45);
    expect(tv.y).toBe(200); // un-animated props still read the base
  });
});

describe('applyGizmo3DTransforms', () => {
  let h: Harness & { engine: LocalEngine };
  let s: Scene;

  /** Every tool action closed AND the engine queue drained. */
  async function engineIdle(): Promise<void> {
    await settleToolEdits();
    await engineQueueIdle();
  }

  const tp = (prop: string): unknown =>
    (defaultSceneGraph.getNode(s.A)!.components.find((c) => c.type === 'Transform')!.props as Record<string, unknown>)[prop];

  /** One call = one entry named `label`; undo restores the exact document, redo reapplies. */
  async function oneEntry(label: string, run: () => void): Promise<void> {
    const before = h.doc();
    const n = historyLabels().length;
    run();
    await engineIdle();
    const after = h.doc();
    expect(after).not.toBe(before);
    expect(historyLabels().length).toBe(n + 1);
    expect(historyLabels().at(-1)).toBe(label);
    await h.run({ type: 'undo' });
    expect(h.doc()).toBe(before);
    await h.run({ type: 'redo' });
    expect(h.doc()).toBe(after);
  }

  beforeEach(async () => {
    h = await setupAppEngine();
    s = await buildScene(h);
    usePreferenceStore.setState({ timelineAutoKeyframe: false });
    // A 3D layer: z / rotationX are properties of it.
    await h.run({ type: 'setLayerSwitches', layers: [s.A], patch: { threeD: true } });
  });

  afterEach(async () => {
    await engineIdle();
    await h.dispose();
  });

  it('writes base props (no keyframes) for a fully static node', async () => {
    await oneEntry('Move', () => {
      expect(applyGizmo3DTransforms([{ id: s.A, values: { x: 150, y: 250, z: -30 } }])).toBe(true);
    });
    expect(tp('x')).toBe(150);
    expect(tp('y')).toBe(250);
    expect(tp('z')).toBe(-30);
    expect(defaultAnimation.tracksFor(s.A)).toHaveLength(0);
  });

  it('keyframes a prop whose stopwatch is lit — at the playhead, with the new value', async () => {
    await h.run({ type: 'addKeyframes', keys: [
      { prop: { layer: s.A, path: 'transform/position' }, time: 0, spatialIn: [], spatialOut: [] },
    ] });
    const keys0 = defaultAnimation.getTrackKeyframes(s.A, 'x')!.length;
    await oneEntry('Move', () => {
      applyGizmo3DTransforms([{ id: s.A, values: { x: 400, y: 260 } }]);
    });
    // x has a track → the write must land on the track or the renderer
    // (which samples tracks first) never shows it.
    expect(defaultAnimation.sample(s.A, 'x', 0)).toBe(400);
    // y shares the position stopwatch (one Position property).
    expect(defaultAnimation.sample(s.A, 'y', 0)).toBe(260);
    // The key at the playhead was replaced, none added.
    expect(defaultAnimation.getTrackKeyframes(s.A, 'x')!.length).toBe(keys0);
  });

  it('does not touch (or keyframe) props absent from the update', async () => {
    await h.run({ type: 'addKeyframes', keys: [
      { prop: { layer: s.A, path: 'transform/scale' }, time: 0, spatialIn: [], spatialOut: [] },
    ] });
    const scale0 = defaultAnimation.sample(s.A, 'scaleX', 0);
    // Position-only gizmo drag on a node with an animated scale:
    await oneEntry('Move', () => {
      applyGizmo3DTransforms([{ id: s.A, values: { x: 300 } }]);
    });
    expect(defaultAnimation.getTrackKeyframes(s.A, 'scaleX')!).toHaveLength(1);
    expect(defaultAnimation.sample(s.A, 'scaleX', 0)).toBe(scale0); // unchanged
    expect(tp('x')).toBe(300);
  });

  it('routes 3D props (z / rotationX) through their own stopwatches', async () => {
    await h.run({ type: 'addKeyframes', keys: [
      { prop: { layer: s.A, path: 'transform/position' }, time: 0, spatialIn: [], spatialOut: [] },
    ] });
    await oneEntry('Rotate', () => {
      applyGizmo3DTransforms([{ id: s.A, values: { z: -120, rotationX: 30 } }]);
    });
    expect(defaultAnimation.sample(s.A, 'z', 0)).toBe(-120); // keyed (Position is animated)
    expect(defaultAnimation.isAnimated(s.A, 'rotationX')).toBe(false); // static → the value only
    expect(tp('rotationX')).toBe(30);
  });

  it('Auto-Keyframe keys an unanimated prop', async () => {
    usePreferenceStore.setState({ timelineAutoKeyframe: true });
    await oneEntry('Scale', () => {
      applyGizmo3DTransforms([{ id: s.A, values: { scaleX: 2, scaleY: 2 } }]);
    });
    expect(defaultAnimation.isAnimated(s.A, 'scaleX')).toBe(true);
    expect(defaultAnimation.sample(s.A, 'scaleX', 0)).toBeCloseTo(2, 9);
  });

  it('skips locked nodes', async () => {
    await h.run({ type: 'setLayerSwitches', layers: [s.A], patch: { locked: true } });
    const x0 = tp('x');
    const n = historyLabels().length;
    applyGizmo3DTransforms([{ id: s.A, values: { x: 999 } }]);
    await engineIdle();
    expect(tp('x')).toBe(x0);
    expect(historyLabels().length).toBe(n);
  });

  it('sends nothing when the API cannot address a write (a 2D layer has no z)', async () => {
    const before = h.doc();
    const n = historyLabels().length;
    expect(applyGizmo3DTransforms([{ id: s.P, values: { x: 5, z: 10 } }])).toBe(false);
    await engineIdle();
    expect(h.doc()).toBe(before);
    expect(historyLabels().length).toBe(n);
  });
});
