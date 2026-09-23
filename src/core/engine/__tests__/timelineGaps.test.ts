/**
 * WS-T (B3z-b): the layer-time / timeline gaps closed in both engines —
 * transitions, marker colours, clearWorkArea, unfreeze, Time Stretch (Hold in
 * Place + non-footage bake), rippleDeleteRange, shiftLayerKeyframes, bars
 * before source frame 0, setParent jump. Each: one entry, exact undo, redo.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { useTransitionStore } from '@stores/transitionStore';
import { getNodeLayerTime } from '@core/scene/layerTime';
import { getTimelineController } from '@core/timeline/TimelineController';
import type { Command } from '@motion/engine-api';
import { setupAppEngine } from '../__testHelpers__/appEngine';
import { buildScene, type Scene } from '../__testHelpers__/scene';
import { sec, type Harness } from '../__testHelpers__/harness';
import type { LocalEngine } from '../LocalEngine';

let h: Harness & { engine: LocalEngine };
let s: Scene;

beforeEach(async () => {
  h = await setupAppEngine();
  s = await buildScene(h);
});
afterEach(async () => {
  await h.dispose();
});

const f = (n: number): number => sec(n / 30);

/** Run, check one exact undo and a redo that lands on the same document. */
async function exact(cmd: Command | Command[]): Promise<unknown> {
  const before = h.doc();
  const res = Array.isArray(cmd) ? await h.batch('B', cmd) : await h.run(cmd);
  const after = h.doc();
  await h.run({ type: 'undo' });
  expect(h.doc()).toEqual(before);
  await h.run({ type: 'redo' });
  expect(h.doc()).toEqual(after);
  return res;
}

async function cut(): Promise<void> {
  await h.run({ type: 'setLayerTiming', items: [
    { layer: s.A, startTime: 0, inPoint: f(30), outPoint: f(60) },
    { layer: s.B, startTime: 0, inPoint: f(60), outPoint: f(90) },
  ] });
}

describe('transitions', () => {
  it('adds a cross dissolve (overlap + opacity ramps), changes and removes it exactly', async () => {
    await cut();
    const bare = h.doc();
    const { transition } = await exact({ type: 'addTransition', left: s.A, right: s.B, kind: 'crossDissolve', duration: f(12), alignment: 'centred' }) as { transition: string };
    const list = useTransitionStore.getState().list(s.comp);
    expect(list.map((t) => t.id)).toEqual([transition]);
    expect(defaultAnimation.getTrackKeyframes(s.A, 'opacity')).toHaveLength(2);
    const doc = await h.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false });
    expect(doc.comps.find((c) => c.id === s.comp)!.transitions).toMatchObject([{ id: transition, left: s.A, right: s.B, kind: 'crossDissolve', duration: f(12), alignment: 'centred' }]);
    await exact({ type: 'setTransition', transition, kind: 'dipToWhite', duration: f(8) });
    await exact({ type: 'setTransition', transition, kind: 'wipe', alignment: 'startAtCut' });
    await exact({ type: 'removeTransitions', transitions: [transition] });
    // Removal puts the cut back exactly (the record is gone too). An emptied
    // effect stack leaves an empty `fx` component behind (writeNodeEffects, as the legacy did).
    const emptyFx = (v: unknown): boolean => {
      const c = v as { type?: string; props?: Record<string, unknown> };
      return c?.type === 'fx' && Object.keys(c.props ?? {}).length === 1 && Array.isArray(c.props?.effects) && (c.props!.effects as unknown[]).length === 0;
    };
    const strip = (d: string): unknown => JSON.parse(d, (k, v: unknown) => {
      if (k === 'transitions') return null;
      if (k === 'components' && Array.isArray(v)) return v.filter((c) => !emptyFx(c));
      return v;
    });
    expect(strip(h.doc())).toEqual(strip(bare));
    expect(useTransitionStore.getState().list(s.comp)).toEqual([]);
  });

  it('refuses a cut that is not one, and a transition the handles cannot pay for', async () => {
    const bad = await h.engine.execute({ type: 'addTransition', left: s.A, right: s.T, kind: 'crossDissolve', duration: f(12), alignment: 'centred' });
    expect(bad.ok).toBe(false);
    await cut();
    // Footage V has no head handle at its source start.
    await h.run({ type: 'setLayerTiming', items: [{ layer: s.V, startTime: f(90), inPoint: f(90), outPoint: f(120) }, { layer: s.B, startTime: 0, inPoint: f(60), outPoint: f(90) }] });
    const res = await h.engine.execute({ type: 'addTransition', left: s.B, right: s.V, kind: 'crossDissolve', duration: f(12), alignment: 'centred' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('outOfRange');
    const ok = await h.engine.execute({ type: 'addTransition', left: s.B, right: s.V, kind: 'dipToBlack', duration: f(12), alignment: 'centred' });
    expect(ok.ok).toBe(true);
  });
});

