/**
 * WS-T (B3z-b): the layer-time / timeline gaps closed in both engines —
 * transitions, marker colours, clearWorkArea, unfreeze, Time Stretch (Hold in
 * Place + non-footage bake), rippleDeleteRange, shiftLayerKeyframes, bars
 * before source frame 0, setParent jump. Each: one entry, exact undo, redo.
 */

import { documentMirror } from '@stores/documentMirror';
import { engineIdle } from '@core/engine/engineInstance';
import type { Command } from '@motion/engine-api';
import { setupAppEngine } from '../__testHelpers__/appEngine';
import { docView } from '@core/engine/__testHelpers__/docView';
import { buildScene, type Scene } from '../__testHelpers__/scene';
import { sec, type Harness } from '../__testHelpers__/appEngine';

let h: Harness;
let s: Scene;

/** A marker of the scene's composition as the mirror holds it. */
async function marker(id: string): Promise<{ color?: string } | undefined> {
  await engineIdle();
  return documentMirror().comp(s.comp)?.markers.find((m) => m.id === id);
}

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
  const before = (await h.doc());
  const res = Array.isArray(cmd) ? await h.batch('B', cmd) : await h.run(cmd);
  const after = (await h.doc());
  await h.run({ type: 'undo' });
  expect((await h.doc())).toEqual(before);
  await h.run({ type: 'redo' });
  expect((await h.doc())).toEqual(after);
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
    const bare = (await h.doc());
    const { transition } = await exact({ type: 'addTransition', left: s.A, right: s.B, kind: 'crossDissolve', duration: f(12), alignment: 'centred' }) as { transition: string };
    expect((await docView()).getTrackKeyframes(s.A, 'opacity')).toHaveLength(2);
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
    expect(strip((await h.doc()))).toEqual(strip(bare));
    const after = await h.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false });
    expect(after.comps.find((c) => c.id === s.comp)!.transitions).toEqual([]);
  });

  it('an effect wipe ramps that effect, with its direction, softness and ease; a dip takes a colour', async () => {
    await cut();
    const { transition } = await exact({
      type: 'addTransition', left: s.A, right: s.B, kind: 'wipe', duration: f(12), alignment: 'centred',
      effect: 'radial-wipe', angle: 45, softness: 12, ease: 'easeInOut',
    }) as { transition: string };
    const fx = (await docView()).getNodeEffects(s.B).find((e) => e.type === 'radial-wipe');
    expect(fx).toBeDefined();
    expect(fx!.params).toMatchObject({ startAngle: 45, feather: 12 });
    const doc = await h.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false });
    expect(doc.comps.find((c) => c.id === s.comp)!.transitions[0]!).toMatchObject({ effect: 'radial-wipe', angle: 45, softness: 12, ease: 'easeInOut' });
    // Back to a plain wipe, then a dip through a colour.
    await exact({ type: 'setTransition', transition, effect: '' });
    expect((await docView()).getNodeEffects(s.B).some((e) => e.type === 'linear-wipe')).toBe(true);
    await exact({ type: 'setTransition', transition, kind: 'dipToWhite', color: '#ff0000' });
    expect((await docView()).getNodeEffects(s.B).find((e) => e.type === 'fill')?.params).toMatchObject({ color: '#ff0000' });
    // A non-transition effect and a bad colour are refused, the record unchanged.
    expect((await h.client.execute({ type: 'setTransition', transition, effect: 'gaussian-blur' })).ok).toBe(false);
    expect((await h.client.execute({ type: 'setTransition', transition, color: 'red' })).ok).toBe(false);
  });

  it('applies a user preset carried as its body (the engine registry only has the built-ins)', async () => {
    const body = JSON.stringify({ tracks: [{ prop: 'opacity', keyframes: [{ t: 0, value: 0 }, { t: 0.5, value: 100 }] }] });
    expect((await h.client.execute({ type: 'applyPreset', layers: [s.A], preset: 'My Fade', time: sec(1) })).ok).toBe(false);
    await exact({ type: 'applyPreset', layers: [s.A], preset: 'My Fade', time: sec(1), body });
    expect((await docView()).getTrackKeyframes(s.A, 'opacity')?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('refuses a cut that is not one, and a transition the handles cannot pay for', async () => {
    const bad = await h.client.execute({ type: 'addTransition', left: s.A, right: s.T, kind: 'crossDissolve', duration: f(12), alignment: 'centred' });
    expect(bad.ok).toBe(false);
    await cut();
    // Footage V has no head handle at its source start.
    await h.run({ type: 'setLayerTiming', items: [{ layer: s.V, startTime: f(90), inPoint: f(90), outPoint: f(120) }, { layer: s.B, startTime: 0, inPoint: f(60), outPoint: f(90) }] });
    const res = await h.client.execute({ type: 'addTransition', left: s.B, right: s.V, kind: 'crossDissolve', duration: f(12), alignment: 'centred' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('outOfRange');
    const ok = await h.client.execute({ type: 'addTransition', left: s.B, right: s.V, kind: 'dipToBlack', duration: f(12), alignment: 'centred' });
    expect(ok.ok).toBe(true);
  });
});

describe('markers, work area, freeze', () => {
  it('stores a marker colour token and reports it', async () => {
    const token = 'var(--color-timeline-marker-green)';
    const { ids: [id] } = await exact({ type: 'addMarkers', markers: [{ owner: { comp: s.comp }, time: sec(1), duration: 0, name: 'x', comment: '', label: 0, color: token }] }) as { ids: string[] };
    expect((await marker(id!))?.color).toBe(token);
    await exact({ type: 'updateMarkers', patches: [{ id: id!, color: '' }] });
    expect((await marker(id!))?.color ?? '').toBe('');
  });

  it('clears the work area', async () => {
    await h.run({ type: 'setWorkArea', comp: s.comp, range: { start: sec(1), duration: sec(1) } });
    await exact({ type: 'clearWorkArea', comp: s.comp });
    // "None" reads back as the whole composition.
    await engineIdle();
    const st = documentMirror().comp(s.comp)!.settings;
    expect(st.workArea).toEqual({ start: 0, duration: st.duration });
  });

  it('unfreezes', async () => {
    await h.run({ type: 'freezeFrame', layer: s.V, time: sec(1), lastFrame: false });
    expect((await docView()).getNodeLayerTime(s.V).freeze).toBe(true);
    await exact({ type: 'unfreezeLayers', layers: [s.V, s.A] });
    expect((await docView()).getNodeLayerTime(s.V).freeze ?? false).toBe(false);
  });
});

describe('time stretch, ranges, key shifts', () => {
  it('stretches footage holding the out point and bakes a non-footage layer', async () => {
    await exact({ type: 'timeStretchLayers', layers: [s.V], stretch: 2, hold: 'outPoint' });
    expect((await docView()).getNodeLayerTime(s.V).stretch).toBe(200);
    const k0 = (await docView()).getTrackKeyframes(s.B, 'x')?.map((k) => k.t);
    await exact({ type: 'timeStretchLayers', layers: [s.B], stretch: -1, hold: 'currentFrame', time: sec(1) });
    expect((await docView()).getTrackKeyframes(s.B, 'x')?.map((k) => k.t)).not.toEqual(k0);
    const r = await h.client.execute({ type: 'timeStretchLayers', layers: [s.V], stretch: -1, hold: 'inPoint' });
    expect(r.ok).toBe(false);
  });

  it('deletes a time range and closes the gap once', async () => {
    await cut();
    const { layers } = await exact({ type: 'rippleDeleteRange', comp: s.comp, range: { start: f(40), duration: f(10) }, layers: [] }) as { layers: string[] };
    expect(layers.length).toBeGreaterThan(0);
  });

  it('shifts every key of a layer in layer time, sub-frame and before 0', async () => {
    await exact({ type: 'shiftLayerKeyframes', items: [{ layer: s.B, delta: -sec(0.3333) }] });
    expect((await docView()).getTrackKeyframes(s.B, 'x')![0]!.t).toBeCloseTo(-0.3333, 6);
  });

  it('lets an unbounded layer start before its source', async () => {
    await exact({ type: 'setLayerTiming', items: [{ layer: s.A, startTime: f(30), inPoint: f(10) }] });
    const r = await h.client.execute({ type: 'setLayerTiming', items: [{ layer: s.V, startTime: f(30), inPoint: f(10) }] });
    expect(r.ok).toBe(false);
  });
});

describe('setParent jump', () => {
  it('relinks and lands on the parent anchor', async () => {
    await exact({ type: 'setParent', layers: [s.A], parent: s.P, keepWorldTransform: true, jump: true, time: 0 });
    const t = (await docView()).getNode(s.A)!.transform.position;
    expect(t.x).toBeCloseTo(0, 6);
    expect(t.y).toBeCloseTo(0, 6);
  });
});
