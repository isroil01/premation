/**
 * 3D gizmo transform writes (ports.ts): applyGizmo3DTransforms goes through
 * the engine (B3): a property with a lit stopwatch keys at the playhead (a
 * base-only write is invisible there, because the renderer samples the track
 * first), a static one takes the value. Props NOT in the update are never
 * touched. One undo entry per call; undo restores exactly. (The READ side is
 * the overlay push's scene3d record — core/mirror/viewGeometry.ts transform3DOf.)
 */

import { defaultAnimation } from '@motion/animation';
import { engineIdle as engineQueueIdle } from '@core/engine/engineInstance';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import { docView } from '@core/engine/__testHelpers__/docView';
import { buildScene, type Scene } from '@core/engine/__testHelpers__/scene';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import { usePreferenceStore } from '@stores/preferenceStore';
import { applyGizmo3DTransforms } from './ports';
import { settleToolEdits } from './viewportGesture';

describe('applyGizmo3DTransforms', () => {
  let h: Harness;
  let s: Scene;

  /** Every tool action closed AND the engine queue drained. */
  async function engineIdle(): Promise<void> {
    await settleToolEdits();
    await engineQueueIdle();
  }

  const tp = async (prop: string): Promise<unknown> =>
    ((await docView()).getNode(s.A)!.components.find((c) => c.type === 'Transform')!.props as Record<string, unknown>)[prop];

  /** One call = one entry named `label`; undo restores the exact document, redo reapplies. */
  async function oneEntry(label: string, run: () => void): Promise<void> {
    const before = (await h.doc());
    const n = (await historyLabels()).length;
    run();
    await engineIdle();
    const after = (await h.doc());
    expect(after).not.toBe(before);
    expect((await historyLabels()).length).toBe(n + 1);
    expect((await historyLabels()).at(-1)).toBe(label);
    await h.run({ type: 'undo' });
    expect((await h.doc())).toBe(before);
    await h.run({ type: 'redo' });
    expect((await h.doc())).toBe(after);
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
    expect((await tp('x'))).toBe(150);
    expect((await tp('y'))).toBe(250);
    expect((await tp('z'))).toBe(-30);
    expect((await docView()).tracksFor(s.A)).toHaveLength(0);
  });

  it('keyframes a prop whose stopwatch is lit — at the playhead, with the new value', async () => {
    await h.run({ type: 'addKeyframes', keys: [
      { prop: { layer: s.A, path: 'transform/position' }, time: 0, spatialIn: [], spatialOut: [] },
    ] });
    const keys0 = (await docView()).getTrackKeyframes(s.A, 'x')!.length;
    await oneEntry('Move', () => {
      applyGizmo3DTransforms([{ id: s.A, values: { x: 400, y: 260 } }]);
    });
    // x has a track → the write must land on the track or the renderer
    // (which samples tracks first) never shows it.
    expect(defaultAnimation.sample(s.A, 'x', 0)).toBe(400);
    // y shares the position stopwatch (one Position property).
    expect(defaultAnimation.sample(s.A, 'y', 0)).toBe(260);
    // The key at the playhead was replaced, none added.
    expect((await docView()).getTrackKeyframes(s.A, 'x')!.length).toBe(keys0);
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
    expect((await docView()).getTrackKeyframes(s.A, 'scaleX')!).toHaveLength(1);
    expect(defaultAnimation.sample(s.A, 'scaleX', 0)).toBe(scale0); // unchanged
    expect((await tp('x'))).toBe(300);
  });

  it('routes 3D props (z / rotationX) through their own stopwatches', async () => {
    await h.run({ type: 'addKeyframes', keys: [
      { prop: { layer: s.A, path: 'transform/position' }, time: 0, spatialIn: [], spatialOut: [] },
    ] });
    await oneEntry('Rotate', () => {
      applyGizmo3DTransforms([{ id: s.A, values: { z: -120, rotationX: 30 } }]);
    });
    expect(defaultAnimation.sample(s.A, 'z', 0)).toBe(-120); // keyed (Position is animated)
    expect((await docView()).isAnimated(s.A, 'rotationX')).toBe(false); // static → the value only
    expect((await tp('rotationX'))).toBe(30);
  });

  it('Auto-Keyframe keys an unanimated prop', async () => {
    usePreferenceStore.setState({ timelineAutoKeyframe: true });
    await oneEntry('Scale', () => {
      applyGizmo3DTransforms([{ id: s.A, values: { scaleX: 2, scaleY: 2 } }]);
    });
    expect((await docView()).isAnimated(s.A, 'scaleX')).toBe(true);
    expect(defaultAnimation.sample(s.A, 'scaleX', 0)).toBeCloseTo(2, 9);
  });

  it('skips locked nodes', async () => {
    await h.run({ type: 'setLayerSwitches', layers: [s.A], patch: { locked: true } });
    const x0 = (await tp('x'));
    const n = (await historyLabels()).length;
    applyGizmo3DTransforms([{ id: s.A, values: { x: 999 } }]);
    await engineIdle();
    expect((await tp('x'))).toBe(x0);
    expect((await historyLabels()).length).toBe(n);
  });

  it('sends nothing when the API cannot address a write (a 2D layer has no z)', async () => {
    const before = (await h.doc());
    const n = (await historyLabels()).length;
    expect(applyGizmo3DTransforms([{ id: s.P, values: { x: 5, z: 10 } }])).toBe(false);
    await engineIdle();
    expect((await h.doc())).toBe(before);
    expect((await historyLabels()).length).toBe(n);
  });
});