describe('markers, work area, freeze', () => {
  it('stores a marker colour token and reports it', async () => {
    const token = 'var(--color-timeline-marker-green)';
    const { ids: [id] } = await exact({ type: 'addMarkers', markers: [{ owner: { comp: s.comp }, time: sec(1), duration: 0, name: 'x', comment: '', label: 0, color: token }] }) as { ids: string[] };
    expect(getTimelineController().timeline.getMarker(id!)?.color).toBe(token);
    await exact({ type: 'updateMarkers', patches: [{ id: id!, color: '' }] });
    expect(getTimelineController().timeline.getMarker(id!)?.color ?? null).toBeNull();
  });

  it('clears the work area', async () => {
    await exact({ type: 'clearWorkArea', comp: s.comp });
    expect(getTimelineController().timeline.getRanges().workArea).toBeNull();
  });

  it('unfreezes', async () => {
    await h.run({ type: 'freezeFrame', layer: s.V, time: sec(1), lastFrame: false });
    await exact({ type: 'unfreezeLayers', layers: [s.V, s.A] });
    expect(getNodeLayerTime(s.V).freeze).toBe(false);
  });
});

describe('time stretch, ranges, key shifts', () => {
  it('stretches footage holding the out point and bakes a non-footage layer', async () => {
    await exact({ type: 'timeStretchLayers', layers: [s.V], stretch: 2, hold: 'outPoint' });
    expect(getNodeLayerTime(s.V).stretch).toBe(200);
    const k0 = defaultAnimation.getTrackKeyframes(s.B, 'x')?.map((k) => k.t);
    await exact({ type: 'timeStretchLayers', layers: [s.B], stretch: -1, hold: 'currentFrame', time: sec(1) });
    expect(defaultAnimation.getTrackKeyframes(s.B, 'x')?.map((k) => k.t)).not.toEqual(k0);
    const r = await h.engine.execute({ type: 'timeStretchLayers', layers: [s.V], stretch: -1, hold: 'inPoint' });
    expect(r.ok).toBe(false);
  });

  it('deletes a time range and closes the gap once', async () => {
    await cut();
    const { layers } = await exact({ type: 'rippleDeleteRange', comp: s.comp, range: { start: f(40), duration: f(10) }, layers: [] }) as { layers: string[] };
    expect(layers.length).toBeGreaterThan(0);
  });

  it('shifts every key of a layer in layer time, sub-frame and before 0', async () => {
    await exact({ type: 'shiftLayerKeyframes', items: [{ layer: s.B, delta: -sec(0.3333) }] });
    expect(defaultAnimation.getTrackKeyframes(s.B, 'x')![0]!.t).toBeCloseTo(-0.3333, 6);
  });

  it('lets an unbounded layer start before its source', async () => {
    await exact({ type: 'setLayerTiming', items: [{ layer: s.A, startTime: f(30), inPoint: f(10) }] });
    const r = await h.engine.execute({ type: 'setLayerTiming', items: [{ layer: s.V, startTime: f(30), inPoint: f(10) }] });
    expect(r.ok).toBe(false);
  });
});

describe('setParent jump', () => {
  it('relinks and lands on the parent anchor', async () => {
    await exact({ type: 'setParent', layers: [s.A], parent: s.P, keepWorldTransform: true, jump: true, time: 0 });
    const t = defaultSceneGraph.getNode(s.A)!.transform.position;
    expect(t.x).toBeCloseTo(0, 6);
    expect(t.y).toBeCloseTo(0, 6);
  });
});
